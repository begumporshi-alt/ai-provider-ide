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
 * Playground: pick the model whose option text matches `model`, send `prompt`, and wait for the
 * streamed assistant text matching `answer`. Returns the full answer (newlines preserved).
 */
async function sendInPlayground(page: Page, model: RegExp, prompt: string, answer: RegExp): Promise<string> {
  await page.getByRole("button", { name: "Playground" }).click();
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
  const answer = await sendInPlayground(page, /oracle-mini/, "Hello", /Hello from oracle-mini/);
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
  const answer = await sendInPlayground(page, /nd-lite/, "Hello", /nd-lite/);
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

  await page.getByRole("button", { name: "Playground" }).click();
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
