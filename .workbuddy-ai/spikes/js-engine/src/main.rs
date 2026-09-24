//! Spike: can `rquickjs` run the Tier-2 QuickJS sandbox, or is that a reimplementation?
//!
//! The question is not "does QuickJS work" — `rquickjs` binds the same C engine that
//! `@jitl/quickjs-singlefile-mjs-release-sync` compiles to WASM, so the language semantics are
//! identical by construction. The question is whether the *host plumbing* in
//! `packages/router-core/src/code-adapter.ts` (615 lines) maps onto `rquickjs`'s API, and whether
//! the guest contract runs **verbatim**.
//!
//! Every probe below is a claim about a primitive the TypeScript design depends on. The money
//! probe is `probe_good_guest` — it runs `GOOD_GUEST` copied unmodified out of
//! `packages/router-core/test/code-adapter.test.ts` and checks the same values that file asserts.
//! If that passes, this is a port. If it does not, it is a reimplementation and the plan changes.
//!
//! Run: `cargo run --release`

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rquickjs::{
    context::EvalOptions, promise::PromiseState, Ctx, Function, Module, Object, Promise, Runtime, Value,
};

/// Copied verbatim from `packages/router-core/test/code-adapter.test.ts:21-37`. Not reformatted,
/// not adapted — that is the whole point of the probe.
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

/// The scripted egress the TS test uses, as a Rust responder. Same three routes.
fn respond(path: &str) -> Option<String> {
    if path.ends_with("/models") {
        Some(r#"{"data":[{"id":"text-1"},{"id":"img-2"}]}"#.to_string())
    } else if path.ends_with("/chat") {
        Some(r#"{"chunks":["Al","pha"]}"#.to_string())
    } else if path.ends_with("/images") {
        Some(r#"{"b64":"QUJD"}"#.to_string())
    } else {
        None
    }
}

type Probe = Result<String, String>;

/// `EvalOptions` with module semantics.
///
/// **This helper exists because of a trap.** `EvalOptions::default()` is `global: true, strict:
/// true` (`context/ctx.rs:61-70`) — that is `JS_EVAL_TYPE_GLOBAL`, *script* mode, in which the
/// guest's `export default {` is a syntax error. Module mode needs `global: false`
/// (`ctx.rs:38-43`), and the struct is `#[non_exhaustive]`, so it cannot be built with a struct
/// literal from outside the crate — only defaulted and then mutated. The obvious
/// `ctx.eval(source)` (`ctx.rs:154` uses `Default::default()`) is therefore *script* mode and
/// would reject every guest on its first character.
fn module_opts() -> EvalOptions {
    let mut opts = EvalOptions::default();
    opts.global = false; // false => JS_EVAL_TYPE_MODULE
    opts
}

/// Drain the job queue. Returns how many jobs ran.
///
/// **`Ctx::execute_pending_job`, never `Runtime::*`, and the reason is a measured deadlock.**
/// `Context::with` holds the runtime's global lock for the whole closure
/// (`context/base.rs:109`), and under the `parallel` feature `Runtime::is_job_pending` /
/// `Runtime::execute_pending_job` each take that same non-reentrant lock
/// (`runtime/base.rs:162,170`). Calling either from inside a context scope therefore hangs the
/// thread — measured here, not inferred: the first `S3` run wedged with the probe's own
/// `[settle] pre-loop` line printed and the `is_job_pending` line never reached.
///
/// `Ctx::execute_pending_job` (`context/ctx.rs:375`) calls `JS_ExecutePendingJob` directly with no
/// lock, so it is the only pump available in this shape. The TypeScript has no such split because
/// its QuickJS is a single-threaded WASM module with a flat API.
///
/// **One cost, stated:** the `Ctx` variant returns `bool` and folds "a job ran" together with "a
/// job threw" (both are `res != 0`). The `Runtime` variant returns `Result<bool, JobException>`.
/// So a caller that needs to see a job's exception must inspect the promise, not the return value —
/// which is what `mem_probe` does.
fn pump<'js>(ctx: &Ctx<'js>, cap: usize) -> usize {
    let mut n = 0;
    while n < cap && ctx.execute_pending_job() {
        n += 1;
    }
    n
}

/// The host half of the bridge: `http` requests the guest made, and the resolve halves of the
/// deferreds they are waiting on. Exactly the two `Set`/`Vec` members `CodeAdapterInstance` keeps.
struct Bridge<'js> {
    requests: RefCell<Vec<Value<'js>>>,
    resolves: RefCell<Vec<Function<'js>>>,
}

impl<'js> Bridge<'js> {
    fn new() -> Rc<Self> {
        Rc::new(Self { requests: RefCell::new(Vec::new()), resolves: RefCell::new(Vec::new()) })
    }

}

/// Build the `http` host function. Returns a **deferred promise** and parks the resolver — the
/// direct analogue of `ctx.newPromise()` + `deferreds.add(...)` in `code-adapter.ts:289`.
///
/// The `Rc<Bridge<'js>>` is captured **by value**, and that is what makes the closure `'js`-bounded
/// without a `transmute`. This is a real difference from the TypeScript, which keeps the deferred
/// set in a field of `CodeAdapterInstance`; here the state lives beside the function because
/// `rquickjs` ties every JS-touching value to the `'js` of the context that made it.
fn make_http<'js>(ctx: &Ctx<'js>, bridge: &Rc<Bridge<'js>>) -> rquickjs::Result<Function<'js>> {
    let bridge = bridge.clone();
    Function::new(
        ctx.clone(),
        move |ctx: Ctx<'js>, req: Value<'js>| -> rquickjs::Result<Promise<'js>> {
            let (promise, resolve, _reject) = ctx.promise()?;
            if std::env::var("SPIKE_DEBUG").is_ok() {
                eprintln!("[http] host function entered; parking a resolver");
            }
            bridge.requests.borrow_mut().push(req);
            bridge.resolves.borrow_mut().push(resolve);
            Ok(promise)
        },
    )
}

/// Pump the job queue, service any parked request, repeat until `promise` settles.
/// This is `callOp`'s `while (!result) { pumpJobs(); ... await sleep(1) }` (`code-adapter.ts:408`).
fn settle<'js>(
    ctx: &Ctx<'js>,
    promise: Promise<'js>,
    bridge: &Rc<Bridge<'js>>,
) -> Result<Value<'js>, String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut pumps = 0usize;
    let mut serviced = 0usize;
    let mut iters = 0usize;
    while promise.state() == PromiseState::Pending {
        // Bounded: a spike must report a wedge, not hang on it.
        iters += 1;
        if iters > 50_000 {
            return Err(format!(
                "settle loop exceeded {iters} iterations; serviced={serviced} pumps={pumps} parked={}",
                bridge.requests.borrow().len()
            ));
        }
        // 1. drain the microtask queue — `runtime.executePendingJobs()`
        pumps += pump(ctx, 100_000);
        // 2. settle one parked request, which schedules the guest's continuation
        if let Some(req) = bridge.requests.borrow_mut().pop() {
            let obj = req.into_object().ok_or_else(|| format!("req into_object"))?;
            let path: String = obj.get("path").map_err(|e| format!("req.path: {e}"))?;
            let body = respond(&path).ok_or_else(|| format!("no route for {path}"))?;
            let out = Object::new(ctx.clone()).map_err(|e| format!("Object::new: {e}"))?;
            out.set("status", 200).map_err(|e| format!("set status: {e}"))?;
            out.set("text", body).map_err(|e| format!("set text: {e}"))?;
            let resolve = bridge.resolves.borrow_mut().pop().ok_or("resolve vanished")?;
            resolve.call::<_, ()>((out,)).map_err(|e| format!("resolve(): {e}"))?;
            serviced += 1;
        }
        if Instant::now() > deadline {
            return Err(format!("guest never settled; serviced={serviced} pumps={pumps}"));
        }
    }
    if std::env::var("SPIKE_DEBUG").is_ok() {
        eprintln!("[settle] settled after {iters} iters, {serviced} serviced, {pumps} pumps");
    }
    promise
        .result::<Value>()
        .ok_or_else(|| "settled but produced no result".to_string())?
        .map_err(|e| format!("result: {e}"))
}

/// Evaluate the guest as an ES module and return its `export default` object.
///
/// **This uses the `Module` door, not `eval_with_options`, and the probe is why.** Both doors
/// reach a module, but `eval_with_options` in module mode returns the module's *evaluation
/// promise*, not its namespace — so a `default` lookup on the immediate result finds nothing
/// (`probe_module_eval` measures exactly that). `Module::declare(...)?.eval()?` hands back the
/// `Module<Evaluated>` itself, whose `get("default")` is the TS's `getProp(namespace, "default")`
/// (`code-adapter.ts:181`).
///
/// `declare` also compiles *without running*, which is what `compile()` (`code-adapter.ts:202`)
/// exists to do — so this one door covers both the compile gate and the call path.
fn default_export<'js>(ctx: &Ctx<'js>, source: &str) -> Result<Object<'js>, String> {
    let declared = Module::declare(ctx.clone(), "adapter.mjs", source)
        .map_err(|e| format!("module failed to compile: {e}"))?;
    let (module, promise) = declared.eval().map_err(|e| format!("module eval failed: {e}"))?;
    // No guest here uses top-level await, but observe the evaluation promise rather than assuming.
    if promise.state() == PromiseState::Pending {
        pump(ctx, 10_000);
    }
    let def: Value = module.get("default").map_err(|e| format!("module.get(default): {e}"))?;
    if !def.is_object() {
        return Err(format!("namespace.default is {} not an object", def.type_of()));
    }
    def.into_object().ok_or_else(|| "namespace.default is not an object".to_string())
}

fn main() {
    // The third field marks a probe that is *expected to kill the process*. Those are opt-in, so a
    // default run answers everything and stays green; `SPIKE_CRASH=1` runs them and the run dies
    // at that line, which is the evidence.
    let probes: Vec<(&str, fn() -> Probe, bool)> = vec![
        ("S2  eval_with_options in module mode returns the promise, not the namespace", probe_module_eval, false),
        ("S2b module eval via Module::declare/eval + get(\"default\")", probe_module_api, false),
        ("S3  host `http` bridge: deferred promise + job pump", probe_http_bridge, false),
        ("S4  `emit` host callback pushes into a host queue", probe_emit, false),
        ("S5  interrupt handler aborts a spinning guest", probe_interrupt, false),
        ("S6a control: allocation with NO limit resolves normally", || mem_probe(None, false), false),
        ("S6b OOM during the call under an 8 MB limit", || mem_probe(Some(8 * 1024 * 1024), false), true),
        ("S6c OOM during the call under the TS sandbox's own 32 MB limit", || mem_probe(Some(32 * 1024 * 1024), false), true),
        ("S6d OOM inside a job (after an await) under an 8 MB limit", || mem_probe(Some(8 * 1024 * 1024), true), false),
        ("S6e control: a plain throw at entry is contained", probe_throw_at_entry, false),
        ("S6f control: runaway recursion vs the 512 KB stack limit", probe_stack_limit, false),
        // Opt-in, like S6b/S6c, and for the same reason: a size whose C stack runs out first kills
        // the process. One size per run, from `SPIKE_THREAD_STACK`; the default is `std::thread`'s.
        ("S6g containment off the main thread (SPIKE_THREAD_STACK bytes)", probe_thread_stack, true),
        ("S7  Runtime/Context are Send+Sync (feature `parallel`)", probe_send_sync, false),
        ("S8  GOOD_GUEST verbatim: listModels/generateText/generateImage", probe_good_guest, false),
    ];

    let mut failed = 0usize;
    // Optional filter so a wedging probe can be isolated: `jsengine-spike S5`.
    let filter = std::env::args().nth(1);
    let run_crashers = std::env::var("SPIKE_CRASH").is_ok();
    let mut ran = 0usize;
    for (name, f, crasher) in probes {
        if let Some(prefix) = &filter {
            if !name.starts_with(prefix.as_str()) {
                continue;
            }
        }
        if crasher && !run_crashers {
            println!("SKIP  {name}\n        opt in with SPIKE_CRASH=1 — this probe is expected to SIGSEGV");
            let _ = std::io::Write::flush(&mut std::io::stdout());
            continue;
        }
        ran += 1;
        match f() {
            Ok(msg) => println!("PASS  {name}\n        {msg}"),
            Err(msg) => {
                failed += 1;
                println!("FAIL  {name}\n        {msg}");
            }
        }
        // Flush per probe: a wedged probe must not swallow the ones that already answered.
        let _ = std::io::Write::flush(&mut std::io::stdout());
    }
    println!(
        "\n{}",
        if failed == 0 { format!("ALL {ran} PROBE(S) PASSED") } else { format!("{failed} of {ran} PROBE(S) FAILED") }
    );
    if failed > 0 {
        std::process::exit(1);
    }
}

// ---------------------------------------------------------------------------------------------
// S2 / S2b — module evaluation
// ---------------------------------------------------------------------------------------------

/// The direct analogue of the TS call — `ctx.evalCode(source, "adapter.mjs", { type: "module" })`.
///
/// **It does not hand back the namespace, and that is the finding.** `global: false` does select
/// `JS_EVAL_TYPE_MODULE`, but QuickJS returns the module's *evaluation promise* from that entry
/// point (module bodies may use top-level await). The immediate result is therefore a Promise —
/// an object with no `default` property — and the namespace only appears once that promise is
/// awaited. A port that wrote `eval_with_options(...).get("default")` would fail on every guest.
fn probe_module_eval() -> Probe {
    let rt = Runtime::new().map_err(|e| format!("Runtime::new: {e}"))?;
    let ctx = rquickjs::Context::full(&rt).map_err(|e| format!("Context::full: {e}"))?;
    ctx.with(|ctx| -> Probe {
        let raw: Value = ctx
            .eval_with_options(GOOD_GUEST, module_opts())
            .map_err(|e| format!("eval_with_options(module) failed: {e}"))?;
        let kind = raw.type_of();
        let promise = raw
            .into_promise()
            .ok_or_else(|| format!("eval_with_options returned {kind}, not a promise"))?;
        // Await it: pump until the evaluation promise settles, then take its value.
        let mut guard = 0;
        while promise.state() == PromiseState::Pending && guard < 10_000 {
            let _ = ctx.execute_pending_job();
            guard += 1;
        }
        let ns = promise
            .result::<Value>()
            .ok_or_else(|| "evaluation promise never settled".to_string())?
            .map_err(|e| format!("evaluation rejected: {e}"))?;
        let resolved_type = ns.type_of();
        // The finding: this entry point cannot reach the namespace at all. Assert the trap rather
        // than pretending this is the right door — if a future version of the crate starts
        // exposing `default` here, this probe must go red so the doc claim is revisited.
        let has_default = ns
            .into_object()
            .map(|o| o.get::<_, Value>("default").map(|v| !v.is_undefined()).unwrap_or(false))
            .unwrap_or(false);
        if has_default {
            return Err(format!(
                "eval_with_options DID expose a `default` (awaited value type {resolved_type}) — the trap claim is wrong"
            ));
        }
        Ok(format!(
            "eval_with_options(module) returns a Promise (type {kind}), and awaiting it yields {resolved_type} \
             with no `default` — the namespace is unreachable from this entry point, so the `Module` door (S2b) \
             is the one to port"
        ))
    })
}

/// The typed alternative: `Module::declare(...)?.eval()?` gives a `Module<Evaluated>` whose `get`
/// reaches the same `default`. Worth knowing which door is open, because `declare` compiles
/// *without running* — which is what `compile()` (`code-adapter.ts:202`) exists to do.
fn probe_module_api() -> Probe {
    let rt = Runtime::new().map_err(|e| format!("Runtime::new: {e}"))?;
    let ctx = rquickjs::Context::full(&rt).map_err(|e| format!("Context::full: {e}"))?;
    ctx.with(|ctx| -> Probe {
        let declared = Module::declare(ctx.clone(), "adapter.mjs", GOOD_GUEST)
            .map_err(|e| format!("Module::declare failed to compile: {e}"))?;
        let (module, promise) = declared.eval().map_err(|e| format!("Module::eval failed: {e}"))?;
        // No top-level await here, so evaluation settles immediately — but observe it anyway.
        let mut guard = 0;
        while promise.state() == PromiseState::Pending && guard < 1000 {
            let _ = ctx.execute_pending_job();
            guard += 1;
        }
        let def: Value = module.get("default").map_err(|e| format!("module.get(default): {e}"))?;
        if !def.is_object() {
            return Err(format!("module default is {} not an object", def.type_of()));
        }
        let ns = module.namespace().map_err(|e| format!("namespace(): {e}"))?;
        let has_default: bool = ns.contains_key("default").map_err(|e| format!("contains_key: {e}"))?;
        Ok(format!(
            "declare compiled the module without running it; get(default) is an object; namespace has 'default' = {has_default}"
        ))
    })
}

// ---------------------------------------------------------------------------------------------
// S3 — the http bridge: the core of `makeHttp` + `callOp`
// ---------------------------------------------------------------------------------------------

/// The TS `http(req)` host function returns a **deferred promise** it resolves later, and the host
/// loop drains the QuickJS job queue until the guest's promise settles. Reproduce that shape.
///
/// `GOOD_GUEST.listModels` awaits once, so a single pump cannot be enough: the first pump runs the
/// body up to the `await`, the resolve schedules the continuation, and a later pump runs it. A
/// probe that passed with one pump would be measuring nothing.
fn probe_http_bridge() -> Probe {
    let rt = Runtime::new().map_err(|e| format!("Runtime::new: {e}"))?;
    let ctx = rquickjs::Context::full(&rt).map_err(|e| format!("Context::full: {e}"))?;
    ctx.with(|ctx| -> Probe {
        let bridge = Bridge::new();
        let http = make_http(&ctx, &bridge).map_err(|e| format!("Function::new(http): {e}"))?;
        let def = default_export(&ctx, GOOD_GUEST)?;
        let list_models: Function = def.get("listModels").map_err(|e| format!("get(listModels): {e}"))?;

        let promise: Promise = list_models.call((http,)).map_err(|e| format!("call(listModels): {e}"))?;
        if std::env::var("SPIKE_DEBUG").is_ok() {
            eprintln!("[S3] call returned; promise state = {:?}", promise.state());
        }
        let result = settle(&ctx, promise, &bridge)?;

        let ids: Vec<String> = result
            .into_array()
            .ok_or_else(|| "listModels result is not an array".to_string())?
            .iter::<String>()
            .filter_map(|v| v.ok())
            .collect();
        if ids != vec!["text-1", "img-2"] {
            return Err(format!("listModels resolved to {ids:?}, expected [\"text-1\", \"img-2\"]"));
        }
        Ok(format!("listModels resolved to {ids:?} through the deferred-promise bridge"))
    })
}

// ---------------------------------------------------------------------------------------------
// S4 — emit: a host callback the guest calls, writing into a host queue
// ---------------------------------------------------------------------------------------------

fn probe_emit() -> Probe {
    let rt = Runtime::new().map_err(|e| format!("Runtime::new: {e}"))?;
    let ctx = rquickjs::Context::full(&rt).map_err(|e| format!("Context::full: {e}"))?;
    ctx.with(|ctx| -> Probe {
        let bridge = Bridge::new();
        let http = make_http(&ctx, &bridge).map_err(|e| format!("Function::new(http): {e}"))?;
        let emitted: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
        let emit = Function::new(
            ctx.clone(),
            {
                let emitted = emitted.clone();
                move |s: String| emitted.borrow_mut().push(s)
            },
        )
        .map_err(|e| format!("Function::new(emit): {e}"))?;

        let def = default_export(&ctx, GOOD_GUEST)?;
        let gen: Function = def.get("generateText").map_err(|e| format!("get(generateText): {e}"))?;
        let args = r#"{"model":"text-1","messages":[{"role":"user","content":"hi"}],"stream":true}"#;
        let promise: Promise = gen.call((http, emit, args)).map_err(|e| format!("call(generateText): {e}"))?;
        settle(&ctx, promise, &bridge)?;

        let got = emitted.borrow().clone();
        if got != vec!["Al".to_string(), "pha".to_string()] {
            return Err(format!("emitted {got:?}, expected [\"Al\", \"pha\"]"));
        }
        Ok(format!("emit pushed {got:?} into the host queue, readable between pumps"))
    })
}

// ---------------------------------------------------------------------------------------------
// S5 / S6 — the sandbox limits
// ---------------------------------------------------------------------------------------------

fn probe_interrupt() -> Probe {
    let rt = Runtime::new().map_err(|e| format!("Runtime::new: {e}"))?;
    let deadline_ms = Arc::new(AtomicU64::new(u64::MAX));
    let armed = Arc::new(AtomicBool::new(false));
    {
        let deadline_ms = deadline_ms.clone();
        let armed = armed.clone();
        rt.set_interrupt_handler(Some(Box::new(move || {
            if !armed.load(Ordering::Relaxed) {
                return false;
            }
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            now > deadline_ms.load(Ordering::Relaxed)
        })));
    }
    let ctx = rquickjs::Context::full(&rt).map_err(|e| format!("Context::full: {e}"))?;
    let started = Instant::now();
    let outcome = ctx.with(|ctx| -> Result<(), String> {
        // An infinite loop in the guest body — nothing but the engine's own interrupt can stop it.
        let def = default_export(&ctx, "export default { async listModels() { for (;;) {} } };")?;
        let m: Function = def.get("listModels").map_err(|e| format!("get: {e}"))?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        deadline_ms.store(now + 300, Ordering::Relaxed);
        armed.store(true, Ordering::Relaxed);
        // An async body runs synchronously up to its first `await` — and this one has none — so
        // the abort may surface as an `Err` from the call itself rather than from a later job.
        // Check every path, or the probe reports a false failure when the engine did its job.
        let call = m.call::<_, Value>(());
        let mut promise_handle: Option<Promise> = None;
        let mut aborted: Option<String> = match call {
            Err(e) => Some(format!("the call returned Err: {e}")),
            Ok(v) => match v.into_promise() {
                Some(p) => {
                    let rejected = p.state() == PromiseState::Rejected;
                    promise_handle = Some(p);
                    if rejected {
                        Some("the returned promise was rejected".to_string())
                    } else {
                        None
                    }
                }
                None => None,
            },
        };
        if aborted.is_none() {
            // Drive it. A spinning guest blocks *inside* the first job execution until the
            // interrupt fires, after which the async function's promise is rejected. Small cap:
            // `Ctx::execute_pending_job` reports an errored job as `true`, so a large cap here
            // would spin on the failure rather than observing it.
            pump(&ctx, 100);
            if let Some(p) = promise_handle.as_ref() {
                if p.state() == PromiseState::Rejected {
                    aborted = Some("the promise rejected while the job queue drained".to_string());
                }
            }
        }
        armed.store(false, Ordering::Relaxed);
        match aborted {
            Some(why) => Err(why),
            None => Ok(()),
        }
    });
    let elapsed = started.elapsed();
    match outcome {
        Err(e) => Ok(format!("guest aborted by the interrupt handler after {elapsed:?} ({e})")),
        Ok(()) => {
            if elapsed < Duration::from_millis(250) {
                Err(format!("returned in {elapsed:?} without the handler firing — it cannot have spun"))
            } else {
                Err(format!("guest spun {elapsed:?} and was NOT aborted — the handler did not stop it"))
            }
        }
    }
}

/// OOM behaviour under a memory limit.
///
/// **A crash kills the process, so each variant is its own probe and must be run alone**
/// (`jsengine-spike S6b`). The four variants answer four different questions:
/// `S6a` no limit (is the *limit* the cause?), `S6b` 8 MB, `S6c` the TS's own 32 MB, and `S6d`
/// with the allocation landing in a job after an `await` rather than inside the call.
fn mem_probe(limit: Option<usize>, await_first: bool) -> Probe {
    let dbg = |m: &str| {
        if std::env::var("SPIKE_DEBUG").is_ok() {
            eprintln!("[mem] {m}");
        }
    };
    let rt = Runtime::new().map_err(|e| format!("Runtime::new: {e}"))?;
    if let Some(l) = limit {
        rt.set_memory_limit(l);
    }
    rt.set_max_stack_size(512 * 1024);
    let ctx = rquickjs::Context::full(&rt).map_err(|e| format!("Context::full: {e}"))?;
    // ~60 MB of live strings: past both the 8 MB and the 32 MB limit, and comfortable without one.
    let alloc = "const a = []; for (let i = 0; i < 60000; i++) a.push('x'.repeat(1000)); return a.length;";
    let src = if await_first {
        // `await Promise.resolve()` forces the continuation onto the job queue, so the allocation
        // happens inside `pump`, not inside `m.call`. A different crash site is a different defect.
        format!("export default {{ async listModels() {{ await Promise.resolve(); {alloc} }} }};")
    } else {
        format!("export default {{ async listModels() {{ {alloc} }} }};")
    };
    let state = ctx.with(|ctx| -> Result<PromiseState, String> {
        let def = default_export(&ctx, &src)?;
        dbg("module compiled and evaluated");
        let m: Function = def.get("listModels").map_err(|e| format!("get: {e}"))?;
        dbg(if await_first { "calling (allocation lands in a job)" } else { "calling (allocation lands in the call)" });
        let call = m.call::<_, Value>(());
        dbg("call returned");
        let promise = match call {
            Err(e) => return Err(format!("trapped at the call: {e}")),
            Ok(v) => v.into_promise(),
        };
        let Some(promise) = promise else {
            return Err("the guest returned a non-promise; the probe cannot observe the trap".to_string());
        };
        if promise.state() == PromiseState::Pending {
            dbg("pumping");
            pump(&ctx, 500_000);
            dbg("pumped");
        }
        Ok(promise.state())
    })?;
    dbg("left scope");
    // `memory_usage()` takes the runtime lock, so it must be read outside the context scope.
    let usage = rt.memory_usage();
    dbg("read memory usage");
    let label = match limit {
        None => "no limit".to_string(),
        Some(l) => format!("{} MB limit", l / (1024 * 1024)),
    };
    // The control inverts the expectation on purpose: with no limit, *resolving* is the correct
    // outcome, and a rejection there would mean the trap came from something other than the limit.
    match (limit.is_none(), state) {
        (true, PromiseState::Resolved) => Ok(format!(
            "(no limit) guest allocated ~60 MB and resolved normally; malloc_size={} — so the limit, \
             not the allocation, is what kills S6b/S6c",
            usage.malloc_size
        )),
        (true, PromiseState::Rejected) => Err(format!(
            "(no limit) guest was rejected with NO limit set; the trap has another cause (malloc_size={})",
            usage.malloc_size
        )),
        (false, PromiseState::Rejected) => Ok(format!(
            "({label}) guest rejected cleanly; malloc_size={}, malloc_count={}",
            usage.malloc_size, usage.malloc_count
        )),
        (false, PromiseState::Resolved) => Err(format!(
            "({label}) guest allocated ~60 MB and resolved normally; the limit did not bite (malloc_size={})",
            usage.malloc_size
        )),
        (_, PromiseState::Pending) => Err(format!(
            "({label}) guest neither resolved nor rejected after the pump; inconclusive (malloc_size={})",
            usage.malloc_size
        )),
    }
}

/// Control: is *any* error raised inside the call fatal, or only the OOM? The TS contract suite
/// pins `throw new Error("boom")` as a clean rejection (`code-adapter.test.ts:216`), so the port
/// must reproduce that — and if it does, the segfault in S6b/S6c is OOM-specific rather than a
/// general "errors during JS_Call are fatal" defect.
fn probe_throw_at_entry() -> Probe {
    let rt = Runtime::new().map_err(|e| format!("Runtime::new: {e}"))?;
    let ctx = rquickjs::Context::full(&rt).map_err(|e| format!("Context::full: {e}"))?;
    ctx.with(|ctx| -> Probe {
        let def = default_export(&ctx, r#"export default { async listModels() { throw new Error("boom"); } };"#)?;
        let m: Function = def.get("listModels").map_err(|e| format!("get: {e}"))?;
        let call = m.call::<_, Value>(());
        match call {
            Err(e) => Err(format!("the throw escaped as a call error instead of a rejection: {e}")),
            Ok(v) => match v.into_promise() {
                Some(p) if p.state() == PromiseState::Rejected => {
                    let reason = p.result::<Value>().map(|r| r.is_err()).unwrap_or(false);
                    Ok(format!("`throw new Error(\"boom\")` rejected cleanly (rejection surfaced: {reason})"))
                }
                Some(p) => Err(format!("expected a rejected promise, got {:?}", p.state())),
                None => Err("the guest did not return a promise".to_string()),
            },
        }
    })
}

/// Control: the other containment limit. `STACK_LIMIT` is 512 KB in the TS sandbox, and unbounded
/// recursion is the cheapest way to reach it. Does a blown stack reject, or does it also kill the
/// process? The TS has no test for this either.
fn probe_stack_limit() -> Probe {
    let rt = Runtime::new().map_err(|e| format!("Runtime::new: {e}"))?;
    rt.set_max_stack_size(512 * 1024);
    let ctx = rquickjs::Context::full(&rt).map_err(|e| format!("Context::full: {e}"))?;
    ctx.with(|ctx| -> Probe {
        let def = default_export(
            &ctx,
            "export default { async listModels() { const f = (n) => f(n + 1); return f(0); } };",
        )?;
        let m: Function = def.get("listModels").map_err(|e| format!("get: {e}"))?;
        let call = m.call::<_, Value>(());
        match call {
            Err(e) => Ok(format!("runaway recursion surfaced as a call error: {e}")),
            Ok(v) => match v.into_promise() {
                Some(p) if p.state() == PromiseState::Rejected => {
                    Ok("runaway recursion rejected cleanly (the stack limit is contained)".to_string())
                }
                Some(p) if p.state() == PromiseState::Pending => {
                    let ran = pump(&ctx, 1000);
                    Ok(format!("runaway recursion left a pending promise; {ran} job(s) drained after it"))
                }
                Some(p) => Err(format!("expected rejection or a pending promise, got {:?}", p.state())),
                None => Err("the guest did not return a promise".to_string()),
            },
        }
    })
}

/// S6g — **does S6f's containment transfer off the main thread?**
///
/// S6f found runaway recursion contained under a 512 KB JS stack limit. But it ran on the **main**
/// thread, where macOS gives 8 MB of C stack. The actor that hosts a guest in `core/js_host.rs`
/// runs on a `std::thread`, whose Rust default is **2 MB** (`std::thread::Builder`'s
/// `DEFAULT_STACK_SIZE`) — so S6f's result does not automatically transfer, and the question "is
/// the JS limit reached *before* the C stack runs out?" has never been asked. The failure mode is
/// the bad one: a blown C stack is a `SIGSEGV`, not a catchable error, and it looks exactly like
/// S6b's OOM crash while having a completely different cause.
///
/// The thread stack size therefore comes from the **environment**, one size per process, because a
/// probe that crashes the process can only report the size that crashed it by dying at that line:
/// `SPIKE_THREAD_STACK=2097152 jsengine-spike S6g`.
fn probe_thread_stack() -> Probe {
    let bytes: usize = std::env::var("SPIKE_THREAD_STACK")
        .ok()
        .and_then(|s| s.parse().ok())
        // `std::thread`'s own default, which is what `JsSandbox::spawn` gets today.
        .unwrap_or(2 * 1024 * 1024);
    let handle = std::thread::Builder::new()
        .stack_size(bytes)
        .spawn(move || -> Probe {
            let rt = Runtime::new().map_err(|e| format!("Runtime::new: {e}"))?;
            rt.set_max_stack_size(512 * 1024);
            let ctx = rquickjs::Context::full(&rt).map_err(|e| format!("Context::full: {e}"))?;
            ctx.with(|ctx| -> Probe {
                let def = default_export(
                    &ctx,
                    "export default { async listModels() { const f = (n) => f(n + 1); return f(0); } };",
                )?;
                let m: Function = def.get("listModels").map_err(|e| format!("get: {e}"))?;
                match m.call::<_, Value>(()) {
                    Err(e) => Ok(format!("call error before any promise: {e}")),
                    Ok(v) => match v.into_promise() {
                        Some(p) if p.state() == PromiseState::Rejected => Ok(format!(
                            "CONTAINED: the 512 KB JS limit fired before the {bytes}-byte C stack"
                        )),
                        Some(p) if p.state() == PromiseState::Pending => {
                            let ran = pump(&ctx, 1000);
                            Ok(format!("pending after the guard; {ran} job(s) drained"))
                        }
                        Some(p) => Err(format!("unexpected state {:?}", p.state())),
                        None => Err("the guest did not return a promise".to_string()),
                    },
                }
            })
        })
        .map_err(|e| format!("thread spawn: {e}"))?;
    handle.join().unwrap_or_else(|_| Err("the guest thread panicked".to_string()))
}

// ---------------------------------------------------------------------------------------------
// S7 — the seam bound. `core/adapter.rs` declares `trait AdapterInstance: Send + Sync`.
// ---------------------------------------------------------------------------------------------

fn probe_send_sync() -> Probe {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Runtime>();
    assert_send_sync::<rquickjs::Context>();
    Ok("Runtime and Context are Send + Sync under the `parallel` feature; the impls are \
        `#[cfg(feature = \"parallel\")]` (runtime/base.rs:187-197, context/base.rs:144-149), so \
        without that feature both are !Send and no `Arc<dyn AdapterInstance>` can hold one."
        .into())
}

// ---------------------------------------------------------------------------------------------
// S8 — the money probe: the guest contract, verbatim, all three operations
// ---------------------------------------------------------------------------------------------

fn probe_good_guest() -> Probe {
    let rt = Runtime::new().map_err(|e| format!("Runtime::new: {e}"))?;
    let ctx = rquickjs::Context::full(&rt).map_err(|e| format!("Context::full: {e}"))?;
    ctx.with(|ctx| -> Probe {
        let bridge = Bridge::new();
        let http = make_http(&ctx, &bridge).map_err(|e| format!("Function::new(http): {e}"))?;
        let emitted: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
        let emit = Function::new(
            ctx.clone(),
            {
                let emitted = emitted.clone();
                move |s: String| emitted.borrow_mut().push(s)
            },
        )
        .map_err(|e| format!("Function::new(emit): {e}"))?;
        let def = default_export(&ctx, GOOD_GUEST)?;

        // 1. listModels -> ["text-1","img-2"]  (the free contract check)
        let list_models: Function = def.get("listModels").map_err(|e| format!("get(listModels): {e}"))?;
        let p: Promise = list_models.call((http.clone(),)).map_err(|e| format!("call(listModels): {e}"))?;
        let models = settle(&ctx, p, &bridge)?;
        let ids: Vec<String> = models
            .into_array()
            .ok_or_else(|| "listModels result is not an array".to_string())?
            .iter::<String>()
            .filter_map(|v| v.ok())
            .collect();
        if ids != vec!["text-1", "img-2"] {
            return Err(format!("listModels -> {ids:?}, expected [\"text-1\", \"img-2\"]"));
        }

        // 2. generateText -> emits ["Al","pha"]  (the paid text check)
        let gen: Function = def.get("generateText").map_err(|e| format!("get(generateText): {e}"))?;
        let args = r#"{"model":"text-1","messages":[{"role":"user","content":"ping"}],"stream":false,"maxTokens":1}"#;
        let p: Promise = gen
            .call((http.clone(), emit.clone(), args))
            .map_err(|e| format!("call(generateText): {e}"))?;
        settle(&ctx, p, &bridge)?;
        let got = emitted.borrow().clone();
        if got != vec!["Al".to_string(), "pha".to_string()] {
            return Err(format!("generateText emitted {got:?}, expected [\"Al\", \"pha\"]"));
        }

        // 3. generateImage -> {ok:true, status:200, base64:"QUJD"}  (the paid image check)
        let img_fn: Function = def.get("generateImage").map_err(|e| format!("get(generateImage): {e}"))?;
        let iargs = r#"{"model":"img-2","prompt":"a single white pixel"}"#;
        let p: Promise = img_fn.call((http, iargs)).map_err(|e| format!("call(generateImage): {e}"))?;
        let img = settle(&ctx, p, &bridge)?;
        let iobj = img.into_object().ok_or_else(|| format!("image into_object"))?;
        let ok: bool = iobj.get("ok").map_err(|e| format!("img.ok: {e}"))?;
        let status: i64 = iobj.get("status").map_err(|e| format!("img.status: {e}"))?;
        let b64: String = iobj.get("base64").map_err(|e| format!("img.base64: {e}"))?;
        if !(ok && status == 200 && b64 == "QUJD") {
            return Err(format!("generateImage -> {{ok:{ok}, status:{status}, base64:{b64:?}}}"));
        }

        Ok("all three guest operations ran verbatim: listModels=[text-1,img-2], \
            generateText=[Al,pha], generateImage={ok,200,QUJD}"
            .into())
    })
}
