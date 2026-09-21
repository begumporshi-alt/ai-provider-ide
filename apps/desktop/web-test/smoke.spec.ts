/**
 * Smoke test: every screen the sidebar can navigate to must render without an uncaught error.
 *
 * One undefined field blanking a route reads to Playwright as "8 tests time out with a black
 * screenshot", not as "ScopeSelect crashed reading `.global`". That whole bug class disappears
 * if one spec visits each nav item and asserts zero `pageerror` events landed.
 *
 * The shim throws on unknown commands, screens wrap loads in `Promise.all(...).catch(undefined)`,
 * and the result is a silently empty screen, not an error — so this guard also catches a fresh
 * shim gap whose only symptom is a missing section. It is intentionally cheap: no assertions on
 * content, just "no React tree crashed while painting this screen".
 *
 * Some bugs only crash *when the data is there* (Memory's ScopeSelect reads `m.scope.global`).
 * The general case below does not catch those, because an empty list renders no rows. A
 * targeted seeded test for Memory fills that gap. Adding more is cheap and obvious.
 */
import { expect, test } from "@playwright/test";

const APP = "/web-test/";

/** Sidebar labels in order, taken straight from `components/Shell.tsx`. */
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
  "Router Settings",
  "Local Gateway",
];

test.describe("smoke", () => {
  for (const label of NAV_LABELS) {
    test(`every screen renders without an uncaught error (${label})`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(`${e.name}: ${e.message}`));

      await page.goto(`${APP}?seed=systemai`);

      // Click the sidebar button. `exact: true` rules out partial matches against section
      // headings like "Memory".
      await page.getByRole("button", { name: label, exact: true }).click();

      // Give React a beat to either paint or crash. 500 ms is enough for a render error to
      // surface; 30 s of waiting (the Playwright default) hides it as a timeout.
      await page.waitForTimeout(500);

      // The bug class is "tree is blank because render threw". A non-empty body is the cheapest
      // check for that. Strictly weaker than asserting on a heading — some screens legitimately
      // have empty bodies before data loads — but catches the render-crash case the diagnostic
      // here was written to defend against.
      const bodyText = await page.locator("body").innerText();
      expect(errors, `render errors on "${label}":\n${errors.join("\n")}`).toEqual([]);
      expect(bodyText.length, `blank body on "${label}"`).toBeGreaterThan(20);
    });
  }
});

test("smoke: memory renders without an uncaught error when rows are present", async ({ page }) => {
  // The empty-store smoke above cannot catch "render crashes on a row", because no rows means
  // the per-row component never executes. Seed first, then navigate, then assert.
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`${e.name}: ${e.message}`));

  await page.goto(`${APP}?seed=systemai`);
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const host = (window as any).__webTest;
    await host.invoke("memory_capture", {
      layer: "L1",
      text: "Tushu lives in Dhaka, which is GMT+6",
      session_id: "s1",
      subject: null,
      pinned: false,
    });
  });

  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await page.waitForTimeout(500);

  const bodyText = await page.locator("body").innerText();
  expect(errors, `render errors on Memory with rows:\n${errors.join("\n")}`).toEqual([]);
  // The seeded text proves rows actually rendered (and so did the row component).
  expect(bodyText, `seeded memory did not render on Memory`).toContain(
    "Tushu lives in Dhaka, which is GMT+6",
  );
});