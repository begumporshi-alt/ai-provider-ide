/**
 * web-test/connect-ide.spec.ts — the "Connect your IDE" setup panel.
 *
 * The panel is the product's front door for its second vision (a routing service other coding
 * agents dial into): if the handoff is wrong — a base URL with the wrong `/v1`-ness, a snippet
 * that claims to hold a secret, a mint that never lands in Per-app keys — the router is
 * undiscoverable no matter how good the gateway behind it is.
 *
 * The base-URL rule is the part worth double assertions: OpenAI-compatible bases carry `/v1`,
 * Claude Code's must NOT (it appends /v1/messages itself). A single-sided "contains" check
 * would pass both the right and the wrong form, so each is paired with its absence.
 *
 * Snippet-content assertions go through the panel's single `<pre>`: the intro paragraph names
 * the placeholder too, and matching the whole panel there is a strict-mode violation — the
 * code block is the element that has to carry the bytes.
 */
import { expect, test, type Page } from "@playwright/test";

const APP = "/web-test/";

async function openGateway(page: Page): Promise<void> {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Local Gateway", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Local Gateway" })).toBeVisible({ timeout: 10_000 });
}

/** The panel itself, so "Copy" and target buttons never match the presets below it. */
function panel(page: Page) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: "Connect your IDE" }) });
}

/** The rendered config bytes — the element whose content the operator actually copies. */
function snippet(page: Page) {
  return panel(page).locator("pre");
}

test("ZCode by default: an openai-compatible entry with the /v1 base and a paste-over placeholder", async ({
  page,
}) => {
  await openGateway(page);

  await expect(snippet(page)).toContainText('"kind": "openai-compatible"');
  // The OpenAI surface keeps /v1 in the base — the endpoint URL verbatim.
  await expect(snippet(page)).toContainText('"baseURL": "http://127.0.0.1:8787/v1"');
  // No snippet ever pretends to hold a secret: the placeholder is the paste-over slot.
  await expect(snippet(page)).toContainText("sk-aip-PASTE-KEY-HERE");
});

test("switching targets swaps the config — and the Claude Code base is the root, not /v1", async ({
  page,
}) => {
  await openGateway(page);
  const p = panel(page);

  await p.getByRole("button", { name: "Claude Code" }).click();
  // Right form present…
  await expect(snippet(page)).toContainText('ANTHROPIC_BASE_URL="http://127.0.0.1:8787"');
  // …and the /v1 form absent — the doubled /v1/v1/messages the old preset dialed.
  await expect(snippet(page)).not.toContainText('ANTHROPIC_BASE_URL="http://127.0.0.1:8787/v1"');
  await expect(snippet(page)).toContainText('ANTHROPIC_AUTH_TOKEN="sk-aip-PASTE-KEY-HERE"');

  await p.getByRole("button", { name: "OpenAI-compatible app" }).click();
  await expect(snippet(page)).toContainText("Base URL: http://127.0.0.1:8787/v1");
});

test("the model id typed into the field lands in the snippet, not just in state", async ({ page }) => {
  await openGateway(page);
  const p = panel(page);

  await p.getByLabel("Model id for snippets").fill("openrouter/anthropic/claude-fable-5.1");
  await p.getByRole("button", { name: "OpenAI-compatible app" }).click();

  await expect(
    snippet(page).getByText(
      `-d '{"model":"openrouter/anthropic/claude-fable-5.1","messages":[{"role":"user","content":"ping"}]}'`,
    ),
  ).toBeVisible();
});

test("minting a labeled key lands in Per-app keys and explains the two-paste flow", async ({ page }) => {
  await openGateway(page);

  // Counter-assertion first: nothing named zcode exists yet, so the later row is *this* mint.
  const row = page.locator("li").filter({ hasText: "zcode" });
  await expect(row).toHaveCount(0);

  await panel(page).getByRole("button", { name: "Mint a key for ZCode" }).click();

  await expect(row).toHaveCount(1);
  await expect(panel(page).getByText(/minted — its secret is on your clipboard/)).toBeVisible();
});

test("copying flips the button to Copied, and every command the panel used is one the host knows", async ({
  page,
}) => {
  await openGateway(page);
  const p = panel(page);

  await p.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(p.getByRole("button", { name: "Copied" })).toBeVisible();

  // A command the shim lacked would have thrown into the panel's error line *and* registered
  // here — both halves asserted, because a swallowed rejection renders like success.
  expect(
    await page.evaluate(
      () => (window as unknown as { __webTest: { unknownCommands: () => string[] } }).__webTest.unknownCommands(),
    ),
  ).toEqual([]);
  await expect(p.getByText(/web-test shim/)).toHaveCount(0);
});
