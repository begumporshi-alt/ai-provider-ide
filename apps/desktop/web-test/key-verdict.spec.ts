/**
 * Testing a key must not punish it for the network's problems.
 *
 * `invalid` is not a label, it is an eviction: `HealthTracker.isKeyUsable` returns false for a key
 * whose status is invalid, and the catalog refresh only considers active keys — so the key leaves
 * rotation until a human re-enables it. The Test button used to write that status for *any*
 * failure, including "nothing came back at all", which meant testing a key while a provider was
 * unreachable silently disabled a key that was fine and told the operator it had been rejected.
 *
 * The shim does not stub `testKey`, so these specs drive the real `store.testKey` through the real
 * adapter. They read the registry for wire-level truth rather than trusting the notice, and the
 * provider is made to fail with `page.route` — the request still leaves the app as a genuine fetch
 * (see the shim's `egressUnary`), it just never gets an answer.
 */
import { expect, test, type Page } from "@playwright/test";

const APP = "/web-test/";
/** The oracle's model list — what `pingKey` calls (see web-test/mock.mjs). */
const ORACLE_MODELS = "**/v1/models";

type Store = Record<string, (...a: unknown[]) => unknown>;

interface KeyRow {
  id: string;
  label: string;
  status: string;
  lastTestedAt: number | null;
}

async function keys(page: Page): Promise<KeyRow[]> {
  return page.evaluate(
    () => (window as unknown as { __webTest: { store: Store } }).__webTest.store.keys!(),
  ) as Promise<KeyRow[]>;
}

/** The seeded store: one enabled provider with one active key (see seeds.ts). */
async function openProviders(page: Page): Promise<void> {
  await page.goto(`${APP}?seed=systemai`);
  // The seed lands on Providers already; the provider name is what proves it rendered.
  await expect(page.getByText("System AI (mock)")).toBeVisible();
  expect((await keys(page))[0]!.status).toBe("active");
}

test("a key that cannot be reached keeps its place in rotation", async ({ page }) => {
  await openProviders(page);

  // No HTTP response arrives, so the test proved nothing about the key.
  await page.route(ORACLE_MODELS, (r) => r.abort("failed"));
  await page.getByRole("button", { name: "Test" }).first().click();

  await expect(page.getByText(/could not verify/)).toBeVisible();

  const after = await keys(page);
  expect(after[0]!.status).toBe("active");
  // The attempt is still recorded — an inconclusive test should leave a trace, not vanish.
  expect(after[0]!.lastTestedAt).toBeGreaterThan(0);
});

test("a provider-side failure is not blamed on the key", async ({ page }) => {
  await openProviders(page);

  // 5xx is the provider failing. It says nothing about the credential.
  await page.route(ORACLE_MODELS, (r) =>
    r.fulfill({ status: 503, contentType: "text/plain", body: "upstream down" }),
  );
  await page.getByRole("button", { name: "Test" }).first().click();

  await expect(page.getByText(/could not verify/)).toBeVisible();
  expect((await keys(page))[0]!.status).toBe("active");
});

test("a key the provider actually rejects is taken out of rotation", async ({ page }) => {
  await openProviders(page);

  // The guard on the fix: a real 401 IS evidence about the credential, and must still evict.
  await page.route(ORACLE_MODELS, (r) =>
    r.fulfill({ status: 401, contentType: "text/plain", body: "no auth credentials" }),
  );
  await page.getByRole("button", { name: "Test" }).first().click();

  await expect(page.getByText(/rejected this key/)).toBeVisible();
  await expect.poll(async () => (await keys(page))[0]!.status).toBe("invalid");
});

test("a rate limit cools the key down rather than invalidating it", async ({ page }) => {
  await openProviders(page);

  await page.route(ORACLE_MODELS, (r) =>
    r.fulfill({ status: 429, contentType: "text/plain", body: "slow down" }),
  );
  await page.getByRole("button", { name: "Test" }).first().click();

  await expect(page.getByText(/rate-limited/)).toBeVisible();
  await expect.poll(async () => (await keys(page))[0]!.status).toBe("cooldown");
});
