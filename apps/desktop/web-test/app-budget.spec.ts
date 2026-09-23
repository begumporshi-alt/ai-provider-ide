/**
 * web-test/app-budget.spec.ts — per-app budgets (0017).
 *
 * The feature is a *narrower* instrument than the global cap: `settings.spend.capMicrosPerMonth`
 * bounds what the owner pays in total, and one runaway app could spend all of it while every other
 * app sat idle. A cap on the key bounds one app.
 *
 * Two things make this worth a browser spec rather than only Rust tests:
 *
 * 1. The Rust tests prove the *gate* refuses the right caller. They cannot prove the screen puts
 *    the budget on the right row, and the screen is where a per-app budget is set.
 * 2. The states that matter need a month of traffic to reach for real. `monthMicros` comes from the
 *    ledger, so "capped and at its limit" is not reachable by clicking — it is arranged through
 *    `__webTest.appKeys`, which is the only way these branches get exercised at all.
 *
 * Every assertion is paired with a counter-assertion, because the failure mode here is not "the
 * number is wrong" — it is "the control is on the wrong row", which a single-sided check passes.
 */
import { expect, test, type Page } from "@playwright/test";

const APP = "/web-test/";

type KeyRow = {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  capMicros: number | null;
  monthMicros: number;
};

/** A key in a known state; every field is overridable so each test states only what it varies. */
const key = (over: Partial<KeyRow>): KeyRow => ({
  id: "ak-1",
  label: "Cursor",
  createdAt: Date.now(),
  lastUsedAt: null,
  revokedAt: null,
  capMicros: null,
  monthMicros: 0,
  ...over,
});

/**
 * Arrange the key list, then open Local Gateway.
 *
 * The order is load-bearing: the screen reads `gateway_app_keys` on mount, and the shim's state is
 * per-page, so arranging after the click would assert against an empty list and a reload would
 * discard what was arranged.
 */
async function openGateway(page: Page, keys: KeyRow[]): Promise<void> {
  await page.goto(`${APP}?seed=systemai`);
  await page.evaluate(
    (rows) =>
      (window as unknown as { __webTest: { appKeys: (r: unknown) => void } }).__webTest.appKeys(rows),
    keys,
  );
  await page.getByRole("button", { name: "Local Gateway", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Local Gateway" })).toBeVisible({ timeout: 10_000 });
}

test("a key with no budget says so, and offers to set one rather than to clear one", async ({
  page,
}) => {
  await openGateway(page, [key({})]);

  await expect(page.getByText(/no budget/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Set budget" })).toBeVisible();
  // The counter-assertion: clearing a budget that does not exist would be a control with no
  // effect, so it must be absent — not merely inert.
  await expect(page.getByRole("button", { name: "Clear" })).toHaveCount(0);
});

test("a budgeted key shows what it spent against its budget, and seeds the field", async ({
  page,
}) => {
  await openGateway(page, [key({ capMicros: 5_000_000, monthMicros: 5_000_000 })]);

  await expect(page.getByText(/this month of \$5\.00/)).toBeVisible();
  await expect(page.getByText(/no budget/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Update" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear" })).toBeVisible();
  // Seeded from the host, so the operator edits the current budget instead of typing over a blank
  // and silently replacing a number they cannot see.
  await expect(page.getByLabel("Monthly budget in USD for Cursor")).toHaveValue("5");
});

test("setting a budget round-trips through the host and re-renders from the answer", async ({
  page,
}) => {
  await openGateway(page, [key({})]);
  const field = page.getByLabel("Monthly budget in USD for Cursor");

  await field.fill("12.5");
  await page.getByRole("button", { name: "Set budget" }).click();

  // Asserted on the *rendered row*, not on the field: the row is re-read from the host, so this
  // fails if the command never landed and the field merely kept what was typed.
  await expect(page.getByText(/this month of \$12\.50/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Update" })).toBeVisible();
});

test("clearing a budget removes it and returns the row to its uncapped state", async ({ page }) => {
  await openGateway(page, [key({ capMicros: 1_000_000, monthMicros: 250_000 })]);

  await expect(page.getByText(/of \$1\.00/)).toBeVisible();
  await page.getByRole("button", { name: "Clear" }).click();

  await expect(page.getByText(/no budget/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Set budget" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear" })).toHaveCount(0);
});

test("two keys keep their own budgets and their own fields", async ({ page }) => {
  await openGateway(page, [
    key({ id: "ak-1", label: "Cursor", capMicros: 1_000_000, monthMicros: 100_000 }),
    key({ id: "ak-2", label: "Claude Code" }),
  ]);

  // The property the per-id draft map exists for. A single shared field would paint one app's
  // budget against the other app's row, and both of these assertions would still pass — which is
  // why they are asserted together rather than one at a time.
  await expect(page.getByLabel("Monthly budget in USD for Cursor")).toHaveValue("1");
  await expect(page.getByLabel("Monthly budget in USD for Claude Code")).toHaveValue("");
  await expect(page.getByText(/of \$1\.00/)).toBeVisible();
  await expect(page.getByText(/no budget/)).toBeVisible();
});

test("a revoked key offers no budget control at all", async ({ page }) => {
  await openGateway(page, [key({ revokedAt: Date.now(), capMicros: 1_000_000 })]);

  await expect(page.getByText("revoked")).toBeVisible();
  // It cannot spend, so a field offering to limit it would be a control that does nothing while
  // looking like it does. Both spellings are checked, because either could leak through.
  await expect(page.getByRole("button", { name: "Set budget" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Update" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();
});
