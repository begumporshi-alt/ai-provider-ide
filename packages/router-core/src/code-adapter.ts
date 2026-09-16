/**
 * code-adapter (L2, §2.7): the Tier-2 fallback. When no declarative manifest can express a
 * provider (exotic auth dance, non-JSON framing, unusual streaming), the Generator may emit
 * a small JS module instead; this file executes it inside QuickJS compiled to WASM.
 *
 * Guest contract (the generator prompt must emit exactly this shape):
 *   export default {
 *     async listModels(http) -> [{id}|string]                       // or null/omitted
 *     async generateText(http, emit, argsJson) -> undefined          // emit(chunk) streams
 *     async generateImage(http, argsJson) -> {ok,status,base64?,url?,errorBody?}
 *   }
 *   `argsJson` is a JSON string: {model, messages, stream, maxTokens?, temperature?}.
 *   `http(req)` -> Promise<{status, text}>: req = {path, method?, headers?, body?}.
 *     `path` must be a RELATIVE provider path ("/models"); the host prefixes the manifest
 *     baseUrl and injects the sentinel auth headers + secretRef — guest code can NEVER
 *     carry or read credentials, and can NEVER address another host (same egress allowlist).
 *   `log(string)` is available globally (scrubbed, capped).
 *
 * Sandbox limits (§2.7): 64 KB source (grammar also bounds it), 45s wall-clock per
 * operation, 32 MB guest heap, 512 KB stack, 20 http calls + 400 emitted lines per
 * operation, 8 MB response body. No filesystem / DOM / Node / import / eval exist in
 * QuickJS at all; the lint below additionally bans `import(`, `require`, `Function(` and
 * friends as a tripwire (source passing them is rejected before compilation).
 *
 * Why the SYNC QuickJS variant + a job-pump (not ASYNCIFY): QuickJS supports promises and
 * async natively; async host calls bridge via QuickJSDeferredPromise and the pump drains
 * the job queue while host fetches settle. ASYNCIFY's one-concurrent-async-action limit
 * and 2x size penalty buy nothing here.
 *
 * Handle-ownership rules used throughout (quickjs-emscripten lifetime contract):
 *  - callFunction args are borrowed; the caller disposes after the call.
 *  - a value returned from a host function implementation transfers to the VM: return
 *    deferred.handle and never dispose it — QuickJSDeferredPromise.dispose() frees the
 *    promise handle itself, so awaiting a disposed deferred is a use-after-free.
 *  - deferred.resolve/reject(handle) borrows the value; settle, dispose your own copy of
 *    the value, and keep the promise handle alive for the VM.
 *  - resolve/reject dispose their callbacks automatically on settle; nothing else is owed.
 */
import type { AdapterManifest } from "@aiprovider/adapter-spec";
import quickjsVariant from "@jitl/quickjs-singlefile-mjs-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import type { HttpPort } from "./ports.js";
import type { AdapterInstance } from "./adapter-instance.js";
import type { ImageAttemptResult, ModelEntry, TextArgs } from "./manifest-interpreter.js";

export class SandboxError extends Error {
  constructor(message: string, readonly reason: "lint" | "compile" | "runtime" | "timeout" | "limits" | "host") {
    super(message);
    this.name = "SandboxError";
  }
}

const SOURCE_LIMIT = 64_000; // grammar also bounds it; defense in depth
const OP_BUDGET_MS = 45_000;
const HTTP_CALLS_PER_OP = 20;
const EMIT_LINES_PER_OP = 400;
const BODY_CAP = 8_000_000;
const MEMORY_LIMIT = 32 * 1024 * 1024;
const STACK_LIMIT = 512 * 1024;
const AUTH_HEADER_RE = /^(authorization|x-api-key|x-goog-api-key|api-key|cookie)$/i;

let modulePromise: Promise<QuickJSWASMModule> | null = null;
function wasmModule(): Promise<QuickJSWASMModule> {
  if (!modulePromise) modulePromise = newQuickJSWASMModuleFromVariant(quickjsVariant);
  return modulePromise;
}

/** Static checks a code adapter source must survive before it ever reaches QuickJS. */
export function lintCodeSource(source: string): string[] {
  const errors: string[] = [];
  if (source.length > SOURCE_LIMIT) errors.push(`source too large (${source.length} > ${SOURCE_LIMIT})`);
  if (!/export\s+default\s*\{/.test(source)) errors.push('must contain "export default {"');
  for (const forbidden of [
    /\bimport\s*\(/, /\bimport\s+[\w{*]/, /\brequire\s*\(/, /\beval\s*\(/,
    /\bnew\s+Function\b/, /\bFunction\s*\(/, /\bWebAssembly\b/, /\bAtomics\b/,
    /\bSharedArrayBuffer\b/, /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bimport\.meta\b/,
  ]) {
    if (forbidden.test(source)) errors.push(`forbidden construct: ${forbidden.source}`);
  }
  return errors;
}

interface OpBudget {
  deadline: number;
  httpCalls: number;
  lines: number;
}

export interface CodeAdapterOptions {
  http: HttpPort;
  opBudgetMs?: number;
  onLog?: (line: string) => void;
}

/**
 * A compiled, sandboxed code adapter (manifest.kind === "code"). Lazy: the sandbox is built
 * on first use. A timeout/error disposes the context so a wedged guest can never poison
 * later operations (the next call rebuilds from source).
 */
export class CodeAdapterInstance implements AdapterInstance {
  private runtime: QuickJSRuntime | null = null;
  private ctx: QuickJSContext | null = null;
  private adapter: QuickJSHandle | null = null;
  private build: Promise<void> | null = null;
  private disposed = false;
  /** http deferreds still awaiting an egress response; settled on teardown (see reset). */
  private deferreds = new Set<QuickJSDeferredPromise>();

  readonly manifest: AdapterManifest;

  constructor(manifest: AdapterManifest, private readonly opts: CodeAdapterOptions) {
    if (manifest.kind !== "code" || !manifest.code?.source) {
      throw new SandboxError('code adapter requires kind:"code" + code.source', "lint");
    }
    const lint = lintCodeSource(manifest.code.source);
    if (lint.length) throw new SandboxError(`code adapter rejected by lint: ${lint.join("; ")}`, "lint");
    this.manifest = manifest;
  }

  capabilities(): { text: boolean; image: boolean } {
    return this.manifest.capabilities;
  }

  tagModality(nativeId: string): "text" | "image" {
    const rules = this.manifest.modalityRules;
    if (rules?.image && new RegExp(rules.image.modelIdPattern).test(nativeId)) return "image";
    return "text";
  }

  // ---------- sandbox lifecycle ----------

  private async ensure(): Promise<{ runtime: QuickJSRuntime; ctx: QuickJSContext; adapter: QuickJSHandle }> {
    if (this.disposed) throw new SandboxError("adapter disposed", "host");
    if (!this.build) this.build = this.buildSandbox();
    try {
      await this.build;
    } catch (e) {
      this.build = null; // allow a clean rebuild on the next call
      throw e;
    }
    if (!this.runtime || !this.ctx || !this.adapter) throw new SandboxError("sandbox failed to initialize", "host");
    return { runtime: this.runtime, ctx: this.ctx, adapter: this.adapter };
  }

  private async buildSandbox(): Promise<void> {
    const mod = await wasmModule();
    const source = this.manifest.code!.source;
    const runtime = mod.newRuntime({
      memoryLimitBytes: MEMORY_LIMIT,
      maxStackSizeBytes: STACK_LIMIT,
      interruptHandler: () => false, // real handler armed per operation
    });
    let ctx: QuickJSContext | null = null;
    try {
      ctx = runtime.newContext();
      const g = ctx.global;
      const onLog = this.opts.onLog;
      const dialect = this.manifest.dialect;
      const log = ctx.newFunction("log", (msg) => {
        const line = msg ? ctx!.getString(msg).slice(0, 500) : "";
        (onLog ?? ((l) => console.log(`[adapter:${dialect}] ${l}`)))(line);
      });
      ctx.setProp(g, "log", log);
      log.dispose();
      g.dispose();

      const evalRes = ctx.evalCode(source, "adapter.mjs", { type: "module" });
      if (evalRes.error) {
        const msg = String(ctx.dump(evalRes.error)).slice(0, 300);
        evalRes.error.dispose();
        throw new SandboxError(`module failed to compile: ${msg}`, "compile");
      }
      const namespace = evalRes.value;
      const def = ctx.getProp(namespace, "default");
      namespace.dispose();
      if (ctx.typeof(def) !== "object") {
        def.dispose();
        throw new SandboxError('module must "export default" an object', "compile");
      }
      this.runtime = runtime;
      this.ctx = ctx;
      this.adapter = def;
    } catch (e) {
      ctx?.dispose();
      runtime.dispose();
      throw e;
    }
  }

  /** Tear down the current context; the next operation rebuilds from source. */
  private async reset(): Promise<void> {
    const ctx = this.ctx;
    const runtime = this.runtime;
    if (ctx?.alive) {
      // An unresolved http deferred keeps its resolver handles (VM objects) alive —
      // freeing the runtime under them trips the GC's leak assertion. Reject every
      // in-flight call so the suspended guest coroutines die inside the job queue.
      const reason = ctx.newString("http: operation cancelled by the host");
      for (const d of this.deferreds) {
        try {
          d.reject(reason);
        } catch {
          /* already settled */
        }
      }
      reason.dispose();
      this.deferreds.clear();
      let guard = 0;
      while (ctx.alive && runtime?.hasPendingJob() && guard++ < 10_000) {
        try {
          runtime.executePendingJobs();
        } catch {
          break; // a wedged job: the context disposal below reclaims everything
        }
      }
    }
    this.adapter?.dispose();
    this.adapter = null;
    this.ctx?.dispose();
    this.ctx = null;
    this.runtime?.dispose();
    this.runtime = null;
    this.build = null;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.reset();
  }

  // ---------- host function bridge ----------

  /**
   * Per-operation `http(req) -> Promise<{status,text}>`. Auth: the guest may set non-auth
   * headers only; manifest auth ({{secret}} sentinels) + secretRef ride host-side. Paths
   * must be relative — the guest cannot address any host beyond the allowlisted baseUrl.
   */
  private makeHttp(ctx: QuickJSContext, secretRef: string, budget: OpBudget): QuickJSHandle {
    const baseUrl = this.manifest.provider.baseUrl.replace(/\/+$/, "");
    const authHeaders: Record<string, string> = Object.fromEntries(
      this.manifest.provider.auth.headers.map((h) => [h.name, h.prefix ? `${h.prefix} {{secret}}` : "{{secret}}"]),
    );
    const fetcher = this.opts.http;
    const isAlive = () => !this.disposed && ctx.alive;

    return ctx.newFunction("http", (argHandle) => {
      // Contract failures reject the returned promise so a guest `await http(...)` throws
      // immediately instead of continuing on a half-formed result object.
      const fail = (msg: string): QuickJSHandle => {
        const d = ctx.newPromise();
        const reason = ctx.newString(msg);
        d.reject(reason);
        reason.dispose(); // reject borrows the value; the promise keeps it alive
        // NOTE: no deferred.dispose() — that frees d.handle, which we return to the VM.
        return d.handle;
      };
      if (!argHandle) return fail("http: request object required");
      if (budget.httpCalls >= HTTP_CALLS_PER_OP) {
        return fail(`http: rate limit (${HTTP_CALLS_PER_OP} calls/operation) exceeded`);
      }
      const a = ctx.dump(argHandle) as Record<string, unknown>;
      const path = typeof a.path === "string" ? a.path : "";
      if (!path.startsWith("/") || path.startsWith("//") || path.includes("..")) {
        return fail(`http: path must be a relative provider path, got ${JSON.stringify(path).slice(0, 80)}`);
      }
      budget.httpCalls += 1;
      const method = a.method === "GET" ? "GET" : "POST";
      const guest = (a.headers && typeof a.headers === "object" ? a.headers : {}) as Record<string, unknown>;
      const headers: Record<string, string> = { ...authHeaders };
      for (const [k, v] of Object.entries(guest)) {
        if (!AUTH_HEADER_RE.test(k) && typeof v === "string") headers[k] = v;
      }
      const deferred = ctx.newPromise();
      this.deferreds.add(deferred);
      void (async () => {
        try {
          const res = await fetcher.request({
            url: baseUrl + path,
            method,
            headers,
            body: a.body === undefined ? undefined : JSON.stringify(a.body),
            secretRef,
          });
          let text = "";
          try {
            text = await res.text();
          } catch {
            /* body already consumed or errored */
          }
          if (text.length > BODY_CAP) text = text.slice(0, BODY_CAP);
          if (!isAlive()) {
            this.deferreds.delete(deferred);
            return deferred.dispose();
          }
          const obj = ctx.newObject();
          ctx.setProp(obj, "status", ctx.newNumber(res.status));
          const t = ctx.newString(text);
          ctx.setProp(obj, "text", t);
          t.dispose();
          this.deferreds.delete(deferred);
          deferred.resolve(obj);
          obj.dispose(); // resolve borrows the value; the promise keeps it alive
          // NOTE: no deferred.dispose() — it frees deferred.handle, which we return to the
          // VM below; the resolve/reject callbacks are disposed automatically on settle.
        } catch (e) {
          this.deferreds.delete(deferred);
          if (!isAlive()) return deferred.dispose();
          const reason = ctx.newString(`http: ${String((e as Error).message ?? e).slice(0, 300)}`);
          deferred.reject(reason);
          reason.dispose();
        }
      })();
      return deferred.handle;
    });
  }

  // ---------- operation driver ----------

  /**
   * Invoke a guest async method, pumping the job queue until its promise settles.
   * Handles settle for both promise-valued (async fn) and plain (sync fn) returns.
   */
  private async callOp(
    name: string,
    secretRef: string,
    extraArgs: (ctx: QuickJSContext) => QuickJSHandle[],
    onSettled: (ctx: QuickJSContext, raw: unknown) => void,
    onFinish?: (ctx: QuickJSContext) => void,
    pump?: (ctx: QuickJSContext, runtime: QuickJSRuntime, budget: OpBudget) => void,
  ): Promise<void> {
    const { runtime, ctx, adapter } = await this.ensure();
    const method = ctx.getProp(adapter, name);
    if (ctx.typeof(method) !== "function") {
      method.dispose();
      throw new SandboxError(`adapter does not implement ${name}()`, "runtime");
    }
    const budget: OpBudget = { deadline: Date.now() + (this.opts.opBudgetMs ?? OP_BUDGET_MS), httpCalls: 0, lines: 0 };
    const http = this.makeHttp(ctx, secretRef, budget);
    const args = [http, ...extraArgs(ctx)];
    let result: { value: unknown } | { error: unknown } | null = null;
    let promiseHandle: QuickJSHandle | null = null;
    const interrupt = () => Date.now() > budget.deadline;
    runtime.setInterruptHandler(interrupt);
    let thrown: unknown = undefined;
    try {
      const call = ctx.callFunction(method, adapter, args);
      if (call.error) {
        const err = ctx.dump(call.error);
        call.error.dispose();
        throw new SandboxError(`adapter.${name} threw at entry: ${JSON.stringify(err)?.slice(0, 300)}`, "runtime");
      }
      promiseHandle = call.value;
      // Sync-returned non-promise: use directly; async: drive to settle.
      const isPromise = ctx.typeof(promiseHandle) === "object";
      const state = isPromise ? ctx.getPromiseState(promiseHandle) : { type: "not-promise" as const };
      if (state.type === "fulfilled" || state.type === "rejected") {
        if (state.type === "rejected") {
          result = { error: ctx.dump(state.error) };
          state.error.dispose();
        } else if (state.notAPromise) {
          // value IS promiseHandle (owned by the finally block) — never dispose it here.
          result = { value: ctx.dump(state.value) };
        } else {
          const fulfilled = ctx.dump(state.value);
          state.value.dispose();
          result = { value: fulfilled };
        }
      } else if (state.type === "pending") {
        void ctx
          .resolvePromise(promiseHandle)
          .then((r) => {
            try {
              if (!ctx.alive) return;
              if (r.error) {
                // DisposableFail: unwrap the rejection reason, keep the handle until dumped.
                result = { error: ctx.dump(r.error) };
                r.error.dispose();
              } else {
                // DisposableSuccess: r.value is defined (undefined only for a void return).
                result = { value: r.value ? ctx.dump(r.value) : undefined };
                r.value.dispose();
              }
            } catch (e) {
              result = { error: String(e) };
            }
          })
          .catch(() => undefined);
      } else {
        result = { value: ctx.dump(promiseHandle) }; // plain sync return
      }

      while (!result) {
        this.pumpJobs(runtime, budget);
        pump?.(ctx, runtime, budget);
        if (result) break;
        if (budget.deadline < Date.now()) {
          throw new SandboxError(`adapter.${name} exceeded ${this.opts.opBudgetMs ?? OP_BUDGET_MS}ms wall clock`, "timeout");
        }
        await new Promise((r) => setTimeout(r, 1));
      }
      if (typeof result === "object" && result !== null && "error" in result) {
        throw new SandboxError(`adapter.${name} threw: ${JSON.stringify(result.error)?.slice(0, 300) ?? String(result.error)}`, "runtime");
      }
      onSettled(ctx, (result as { value: unknown }).value);
      onFinish?.(ctx);
    } catch (e) {
      thrown = e; // a wedged or failing guest: tear the sandbox down below, AFTER the borrows
    } finally {
      // Release the per-call borrows while the context is still live — reset() below frees
      // the context, and touching a freed handle throws UseAfterFree and masks the real error.
      if (ctx.alive) {
        runtime.setInterruptHandler(() => false);
        for (const a of args) a.dispose();
        method.dispose();
        promiseHandle?.dispose();
      }
    }
    if (thrown !== undefined) {
      await this.reset(); // wedged or runtime error: rebuild clean next time
      throw thrown;
    }
  }

  private pumpJobs(runtime: QuickJSRuntime, budget: OpBudget): void {
    let jobs = 0;
    while (runtime.hasPendingJob()) {
      if (budget.deadline < Date.now()) return;
      runtime.executePendingJobs();
      if (++jobs > 20_000) return; // re-check the deadline at the outer loop
    }
  }

  // ---------- AdapterInstance surface ----------

  async listModels(secretRef: string): Promise<ModelEntry[]> {
    let out: ModelEntry[] = [];
    await this.callOp(
      "listModels",
      secretRef,
      () => [],
      (ctx, raw) => {
        const list = Array.isArray(raw) ? raw : [];
        out = list
          .map((e): ModelEntry | null => {
            if (typeof e === "string") return { nativeId: e, raw: e };
            if (e && typeof e === "object") {
              const id = String((e as Record<string, unknown>).id ?? (e as Record<string, unknown>).name ?? "");
              if (id) return { nativeId: id, raw: e };
            }
            return null;
          })
          .filter((e): e is ModelEntry => Boolean(e && e.nativeId.length > 0 && e.nativeId.length < 200));
        void ctx;
      },
    );
    return out;
  }

  async generateImage(
    secretRef: string,
    args: { model: string; prompt: string; size?: string },
  ): Promise<ImageAttemptResult> {
    let out: ImageAttemptResult = { ok: false, status: 0 };
    await this.callOp(
      "generateImage",
      secretRef,
      (ctx) => [ctx.newString(JSON.stringify(args))],
      (_ctx, raw) => {
        const r = (raw ?? {}) as Record<string, unknown>;
        out = {
          ok: Boolean(r.ok),
          status: Number(r.status ?? 0),
          errorBody: typeof r.errorBody === "string" ? r.errorBody.slice(0, 500) : undefined,
          base64: typeof r.base64 === "string" ? r.base64 : undefined,
          url: typeof r.url === "string" ? r.url : undefined,
        };
      },
    );
    return out;
  }

  /** Streaming: the guest `emit(chunk)` pushes chunks; we pump and yield between them. */
  async *generateText(secretRef: string, args: TextArgs): AsyncGenerator<string, void, void> {
    const { runtime, ctx, adapter } = await this.ensure();
    const method = ctx.getProp(adapter, "generateText");
    if (ctx.typeof(method) !== "function") {
      method.dispose();
      throw new SandboxError("adapter does not implement generateText()", "runtime");
    }
    const budget: OpBudget = { deadline: Date.now() + (this.opts.opBudgetMs ?? OP_BUDGET_MS), httpCalls: 0, lines: 0 };
    const queue: string[] = [];
    let failure: Error | null = null;
    let done = false;

    const emit = ctx.newFunction("emit", (msg) => {
      if (budget.lines >= EMIT_LINES_PER_OP) {
        failure = new SandboxError(`emit: rate limit (${EMIT_LINES_PER_OP} lines/operation) exceeded`, "limits");
        return;
      }
      if (msg) {
        const s = ctx.getString(msg);
        if (s) {
          budget.lines += 1;
          queue.push(s);
        }
      }
    });
    const http = this.makeHttp(ctx, secretRef, budget);
    const argsHandle = ctx.newString(
      JSON.stringify({
        model: args.model,
        messages: args.messages,
        stream: args.stream,
        maxTokens: args.maxTokens,
        temperature: args.temperature,
        limits: this.manifest.limits ?? null,
      }),
    );
    runtime.setInterruptHandler(() => Date.now() > budget.deadline);
    const call = ctx.callFunction(method, adapter, [http, emit, argsHandle]);
    http.dispose();
    emit.dispose();
    argsHandle.dispose();
    method.dispose();
    let entryError: SandboxError | undefined;
    let promiseHandle: QuickJSHandle | null = null;
    if (call.error) {
      const err = ctx.dump(call.error);
      call.error.dispose();
      entryError = new SandboxError(`generateText entry failed: ${JSON.stringify(err)?.slice(0, 300)}`, "runtime");
    } else {
      promiseHandle = call.value;
    }
    if (promiseHandle) {
      void ctx
        .resolvePromise(promiseHandle)
        .then((r) => {
          try {
            if (!ctx.alive) return;
            if (r.error) {
              const thrown = ctx.dump(r.error);
              r.error.dispose();
              if (!failure) failure = new SandboxError(`adapter threw: ${JSON.stringify(thrown)?.slice(0, 300)}`, "runtime");
            }
            done = true;
          } catch {
            done = true;
          }
        })
        .catch(() => {
          done = true;
        });
    }

    let broke = false;
    try {
      if (entryError) throw entryError;
      while (true) {
        this.pumpJobs(runtime, budget);
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        if (failure) throw failure;
        if (done) break;
        if (Date.now() > budget.deadline) {
          throw new SandboxError(`generateText exceeded ${this.opts.opBudgetMs ?? OP_BUDGET_MS}ms`, "timeout");
        }
        await new Promise((r) => setTimeout(r, 1));
      }
      for (const c of queue) yield c;
      if (failure) throw failure;
    } catch (e) {
      broke = true;
      throw e;
    } finally {
      // Release the borrow before reset() frees the context (see callOp: touching a freed
      // handle throws UseAfterFree and masks the real failure).
      if (ctx.alive) {
        runtime.setInterruptHandler(() => false);
        promiseHandle?.dispose();
      }
      if (broke || !done) await this.reset(); // hung guest: rebuild clean for the next op
    }
  }

  async pingKey(secretRef: string): Promise<{ ok: boolean; status: number; rateLimited: boolean; message?: string }> {
    try {
      const models = await this.listModels(secretRef);
      return { ok: models.length > 0, status: models.length > 0 ? 200 : 0, rateLimited: false, message: models.length ? undefined : "empty model list" };
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      return { ok: false, status: /429/.test(msg) ? 429 : 0, rateLimited: /429/.test(msg), message: msg.slice(0, 300) };
    }
  }
}
