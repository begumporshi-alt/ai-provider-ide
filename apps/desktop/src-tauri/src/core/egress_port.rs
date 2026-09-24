//! The egress as an adapter's host — `impl HttpPort for EgressPort`.
//!
//! # Why this module is the one the plan assumed already existed
//!
//! `http_port.rs`'s note and `dev-book/10-headless-service.md:1791` both say, in the future tense,
//! *"`egress.rs` will implement it."* It did not. Reconnaissance on 2026-09-24 measured the
//! consequence: `impl HttpPort` had **seven** occurrences and every one was inside a `#[cfg(test)]`
//! module (`interpreter.rs`, `js_host.rs`, `code_adapter.rs`, `adapter_runtime.rs`), so no
//! production type implemented the trait at all. `AdapterRuntime` was likewise constructed nowhere
//! outside its own tests. The adapter seam was built and tested and had never been connected.
//!
//! That is why this module is small and load-bearing: it is the edge that turns a tested seam into
//! a live path, and until it exists the headless service cannot answer a completion.
//!
//! # The push/pull mismatch, and how it is reconciled
//!
//! The two sides want opposite shapes and neither is wrong:
//!
//! - [`HttpPort::request`] returns a **pull** stream — `HttpResponse::lines` is a
//!   `BoxStream<'a, Result<String, HttpError>>` the interpreter drives with `for await`-style
//!   polling, and dropping it is the documented cancellation.
//! - [`egress::stream`] is a **push** producer — it owns the reqwest body and pushes
//!   [`StreamEvent`]s into a sink until the upstream ends.
//!
//! So the driver is spawned and its events travel through an unbounded channel, which the returned
//! stream drains. The channel is not incidental plumbing; it is the adapter between the two shapes,
//! and it carries cancellation in the direction the egress already understands: dropping the
//! receiver makes the next `send` fail, which is exactly how `egress::stream` learns a consumer has
//! gone away (§3.5).
//!
//! # Headers are out of band, and that is why the first event is consumed here
//!
//! [`HttpResponse`] carries `status` and `headers` *beside* the stream, not inside it, so the
//! response cannot be constructed until the egress has reported them. The first event is therefore
//! awaited before returning rather than yielded. The alternative — a response whose status is
//! `0` until the first poll — would be a lie the interpreter has no way to detect, because it reads
//! the status before it touches the stream (`manifest-interpreter.ts:304`).
//!
//! # The `>= 400` case is the documented asymmetry, not a special case bolted on
//!
//! `http_port.rs:25-31` states the rule: **`body` is filled for a unary request *and for a
//! streaming request that failed*; `lines` is present only for a streaming request that succeeded.**
//! The egress already produces the shape that needs — on a `>= 400` it sends `Headers` and then one
//! `Error` carrying the provider's own words (`egress.rs`, the `status >= 400` arm). So this module
//! reads that second event into `body` and returns `lines: None`, and the contract holds without
//! either side knowing about the other.
//!
//! # What is deliberately absent
//!
//! - **No timeout translation.** [`HttpRequest`] has no timeout field by design (`http_port.rs:43`)
//!   and `egress::build` applies its own, so `timeout_ms` is passed as `None`.
//! - **No cancellation for the unary path.** [`egress::request`] takes no `Cancel` and the egress
//!   never had one for it; the TypeScript passes `timeout_ms: null` on every request. Cancellation
//!   on the streaming path is real and is tested below.

use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;

use crate::core::adapter::Cancel;
use crate::core::egress::{self, EgressRequest, EgressState, StreamEvent};
use crate::core::http_port::{HttpError, HttpPort, HttpRequest, HttpResponse};

/// How often the cancellation watcher checks the flag.
///
/// Short enough that an abandoned request stops paying for a provider stream promptly, long enough
/// that a request's lifetime is not a spin loop. Cancellation is also observed on the sink side
/// (dropping the receiver fails the next `send`), so this only bounds the case where the upstream
/// has gone quiet — which is the case the abort exists for.
const CANCEL_POLL: Duration = Duration::from_millis(25);

/// The egress, seen as an adapter's host.
///
/// Holds an `Arc<EgressState>` rather than a borrow because the streaming driver is spawned and the
/// state must outlive this call. `EgressState` is already the shared, `Send + Sync` handle the app
/// puts in managed state (`tauri/app.rs:186`), so nothing is cloned per request but the `Arc`.
pub struct EgressPort {
    state: Arc<EgressState>,
}

impl EgressPort {
    pub fn new(state: Arc<EgressState>) -> Self {
        Self { state }
    }
}

impl std::fmt::Debug for EgressPort {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // `EgressState` holds reqwest clients, which are not `Debug`. Naming the type is the
        // honest summary; the interesting field would be the allowlist, which is not what this
        // type is for.
        f.write_str("EgressPort")
    }
}

impl HttpPort for EgressPort {
    fn request<'a>(
        &'a self,
        req: HttpRequest,
        cancel: &'a Cancel,
    ) -> BoxFuture<'a, Result<HttpResponse<'a>, HttpError>> {
        Box::pin(async move {
            // Destructured up front: `stream` selects the path, and the remaining fields are moved
            // into the egress request. Reading `req.stream` after moving `req.url` would not
            // compile, and reading it *before* is the kind of ordering a later edit silently
            // inverts.
            let HttpRequest { url, method, headers, body, secret_ref, stream } = req;
            let req = EgressRequest {
                url,
                method: method.as_str().to_string(),
                headers,
                body,
                secret_ref,
                // `http_port` has no timeout field on purpose (`http_port.rs:43`); the egress
                // applies its own connect and idle budgets.
                timeout_ms: None,
            };
            if !stream {
                let res = egress::request(&self.state, req)
                    .await
                    .map_err(|e| HttpError::new(e.to_string()))?;
                return Ok(HttpResponse {
                    status: res.status,
                    headers: res.headers,
                    body: res.body,
                    lines: None,
                });
            }
            streaming(self.state.clone(), req, cancel).await
        })
    }
}

/// Drive one streaming request and shape it as an [`HttpResponse`].
///
/// The lifetime is a parameter even though the stream built here is `'static`: the caller's
/// `HttpResponse<'a>` is what the trait promises, and a `'static` stream coerces into it.
async fn streaming<'a>(
    state: Arc<EgressState>,
    req: EgressRequest,
    cancel: &Cancel,
) -> Result<HttpResponse<'a>, HttpError> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<StreamEvent>();

    let driver = tokio::spawn(async move { egress::stream(&state, req, tx).await });

    // Cancellation is watched here because `egress::stream` cannot see the flag — it only learns a
    // consumer is gone from a failed `send`, which never happens while the upstream is silent.
    // Aborting the driver drops the reqwest body and closes the provider connection. The watcher
    // also exits when the driver finishes, so it is bounded by the request's own lifetime and a
    // completed request leaves no task behind.
    let flag = cancel.clone();
    let _watcher = tokio::spawn(async move {
        loop {
            if flag.is_cancelled() {
                driver.abort();
                // Await the abort so the body is dropped before the watcher exits, rather than
                // racing the runtime for it.
                let _ = driver.await;
                return;
            }
            if driver.is_finished() {
                return;
            }
            tokio::time::sleep(CANCEL_POLL).await;
        }
    });

    // Out of band: see the module note. The response's status is a field, not a stream item.
    let (status, headers) = match rx.recv().await {
        Some(StreamEvent::Headers { status, headers }) => (status, headers),
        Some(StreamEvent::Error { message }) => return Err(HttpError::new(message)),
        // The sender dropped with nothing sent: the driver failed before it could classify. The
        // egress sends an `Error` on every path it can reach, so this is the unreachable residue —
        // reported as a transport failure rather than as a status the provider never gave.
        Some(StreamEvent::Line { .. }) | Some(StreamEvent::Done) | None => {
            return Err(HttpError::new(
                "the egress ended before reporting response headers".to_string(),
            ));
        }
    };

    if status >= 400 {
        // The documented contract: a failed streaming request carries its words in `body` and has
        // no stream. The egress's next event is the one holding the provider's response.
        let body = match rx.recv().await {
            Some(StreamEvent::Error { message }) => message,
            // A `>= 400` with no error event behind it would be a provider that answered an error
            // status and then a clean stream. The status is still the truth and is what the caller
            // classifies on, so the body stays empty rather than being invented.
            _ => String::new(),
        };
        return Ok(HttpResponse { status, headers, body, lines: None });
    }

    let lines: BoxStream<'static, Result<String, HttpError>> = Box::pin(async_stream::stream! {
        while let Some(ev) = rx.recv().await {
            match ev {
                StreamEvent::Line { text } => yield Ok(text),
                StreamEvent::Done => break,
                // A break mid-stream travels as an item, not as an end: the interpreter must be
                // able to tell "the provider stopped talking" from "the answer is complete".
                StreamEvent::Error { message } => {
                    yield Err(HttpError::new(message));
                    break;
                }
                // Not a shape the egress produces after the first event.
                StreamEvent::Headers { .. } => {}
            }
        }
    });

    Ok(HttpResponse { status, headers, body: String::new(), lines: Some(lines) })
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use axum::body::Body;
    use axum::extract::State as AxState;
    use axum::response::Response;
    use axum::routing::post;
    use axum::Router;
    use futures_util::StreamExt;

    use crate::core::egress::{AllowList, EgressState};
    use crate::core::http_port::HttpMethod;
    use crate::core::store::Store;

    /// What the server saw, so an assertion cannot pass on a request that never arrived.
    ///
    /// This is the discipline the drift register keeps rediscovering: an assertion whose expected
    /// failure has more than one cause is not an assertion. "The line arrived" and "the line is
    /// correct" are two claims, and only the first one being true would hide a broken method, path
    /// or body.
    #[derive(Default)]
    struct Seen {
        paths: Mutex<Vec<String>>,
        methods: Mutex<Vec<String>>,
        bodies: Mutex<Vec<String>>,
    }

    impl Seen {
        fn path_count(&self, want: &str) -> usize {
            self.paths.lock().unwrap().iter().filter(|p| *p == want).count()
        }
        fn methods(&self) -> Vec<String> {
            self.methods.lock().unwrap().clone()
        }
        fn bodies(&self) -> Vec<String> {
            self.bodies.lock().unwrap().clone()
        }
    }

    async fn record(seen: &Seen, path: &str, method: &str, body: &str) {
        seen.paths.lock().unwrap().push(path.to_string());
        seen.methods.lock().unwrap().push(method.to_string());
        seen.bodies.lock().unwrap().push(body.to_string());
    }

    /// A unary answer: a status, a header, and a JSON body.
    async fn unary_h(AxState(seen): AxState<Arc<Seen>>, body: String) -> Response {
        record(&seen, "/unary", "POST", &body).await;
        Response::builder()
            .status(200)
            .header("x-provider", "scripted")
            .body(Body::from(r#"{"ok":true}"#))
            .unwrap()
    }

    /// A successful SSE answer: two lines, then the body ends.
    async fn sse_ok_h(AxState(seen): AxState<Arc<Seen>>, body: String) -> Response {
        record(&seen, "/sse", "POST", &body).await;
        let chunks: Vec<Result<axum::body::Bytes, std::convert::Infallible>> = vec![
            Ok(axum::body::Bytes::from_static(b"data: alpha\n")),
            Ok(axum::body::Bytes::from_static(b"data: beta\n")),
        ];
        Response::builder()
            .status(200)
            .header("content-type", "text/event-stream")
            .body(Body::from_stream(futures_util::stream::iter(chunks)))
            .unwrap()
    }

    /// An error answer to a streaming request: the status is the answer and the body is the words.
    async fn sse_err_h(AxState(seen): AxState<Arc<Seen>>, body: String) -> Response {
        record(&seen, "/sse-err", "POST", &body).await;
        Response::builder()
            .status(500)
            .header("content-type", "text/plain")
            .body(Body::from("provider said: model is overloaded"))
            .unwrap()
    }

    /// A stream that never ends on its own, so cancellation is the only thing that can stop it.
    async fn sse_forever_h(AxState(seen): AxState<Arc<Seen>>, body: String) -> Response {
        record(&seen, "/sse-forever", "POST", &body).await;
        let chunks = futures_util::stream::unfold(0u32, |n| async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let item: Result<axum::body::Bytes, std::convert::Infallible> =
                Ok(axum::body::Bytes::from(format!("data: tick {n}\n")));
            Some((item, n + 1))
        });
        Response::builder().status(200).body(Body::from_stream(chunks)).unwrap()
    }

    /// A live server on loopback, plus the record of what it saw.
    ///
    /// `127.0.0.1` is what makes this possible without an allowlist entry: `egress::check_url`
    /// permits loopback unconditionally (`egress.rs`, the `is_local` branch), which is the same
    /// affordance a local Ollama provider relies on.
    async fn serve() -> (String, Arc<Seen>) {
        let seen = Arc::new(Seen::default());
        let app = Router::new()
            .route("/unary", post(unary_h))
            .route("/sse", post(sse_ok_h))
            .route("/sse-err", post(sse_err_h))
            .route("/sse-forever", post(sse_forever_h))
            .with_state(seen.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{addr}"), seen)
    }

    /// A store with no rows. The unary and streaming paths carry no secret, so nothing here reads
    /// the database — but `EgressState` owns one and `check_secret_host` would consult it if a
    /// `secret_ref` were present, which these tests deliberately never set.
    ///
    /// The directory is `AtomicUsize`-suffixed rather than `pid + timestamp`: two tests starting in
    /// the same millisecond would otherwise open the same file and one would fail with
    /// `DatabaseBusy` for a reason that has nothing to do with what it is testing.
    fn store() -> Arc<Store> {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "aip-egress-port-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        Arc::new(Store::open(&dir).unwrap())
    }

    fn port() -> EgressPort {
        EgressPort::new(Arc::new(EgressState::new(Arc::new(AllowList::default()), store())))
    }

    fn request(base: &str, path: &str, stream: bool) -> HttpRequest {
        let mut headers = BTreeMap::new();
        headers.insert("content-type".to_string(), "application/json".to_string());
        HttpRequest {
            url: format!("{base}{path}"),
            method: HttpMethod::Post,
            headers,
            body: Some(r#"{"stream":false}"#.to_string()),
            secret_ref: None,
            stream,
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_unary_request_maps_the_status_headers_and_body() {
        let (base, seen) = serve().await;
        // Both bindings are load-bearing, not style: the trait promises a future that borrows the
        // port for its whole life (`http_port.rs:154-157`) and `HttpResponse` carries the same
        // lifetime, so a temporary would be freed while the response still borrowed it.
        let egress = port();
        let cancel = Cancel::new();
        let res = egress
            .request(request(&base, "/unary", false), &cancel)
            .await
            .expect("the local server answered");

        assert_eq!(res.status, 200);
        assert_eq!(res.headers.get("x-provider").map(String::as_str), Some("scripted"));
        assert_eq!(res.body, r#"{"ok":true}"#);
        assert!(res.lines.is_none(), "a unary answer carries no stream");

        // The request actually arrived, with the method and body the caller set.
        assert_eq!(seen.path_count("/unary"), 1, "the server saw exactly one request");
        assert_eq!(seen.methods(), vec!["POST".to_string()]);
        assert_eq!(seen.bodies(), vec![r#"{"stream":false}"#.to_string()]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_streaming_request_delivers_the_headers_beside_the_lines() {
        let (base, seen) = serve().await;
        let egress = port();
        let cancel = Cancel::new();
        let res = egress
            .request(request(&base, "/sse", true), &cancel)
            .await
            .expect("the local server answered");

        // Headers are out of band: present on the response, not as a stream item.
        assert_eq!(res.status, 200);
        assert_eq!(res.headers.get("content-type").map(String::as_str), Some("text/event-stream"));
        assert!(res.body.is_empty(), "a successful stream has no materialised body");

        let mut lines = res.lines.expect("a successful stream has lines");
        let mut got = Vec::new();
        while let Some(item) = lines.next().await {
            got.push(item.expect("a clean stream yields no error"));
        }
        assert_eq!(got, vec!["data: alpha".to_string(), "data: beta".to_string()]);
        assert_eq!(seen.path_count("/sse"), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_streaming_request_that_answers_500_fills_the_body_and_leaves_no_lines() {
        let (base, _seen) = serve().await;
        let egress = port();
        let cancel = Cancel::new();
        let res = egress
            .request(request(&base, "/sse-err", true), &cancel)
            .await
            .expect("an error status is a response, not a transport failure");

        // The documented asymmetry (`http_port.rs:25-31`): a failed streaming request carries its
        // words in `body` and has no stream.
        assert_eq!(res.status, 500);
        assert!(res.lines.is_none(), "a failed stream has nothing to stream");
        assert!(
            res.body.contains("provider said: model is overloaded"),
            "the provider's own words survive: {:?}",
            res.body
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancelling_ends_the_line_stream_without_waiting_for_the_provider() {
        let (base, _seen) = serve().await;
        let egress = port();
        let cancel = Cancel::new();
        let res = egress
            .request(request(&base, "/sse-forever", true), &cancel)
            .await
            .expect("the server answered with headers");

        let mut lines = res.lines.expect("a successful stream has lines");
        // Read one line, so the stream is demonstrably live and the assertion below is about
        // cancellation rather than about a stream that never started.
        let first = lines.next().await.expect("a first line arrives");
        assert!(first.is_ok(), "the first line is clean: {first:?}");

        cancel.cancel();

        // The server ticks every 20ms forever. If cancellation did not reach the driver, this would
        // never resolve; the bound is generous so the test is about the mechanism, not the clock.
        let ended = tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(item) = lines.next().await {
                if item.is_err() {
                    break;
                }
            }
        })
        .await;
        assert!(ended.is_ok(), "cancelling must end the stream, not leave it running forever");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_host_outside_the_allowlist_is_refused_before_any_connection() {
        // The un-gating must not have widened the egress: a remote host still needs an allowlist
        // entry, and the refusal is a transport failure rather than a fabricated status.
        let egress = port();
        let cancel = Cancel::new();
        // Not `expect_err`: `HttpResponse` holds a `dyn Stream` and so implements no `Debug`, and
        // the helper that would print it does not exist. Matching states the two outcomes instead.
        let err = match egress
            .request(request("http://attacker.example", "/unary", false), &cancel)
            .await
        {
            Ok(_) => panic!("an unregistered remote host is denied"),
            Err(e) => e,
        };
        assert!(
            err.to_string().contains("attacker.example"),
            "the refusal names the host it refused: {err}"
        );
    }
}
