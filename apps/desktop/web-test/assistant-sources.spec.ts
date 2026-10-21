/**
 * web-test/assistant-sources.spec.ts — choosing another agent's session from the Assistant.
 *
 * The Sources screen manages the inventory; this is the retrieval half: open the session chip
 * menu, browse the source sessions, search, and Use one. The import is a snapshot, and the
 * Assistant continues the imported session in place — the imported turns appear in the transcript
 * and the chip carries the source session's name.
 */
import { expect, test, type Page } from "@playwright/test";
import { pickModel } from "./model-picker";

const APP = "/web-test/";

async function openAssistant(page: Page) {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);
}

test("assistant: a source session can be selected and becomes the conversation", async ({
  page,
}) => {
  await openAssistant(page);

  // The session chip is the single door into session actions.
  await page.getByRole("button", { name: /untitled session/ }).click();
  await page.getByRole("menuitem", { name: /Browse sources/ }).click();

  const picker = page.getByRole("dialog", { name: "Sessions from other agents" });
  await expect(picker).toBeVisible();
  await expect(picker.getByTestId("source-picker-row")).toHaveCount(2);

  // Search narrows across sources, then Use imports the one chosen.
  await picker.getByLabel("Search sessions from other agents").fill("refresh");
  await expect(picker.getByTestId("source-picker-row")).toHaveCount(1);
  await expect(picker.getByTestId("source-picker-row").first()).toHaveAttribute(
    "data-source",
    "claude",
  );
  await picker.getByRole("button", { name: "Use sess_1 from claude" }).click();
  await expect(picker).toHaveCount(0);

  // The imported transcript is the current conversation: both turns, including the sentence that
  // exists only in the foreign session.
  await expect(
    page.getByText("How do we rotate the refresh token?").first(),
  ).toBeVisible();
  await expect(
    page.getByText(/keep the previous token valid for one overlap window/).first(),
  ).toBeVisible();
  // The chip names the adopted session rather than "untitled session".
  await expect(
    page.getByRole("button", { name: "Claude: auth flow sketch" }),
  ).toBeVisible();
});
