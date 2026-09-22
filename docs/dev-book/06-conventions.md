# 06 — Conventions

**These are not preferences.** Each one was paid for by a bug, and the "why" is the part that matters — a rule
without its reason gets relaxed by the next person who finds it inconvenient.

`CONTRIBUTING.md` carries the six highest-value ones for contributors. This chapter is the complete set.

## State, configuration and caching

**`settings_set` is a whole-row UPSERT.** Writing only the keys you know about **erases every other key in the
row**. `patchGatewaySettings` merges, and it is spec'd against the *stored row* rather than the intended one.
Before writing settings, read the row.

**A cache needs an authority, not just a TTL.** A TTL bounds staleness but does not make an invalidation
possible. Ask whether the mutation sites can actually reach the cache before adding one; if they cannot, a
correct-looking cache will serve stale data for its whole lifetime.

**Clamp from numbers and numeric strings only, and never pre-parse before clamping.** `Number("")` is `0`, and
for the per-provider cap `0` means **unlimited** — so an empty input field would silently remove the cap. Pass
the raw string into the clamp.

**`memory_enabled` is in-memory only and is off after a restart.** `Disabled` outranks `WriteOnly`, so a
post-reinstall `aip-memory: write` request reports `reason=disabled`. Check the Memory screen, not HTTP.

**A debounced save reads state when it fires, not when it is scheduled.** Anything computed at scheduling time
is stale by the time the write happens.

## Rust

**`panic = "abort"`, so there is no poison handling.** A panic takes the process down; do not write code that
assumes a mutex can be recovered.

**Parallel tests must not derive a temp directory from `pid + timestamp`.** Two tests in the same millisecond
collide and one fails with `DatabaseBusy`, which looks like a locking bug in the code under test. Use a
monotonic `AtomicUsize`.

**A `#[tauri::command]` argument and a serde field are different boundaries.** Only *nested* payloads go through
serde, and serde ignores unknown keys by default — so an unknown key in a nested payload fails silently rather
than loudly. Every nested payload gets `deny_unknown_fields`. Note that `shim.ts::toRustArgs` renames top-level
keys only.

**Every new `#[tauri::command]` needs a `web-test/shim.ts` case the same day.** The shim throws on unknown
commands, the screens swallow the error, and the screen goes blank with no message — a failure mode that looks
like a rendering bug and is not one.

**Never match a node on its label.** Labels are truncated to 80 characters, so two distinct nodes can share one.
Pass the identity the thing already has.

**A database-lifetime-unique ID must not come from a per-process counter.** `next_id` restarts at 1 on every
launch. IDs carry a boot marker.

## TypeScript and React

**Overlapping reads need a generation counter.** StrictMode double-fires mount effects in Vite dev, so two reads
can be in flight and resolve out of order. Only the newest may write.

**A switch rendered in two places drifts.** Control owns cross-cutting switches — **move them, do not mirror
them**. The one deliberate exception is the memory master switch, which stays on the Memory screen by decision.

**A switch's accessible name must not change with its state.** Put the state in `aria-checked` and give the
state its own element; otherwise every test and every screen reader has to guess which label is current.

**A tool failure must never reach the model as an empty string.** Guard at the bridge *and* at the consumer, and
clear the data on failure. A stale value sitting under an error message claims to be *now*.

## Testing

**`vitest` does not typecheck.** `expect(x).toBe(true, "msg")` is not a valid assertion — the message is the
second argument of `expect`, so it is `expect(x, "msg").toBe(true)`. Run the gate, not just `vitest`.

**Assert JSON and SSE by parsing, never by substring.** `serde_json` writes keys sorted, so
`{"index":0,"type":…}` may arrive as `{"index":0,"type":…}` today and in another order tomorrow. A substring
test binds to key order and **silently tests nothing**.

**Two fixes for one property mask each other.** If you fix two things at once and the test passes, you have
learned nothing about which fix was load-bearing. Test the inner function directly with adversarial input;
select by content rather than index; never assert a collection's length as a proxy for its contents.

**`__webTest.failNext(cmd, msg, afterMs?)` is how you reach a UI `catch`.** But **an immediate failure cannot
test supersession** — defer it with `afterMs` and then outlive it before asserting, or the assertion runs before
the second read resolves.

**A negative assertion on an auto-dismissing surface can never fail.** By the time it runs, the thing is gone
either way.

**`getByText` matching two elements is a duplicated fact on screen**, not a bad selector. Scope to the container
rather than adding a third selector. And a readiness wait must match something **only** the awaited view
renders — otherwise the wrong copy satisfies it and the test passes before the view exists.

**Probe headers are lowercase.** `h.get("Retry-After")` is always `None`. Dump the headers before claiming a
header is absent.

## Observability

**A swallowed write is invisible to every reader.** Trail writes swallow errors on purpose so a logging failure
cannot break a request — which means a lost write leaves no trace anywhere. Use the one `writeTrail` helper, and
give each trail its **own channel**. There are four known loss shapes; see `REFERENCE.md` §Trail health.

## Repository hygiene

**This repository is public.** `pnpm key-leak-grep` is a gate step, and every fixture must be synthetic. Never
commit a real key, token or hostname.

**Docs live in `docs/`.** The root holds only `README`, `CHANGELOG`, `CONTRIBUTING`, `SECURITY` and `LICENSE`,
plus the two overview artefacts the tooling writes there. Older memory files cite docs by bare filename — resolve
those under `docs/`.

**One edit per file per batch.** A second edit to the same file lands on a stale snapshot and clobbers the
first, and **both report success**.

## Commits

`type(scope): what changed`, with a body that explains **why** rather than restating the diff. Keep unrelated
changes separate — in particular, a mechanical reformat belongs in its own commit, because it destroys `git
blame` for zero behavioural change.

## Next

[07 Drift register](07-drift-register.md) — what to update when you change one of these.
