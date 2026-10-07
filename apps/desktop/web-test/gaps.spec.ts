/**
 * web-test/gaps.spec.ts — the capability gaps, driven live through the real agent loop.
 *
 * Each test sends a task in plain mode (every call gated), answers the approval modals the way a
 * user does, and asserts on what the transcript actually renders — the loop executes the tool, the
 * shim's sandbox answers exactly as tools.rs would, and the mock provider scripts the model's
 * side. Gap 7 (CDP browser tools) is Rust-only and has no web shim; its live proof is the cargo
 * test that drives real headless Chrome, not anything here.
 */
import { expect, test } from "@playwright/test";
import { pickModel } from "./model-picker";
import { closeRunConfig, openRunConfig } from "./run-config";

const APP = "/web-test/";

type WebTest = { __webTest: { vfs: () => Record<string, string> } };

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

/** Answers one approval modal, in the order the loop asks for them. Reads get "Allow this tool
 *  call?"; mutating tools get "Allow this change?" so the reader knows which kind they approve. */
async function allowOnce(page: import("@playwright/test").Page) {
  await expect(page.getByRole("heading", { name: /Allow this (tool call|change)\?/ })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
}

test("gap 1: two tool calls in one turn both run, both prompt, both land", async ({ page }) => {
  await openAgentChat(page);
  await send(page, "do two things in parallel");

  // Approvals are asked one at a time even though the model emitted both calls together.
  await allowOnce(page);
  await allowOnce(page);

  await expect(page.getByText("Done. Here is what I found in the workspace.")).toBeVisible({ timeout: 30_000 });
  // Both calls of the batch made it into the transcript, not just whichever finished first.
  await expect(page.getByText("read_file", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("list_dir", { exact: true }).first()).toBeVisible();
});

test("gap 3: a notebook is read, edited, and the receipt says what changed", async ({ page }) => {
  await openAgentChat(page);
  await send(page, "fix up my notebook");

  await allowOnce(page); // read_notebook
  await allowOnce(page); // edit_notebook

  await expect(page.getByText("Notebook updated — cell 0 now reads the edited line.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/replaced cell 0/)).toBeVisible();
});

test("gap 5: load_skill fetches an installed skill's body and the answer follows it", async ({ page }) => {
  await openAgentChat(page);
  await send(page, "follow the code review checklist");

  await allowOnce(page); // load_skill "Code review"

  // The final answer quotes the fetched body, so the assertion proves the round trip: the skill
  // named in the tool call was looked up among the installed, enabled skills and its instructions
  // came back as the tool result.
  await expect(page.getByText(/Following the loaded checklist: .*Review the change the user points at/)).toBeVisible({
    timeout: 30_000,
  });
});

test("gap 6: a background command starts, is polled by id, and reports its output", async ({ page }) => {
  await openAgentChat(page);
  await send(page, "start a background job");

  await allowOnce(page); // run_command background:true
  await allowOnce(page); // process_output { job: "bg-0", ... }

  await expect(page.getByText("Background job finished — its output: bg work done")).toBeVisible({ timeout: 30_000 });
  // The poll targeted the id the start receipt named.
  await expect(page.getByText(/process_output/).first()).toBeVisible();
});

test("gap 4: generate_image produces bytes, saves them in the workspace, and reports the path", async ({ page }) => {
  await openAgentChat(page);
  await send(page, "draw me a pixel");

  await allowOnce(page); // generate_image (loop-handled: gateway image route + write_file)

  // The loop's receipt names the written path; the transcript also shows the follow-up user turn
  // that carries the image part (the transcript stores text, so the part appears as its marker).
  await expect(page.getByText(/generated and saved: images\/drawn\.png/)).toBeVisible({ timeout: 30_000 });
  // The bytes really landed in the sandbox — a receipt alone would pass even if the write failed.
  await expect
    .poll(() => page.evaluate(() => Object.keys((window as unknown as WebTest).__webTest.vfs())))
    .toContain("images/drawn.png");
});
