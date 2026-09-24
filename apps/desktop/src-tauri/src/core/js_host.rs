//! js_host — the engine half of `code-adapter.ts`: the QuickJS host, as an **actor**.
//!
//! [`crate::core::sandbox`] is the rules; this is the machinery that runs them. The split is the
//! one that let `manifest.rs` land before `interpreter.rs`, and it is why this module can be read
//! without re-deriving what a guest is allowed to ask for.
//!
//! # Why an actor, and not a struct with fields
//!
//! The seam requires `AdapterInstance: Send + Sync` (`core/adapter.rs`). `rquickjs`'s `parallel`
//! feature gives that to `Runtime` and `Context` — and to **nothing else**. Measured 2026-09-24,
//! D30: `Persistent<T>` carries `rt: *mut JSRuntime` (`persistent.rs:37`) so the wrapper is
//! `!Send`/`!Sync` whatever `T` is, and `Value<'js>` reaches `NonNull<JSContext>`
//! (`context/ctx.rs:74`, through its `Ctx`) and `*mut c_void` inside `JSValue`. `Ctx`, `Value`,
//! `Object`, `Function` and `Persistent<T>` are therefore all `!Send` **and** `!Sync`.
//!
//! So an adapter cannot hold its runtime, its compiled guest or its parked resolvers as fields —
//! and that shape fails at the `Arc<dyn AdapterInstance>` coercion rather than at the definition,
//! which is why the measurement was worth taking before writing it. What is `Send + Sync` here is
//! [`JsSandbox`], a handle holding a channel. The `!Send` values are created **on the actor thread
//! and never move**, which is legal because they are locals of the closure that thread runs.
//!
//! # The async-host shape, which §2.1.3 named as the largest unknown
//!
//! `Context::with` is synchronous and holds the runtime's global lock, so the job pump and an
//! `await` on the egress can never share a scope. One operation is therefore a **sequence of short
//! synchronous scopes separated by awaits**, and every value that must survive a scope boundary
//! crosses it as a [`Persistent`]:
//!
//! ```text
//! loop {
//!     ctx.with(..)  ->  pump the job queue, resolve every parked request that now has an answer
//!     if settled   ->  dump the value and return
//!     outside      ->  await the egress for one parked request, store its answer
//! }
//! ```
//!
//! The TypeScript needs none of this: its QuickJS is a single-threaded WASM module with a flat API,
//! so `callOp`'s loop pumps and awaits in one function body (`code-adapter.ts:408`).
//!
//! # Three traps, each inherited from a measurement rather than re-derived
//!
//! 1. **The module door is `Module::declare` → `eval` → `get("default")`**, never
//!    `eval_with_options`. In module mode the latter returns the module's *evaluation promise*,
//!    which resolves to `undefined`, so a `default` lookup on it finds nothing (§2.1.3 S2/S2b).
//! 2. **The pump is `Ctx::execute_pending_job`**, never `Runtime::is_job_pending` /
//!    `Runtime::execute_pending_job`: `Context::with` already holds the runtime's global lock for
//!    the whole closure, and under `parallel` those two take the same non-reentrant lock, so
//!    calling either inside a scope hangs the thread (§2.1.3 trap 2).
//! 3. **`Persistent` must be dropped before its `Runtime`**, or the process aborts
//!    (`persistent.rs:33-34`). Rust drops struct fields in declaration order, so [`JsHost`] declares
//!    its persistent handle *above* the runtime it belongs to. Field order is the whole of the
//!    safety here, and it is pinned by a test that drops a host and survives.
//!
//! # What is deliberately absent
//!
//! - **The heap ceiling is not a containment boundary.** `MEMORY_LIMIT` is applied because the
//!   reference applies it, but §2.1.3 S6b/S6c measured that an out-of-memory raised while the guest
//!   runs *directly inside the call* takes the process down with `SIGSEGV`. Nothing here claims
//!   otherwise; the subprocess decision is still open.
//! - **The six `AdapterInstance` operations are not implemented.** This module runs *one named
//!   operation* and returns what the guest produced. `listModels`' mapping, `generateText`'s
//!   streaming generator, `pingKey` and `dispose` are the next increment; they are readers over
//!   [`crate::core::sandbox`]'s already-tested functions, and putting them here first would mean
//!   testing them against an unproven engine path.
//! - **`log` is not wired.** The reference installs a `log` global (`code-adapter.ts:166`); §2.1.3
//!   lists it as untested by the spike, and `LOG_LINE_CAP` exists in `sandbox.rs` for it.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rquickjs::{
    promise::PromiseState, Ctx, Function, Module, Object, Persistent, Promise, Runtime,
    String as JsString, Value,
};
use serde_json::{Map, Value as Json};

use crate::core::adapter::Cancel;
use crate::core::http_port::{HttpMethod, HttpPort, HttpRequest};
use crate::core::sandbox::{
    note_emitted_line, plan_http_call, HttpTarget, OpBudget, PlannedCall, SandboxError,
    SandboxReason, BODY_CAP, LOG_LINE_CAP, MEMORY_LIMIT, OP_BUDGET_MS, STACK_LIMIT,
};

/// How far the actor's settle loop may spin without the guest settling or a request parking.
///
/// Not a budget the reference has — the reference's loop is bounded by its wall clock alone — but
/// a loop that can neither settle nor park is a defect in *this* module, and an unbounded one would
/// turn that defect into a hang. The deadline is still the mechanism that stops a runaway guest;
/// this only stops a runaway driver.
const MAX_SETTLE_ROUNDS: usize = 200_000;

/// The C stack the actor thread is given, **explicitly**.
///
/// `set_max_stack_size(STACK_LIMIT)` bounds what QuickJS lets a guest use, and QuickJS measures that
/// against the *real* C stack. Containment therefore needs a C stack larger than the JS limit, and
/// if the C stack runs out first the result is a `SIGSEGV` — S6b's crash signature with an entirely
/// different cause. Measured 2026-09-24, probe **S6g** (`.workbuddy-ai/spikes/js-engine`), on a
/// `std::thread` with its size varied and the JS limit fixed at `STACK_LIMIT`:
///
/// | thread C stack | 256 KB | 512 KB | 768 KB | 1 MB | 2 MB |
/// |---|---|---|---|---|---|
/// | result | `SIGSEGV` | contained | contained | contained | contained |
///
/// So 512 KB — exactly the JS limit — is the measured floor, and 2 MB is Rust's default. This is
/// set **explicitly anyway**, because that default is not a contract: it is 2 MB *unless*
/// `RUST_MIN_STACK` overrides it, which would make containment a property of the environment
/// rather than of this code. `STACK_LIMIT * 4` keeps the measured 4x margin while deriving the
/// number from the limit it protects, so the two cannot drift apart.
const ACTOR_STACK_BYTES: usize = STACK_LIMIT * 4;

/// The three operations a guest may implement. `pingKey` is host-side — it calls `listModels`
/// (`code-adapter.ts:606-614`) — so it is deliberately not a variant.
///
/// The argument shapes are the reference's `extraArgs` callbacks (`code-adapter.ts:456`, `:483`)
/// plus `generateText`'s inline list, and they are not uniform: `http` is always first, `emit` is
/// present for exactly one of the three.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    /// `listModels(http)`.
    ListModels,
    /// `generateText(http, emit, argsJson)`.
    GenerateText,
    /// `generateImage(http, argsJson)`.
    GenerateImage,
}

impl Operation {
    /// The property name the guest's `export default` object must carry.
    pub fn as_str(self) -> &'static str {
        match self {
            Operation::ListModels => "listModels",
            Operation::GenerateText => "generateText",
            Operation::GenerateImage => "generateImage",
        }
    }

    /// Whether the guest's method receives the `emit` callback. Exactly one does.
    pub fn takes_emit(self) -> bool {
        matches!(self, Operation::GenerateText)
    }

    /// Whether the guest's method receives the serialised argument object. Two of three do;
    /// `listModels` takes no arguments at all (`code-adapter.ts:456` returns `[]`).
    pub fn takes_args_json(self) -> bool {
        !matches!(self, Operation::ListModels)
    }
}

/// The runtime limits, as one value.
///
/// Defaults come from [`crate::core::sandbox`]'s constants rather than from literals, so the number
/// a caller reads here and the number the rules module documents cannot drift.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SandboxLimits {
    pub memory_bytes: usize,
    pub stack_bytes: usize,
    pub op_budget_ms: u64,
}

impl Default for SandboxLimits {
    fn default() -> Self {
        SandboxLimits {
            memory_bytes: MEMORY_LIMIT,
            stack_bytes: STACK_LIMIT,
            op_budget_ms: OP_BUDGET_MS,
        }
    }
}

/// What one operation produced.
///
/// `value` is the guest's return value dumped to JSON. The dump is a **walk** rather than a
/// `JSON.stringify` round-trip, and the difference is observable: `stringify` drops a property whose
/// value is `undefined` and renders `NaN`/`Infinity` as `null`, where the reference's `ctx.dump()`
/// keeps them — and `String(NaN)` is `"NaN"`, not `""`. See [`dump`].
#[derive(Debug, Clone, PartialEq)]
pub struct OperationOutcome {
    pub value: Json,
    /// The lines the guest pushed through `emit`, in order. Empty for operations that take no
    /// `emit` callback.
    pub emitted: Vec<String>,
    /// How many `http` calls the operation actually made — the budget the host charged, which is
    /// what a caller needs to tell "the guest made no request" from "the guest's request was
    /// refused".
    pub http_calls: u32,
}

/// One item a streaming caller receives.
///
/// **`End` is always the last item and is sent exactly once**, which is what lets a consumer stop
/// at it instead of guessing: a closed channel alone cannot say whether the guest finished
/// cleanly, was aborted, or died with its thread.
///
/// The terminal outcome travels *here* rather than through the reply future so that the two never
/// have to be interleaved. Holding a receiver and a reply future at once forces a `select` whose
/// only job is to decide which one to poll first, and the borrow that `select` needs fights the
/// one that drops the sender — see [`JsSandbox::stream`].
#[derive(Debug, Clone, PartialEq)]
pub enum Chunk {
    /// One `emit(chunk)` the guest made, in order.
    Line(String),
    /// The operation finished. `Err` carries the reference's own reason.
    End(Result<(), SandboxError>),
}

/// One operation to run, and everything a caller supplies for it that is not a reply channel.
///
/// **Owned, because it travels through the command channel** — `Command` must be `'static`, so the
/// borrowed form the public API accepts is turned into this exactly once, in [`JsSandbox::send`].
///
/// **Six values that are always passed together, in the same order, through four layers are a
/// parameter object rather than an argument list.** They reached `send`, `Command::Call`,
/// `JsHost::call` and `JsHost::drive` positionally, which is the same argument-order hazard
/// restated at every hop, and it is what pushed two of those signatures past
/// `clippy::too_many_arguments`. One spelling of the six also removes the `#[allow]` that
/// `JsHost::drive` needed while it was carrying them one by one.
struct CallSpec {
    operation: Operation,
    args_json: String,
    target: HttpTarget,
    secret_ref: String,
    egress: Arc<dyn HttpPort>,
    cancel: Cancel,
}

impl CallSpec {
    /// The borrowed form the public API takes, turned into the owned form the channel needs.
    fn new(
        operation: Operation,
        args_json: &str,
        target: &HttpTarget,
        secret_ref: &str,
        egress: Arc<dyn HttpPort>,
        cancel: &Cancel,
    ) -> CallSpec {
        CallSpec {
            operation,
            args_json: args_json.to_string(),
            target: target.clone(),
            secret_ref: secret_ref.to_string(),
            egress,
            cancel: cancel.clone(),
        }
    }
}

/// A command for the actor thread.
///
/// The egress travels as an `Arc<dyn HttpPort>` because `HttpPort: Send + Sync` and the request's
/// future borrows the port for its whole life (`http_port.rs:158-164`), so the port has to outlive
/// the await inside the actor. `Cancel` is `Arc<AtomicBool>` (`adapter.rs:54`) and is cloned per
/// operation, which is the same sharing the interpreter uses. Both live in [`CallSpec`].
enum Command {
    Call {
        spec: CallSpec,
        /// Set only when the caller wants the guest's `emit` lines **as they happen**. `None` on
        /// the ordinary path, where the lines come back together in
        /// [`OperationOutcome::emitted`] once the operation has settled.
        chunks: Option<tokio::sync::mpsc::UnboundedSender<Chunk>>,
        reply: tokio::sync::oneshot::Sender<Result<OperationOutcome, SandboxError>>,
    },
    /// Drop the runtime and end the thread. Nothing is replied to: the handle's `Drop` cannot wait
    /// for an answer, and a caller that needs to know the guest is gone joins the thread.
    Shutdown,
}

/// A handle to a guest, on whatever thread the caller happens to be.
///
/// **This is the type that satisfies the seam's `Send + Sync`.** It holds a channel and a join
/// handle — no `Runtime`, no `Context`, no `Persistent` — because none of those may cross a thread
/// boundary (see the module note).
pub struct JsSandbox {
    commands: tokio::sync::mpsc::UnboundedSender<Command>,
    /// Behind a mutex so teardown can take `&self`. [`crate::core::adapter::AdapterInstance`]'s
    /// `dispose` is `&self`, and a caller holding an adapter behind a shared reference — the only
    /// shape a registry of live adapters can hand out — has no way to obtain a `&mut`. Joining
    /// needs *ownership* of the handle, so the slot is `Option` inside the lock and `take` is what
    /// makes a second `dispose` a no-op rather than a second join.
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
    /// The guest's `log(...)` lines, shared with the actor.
    ///
    /// **Created here, not inside `JsHost`, because a queue on the actor thread has no reader.**
    /// `JsHost` never leaves that thread and is never named from outside it, so an `Arc` it alone
    /// held would be a buffer nothing could ever drain — and the field would be dead code, which
    /// is how this was first written. One `Arc`, cloned into the actor and kept on the handle, is
    /// the whole difference.
    log_lines: Arc<Mutex<Vec<String>>>,
}

impl std::fmt::Debug for JsSandbox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let alive = self.thread.lock().unwrap().is_some();
        f.debug_struct("JsSandbox").field("alive", &alive).finish()
    }
}

impl JsSandbox {
    /// Compile `source` and start the actor thread.
    ///
    /// Compilation happens **on the actor thread**, so a source that does not parse is reported
    /// here as [`SandboxReason::Compile`] rather than surfacing at the first call. That is the
    /// reference's `ensure()`/`compile()` split (`code-adapter.ts:202`) collapsed into one step,
    /// and the reason it is safe to collapse is that `Module::declare` compiles *without running*.
    pub fn spawn(source: &str, limits: SandboxLimits) -> Result<JsSandbox, SandboxError> {
        let source = source.to_string();
        let (commands, mut rx) = tokio::sync::mpsc::unbounded_channel::<Command>();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), SandboxError>>();
        // Shared before the thread starts, so the actor's half can move into it while this half
        // stays readable from any thread. See the field's note for why it cannot be the actor's.
        let log_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let actor_log_lines = log_lines.clone();

        let thread = std::thread::Builder::new()
            .name("js-sandbox".to_string())
            // Not `std::thread`'s default — see `ACTOR_STACK_BYTES`. A default here would make the
            // guest's containment depend on `RUST_MIN_STACK`.
            .stack_size(ACTOR_STACK_BYTES)
            .spawn(move || {
                // A current-thread runtime, because everything here is `!Send` by construction.
                let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                    Ok(rt) => rt,
                    Err(e) => {
                        let _ = ready_tx.send(Err(SandboxError::new(
                            SandboxReason::Host,
                            format!("the sandbox runtime could not start: {e}"),
                        )));
                        return;
                    }
                };
                rt.block_on(async move {
                    let host = match JsHost::compile(&source, limits, actor_log_lines) {
                        Ok(host) => {
                            let _ = ready_tx.send(Ok(()));
                            host
                        }
                        Err(e) => {
                            let _ = ready_tx.send(Err(e));
                            return;
                        }
                    };
                    while let Some(command) = rx.recv().await {
                        match command {
                            Command::Shutdown => break,
                            Command::Call { spec, chunks, reply } => {
                                let outcome = host.call(&spec, chunks.as_ref()).await;
                                // `End` goes out **before** the reply, and is the last item: the
                                // sender dies with this command, so the consumer's `recv` reports
                                // closure immediately after it.
                                if let Some(chunks) = chunks {
                                    let end = match &outcome {
                                        Ok(_) => Ok(()),
                                        Err(e) => Err(e.clone()),
                                    };
                                    let _ = chunks.send(Chunk::End(end));
                                }
                                // A closed receiver means the caller gave up; that is not this
                                // thread's problem and must not end the actor.
                                let _ = reply.send(outcome);
                            }
                        }
                    }
                    // `host` is dropped here, before the runtime handle, and its own field order
                    // puts the `Persistent` ahead of the `Runtime` it belongs to.
                    drop(host);
                });
            })
            .map_err(|e| {
                SandboxError::new(SandboxReason::Host, format!("the sandbox thread failed: {e}"))
            })?;

        match ready_rx.recv() {
            Ok(Ok(())) => Ok(JsSandbox { commands, thread: Mutex::new(Some(thread)), log_lines }),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => {
                let _ = thread.join();
                Err(SandboxError::new(
                    SandboxReason::Host,
                    "the sandbox thread died before it reported",
                ))
            }
        }
    }

    /// Run one named operation and wait for it.
    ///
    /// `target` and `secret_ref` are the manifest's, already rendered — [`HttpTarget::new`] does the
    /// rendering, and the rules that decide whether a guest may make a given call live in
    /// [`crate::core::sandbox::plan_http_call`], so this function never sees a credential.
    pub async fn call(
        &self,
        operation: Operation,
        args_json: &str,
        target: &HttpTarget,
        secret_ref: &str,
        egress: Arc<dyn HttpPort>,
        cancel: &Cancel,
    ) -> Result<OperationOutcome, SandboxError> {
        let spec = CallSpec::new(operation, args_json, target, secret_ref, egress, cancel);
        let reply = self.send(spec, None)?;
        reply.await.map_err(|_| {
            SandboxError::new(SandboxReason::Host, "the sandbox thread dropped the request")
        })?
    }

    /// Run an operation and receive the guest's `emit` lines **as it produces them**.
    ///
    /// **The command is sent here and the reply is not awaited, so this is synchronous** and the
    /// actor is already working when it returns. That is what makes the result a stream rather than
    /// a future, and why the terminal outcome travels as [`Chunk::End`] instead of down the reply
    /// channel: a caller holding both would need a `select` to interleave them, and the borrow that
    /// `select` holds on the future fights the one that drops the sender — the drop is what closes
    /// the channel, so it cannot happen while the future is borrowed. One channel carries both.
    ///
    /// Meaningful only for an operation that takes `emit` ([`Operation::takes_emit`]); any other
    /// produces `End` and nothing before it.
    pub fn stream(
        &self,
        operation: Operation,
        args_json: &str,
        target: &HttpTarget,
        secret_ref: &str,
        egress: Arc<dyn HttpPort>,
        cancel: &Cancel,
    ) -> Result<tokio::sync::mpsc::UnboundedReceiver<Chunk>, SandboxError> {
        let (chunks_tx, chunks_rx) = tokio::sync::mpsc::unbounded_channel();
        let spec = CallSpec::new(operation, args_json, target, secret_ref, egress, cancel);
        self.send(spec, Some(chunks_tx))?;
        Ok(chunks_rx)
    }

    /// Hand one operation to the actor. The only failure is a sandbox that is no longer there,
    /// which is reported **here rather than later** — a caller that got a receiver would otherwise
    /// wait forever on a channel nobody will ever write to.
    fn send(
        &self,
        spec: CallSpec,
        chunks: Option<tokio::sync::mpsc::UnboundedSender<Chunk>>,
    ) -> Result<tokio::sync::oneshot::Receiver<Result<OperationOutcome, SandboxError>>, SandboxError>
    {
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        self.commands
            .send(Command::Call { spec, chunks, reply: reply_tx })
            .map_err(|_| SandboxError::new(SandboxReason::Host, "the sandbox thread is gone"))?;
        Ok(reply_rx)
    }

    /// Take the guest's `log(...)` lines, leaving the queue empty.
    ///
    /// **Drain, not read.** `log` is a global the guest may call at any moment, including between
    /// two operations, so copy-and-clear is the only shape that can neither lose a line nor hand
    /// the same one out twice.
    pub fn drain_log_lines(&self) -> Vec<String> {
        std::mem::take(&mut *self.log_lines.lock().unwrap())
    }

    /// Stop the actor and wait for its thread.
    ///
    /// Idempotent, and safe to call from `Drop`. The reference's `dispose()` (`code-adapter.ts`)
    /// also marks every in-flight deferred so a guest parked on a promise is not left waiting; here
    /// the parked resolvers die with the context, which is the same outcome by a shorter road.
    ///
    /// **`&self`, not `&mut self`, because the seam demands it.** `AdapterInstance::dispose` takes
    /// `&self`, so a `&mut` here would force every adapter to wrap the sandbox in a lock it then
    /// has to hold across an await — which is either a `Send` error or a serialization of every
    /// operation. Taking `&self` and locking only for the join costs one mutex on a path that runs
    /// once.
    pub fn dispose(&self) {
        let _ = self.commands.send(Command::Shutdown);
        let thread = self.thread.lock().unwrap().take();
        if let Some(thread) = thread {
            let _ = thread.join();
        }
    }
}

impl Drop for JsSandbox {
    fn drop(&mut self) {
        self.dispose();
    }
}

/// One `http` call the guest made, plus the two resolvers waiting on it.
///
/// `request` is already a [`PlannedCall`] rather than a raw JS value, so the decision about whether
/// the call is allowed was taken **inside the scope where the guest called it** — which is where the
/// reference takes it too (`code-adapter.ts:274-288`), and where a rejection can still reach the
/// guest's own `await`.
struct Parked {
    call: PlannedCall,
    resolve: Persistent<Function<'static>>,
    reject: Persistent<Function<'static>>,
    /// Filled by the driver once the egress has answered. `None` means "still in flight".
    answer: Option<Result<HttpAnswer, String>>,
}

/// The two fields a guest sees: `{ status, text }` (`code-adapter.ts:311-314`).
struct HttpAnswer {
    status: u16,
    text: String,
}

/// The `!Send` innards. Created on the actor thread; never moves.
struct JsHost {
    /// **Declared before `runtime` on purpose.** Rust drops fields in declaration order, and a
    /// `Persistent` that outlives its `Runtime` aborts the process (`persistent.rs:33-34`).
    adapter: Persistent<Object<'static>>,
    /// Held to own the runtime for the host's whole life, and to fix the drop order above. Nothing
    /// here reads it after `compile` — the limits and the interrupt handler are installed there —
    /// so it would otherwise be dead code. The `allow` is the honest way to say the field is
    /// load-bearing without inventing a reader to satisfy the lint.
    #[allow(dead_code)]
    runtime: Runtime,
    context: rquickjs::Context,
    /// Epoch milliseconds. `u64::MAX` is the single spelling of "no deadline" — see the note in
    /// `compile` for why there is deliberately no separate `armed` flag beside it.
    deadline_ms: Arc<AtomicU64>,
    limits: SandboxLimits,
}

impl JsHost {
    /// `log_lines` is the shared queue from [`JsSandbox::spawn`]; `compile` only hands a clone of
    /// it to the `log` closure and does not keep one.
    fn compile(
        source: &str,
        limits: SandboxLimits,
        log_lines: Arc<Mutex<Vec<String>>>,
    ) -> Result<JsHost, SandboxError> {
        let runtime = Runtime::new().map_err(|e| {
            SandboxError::new(SandboxReason::Host, format!("QuickJS did not start: {e}"))
        })?;
        runtime.set_memory_limit(limits.memory_bytes);
        runtime.set_max_stack_size(limits.stack_bytes);

        // `u64::MAX` is the **single** spelling of "no deadline", and it is what makes an idle
        // runtime uninterruptible: while no operation is in flight, the comparison below is false
        // for every clock reading, so a stale deadline cannot abort the next operation.
        //
        // A separate `armed: Arc<AtomicBool>` was written here first, on the theory that one
        // interrupt handler per *runtime* (rather than the reference's one per *operation*) needed a
        // flag to stop two operations inheriting each other's deadline. It does not — resetting the
        // sentinel already does that. Measured: the whole module suite, including the test that
        // aborts a spinning guest, passes with the flag removed. The flag was therefore a second
        // spelling of one state, and the theory behind it was wrong.
        let deadline_ms = Arc::new(AtomicU64::new(u64::MAX));
        {
            let deadline_ms = deadline_ms.clone();
            runtime.set_interrupt_handler(Some(Box::new(move || {
                now_ms() > deadline_ms.load(Ordering::SeqCst)
            })));
        }

        let context = rquickjs::Context::full(&runtime).map_err(|e| {
            SandboxError::new(SandboxReason::Host, format!("the guest context failed: {e}"))
        })?;

        // Install the global `log` function before compiling the guest, so the guest can use it
        // during top-level evaluation. `log` is not per-operation — it persists across calls.
        context.with(|ctx| -> Result<(), SandboxError> {
            let log_fn = make_log(&ctx, log_lines.clone())?;
            let global: Object = ctx.globals();
            global.set("log", log_fn).map_err(host_lost)?;
            Ok(())
        })?;

        let adapter = context.with(|ctx| -> Result<Persistent<Object<'static>>, SandboxError> {
            let declared = Module::declare(ctx.clone(), "adapter.mjs", source.to_string())
                .map_err(|e| SandboxError::new(SandboxReason::Compile, e.to_string()))?;
            let (module, promise) = declared
                .eval()
                .map_err(|e| SandboxError::new(SandboxReason::Compile, e.to_string()))?;
            // A guest with top-level `await` settles its evaluation promise on the job queue. The
            // reference never sees this because its engine evaluates synchronously; observing it
            // costs one pump and removes a class of "the guest compiled but is empty" mystery.
            if promise.state() == PromiseState::Pending {
                pump(&ctx, 10_000);
            }
            let default: Value = module
                .get("default")
                .map_err(|e| SandboxError::new(SandboxReason::Compile, e.to_string()))?;
            if !default.is_object() {
                return Err(SandboxError::new(
                    SandboxReason::Compile,
                    format!(
                        "the guest must `export default {{...}}`; it exported {}",
                        default.type_of()
                    ),
                ));
            }
            let object = default.into_object().ok_or_else(|| {
                SandboxError::new(SandboxReason::Compile, "the default export is not an object")
            })?;
            Ok(Persistent::save(&ctx, object))
        })?;

        Ok(JsHost { adapter, runtime, context, deadline_ms, limits })
    }

    /// One operation, start to finish. Runs on the actor thread.
    ///
    /// `chunks` is `Some` when the caller is streaming: the lines are handed over as they are
    /// emitted and are therefore **absent** from the returned [`OperationOutcome::emitted`],
    /// because they have a new owner.
    async fn call(
        &self,
        spec: &CallSpec,
        chunks: Option<&tokio::sync::mpsc::UnboundedSender<Chunk>>,
    ) -> Result<OperationOutcome, SandboxError> {
        let budget = Rc::new(RefCell::new(OpBudget::default()));
        let emitted: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
        let parked: Rc<RefCell<Vec<Parked>>> = Rc::new(RefCell::new(Vec::new()));
        // The line cap cannot be enforced from inside the `emit` callback — a callback that throws
        // surfaces *inside* the guest's own `await`, where the guest has no `catch` — so the
        // callback records the message here and the driver is what turns it into a failure.
        let emit_failure: Rc<RefCell<Option<String>>> = Rc::new(RefCell::new(None));

        // Set the deadline for this operation only, and restore the sentinel on every exit path —
        // including an early return — so the next call cannot inherit this one's deadline.
        self.deadline_ms.store(now_ms().saturating_add(self.limits.op_budget_ms), Ordering::SeqCst);
        let result = self.drive(spec, &budget, &emitted, &parked, &emit_failure, chunks).await;
        self.deadline_ms.store(u64::MAX, Ordering::SeqCst);

        result.map(|value| OperationOutcome {
            value,
            emitted: emitted.borrow().clone(),
            http_calls: budget.borrow().http_calls,
        })
    }

    /// The pump/await alternation. See the module note for why it cannot be one scope.
    async fn drive(
        &self,
        spec: &CallSpec,
        budget: &Rc<RefCell<OpBudget>>,
        emitted: &Rc<RefCell<Vec<String>>>,
        parked: &Rc<RefCell<Vec<Parked>>>,
        emit_failure: &Rc<RefCell<Option<String>>>,
        chunks: Option<&tokio::sync::mpsc::UnboundedSender<Chunk>>,
    ) -> Result<Json, SandboxError> {
        // Scope 1: build the host functions, call the guest's method, keep the promise.
        let promise: Persistent<Promise<'static>> =
            self.context.with(|ctx| -> Result<Persistent<Promise<'static>>, SandboxError> {
                let adapter = self.adapter.clone().restore(&ctx).map_err(host_lost)?;
                let method: Value = adapter
                    .get(spec.operation.as_str())
                    .map_err(|e| SandboxError::new(SandboxReason::Runtime, e.to_string()))?;
                if !method.is_function() {
                    return Err(SandboxError::new(
                        SandboxReason::Runtime,
                        format!("adapter does not implement {}()", spec.operation.as_str()),
                    ));
                }
                let method = method.into_function().ok_or_else(|| {
                    SandboxError::new(SandboxReason::Runtime, "the guest method is not callable")
                })?;

                let http = make_http(
                    &ctx,
                    &spec.target,
                    &spec.secret_ref,
                    budget.clone(),
                    parked.clone(),
                )?;
                // `rquickjs::String::from_str` takes the `Ctx` **by value** and is the only way to
                // build a JS string in 0.9.0 — there is no `Ctx::new_string`. The name is aliased
                // at the import because an unaliased `String` would shadow `std::string::String`
                // for the whole module.
                // `::<_, Value>` is not decoration: nothing else pins the return type, because
                // `into_promise()` below only constrains it *after* the match has to have one.
                let args = match (spec.operation.takes_emit(), spec.operation.takes_args_json()) {
                    (true, true) => {
                        let emit =
                            make_emit(&ctx, emitted.clone(), budget.clone(), emit_failure.clone())?;
                        let args =
                            JsString::from_str(ctx.clone(), &spec.args_json).map_err(host_lost)?;
                        method
                            .call::<_, Value>((http, emit, args))
                            .map_err(|e| runtime_failure(spec.operation, e))?
                    }
                    (false, true) => {
                        let args =
                            JsString::from_str(ctx.clone(), &spec.args_json).map_err(host_lost)?;
                        method
                            .call::<_, Value>((http, args))
                            .map_err(|e| runtime_failure(spec.operation, e))?
                    }
                    _ => method
                        .call::<_, Value>((http,))
                        .map_err(|e| runtime_failure(spec.operation, e))?,
                };
                let promise: Promise = args.into_promise().ok_or_else(|| {
                    SandboxError::new(
                        SandboxReason::Runtime,
                        format!(
                            "{}() must be async; it returned a non-promise",
                            spec.operation.as_str()
                        ),
                    )
                })?;
                Ok(Persistent::save(&ctx, promise))
            })?;

        // The alternation.
        let mut rounds = 0usize;
        loop {
            rounds += 1;
            if rounds > MAX_SETTLE_ROUNDS {
                return Err(SandboxError::new(
                    SandboxReason::Host,
                    format!("the settle loop ran {rounds} rounds without settling or parking"),
                ));
            }

            // Scope: resolve everything that has an answer, then drain the queue. Kept short,
            // because `Context::with` holds the global lock for its whole body.
            //
            // **The order is load-bearing.** Resolving a parked request queues the guest's
            // continuation as a job, so a pump that ran *before* the resolve leaves the guest
            // suspended for a whole extra round — and when that request was the last one, the driver
            // then finds nothing to await and reports a timeout for a guest that was one job away
            // from finishing. Measured: the verbatim guest did exactly that before this was fixed,
            // and `a_verbatim_guest_runs_through_the_actor` is the test that caught it.
            let state = self.context.with(|ctx| -> Result<PromiseState, SandboxError> {
                resolve_answered(&ctx, parked)?;
                pump(&ctx, 100_000);
                let promise = promise.clone().restore(&ctx).map_err(host_lost)?;
                Ok(promise.state())
            })?;

            // **Forward before deciding anything.** The reference yields every queued chunk
            // *before* it throws the emit failure (`code-adapter.ts:574-577`), so a guest that
            // emits to the cap and keeps going still has its first `EMIT_LINES_PER_OP` lines
            // delivered — the cap ends the stream, it does not revoke what was already said.
            forward(chunks, emitted);
            if let Some(message) = emit_failure.borrow().clone() {
                return Err(SandboxError::new(SandboxReason::Limits, message));
            }

            if state != PromiseState::Pending {
                return self.read_result(&promise, spec.operation);
            }

            // Outside every scope: is there a request waiting for the egress?
            let waiting = {
                let parked = parked.borrow();
                parked.iter().position(|p| p.answer.is_none())
            };
            if let Some(index) = waiting {
                let call = parked.borrow()[index].call.clone();
                let answer = self.service(&call, spec.egress.as_ref(), &spec.cancel).await;
                parked.borrow_mut()[index].answer = Some(answer);
                continue;
            }

            // Nothing settled and nothing to await: either the guest is spinning inside a job (and
            // only the interrupt handler can stop it) or it is waiting on a promise nobody will
            // resolve. Both are terminal, and both must be reported rather than spun on.
            if spec.cancel.is_cancelled() {
                return Err(SandboxError::new(
                    SandboxReason::Host,
                    format!("{}() was cancelled", spec.operation.as_str()),
                ));
            }
            return Err(SandboxError::new(
                SandboxReason::Timeout,
                format!(
                    "{}() neither settled nor requested anything within {} ms",
                    spec.operation.as_str(),
                    self.limits.op_budget_ms
                ),
            ));
        }
    }

    /// Read a settled promise's value, dumping it out of the scope.
    ///
    /// **The rejection reason is not in the `Err`.** `Promise::result` answers a rejected promise by
    /// re-throwing its value onto the context and returning `Err(Error::Exception)`
    /// (`value/promise.rs:107-113`), so the reason has to be read back with `Ctx::catch`. Reading
    /// the `Err` as if it were the reason reports every rejection as the literal string
    /// "exception" — the message is what a caller diagnoses from, so this is not cosmetic.
    fn read_result(
        &self,
        promise: &Persistent<Promise<'static>>,
        operation: Operation,
    ) -> Result<Json, SandboxError> {
        self.context.with(|ctx| -> Result<Json, SandboxError> {
            let promise = promise.clone().restore(&ctx).map_err(host_lost)?;
            let settled = promise.result::<Value>().ok_or_else(|| {
                SandboxError::new(SandboxReason::Runtime, "the promise settled without a result")
            })?;
            match settled {
                Ok(value) => Ok(dump(value)),
                Err(_) => {
                    // `catch` takes the pending exception and clears it. The value is whatever the
                    // guest rejected with, which is usually an `Error` and not always.
                    let thrown = ctx.catch();
                    Err(SandboxError::new(
                        SandboxReason::Runtime,
                        format!("{}() rejected: {}", operation.as_str(), describe(&thrown)),
                    ))
                }
            }
        })
    }

    /// One egress round trip, outside every JS scope.
    async fn service(
        &self,
        call: &PlannedCall,
        egress: &dyn HttpPort,
        cancel: &Cancel,
    ) -> Result<HttpAnswer, String> {
        let method = if call.method == "GET" { HttpMethod::Get } else { HttpMethod::Post };
        let mut headers = std::collections::BTreeMap::new();
        for (name, value) in &call.headers {
            headers.insert(name.clone(), value.clone());
        }
        let request = HttpRequest {
            url: call.url.clone(),
            method,
            headers,
            body: call.body.clone(),
            secret_ref: Some(call.secret_ref.clone()),
            // The sandbox's `http` is unary by construction: the guest gets `{status, text}` and
            // there is no line stream to give it (`code-adapter.ts:300-306` reads the whole body).
            stream: false,
        };
        match egress.request(request, cancel).await {
            Ok(response) => {
                // The reference caps the body after reading it (`code-adapter.ts:306`), so the cap
                // bounds what reaches the guest rather than what the socket receives.
                let mut text = response.body;
                if text.len() > BODY_CAP {
                    text.truncate(floor_char_boundary(&text, BODY_CAP));
                }
                Ok(HttpAnswer { status: response.status, text })
            }
            // The reference's message is `http: ${String(e.message).slice(0, 300)}`
            // (`code-adapter.ts:324`). The slice is UTF-16 units there; this is scalar values, the
            // divergence `sandbox.rs` already records for `ERROR_BODY_CAP`.
            Err(e) => {
                let message = e.to_string();
                let cut: String = message.chars().take(300).collect();
                Err(format!("http: {cut}"))
            }
        }
    }
}

/// Drain the job queue. `Ctx::execute_pending_job`, never `Runtime::*` — see the module note.
///
/// The return value folds "a job ran" together with "a job threw" (both are `res != 0`), so a
/// caller that needs to see an exception must read the promise, which is what `read_result` does.
fn pump<'js>(ctx: &Ctx<'js>, cap: usize) -> usize {
    let mut ran = 0usize;
    while ran < cap && ctx.execute_pending_job() {
        ran += 1;
    }
    ran
}

/// Restore and call the resolvers of every parked request the driver has answered.
fn resolve_answered<'js>(
    ctx: &Ctx<'js>,
    parked: &Rc<RefCell<Vec<Parked>>>,
) -> Result<(), SandboxError> {
    // Indices first, so no borrow is held while a JS call runs.
    let ready: Vec<usize> = {
        let parked = parked.borrow();
        parked.iter().enumerate().filter(|(_, p)| p.answer.is_some()).map(|(i, _)| i).collect()
    };
    // Reverse order: removing from the tail keeps the indices of the ones not yet taken valid.
    for index in ready.into_iter().rev() {
        let entry = parked.borrow_mut().remove(index);
        let Some(answer) = entry.answer else { continue };
        match answer {
            Ok(answer) => {
                let object = Object::new(ctx.clone()).map_err(host_lost)?;
                object.set("status", answer.status).map_err(host_lost)?;
                object.set("text", answer.text).map_err(host_lost)?;
                let resolve = entry.resolve.restore(ctx).map_err(host_lost)?;
                // A guest that has already given up on this promise is not an error: the reference
                // guards the same way with `isAlive()` (`code-adapter.ts:307`).
                let _ = resolve.call::<_, ()>((object,));
            }
            Err(message) => {
                let reason = JsString::from_str(ctx.clone(), &message).map_err(host_lost)?;
                let reject = entry.reject.restore(ctx).map_err(host_lost)?;
                let _ = reject.call::<_, ()>((reason,));
            }
        }
    }
    Ok(())
}

/// Build the guest's `http(req) -> Promise<{status, text}>`.
///
/// **The decision is taken here, in the guest's own scope.** The reference's `fail()` rejects the
/// returned promise rather than throwing, so a contract failure surfaces at the guest's `await`
/// instead of continuing on a half-formed result (`code-adapter.ts:263-272`). Reproducing that is
/// the point of returning a promise even on the error path.
fn make_http<'js>(
    ctx: &Ctx<'js>,
    target: &HttpTarget,
    secret_ref: &str,
    budget: Rc<RefCell<OpBudget>>,
    parked: Rc<RefCell<Vec<Parked>>>,
) -> Result<Function<'js>, SandboxError> {
    let target = target.clone();
    let secret_ref = secret_ref.to_string();
    Function::new(
        ctx.clone(),
        move |ctx: Ctx<'js>, req: Value<'js>| -> rquickjs::Result<Promise<'js>> {
            let (promise, resolve, reject) = ctx.promise()?;
            // `req` arrives as a `Value`; `plan_http_call` wants an `Option<&Json>`, so the guest's
            // argument is dumped first. That is also what makes the parked entry scope-free.
            let dumped = dump(req);
            let arg = if dumped.is_null() { None } else { Some(dumped) };
            let mut budget = budget.borrow_mut();
            match plan_http_call(&mut budget, arg.as_ref(), &target, &secret_ref) {
                Ok(call) => {
                    parked.borrow_mut().push(Parked {
                        call,
                        resolve: Persistent::save(&ctx, resolve),
                        reject: Persistent::save(&ctx, reject),
                        answer: None,
                    });
                    Ok(promise)
                }
                Err(message) => {
                    let reason = JsString::from_str(ctx.clone(), &message)?;
                    // The reject callback is consumed; the promise keeps the value alive.
                    reject.call::<_, ()>((reason,))?;
                    Ok(promise)
                }
            }
        },
    )
    .map_err(|e| SandboxError::new(SandboxReason::Host, format!("http() was not built: {e}")))
}

/// Build the guest's `emit(chunk)`, which charges the line budget and queues the text.
///
/// **Two rules live here, and streaming is what makes both observable.**
///
/// The per-operation line cap is enforced by *dropping* the line and recording the message for the
/// driver, not by failing here: a host function that throws surfaces at the guest's own `await`,
/// where the guest has no `catch`. The driver reads `failure` after it has forwarded everything
/// already queued, which is the reference's order (`code-adapter.ts:574-577`).
///
/// **The cap itself is [`crate::core::sandbox::note_emitted_line`], not a rule restated here.**
/// That function is where the boundary (`>=`, so the 401st line fails and the 400th does not) and
/// the message both live, and its own module pins them. Charging the budget by hand here would be
/// a second spelling of one limit — and it is how the first version of this module came to
/// *document* the cap without enforcing it: nothing charged `budget.lines` at all, so a guest could
/// emit without bound while the doc-comment said the cap bit.
///
/// **An empty chunk is neither counted nor queued.** The reference is
/// `if (msg) { const s = getString(msg); if (s) { budget.lines += 1; queue.push(s); } }`, so
/// `emit("")` contributes nothing — and it is tested *before* the charge, which is the reference's
/// order. On the buffered path that was invisible — an empty string in a `Vec` of lines is a line
/// nobody reads — but in a text stream it is a chunk the consumer sees, and a text stream that
/// emits a blank line mid-sentence is a visible defect.
fn make_emit<'js>(
    ctx: &Ctx<'js>,
    emitted: Rc<RefCell<Vec<String>>>,
    budget: Rc<RefCell<OpBudget>>,
    failure: Rc<RefCell<Option<String>>>,
) -> Result<Function<'js>, SandboxError> {
    Function::new(ctx.clone(), move |chunk: String| {
        if chunk.is_empty() {
            return;
        }
        let mut budget = budget.borrow_mut();
        if let Err(over) = note_emitted_line(&mut budget) {
            *failure.borrow_mut() = Some(over.message);
            return;
        }
        // The reference caps a logged line at 500 (`LOG_LINE_CAP`); the same cap is applied to an
        // emitted chunk so a guest cannot push unbounded text through one call.
        let text: String = chunk.chars().take(LOG_LINE_CAP).collect();
        emitted.borrow_mut().push(text);
    })
    .map_err(|e| SandboxError::new(SandboxReason::Host, format!("emit() was not built: {e}")))
}

/// Hand every line the guest has emitted since the last round to a streaming caller.
///
/// **`take`, not `clone`, and the reason is a defect rather than tidiness.** `forward` runs once per
/// round of the settle loop, so a `clone` leaves every line in the staging buffer and the *next*
/// round sends it again: a guest that emits, awaits, then emits delivers its first chunk twice.
/// Measured — swapping in `clone` reddens exactly
/// `a_chunk_reaches_the_caller_before_the_request_it_precedes_is_answered`, with `Line("first")`
/// arriving where `Line("second")` belongs.
///
/// The empty outcome is the second consequence, and it is a contract rather than a behaviour: a
/// caller of `JsHost::call` that passed a chunk channel finds `OperationOutcome::emitted` empty,
/// because those lines have a new owner. Giving them a second one is the two-spellings defect this
/// module keeps finding.
fn forward(
    chunks: Option<&tokio::sync::mpsc::UnboundedSender<Chunk>>,
    emitted: &RefCell<Vec<String>>,
) {
    if let Some(chunks) = chunks {
        let lines: Vec<String> = std::mem::take(&mut *emitted.borrow_mut());
        for line in lines {
            // A closed receiver means the consumer stopped listening. The actor must not stall on
            // it — the operation still has to finish and release the thread.
            let _ = chunks.send(Chunk::Line(line));
        }
    }
}

/// Build the global `log` function. `log` is not per-operation — it is installed once at compile
/// time and persists across calls — so its queue lives on the host, not on the operation closure.
fn make_log<'js>(
    ctx: &Ctx<'js>,
    lines: Arc<Mutex<Vec<String>>>,
) -> Result<Function<'js>, SandboxError> {
    Function::new(ctx.clone(), move |msg: String| {
        let text: String = msg.chars().take(LOG_LINE_CAP).collect();
        lines.lock().unwrap().push(text);
    })
    .map_err(|e| SandboxError::new(SandboxReason::Host, format!("log() was not built: {e}")))
}

/// `String(x)` for a thrown value, for the message a rejection carries.
fn describe<'js>(error: &Value<'js>) -> String {
    if let Some(message) = error.as_exception().and_then(|e| e.message()) {
        return message;
    }
    dump(error.clone()).to_string()
}

/// A JS value as JSON, by walking it.
///
/// **Not a `JSON.stringify` round-trip, and the difference is observable.** `stringify` omits a
/// property whose value is `undefined` and renders `NaN`/`Infinity` as `null`; the reference's
/// `ctx.dump()` keeps all three, and `String(NaN)` is `"NaN"`. Since the readers in
/// [`crate::core::sandbox`] were written against the dumped shape, the dump has to be the walk.
///
/// Values with no JSON counterpart — functions, symbols, BigInts, exceptions — become `null`. The
/// reference's `dump` produces a JS value for those, and `String(fn)` is `"function () {}"` rather
/// than `""`, so a guest that returns a function where an id was expected reads differently in the
/// two implementations. That is a recorded divergence, not a reproduced one: no reader in
/// `sandbox.rs` accepts a function, and inventing a stringification for one would be a second
/// spelling of `String(x)` that no measured input can check.
/// No `Ctx` parameter: in 0.9 a `Value<'js>` carries its own context and this walk only ever reads
/// *through* it, never creates anything. The parameter was vestigial from the first draft, and
/// clippy's `only_used_in_recursion` is what caught it — a signature that only exists to pass
/// itself along is a signature that is not earning its keep.
fn dump<'js>(value: Value<'js>) -> Json {
    if value.is_undefined() || value.is_null() {
        return Json::Null;
    }
    if let Some(b) = value.as_bool() {
        return Json::Bool(b);
    }
    if let Some(i) = value.as_int() {
        return Json::Number(i.into());
    }
    if let Some(f) = value.as_float() {
        // `NaN` and the infinities are unreachable here: `Value::as_float` returns `Some` only for
        // a JS number, and `Number::from_f64` rejects the non-finite ones, so a guest that returns
        // `NaN` takes the `Json::Null` arm below rather than silently becoming `0`.
        return serde_json::Number::from_f64(f).map(Json::Number).unwrap_or(Json::Null);
    }
    if value.is_string() {
        if let Some(s) = value.as_string() {
            if let Ok(s) = s.to_string() {
                return Json::String(s);
            }
        }
        return Json::Null;
    }
    if value.is_array() {
        let Some(array) = value.into_array() else { return Json::Null };
        // `Array::len` already returns `usize`; the `as usize` this replaces was pure noise.
        let mut out = Vec::with_capacity(array.len());
        for item in array.iter::<Value>() {
            match item {
                Ok(item) => out.push(dump(item)),
                Err(_) => out.push(Json::Null),
            }
        }
        return Json::Array(out);
    }
    // **Before `is_object`, not after.** `is_object` is a raw `JS_TAG_OBJECT` check
    // (`value.rs:332`), and a function carries that tag too — so without this a guest returning
    // `f: () => 1` takes the object branch and dumps as `{}` instead of `null`. `is_function` is
    // the real test (`JS_IsFunction`, `value.rs:350`). Measured: found by
    // `the_dump_walks_rather_than_stringifies`, which failed with `Object {}` before the fix.
    if value.is_function() {
        return Json::Null;
    }
    if value.is_object() {
        let Some(object) = value.into_object() else { return Json::Null };
        let mut out = Map::new();
        let keys: Vec<String> = object.keys::<String>().filter_map(Result::ok).collect();
        for key in keys {
            // A property that throws on read is not a reason to lose the whole reply; the
            // reference's dump would surface it as `undefined` and the reader would see the
            // absence, which is what `Json::Null` gives the `??` chains in `sandbox.rs`.
            let Ok(item) = object.get::<_, Value>(key.as_str()) else { continue };
            out.insert(key, dump(item));
        }
        return Json::Object(out);
    }
    Json::Null
}

/// The largest `n <= cap` that is a char boundary, so `truncate` cannot split a UTF-8 sequence.
fn floor_char_boundary(s: &str, cap: usize) -> usize {
    if cap >= s.len() {
        return s.len();
    }
    let mut end = cap;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    end
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn host_lost(e: rquickjs::Error) -> SandboxError {
    SandboxError::new(SandboxReason::Host, format!("the guest context was lost: {e}"))
}

fn runtime_failure(operation: Operation, e: rquickjs::Error) -> SandboxError {
    SandboxError::new(
        SandboxReason::Runtime,
        format!("{}() threw at entry: {e}", operation.as_str()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::http_port::{HttpError, HttpResponse};
    use crate::core::sandbox::{AuthHeader, EMIT_LINES_PER_OP};
    use futures_util::future::BoxFuture;
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    /// Copied **verbatim** from `packages/router-core/test/code-adapter.test.ts:21-37` — not
    /// reindented, not adapted. The spike ran the same bytes (S8); this runs them through the actor.
    const GOOD_GUEST: &str = r#"
export default {
  async listModels(http) {
    const r = await http({ path: "/models" });
    return JSON.parse(r.text).data.map((m) => m.id);
  },
  async generateText(http, emit, argsJson) {
    const args = JSON.parse(argsJson);
    const r = await http({ path: "/chat", method: "POST", body: args, headers: { "x-trace": "guest" } });
    for (const c of JSON.parse(r.text).chunks) emit(c);
  },
  async generateImage(http, argsJson) {
    const r = await http({ path: "/images", method: "POST", body: JSON.parse(argsJson) });
    return { ok: true, status: 200, base64: JSON.parse(r.text).b64 };
  },
};
"#;

    /// The scripted egress the TypeScript test uses, as a Rust port. Same three routes, same bodies.
    struct FakeEgress {
        seen: Mutex<Vec<(String, String)>>,
    }

    impl FakeEgress {
        fn new() -> Arc<Self> {
            Arc::new(FakeEgress { seen: Mutex::new(Vec::new()) })
        }
    }

    impl HttpPort for FakeEgress {
        fn request<'a>(
            &'a self,
            req: HttpRequest,
            _cancel: &'a Cancel,
        ) -> BoxFuture<'a, Result<HttpResponse<'a>, HttpError>> {
            Box::pin(async move {
                self.seen.lock().unwrap().push((req.method.as_str().to_string(), req.url.clone()));
                let body = if req.url.ends_with("/models") {
                    r#"{"data":[{"id":"text-1"},{"id":"img-2"}]}"#.to_string()
                } else if req.url.ends_with("/chat") {
                    r#"{"chunks":["Al","pha"]}"#.to_string()
                } else if req.url.ends_with("/images") {
                    r#"{"b64":"QUJD"}"#.to_string()
                } else {
                    return Err(HttpError::new(format!("no route for {}", req.url)));
                };
                Ok(HttpResponse { status: 200, headers: BTreeMap::new(), body, lines: None })
            })
        }
    }

    fn target() -> HttpTarget {
        HttpTarget::new(
            "https://api.example.com",
            &[AuthHeader { name: "authorization".to_string(), prefix: Some("Bearer".to_string()) }],
        )
    }

    fn spawn(source: &str) -> JsSandbox {
        JsSandbox::spawn(source, SandboxLimits::default()).expect("the guest should compile")
    }

    /// The architectural claim, as a compile-time assertion: this is the type the seam needs.
    #[test]
    fn the_handle_is_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<JsSandbox>();
    }

    #[test]
    fn a_verbatim_guest_runs_through_the_actor() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let sandbox = spawn(GOOD_GUEST);
            let egress = FakeEgress::new();
            let cancel = Cancel::new();

            let models = sandbox
                .call(Operation::ListModels, "", &target(), "k1", egress.clone(), &cancel)
                .await
                .expect("listModels");
            assert_eq!(models.value, serde_json::json!(["text-1", "img-2"]));

            let text = sandbox
                .call(
                    Operation::GenerateText,
                    r#"{"model":"text-1"}"#,
                    &target(),
                    "k1",
                    egress.clone(),
                    &cancel,
                )
                .await
                .expect("generateText");
            assert_eq!(text.emitted, vec!["Al".to_string(), "pha".to_string()]);
            assert_eq!(text.value, Json::Null, "the guest's generateText returns undefined");

            let image = sandbox
                .call(
                    Operation::GenerateImage,
                    r#"{"prompt":"x"}"#,
                    &target(),
                    "k1",
                    egress.clone(),
                    &cancel,
                )
                .await
                .expect("generateImage");
            assert_eq!(
                image.value,
                serde_json::json!({ "ok": true, "status": 200, "base64": "QUJD" })
            );

            let seen = egress.seen.lock().unwrap().clone();
            assert_eq!(seen.len(), 3, "one egress round trip per guest call: {seen:?}");
            // **POST, not GET.** The guest's `listModels` sends no `method` key, and the reference's
            // rule is `a.method === "GET" ? "GET" : "POST"` (`code-adapter.ts:283`) — an absent key
            // therefore means POST. The first draft of this assertion said GET; the code was right
            // and the test was wrong, which is why it asserts the whole call and not just the verb.
            assert_eq!(seen[0], ("POST".to_string(), "https://api.example.com/models".to_string()));
            assert_eq!(seen[1], ("POST".to_string(), "https://api.example.com/chat".to_string()));
            assert_eq!(seen[2], ("POST".to_string(), "https://api.example.com/images".to_string()));
        });
    }

    #[test]
    fn the_http_budget_is_charged_per_operation_not_per_sandbox() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let sandbox = spawn(GOOD_GUEST);
            let egress = FakeEgress::new();
            let cancel = Cancel::new();
            for _ in 0..3 {
                let out = sandbox
                    .call(Operation::ListModels, "", &target(), "k1", egress.clone(), &cancel)
                    .await
                    .expect("listModels");
                assert_eq!(out.http_calls, 1, "the budget is rebuilt for every operation");
            }
        });
    }

    #[test]
    fn a_guest_that_does_not_implement_the_operation_is_a_runtime_failure() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let sandbox = spawn("export default { async listModels() { return []; } };");
            let err = sandbox
                .call(
                    Operation::GenerateImage,
                    "{}",
                    &target(),
                    "k1",
                    FakeEgress::new(),
                    &Cancel::new(),
                )
                .await
                .expect_err("generateImage is absent");
            assert_eq!(err.reason, SandboxReason::Runtime);
            assert!(err.message.contains("does not implement generateImage()"), "{}", err.message);
        });
    }

    #[test]
    fn a_source_that_does_not_parse_is_a_compile_failure_at_spawn() {
        let err = JsSandbox::spawn("export default {", SandboxLimits::default())
            .expect_err("an unclosed brace must not compile");
        assert_eq!(err.reason, SandboxReason::Compile);
    }

    #[test]
    fn a_guest_without_a_default_object_is_a_compile_failure() {
        let err = JsSandbox::spawn("export const x = 1;", SandboxLimits::default())
            .expect_err("no default export");
        assert_eq!(err.reason, SandboxReason::Compile);
    }

    #[test]
    fn a_spinning_guest_is_aborted_by_the_interrupt_handler() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let limits = SandboxLimits { op_budget_ms: 300, ..SandboxLimits::default() };
            let sandbox =
                JsSandbox::spawn("export default { async listModels() { for (;;) {} } };", limits)
                    .expect("compiles");
            let started = std::time::Instant::now();
            let err = sandbox
                .call(Operation::ListModels, "", &target(), "k1", FakeEgress::new(), &Cancel::new())
                .await
                .expect_err("an infinite loop cannot succeed");
            let elapsed = started.elapsed();
            assert!(
                elapsed >= std::time::Duration::from_millis(250),
                "it cannot have spun in {elapsed:?}"
            );
            assert!(
                matches!(err.reason, SandboxReason::Runtime | SandboxReason::Timeout),
                "the interrupt must surface as a runtime abort or a timeout, got {:?}: {}",
                err.reason,
                err.message
            );
        });
    }

    #[test]
    fn a_rejected_path_reaches_the_guests_own_await() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            // The guest awaits a traversal path, so `plan_http_call` rejects the promise it returned
            // and the guest's `await` must throw — which the guest turns into a rejection of its own.
            let guest = r#"
export default {
  async listModels(http) {
    await http({ path: "/../etc/passwd" });
    return ["should not reach here"];
  },
};
"#;
            let sandbox = spawn(guest);
            let err = sandbox
                .call(Operation::ListModels, "", &target(), "k1", FakeEgress::new(), &Cancel::new())
                .await
                .expect_err("the path must be refused");
            assert_eq!(err.reason, SandboxReason::Runtime);
            assert!(
                err.message.contains("path must be a relative provider path"),
                "the reference's own message must survive to the caller: {}",
                err.message
            );
        });
    }

    #[test]
    fn a_guest_that_throws_at_entry_is_a_runtime_failure_not_a_host_failure() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let sandbox =
                spawn("export default { async listModels() { throw new Error('boom'); } };");
            let err = sandbox
                .call(Operation::ListModels, "", &target(), "k1", FakeEgress::new(), &Cancel::new())
                .await
                .expect_err("boom");
            assert_eq!(err.reason, SandboxReason::Runtime);
            assert!(err.message.contains("boom"), "{}", err.message);
        });
    }

    /// The `log` global reaches a caller, and a drain is a drain.
    ///
    /// **This is the test the field's note exists for.** The first draft put the queue on `JsHost`,
    /// which never leaves the actor thread and is never named from outside it — so no caller could
    /// ever read a line, and the field was dead code. The assertion is therefore not "log works"
    /// but "log is reachable from a thread that is not the actor's".
    #[test]
    fn the_guest_log_reaches_the_caller_and_a_drain_empties_the_queue() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let sandbox = spawn(
                r#"
                export default {
                  async listModels() { log("first"); log("x".repeat(900)); return []; },
                };
                "#,
            );
            let cancel = Cancel::new();
            sandbox
                .call(Operation::ListModels, "", &target(), "k1", FakeEgress::new(), &cancel)
                .await
                .expect("listModels");
            let lines = sandbox.drain_log_lines();
            assert_eq!(lines.len(), 2);
            assert_eq!(lines[0], "first");
            // `LOG_LINE_CAP`, applied by `make_log`: 500 chars, not the 900 the guest pushed.
            assert_eq!(lines[1].len(), LOG_LINE_CAP);
            // A drain, not a read: the second call is empty rather than a repeat of the first.
            assert!(sandbox.drain_log_lines().is_empty());
        });
    }

    #[test]
    fn disposing_a_sandbox_twice_is_safe_and_the_thread_ends() {
        // Not `mut`: `dispose` takes `&self` so that the seam can call it through a shared
        // reference — see the method's own note.
        let sandbox = spawn("export default { async listModels() { return []; } };");
        sandbox.dispose();
        sandbox.dispose();
        // A call after disposal is a host failure, not a hang.
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let err = sandbox
                .call(Operation::ListModels, "", &target(), "k1", FakeEgress::new(), &Cancel::new())
                .await
                .expect_err("the actor is gone");
            assert_eq!(err.reason, SandboxReason::Host);
        });
    }

    #[test]
    fn the_dump_walks_rather_than_stringifies() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            // `JSON.stringify` would drop `u` and render `n` as null. The walk keeps both, and the
            // reference's `ctx.dump()` keeps them too.
            let guest = r#"
export default {
  async listModels() {
    return { u: undefined, n: NaN, a: [1, null, "x"], o: { deep: true }, f: () => 1 };
  },
};
"#;
            let sandbox = spawn(guest);
            let out = sandbox
                .call(Operation::ListModels, "", &target(), "k1", FakeEgress::new(), &Cancel::new())
                .await
                .expect("listModels");
            assert_eq!(
                out.value,
                serde_json::json!({
                    "u": null,
                    "n": null,
                    "a": [1, null, "x"],
                    "o": { "deep": true },
                    "f": null,
                }),
                "undefined and NaN survive as null; a function has no JSON counterpart"
            );
        });
    }

    #[test]
    fn an_operation_that_neither_settles_nor_requests_is_reported_not_spun_on() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            // A guest parked on a promise nobody will resolve — the reference's `callOp` would spin
            // until its deadline; here the driver has nothing to await and must say so.
            let guest = "export default { async listModels() { await new Promise(() => {}); } };";
            let limits = SandboxLimits { op_budget_ms: 200, ..SandboxLimits::default() };
            let sandbox = JsSandbox::spawn(guest, limits).expect("compiles");
            let err = sandbox
                .call(Operation::ListModels, "", &target(), "k1", FakeEgress::new(), &Cancel::new())
                .await
                .expect_err("a never-settling guest must not hang the caller");
            assert_eq!(err.reason, SandboxReason::Timeout);
        });
    }

    /// The limits reach the host — and that is *all* this can assert about two of the three.
    ///
    /// `Runtime` in 0.9.0 exposes `set_memory_limit` and `set_max_stack_size` with **no getters**
    /// (`runtime/base.rs:112`, `:121`), so there is nothing to read back. The only observable
    /// consequence of the memory limit is the out-of-memory of §2.1.3 S6b/S6c, which takes the
    /// process down with `SIGSEGV` when it is raised directly inside the call — a test that crashes
    /// the harness proves nothing. The stack limit *is* observable and gets its own test below.
    #[test]
    fn the_limits_reach_the_host_that_was_asked_for() {
        let limits = SandboxLimits {
            memory_bytes: 8 * 1024 * 1024,
            stack_bytes: 256 * 1024,
            op_budget_ms: 1_000,
        };
        let host = JsHost::compile("export default {};", limits, Arc::new(Mutex::new(Vec::new())))
            .expect("compiles");
        assert_eq!(host.limits, limits);
    }

    /// Containment on the **actor's own thread** — the condition S6f never measured, because S6f ran
    /// on the main thread with 8 MB of C stack behind it.
    ///
    /// If the C stack ran out before the JS limit fired, this test would not fail: it would
    /// `SIGSEGV` and take the whole harness with it. That is precisely why the assertion is worth
    /// having, and why `ACTOR_STACK_BYTES` is set explicitly rather than inherited.
    #[test]
    fn runaway_recursion_is_contained_on_the_actor_thread() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let guest =
                "export default { async listModels() { const f = (n) => f(n + 1); return f(0); } };";
            let sandbox = spawn(guest);
            let err = sandbox
                .call(Operation::ListModels, "", &target(), "k1", FakeEgress::new(), &Cancel::new())
                .await
                .expect_err("runaway recursion cannot succeed");
            assert_eq!(err.reason, SandboxReason::Runtime);
            // QuickJS says "Maximum call stack size exceeded"; the assertion is written to hold for
            // that and for a plain "stack overflow" without pinning a wording it never measured.
            assert!(
                err.message.contains("stack"),
                "the reason must name the stack rather than something downstream of it: {}",
                err.message
            );
        });
    }

    // ---- Streaming (increment 20b) ------------------------------------------------------------

    /// An egress that parks until the test releases it.
    ///
    /// **The only vantage point from which streaming and buffering are distinguishable.** Both
    /// deliver the same text in the same order; they differ only in *when*, and *when* is visible
    /// only while the request is still open. An egress that answers immediately cannot tell the two
    /// apart, so it cannot test this at all — which is why the fixture exists rather than a reuse of
    /// [`FakeEgress`].
    struct GatedEgress {
        entered: tokio::sync::mpsc::UnboundedSender<()>,
        release: Arc<tokio::sync::Notify>,
    }

    impl HttpPort for GatedEgress {
        fn request<'a>(
            &'a self,
            _req: HttpRequest,
            _cancel: &'a Cancel,
        ) -> BoxFuture<'a, Result<HttpResponse<'a>, HttpError>> {
            Box::pin(async move {
                let _ = self.entered.send(());
                self.release.notified().await;
                Ok(HttpResponse {
                    status: 200,
                    headers: BTreeMap::new(),
                    body: r#"{"chunks":["ignored"]}"#.to_string(),
                    lines: None,
                })
            })
        }
    }

    fn gated() -> (Arc<GatedEgress>, tokio::sync::mpsc::UnboundedReceiver<()>) {
        let (entered, entered_rx) = tokio::sync::mpsc::unbounded_channel();
        let port = Arc::new(GatedEgress { entered, release: Arc::new(tokio::sync::Notify::new()) });
        (port, entered_rx)
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    /// Drain a stream to its terminal item.
    async fn drain(mut chunks: tokio::sync::mpsc::UnboundedReceiver<Chunk>) -> Vec<Chunk> {
        let mut seen = Vec::new();
        while let Some(chunk) = chunks.recv().await {
            seen.push(chunk);
        }
        seen
    }

    /// **The property this increment exists for.** The guest emits and *then* awaits, so the first
    /// chunk is in the caller's hand while the request that follows it is still open. A buffered
    /// port cannot produce this: it has nothing to hand over until the promise settles.
    ///
    /// This is also the test that catches `forward` cloning instead of taking. A clone leaves the
    /// first line in the staging buffer, so the next round of the settle loop sends it again and the
    /// caller sees `first` twice.
    #[test]
    fn a_chunk_reaches_the_caller_before_the_request_it_precedes_is_answered() {
        runtime().block_on(async {
            let sandbox = spawn(
                r#"
                export default {
                  async generateText(http, emit, argsJson) {
                    emit("first");
                    await http({ path: "/chat", method: "POST", body: {} });
                    emit("second");
                  },
                };
                "#,
            );
            let (egress, mut entered) = gated();
            let cancel = Cancel::new();
            let mut chunks = sandbox
                .stream(Operation::GenerateText, "{}", &target(), "k1", egress.clone(), &cancel)
                .expect("the stream should start");

            entered.recv().await.expect("the guest's request should be in flight");
            assert_eq!(
                chunks.try_recv(),
                Ok(Chunk::Line("first".to_string())),
                "the first chunk must be in hand while the request it precedes is still open"
            );

            egress.release.notify_one();
            assert_eq!(chunks.recv().await, Some(Chunk::Line("second".to_string())));
            assert_eq!(chunks.recv().await, Some(Chunk::End(Ok(()))));
            assert_eq!(chunks.recv().await, None, "the channel must close after End");
        });
    }

    /// `End` is the last item and there is exactly one.
    ///
    /// A closed channel alone cannot say whether the guest finished cleanly, was aborted, or died
    /// with its thread — so a consumer that stops at `None` cannot tell success from a dead actor,
    /// which is why the terminal outcome is an item rather than the channel's closure.
    #[test]
    fn end_is_the_last_item_and_arrives_exactly_once() {
        runtime().block_on(async {
            let sandbox = spawn(
                r#"export default { async generateText(http, emit) { for (const c of ["a","b","c"]) emit(c); } };"#,
            );
            let cancel = Cancel::new();
            let chunks = sandbox
                .stream(Operation::GenerateText, "{}", &target(), "k1", FakeEgress::new(), &cancel)
                .expect("the stream should start");
            assert_eq!(
                drain(chunks).await,
                vec![
                    Chunk::Line("a".to_string()),
                    Chunk::Line("b".to_string()),
                    Chunk::Line("c".to_string()),
                    Chunk::End(Ok(())),
                ]
            );
        });
    }

    /// `emit("")` is neither delivered nor **counted**.
    ///
    /// The counting half is the one a "no blank chunk on the wire" test would miss: 500 empties
    /// followed by one real line stays under the cap only if the empty check runs *before* the
    /// charge, which is the reference's order (`if (msg) { const s = …; if (s) { budget.lines += 1;
    /// queue.push(s); } }`).
    #[test]
    fn an_empty_emit_is_neither_counted_nor_delivered() {
        runtime().block_on(async {
            let sandbox = spawn(
                r#"export default { async generateText(http, emit) { for (let i = 0; i < 500; i++) emit(""); emit("x"); } };"#,
            );
            let cancel = Cancel::new();
            let chunks = sandbox
                .stream(Operation::GenerateText, "{}", &target(), "k1", FakeEgress::new(), &cancel)
                .expect("the stream should start");
            assert_eq!(drain(chunks).await, vec![Chunk::Line("x".to_string()), Chunk::End(Ok(()))]);
        });
    }

    /// The cap ends the stream **and keeps what was already said**: the reference yields every
    /// queued chunk before it raises the limit failure (`code-adapter.ts:574-577`), so the cap is
    /// what stops the stream rather than what revokes it.
    ///
    /// The expected failure is built by *calling* the rule rather than by quoting its message, so
    /// this assertion cannot drift from `sandbox.rs`'s own spelling of it.
    #[test]
    fn the_line_cap_ends_the_stream_and_keeps_what_was_already_emitted() {
        runtime().block_on(async {
            // One past the cap, with the cap written once — in the source of truth rather than
            // here, so a change to `EMIT_LINES_PER_OP` moves this test with it.
            let source = format!(
                r#"export default {{ async generateText(http, emit) {{ for (let i = 0; i < {}; i++) emit("L"); }} }};"#,
                EMIT_LINES_PER_OP + 1
            );
            let sandbox = spawn(&source);
            let cancel = Cancel::new();
            let chunks = sandbox
                .stream(Operation::GenerateText, "{}", &target(), "k1", FakeEgress::new(), &cancel)
                .expect("the stream should start");
            let seen = drain(chunks).await;

            let mut spent = OpBudget { http_calls: 0, lines: EMIT_LINES_PER_OP };
            let over = note_emitted_line(&mut spent).expect_err("the cap must already be reached");

            assert_eq!(seen.len(), EMIT_LINES_PER_OP as usize + 1);
            assert!(
                seen[..EMIT_LINES_PER_OP as usize]
                    .iter()
                    .all(|c| *c == Chunk::Line("L".to_string())),
                "every line under the cap must still be delivered"
            );
            assert_eq!(seen[EMIT_LINES_PER_OP as usize], Chunk::End(Err(over)));
        });
    }

    /// The buffered path is untouched by all of the above: with no chunk channel, the lines belong
    /// to the outcome. This is the guard against a `forward` that took unconditionally.
    #[test]
    fn a_buffered_call_still_hands_back_the_lines_in_the_outcome() {
        runtime().block_on(async {
            let sandbox = spawn(
                r#"export default { async generateText(http, emit) { emit("a"); emit("b"); } };"#,
            );
            let outcome = sandbox
                .call(
                    Operation::GenerateText,
                    "{}",
                    &target(),
                    "k1",
                    FakeEgress::new(),
                    &Cancel::new(),
                )
                .await
                .expect("the call should answer");
            assert_eq!(outcome.emitted, vec!["a".to_string(), "b".to_string()]);
        });
    }

    /// A guest that throws *after* emitting still delivers what it said, and the reason arrives as
    /// the stream's terminal item rather than as the response phase's `Err`.
    #[test]
    fn a_guest_that_throws_after_emitting_ends_the_stream_with_its_reason() {
        runtime().block_on(async {
            let sandbox = spawn(
                r#"export default { async generateText(http, emit) { emit("a"); throw new Error("boom"); } };"#,
            );
            let cancel = Cancel::new();
            let mut chunks = sandbox
                .stream(Operation::GenerateText, "{}", &target(), "k1", FakeEgress::new(), &cancel)
                .expect("the stream should start");

            assert_eq!(chunks.recv().await, Some(Chunk::Line("a".to_string())));
            match chunks.recv().await {
                Some(Chunk::End(Err(e))) => {
                    assert_eq!(e.reason, SandboxReason::Runtime);
                    assert!(
                        e.message.contains("boom"),
                        "the reason must carry the guest's own words: {}",
                        e.message
                    );
                }
                other => panic!("the failure must be the terminal item, got {other:?}"),
            }
            assert_eq!(chunks.recv().await, None);
        });
    }

    /// A consumer that stops listening must not take the actor with it.
    ///
    /// The receiver is dropped mid-operation, so `forward` writes to a closed channel; the actor
    /// ignores that, finishes the operation, and goes on serving. Without the `let _ =` on the send,
    /// this would be an actor that dies on the first consumer that walks away.
    #[test]
    fn a_dropped_receiver_leaves_the_actor_serving() {
        runtime().block_on(async {
            let sandbox = spawn(GOOD_GUEST);
            let egress = FakeEgress::new();
            let cancel = Cancel::new();
            {
                let chunks = sandbox
                    .stream(
                        Operation::GenerateText,
                        r#"{"model":"text-1"}"#,
                        &target(),
                        "k1",
                        egress.clone(),
                        &cancel,
                    )
                    .expect("the stream should start");
                drop(chunks);
            }

            let models = sandbox
                .call(Operation::ListModels, "", &target(), "k1", egress, &cancel)
                .await
                .expect("the actor must still serve after a dropped receiver");
            assert_eq!(models.value, serde_json::json!(["text-1", "img-2"]));
        });
    }

    /// A stream from a sandbox that is gone fails **here**, rather than handing back a receiver
    /// nobody will ever write to. The difference is between an error and a hang.
    #[test]
    fn streaming_a_disposed_sandbox_fails_here_rather_than_hanging() {
        runtime().block_on(async {
            let sandbox = spawn(GOOD_GUEST);
            sandbox.dispose();
            let err = sandbox
                .stream(
                    Operation::GenerateText,
                    "{}",
                    &target(),
                    "k1",
                    FakeEgress::new(),
                    &Cancel::new(),
                )
                .expect_err("a disposed sandbox cannot start a stream");
            assert_eq!(err.reason, SandboxReason::Host);
            assert!(err.message.contains("gone"), "the reason must say so: {}", err.message);
        });
    }
}
