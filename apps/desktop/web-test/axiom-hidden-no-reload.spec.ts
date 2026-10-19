/**
 * web-test/axiom-hidden-no-reload.spec.ts — the hang's trigger, pinned.
 *
 * The 2026-10-19 spindump showed the router's main thread pinned while a hidden AXIOM screen
 * re-read its audit ledger every 1.5 s. The chain was: an agent run makes `liveRunIds()` non-empty;
 * the subagents drawer bumped the GLOBAL tick on an interval; the hidden AXIOM screen listened to
 * that tick and reloaded seven stores, including multi-megabyte audit reports.
 *
 * This spec opens AXIOM once (so it stays mounted), returns to the Assistant, starts an agent turn
 * and leaves it parked on the approval modal — a live run. It then counts `axiom_audits_list`
 * invokes for longer than two ticks. The fixed build makes none.
 */
import { expect, test } from "@playwright/test";
import { pickModel } from "./model-picker";
import { closeRunConfig, openRunConfig } from "./run-config";

const APP = "/web-test/";

test("a hidden AXIOM screen does not reload during a live agent run", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${APP}?seed=systemai`);

  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);
  await openRunConfig(page);
  await page.getByLabel("agent mode").check();
  await closeRunConfig(page);
  await page.getByRole("button", { name: "Root", exact: true }).click();
  await page.getByPlaceholder(/absolute\/path/).fill("/tmp");
  await page.getByRole("button", { name: "Chat", exact: true }).click();

  // Count the hidden screen's ledger reads. Instrument BEFORE the first open, so the test also
  // proves the counter can see a real reload — a zero that can never be non-zero is no evidence.
  await page.evaluate(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const original = internals.invoke;
    (window as unknown as { __auditListCalls: number }).__auditListCalls = 0;
    internals.invoke = (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "axiom_audits_list") {
        (window as unknown as { __auditListCalls: number }).__auditListCalls += 1;
      }
      return original(cmd, args);
    };
  });

  // Open AXIOM once so it is mounted for the rest of the page's life, then leave it hidden.
  await page.getByRole("button", { name: "AXIOM", exact: true }).click();
  await expect(page.getByTestId("axiom-stepper")).toBeVisible();
  // The initial load really does read the ledger; the counter is not blind.
  await expect
    .poll(async () =>
      page.evaluate(() => (window as unknown as { __auditListCalls: number }).__auditListCalls),
    )
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    (window as unknown as { __auditListCalls: number }).__auditListCalls = 0;
  });
  await page.getByRole("button", { name: "Assistant", exact: true }).click();

  // A live agent run: parked on the approval modal, so `liveRunIds()` is non-empty.
  await page.getByPlaceholder(/Describe a task for the agent/).fill("list files");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("heading", { name: "Allow this tool call?" })).toBeVisible({ timeout: 30_000 });

  // Longer than two 1.5 s drawer ticks.
  await page.waitForTimeout(3_500);
  const calls = await page.evaluate(
    () => (window as unknown as { __auditListCalls: number }).__auditListCalls,
  );
  expect(
    calls,
    "a hidden AXIOM must not re-read its audit ledger when a live run ticks the drawer",
  ).toBe(0);
});
