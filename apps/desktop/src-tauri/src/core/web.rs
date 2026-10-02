//! Built-in, keyless web access for the agent tools (2026-10-02).
//!
//! Two capabilities, no API keys, no external service accounts:
//!
//! - [`web_fetch_text`] — download a public page and hand back readable text (HTML stripped).
//! - [`web_search`] — query DuckDuckGo's HTML endpoint (the "lite" page: server-rendered, no
//!   JavaScript, no auth) and parse the result list out of it. This is the same trick curl-based
//!   scrapers have used for years; it is free and unauthenticated, and the trade is that the
//!   markup is unofficial, so the parser is written tolerant and its fixture test pins the shape
//!   it relies on.
//!
//! # The boundary is the URL guard, not the egress allowlist
//!
//! `core::egress` exists to enforce the operator's provider-host allowlist. A general web tool
//! would be useless behind one — the whole point is "any page the user asks about". So this
//! module holds its own, narrower rule ([`check_public_http_url`]): scheme must be http(s), no
//! userinfo, and the host — after DNS resolution, not just textually — must not be private,
//! loopback, link-local or otherwise non-public. That keeps the tool from being turned into a
//! bridge into the machine's own network (cloud metadata endpoints, localhost services, the
//! router's own admin port) while staying keyless and open for the public web.
//!
//! Redirects are deliberately NOT followed: a redirect target gets its own guard pass only when
//! the model calls again on it, which keeps the check simple and honest. The error names the
//! `Location` so a retry is one tool call.

use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;

/// One search result from the DuckDuckGo lite page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebSearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// A page's raw bytes are capped before HTML-stripping, so one giant response cannot tie up
/// the tool host.
const MAX_BODY_BYTES: usize = 512 * 1024;
/// The text handed to the model is capped tighter — 32 KB of prose is already ~8k tokens, and
/// the model can re-fetch with the reading it needs.
const MAX_TEXT_BYTES: usize = 32 * 1024;
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) AIProviderRouter/1.2 Safari/537.36";

/// A dedicated multi-thread runtime, built once. The tool host is synchronous, and blocking on
/// the ambient runtime (if any) with `tokio::block_on` would panic; a private runtime is the
/// safe bridge between the two worlds.
fn runtime() -> &'static tokio::runtime::Runtime {
    static CELL: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    CELL.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("the web runtime must start")
    })
}

// ── the URL guard ────────────────────────────────────────────────────────────────────────

/// Is this IP inside the machine's own or otherwise non-routable space? The guard's core.
fn forbidden_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                // 198.18.0.0/15, the benchmarking range (`is_benchmarking` is still unstable)
                || (v4.octets()[0] == 198 && (v4.octets()[1] == 18 || v4.octets()[1] == 19))
                || v4.octets()[0] == 0 // 0.0.0.0/8, "this network"
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                // unique local addresses (fc00::/7) — the IPv6 "private" range
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                // link-local (fe80::/10)
                || (v6.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

/// Validate a URL for the web tools: http(s) only, no userinfo, and the host must resolve to
/// public addresses only. `https://1.1.1.1/` passes without DNS; a domain must actually resolve.
pub fn check_public_http_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|e| format!("bad URL: {e}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!(
            "only http(s) URLs are supported, not \"{}\"",
            url.scheme()
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URLs with embedded credentials are refused".into());
    }
    let port = url.port_or_known_default().unwrap_or(80);
    let addrs: Vec<IpAddr> = match url.host_str() {
        Some(domain) => {
            // A literal IP (brackets stripped for IPv6) needs no resolution; a name must
            // actually resolve, and every resolved address is checked — the textual host is
            // not the boundary, the address behind it is.
            let literal = domain
                .trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<IpAddr>()
                .ok();
            match literal {
                Some(ip) => vec![ip],
                None => {
                    let resolved = (domain, port).to_socket_addrs().map_err(|e| {
                        format!("cannot resolve host \"{domain}\": {e}")
                    })?;
                    resolved.map(|sa: SocketAddr| sa.ip()).collect()
                }
            }
        }
        None => return Err("URL has no host".into()),
    };
    if addrs.is_empty() {
        return Err("host resolved to no addresses".into());
    }
    for ip in &addrs {
        if forbidden_ip(*ip) {
            return Err(format!(
                "{ip} is not a public address — the web tools only reach the public internet"
            ));
        }
    }
    Ok(url)
}

// ── the HTTP fetch ───────────────────────────────────────────────────────────────────────

/// GET one URL and return the raw body. No redirects are followed — a 3xx is an error whose
/// text names the `Location`. The public-URL guard is NOT applied here (it is a separate,
/// separately-testable rule the callers apply), which is also what lets tests point this at a
/// local listener.
pub fn http_get(url: &reqwest::Url) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(FETCH_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|e| format!("cannot build HTTP client: {e}"))?;
    runtime().block_on(async {
        let resp = client.get(url.clone()).send().await.map_err(|e| {
            if e.is_timeout() {
                "the request timed out".to_string()
            } else if e.is_connect() {
                format!("cannot connect: {e}")
            } else {
                format!("request failed: {e}")
            }
        })?;
        let status = resp.status();
        if status.is_redirection() {
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("(no location)");
            return Err(format!("redirected to {loc} — fetch that URL directly"));
        }
        if !status.is_success() {
            return Err(format!("HTTP {status}"));
        }
        let total = resp.content_length();
        if let Some(n) = total {
            if n as usize > MAX_BODY_BYTES {
                return Err(format!(
                    "response is {n} bytes, over the {MAX_BODY_BYTES}-byte cap"
                ));
            }
        }
        let mut body: Vec<u8> = Vec::new();
        let mut resp = resp;
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| format!("reading the response failed: {e}"))?
        {
            if body.len() + chunk.len() > MAX_BODY_BYTES {
                return Err(format!(
                    "response exceeds the {MAX_BODY_BYTES}-byte cap"
                ));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    })
}

/// Fetch a URL and return readable text. HTML responses are stripped to text (scripts, styles,
/// tags and most entities removed); anything else that sniffs as text is passed through as-is.
/// A `Page:`/`URL:` header is prefixed so the model can cite what it read.
pub fn web_fetch_text(raw_url: &str) -> Result<String, String> {
    let url = check_public_http_url(raw_url)?;
    let body = http_get(&url)?;
    let raw = String::from_utf8_lossy(&body).into_owned();
    let title = if looks_like_html(&body) {
        Regex::new(r"(?is)<title[^>]*>(.*?)</title>")
            .expect("constant")
            .captures(&raw)
            .map(|c| html_to_text(&c[1]))
            .unwrap_or_default()
    } else {
        String::new()
    };
    let mut text = if looks_like_html(&body) {
        html_to_text(&raw)
    } else {
        raw
    };
    if text.len() > MAX_TEXT_BYTES {
        let mut cut = MAX_TEXT_BYTES;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("\n\n(truncated — the page is longer than the 32 KB text cap)");
    }
    if text.trim().is_empty() {
        return Err("the page fetched fine but contained no readable text".into());
    }
    let mut out = String::new();
    if !title.is_empty() {
        out.push_str(&format!("Page: {title}\n"));
    }
    out.push_str(&format!("URL: {url}\n\n"));
    out.push_str(&text);
    Ok(out)
}

/// Does this look like HTML? A byte sniff, not a content-type read — the response headers are
/// already gone by the time the caller sees the body, and mislabeled servers are common enough
/// that sniffing serves the model better.
fn looks_like_html(body: &[u8]) -> bool {
    let head = String::from_utf8_lossy(&body[..body.len().min(512)]).to_lowercase();
    head.contains("<html") || head.contains("<!doctype") || head.contains("<body") || head.contains("<head")
}

// ── HTML → text ──────────────────────────────────────────────────────────────────────────

/// Reduce HTML to readable text: script/style/comment blocks removed, block-level tags turned
/// into newlines, remaining tags stripped, the common named entities and numeric references
/// decoded, whitespace collapsed. Tolerant by design — it never fails, it just cleans.
pub fn html_to_text(html: &str) -> String {
    // (The regex crate has no backreferences, so paired close-tags are matched one tag at a
    // time rather than with `<(tag)>.*?</\1>`.)
    let mut s = html.to_string();
    for tag in ["script", "style", "noscript", "svg", "head"] {
        let re = Regex::new(&format!(r"(?is)<{tag}\b.*?</{tag}\s*>")).expect("constant");
        s = re.replace_all(&s, "").into_owned();
    }
    let comments = Regex::new(r"(?s)<!--.*?-->").expect("constant");
    let blocks =
        Regex::new(r"(?i)</?(?:p|div|br|li|tr|h[1-6]|section|article|header|footer|nav|table|ul|ol|blockquote|pre|form|option|title)\b[^>]*>")
            .expect("constant");
    let any_tag = Regex::new(r"(?s)<[^>]*>").expect("constant");
    let blank_lines = Regex::new(r"\n\s*\n\s*").expect("constant");

    let s = comments.replace_all(&s, "");
    let s = blocks.replace_all(&s, "\n");
    let s = any_tag.replace_all(&s, "");
    let s = decode_entities(&s);
    let s = blank_lines.replace_all(&s, "\n\n");
    s.lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// Decode the HTML entities the wild actually uses. Scans once and never re-scans output, so
/// `&amp;lt;` decodes to the literal `&lt;` rather than `<`.
fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '&' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < chars.len() && chars[j] != ';' && j - i <= 10 {
            j += 1;
        }
        if j >= chars.len() || chars[j] != ';' {
            out.push('&');
            i += 1;
            continue;
        }
        let name: String = chars[i + 1..j].iter().collect();
        let decoded = match name.as_str() {
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            "amp" => Some('&'),
            "copy" => Some('©'),
            "reg" => Some('®'),
            "mdash" => Some('—'),
            "ndash" => Some('–'),
            "hellip" => Some('…'),
            "rsquo" => Some('’'),
            "lsquo" => Some('‘'),
            "ldquo" => Some('“'),
            "rdquo" => Some('”'),
            "middot" => Some('·'),
            "laquo" => Some('«'),
            "raquo" => Some('»'),
            hex_or_num if hex_or_num.starts_with("#x") || hex_or_num.starts_with("#X") => {
                u32::from_str_radix(&hex_or_num[2..], 16).ok().and_then(char::from_u32)
            }
            num if num.starts_with('#') => num[1..].parse::<u32>().ok().and_then(char::from_u32),
            _ => None,
        };
        match decoded {
            Some(c) => out.push(c),
            None => out.push_str(&format!("&{name};")),
        }
        i = j + 1;
    }
    out
}

// ── the DuckDuckGo lite parser ───────────────────────────────────────────────────────────

/// Percent-decode a URL fragment; `+` is a space (query-string rules, which is what DDG's
/// `uddg=` parameter carries).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3])
                    .ok()
                    .and_then(|h| u8::from_str_radix(h, 16).ok());
                match hex {
                    Some(b) => {
                        out.push(b);
                        i += 3;
                    }
                    None => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parse the DuckDuckGo lite result page: anchors styled `result-link` carry the hit, sibling
/// table cells styled `result-snippet` carry the blurb. Links are either direct or wrapped in
/// DDG's `/l/?uddg=<encoded>` redirect; the wrapped form is unwrapped so the model gets the
/// real URL.
pub fn parse_ddg_lite(html: &str) -> Vec<WebSearchHit> {
    let anchor_re = Regex::new(r#"(?is)<a\b([^>]*)>(.*?)</a>"#).expect("constant");
    let href_re = Regex::new(r#"(?i)href\s*=\s*["']([^"']+)["']"#).expect("constant");
    let snippet_re = Regex::new(r#"(?is)<td[^>]*class=["']?result-snippet["']?[^>]*>(.*?)</td>"#).expect("constant");

    let snippets: Vec<String> = snippet_re
        .captures_iter(html)
        .map(|c| html_to_text(&c[1]))
        .collect();

    let mut hits: Vec<WebSearchHit> = Vec::new();
    for caps in anchor_re.captures_iter(html) {
        let attrs = &caps[1];
        if !attrs.contains("result-link") {
            continue;
        }
        let Some(href) = href_re.captures(attrs) else { continue };
        let mut url = href[1].trim().to_string();
        if let Some(pos) = url.find("uddg=") {
            let encoded = url[pos + 5..].split('&').next().unwrap_or("");
            url = percent_decode(encoded);
        } else if url.starts_with("//") {
            url = format!("https:{url}");
        }
        if url.contains("duckduckgo.com") || url.is_empty() {
            continue; // DDG's own nav links and ad redirectors are not results
        }
        let title = html_to_text(&caps[2]);
        if title.is_empty() {
            continue;
        }
        let snippet = snippets.get(hits.len()).cloned().unwrap_or_default();
        hits.push(WebSearchHit { title, url, snippet });
        if hits.len() >= 10 {
            break;
        }
    }
    hits
}

/// Query DuckDuckGo and return the parsed results. This is the whole `web_search` tool.
pub fn web_search(query: &str) -> Result<Vec<WebSearchHit>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("a search query is required".into());
    }
    let query: String = query.chars().take(300).collect();
    let mut url = reqwest::Url::parse("https://lite.duckduckgo.com/lite/").expect("constant");
    url.query_pairs_mut().append_pair("q", &query);
    let body = http_get(&url)?;
    let html = String::from_utf8_lossy(&body).into_owned();
    let hits = parse_ddg_lite(&html);
    if hits.is_empty() {
        return Err(
            "the search engine returned no parsable results (it may be rate-limiting or changed its markup) — try again, or web_fetch a likely URL directly".into(),
        );
    }
    Ok(hits)
}

/// Format the results the way the transcript wants them.
pub fn format_search_results(query: &str, hits: &[WebSearchHit]) -> String {
    let mut out = format!("Results for \"{}\":\n\n", query.trim());
    for (i, hit) in hits.iter().enumerate() {
        out.push_str(&format!("{}. {}\n   {}\n", i + 1, hit.title, hit.url));
        if !hit.snippet.is_empty() {
            out.push_str(&format!("   {}\n", hit.snippet));
        }
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    // ── the URL guard ────────────────────────────────────────────────────

    #[test]
    fn the_guard_refuses_every_non_public_target() {
        for bad in [
            "http://127.0.0.1/",             // loopback literal
            "http://[::1]/",                 // IPv6 loopback literal
            "http://10.0.0.5/",              // RFC1918 private
            "http://192.168.1.1/",           // home router range
            "http://169.254.169.254/latest", // cloud metadata endpoint
            "http://0.0.0.0/",
            "https://[fe80::1]/",            // IPv6 link-local
            "https://[fc00::1]/",            // IPv6 unique local
            "http://localhost/",             // loopback by NAME — resolution must be checked
            "file:///etc/passwd",            // not http(s)
            "ftp://example.com/",            // not http(s)
            "http://user:pass@example.com/", // embedded credentials
            "javascript:alert(1)",           // not even a URL scheme we parse as http
        ] {
            let err = check_public_http_url(bad).expect_err(bad);
            assert!(!err.is_empty(), "{bad} must be refused with a reason");
        }
    }

    #[test]
    fn the_guard_accepts_a_public_literal_without_dns() {
        // A literal public IP needs no resolution, so this holds offline.
        assert!(check_public_http_url("https://1.1.1.1/").is_ok());
    }

    // ── HTML → text ──────────────────────────────────────────────────────

    #[test]
    fn html_to_text_strips_chrome_and_keeps_prose() {
        let html = "<html><head><style>body{color:red}</style><title>Ignore Me</title></head>\
                    <body><script>evil()</script><!-- hidden -->\
                    <h1>Hello&nbsp;&amp; welcome</h1><p>Real   prose here.</p>\
                    <a href='/next'>next page</a></body></html>";
        let text = html_to_text(html);
        assert!(text.contains("Hello & welcome"), "{text}");
        assert!(text.contains("Real prose here."), "{text}");
        assert!(text.contains("next page"), "{text}");
        assert!(!text.contains("evil"), "{text}");
        assert!(!text.contains("color:red"), "{text}");
        assert!(!text.contains("Ignore Me"), "{text}");
        assert!(!text.contains("hidden"), "{text}");
    }

    #[test]
    fn numeric_entities_decode_and_unknown_ones_survive() {
        assert_eq!(decode_entities("a&#65;b&#x42;c"), "aAbBc");
        assert_eq!(decode_entities("&fakeentity;"), "&fakeentity;");
        // &amp;lt; must decode to the literal "&lt;", not "<" — no re-scanning.
        assert_eq!(decode_entities("&amp;lt;"), "&lt;");
    }

    #[test]
    fn percent_decode_handles_escapes_and_plus() {
        assert_eq!(percent_decode("a%20b+c%2Fd"), "a b c/d");
        assert_eq!(percent_decode("100%"), "100%"); // a stray % survives
    }

    // ── the DuckDuckGo lite parser ───────────────────────────────────────

    const DDG_FIXTURE: &str = r#"<html><body><table>
      <tr><td>1.&nbsp;</td><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fguide&amp;rut=xyz" class='result-link'><b>Rust</b> Guide</a></td></tr>
      <tr><td class='result-snippet'>A gentle intro to <b>Rust</b> &amp; ownership.</td></tr>
      <tr><td>2.&nbsp;</td><td><a rel="nofollow" href="https://docs.example.com/overview" class='result-link'>Overview</a></td></tr>
      <tr><td class='result-snippet'>The long-form docs.</td></tr>
      <tr><td><a href="https://duckduckgo.com/y.js?ad=1" class='result-link'>An ad</a></td></tr>
    </table></body></html>"#;

    #[test]
    fn the_ddg_parser_extracts_hits_unwraps_redirects_and_drops_ads() {
        let hits = parse_ddg_lite(DDG_FIXTURE);
        assert_eq!(hits.len(), 2, "{hits:?}");
        assert_eq!(hits[0].title, "Rust Guide");
        assert_eq!(hits[0].url, "https://example.org/guide");
        assert!(hits[0].snippet.contains("ownership"), "{:?}", hits[0].snippet);
        assert_eq!(hits[1].url, "https://docs.example.com/overview");
        assert_eq!(hits[1].snippet, "The long-form docs.");
    }

    #[test]
    fn search_results_render_numbered_and_citable() {
        let hits = vec![WebSearchHit {
            title: "T".into(),
            url: "https://example.org/".into(),
            snippet: "S".into(),
        }];
        let out = format_search_results("q", &hits);
        assert!(out.contains("1. T"), "{out}");
        assert!(out.contains("https://example.org/"), "{out}");
    }

    #[test]
    fn an_empty_query_is_refused_before_any_network() {
        assert!(web_search("   ").is_err());
    }

    // ── http_get against a local listener (no public internet needed) ────

    /// Serve one canned response on 127.0.0.1 and return the base URL. `http_get` applies no
    /// guard itself (the guard is the caller's rule), so loopback is exactly how this is tested.
    fn serve_once(response: &'static str) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().expect("accept");
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf);
            sock.write_all(response.as_bytes()).expect("write");
        });
        format!("http://{addr}/page")
    }

    #[test]
    fn http_get_reads_a_200_body() {
        let url = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
        );
        let body = http_get(&reqwest::Url::parse(&url).unwrap()).expect("body");
        assert_eq!(body, b"hello");
    }

    #[test]
    fn http_get_refuses_a_redirect_and_names_the_location() {
        let url = serve_once(
            "HTTP/1.1 301 Moved Permanently\r\nLocation: https://elsewhere.example/page\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        let err = http_get(&reqwest::Url::parse(&url).unwrap()).expect_err("redirect");
        assert!(err.contains("https://elsewhere.example/page"), "{err}");
    }

    #[test]
    fn web_fetch_text_reports_a_private_target_instead_of_fetching_it() {
        // The guard fires before any network: a loopback URL is refused even though a server
        // could have answered.
        let err = web_fetch_text("http://127.0.0.1:9/x").expect_err("guard");
        assert!(err.contains("not a public address"), "{err}");
    }
}
