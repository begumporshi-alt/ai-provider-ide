//! Built-in, keyless web access for the agent tools (2026-10-02).
//!
//! Two capabilities, no API keys, no external service accounts:
//!
//! - [`web_fetch_text`] — download a public page and hand back readable text (HTML stripped).
//! - [`web_search`] — query keyless search endpoints and parse the result lists out of their
//!   server-rendered HTML. There is no stable, free, keyless, general-web search API anywhere,
//!   so search here is deliberately a CHAIN: backends are tried in order and the first that
//!   answers wins (the result says which one). Today that is DuckDuckGo's "lite" page, then
//!   DuckDuckGo's full "html" template (same provider, different markup, so one template
//!   changing does not take out both); each parser is tolerant and pinned by a fixture test,
//!   so a markup change degrades to the next backend instead of breaking the tool. A key-backed
//!   backend (Brave/Tavily) heads the chain when a `<provider>|<key>` secret is stored in the
//!   vault under "websearch" — see [`chain_for`]; nothing writes that account yet, so keyless
//!   runs see the two-DDG chain. After a run where every backend failed, each one cools down
//!   for 2 minutes rather than being re-hammered — see [`BACKEND_COOLDOWN`]. A self-hosted
//!   SearXNG is the permanent keyless option and slots in at the tail — see [`parse_searxng`].
//!
//! For comparison: ZCode solves search by delegating to the model provider's server-side
//! `web_search` (`supportsNativeWebSearch` in their handler) — the vendor hosts the search
//! infrastructure. That is not available to a multi-provider, bring-your-own-key app, hence the
//! chain.
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
use std::time::{Duration, Instant};

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
/// A plain browser UA. Measured 2026-10-07 against DuckDuckGo: the app-suffixed UA and a
/// Chrome UA get 202'd equally once requests burst, so the UA is not what trips DDG — but bare
/// non-browser UAs are the classic trigger for site-side 403s on ordinary pages, so the fetch
/// identifies as the browser it otherwise behaves as. No app marker: it only invites scrutiny.
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// The headers a page GET carries beyond the UA. A request with only a UA string is the
/// bot-shaped profile many sites 403 outright; these two make the request look like the
/// browsers that page expects. Applied as client defaults, so a caller-supplied header
/// (`http_request`) still overrides them.
fn browser_default_headers() -> reqwest::header::HeaderMap {
    let mut h = reqwest::header::HeaderMap::new();
    h.insert(
        reqwest::header::ACCEPT,
        reqwest::header::HeaderValue::from_static(
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ),
    );
    h.insert(
        reqwest::header::ACCEPT_LANGUAGE,
        reqwest::header::HeaderValue::from_static("en-US,en;q=0.9"),
    );
    h
}

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

// ── the fetch cache ──────────────────────────────────────────────────────────────────────

/// The agent re-reads pages constantly within a run; re-fetching is tokens, latency, and
/// politeness spent for nothing. Successful `web_fetch` results are cached per URL for a short
/// window (the ZCode WebFetch behaviour), bounded in entries so a long session cannot grow it
/// without limit.
const CACHE_TTL: Duration = Duration::from_secs(15 * 60);
const CACHE_MAX_ENTRIES: usize = 32;

fn fetch_cache(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, String)>> {
    static CELL: OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, String)>>,
    > = OnceLock::new();
    CELL.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Insert with an explicit timestamp, so the TTL is testable without sleeping.
fn cache_insert(url: String, text: String, at: std::time::Instant) {
    let mut cache = fetch_cache().lock().unwrap();
    if cache.len() >= CACHE_MAX_ENTRIES && !cache.contains_key(&url) {
        // Evict the oldest entry rather than refusing: a full cache must not disable caching.
        if let Some(oldest) = cache.iter().min_by_key(|(_, (t, _))| *t).map(|(k, _)| k.clone()) {
            cache.remove(&oldest);
        }
    }
    cache.insert(url, (at, text));
}

fn cache_lookup(url: &str) -> Option<String> {
    let mut cache = fetch_cache().lock().unwrap();
    let (at, text) = cache.get(url).cloned()?;
    if at.elapsed() > CACHE_TTL {
        cache.remove(url);
        return None;
    }
    Some(text)
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
        return Err(format!("only http(s) URLs are supported, not \"{}\"", url.scheme()));
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
            let literal =
                domain.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>().ok();
            match literal {
                Some(ip) => vec![ip],
                None => {
                    let resolved = (domain, port)
                        .to_socket_addrs()
                        .map_err(|e| format!("cannot resolve host \"{domain}\": {e}"))?;
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
        .default_headers(browser_default_headers())
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
        if status.as_u16() != 200 {
            // 2xx-but-not-200 from a page GET is a bot-check/anomaly response in practice (the
            // search engines answer 202 with a challenge page). Say so: the model reading this
            // should retry later or fetch a likely URL directly, not parse a challenge page.
            return Err(format!(
                "HTTP {status} — likely a bot check or rate limit; wait a moment and retry"
            ));
        }
        let total = resp.content_length();
        if let Some(n) = total {
            if n as usize > MAX_BODY_BYTES {
                return Err(format!("response is {n} bytes, over the {MAX_BODY_BYTES}-byte cap"));
            }
        }
        let mut body: Vec<u8> = Vec::new();
        let mut resp = resp;
        while let Some(chunk) =
            resp.chunk().await.map_err(|e| format!("reading the response failed: {e}"))?
        {
            if body.len() + chunk.len() > MAX_BODY_BYTES {
                return Err(format!("response exceeds the {MAX_BODY_BYTES}-byte cap"));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    })
}

/// Fetch a URL and return readable text. HTML responses are stripped to text (scripts, styles,
/// tags and most entities removed); anything else that sniffs as text is passed through as-is.
/// A `Page:`/`URL:` header is prefixed so the model can cite what it read.
///
/// Results are cached per URL for [`CACHE_TTL`] — a run that reads the same page twice pays
/// once. The cache sits behind the guard: a URL the guard refuses is never fetched and never
/// cached.
pub fn web_fetch_text(raw_url: &str) -> Result<String, String> {
    let url = check_public_http_url(raw_url)?;
    let key = url.as_str().to_string();
    if let Some(cached) = cache_lookup(&key) {
        return Ok(format!("{cached}\n\n(from cache — {key})"));
    }
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
    let mut text = if looks_like_html(&body) { html_to_text(&raw) } else { raw };
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
    cache_insert(key, out.clone(), std::time::Instant::now());
    Ok(out)
}

/// Does this look like HTML? A byte sniff, not a content-type read — the response headers are
/// already gone by the time the caller sees the body, and mislabeled servers are common enough
/// that sniffing serves the model better.
fn looks_like_html(body: &[u8]) -> bool {
    let head = String::from_utf8_lossy(&body[..body.len().min(512)]).to_lowercase();
    head.contains("<html")
        || head.contains("<!doctype")
        || head.contains("<body")
        || head.contains("<head")
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
/// `&amp;lt;` decodes to the literal `&lt;` rather than `<`. Shared with the DOCX extractor.
pub fn decode_entities(s: &str) -> String {
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
    let snippet_re = Regex::new(r#"(?is)<td[^>]*class=["']?result-snippet["']?[^>]*>(.*?)</td>"#)
        .expect("constant");

    let snippets: Vec<String> =
        snippet_re.captures_iter(html).map(|c| html_to_text(&c[1])).collect();

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

/// Parse a DuckDuckGo "html" endpoint result page — the full template behind
/// html.duckduckgo.com, whose markup differs from the lite page's table (`result__a` headline
/// links, `result__snippet` blurbs). The two templates are the first two chain backends: same
/// provider, but a markup change on one page does not touch the other.
pub fn parse_ddg_html(html: &str) -> Vec<WebSearchHit> {
    let link_re =
        Regex::new(r#"(?is)<a\b[^>]*class=["']result__a["'][^>]*>(.*?)</a>"#).expect("constant");
    let href_re = Regex::new(r#"(?i)href\s*=\s*["']([^"']+)["']"#).expect("constant");
    let snippet_re = Regex::new(r#"(?is)<a\b[^>]*class=["']result__snippet["'][^>]*>(.*?)</a>"#)
        .expect("constant");

    let snippets: Vec<String> =
        snippet_re.captures_iter(html).map(|c| html_to_text(&c[1])).collect();

    let mut hits: Vec<WebSearchHit> = Vec::new();
    for caps in link_re.captures_iter(html) {
        let anchor = &caps[0];
        let Some(href) = href_re.captures(anchor) else { continue };
        let mut url = href[1].trim().to_string();
        if let Some(pos) = url.find("uddg=") {
            let encoded = url[pos + 5..].split('&').next().unwrap_or("");
            url = percent_decode(encoded);
        } else if url.starts_with("//") {
            url = format!("https:{url}");
        }
        if url.contains("duckduckgo.com") || !url.starts_with("http") {
            continue;
        }
        let title = html_to_text(&caps[1]);
        if title.is_empty() {
            continue;
        }
        hits.push(WebSearchHit {
            title,
            url,
            snippet: snippets.get(hits.len()).cloned().unwrap_or_default(),
        });
        if hits.len() >= 10 {
            break;
        }
    }
    hits
}

/// Parse a SearXNG result page (the default HTML theme): `<article class="result …">` blocks,
/// each with a headline link and a `<p class="content">` blurb. Tolerant in the same way the
/// DDG parsers are — it extracts what it recognises and skips what it does not.
///
/// Kept ready but NOT in the default chain: every public instance probed in 2026-10 serves a
/// browser-verification challenge or 429s scripted clients. The parser's real purpose is a
/// SELF-HOSTED instance, which is the permanent keyless path — user-owned infrastructure, no
/// markup surprises, reachable because the search backends bypass the public-URL guard (the
/// guard governs what the MODEL may fetch, not what the app's own configured services are).
pub fn parse_searxng(html: &str) -> Vec<WebSearchHit> {
    let article_re = Regex::new(
        r#"(?is)<article\b[^>]*class=["'][^"']*\bresult\b[^"']*["'][^>]*>(.*?)</article>"#,
    )
    .expect("constant");
    let link_re =
        Regex::new(r#"(?is)<a\b([^>]*)href=["']([^"']+)["'][^>]*>(.*?)</a>"#).expect("constant");
    let content_re =
        Regex::new(r#"(?is)<p\b[^>]*class=["'][^"']*\bcontent\b[^"']*["'][^>]*>(.*?)</p>"#)
            .expect("constant");

    let mut hits: Vec<WebSearchHit> = Vec::new();
    for caps in article_re.captures_iter(html) {
        let block = &caps[1];
        let Some(link) = link_re.captures(block) else { continue };
        let url = link[2].trim().to_string();
        // Results are absolute http(s) links; instance-internal ones (settings, about,
        // pagination — relative or same-host) are not.
        if !url.starts_with("http://") && !url.starts_with("https://") {
            continue;
        }
        let title = html_to_text(&link[3]);
        if title.is_empty() {
            continue;
        }
        let snippet = content_re.captures(block).map(|c| html_to_text(&c[1])).unwrap_or_default();
        hits.push(WebSearchHit { title, url, snippet });
        if hits.len() >= 10 {
            break;
        }
    }
    hits
}

/// GET one backend page and hand its body to the parser. Shared shape so the chain can hold a
/// list of them.
type SearchBackend = fn(&str) -> Result<Vec<WebSearchHit>, String>;

/// The dynamic form of a backend for the failover chain: a trait object, so tests can pass
/// closures that count calls (`fn` pointers cannot close over state).
type DynSearchBackend<'a> = &'a (dyn Fn(&str) -> Result<Vec<WebSearchHit>, String> + 'a);

// The key tier below is wired: `web_search` builds its chain through `chain_for`, which puts a
// vault-stored `<brave|tavily>|<key>` secret at the HEAD and the keyless pair after it. Nothing
// writes that vault account yet (no settings field), so keyless users run the two-DDG chain and
// the tier activates the moment a secret is stored under "websearch".
const SEARCH_KEY_ACCOUNT: &str = "websearch";

/// The key-tier backends. These are official APIs — the stable path the keyless chain defers
/// to whenever the user has configured a key. Each parses the provider's JSON and needs a
/// `POST`-or-header variant of the fetch, so they carry their own thin request code instead of
/// `http_get`.
fn search_brave(query: &str) -> Result<Vec<WebSearchHit>, String> {
    let secret = vault_secret()?;
    let key = secret.split_once('|').map(|(_, k)| k).unwrap_or("");
    if key.is_empty() {
        return Err("no key configured".into());
    }
    let mut url =
        reqwest::Url::parse("https://api.search.brave.com/res/v1/web/search").expect("constant");
    url.query_pairs_mut().append_pair("q", query);
    url.query_pairs_mut().append_pair("count", "10");
    let body = http_get_with_headers(
        &url,
        &[("X-Subscription-Token", key), ("Accept", "application/json")],
    )?;
    parse_brave_json(&body)
}

fn search_tavily(query: &str) -> Result<Vec<WebSearchHit>, String> {
    let secret = vault_secret()?;
    let key = secret.split_once('|').map(|(_, k)| k).unwrap_or("");
    if key.is_empty() {
        return Err("no key configured".into());
    }
    let body = http_post_json(
        "https://api.tavily.com/search",
        key,
        &serde_json::json!({ "api_key": key, "query": query, "max_results": 10 }).to_string(),
    )?;
    parse_tavily_json(&body)
}

/// The stored `<provider>|<key>` secret, if one is configured and well-formed.
fn vault_secret() -> Result<String, String> {
    match crate::core::vault::get(SEARCH_KEY_ACCOUNT) {
        Ok(Some(secret)) if secret.contains('|') && !secret.ends_with('|') => Ok(secret),
        Ok(_) => Err("no key configured".into()),
        Err(e) => Err(format!("cannot read the search key: {e}")),
    }
}

/// Parse Brave's web-search JSON: `web.results[]` of `{title, url, description}`.
fn parse_brave_json(body: &str) -> Result<Vec<WebSearchHit>, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("Brave returned non-JSON: {e}"))?;
    let results = v["web"]["results"]
        .as_array()
        .ok_or_else(|| format!("Brave response has no web.results: {}", snip(body)))?;
    Ok(results
        .iter()
        .filter_map(|r| {
            Some(WebSearchHit {
                title: r["title"].as_str()?.to_string(),
                url: r["url"].as_str()?.to_string(),
                snippet: r["description"].as_str().unwrap_or_default().to_string(),
            })
        })
        .take(10)
        .collect())
}

/// Parse Tavily's JSON: `results[]` of `{title, url, content}`.
fn parse_tavily_json(body: &str) -> Result<Vec<WebSearchHit>, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("Tavily returned non-JSON: {e}"))?;
    let results = v["results"]
        .as_array()
        .ok_or_else(|| format!("Tavily response has no results: {}", snip(body)))?;
    Ok(results
        .iter()
        .filter_map(|r| {
            Some(WebSearchHit {
                title: r["title"].as_str()?.to_string(),
                url: r["url"].as_str()?.to_string(),
                snippet: r["content"].as_str().unwrap_or_default().to_string(),
            })
        })
        .take(10)
        .collect())
}

fn snip(s: &str) -> String {
    s.chars().take(120).collect()
}

/// GET with extra headers — the shape `http_get` cannot express (Brave authenticates by
/// header). Same timeout and no-redirect discipline.
fn http_get_with_headers(url: &reqwest::Url, headers: &[(&str, &str)]) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(FETCH_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|e| format!("cannot build HTTP client: {e}"))?;
    runtime().block_on(async {
        let mut req = client.get(url.clone());
        for (name, value) in headers {
            req = req.header(*name, *value);
        }
        let resp = req.send().await.map_err(|e| format!("request failed: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(format!("HTTP {status}"));
        }
        let bytes = resp.bytes().await.map_err(|e| format!("reading failed: {e}"))?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })
}

/// POST JSON with a bearer-free `Content-Type` body — Tavily authenticates in the body. Same
/// timeout and no-redirect discipline as `http_get`.
fn http_post_json(url: &str, _key: &str, json: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(FETCH_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|e| format!("cannot build HTTP client: {e}"))?;
    runtime().block_on(async {
        let resp = client
            .post(url)
            .header("Content-Type", "application/json")
            .body(json.to_string())
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(format!("HTTP {status}"));
        }
        let bytes = resp.bytes().await.map_err(|e| format!("reading failed: {e}"))?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })
}

/// The keyless backends, tried in order after any key tier. A self-hosted SearXNG slots in at
/// the TAIL (see [`parse_searxng`]).
fn keyless_backends() -> Vec<(&'static str, SearchBackend)> {
    vec![("DuckDuckGo", search_ddg_lite), ("DuckDuckGo (html)", search_ddg_html)]
}

/// The chain as a pure function of the configured secret, which is what makes the tiering
/// testable without touching the vault. The key backend goes at the HEAD: when the user
/// configured one, it is the answer they asked for; the keyless backends become the fallback.
fn chain_for(secret: Option<&str>) -> Vec<(&'static str, SearchBackend)> {
    let mut out: Vec<(&'static str, SearchBackend)> = Vec::new();
    match secret.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) if s.starts_with("brave|") => out.push(("Brave", search_brave)),
        Some(s) if s.starts_with("tavily|") => out.push(("Tavily", search_tavily)),
        _ => {}
    }
    out.extend(keyless_backends());
    out
}

/// The chain as the app will run it: whatever key the user configured, then the keyless pair.
fn search_backends() -> Vec<(&'static str, SearchBackend)> {
    let secret = crate::core::vault::get(SEARCH_KEY_ACCOUNT).ok().flatten();
    chain_for(secret.as_deref())
}

/// Run the backend chain: first success wins; every failure is kept so the final error says
/// what actually went wrong per backend. Generic over the backend callable (a `&dyn Fn`) so
/// the failover logic is testable with closures and no network.
pub fn run_search_chain(
    query: &str,
    backends: &[(&'static str, DynSearchBackend<'_>)],
) -> Result<(&'static str, Vec<WebSearchHit>), String> {
    let mut failures: Vec<String> = Vec::new();
    for (name, backend) in backends {
        match backend(query) {
            Ok(hits) if hits.is_empty() => {
                failures.push(format!("{name}: returned no results"));
            }
            Ok(hits) => return Ok((name, hits)),
            Err(e) => failures.push(format!("{name}: {e}")),
        }
    }
    Err(format!("every search backend failed — {}", failures.join("; ")))
}

/// Query DuckDuckGo's lite page and parse the results.
fn search_ddg_lite(query: &str) -> Result<Vec<WebSearchHit>, String> {
    let mut url = reqwest::Url::parse("https://lite.duckduckgo.com/lite/").expect("constant");
    url.query_pairs_mut().append_pair("q", query);
    let body = http_get(&url)?;
    let html = String::from_utf8_lossy(&body).into_owned();
    let hits = parse_ddg_lite(&html);
    if hits.is_empty() {
        return Err("no parsable results (rate-limited or markup changed?)".into());
    }
    Ok(hits)
}

/// Query DuckDuckGo's "html" endpoint (the full template) and parse the results. Second in the
/// chain: a different template from the lite page, so the two do not share a markup change.
fn search_ddg_html(query: &str) -> Result<Vec<WebSearchHit>, String> {
    let mut url = reqwest::Url::parse("https://html.duckduckgo.com/html/").expect("constant");
    url.query_pairs_mut().append_pair("q", query);
    let body = http_get(&url)?;
    let html = String::from_utf8_lossy(&body).into_owned();
    let hits = parse_ddg_html(&html);
    if hits.is_empty() {
        return Err("no parsable results (rate-limited or markup changed?)".into());
    }
    Ok(hits)
}

// Query a SearXNG instance and parse the results. Held ready, not wired into the chain — see
// [`parse_searxng`]. Wiring it is one entry in `web_search`'s backend list plus this request;
// the base URL is a placeholder to be replaced by the configured instance's.
// fn search_searxng — removed until a settings field exists for the instance URL, so the
// build carries no unreachable code; the parser above is the tested half and stays.

// ── the post-failure cooldown ────────────────────────────────────────────────────────────

/// How long a search backend that just failed sits out. Keyless engines bot-check by IP after
/// bursts (measured 2026-10-07: DuckDuckGo answers 202 to every request for a while once a run
/// has hammered it), and the agent's natural behaviour is to search again immediately — which
/// re-enters the chain, hammers the flagged engine, and extends the flag. A short quiet window
/// is what actually lifts those checks.
const BACKEND_COOLDOWN: Duration = Duration::from_secs(120);

fn search_cooldowns() -> &'static std::sync::Mutex<std::collections::HashMap<String, Instant>> {
    static CELL: OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, Instant>>,
    > = OnceLock::new();
    CELL.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Record that `name` just failed, starting its cooldown. `at` is explicit, like the fetch
/// cache's insert, so the window is testable without sleeping.
fn mark_backend_failed(name: &str, at: Instant) {
    search_cooldowns().lock().unwrap().insert(name.to_string(), at);
}

/// Is `name` inside its post-failure cooldown as of `at`?
fn backend_is_cooling(name: &str, at: Instant) -> bool {
    search_cooldowns()
        .lock()
        .unwrap()
        .get(name)
        .map(|failed_at| at.duration_since(*failed_at) < BACKEND_COOLDOWN)
        .unwrap_or(false)
}

/// The backends this call may use: everything configured, minus the ones cooling down from a
/// recent failure. `None` means every backend is cooling — the caller refuses rather than
/// re-hammering engines that just flagged this IP.
fn drop_cooling(
    all: Vec<(&'static str, SearchBackend)>,
    at: Instant,
) -> Option<Vec<(&'static str, SearchBackend)>> {
    let live: Vec<(&'static str, SearchBackend)> =
        all.into_iter().filter(|(n, _)| !backend_is_cooling(n, at)).collect();
    if live.is_empty() { None } else { Some(live) }
}

/// Search the public web: try every configured backend in order — a vault-stored key tier at
/// the head, the keyless pair after it — and return the first answer with the name of the
/// backend that served it. This is the whole `web_search` tool.
///
/// After a run where every backend failed, each of them cools down for [`BACKEND_COOLDOWN`]:
/// a `web_search` inside that window refuses instead of contacting the flagged engines again,
/// because the request burst is what trips their bot checks. A self-hosted SearXNG slots in at
/// the TAIL once a settings field for the instance URL exists (see [`parse_searxng`]).
pub fn web_search(query: &str) -> Result<(&'static str, Vec<WebSearchHit>), String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("a search query is required".into());
    }
    let query: String = query.chars().take(300).collect();
    let now = Instant::now();
    let Some(live) = drop_cooling(search_backends(), now) else {
        return Err(
            "every search backend is cooling down after a recent failure — wait a couple of \
             minutes before searching again"
                .into(),
        );
    };
    let dyn_backends: Vec<(&'static str, DynSearchBackend<'_>)> = live
        .iter()
        .map(|(n, f)| {
            // The unsize coercion needs an annotated coercion site; a bare tuple would leave
            // `f` a fn pointer.
            let f: DynSearchBackend<'_> = f;
            (*n, f)
        })
        .collect();
    match run_search_chain(&query, &dyn_backends) {
        Ok(answer) => Ok(answer),
        Err(e) => {
            let now = Instant::now();
            for (n, _) in &live {
                mark_backend_failed(n, now);
            }
            Err(format!(
                "{e} — those backends are cooling down for 2 minutes; wait before searching again"
            ))
        }
    }
}

/// Send one HTTP request to a public URL and return `HTTP {status}` plus the body. This backs
/// the `http_request` tool — the general-API caller that `http_get` deliberately is not. The
/// same guard applies (public http(s) only), redirects are reported rather than followed, and
/// the body is capped. The tool is registered MUTATING because a request is data leaving the
/// machine: it rides the approval gate, not the read-only fast path.
pub fn http_request(
    method: &str,
    raw_url: &str,
    headers: &[(String, String)],
    body: Option<&str>,
) -> Result<String, String> {
    const MAX_RESPONSE_BYTES: usize = 256 * 1024;
    let url = check_public_http_url(raw_url)?;
    let method = method.to_ascii_uppercase();
    match method.as_str() {
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" => {}
        other => return Err(format!("method \"{other}\" is not supported")),
    }
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(FETCH_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|e| format!("cannot build HTTP client: {e}"))?;
    runtime().block_on(async {
        let m: reqwest::Method = method.parse().map_err(|e| format!("bad method: {e}"))?;
        let mut req = client.request(m, url.clone());
        for (name, value) in headers {
            if name.contains('\r')
                || name.contains('\n')
                || value.contains('\r')
                || value.contains('\n')
            {
                return Err(format!("header \"{name}\" contains a line break — refused"));
            }
            req = req.header(name.as_str(), value.as_str());
        }
        if let Some(b) = body {
            req = req.body(b.to_string());
        }
        let resp = req.send().await.map_err(|e| format!("request failed: {e}"))?;
        let status = resp.status();
        if status.is_redirection() {
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("(no location)");
            return Err(format!("redirected to {loc} — request that URL directly"));
        }
        let mut out = format!("HTTP {status}");
        if let Some(ct) =
            resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok())
        {
            out.push_str(&format!(" ({ct})"));
        }
        let mut bytes: Vec<u8> = Vec::new();
        let mut resp = resp;
        while let Some(chunk) =
            resp.chunk().await.map_err(|e| format!("reading the response failed: {e}"))?
        {
            if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                bytes.extend_from_slice(&chunk[..MAX_RESPONSE_BYTES - bytes.len()]);
                out.push_str("\n\n(response truncated at 256 KB)");
                return Ok(out);
            }
            bytes.extend_from_slice(&chunk);
        }
        let text = String::from_utf8_lossy(&bytes);
        if text.trim().is_empty() {
            return Ok(format!("{out}\n\n(empty body)"));
        }
        out.push_str("\n\n");
        out.push_str(&text);
        Ok(out)
    })
}

/// Format the results the way the transcript wants them.
pub fn format_search_results(query: &str, backend: &str, hits: &[WebSearchHit]) -> String {
    let mut out = format!("Results for \"{}\" (via {backend}):\n\n", query.trim());
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

    const DDG_HTML_FIXTURE: &str = r#"<div class="results">
      <div class="result results_links results_links_deep web-result">
        <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://example.org/guide">Rust <b>Guide</b></a></h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fguide&amp;rut=abc">A gentle intro to <b>Rust</b> &amp; ownership.</a>
      </div>
      <div class="result results_links results_links_deep web-result">
        <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://docs.example.com/overview">Overview</a></h2>
        <a class="result__snippet" href="https://docs.example.com/overview">The long-form docs.</a>
      </div>
    </div>"#;

    #[test]
    fn the_ddg_html_parser_extracts_hits_and_snippets() {
        let hits = parse_ddg_html(DDG_HTML_FIXTURE);
        assert_eq!(hits.len(), 2, "{hits:?}");
        assert_eq!(hits[0].title, "Rust Guide");
        assert_eq!(hits[0].url, "https://example.org/guide");
        assert!(hits[0].snippet.contains("ownership"), "{:?}", hits[0].snippet);
        assert_eq!(hits[1].url, "https://docs.example.com/overview");
        assert_eq!(hits[1].snippet, "The long-form docs.");
    }

    const SEARXNG_FIXTURE: &str = r#"<div id="results">
      <article class="result result-default">
        <h3><a href="https://example.org/guide" class="url_wrapper">Rust <b>Guide</b></a></h3>
        <p class="content">A gentle intro to Rust &amp; ownership.</p>
      </article>
      <article class="result result-default">
        <h3><a href="https://docs.example.com/overview" class="url_wrapper">Overview</a></h3>
        <p class="content">The long-form docs.</p>
      </article>
      <article class="result">
        <h3><a href="/about">About this instance</a></h3>
      </article>
    </div>"#;

    #[test]
    fn the_searxng_parser_extracts_hits_and_drops_instance_links() {
        let hits = parse_searxng(SEARXNG_FIXTURE);
        assert_eq!(hits.len(), 2, "{hits:?}");
        assert_eq!(hits[0].title, "Rust Guide");
        assert_eq!(hits[0].url, "https://example.org/guide");
        assert!(hits[0].snippet.contains("ownership"), "{:?}", hits[0].snippet);
        assert_eq!(hits[1].url, "https://docs.example.com/overview");
    }

    #[test]
    fn search_results_render_numbered_and_citable() {
        let hits = vec![WebSearchHit {
            title: "T".into(),
            url: "https://example.org/".into(),
            snippet: "S".into(),
        }];
        let out = format_search_results("q", "DuckDuckGo", &hits);
        assert!(out.contains("1. T"), "{out}");
        assert!(out.contains("https://example.org/"), "{out}");
        assert!(out.contains("via DuckDuckGo"), "{out}");
    }

    // ── the backend chain ────────────────────────────────────────────────

    #[test]
    fn the_chain_takes_the_first_backend_that_answers() {
        let fail =
            |_q: &str| -> Result<Vec<WebSearchHit>, String> { Err("backend is down".into()) };
        let serve = |_q: &str| -> Result<Vec<WebSearchHit>, String> {
            Ok(vec![WebSearchHit {
                title: "hit".into(),
                url: "https://example.org/".into(),
                snippet: String::new(),
            }])
        };
        let backends: Vec<(&'static str, DynSearchBackend<'_>)> = vec![("A", &fail), ("B", &serve)];
        let (served, hits) = run_search_chain("q", &backends).expect("B serves");
        assert_eq!(served, "B");
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn the_chain_aggregates_every_failure_when_all_backends_fail() {
        let fail =
            |_q: &str| -> Result<Vec<WebSearchHit>, String> { Err("backend is down".into()) };
        let backends: Vec<(&'static str, DynSearchBackend<'_>)> = vec![("A", &fail), ("B", &fail)];
        let err = run_search_chain("q", &backends).expect_err("all fail");
        assert!(err.contains("A: backend is down"), "{err}");
        assert!(err.contains("B: backend is down"), "{err}");
    }

    #[test]
    fn an_empty_backend_answer_counts_as_a_failure_not_a_success() {
        let empty = |_q: &str| -> Result<Vec<WebSearchHit>, String> { Ok(Vec::new()) };
        let serve = |_q: &str| -> Result<Vec<WebSearchHit>, String> {
            Ok(vec![WebSearchHit {
                title: "hit".into(),
                url: "https://example.org/".into(),
                snippet: String::new(),
            }])
        };
        let backends: Vec<(&'static str, DynSearchBackend<'_>)> =
            vec![("A", &empty), ("B", &serve)];
        let (served, _) = run_search_chain("q", &backends).expect("B serves");
        assert_eq!(served, "B");
    }

    #[test]
    fn an_empty_query_is_refused_before_any_network() {
        assert!(web_search("   ").is_err());
    }

    // ── the fetch cache ──────────────────────────────────────────────────

    #[test]
    fn web_fetch_text_serves_a_second_read_from_the_cache() {
        // The guard runs before the cache, so a live loopback round-trip is not reachable
        // offline by design. Seeding a cache entry for a public-URL key proves the same claim:
        // `web_fetch_text` answers from the cache without any fetch at all.
        let key = "https://example.com/aip-cache-round-trip";
        cache_insert(
            key.to_string(),
            "Page: T\nURL: https://example.com/aip-cache-round-trip\n\ncache me".into(),
            std::time::Instant::now(),
        );
        let second = web_fetch_text(key).expect("served from cache");
        assert!(second.contains("cache me"), "{second}");
        assert!(second.contains("(from cache"), "the cache hit is disclosed: {second}");
    }

    #[test]
    fn an_expired_cache_entry_is_refetched() {
        let url_key = "https://cache-test.invalid/expired".to_string();
        let stale = std::time::Instant::now() - CACHE_TTL - std::time::Duration::from_secs(1);
        cache_insert(url_key.clone(), "stale body".into(), stale);
        assert!(cache_lookup(&url_key).is_none(), "a past-TTL entry must not serve");
    }

    #[test]
    fn a_full_cache_evicts_the_oldest_entry_rather_than_refusing() {
        // Strictly increasing timestamps, so "oldest" is unambiguous — equal ones would leave
        // the eviction choice to HashMap iteration order.
        let now = std::time::Instant::now();
        for i in 0..CACHE_MAX_ENTRIES + 1 {
            let at = now + std::time::Duration::from_millis(i as u64);
            cache_insert(format!("https://cache-test.invalid/{i}"), format!("body {i}"), at);
        }
        // The oldest insert (index 0) was evicted to make room; the newest survives.
        assert!(cache_lookup("https://cache-test.invalid/0").is_none());
        assert!(cache_lookup(&format!("https://cache-test.invalid/{CACHE_MAX_ENTRIES}")).is_some());
    }

    // ── the key tier ─────────────────────────────────────────────────────

    #[test]
    fn the_chain_gains_a_head_slot_only_when_a_key_is_configured() {
        assert_eq!(chain_for(None).len(), 2, "keyless: just the two DDG templates");
        assert_eq!(chain_for(Some("brave|TAV-KEY")).len(), 3, "brave at the head");
        assert_eq!(chain_for(Some("tavily|tvly-123")).len(), 3, "tavily at the head");
        assert_eq!(chain_for(Some("  ")).len(), 2, "a blank secret is no key");
        assert_eq!(
            chain_for(Some("gibberish")).len(),
            2,
            "an unknown provider is ignored, not fatal"
        );
        let names: Vec<&str> = chain_for(Some("brave|k")).iter().map(|(n, _)| *n).collect();
        assert_eq!(names, vec!["Brave", "DuckDuckGo", "DuckDuckGo (html)"]);
    }

    #[test]
    fn the_brave_parser_reads_web_results() {
        let body = r#"{"web":{"results":[
            {"title":"Rust","url":"https://rust-lang.org/","description":"A language"},
            {"title":"Docs","url":"https://doc.rust-lang.org/","description":"The book"}
        ]}}"#;
        let hits = parse_brave_json(body).expect("parses");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].url, "https://rust-lang.org/");
        assert_eq!(hits[1].snippet, "The book");
        assert!(parse_brave_json("{\"type\":\"error\"}").is_err());
    }

    #[test]
    fn the_tavily_parser_reads_results() {
        let body = r#"{"results":[
            {"title":"Rust","url":"https://rust-lang.org/","content":"A language"},
            {"title":"Docs","url":"https://doc.rust-lang.org/","content":"The book"}
        ]}"#;
        let hits = parse_tavily_json(body).expect("parses");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].url, "https://rust-lang.org/");
        assert_eq!(hits[1].snippet, "The book");
        assert!(parse_tavily_json("{\"detail\":\"bad key\"}").is_err());
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

    /// Like [`serve_once`], but the request bytes are captured for assertion. The capture is
    /// written before the response is, so a completed `http_get` implies it is readable.
    fn serve_capture(
        response: &'static str,
    ) -> (String, std::sync::Arc<std::sync::Mutex<String>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let captured = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let cap = captured.clone();
        std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().expect("accept");
            let mut buf = [0u8; 4096];
            let n = sock.read(&mut buf).unwrap_or(0);
            *cap.lock().unwrap() = String::from_utf8_lossy(&buf[..n]).into_owned();
            sock.write_all(response.as_bytes()).expect("write");
        });
        (format!("http://{addr}/page"), captured)
    }

    #[test]
    fn http_get_identifies_as_a_browser_and_carries_accept_headers() {
        // The 2026-10-06 incident: page fetches coming back 403 Forbidden. A UA-only request is
        // the bot-shaped profile sites refuse; these assertions pin that the fetch now carries
        // the browser headers and no longer advertises the app in its UA.
        let (url, captured) = serve_capture(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi",
        );
        let body = http_get(&reqwest::Url::parse(&url).unwrap()).expect("body");
        assert_eq!(body, b"hi");
        let req = captured.lock().unwrap().to_lowercase();
        assert!(req.contains("user-agent:"), "{req}");
        assert!(
            !req.contains("aiproviderrouter"),
            "the app name must not ride the UA: {req}"
        );
        assert!(req.contains("chrome/"), "a browser-shaped UA: {req}");
        assert!(req.contains("accept:"), "{req}");
        assert!(req.contains("accept-language:"), "{req}");
    }

    // ── the post-failure search cooldown ─────────────────────────────────

    #[test]
    fn a_marked_backend_sits_out_the_cooldown_then_returns() {
        let now = Instant::now();
        let expired = now
            .checked_sub(BACKEND_COOLDOWN + Duration::from_secs(1))
            .expect("the clock reaches back past the cooldown window");
        mark_backend_failed("cool-test", expired);
        assert!(
            !backend_is_cooling("cool-test", now),
            "past the window, the backend is live again"
        );

        mark_backend_failed("cool-test", now);
        assert!(backend_is_cooling("cool-test", now), "freshly failed: cooling");

        // Do not leak the entry into other tests sharing the process-wide map.
        search_cooldowns().lock().unwrap().remove("cool-test");
    }

    #[test]
    fn drop_cooling_keeps_the_live_backends_and_refuses_when_all_are_cooling() {
        let now = Instant::now();
        mark_backend_failed("cool-test", now);
        let all: Vec<(&'static str, SearchBackend)> =
            vec![("cool-test", search_ddg_lite), ("live", search_ddg_html)];
        let live = drop_cooling(all, now).expect("one backend still live");
        assert_eq!(live.len(), 1, "only the un-cooled backend survives the filter");
        assert_eq!(live[0].0, "live");

        let all_cooling: Vec<(&'static str, SearchBackend)> =
            vec![("cool-test", search_ddg_lite)];
        assert!(
            drop_cooling(all_cooling, now).is_none(),
            "no live backends means refuse, not hammer"
        );
        search_cooldowns().lock().unwrap().remove("cool-test");
    }

    #[test]
    fn web_search_refuses_instead_of_re_hammering_when_every_backend_is_cooling() {
        // End to end through the real entry point. This assumes no search key is configured in
        // the vault (the keyless chain is exactly the two DDG backends); a machine testing with
        // a "websearch" vault secret would exercise the Brave/Tavily head instead.
        let now = Instant::now();
        for name in ["DuckDuckGo", "DuckDuckGo (html)"] {
            mark_backend_failed(name, now);
        }
        let err = web_search("anything").expect_err("all cooling — refusal before any network");
        assert!(err.contains("cooling down"), "{err}");
        for name in ["DuckDuckGo", "DuckDuckGo (html)"] {
            search_cooldowns().lock().unwrap().remove(name);
        }
    }
}
