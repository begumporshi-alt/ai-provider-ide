/**
 * Select a model in the Assistant's picker (shared by the web-test specs).
 *
 * The picker has not been a native `<select>` since commit 721c115, which replaced it with a
 * button that opens a searchable `role="listbox"` panel. The specs kept driving
 * `getByRole("combobox")`, which no longer matches anything — so every test that picked a model
 * (and the two Assistant stories that only needed a picker *to exist*) failed. This is the single
 * place the interaction lives now; fix it here rather than in each spec.
 *
 * `match` is tested against the option's label, which carries the provider slug (`slug/nativeId`).
 *
 * Both the text and image pickers are always mounted; the inactive tab is hidden with CSS, which
 * removes it from the accessibility tree — so only the visible picker's button and options match.
 */
import { type Page } from "@playwright/test";

export async function pickModel(page: Page, match: RegExp): Promise<void> {
  await page.getByRole("button", { name: /open picker/ }).click();
  await page.getByRole("option").filter({ hasText: match }).first().click();
}

/**
 * The Assistant's picker button, for tests that only need its position rather than a selection.
 * Same staleness fix as `pickModel`.
 */
export function pickerButton(page: Page) {
  return page.getByRole("button", { name: /open picker/ });
}
