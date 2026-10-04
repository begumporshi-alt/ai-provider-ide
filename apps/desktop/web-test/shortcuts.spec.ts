/**
 * web-test/shortcuts.spec.ts — Phase 8: the keyboard layer, the palette, and conversation search.
 *
 * # What is worth proving here
 *
 * A shortcut is the easiest kind of feature to ship as a decoration: the listener exists, the
 * handler is called, and nothing observable happened. So every assertion below is about an effect
 * the user can see — a different screen, a cleared transcript, a stopped request, a filtered list,
 * a caret that actually has focus — rather than about a key having been pressed.
 *
 * The palette gets the most attention because it is the one piece that can *lie*: it lists
 * commands, and a row that does nothing is worse than a missing row. Two of those rows
 * ("New chat" while a turn runs, "already open" for the current screen) are asserted to say so
 * and to refuse.
 *
 * # Which chords
 *
 * `mod` is Cmd on macOS and Ctrl everywhere else, and the app decides that from the platform at
 * runtime — so this spec asks the *page* which one it is (`modOf`) rather than assuming the
 * runner's OS. The probe that made this necessary: the harness reports `MacIntel` while claiming a
 * Windows user agent, so a hardcoded `Control` pressed a chord the app had not bound and every test
 * here failed at the first keypress. The unit tests in `lib/keys/shortcuts.test.ts` are where both
 * branches are pinned; this file proves the wiring end-to-end on whichever platform it runs.
 *
 * `Control+N` is deliberately bound by nothing: browsers keep it for "new window" and the packaged
 * app's native menu keeps it too, which is why new chat is on `mod+Shift+O`.
 */
import { expect, test, type Page } from "@playwright/test";
import { pickModel } from "./model-picker";

const APP = "/web-test/";

/**
 * How long to wait for the reply bubble after a Send. Omitting the timeout would inherit the
 * config's expect budget (60 s on CI, 30 s locally), but these waits are written per-test because
 * the two-turn search test spends the budget twice — so the constant is explicit and CI-scaled,
 * and the search test additionally calls test.slow() to keep the sum inside its own budget.
 */
const REPLY_TIMEOUT = process.env.CI ? 60_000 : 30_000;

/**
 * The modifier the app itself would use here, read from the page for the same reason the app reads
 * it: the platform is a runtime fact, not a property of the test runner.
 */
async function modOf(page: Page): Promise<string> {
  const mac = await page.evaluate(() =>
    /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent),
  );
  return mac ? "Meta" : "Control";
}

/**
 * The extra 100 s these tests used to spend is worth naming: each failing keypress waited for a
 * locator that could never appear. A chord helper that keeps the platform in one place means a
 * wrong chord fails on the first assertion instead of timing out — and `expectPaletteOpen` below
 * is the assertion that makes it fail fast.
 */
async function pressMod(page: Page, key: string): Promise<void> {
  await page.keyboard.press(`${await modOf(page)}+${key}`);
}

/** Open the palette and assert it opened, so a chord mistake is a clear failure, not a timeout. */
async function openPalette(page: Page): Promise<void> {
  await pressMod(page, "k");
  await expect(page.getByRole("dialog", { name: "Commands" })).toBeVisible({ timeout: 5_000 });
}

/**
 * Send a prompt whose reply takes seconds instead of milliseconds.
 *
 * The mock answers immediately by default, which makes "the turn is still running" untestable: the
 * Stop button can be asserted visible and the turn can still be over before the next key arrives.
 * `slow:` is the mock's opt-in delayed stream (see `web-test/mock.mjs`), so any test that acts ON a
 * running turn sends this.
 *
 * Every "Stop" locator in this file is anchored (`/Stop$/`), and that is not a style preference: the
 * button's accessible name is "■ Stop" while the trace line under the composer reads "✕ stopped by
 * you · 680ms", and Playwright's accessible-name match is a case-insensitive *substring* by default
 * — so a lax `name: "Stop"` matched the trace line as well, and the assertion "the turn is still
 * running" was satisfied by the sentence saying it had been stopped.
 */
async function sendSlowTurn(page: Page): Promise<void> {
  await page.getByPlaceholder(/Message your assistant/).fill("slow: hold the line");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: /Stop$/ })).toBeVisible({ timeout: 10_000 });
}

/**
 * Wait for the turn to actually end — the status line with the mock's latency only renders when
 * the run has finished. The palette refuses New chat while a turn runs (by design), so a chord
 * pressed before this line exists is silently eaten: measured against CI failure artifacts
 * (2026-10-04), both flaky shortcuts failures were the chord landing mid-run — locally the mock's
 * reply beats the keypress, on the 2.5× slower runner it does not.
 */
async function awaitTurnDone(page: Page): Promise<void> {
  await expect(page.getByText("System AI (mock)")).toBeVisible({ timeout: REPLY_TIMEOUT });
}

async function openAssistant(page: Page): Promise<void> {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
}

/** Last body sent to /chat/completions — proves a turn really went out. */
async function chatRequests(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (
        (window as unknown as { __webTest: { store: Record<string, () => unknown> } }).__webTest.store
          .requests!() as { url: string; body: string | null }[]
      ).filter((r) => r.url.endsWith("/chat/completions") && r.body).length,
  );
}

test("the palette opens from anywhere, filters, and navigates", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);

  // From a screen that is not the Assistant: the listener has to be global, because `App` mounts
  // one screen at a time and a screen-owned listener would not exist on the others.
  await page.getByRole("button", { name: "AI Providers", exact: true }).click();
  await openPalette(page);

  const palette = page.getByRole("dialog", { name: "Commands" });
  await expect(palette).toBeVisible();
  // Every current screen is listed, so the palette cannot be narrower than the sidebar.
  await expect(palette.getByRole("option", { name: /Model Browser/ })).toBeVisible();
  await expect(palette.getByRole("option", { name: /Search conversations/ })).toBeVisible();
  // …and the row for the screen already open says so rather than pretending to navigate.
  await expect(palette.getByRole("option", { name: /AI Providers/ })).toContainText("already open");

  await page.getByLabel("Command palette search").fill("history");
  await page.keyboard.press("Enter");

  // The palette closed and the screen changed — both halves, because a palette that navigates but
  // stays open covers the thing it navigated to. The assertion is the screen's own heading, not its
  // search box: History with no recorded sessions renders its empty state and no search box at all
  // (there is nothing to search), and that is a different test's subject.
  await expect(palette).toBeHidden();
  await expect(page.getByRole("heading", { name: "History", exact: true })).toBeVisible();
});

test("Escape closes the palette and does not also stop the turn behind it", async ({ page }) => {
  await openAssistant(page);
  await pickModel(page, /oracle-mini/);

  // Wait for the stop button: it only exists while the turn is in flight, which is the state this
  // test needs. Without it the assertions below would pass on a turn that had already finished.
  await sendSlowTurn(page);
  const stop = page.getByRole("button", { name: /Stop$/ });

  await openPalette(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Commands" })).toBeHidden();

  // Escape belonged to the dialog. If the Assistant's own Escape handler had run too, the stop
  // button would be gone and the transcript would say "stopped by you".
  await expect(stop).toBeVisible();
  await expect(page.getByText(/stopped by you/)).toHaveCount(0);
});

test("the shortcut sheet lists the keys the app actually binds", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await pressMod(page, "/");

  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet).toContainText("Stop the running turn");
  // The sheet prints the chord for the platform it is running on, so the assertion accepts either
  // notation and both cases are pinned in the unit tests rather than here.
  await expect(sheet).toContainText(/Ctrl\+K|⌘K/);
  await expect(sheet).toContainText(/Ctrl\+Shift\+O|⌘⇧O/);
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
});

test("the other platform's chord stays free", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  const other = (await modOf(page)) === "Meta" ? "Control" : "Meta";

  // The positive case is the test above; this is the one that matters for not breaking anything.
  // On macOS, Ctrl+K is "kill to end of line" inside a text field, and hijacking it to open a
  // palette would corrupt editing in the composer — so the app must *not* answer to it.
  await page.keyboard.press(`${other}+k`);
  await expect(page.getByRole("dialog", { name: "Commands" })).toHaveCount(0);
  await page.keyboard.press(`${other}+/`);
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
});

test("new chat starts a fresh conversation from the keyboard", async ({ page }) => {
  await openAssistant(page);
  await pickModel(page, /oracle-mini/);

  await page.getByPlaceholder(/Message your assistant/).fill("remember this");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("div.whitespace-pre-wrap").last()).toBeVisible({ timeout: REPLY_TIMEOUT });
  await expect(page.getByText("remember this")).toBeVisible();
  await awaitTurnDone(page);

  await pressMod(page, "Shift+O");

  // The transcript is cleared — the user's own text is gone, which is the observable part of
  // "new conversation". The session bar's title resets with it.
  await expect(page.getByText("remember this")).toHaveCount(0);
});

test("Escape stops a running turn", async ({ page }) => {
  await openAssistant(page);
  await pickModel(page, /oracle-mini/);

  await sendSlowTurn(page);

  await page.keyboard.press("Escape");

  // The permanent trace line is the evidence that the abort reached the request rather than just
  // repainting the button.
  await expect(page.getByText(/stopped by you/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: /Stop$/ })).toBeHidden();
});

test("Escape does nothing when no turn is running", async ({ page }) => {
  await openAssistant(page);
  await pickModel(page, /oracle-mini/);

  await page.getByPlaceholder(/Message your assistant/).fill("draft text");
  await page.keyboard.press("Escape");

  // Not swallowed: the composer keeps what was typed, and no transcript appeared. A shortcut that
  // fires with nothing to act on is how a key silently stops meaning what it meant.
  await expect(page.getByPlaceholder(/Message your assistant/)).toHaveValue("draft text");
  await expect(page.getByText(/stopped by you/)).toHaveCount(0);
});

test("the palette refuses New chat while a turn is running, and says why", async ({ page }) => {
  await openAssistant(page);
  await pickModel(page, /oracle-mini/);

  await sendSlowTurn(page);

  await openPalette(page);
  const row = page.getByRole("dialog", { name: "Commands" }).getByRole("option", { name: /New chat/ });
  await expect(row).toBeDisabled();
  await expect(row).toContainText("a turn is running");

  // Refused, not merely greyed: clicking must not clear a transcript mid-stream.
  await row.click({ force: true }).catch(() => undefined);
  await expect(page.getByRole("button", { name: /Stop$/ })).toBeVisible();
});

test("conversation search filters the session list and keeps the detail in step", async ({ page }) => {
  // Two full turns inside one test: the reply waits (REPLY_TIMEOUT each) and the turns themselves
  // have to fit the per-test budget, and on the slow hosted runner two of everything did not.
  test.slow();
  await openAssistant(page);
  await pickModel(page, /oracle-mini/);

  // Two sessions with distinguishable text, so a filter can be shown to keep one and drop the other.
  for (const text of ["alpha conversation", "beta conversation"]) {
    await page.getByPlaceholder(/Message your assistant/).fill(text);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator("div.whitespace-pre-wrap").last()).toBeVisible({ timeout: REPLY_TIMEOUT });
    await awaitTurnDone(page);
    await pressMod(page, "Shift+O");
  }

  await page.getByRole("button", { name: "History", exact: true }).click();
  // Both sessions are listed before filtering — without this the assertion below could pass on a
  // History screen that simply had one row.
  await expect(page.getByTestId("history-session")).toHaveCount(2);
  await expect(page.getByText(/2 sessions/)).toBeVisible();

  const box = page.getByLabel("Search conversations");
  await box.fill("alpha");

  await expect(page.getByTestId("history-session")).toHaveCount(1);
  // The count reads "1 of 2": what is shown, and how much is hidden.
  await expect(page.getByText(/1 of 2/)).toBeVisible();
  // The detail pane follows the filter instead of showing the row that was hidden.
  await expect(page.getByText("alpha conversation").first()).toBeVisible();

  await box.fill("no such conversation anywhere");
  await expect(page.getByTestId("history-session")).toHaveCount(0);
  await expect(page.getByText(/No session matches/)).toBeVisible();
});

test("the palette's Search conversations focuses the History box", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  // One recorded session first. History with nothing in it renders its empty state and *no* search
  // box — searching an empty store is not a thing to offer — so the command's destination only
  // exists once there is something to search.
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);
  await page.getByPlaceholder(/Message your assistant/).fill("hello there");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("div.whitespace-pre-wrap").last()).toBeVisible({ timeout: REPLY_TIMEOUT });
  // The session is recorded when the run ENDS, not when the reply text first appears — searching
  // before that found a History with no sessions and no search box (CI artifact, 2026-10-04).
  await awaitTurnDone(page);

  await openPalette(page);
  await page.getByLabel("Command palette search").fill("search conv");
  await page.keyboard.press("Enter");

  // Focus, not just navigation: the command is called "Search conversations", and landing on the
  // screen with the box unfocused means the user still has to click before they can type.
  await expect(page.getByLabel("Search conversations")).toBeFocused();
  await page.keyboard.type("anything");
  await expect(page.getByLabel("Search conversations")).toHaveValue("anything");
});

test("the palette's Focus the composer puts the caret in it", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  await openPalette(page);
  await page.getByLabel("Command palette search").fill("focus the composer");
  await page.keyboard.press("Enter");

  const composer = page.getByPlaceholder(/Message your assistant/);
  await expect(composer).toBeFocused();
  await page.keyboard.type("typed without clicking");
  await expect(composer).toHaveValue("typed without clicking");
  // Nothing was sent by typing: focus is not send.
  expect(await chatRequests(page)).toBe(0);
});
