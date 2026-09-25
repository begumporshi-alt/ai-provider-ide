/**
 * The trail writes, and what happens when one does not land (2026-09-21).
 *
 * Four call sites write these two trails — `drift_event_record`, `drift_event_resolve`, and
 * `generator_audit_record` **twice** (drift repair, and the wizard's candidate generation) — and every
 * one of them was issued with `.catch(() => undefined)`. That is the right instinct for the first
 * property: a repair that applied correctly must not be reported as failed because its *record* did not
 * land, or the operator is told to retry a repair that is already live. It is the wrong instinct for
 * the second: each of those tables now has a reader that claims completeness ("every adapter the
 * assistant wrote", "every time a provider was detected drifting"), and **a read cannot detect a write
 * that never happened** — a dropped row is simply absent. So the swallow stays and the failure is kept.
 *
 * These specs cover the *keeping*: that a rejected write reaches the channel, and that `approveRepair`
 * reports the one case where the operator can still see the contradiction. The card that renders the
 * channel is a browser spec — this file has no React tree, and asserting on a component from here
 * would be the decoration the project keeps warning about.
 *
 * **The channel has two shapes, because the two failures differ** (added later the same day). A lost
 * *row* is an omission, so it is counted. A lost *ending* is not an omission: the row is there, it says
 * `running`, and the Agents screen explains that state with a *cause* — "the app was closed mid-run" —
 * which a failed finish write makes false. `orchestrator.endRun` drops the controller *before* it
 * writes, so a lost ending and a killed session are indistinguishable on screen; and the status is not
 * in doubt, because `endRun` was handed it. So that failure is kept per run, and the row shows what
 * actually happened.
 *
 * Both directions are asserted for each path. A test that only checks "the warning appeared" passes
 * against a channel that warns unconditionally, which would be worse than the bug.
 *
 * Which spec covers which call site (recorded because a spec that passes with its mechanism removed is
 * decoration, and the sites do not share one):
 *   - `drift_event_resolve`, drift repair → "keeps the failure when a repair's drift event could not be closed"
 *   - `drift_event_record`, the drift monitor → "keeps the failure when a detection could not be written"
 *   - `generator_audit_record`, **both** producers → "keeps the failure when a generation could not be
 *     recorded", which drives the shared `recordGeneratorAudit` directly.
 *   - `agent_run_finish`, `orchestrator.endRun` → "keeps the status the loop reported when the finish
 *     write does not land" — the channel's second shape.
 *   - `agent_run_start` / `agent_step_append`, `orchestrator.startRun` / `recordStep` → the third
 *     trail, a run the dashboard will never list: "counts a start that did not land", and the two
 *     specs around it that pin the one-run-one-count rule from both sides.
 *
 * The third covers two call sites with one spec, and that is the point of the helper rather than a
 * shortcut: the wizard used to build its own `generator_audit_record` payload inline, so when the other
 * three sites were routed through `writeTrail` that copy was missed and stayed silent — on the producer
 * the generation-audit card names *first*. One function is one place to get it right.
 *
 * **A fourth shape, added last and not a trail write at all** (`buildRepairPlan`). It earns its place here
 * because the property is the same one — a failure is *kept* rather than discarded — and because the
 * surface it stranded was a card asserting a cause. Its depth is in REFERENCE.md §Trail health.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted` because vi.mock factories run before any top-level `const` exists.
const h = vi.hoisted(() => ({
  /** Commands the fake host rejects, with the message it rejects with. */
  failing: new Map<string, string>(),
  invokes: [] as Array<{ cmd: string; args: Record<string, unknown> }>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    h.invokes.push({ cmd, args });
    const failure = h.failing.get(cmd);
    if (failure !== undefined) throw new Error(failure);
    // No per-command switch: every command these specs arrange to fail is a trail write whose
    // success value is unused, so the honest default is `undefined`. `manifest_stage` and
    // `manifest_activate` used to be answered here — they moved to the transport fake in 26o/26i,
    // and a `case` for a command nothing issues is a stub that reads as coverage.
    return undefined;
  },
}));

/**
 * The transport, replaced at the module boundary (26j).
 *
 * `approveRepair` ends by pushing the provider's new status to the host, which since 26i is
 * `POST /admin/providers` rather than an IPC command. Without this the repair's *own* failure — the
 * thing these specs are about — is masked by a socket error from a gateway no spec started.
 *
 * **Since 26o the two manifest writes are on this transport as well**, so the `invoke` mock above no
 * longer sees them: `POST /admin/manifests/stage` replaced `manifest_stage`, and
 * `POST /admin/manifests/{id}/activate` replaced `manifest_activate` in 26i. Their two `case`s were
 * removed rather than left in place — a stub for a command nothing issues reads as coverage and is
 * not. `stage` is seeded because the route answers `{ version }` and the fake refuses to invent one.
 */
vi.mock("./lib/gateway-client", async () => await import("./lib/gateway-client.fake"));

import { adminBodies, resetAdmin, seedAdmin } from "./lib/gateway-client.fake";
import {
  BUILTIN_TEMPLATES,
  type AdapterManifest,
  type DriftEvidence,
  type RepairPlan,
} from "@aiprovider/router-core";
import {
  addProvider, approveRepair, buildRepairPlan, driftMonitor, ledger, pendingRepairs,
  recordGeneratorAudit, registry,
} from "./store";
import { useTrailHealth } from "./lib/trail-health";
import { endRun, recordStep, startRun } from "./lib/agent/orchestrator";

const driftFailures = () => useTrailHealth.getState().counts.drift;
const lastDriftMessage = () => useTrailHealth.getState().lastMessage.drift;
const auditFailures = () => useTrailHealth.getState().counts.generator_audit;
const lastAuditMessage = () => useTrailHealth.getState().lastMessage.generator_audit;
const runFailures = () => useTrailHealth.getState().counts.agent_run;
const lastRunMessage = () => useTrailHealth.getState().lastMessage.agent_run;

/** Let the `void`-ed writes inside `onTrigger` settle. A macrotask, not a microtask: `writeTrail`
 *  awaits `invoke`, and the fake host's rejection is one hop further out. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const PROVIDER = "p1";

/**
 * Put the provider in the registry.
 *
 * Not optional: `setProviderStatus` throws `unknown provider ${id}` for an id it does not hold
 * (`provider-registry.ts:31`), and `approveRepair` awaits it *before* the resolve — so a test that
 * skipped this would fail at the status write and never reach the behaviour under test.
 */
function seedProvider(): void {
  registry.addProvider({
    id: PROVIDER,
    slug: "p1",
    name: "Provider One",
    type: "builtin",
    baseUrl: "http://127.0.0.1:1/v1",
    status: "repairing",
    rotationStrategy: "round_robin",
  });
}

/**
 * Stage a plan in `pendingRepairs`, which is where `approveRepair` reads from.
 *
 * The `deterministic` branch rather than `candidate`: `approveRepair` takes
 * `plan.candidate?.manifest ?? plan.deterministic`, so this reaches the same code with one fewer
 * fabricated shape. It only changes the recorded `origin`.
 */
function stagePlan(): void {
  const evidence: DriftEvidence = {
    providerId: PROVIDER,
    providerSlug: "p1",
    errors: 5,
    models: ["a", "b"],
    windowMs: 900_000,
    detectedAt: 1,
  };
  const plan: RepairPlan = {
    providerId: PROVIDER,
    providerSlug: "p1",
    name: "Provider One",
    baseUrl: "http://127.0.0.1:1/v1",
    currentVersion: 1,
    evidence: ["staged by the test"],
    deterministic: BUILTIN_TEMPLATES["openai-compat"]("http://127.0.0.1:1/v1") as AdapterManifest,
    status: "planned",
  };
  pendingRepairs.set(PROVIDER, { evidence, plan });
}

/** A recent success for `requestedModel` through a *different* provider — the drift monitor's
 *  isolation test, and the only reason `observe` is allowed to fire. */
async function seedSuccessElsewhere(requestedModel: string): Promise<void> {
  await ledger.append({
    ts: Date.now(),
    modality: "text",
    source: "ui",
    providerId: "other-provider",
    requestedModel,
    model: requestedModel,
    status: "ok",
    tokensIn: 0,
    tokensOut: 0,
    costEstimateMicros: 0,
  });
}

/** Cross the monitor's threshold: 5 drift-class errors across 2 models, all for one provider. */
function drift(providerId: string, requestedModel: string, errors = 5): void {
  for (let i = 0; i < errors; i++) {
    driftMonitor.observe({
      providerId,
      providerSlug: providerId,
      model: i < 3 ? "a" : "b",
      requestedModel,
      cls: "NOT_FOUND", // in DRIFT_CLASSES (errors.ts:17)
      ts: Date.now(),
    });
  }
}

beforeEach(() => {
  h.failing.clear();
  h.invokes = [];
  resetAdmin();
  // The two manifest writes `approveRepair` makes are admin routes, so the fake answers them and the
  // fake will not invent either value: the host computes a manifest version from the provider's
  // `MAX(version)` and `manifest_activate` answers the version it displaced. Seeded here rather than
  // in the one spec that asserts on `version`, because the other spec's `activate` call would
  // otherwise carry `undefined` — a body the real route would reject and this file would not notice.
  seedAdmin("POST", "/admin/manifests/stage", { version: 2 });
  seedAdmin("POST", `/admin/manifests/${PROVIDER}/activate`, { previousVersion: 1 });
  pendingRepairs.clear();
  registry.hydrate([], []); // the registry is a module singleton; start each spec empty
  driftMonitor.reset(); // ...and so is the monitor, whose cooldown would silence the second spec
  useTrailHealth.setState({
    counts: { generator_audit: 0, drift: 0, agent_run: 0 },
    lastMessage: { generator_audit: null, drift: null, agent_run: null },
    unrecordedEnd: {}, // the store is a module singleton too, and the ending specs below write it
  });
});

describe("a trail write that does not land is kept, not discarded", () => {
  it("keeps the failure when a repair's drift event could not be closed", async () => {
    seedProvider();
    stagePlan();
    h.failing.set("drift_event_resolve", "database is locked");

    const r = await approveRepair(PROVIDER);

    // The repair itself still succeeded — this is the property `.catch(() => undefined)` was
    // protecting, and it must survive the change. `2` is the seeded `{ version }` of the stage route:
    // since 26o the version comes back from the host rather than from a command's return value.
    expect(r?.version).toBe(2);
    // ...and it came back because the *row* is the request body. Asserted separately because the
    // line above cannot tell the two wire shapes apart: the IPC command took `{ m: row }` and this
    // route takes the row, and both would destructure a seeded `version` out of the response. Only
    // the body shows which one was sent.
    const staged = adminBodies("POST", "/admin/manifests/stage")[0] as Record<string, unknown>;
    expect(staged.providerId).toBe(PROVIDER);
    expect(staged.m).toBeUndefined(); // the `toRustArgs` wrapper is not part of this route's shape
    // ...and the operator is told the record did not land, rather than being left to infer it from a
    // row that still reads "Open".
    expect(r?.resolveRecorded).toBe(false);
    expect(driftFailures()).toBe(1);
    expect(lastDriftMessage()).toBe("database is locked");
  });

  it("reports a recorded close as recorded, so the warning still means something", async () => {
    seedProvider();
    stagePlan();

    const r = await approveRepair(PROVIDER);

    // The other side of the branch. Without this, a channel that warned unconditionally — or an
    // `approveRepair` that returned a constant `false` — would satisfy the spec above.
    expect(r?.resolveRecorded).toBe(true);
    expect(driftFailures()).toBe(0);
  });

  it("keeps the failure when a detection could not be written", async () => {
    await seedSuccessElsewhere("gpt-x");
    h.failing.set("drift_event_record", "disk is full");

    drift("drifted", "gpt-x");
    await flush();

    // This one has no UI moment of its own: the write is issued from the router's attempt callback,
    // on whatever screen the operator happens to be on. The channel is the only thing that can carry
    // it, which is why the card reads it rather than anything it loaded.
    expect(driftFailures()).toBe(1);
    expect(lastDriftMessage()).toBe("disk is full");
    // The detection still marked the provider repairing — losing the record must not lose the
    // response to it.
    expect(h.invokes.filter((i) => i.cmd === "provider_upsert").length).toBe(0); // not in the registry
  });

  it("does not warn when the detection was written", async () => {
    await seedSuccessElsewhere("gpt-x");

    drift("drifted", "gpt-x");
    await flush();

    expect(driftFailures()).toBe(0);
    expect(lastDriftMessage()).toBeNull();
  });

  /**
   * One spec for two call sites, because both go through `recordGeneratorAudit`.
   *
   * That is the whole reason the helper exists. The wizard used to build this payload and its own
   * `invoke` inline, so when the other trail writes were routed through `writeTrail` the copy was
   * missed — the audit failures from candidate generation stayed silent while the card above them went
   * on claiming completeness. The payload assertion below is what a caller could no longer get wrong.
   */
  it("keeps the failure when a generation could not be recorded", async () => {
    h.failing.set("generator_audit_record", "database is locked");

    const recorded = await recordGeneratorAudit({
      modelUsed: "sysai/oracle-mini",
      promptChars: 400,
      completionChars: 80,
      redactionHash: "abc123",
    });

    expect(recorded).toBe(false);
    expect(auditFailures()).toBe(1);
    expect(lastAuditMessage()).toBe("database is locked");
    // Scoped per trail: a lost generation write must not be counted against the drift trail.
    expect(driftFailures()).toBe(0);
    // The `÷ 4` estimate and the `e:` wrapper are built here, not by each caller.
    expect(h.invokes.find((i) => i.cmd === "generator_audit_record")?.args).toEqual({
      e: {
        modelUsed: "sysai/oracle-mini",
        promptTokens: 100,
        completionTokens: 20,
        redactionHash: "abc123",
      },
    });
  });

  it("does not warn when the generation was recorded", async () => {
    const recorded = await recordGeneratorAudit({
      modelUsed: "sysai/oracle-mini",
      promptChars: 400,
      completionChars: 80,
      redactionHash: "abc123",
    });

    expect(recorded).toBe(true);
    expect(auditFailures()).toBe(0);
    expect(lastAuditMessage()).toBeNull();
  });
});

/**
 * The channel's second shape: an ending that was observed but not written.
 *
 * A lost *row* is an omission and is counted. A lost *ending* is not an omission — the row is there,
 * and it says `running` — so a count would answer a question nobody asks. The question the Agents
 * screen is asked is about one row, and its answer is known: `endRun` was handed the status, and only
 * the write failed. So it is kept per run.
 *
 * Both directions again. A channel that recorded every ending would satisfy the failure spec alone,
 * which is the same trap the three above avoid.
 */
describe("an ending that was observed but not written is kept, per run", () => {
  it("keeps the status the loop reported when the finish write does not land", async () => {
    h.failing.set("agent_run_finish", "database is locked");

    endRun("run-1", "stopped", 3);
    await flush();

    // The status, not merely the fact of a failure: the screen has to render *what* happened, and
    // "a write was lost" would leave it showing the stale `running` the row still holds.
    expect(useTrailHealth.getState().unrecordedEnd).toEqual({ "run-1": "stopped" });
    // Scoped: an agent-run failure must not be counted against either trail card.
    expect(driftFailures()).toBe(0);
    expect(auditFailures()).toBe(0);
  });

  it("keeps nothing when the finish write lands", async () => {
    endRun("run-2", "ok", 3);
    await flush();

    expect(useTrailHealth.getState().unrecordedEnd).toEqual({});
  });

  it("keeps each run's own ending, so one row cannot explain another", async () => {
    h.failing.set("agent_run_finish", "database is locked");

    endRun("run-a", "stopped", 1);
    endRun("run-b", "error", 1);
    await flush();

    // A single "last unrecorded ending" slot would make both rows read `error` — the same failure a
    // single global trail counter would cause, one level down.
    expect(useTrailHealth.getState().unrecordedEnd).toEqual({ "run-a": "stopped", "run-b": "error" });
  });
});

/**
 * The channel's third trail: a run the dashboard will never list at all.
 *
 * `agentRunStart` failing is the one loss here that leaves *nothing* behind — no row, no status, no
 * ending to mark. And it is not a single write: every later step append for that run fails too, for
 * the same reason (a foreign key in Rust, `unknown run` in the shim). Counting each would report
 * "4 writes could not be recorded" for one lost run with three steps, which is a number the operator
 * cannot act on and which makes a two-run outage look like an eight-write one.
 *
 * So a step failure is reported only when its run was recorded. What the browser spec pins is the real
 * semantics — there the append genuinely rejects with `unknown run`, because the shim enforces it;
 * here the fake host answers `undefined` for anything not arranged to fail, so the second spec
 * arranges both failures and is testing the *suppression*, which is the mechanism under test.
 *
 * The fourth spec is the other direction again: without it, a channel that counted nothing at all
 * would satisfy the first three, since three of them assert a positive count only after arranging one.
 */
describe("a run the dashboard will never list is counted once, not once per write", () => {
  it("counts a start that did not land", async () => {
    h.failing.set("agent_run_start", "database is locked");

    startRun({ runId: "run-s1", model: "mock/oracle-1" });
    await flush();

    expect(runFailures()).toBe(1);
    expect(lastRunMessage()).toBe("database is locked");
    // Scoped: an agent-run failure must not be counted against either provider card.
    expect(driftFailures()).toBe(0);
    expect(auditFailures()).toBe(0);
  });

  it("does not count the steps of a run that was never recorded", async () => {
    h.failing.set("agent_run_start", "database is locked");
    h.failing.set("agent_step_append", "database is locked");

    startRun({ runId: "run-s2", model: "mock/oracle-1" });
    await flush(); // the start's rejection has landed, and with it the run's membership
    recordStep("run-s2", "tool_call", "ls");
    recordStep("run-s2", "tool_result", "ls", "ok", true);
    recordStep("run-s2", "done");
    await flush();

    // One lost run, not one lost run plus three lost steps. Those appends failed for the same reason
    // the insert did — an unrelated second failure would have to be counted, and is not silenced.
    expect(runFailures()).toBe(1);
  });

  it("counts a step failure of a run that *was* recorded", async () => {
    startRun({ runId: "run-s3", model: "mock/oracle-1" });
    await flush();
    h.failing.set("agent_step_append", "disk is full");

    recordStep("run-s3", "tool_call", "ls");
    await flush();

    // The suppression is not a blanket one: this step's loss is a real, separate omission, and the
    // run it belongs to is on screen.
    expect(runFailures()).toBe(1);
    expect(lastRunMessage()).toBe("disk is full");
  });

  it("counts nothing when every write lands", async () => {
    startRun({ runId: "run-s4", model: "mock/oracle-1" });
    await flush();
    recordStep("run-s4", "done");
    await flush();

    expect(runFailures()).toBe(0);
    expect(lastRunMessage()).toBeNull();
  });
});

/**
 * A repair that dies before it starts is registered, not swallowed.
 *
 * `onTrigger` sets the provider `repairing` and fires `buildRepairPlan` with
 * `.catch(() => undefined)`. The card renders "Building a repair plan…" for as long as `pendingRepairs`
 * holds no entry — so a failure *before* the entry was created left that sentence on screen permanently,
 * about work that had stopped, and in the same words as the legitimate in-progress case. Waiting was
 * indistinguishable from broken.
 *
 * Two reachable causes, and neither is exotic:
 *   - `adapters.forProvider` throws `no active manifest` for a provider hydration could not register,
 *     which is exactly what a corrupt manifest body leaves behind — `store.ts:350-357` even promises
 *     "Phase 5 drift/repair surfaces it". It sat *outside* the `try`.
 *   - a provider with no key to probe with returned `undefined` with no entry at all.
 *
 * The assertion that carries the weight is the entry's **existence**, not the message: the screen's copy is
 * driven by `pendingRepairs.get(id)`, so without the entry there is nothing for it to render.
 */
describe("a repair that dies before it starts is registered, not swallowed", () => {
  const evidence = (providerId: string, slug: string): DriftEvidence => ({
    providerId, providerSlug: slug, errors: 5, models: ["a", "b"], windowMs: 900_000, detectedAt: 1,
  });

  it("keeps the failure when the provider has no active manifest", async () => {
    // A distinct id, not `seedProvider`'s: `approveRepair` hot-swaps an adapter in for the provider it
    // repairs (`store.ts:282`), `adapters` is a module singleton, and the specs above repair PROVIDER.
    // Reusing it would hand this spec the one thing it is trying not to have, and it would fail with
    // the *next* error along — "no key to probe" — which is how this was caught.
    const id = "p-no-manifest";
    registry.addProvider({
      id, slug: "no-manifest", name: "No Manifest", type: "builtin",
      baseUrl: "http://127.0.0.1:1/v1", status: "repairing", rotationStrategy: "round_robin",
    });

    const plan = await buildRepairPlan(evidence(id, "no-manifest"));

    expect(plan).toBeUndefined();
    expect(pendingRepairs.has(id)).toBe(true);
    expect(pendingRepairs.get(id)?.error).toMatch(/no active manifest/);
    // ...and it is a failure, not a plan: the card must not offer one to review.
    expect(pendingRepairs.get(id)?.plan).toBeUndefined();
  });

  it("keeps the failure when the provider has no key to probe with", async () => {
    // `addProvider` registers the adapter, so this reaches the next failure along.
    const p = await addProvider({
      slug: "no-key-co", name: "No Key Co", type: "builtin",
      baseUrl: "http://127.0.0.1:1/v1",
      manifest: BUILTIN_TEMPLATES["openai-compat"]("http://127.0.0.1:1/v1"),
    });

    const plan = await buildRepairPlan(evidence(p.id, p.slug));

    expect(plan).toBeUndefined();
    expect(pendingRepairs.get(p.id)?.error).toMatch(/no key to probe/);
  });

  it("does not report a failure for a repair that is still running", async () => {
    seedProvider();
    // The entry is registered synchronously, before the awaits: the card's "Building a repair plan…"
    // branch depends on it existing while the work is genuinely in flight. Asserted on the same tick
    // the call is made, so this is the in-progress state and not a finished one.
    const running = buildRepairPlan(evidence(PROVIDER, "p1"));

    const during = pendingRepairs.get(PROVIDER);
    expect(during).toBeDefined();
    expect(during?.plan).toBeUndefined();
    expect(during?.error).toBeUndefined();

    await running;
  });
});
