/**
 * The state where **the gateway is not listening** — a state the operator can put the app in on
 * purpose, because Control's switch turns the listener off and `GatewayStartup::Off` honours that
 * across relaunches.
 *
 * The app must survive it. Since the pure-HTTP migration (dev-book §10 decision 2) the reads that
 * fill every screen are host calls, so with nothing bound they all fail at once. Measured
 * 2026-09-25, before `bootstrap` guarded them, the app came up as:
 *
 *     App data could not be opened
 *     TypeError: Failed to fetch
 *
 * — a corrupt-database screen, complete with restore-from-backup advice, for a gateway that was
 * simply not running, with no screen rendered at all. The mitigation is the one dev-book §10 already
 * prescribes for "UI → service discovery fails on first install": degrade, and say so.
 *
 * This spec exists because the suite could not see it. `web-test/shim.ts` answered every `/admin/*`
 * call unconditionally, so a boot path that had acquired a network dependency looked healthy in all
 * 106 tests. `__webTestAdminSurfaceAbsent` is the capability that closes that gap.
 *
 * `addInitScript` is required, not incidental: `bootstrap()` runs on mount, so a flag set after the
 * page has loaded is always too late to reach it.
 */
import { expect, test } from "@playwright/test";

const APP = "/web-test/";

/** Sidebar labels, taken from `components/Shell.tsx` — the same list `smoke.spec.ts` walks. */
const NAV_LABELS = [
  "AI Providers",
  "Model Browser",
  "Assistant",
  "Activity",
  "Context",
  "History",
  "Skills",
  "Agents",
  "Memory",
  "Control",
  "Router Settings",
  "Local Gateway",
];

/** Arrange "nothing is bound on the gateway port" before any page script runs. */
async function withoutAGateway(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __webTestAdminSurfaceAbsent: boolean }).__webTestAdminSurfaceAbsent = true;
  });
}

test("gateway off: the app boots and names the cause instead of blaming the database", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`${e.name}: ${e.message}`));

  await withoutAGateway(page);
  await page.goto(APP);
  await page.waitForTimeout(1000);

  const body = await page.locator("body").innerText();

  // The specific defect: a listener that is not running is not a corrupt store. The copy on that
  // screen tells the user to restore a backup, which is wrong advice for a gateway that is off.
  expect(body, "the corrupt-database screen must not stand in for an absent gateway").not.toContain(
    "App data could not be opened",
  );

  // Degrading is not enough on its own: an empty screen and a gateway that is off look identical,
  // and they have opposite fixes. The state has to be named.
  expect(body, "the degraded state must be named").toContain("Gateway not running");

  // And the app is actually usable: the shell painted and the nav is live.
  await expect(page.getByRole("button", { name: "AI Providers", exact: true })).toBeVisible();
  expect(errors, `uncaught errors on boot:\n${errors.join("\n")}`).toEqual([]);
});

test("gateway off: every screen still renders", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`${e.name}: ${e.message}`));

  await withoutAGateway(page);
  await page.goto(APP);

  for (const label of NAV_LABELS) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.waitForTimeout(300);
    const bodyText = await page.locator("body").innerText();
    expect(bodyText.length, `blank body on "${label}" with no gateway`).toBeGreaterThan(20);
  }

  expect(errors, `uncaught errors:\n${errors.join("\n")}`).toEqual([]);
});
