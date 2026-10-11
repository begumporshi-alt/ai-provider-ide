/**
 * web-test/session-skills.spec.ts — the transcript's session-skills drawer.
 *
 * The drawer is the per-conversation view over the installed skills: which ones the model already
 * loaded through load_skill (the used log), and which this conversation may reach (the session
 * toggles). The toggle must prove its two promises live: the skill really is out of the running
 * agent's reach (the load_skill call comes back "no enabled skill named …"), and the Skills
 * screen's global flag is untouched (read through __webTest.store.skills).
 */
import { expect, test } from "@playwright/test";
import { pickModel } from "./model-picker";
import { closeRunConfig, openRunConfig } from "./run-config";

const APP = "/web-test/";

async function openAgentChat(page: import("@playwright/test").Page) {
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
}

async function send(page: import("@playwright/test").Page, text: string) {
  await page.getByPlaceholder(/Describe a task for the agent/).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

async function allowOnce(page: import("@playwright/test").Page) {
  await expect(page.getByRole("heading", { name: /Allow this (tool call|change)\?/ })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
}

test("the drawer lists the installed skills, tracks a loaded one, and a new session starts clean", async ({ page }) => {
  await openAgentChat(page);

  // The shim seeds the four builtins, so there is always something true for the rail to say.
  const rail = page.getByTestId("session-skills-rail");
  await expect(rail).toBeVisible({ timeout: 15_000 });
  await expect(rail).toContainText("4 on");

  await rail.click();
  const drawer = page.getByTestId("session-skills-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByTestId("session-skills-row")).toHaveCount(4);
  // Nothing has been loaded in this conversation yet — the used section says so in words.
  await expect(drawer.getByTestId("session-skills-empty-used")).toBeVisible();
  await page.getByRole("button", { name: "Close session skills drawer" }).click();

  // The gap-5 flow: the mock's agent calls load_skill "Code review" and quotes the body. The
  // drawer's used log must record the hit the same way the transcript proves the round trip.
  await send(page, "follow the code review checklist");
  await allowOnce(page);
  await expect(page.getByText(/Following the loaded checklist: .*Review the change the user points at/)).toBeVisible({
    timeout: 30_000,
  });

  await expect(rail).toContainText("1 used");
  await rail.click();
  const usedRows = drawer.getByTestId("session-skills-used-row");
  await expect(usedRows).toHaveCount(1);
  await expect(usedRows).toContainText("Code review");

  // Session-scoped state resets with the conversation, like the task list does. The session
  // menu is the single door into "New session" (the same path assistant-session.spec drives).
  await page.getByRole("button", { name: /untitled session/ }).click();
  await page.getByRole("menuitem", { name: /New session/ }).click();
  await expect(drawer.getByTestId("session-skills-empty-used")).toBeVisible();
  await expect(drawer.getByTestId("session-skills-used-row")).toHaveCount(0);
});

test("a session toggle keeps the skill out of the running agent without touching the global flag", async ({ page }) => {
  await openAgentChat(page);
  await page.getByTestId("session-skills-rail").click();
  const drawer = page.getByTestId("session-skills-drawer");
  await expect(drawer).toBeVisible();

  await drawer.getByLabel("Code review — available this session").uncheck();
  // The row says this is a session-only decision, not a global disable.
  await expect(drawer.getByTestId("session-skills-override-mark").first()).toBeVisible();

  // Global state untouched: the shim's skills table still reports the builtin enabled.
  const enabled = await page.evaluate(() =>
    ((window as unknown as { __webTest: { store: { skills: () => Array<{ slug: string; enabled: boolean }> } } })
      .__webTest.store.skills()
      .find((s) => s.slug === "code-review")?.enabled),
  );
  expect(enabled).toBe(true);

  // The proof that matters: the running agent cannot reach it. The mock's model still asks for
  // load_skill "Code review" — the loop must answer that no such skill is available to this run.
  await page.getByRole("button", { name: "Close session skills drawer" }).click();
  // The rail is the drawer's collapsed state, so its "session" mark is only readable once closed.
  await expect(page.getByTestId("session-skills-rail")).toContainText("session");
  await send(page, "follow the code review checklist");
  await allowOnce(page);
  // The transcript renders typographic quotes, so the name is matched loosely — what the
  // assertion pins is the loop's refusal sentence itself.
  await expect(page.getByText(/Following the loaded checklist: no enabled skill named .Code review./)).toBeVisible({
    timeout: 30_000,
  });

  // The used log stays empty — a refused load is not a use.
  await page.getByTestId("session-skills-rail").click();
  await expect(drawer.getByTestId("session-skills-empty-used")).toBeVisible();

  // "reset to global" drops the override: the checkbox reads on again.
  await drawer.getByTestId("session-skills-reset").click();
  await expect(drawer.getByLabel("Code review — available this session")).toBeChecked();
  await expect(drawer.getByTestId("session-skills-override-mark")).toHaveCount(0);
});
