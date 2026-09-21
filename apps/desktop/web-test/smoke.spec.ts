/**
 * Smoke test: every screen the sidebar can navigate to must render without an uncaught error.
 *
 * One undefined field blanking a route reads to Playwright as "8 tests time out with a black
 * screenshot", not as "ScopeSelect crashed reading `.global`". That whole bug class disappears
 * if one spec visits each nav item and asserts zero `pageerror` events landed.
 *
 * This guard deliberately checks only "no React tree crashed". It does NOT catch a shim gap: the
 * shim rejects an unknown command, screens swallow the rejection, and the section renders empty
 * rather than crashing — body text is still well over 20 chars because the rest of the shell
 * painted. `unknownCommands` below is the guard for that; see it before trusting this one.
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
  "Control",
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

/**
 * The guard the render checks above cannot provide.
 *
 * The shim rejects a command it has no case for, exactly as Rust would. Screens load several in
 * one `Promise.all([...]).catch(() => undefined)`: one rejection nulls the whole batch, every
 * value stays at its initial state, and the section renders looking precisely like a screen that
 * loaded and had nothing to report. No error, no crash, no failing test — and a control that
 * should be live is silently disabled.
 *
 * `router_model_context_count` was missing from the shim for the entire memory feature. The
 * Memory screen's master switch never loaded; it rendered disabled and reading "off", which is
 * what "off" is supposed to look like anyway. Nothing caught it.
 */
test("smoke: no screen calls a command the shim does not implement", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  for (const label of NAV_LABELS) {
    await page.getByRole("button", { name: label, exact: true }).click();
    // Screens fire their loads on mount and poll; one beat is enough for them to land.
    await page.waitForTimeout(300);
  }
  const unknown = await page.evaluate(() =>
    (window as unknown as { __webTest: { unknownCommands: () => string[] } }).__webTest.unknownCommands(),
  );
  expect(unknown, "commands the app calls that the shim has no case for").toEqual([]);
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
      sessionId: "s1",
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