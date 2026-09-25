/**
 * web-test/service-status.spec.ts — what the app says about the login-item service.
 *
 * The harness has no launchd, so `service_install` and `service_uninstall` throw. What can be
 * tested is the screen's copy for each state the shim can arrange through `__webTest.serviceStatus`.
 */
import { expect, test, type Page } from "@playwright/test";

const APP = "/web-test/";

/**
 * Both halves this spec arranges: the service state, and the app gateway's running flag — the port
 * conflict it warns about is the *combination*, so one without the other cannot be reached.
 */
type Host = {
  serviceStatus: (next: Record<string, unknown>) => void;
  gatewayStatus: (next: Record<string, unknown>) => void;
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

test("a service the host reports as not installed reads as not installed", async ({ page }) => {
  await openGatewayTab(page, { plistPresent: false, loaded: false, pid: null });

  await expect(page.getByText("Not installed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Install" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(0);
});

test("a service the host reports as installed but not running reads as installed", async ({ page }) => {
  await openGatewayTab(page, { plistPresent: true, loaded: false, pid: null });

  await expect(page.getByText("Installed, not running", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Install" })).toHaveCount(0);
});

test("a service the host reports as running reads as running with its pid", async ({ page }) => {
  await openGatewayTab(page, { plistPresent: true, loaded: true, pid: 12345 });

  await expect(page.getByText("Running (pid 12345)", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Install" })).toHaveCount(0);
});

test("a running app gateway warns when the service is installed but not up", async ({ page }) => {
  // Arrange: app gateway running, service installed but not loaded.
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

  await expect(
    page.getByText("The app gateway is running and owns the port. Stop it before starting the service"),
  ).toBeVisible();
});
