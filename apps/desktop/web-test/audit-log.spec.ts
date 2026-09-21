/**
 * web-test/audit-log.spec.ts — the Control → Tools audit-trail reader.
 *
 * The gap this closes: `gateway.log` has been appended to on every gateway tool call since
 * 2026-09-20, and nothing could read it. The card on Control → Tools even said so — "Recorded today;
 * a reader lands with §6 must-have 9" — which made the trail *evidence nobody could consult*: the log
 * exists to answer "what did an agent do on this machine", and the only answer was a file path the UI
 * never mentioned.
 *
 * Branches are deliberately cross-checked, so none of the assertions is vacuous:
 *
 *   1. **Empty is not failed.** A gateway that has never run a tool answers `[]`, and the card must
 *      say "none has run" rather than reporting a failure. The two are asserted in separate tests and
 *      each asserts the *other's* copy is absent — a card that rendered one sentence for both would
 *      pass either test on its own.
 *   2. **A line with no timestamp is kept.** `log_to_file` is called from paths that write bare
 *      lines, and those are startup evidence. It renders a placeholder rather than inventing a time.
 *
 * The host owns `{app_data_dir}/gateway.log`, so these states cannot be produced from the UI and are
 * arranged through `__webTest.logLines` and `__webTest.failNext`.
 *
 * **Every test seeds the host's answer after the Tools tab has mounted and before the disclosure is
 * opened.** That ordering is what pins "the log is read on demand": a read that happened at mount
 * would have taken the empty default and, having been marked as tried, would never look again — so
 * the seeded lines could not appear. An earlier draft had a fifth test asserting exactly this by
 * refreshing; it was deleted, because with the seed placed here it could only restate the others.
 */
import { expect, test, type Page } from "@playwright/test";

const APP = "/web-test/";

type Line = { tsMs: number | null; text: string };
type Host = {
  logLines: (next: Line[]) => void;
  failNext: (cmd: string, message: string) => void;
};

/** The audit list, scoped so a `listitem` elsewhere on the screen cannot satisfy an assertion. */
function auditList(page: Page) {
  return page.getByRole("list", { name: "Gateway tool audit log" });
}

/** Control → Tools, mounted, with the detail disclosure still closed. */
async function openToolsTab(page: Page): Promise<void> {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Control" }).click();
  await expect(page.getByRole("heading", { name: "Control" })).toBeVisible({ timeout: 10_000 });
  // `tab`, not `button`: Control's Findings list renders jump buttons labelled with tab names too.
  await page.getByRole("tab", { name: "Tools" }).click();
  // The switch, not the heading: it proves this tab mounted, which a heading would not.
  await expect(page.getByRole("switch", { name: "Gateway tools" })).toBeVisible({ timeout: 10_000 });
}

/** Arrange what the host will answer, then open the disclosure that reads it. */
async function openDetail(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Show detail" }).click();
  await expect(page.getByText("Audit trail")).toBeVisible();
}

test("a log with tool calls renders them oldest first, each with its stamp", async ({ page }) => {
  await openToolsTab(page);
  await page.evaluate(
    (l) => (window as unknown as { __webTest: Host }).__webTest.logLines(l),
    [
      { tsMs: 1_756_000_000_000, text: "run_command ls -la" },
      { tsMs: 1_756_000_060_000, text: "write_file src/main.rs bytes=1204" },
      { tsMs: 1_756_000_120_000, text: "read_file src/lib.rs" },
    ] satisfies Line[],
  );
  await openDetail(page);

  const items = auditList(page).getByRole("listitem");
  await expect(items).toHaveCount(3);

  // Oldest first, newest last — a tail read is only useful if the recent end is at the bottom.
  await expect(items.nth(0)).toContainText("run_command ls -la");
  await expect(items.nth(2)).toContainText("read_file src/lib.rs");

  // A stamp, in `MM-DD HH:MM:SS`. Asserted by shape and not by value: the formatter is local-time,
  // so an exact string would make this spec fail in another timezone rather than catch a bug.
  await expect(items.nth(0)).toContainText(/\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);

  // The copy that promised a reader is gone; the promise is now the card.
  await expect(page.getByText(/must-have 9/)).toHaveCount(0);
});

test("a line with no timestamp is kept and renders without inventing a time", async ({ page }) => {
  await openToolsTab(page);
  await page.evaluate(
    (l) => (window as unknown as { __webTest: Host }).__webTest.logLines(l),
    [
      { tsMs: null, text: "gateway worker booting" },
      { tsMs: 1_756_000_000_000, text: "run_command ls" },
    ] satisfies Line[],
  );
  await openDetail(page);

  const items = auditList(page).getByRole("listitem");
  await expect(items).toHaveCount(2);

  // The evidence survives...
  await expect(items.nth(0)).toContainText("gateway worker booting");
  // ...and the placeholder is the em dash, not a fabricated time.
  await expect(items.nth(0)).toContainText("—");
  await expect(items.nth(0)).not.toContainText(/\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);

  // The cross-check: a stamped line in the same list still gets its stamp, so the assertion above is
  // about this line rather than about the list failing to render stamps at all.
  await expect(items.nth(1)).toContainText(/\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
});

test("an empty log reads as 'none has run', not as a failure", async ({ page }) => {
  // The default answer is `[]`, which is also what a gateway that has never run a tool returns.
  await openToolsTab(page);
  await openDetail(page);

  await expect(page.getByText(/No tool calls recorded yet/)).toBeVisible();
  // The distinction the card exists to make, asserted from both sides.
  await expect(page.getByText(/Could not read the log/)).toHaveCount(0);
  await expect(auditList(page)).toHaveCount(0);
});

test("a read that fails says so, and does not read as an empty log", async ({ page }) => {
  await openToolsTab(page);
  await page.evaluate(() =>
    (window as unknown as { __webTest: Host }).__webTest.failNext(
      "gateway_log_tail",
      "web-test shim: arranged failure",
    ),
  );
  await openDetail(page);

  await expect(page.getByText(/Could not read the log/)).toBeVisible();
  await expect(page.getByText(/arranged failure/)).toBeVisible();
  // If these two shared a sentence, "the file could not be read" would look like "no tools have run".
  await expect(page.getByText(/No tool calls recorded yet/)).toHaveCount(0);
});

test("a failed refresh drops the previous lines rather than leaving them under the error", async ({
  page,
}) => {
  await openToolsTab(page);
  await page.evaluate(
    (l) => (window as unknown as { __webTest: Host }).__webTest.logLines(l),
    [{ tsMs: 1_756_000_000_000, text: "run_command ls" }] satisfies Line[],
  );
  await openDetail(page);

  // The first read succeeded, so there is something on screen to go stale.
  await expect(auditList(page).getByRole("listitem")).toHaveCount(1);

  // The host stops answering, and the operator asks again.
  await page.evaluate(() =>
    (window as unknown as { __webTest: Host }).__webTest.failNext(
      "gateway_log_tail",
      "web-test shim: arranged failure",
    ),
  );
  await page.getByRole("button", { name: "Refresh" }).click();

  await expect(page.getByText(/Could not read the log/)).toBeVisible();
  // The line is gone, not merely annotated: a stale tail rendered under a failure notice is a claim
  // about *now*, and this is the one card that must not claim a line is current when the read that
  // would have shown it is the read that failed.
  await expect(page.getByText("run_command ls")).toHaveCount(0);
  await expect(auditList(page)).toHaveCount(0);
  // And the button offers a fresh read rather than a refresh of what is no longer displayed.
  await expect(page.getByRole("button", { name: "Read the log" })).toBeVisible();
});
