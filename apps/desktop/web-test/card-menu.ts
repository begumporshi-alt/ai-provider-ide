/**
 * Provider-card "⋯" menu interaction (shared by the web-test specs).
 *
 * The card actions — Check health, Edit, Remove, Repair… — moved into a `⋯` menu (the kebab
 * refactor). The specs still clicked them as if they were first-class buttons on the card, so
 * every spec that staged a repair had been failing. The menu is `role="menu"` with
 * `role="menuitem"` entries; the trigger is `aria-label="Actions for <provider name>"`.
 *
 * Pass a card locator when more than one provider is on screen (scope it with a `<section>`
 * filter), otherwise the unscoped lookup is fine for a single-provider seed.
 */
import { type Locator, type Page } from "@playwright/test";

export async function cardAction(page: Page, action: string | RegExp, card?: Locator): Promise<void> {
  const scope = card ?? page;
  await scope.getByRole("button", { name: /^Actions for / }).click();
  await scope.getByRole("menuitem", { name: action }).click();
}
