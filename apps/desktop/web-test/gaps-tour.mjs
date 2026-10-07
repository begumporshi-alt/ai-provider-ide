/**
 * web-test/gaps-tour.mjs — one-off screenshot tour of the capability gaps against the running
 * dev servers (vite :1430, mock :18901). DEV-ONLY, not part of the Playwright suite.
 *
 *   node web-test/gaps-tour.mjs            # writes web-test/screenshots/*.png
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const APP = "http://127.0.0.1:1430/web-test/";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "screenshots");
mkdirSync(OUT, { recursive: true });

const shot = (page, name) => page.screenshot({ path: join(OUT, name), fullPage: false });

async function allowOnce(page) {
  await page.getByRole("heading", { name: /Allow this (tool call|change)\?/ }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
}

async function openAgentChat(page) {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await page.getByRole("button", { name: /open picker/ }).click();
  await page.getByRole("option").filter({ hasText: /oracle-mini/ }).first().click();
  await page.getByRole("button", { name: "Run configuration" }).click();
  await page.getByLabel("agent mode").check();
  await page.getByTestId("run-config-overlay").click({ position: { x: 10, y: 10 } });
  await page.getByRole("dialog", { name: "Run configuration" }).waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Root", exact: true }).click();
  await page.getByPlaceholder(/absolute\/path/).fill("/tmp");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
}

async function send(page, text) {
  await page.getByPlaceholder(/Describe a task for the agent/).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

const browser = await chromium.launch();

async function attempt(name, fn) {
  const page = await browser.newPage();
  try {
    await fn(page);
  } catch (e) {
    await shot(page, `FAIL-${name}.png`).catch(() => {});
    throw e;
  }
  await page.close();
}

// Gap 1 — parallel tool calls
{
  const page = await browser.newPage();
  await openAgentChat(page);
  await send(page, "do two things in parallel");
  await allowOnce(page);
  await allowOnce(page);
  await page.getByText("Done. Here is what I found in the workspace.").waitFor({ timeout: 30_000 });
  await shot(page, "gap1-parallel-tool-calls.png");
  await page.close();
}

// Gap 2 — dispatch_agent delegation, then the Subagents screen
{
  const page = await browser.newPage();
  try {
    await openAgentChat(page);
    await send(page, "delegate a file listing");
    await allowOnce(page);
    await allowOnce(page);
    await page.getByText("Done. Here is what I found in the workspace.").last().waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Subagents", exact: true }).click();
    await page.getByText(/delegated runs/).waitFor({ timeout: 15_000 });
    await shot(page, "gap2-subagents-screen.png");
  } catch (e) {
    await shot(page, "FAIL-gap2.png").catch(() => {});
    throw e;
  }
  await page.close();
}

// Gap 3 — notebook read + edit
{
  const page = await browser.newPage();
  await openAgentChat(page);
  await send(page, "fix up my notebook");
  await allowOnce(page);
  await allowOnce(page);
  await page.getByText("Notebook updated — cell 0 now reads the edited line.").waitFor({ timeout: 30_000 });
  await shot(page, "gap3-notebook-edit.png");
  await page.close();
}

// Gap 4 — generate_image in agent mode
{
  const page = await browser.newPage();
  await openAgentChat(page);
  await send(page, "draw me a pixel");
  await allowOnce(page);
  await page.getByText(/generated and saved: images\/drawn\.png/).waitFor({ timeout: 30_000 });
  await shot(page, "gap4-agent-image.png");
  await page.close();
}

// Gap 5 — load_skill
{
  const page = await browser.newPage();
  await openAgentChat(page);
  await send(page, "follow the code review checklist");
  await allowOnce(page);
  await page.getByText(/Following the loaded checklist: .*points at/).waitFor({ timeout: 30_000 });
  await shot(page, "gap5-load-skill.png");
  await page.close();
}

// Gap 6 — background run_command + process_output
{
  const page = await browser.newPage();
  await openAgentChat(page);
  await send(page, "start a background job");
  await allowOnce(page);
  await allowOnce(page);
  await page.getByText("Background job finished — its output: bg work done").waitFor({ timeout: 30_000 });
  await shot(page, "gap6-background-command.png");
  await page.close();
}

// Keep-mounted fix — leave mid-turn, come back, the live transcript is still there.
// Plain mode: in agent mode "slow:" is the held run_command variant, not the tick stream.
{
  const page = await browser.newPage();
  try {
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.goto(`${APP}?seed=systemai`);
    await page.getByRole("button", { name: "Assistant", exact: true }).click();
    await page.getByRole("button", { name: /open picker/ }).click();
    await page.getByRole("option").filter({ hasText: /oracle-mini/ }).first().click();
    await page.getByPlaceholder(/Message your assistant/).fill("slow: hello");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByText(/tick1\b/).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await shot(page, "keep-mounted-away-mid-turn.png");
    await page.getByRole("button", { name: "Assistant", exact: true }).click();
    await page.getByText(/tick39/).waitFor({ timeout: 30_000 });
    await shot(page, "keep-mounted-back-live.png");
  } catch (e) {
    await shot(page, "FAIL-keep-mounted.png").catch(() => {});
    throw e;
  }
  await page.close();
}

// Image tab (the Image screen the generate_image port reuses)
{
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await page.getByPlaceholder(/A tiny lighthouse/).fill("a tiny red pixel");
  await page.getByRole("button", { name: /open picker/ }).click();
  await page.getByRole("option").filter({ hasText: /sd-oracle-1/ }).first().click();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await page.locator('img[alt="generated"]').waitFor({ timeout: 30_000 });
  await shot(page, "image-tab-generated.png");
  await page.close();
}

await browser.close();
console.log("screenshots written to", OUT);
