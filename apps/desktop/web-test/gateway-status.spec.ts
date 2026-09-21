/**
 * web-test/gateway-status.spec.ts — what the app says about the gateway worker.
 *
 * The bug this pins: `gateway_status.running` was `is_available()` — the *conjunction* of operator
 * intent and a live heartbeat. A hidden worker's beat stops after ~8 idle minutes, so a gateway
 * that was bound and serving would report itself stopped: the dot went grey, the button offered
 * "Start", and pressing it tore down a healthy listener. Sleeping is not stopped. `running` is now
 * operator intent (`is_running()`) and the beat is reported separately as `workerAwake`, so the
 * screen can say "the worker is asleep" instead of contradicting itself.
 *
 * **Retargeted 2026-09-21.** The on/off switch, the port and the spend cap moved from Local Gateway
 * to Control → Gateway (§3: move, don't mirror). The worker diagnostics moved with them: they are
 * the *evidence for that switch's state*, and §4.4 puts evidence beside the control it explains.
 * Local Gateway keeps a read-only "Running"/"Stopped" line, because it is the screen that prints
 * the endpoint URL and therefore the screen that has to say whether that URL answers.
 *
 * This had no coverage at all before: `gateway_status` was not in the shim's command table, so the
 * invoke threw, `status` stayed null, and every spec saw the "Stopped" branch regardless of what
 * the host would have said. The host owns the listener and the worker window, so the states below
 * cannot be reached from the UI — the shim exposes them through `__webTest.gatewayStatus`.
 *
 * The three states are deliberately cross-checked, so none of the assertions is vacuous: the
 * sleeping caveat is asserted *present* in one test and *absent* in another, and "Stopped" is
 * asserted absent while the worker sleeps but present when the operator really did stop it.
 */
import { expect, test, type Page } from "@playwright/test";

const APP = "/web-test/";

type Host = { gatewayStatus: (next: Record<string, unknown>) => void };

/**
 * Arrange the host's report, then open Control → Gateway.
 *
 * The order matters: the tab reads status on mount, so arranging after the click would assert
 * against the previous value.
 *
 * The readiness wait is the **switch**, not the Control heading. The heading is there before any
 * host command has answered, whereas the switch is the thing every assertion below is about — and
 * a `getByRole("switch")` also proves the tab actually mounted, which a heading on another tab
 * would not.
 */
async function openGatewayTab(page: Page, status: Record<string, unknown>): Promise<void> {
  await page.goto(`${APP}?seed=systemai`);
  await page.evaluate(
    (s) => (window as unknown as { __webTest: Host }).__webTest.gatewayStatus(s),
    status,
  );
  await page.getByRole("button", { name: "Control" }).click();
  await expect(page.getByRole("heading", { name: "Control" })).toBeVisible({ timeout: 10_000 });
  // `tab`, not `button`: Control's Findings list renders jump buttons labelled with tab names too.
  await page.getByRole("tab", { name: "Gateway" }).click();
  await expect(page.getByRole("switch", { name: "Gateway" })).toBeVisible({ timeout: 10_000 });
}

test("a bound gateway whose worker is asleep reads as running, not stopped", async ({ page }) => {
  // The exact state the old code got wrong: serving, socket bound, beat lapsed 32s ago.
  await openGatewayTab(page, { running: true, workerAwake: false, heartbeatAgeMs: 32_000 });

  await expect(page.getByText(/the worker is asleep/)).toBeVisible();
  await expect(page.getByText("Running", { exact: true })).toBeVisible();
  // The regression itself. "Stopped" here is what made the UI offer to restart a healthy gateway.
  await expect(page.getByText("Stopped", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/last heard from the worker/)).toHaveCount(0);
});

test("an awake worker shows no sleeping caveat", async ({ page }) => {
  await openGatewayTab(page, { running: true, workerAwake: true, heartbeatAgeMs: 500 });

  await expect(page.getByText("Running", { exact: true })).toBeVisible();
  // The counter-assertion to the test above: the caveat is conditional, not always painted.
  await expect(page.getByText(/the worker is asleep/)).toHaveCount(0);
});

test("a gateway the operator really stopped names how long ago the worker was heard", async ({
  page,
}) => {
  await openGatewayTab(page, { running: false, workerAwake: false, heartbeatAgeMs: 45_000 });

  await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
  await expect(page.getByText(/last heard from the worker 45s ago/)).toBeVisible();
  // Proves "Stopped" is reachable, which is what makes the count-0 assertion above meaningful.
  await expect(page.getByText(/the worker is asleep/)).toHaveCount(0);
});

test("a worker that failed to boot shows the error, not the sleeping caveat", async ({ page }) => {
  await openGatewayTab(page, {
    running: true,
    workerAwake: false,
    workerError: "TypeError: core is not a function",
  });

  await expect(page.getByText(/failed to start/)).toBeVisible();
  await expect(page.getByText(/TypeError: core is not a function/)).toBeVisible();
  // A dead worker is not a sleeping one, and telling the operator to just retry would mislead.
  await expect(page.getByText(/the worker is asleep/)).toHaveCount(0);
});
