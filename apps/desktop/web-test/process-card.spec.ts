/**
 * web-test/process-card.spec.ts — the live process card, driven through the real agent loop.
 *
 * A background `run_command` outlives the tool call that started it, and until now the person
 * watched nothing: the row said "started background job bg-N" and the work — a dev server, a
 * long build — happened invisibly until the model happened to poll. The card under that row
 * polls the same `process_output` sandbox tool the model does, and this spec asserts on what it
 * actually renders: the running state while the job works, the output tail it prints, and the
 * honest exit when the job finishes.
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

test("a running background job is visible: live status, output tail, honest exit", async ({ page }) => {
  await openAgentChat(page);
  await send(page, "watch the bg job");

  await allowOnce(page); // run_command background:true — the model then ends its turn.

  // The card appears while the job is still working and names the id the receipt minted.
  const card = page.getByTestId("process-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText(/bg-\d+ — running/);

  // The tail is live: the shim's node job prints once at ~1s, so a card that only rendered the
  // start receipt's one-liner would never show it.
  await expect(card).toContainText("starting bg work", { timeout: 15_000 });

  // And the exit is the sandbox's own label, not a guess — the same text a `process_output`
  // poll would have handed the model.
  await expect(card).toContainText(/bg-\d+ — exited \(code 0\)/, { timeout: 15_000 });
  await expect(card).toContainText("bg work done");

  // The turn's own answer arrived too — the card supplements the transcript, it does not replace it.
  await expect(page.getByText("Started. The job keeps running on its own.")).toBeVisible();
});

test("the card's stop button ends the job the user did not ask to keep running", async ({ page }) => {
  await openAgentChat(page);
  await send(page, "watch the bg job");

  await allowOnce(page);

  const card = page.getByTestId("process-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText(/bg-\d+ — running/);

  // The job runs 5s in the shim — the click lands well inside that window, so the exit the card
  // then reports can only be the kill's, not a natural one.
  const stop = page.getByTestId("process-stop");
  await expect(stop).toBeVisible();
  await stop.click();
  await expect(stop).toContainText("stopping…");

  // The next poll reads the sandbox's own verdict: a killed job has no exit code, so Rust writes
  // -1 (`code().unwrap_or(-1)`) — and the stop button goes with the running state it belongs to.
  await expect(card).toContainText(/bg-\d+ — exited \(code -1\)/, { timeout: 15_000 });
  await expect(page.getByTestId("process-stop")).toHaveCount(0);

  // The turn still concluded — stopping a job stops the work, not the conversation.
  await expect(page.getByText("Started. The job keeps running on its own.")).toBeVisible();
});
