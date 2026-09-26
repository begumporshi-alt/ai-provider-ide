/**
 * web-test/service-status.spec.ts — what the app says about the login-item service, and what its
 * buttons do.
 *
 * The harness has no launchd, so every `service_*` verb throws. Two things are still testable, and
 * they are different things: the screen's **copy** for each state the shim can arrange through
 * `__webTest.serviceStatus`, and the **wiring** of the buttons — which command each one calls, and
 * in what order. The order is the part worth pinning, because Start has to release the port before
 * it asks launchd for the job.
 */
import { expect, test, type Page } from "@playwright/test";

const APP = "/web-test/";

/**
 * Everything this spec arranges and observes: the service state, the app gateway's running flag,
 * and the service card's call log. The port conflict the card warns about is the *combination* of
 * the first two, so one without the other cannot be reached.
 */
type Host = {
  serviceStatus: (next: Record<string, unknown>) => void;
  gatewayStatus: (next: Record<string, unknown>) => void;
  serviceCalls: () => string[];
  resetServiceCalls: () => void;
};

async function openGatewayTab(page: Page, status: Record<string, unknown>): Promise<void> {
  await page.goto(`${APP}?seed=systemai`);
  await page.evaluate(
    (s) => (window as unknown as { __webTest: Host }).__webTest.serviceStatus(s),
    status,
  );
  await page.getByRole("button", { name: "Control" }).click();
  await expect(page.getByRole("heading", { name: "Control" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("tab", { name: "Gateway" }).click();
  await expect(page.getByRole("switch", { name: "Gateway" })).toBeVisible({ timeout: 10_000 });
}

/** The card's commands, oldest first. Read through `evaluate` so the assertion sees the page's own. */
const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __webTest: Host }).__webTest.serviceCalls());

/** Clear the log, so an assertion is about the click the test makes rather than what the mount did. */
const clearCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __webTest: Host }).__webTest.resetServiceCalls());

test("a service the host reports as not installed reads as not installed", async ({ page }) => {
  await openGatewayTab(page, { plistPresent: false, loaded: false, pid: null });

  await expect(page.getByText("Not installed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Install" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(0);
  // Neither verb is reachable before the plist exists: there is nothing to start and nothing to
  // stop, so offering either would be a button that can only fail.
  await expect(page.getByRole("button", { name: "Start" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
});

test("a service the host reports as installed but not running offers Start", async ({ page }) => {
  await openGatewayTab(page, { plistPresent: true, loaded: false, pid: null });

  await expect(page.getByText("Installed, not running", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Install" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
});

test("a job launchd holds with no process behind it is not called running", async ({ page }) => {
  // `loaded` alone is a job between restarts — the shape a throttled `KeepAlive` leaves behind.
  // Reading that as "Running" is the defect this state exists to catch: the card would show a
  // healthy dot over a gateway that is down, and offer no button to bring it up.
  await openGatewayTab(page, { plistPresent: true, loaded: true, pid: null });

  await expect(page.getByText("Installed, not running", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
});

test("a service the host reports as running reads as running with its pid, and offers Stop", async ({
  page,
}) => {
  await openGatewayTab(page, { plistPresent: true, loaded: true, pid: 12345 });

  await expect(page.getByText("Running (pid 12345)", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start" })).toHaveCount(0);
});

test("a running app gateway says Start will hand the port over", async ({ page }) => {
  // Arrange: app gateway running, service installed but not loaded — the conflict is the pair.
  await page.goto(`${APP}?seed=systemai`);
  await page.evaluate(
    (s) => {
      (window as unknown as { __webTest: Host }).__webTest.serviceStatus(s);
      (window as unknown as { __webTest: Host }).__webTest.gatewayStatus({ running: true });
    },
    { plistPresent: true, loaded: false, pid: null },
  );
  await page.getByRole("button", { name: "Control" }).click();
  await expect(page.getByRole("heading", { name: "Control" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("tab", { name: "Gateway" }).click();
  await expect(page.getByRole("switch", { name: "Gateway" })).toBeVisible({ timeout: 10_000 });

  // The copy is a promise about the button rather than an instruction to go and use another
  // control. The old wording — "Stop it before starting the service" — described a step the
  // operator had to perform themselves, which is the step Start now performs.
  await expect(page.getByText("The app gateway is running and owns the port.")).toBeVisible();
  await expect(page.getByText("Start stops it first")).toBeVisible();
});

test("Start releases the port before it asks launchd for the job", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await page.evaluate(
    (s) => {
      (window as unknown as { __webTest: Host }).__webTest.serviceStatus(s);
      (window as unknown as { __webTest: Host }).__webTest.gatewayStatus({ running: true });
    },
    { plistPresent: true, loaded: false, pid: null },
  );
  await page.getByRole("button", { name: "Control" }).click();
  await expect(page.getByRole("heading", { name: "Control" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("tab", { name: "Gateway" }).click();
  await expect(page.getByRole("switch", { name: "Gateway" })).toBeVisible({ timeout: 10_000 });

  await clearCalls(page);
  await page.getByRole("button", { name: "Start" }).click();

  // **The order is the property.** Reversed, the agent would load into a port the app still holds,
  // every spawn would die on `EADDRINUSE`, and `KeepAlive` would throttle the job — which is
  // precisely the "Installed, not running" state this button exists to clear.
  await expect.poll(() => calls(page)).toEqual(["gateway_disable", "service_start"]);
});

test("Start leaves the gateway alone when the app is not holding the port", async ({ page }) => {
  await openGatewayTab(page, { plistPresent: true, loaded: false, pid: null });

  await clearCalls(page);
  await page.getByRole("button", { name: "Start" }).click();

  // No `gateway_disable`: the handover runs only when there is a port to hand over. Stopping a
  // gateway that is already down is a command with no effect, reported as a step taken.
  await expect.poll(() => calls(page)).toEqual(["service_start"]);
});

test("Stop asks launchd to unload the job", async ({ page }) => {
  await openGatewayTab(page, { plistPresent: true, loaded: true, pid: 12345 });

  await clearCalls(page);
  await page.getByRole("button", { name: "Stop" }).click();

  await expect.poll(() => calls(page)).toEqual(["service_stop"]);
});

test("a refusal from the host is shown rather than swallowed", async ({ page }) => {
  await openGatewayTab(page, { plistPresent: true, loaded: false, pid: null });

  // The harness throws, which is the only failure shape reachable here — and the card must show it.
  // A button that failed silently would leave the operator pressing Start and watching nothing.
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByText(/no launchd to start a job in/)).toBeVisible();
});
