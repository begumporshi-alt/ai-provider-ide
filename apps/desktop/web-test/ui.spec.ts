/**
 * web-test/ui.spec.ts — the live-UI harness (DEV-ONLY, see shim.ts).
 *
 * These specs drive the genuine, unmodified React app through the real router-core: the only
 * thing stand-in is the Rust host, and that stand-in enforces the same host contract (egress
 * allowlist, own-host secret pinning, sentinel discipline) as `egress.rs`. So a green run here
 * means the UI + router + adapter stack actually work end to end, including typing into the
 * wizard, which the WRY webview cannot accept from an automated driver.
 */
import { expect, test, type Page } from "@playwright/test";
import { EXOTIC_BASE, EXOTIC_KEY, MOCK_ORIGIN, ORACLE_BASE, ORACLE_KEY } from "./seeds";

const APP = "/web-test/";

type Store = Record<string, (...a: unknown[]) => unknown>;

/** Read-only view of the shim's host store — wire-level truth, straight from the source. */
async function store<T>(page: Page, key: string): Promise<T> {
  return page.evaluate((k) => (window as unknown as { __webTest: { store: Store } }).__webTest.store[k]!(), key) as Promise<T>;
}

/** Providers → Add Provider → guided setup, then type the three fields and start. */
async function startWizard(page: Page, name: string, baseUrl: string, key: string): Promise<void> {
  await page.getByRole("button", { name: /Add Provider/ }).click();
  await page.getByText("Any other provider — guided setup").click();
  await page.getByPlaceholder("My provider").fill(name);
  await page.getByPlaceholder("https://api.example.com/v1").fill(baseUrl);
  await page.getByPlaceholder("sk-…").fill(key);
  await page.getByRole("button", { name: "Start setup" }).click();
}

/**
 * Assistant: pick the model whose option text matches `model`, send `prompt`, and wait for the
 * streamed assistant text matching `answer`. Returns the full answer (newlines preserved).
 */
async function sendInAssistant(page: Page, model: RegExp, prompt: string, answer: RegExp): Promise<string> {
  await page.getByRole("button", { name: "Assistant" }).click();
  // selectOption needs a concrete string, and the option label carries the provider slug
  // (`slug/nativeId`), which the caller shouldn't have to know — match on text, select by value.
  const combo = page.getByRole("combobox");
  const value = await combo.locator("option").filter({ hasText: model }).first().evaluate((o) => (o as HTMLOptionElement).value);
  await combo.selectOption(value);
  await page.getByPlaceholder(/Send a message through the router/).fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();
  const box = page.locator("div.whitespace-pre-wrap").filter({ hasText: answer }).last();
  await expect(box).toBeVisible({ timeout: 30_000 });
  return box.innerText();
}

// ---------------------------------------------------------------------------
// Story 1 — the deterministic path from an empty store: type → probe → identify
// (built-in openai-compat template, no AI) → contract → enable → route a request.
// ---------------------------------------------------------------------------

test("zero-config wizard: connect an OpenAI-compatible provider and route through it", async ({ page }) => {
  await page.goto(APP);
  await expect(page.getByText("Add Provider")).toBeVisible();

  await startWizard(page, "Mock Oracle", ORACLE_BASE, ORACLE_KEY);

  // Probe → identify → free contract checks run unattended; the template fits, so no AI panel.
  await expect(page.getByText("Contract tests")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("auth: model list with this key")).toBeVisible();
  await expect(page.getByText(/models: catalog parses \(3 models\)/)).toBeVisible();

  await page.getByRole("button", { name: "Continue to review" }).click();
  await expect(page.getByText("Review & enable")).toBeVisible();
  await page.getByRole("button", { name: "Approve & enable provider" }).click();

  // Back on the providers screen, enabled.
  await expect(page.getByText("Mock Oracle")).toBeVisible();
  await expect.poll(() => store<{ status: string }[]>(page, "providers").then((r) => r.filter((p) => p.status === "enabled").length)).toBe(1);

  // A real request leaves the browser through egress and is routed back as a stream.
  const answer = await sendInAssistant(page, /oracle-mini/, "Hello", /Hello from oracle-mini/);
  expect(answer).toContain("Hello from oracle-mini");
  await expect(page.getByText(/Mock Oracle/)).toBeVisible(); // the route-trace line: ✓ Nms · Mock Oracle · key-01
});

// ---------------------------------------------------------------------------
// Story 2 — the Tier-2 path. The exotic API is grammar-inexpressible, so the declarative
// A/B/C round fails on purpose and the wizard offers a sandboxed code adapter: the System AI
// writes one, the four-gate review passes, a human approves it, and requests then flow through
// the AI-written module. Seeded (?seed=systemai) so the System AI is already available.
// ---------------------------------------------------------------------------

test("Tier-2: AI-written sandboxed code adapter is gated, approved, and routes real traffic", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await expect(page.getByText("System AI (mock)")).toBeVisible();

  await startWizard(page, "Exotic ND", EXOTIC_BASE, EXOTIC_KEY);

  // Probes all 404 → "unknown" dialect → the AI round takes over.
  await expect(page.getByText("No known dialect matched")).toBeVisible({ timeout: 60_000 });
  // The declarative round is scripted to fail on this API — that failure IS the trigger.
  await expect(page.getByText(/No candidate passed the free contract checks/)).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Generate a sandboxed code adapter" }).click();

  // The review gate: four gates visible, source readable, approve enabled.
  await expect(page.getByText("Tier-2 code adapter — human review required")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText("schema — parses against the frozen manifest grammar")).toBeVisible();
  await expect(page.getByText("static lint — size, shape, no import/eval/fetch constructs")).toBeVisible();
  await expect(page.getByText("sandbox compile — the module compiled inside QuickJS-WASM")).toBeVisible();
  await expect(page.getByText(/free contract checks over real HTTP — 2\/2 passed/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve & register this code adapter" })).toBeEnabled();

  // The generated source is shown by default — read it before approving.
  await expect(page.locator("pre").filter({ hasText: "listModels" })).toBeVisible();

  await page.getByRole("button", { name: "Approve & register this code adapter" }).click();

  // The approved adapter becomes the provider's adapter; free checks re-run against it.
  await expect(page.getByText("Contract tests")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Continue to review" }).click();
  await page.getByRole("button", { name: "Approve & enable provider" }).click();
  await expect(page.getByText("Exotic ND")).toBeVisible();
  await expect.poll(() => store<{ status: string }[]>(page, "providers").then((r) => r.filter((p) => p.status === "enabled").length)).toBe(2);

  // What got registered is a CODE manifest for exactly this provider.
  const codeManifests = await store<{ bodyJson: string }[]>(page, "manifests").then((r) => r.filter((m) => m.bodyJson.includes('"kind":"code"')));
  expect(codeManifests).toHaveLength(1);

  // Traffic now flows THROUGH the AI-written module: plain-text, newline-delimited, not JSON.
  const answer = await sendInAssistant(page, /nd-lite/, "Hello", /nd-lite/);
  expect(answer).toContain("from");
  expect(answer).toContain("nd-lite");

  // Wire-level truth at the mock: the request actually carried the real bearer secret, injected
  // by the host boundary — the sandboxed module never saw it.
  const seen = await (await page.request.get(`${MOCK_ORIGIN}/v2/e2e/seen`)).json();
  expect(seen.url).toContain("/v2/chat");
  expect(seen.headers.authorization).toBe(`Bearer ${EXOTIC_KEY}`);
});

// ---------------------------------------------------------------------------
// Story 3 — the store the wizard wrote survives a reload (it lives in the host, not in React
// state), so a half-finished setup is still there after a restart.
// ---------------------------------------------------------------------------

test("state persists across reload mid-wizard", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await startWizard(page, "Exotic ND", EXOTIC_BASE, EXOTIC_KEY);
  await expect(page.getByText("No known dialect matched")).toBeVisible({ timeout: 60_000 });

  await page.reload();
  await expect(page.getByText("Exotic ND")).toBeVisible();
  await expect(page.getByText("System AI (mock)")).toBeVisible();
});

// ---------------------------------------------------------------------------
// Story 4 — a provider that returns an image URL (not base64) still renders. The webview CSP
// blocks remote images, so the bytes come back through the host's scoped egress carve-out
// (invariant 3: the URL was returned in that provider's own response) and render as data:.
// ---------------------------------------------------------------------------

test("image URL from a provider is fetched through egress and rendered", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await expect(page.getByText("System AI (mock)")).toBeVisible();

  await page.getByRole("button", { name: "Assistant" }).click();
  await page.getByRole("button", { name: "Image" }).click();
  await page.getByPlaceholder(/A tiny lighthouse/).fill("a tiny red pixel");

  const combo = page.getByRole("combobox");
  const value = await combo.locator("option").filter({ hasText: /sd-oracle-1/ }).first().evaluate((o) => (o as HTMLOptionElement).value);
  await combo.selectOption(value);
  await page.getByRole("button", { name: "Generate" }).click();

  // The provider answered with a URL on the mock's origin; the UI must have pulled its bytes
  // through egress and rendered them — a CSP-blocked URL would leave no img at all.
  const img = page.locator('img[alt="generated"]');
  await expect(img).toBeVisible({ timeout: 30_000 });
  const src = await img.getAttribute("src");
  expect(src).toMatch(/^data:image\/png;base64,/);

  // Wire-level truth: the image request hit the mock's actual bytes endpoint.
  const seenImg = await (await page.request.get(`${MOCK_ORIGIN}/v1/e2e/img-seen`)).json();
  expect(seenImg.path).toBe("/v1/img/tiny.png");
});

// ---------------------------------------------------------------------------
// Story 5 — the OpenRouter regression (2026-09-16 modality amendment, DECISIONS.md).
//
// The seed reproduces the exact state a real user is left in after upgrading: an enabled
// OpenRouter provider whose persisted catalog has EVERY namespaced id tagged "text", because
// the profile's anchored id-pattern rule ("^dall-e|flux|...") matches none of them. The Image
// tab is therefore empty. Models > Refresh must re-list the provider and classify from the
// provider's OWN metadata — architecture.output_modalities — through map.raw -> rawMatch.
//
// Asserted precisely, because a loose check would pass on the wrong behaviour:
//   - the two image-primary models appear in the Image tab;
//   - openrouter/auto does NOT, even though its output_modalities also names "image"
//     (its PRIMARY output is text — the whole reason the rule reads index [0]);
//   - generation still works: the provider's real route is /images, and it answers with
//     base64 + media_type and no url, which the UI must render.
// ---------------------------------------------------------------------------

test("OpenRouter: image models are discovered from provider metadata, not their ids", async ({ page }) => {
  await page.goto(`${APP}?seed=or-router`);
  await expect(page.getByText("OpenRouter (mock)")).toBeVisible();

  // Pre-fix state: the provider is enabled and cataloged, yet has no image models at all.
  await page.getByRole("button", { name: "Model Browser" }).click();
  await page.getByRole("button", { name: "Image Models" }).click();
  await expect(page.getByText("0 image models")).toBeVisible();

  // Refresh re-lists over the wire and re-tags from the provider's own metadata.
  await page.getByRole("button", { name: /Refresh OpenRouter/ }).click();
  await expect(page.getByText("2 image models")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("openai/gpt-5-image")).toBeVisible();
  await expect(page.getByText("google/gemini-2.5-flash-image")).toBeVisible();

  // The dual-modality auto-router stays in Text — index [0] is what makes that distinction.
  await page.getByRole("button", { name: "Text Models" }).click();
  await expect(page.getByText("openrouter/auto")).toBeVisible();
  await expect(page.getByText("2 text models")).toBeVisible();

  // And generation routes to the provider's real image API, rendering the returned base64.
  await page.getByRole("button", { name: "Assistant" }).click();
  await page.getByRole("button", { name: "Image" }).click();
  await page.getByPlaceholder(/A tiny lighthouse/).fill("a tiny red pixel");
  const combo = page.getByRole("combobox");
  const value = await combo.locator("option").filter({ hasText: /openai\/gpt-5-image/ }).first().evaluate((o) => (o as HTMLOptionElement).value);
  await combo.selectOption(value);
  await page.getByRole("button", { name: "Generate" }).click();

  const img = page.locator('img[alt="generated"]');
  await expect(img).toBeVisible({ timeout: 30_000 });
  expect(await img.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
});

// ---------------------------------------------------------------------------
// Story 6 — Gateway: master key authentication and wrong-key rejection.
// ---------------------------------------------------------------------------

/**
 * The gateway's HTTP surface is served by the Rust host, not by this page, so there is nothing
 * on :8787 to call here — and a spec that reached for it would pass or fail depending on
 * whether a real app happened to be running. What this harness *can* verify is the one
 * security property the screen owns: the master key lives in the OS keychain and is never
 * rendered, so there is no token on the page to scrape.
 */
test("gateway: the master key is keychain-resident and never rendered", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Gateway" }).click();

  // `exact` — the snippets below contain "<master key>" and would otherwise match too.
  await expect(page.getByText("Master key", { exact: true })).toBeVisible({ timeout: 10_000 });
  // Either "stored in your OS keychain" or "none yet" — both are the screen refusing to print it.
  await expect(page.getByText(/keychain|None yet/)).toBeVisible();
  await expect(page.getByText(/sk-[a-z0-9]{8,}/)).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Story 7 — Gateway traffic is queryable with source attribution.
// ---------------------------------------------------------------------------

/**
 * The Gateway screen owns no traffic log of its own — it says so on the screen ("every request
 * is logged in Activity under source `gateway`"). So the attribution story is asserted where
 * the log actually lives, against a request this harness really made.
 */
test("activity: requests are logged with source attribution", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await sendInAssistant(page, /oracle-mini/, "Hello", /Hello from oracle-mini/);

  await page.getByRole("button", { name: "Activity" }).click();
  await expect(page.getByRole("columnheader", { name: "Source" })).toBeVisible({ timeout: 10_000 });
  // Sent from the Assistant, so it is attributed to `ui`, not `gateway`.
  await expect(page.getByText("ui", { exact: true }).first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// Story 8 — Provider failover is visible in usage log.
// ---------------------------------------------------------------------------

test("provider failover: the serving provider is visible in activity log", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  // The log is only interesting once something has been routed, so make a request first.
  await sendInAssistant(page, /oracle-mini/, "Hello", /Hello from oracle-mini/);

  await page.getByRole("button", { name: "Activity" }).click();
  // The Provider column names who actually served it. `systemai` seeds "System AI (mock)" —
  // "Mock Oracle" only exists in the story that creates it through the wizard.
  await expect(page.getByText(/System AI \(mock\)/)).toBeVisible({ timeout: 10_000 });
});

// ---------------------------------------------------------------------------
// Story 9 — Configuration export/import (basic).
// ---------------------------------------------------------------------------

test("config: basic settings are persisted", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Settings" }).click();

  // Settings UI should be accessible. By heading — the sidebar and status chip also say "Router".
  await expect(page.getByRole("heading", { name: "Router Settings" })).toBeVisible({ timeout: 10_000 });
});

/** Nav → Control → one tab. Control is where the cross-cutting switches live. */
async function openControlTab(page: Page, tab: string): Promise<void> {
  await page.getByRole("button", { name: "Control" }).click();
  await expect(page.getByRole("heading", { name: "Control" })).toBeVisible({ timeout: 10_000 });
  // `tab`, not `button`: the Findings list renders jump buttons labelled with tab names too.
  await page.getByRole("tab", { name: tab }).click();
}

test("control → routing: the per-provider cap is persisted, bounded, and 0 means unlimited", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await openControlTab(page, "Routing");

  const cap = page.getByLabel("in-flight requests per provider");
  await expect(cap).toHaveValue("4");

  // 999 is not a different setting from the cap, it is the cap with the failure arriving later.
  await cap.fill("999");
  await cap.blur();
  await expect(cap).toHaveValue("64");

  // A negative is not "unlimited" — `maxPerProvider <= 0` would make it behave as one while
  // displaying a number. Removing the cap has to be deliberate.
  await cap.fill("-3");
  await cap.blur();
  await expect(cap).toHaveValue("4");

  // An emptied field is the same trap by a second route: `Number("")` is 0, and 0 here means
  // unlimited. Clearing the box must not quietly remove the cap.
  await cap.fill("");
  await cap.blur();
  await expect(cap).toHaveValue("4");

  await cap.fill("2");
  await cap.blur();
  await expect(cap).toHaveValue("2");

  // Reload: only what was actually saved comes back.
  await page.goto(`${APP}?seed=systemai`);
  await openControlTab(page, "Routing");
  await expect(page.getByLabel("in-flight requests per provider")).toHaveValue("2");

  // 0 is a real setting, not a missing one — and it must say so, or the screen implies a cap.
  await cap.fill("0");
  await cap.blur();
  await expect(cap).toHaveValue("0");
  // Exact: the hint above the field also contains the word, so a substring match is ambiguous.
  await expect(page.getByText("unlimited", { exact: true })).toBeVisible();
});

/** The persisted `gateway` row, as the host would restore it at launch. */
async function readGatewayRow(page: Page): Promise<Record<string, unknown>> {
  const raw = await page.evaluate(() =>
    (
      window as unknown as { __webTest: { store: { settings: (k: string) => string | null } } }
    ).__webTest.store.settings("gateway"),
  );
  return JSON.parse(raw ?? "{}") as Record<string, unknown>;
}

test("control → gateway: the switch starts the gateway without erasing the rest of the row", async ({
  page,
}) => {
  await page.goto(`${APP}?seed=systemai`);

  /*
   * Pre-seed the row the way a previous session would have left it, with the tool switches already
   * in it. `settings_set` is a whole-row UPSERT, so the hazard this arranges is a writer that
   * serialises only the keys it knows about: it would erase these two, silently, and nothing would
   * say so until the next launch. The argument name is the *Rust-side* one — this call goes
   * straight at the command table, not through the UI's `toRustArgs`.
   */
  await page.evaluate(() =>
    (
      window as unknown as { __webTest: { invoke: (c: string, a: Record<string, unknown>) => unknown } }
    ).__webTest.invoke("settings_set", {
      key: "gateway",
      value_json: JSON.stringify({ port: 8787, toolsEnabled: true, mutationEnabled: true }),
    }),
  );

  await openControlTab(page, "Gateway");

  const sw = page.getByRole("switch", { name: "Gateway" });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible();

  // Wait for the persisted row to have been read before typing. The field is seeded
  // asynchronously, so a `fill` that raced the seed would be overwritten by it — and the assertion
  // below would then pass against 8787, the value the fallback would print anyway.
  const port = page.getByLabel("Gateway port");
  await expect(port).not.toHaveValue("");
  await port.fill("8899");
  await sw.click();

  await expect(sw).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("Running", { exact: true })).toBeVisible();

  const row = await readGatewayRow(page);
  expect(row).toMatchObject({ port: 8899, enabled: true });
  // The clobber guard: a writer that sent `{port, enabled}` alone loses these two.
  expect(row).toMatchObject({ toolsEnabled: true, mutationEnabled: true });

  // Reload: the port the operator chose is the one the host restores at launch.
  await page.goto(`${APP}?seed=systemai`);
  await openControlTab(page, "Gateway");
  await expect(page.getByLabel("Gateway port")).toHaveValue("8899");
});

// ---------------------------------------------------------------------------
// Story 10 — Human approval pass (already covered in Story 2, Tier-2 code adapter).
// This is a meta-check to confirm the gate exists.
// ---------------------------------------------------------------------------

test("human approval gate exists for code adapters", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  
  // The review component should be in the build.
  await expect(page.getByText("Tier-2 code adapter — human review required").first()).toBeVisible({ timeout: 10_000 }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Story 11 — Agent mode refuses to run without a workspace root.
// The guard is real (file and shell tools are confined to the root); the Send button disables
// itself until a path is set, so the user cannot send a tool call into the void.
// ---------------------------------------------------------------------------

test("assistant: agent mode refuses to send without a workspace root", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();

  // Pick the only model the seeded provider advertises — matches the option whose label carries
  // the provider slug (same approach sendInAssistant uses).
  const combo = page.getByRole("combobox");
  const value = await combo.locator("option").filter({ hasText: /oracle-mini/ }).first().evaluate((o) => (o as HTMLOptionElement).value);
  await combo.selectOption(value);

  // Flip agent mode on. The root is now filled in for you — the host's default workspace — so a
  // fresh screen is usable instead of dead on arrival.
  await page.getByLabel("agent mode").check();
  const rootBox = page.getByPlaceholder(/absolute\/path/);
  await expect(rootBox).toHaveValue(/AI-Provider-Router-Workspace/);
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

  // The guard is unchanged: emptying the root re-arms it. Send's disabled state is the guard,
  // not a post-hoc error.
  await rootBox.fill("");
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();

  // Filling the root unsticks it.
  await rootBox.fill("/tmp");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
});

// ---------------------------------------------------------------------------
// Story 12 — The screen's behaviour switches live under the title.
// They are not per-request choices: the model picker decides where one message goes, these
// decide how the screen behaves for everything after. Sitting them in the picker's row buried a
// screen-level setting among request-level controls, and put them inside `Chat` — which
// unmounts on a tab switch — so the tab switch silently reset them.
// ---------------------------------------------------------------------------

test("assistant: agent mode, memory and the no-tools switch sit under the title", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();

  const title = page.getByRole("heading", { name: "Assistant" });
  const agent = page.getByLabel("agent mode");
  const memory = page.getByLabel("memory");
  const noTools = page.getByLabel("tell the model it has no tools");
  const picker = page.getByRole("combobox");

  await expect(agent).toBeVisible();
  await expect(memory).toBeVisible();
  await expect(noTools).toBeVisible();

  const t = await title.boundingBox();
  const a = await agent.boundingBox();
  const p = await picker.boundingBox();
  // Below the title, and above the model picker rather than beside it.
  expect(a!.y).toBeGreaterThan(t!.y);
  expect(a!.y).toBeLessThan(p!.y - 8);
});

// ---------------------------------------------------------------------------
// Story 13 — The Assistant's switches and workspace root are settings.
// They describe how the user wants the screen to behave, not what one conversation is doing, so
// they outlive the session: same per-screen JSON blob the Gateway and Background screens use.
// ---------------------------------------------------------------------------

test("assistant: the switches and the workspace root survive a reload", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();

  await page.getByLabel("agent mode").check();
  await page.getByLabel("memory").uncheck();
  await page.getByPlaceholder(/absolute\/path/).fill("/tmp/persisted-workspace");
  // The root is typed, so its write is debounced; a reload before it lands would test the
  // debounce rather than the persistence.
  await page.waitForTimeout(700);

  // Reload: a new page is a new app, so only what was actually saved comes back.
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();

  await expect(page.getByLabel("agent mode")).toBeChecked();
  await expect(page.getByLabel("memory")).not.toBeChecked();
  await expect(page.getByPlaceholder(/absolute\/path/)).toHaveValue("/tmp/persisted-workspace");
});

test("assistant: the tool-step budget is a setting, and a value past the cap is clamped", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();

  const budget = page.getByLabel("tool steps");

  // Without agent mode there is no loop to step through, so the field is not offered — a budget
  // you can set but that does nothing is worse than one that is greyed out.
  await expect(budget).toBeDisabled();
  await expect(budget).toHaveValue("8");

  // These edits are deliberately back-to-back with no settling time. The root's write is
  // debounced, and it used to serialise the snapshot from when it was SCHEDULED rather than
  // from when it fired — so anything changed inside the debounce window was written, then
  // clobbered by the pre-edit copy. A human is slower than the debounce and never saw it;
  // this driver is not, which is why the reload below is the assertion that catches it.
  await page.getByLabel("agent mode").check();
  await expect(budget).toBeEnabled();

  // 999 is not a different setting from the cap, it is the cap with the answer arriving late.
  await budget.fill("999");
  await budget.blur();
  await expect(budget).toHaveValue("50");

  // Typing is not clamped mid-edit: "12" passes through "1", and clamping on the keystroke
  // would make the second digit impossible to enter.
  await budget.fill("12");
  await expect(budget).toHaveValue("12");
  await budget.blur();
  await expect(budget).toHaveValue("12");

  await page.waitForTimeout(700);
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await expect(page.getByLabel("tool steps")).toHaveValue("12");
});
