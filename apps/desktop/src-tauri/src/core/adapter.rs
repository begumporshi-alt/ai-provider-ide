//! The adapter seam — the **image half** of what the execution engine needs from a provider
//! adapter, and nothing beyond that half.
//!
//! **The seam has two halves and only one is here.** `adapter-instance.ts` declares seven members;
//! `execution-engine.ts` calls exactly two of them — `generateImage` (`:174`) and `generateText`
//! (`:91`). `generate_image` is the one below. `generate_text` is not, and the reason is not
//! difficulty: its `TextArgs` carries `messages`, `tools`, `toolChoice` and `responseFormat` as
//! `unknown`, plus an `onUsage` callback that is load-bearing — dropping the caller's callback is
//! how every gateway response came to report `usage: null` (`execution-engine.ts:93-96`). On this
//! side those `unknown`s become `serde_json::Value` and the callbacks become owned closures, and
//! `onUsage` would introduce a **second** usage shape beside the `BridgeMsg::Usage` the crate
//! already has (`gateway.rs:366`) — the two-spellings-of-one-state defect this repo keeps finding
//! (D19, D21). **That shape is now decided rather than deferred:** the callback carries
//! `core::usage::UsageTokens`, the crate's single three-field home for token counts, landed in
//! increment 8 and recorded as D23. So the text half is unblocked on that count and on nothing else
//! — the streaming shape, and the ownership of the mutable state the loop must keep alive after
//! `execute_text` returns, are still open.
//!
//! What is here is the Rust port of `adapter-instance.ts` (31 lines) together with the shapes the
//! engine passes across it. It is its own module for the same reason the TypeScript keeps it in its
//! own file: an adapter implementation depends on *this* and not on the engine, so the dependency
//! points one way and the engine can be tested against a double.
//!
//! **What the seam is for.** `manifest-interpreter.ts` (declarative) and `code-adapter.ts` (the
//! Tier-2 sandbox) both implement it, and the engine cannot tell them apart. That is what keeps
//! the sandbox decision open: a subprocess-backed adapter is simply another implementor, so
//! "in-process or out-of-process" is not a question this trait has to answer.
//!
//! **Two traits, not one.** `AdapterInstance` is one provider's adapter; `AdapterFactory` resolves
//! a provider id to it. The TypeScript splits them too (`AdapterFactory` is a private interface
//! inside `execution-engine.ts`), and the split is what lets the engine be handed a factory that
//! returns doubles.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::future::BoxFuture;

use crate::core::engine::AttemptError;

/// An abort flag — the port of `AbortSignal`.
///
/// The engine only ever asks two questions of an `AbortSignal`: *is it aborted*, and *does the
/// adapter see it*. A flag answers both, so a flag is the honest shape rather than a stand-in.
/// `Arc<AtomicBool>` rather than a `CancellationToken` because `tokio-util` is not a dependency
/// and this port may not add one.
#[derive(Debug, Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }

    /// Raise the flag. Idempotent — the TypeScript's `abort()` is too.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// What an image attempt is asked to produce.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageArgs {
    /// The **native** model id, resolved by the planner — not the id the caller typed.
    pub model: String,
    pub prompt: String,
    pub size: Option<String>,
}

/// The outcome of an image attempt.
///
/// **`ok: false` is a refusal, not a failed call.** The provider answered and said no, and the
/// status is what the engine classifies. `Err` from [`AdapterInstance::generate_image`] means the
/// call itself did not complete. The TypeScript draws the same line and it is load-bearing:
/// `manifest-interpreter.ts:461` **returns** `{ok: false, status}` for a `>= 400` rather than
/// throwing, so a refusal keeps its status while a throw does not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageReply {
    pub ok: bool,
    pub status: u16,
    pub base64: Option<String>,
    pub url: Option<String>,
    /// The provider's own words, when it refused. Kept for the ledger and for the operator; the
    /// engine itself never reads it.
    pub error_body: Option<String>,
}

/// One provider's adapter.
pub trait AdapterInstance: Send + Sync {
    /// Generate an image. See [`ImageReply`] for the refusal/throw split.
    fn generate_image<'a>(
        &'a self,
        secret_ref: &'a str,
        args: ImageArgs,
        cancel: &'a Cancel,
    ) -> BoxFuture<'a, Result<ImageReply, AttemptError>>;
}

/// Resolve a provider id to the adapter that serves it.
///
/// Async because the TypeScript's is — resolving may read a manifest, build a sandbox, or start a
/// subprocess. `Err` is a resolution failure, which the engine classifies as a transport failure:
/// the TypeScript's `forProvider` rejection lands in the same `catch` as a thrown `generateImage`.
///
/// **The TypeScript also returns a `baseUrl`, and the engine discards it** (`execution-engine.ts`
/// destructures only `{ adapter }`, at both call sites). So this returns only the adapter. Adding
/// the base URL here would put a field on the seam that no caller reads — the shape of the
/// `BridgeMsg::Usage` gap, where a value the sender holds is dropped one line later.
pub trait AdapterFactory: Send + Sync {
    fn for_provider<'a>(
        &'a self,
        provider_id: &'a str,
    ) -> BoxFuture<'a, Result<Arc<dyn AdapterInstance>, String>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_cancel_is_not_cancelled() {
        assert!(!Cancel::new().is_cancelled());
    }

    #[test]
    fn cancelling_is_visible_through_every_clone() {
        // The whole point of the `Arc`: the engine holds one clone and the adapter another, and a
        // cancel raised on either must be seen by both. A `Clone` that copied the flag would pass
        // a single-clone test and fail here.
        let engine_side = Cancel::new();
        let adapter_side = engine_side.clone();
        assert!(!adapter_side.is_cancelled());

        engine_side.cancel();
        assert!(adapter_side.is_cancelled(), "a clone must observe the same flag");
    }

    #[test]
    fn cancelling_twice_is_the_same_as_cancelling_once() {
        let c = Cancel::new();
        c.cancel();
        c.cancel();
        assert!(c.is_cancelled());
    }
}
