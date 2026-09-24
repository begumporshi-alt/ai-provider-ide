//! The host seam an adapter makes its requests through — the port of `ports.ts`'s `HttpPort`
//! (`ports.ts:11-27`) and of `manifest-interpreter.ts`'s `HttpPortLike` (`:35-49`).
//!
//! **Its own module, and the reason is the dependency direction.** `egress.rs` will implement this
//! trait; `interpreter.rs` consumes it. Put the trait in `egress.rs` and the interpreter has to
//! depend on the whole egress — the allowlist, the pairing database, the keychain vault — to name a
//! type it only ever calls two methods on. Put it in `interpreter.rs` and egress has to depend on
//! the interpreter, which is backwards: a host does not know what an adapter is. The trait sits
//! between them and neither side names the other. It is the same split `adapter.rs` took, for the
//! same reason and with the same one-way edge.
//!
//! **This is not the gateway and not egress.** `gateway.rs` is the client-facing server that
//! accepts OpenAI-shaped requests; `egress.rs` is the audited outbound path; this is only the shape
//! those two agree on. Nothing here sends anything.
//!
//! # The response shape, and why it is not the TypeScript's
//!
//! The TypeScript returns one object carrying *both* accessors — `text(): Promise<string>` and
//! `lines: AsyncIterable<string>` — and leaves it to the caller which one to touch. The interpreter
//! touches exactly one per response, and which one it needs is known **before** the request is
//! made: `text` on every path except the SSE loop. So the caller says so, and the port prepares
//! one. A lazy pair would have meant either a buffered body that a streaming response never needs,
//! or a stored future this crate's shape has no room for.
//!
//! The one case where the request's choice is not the caller's need is a **streaming request that
//! answers `>= 400`**: the interpreter reads the status before it touches the stream
//! (`manifest-interpreter.ts:304`) and then wants the provider's words to build the error. So
//! [`HttpResponse::body`] is filled in that case too, and [`HttpResponse::lines`] is empty — the
//! response is an error, and there is nothing to stream. The TypeScript reaches the same place by a
//! different road: its `text()` on a stream that failed waits for the host's error event and
//! returns it (`ipc-client.ts:142-149`).
//!
//! # `Cancel` is reused rather than respelled
//!
//! `adapter.rs` already has the port of `AbortSignal`, and this is the second place the TypeScript
//! passes one (`manifest-interpreter.ts:242`, `:302`). A second abort flag here would be a second
//! answer to "has this request been abandoned", which is exactly the defect this port keeps finding
//! — see `manifest.rs`'s note on the three states it refused to redefine. The dependency edge is
//! one-way: `http_port` knows `adapter`, and `adapter` knows nothing of `http_port`.
//!
//! # What is deliberately absent
//!
//! - **No timeout field.** The TypeScript port passes `timeout_ms: null` on every request
//!   (`ipc-client.ts:39`); timeouts are the host's business and the egress applies its own.
//! - **No method beyond GET and POST.** `egress::build` already refuses anything else
//!   (`egress.rs:235-239`), so a third variant here would be a variant no implementation may serve.
//! - **No `StorePort` or `KeyVaultPort` counterpart.** Both are `throw`-only stubs on the
//!   TypeScript side (`ipc-client.ts:196-224`) because the webview is key-blind and does not own
//!   SQL. In Rust the host *is* the process holding the keychain and the database, so there is
//!   nothing to port — the absence is the point.

use std::collections::BTreeMap;

use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;

use crate::core::adapter::Cancel;

/// One outbound request, described by the caller.
///
/// `headers` is a `BTreeMap` for the reason `egress::EgressRequest` uses one (`egress.rs:99`): it
/// is the type the wire already carries, and a header set has no meaningful order.
///
/// **`secret_ref` is an opaque reference, never a credential.** The interpreter emits auth headers
/// whose value carries the `{{secret}}` sentinel ([`crate::core::egress::SENTINEL`]) and the host
/// substitutes the real value on the way out — which is what makes two concurrent attempts against
/// one provider with different keys unable to cross secrets (invariant 2). Nothing in this module
/// can see a key, and that is structural rather than a convention.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub url: String,
    pub method: HttpMethod,
    pub headers: BTreeMap<String, String>,
    /// The serialised request body, when the call has one.
    pub body: Option<String>,
    /// The keychain reference the host resolves, or `None` for a call that carries no secret.
    pub secret_ref: Option<String>,
    /// Ask for a line stream rather than a materialised body.
    ///
    /// The TypeScript port decides this by *sniffing* the request — an `accept:
    /// text/event-stream` header, or a body whose `stream` field is `true`
    /// (`ipc-client.ts:41`). It can afford to: it sees the same body the interpreter built. The
    /// flag states the same fact without a second reader of the body, and it is the caller's
    /// answer to a question only the caller can answer — *am I going to consume a stream?*
    pub stream: bool,
}

/// The two methods a manifest may use. `egress::build` permits no others.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Post,
}

impl HttpMethod {
    /// The spelling the wire carries — `EgressRequest::method` is a `String` (`egress.rs:98`) and
    /// `egress::build` matches on exactly these two.
    pub fn as_str(self) -> &'static str {
        match self {
            HttpMethod::Get => "GET",
            HttpMethod::Post => "POST",
        }
    }
}

/// A response the host produced.
///
/// See the module note for the `body`/`lines` split and the one case where both rules meet. The
/// short form: **`body` is filled for a unary request and for a streaming request that failed;
/// `lines` is present only for a streaming request that succeeded.**
pub struct HttpResponse<'a> {
    pub status: u16,
    /// The provider's response headers, lower-cased by the host.
    ///
    /// Case matters downstream: [`crate::core::manifest::header_value`] exists because the
    /// interpreter looks `Retry-After` up case-insensitively — a plain map is not a `Headers`, and
    /// providers are not consistent about capitalisation.
    pub headers: BTreeMap<String, String>,
    /// The whole body, as described above. Empty when a streaming response succeeded.
    pub body: String,
    /// The line stream, present exactly when the request asked to stream and the answer was not an
    /// error.
    ///
    /// **An item is a `Result` because a stream can break after it has started.** The TypeScript
    /// throws from inside the async generator (`ipc-client.ts:124`) and the throw propagates out of
    /// the interpreter's `for await`; a Rust stream cannot throw, so the break travels as an item —
    /// the same shape `AdapterInstance::generate_text` uses for the same reason, one layer up. The
    /// egress already produces this case: a provider that goes silent for two minutes ends the
    /// stream with a message rather than a line (`egress.rs:386-394`).
    pub lines: Option<BoxStream<'a, Result<String, HttpError>>>,
}

/// The call did not complete.
///
/// A newtype over the host's own message, matching `core::error::CommandError`'s shape: the
/// interpreter does not read this, it only decides *that* there was no HTTP answer and classifies
/// the attempt as a transport failure — which is what the TypeScript's `instanceof
/// ManifestHttpError` test does by failing (`manifest-interpreter.ts:480-482`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct HttpError(pub String);

impl HttpError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

/// Outbound HTTP, as an adapter sees it.
///
/// `Send + Sync` because a `ManifestInterpreter` is handed to the engine as an
/// `Arc<dyn AdapterInstance>` and every implementor of that trait must be both.
///
/// The returned future borrows `self` for its whole life: a streaming response hands back a stream
/// that is still reading from the port, so the port has to outlive it. That is the same lifetime
/// the TypeScript expresses by keeping the `Channel` open, and it is what lets the stream be
/// dropped to cancel the upstream — the egress's own comment relies on it (`egress.rs:327-329`).
pub trait HttpPort: Send + Sync {
    fn request<'a>(
        &'a self,
        req: HttpRequest,
        cancel: &'a Cancel,
    ) -> BoxFuture<'a, Result<HttpResponse<'a>, HttpError>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two spellings the wire carries, asserted rather than assumed: `egress::build` matches
    /// these exact strings and refuses everything else.
    #[test]
    fn the_method_spellings_are_the_ones_egress_matches_on() {
        assert_eq!(HttpMethod::Get.as_str(), "GET");
        assert_eq!(HttpMethod::Post.as_str(), "POST");
    }

    #[test]
    fn an_http_error_carries_the_hosts_own_message() {
        let e = HttpError::new("upstream went silent for 120s");
        assert_eq!(e.to_string(), "upstream went silent for 120s");
        assert_eq!(e, HttpError("upstream went silent for 120s".to_string()));
    }
}
