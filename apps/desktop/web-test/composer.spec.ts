/**
 * web-test/composer.spec.ts — Phase 3: attachments, slash commands and `@`-references.
 *
 * # What is worth proving
 *
 * Phase 3's riskiest part is not the textarea growing; it is that an image **reaches the provider**.
 * There are six steps between a dropped file and a `image_url` part on the wire (read → state →
 * request → `ContentPart` → manifest template → body), and five of them can fail while the UI still
 * looks right. So the primary assertion is on what the request carried, and the harness's mock
 * reports the number of image parts it received in its own reply, which makes the same fact visible
 * in the transcript.
 *
 * The second thing worth proving is the gate: attaching to a model that does not accept images must
 * be refused *and said out loud*. A silent no-op on a dropped file is indistinguishable from a
 * broken app.
 *
 * # The three vision states
 *
 * `?seed=systemai` deliberately carries all of them: `oracle-vision` declares image input,
 * `oracle-flash` is reachable and declares nothing, and a provider that publishes no capabilities
 * at all yields the third. The UI must treat "unknown" differently from "no" — the tests below check
 * the wording, because that difference is what stops a user concluding their model is worse than it is.
 */
import { expect, test, type Page } from "@playwright/test";
import { pickModel } from "./model-picker";

const APP = "/web-test/";

/** 1×1 PNG as base64 — a real image, small enough to inline in the test. */
const PNG_1PX_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

interface EgressLogEntry { url: string; body: string | null }
interface WireMessage { role: string; content: unknown }

/**
 * The user turn on the wire.
 *
 * By role, never by index: the no-tools guard is prepended as a system message, so `messages[0]` is
 * the system prompt and a test that asserted on it would be checking the guard rather than the
 * attachment.
 */
function userTurn(body: Record<string, unknown>): WireMessage {
  const msgs = body.messages as WireMessage[];
  const user = msgs.find((m) => m.role === "user");
  expect(user, "no user message on the wire").toBeDefined();
  return user!;
}

async function lastChatBody(page: Page): Promise<Record<string, unknown>> {
  const reqs = await page.evaluate(
    () =>
      (
        (window as unknown as { __webTest: { store: Record<string, () => unknown> } }).__webTest.store
          .requests!() as EgressLogEntry[]
      ),
  );
  const last = [...reqs].reverse().find((r) => r.url.endsWith("/chat/completions") && r.body);
  expect(last, "no chat request was sent").toBeDefined();
  return JSON.parse(last!.body!) as Record<string, unknown>;
}

async function openAssistant(page: Page, model: RegExp): Promise<void> {
  await page.goto(`${APP}?seed=systemai`);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, model);
}

/** Attach a file through the real picker input (the same path a click takes). */
async function attach(page: Page, name: string, mimeType: string, buffer: Buffer): Promise<void> {
  await page.getByTestId("composer-file-input").setInputFiles({ name, mimeType, buffer });
}

test("an attached image reaches the provider as an image part", async ({ page }) => {
  await openAssistant(page, /oracle-vision/);

  await attach(page, "pixel.png", "image/png", Buffer.from(PNG_1PX_BASE64, "base64"));
  // The chip is the user's only evidence the file was read, so it is asserted before the send.
  await expect(page.getByTestId("attachment-chip")).toContainText("pixel.png");

  await page.getByTestId("composer-input").fill("what is this?");
  await page.getByRole("button", { name: "Send" }).click();

  // 1. The wire: OpenAI's shape, with the bytes as a data URI (the dialect's own template did that).
  const body = await lastChatBody(page);
  expect(userTurn(body).content).toEqual([
    { type: "text", text: "what is this?" },
    { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_1PX_BASE64}` } },
  ]);

  // 2. The reply: the mock counts the image parts it received, so the transcript proves the whole
  //    chain rather than only the request.
  await expect(page.getByText(/Seen 1 image in this request/)).toBeVisible({ timeout: 30_000 });
  // 3. The transcript shows the image with the turn it belonged to.
  await expect(page.getByTestId("sent-image")).toBeVisible();
});

test("an image survives the next turn, so a follow-up can refer to it", async ({ page }) => {
  await openAssistant(page, /oracle-vision/);
  await attach(page, "pixel.png", "image/png", Buffer.from(PNG_1PX_BASE64, "base64"));
  await page.getByTestId("composer-input").fill("what is this?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/Seen 1 image/)).toBeVisible({ timeout: 30_000 });

  // A second turn, with a second image attached. The count is the assertion: the request carries the
  // replayed first image *and* the new one. If replay dropped the first, the reply would say 1 — and
  // "what about the first one?" would be a question about a picture the provider never received.
  await attach(page, "second.png", "image/png", Buffer.from(PNG_1PX_BASE64, "base64"));
  await page.getByTestId("composer-input").fill("and now?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/Seen 2 images in this request/)).toBeVisible({ timeout: 30_000 });
});

test("an image is refused for a model that does not declare image input, and says so", async ({ page }) => {
  await openAssistant(page, /oracle-flash/);

  await attach(page, "pixel.png", "image/png", Buffer.from(PNG_1PX_BASE64, "base64"));

  // Refused, and explained. Nothing was attached, so there is no chip.
  await expect(page.getByTestId("attachment-chip")).toHaveCount(0);
  await expect(page.getByTestId("composer-notice")).toContainText("does not declare image input");

  // And the refusal is real: a text-only send carries a plain string, not an empty part array.
  await page.getByTestId("composer-input").fill("just text then");
  await page.getByRole("button", { name: "Send" }).click();
  const body = await lastChatBody(page);
  expect(userTurn(body).content).toBe("just text then");
});

test("a text file is appended to the draft rather than turned into a part", async ({ page }) => {
  await openAssistant(page, /oracle-flash/);

  await attach(page, "notes.md", "text/markdown", Buffer.from("# Notes\n\nSome context.\n", "utf8"));

  // Visible and editable in the box, which is what a text file is: context, not an attachment.
  const composer = page.getByTestId("composer-input");
  await expect(composer).toHaveValue(/notes\.md:/);
  await expect(composer).toHaveValue(/Some context\./);
  await expect(page.getByTestId("attachment-chip")).toHaveCount(0);
});

test("the slash menu lists commands, and /image switches the tab", async ({ page }) => {
  await openAssistant(page, /oracle-flash/);

  await page.getByTestId("composer-input").type("/");
  const menu = page.getByRole("listbox", { name: "Slash commands" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("option", { name: /compact/ })).toBeVisible();

  // Typing the whole name and pressing Enter runs it (the menu closes once the name is complete).
  await page.getByTestId("composer-input").type("image");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Image", exact: true })).toHaveAttribute("style", /--surface-2/);
  // The draft is consumed by the command, not left behind to be sent as a message.
  await expect(page.getByTestId("composer-input")).toHaveValue("");
});

test("/model opens the picker", async ({ page }) => {
  await openAssistant(page, /oracle-flash/);
  await page.getByTestId("composer-input").type("/model");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox", { name: "Pick a model" })).toBeVisible();
});

test("/clear starts a new conversation", async ({ page }) => {
  await openAssistant(page, /oracle-mini/);
  await page.getByTestId("composer-input").fill("remember this text");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("remember this text").first()).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("composer-input").type("/clear");
  await page.keyboard.press("Enter");

  await expect(page.getByText("remember this text")).toHaveCount(0);
});

test("a slash that is not a command stays a message", async ({ page }) => {
  await openAssistant(page, /oracle-mini/);
  // No menu, and Enter sends it: the check that the command layer does not swallow real prompts.
  await page.getByTestId("composer-input").fill("/clearer is a word, explain it");
  await expect(page.getByRole("listbox", { name: "Slash commands" })).toHaveCount(0);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("/clearer is a word, explain it").first()).toBeVisible({ timeout: 30_000 });
});

test("@-references list workspace files and are inlined into the request", async ({ page }) => {
  // The shim's workspace holds exactly one file (`README.md`, contents "hello\nworld\n"), and the
  // default root is already set, so the mention menu has something real to offer.
  await openAssistant(page, /oracle-mini/);

  await page.getByTestId("composer-input").type("summarise @read");
  const menu = page.getByTestId("mention-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("option", { name: /README\.md/ })).toBeVisible();

  await menu.getByRole("option", { name: /README\.md/ }).click();
  await expect(page.getByTestId("composer-input")).toHaveValue(/@README\.md/);

  await page.getByRole("button", { name: "Send" }).click();

  // The file's *contents* are in the request, not just its name — that is the whole point of the
  // reference, and the failure mode is a model answering about a file it never saw.
  const body = await lastChatBody(page);
  const wire = JSON.stringify(body);
  expect(wire).toContain("hello\\nworld");
  expect(wire).toContain("--- README.md ---");
});

test("a reference that matches nothing is reported, not silently dropped", async ({ page }) => {
  await openAssistant(page, /oracle-mini/);
  await page.getByTestId("composer-input").fill("read @does-not-exist.txt");
  await page.getByRole("button", { name: "Send" }).click();

  // The message still goes (the user may be asking about a path the agent should create) — but the
  // notice says the reference was not resolved, so an answer about nothing is not mistaken for an
  // answer about a file.
  await expect(page.getByText(/Not found in the workspace/)).toBeVisible({ timeout: 30_000 });
});

/* --------------------------------------------------------------------------------------------
 * "Add context": the menu that replaced a button whose chevron opened nothing.
 *
 * The four rows are worth testing for what they *do*, not for being listed: a menu that opens and
 * lists four labels is the shape the old button already faked. So each case below ends at the
 * consequence — the request on the wire, the draft's contents, or the refusal — because that is
 * where a wired-up-looking row can still be inert.
 * ------------------------------------------------------------------------------------------ */

/** The menu, opened from the one attach affordance. */
async function openContextMenu(page: Page) {
  await page.getByTestId("add-context-button").click();
  const menu = page.getByTestId("add-context-menu");
  await expect(menu).toBeVisible();
  return menu;
}

/** Every system message on the wire, joined — a per-turn instruction must appear in one of them. */
function systemText(body: Record<string, unknown>): string {
  const msgs = (body.messages ?? []) as WireMessage[];
  return msgs.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n---\n");
}

test("the menu is grouped, and every row is a real destination", async ({ page }) => {
  await openAssistant(page, /oracle-flash/);
  const menu = await openContextMenu(page);

  // Two groups, because the rows answer two different questions: what the model reads, versus how it
  // should behave. A flat list of four nouns is what makes a menu unreadable.
  await expect(menu).toContainText("What it reads");
  await expect(menu).toContainText("How it behaves this turn");

  await expect(menu.getByRole("menuitem", { name: /Upload files/ })).toBeEnabled();
  await expect(menu.getByRole("menuitem", { name: /Project files/ })).toBeEnabled();
  await expect(menu.getByRole("menuitem", { name: /Instructions/ })).toBeEnabled();
  // Nothing has been answered yet, so there is nothing to reuse — and the row says so rather than
  // being clickable into an empty list.
  await expect(menu.getByRole("menuitem", { name: /Previous results/ })).toBeDisabled();
  await expect(menu).toContainText("No earlier answer in this conversation yet");
});

test("arrows move through the rows and Enter opens the one they land on", async ({ page }) => {
  await openAssistant(page, /oracle-flash/);
  await openContextMenu(page);

  // The keyboard contract the slash and mention menus already have: the menu is usable without the
  // mouse, and a disabled row cannot trap the cursor.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("project-file-picker")).toBeVisible();
});

test("Project files adds a reference the send actually resolves", async ({ page }) => {
  // The shim's workspace holds exactly one file, `README.md` with contents "hello\nworld\n".
  await openAssistant(page, /oracle-mini/);
  const menu = await openContextMenu(page);
  await menu.getByRole("menuitem", { name: /Project files/ }).click();

  const picker = page.getByTestId("project-file-picker");
  await expect(picker).toBeVisible();
  await page.getByTestId("project-file-search").fill("read");
  await page.getByTestId("project-file-option").first().click();
  await page.getByRole("button", { name: /Add 1 reference/ }).click();

  // The draft gets the token, not the contents: a reference stays a reference until send, which is
  // what keeps the user's box readable.
  const input = page.getByTestId("composer-input");
  await expect(input).toHaveValue(/@README\.md/);

  // The case the badge exists for: eleven characters in the box that will put a whole file on the
  // wire at send time. The count is the only place that cost is visible.
  await expect(page.getByTestId("add-context-button")).toContainText("· 1");

  await input.fill("@README.md summarise this");
  await page.getByRole("button", { name: "Send" }).click();

  // And the reference is real: the file's bytes are in the request. A row that only inserted text
  // would look identical in the UI and send a model a question about a file it never saw.
  const body = await lastChatBody(page);
  expect(JSON.stringify(body)).toContain("hello\\nworld");
  expect(JSON.stringify(body)).toContain("--- README.md ---");
});

test("an instruction is sent as its own system message, not as the user's words", async ({ page }) => {
  await openAssistant(page, /oracle-flash/);

  const menu = await openContextMenu(page);
  await menu.getByRole("menuitem", { name: /Instructions/ }).click();
  await page.getByTestId("instruction-input").fill("Reply in Bangla only.");
  await page.getByRole("button", { name: "Use for this turn" }).click();

  // Visible before the send. An invisible constraint is one the user misremembers setting, which is
  // why this is a chip with a ✕ and not state held quietly in the composer.
  await expect(page.getByTestId("instruction-chip")).toContainText("Reply in Bangla only.");
  // And the button's own badge counts it, so "Add context" keeps claiming what it will carry.
  await expect(page.getByTestId("add-context-button")).toContainText("· 1");

  // Close the menu (a click outside; Escape has no target once the panel is gone).
  await page.mouse.click(8, 8);
  await expect(page.getByTestId("add-context-menu")).toHaveCount(0);

  await page.getByTestId("composer-input").fill("hello");
  await page.getByRole("button", { name: "Send" }).click();

  const body = await lastChatBody(page);
  // A system message, so the model reads it as a constraint…
  expect(systemText(body)).toContain("Reply in Bangla only.");
  // …and the user's turn is still exactly what they typed.
  expect(userTurn(body).content).toBe("hello");
});

test("the instruction applies to one turn only", async ({ page }) => {
  await openAssistant(page, /oracle-flash/);
  const menu = await openContextMenu(page);
  await menu.getByRole("menuitem", { name: /Instructions/ }).click();
  await page.getByTestId("instruction-input").fill("Be terse.");
  await page.getByRole("button", { name: "Use for this turn" }).click();
  await page.mouse.click(8, 8);

  await page.getByTestId("composer-input").fill("first");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 30_000 });

  // Cleared by the send it belonged to. A per-turn constraint that silently persists is how a user
  // concludes the model is ignoring them — they set it once, an hour ago.
  await expect(page.getByTestId("instruction-chip")).toHaveCount(0);
  await expect(page.getByTestId("add-context-button")).not.toContainText("·");
});

test("Previous results offers answers from this conversation and inserts one", async ({ page }) => {
  await openAssistant(page, /oracle-mini/);
  await page.getByTestId("composer-input").fill("remember this text");
  await page.getByRole("button", { name: "Send" }).click();
  // Idle again: the stop control is replaced by Send only when the run has finished.
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 30_000 });

  const menu = await openContextMenu(page);
  const row = menu.getByRole("menuitem", { name: /Previous results/ });
  await expect(row).toBeEnabled();
  await expect(menu).toContainText(/Reuse one of 1 earlier answer/);
  await row.click();

  await page.getByRole("menuitem", { name: /Answer 1/ }).click();

  // In the draft, where the user can read it and delete it — a reused answer is context the user
  // should be able to see, not a silent addition to the request.
  await expect(page.getByTestId("composer-input")).toHaveValue(/Previous result — Answer 1/);
});

test("a pasted image is attached, because a screenshot is the fastest context there is", async ({ page }) => {
  await openAssistant(page, /oracle-vision/);

  // The default paste handler does nothing with a screenshot on the clipboard, so this path did not
  // exist before. Dispatched as a real ClipboardEvent with a file, which is what a paste of an image
  // actually delivers.
  await page.getByTestId("composer-input").evaluate((el, b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    // Defined rather than passed to the constructor: `clipboardData` is a readonly member and some
    // Chromium builds ignore it in the init dictionary.
    Object.defineProperty(ev, "clipboardData", { value: dt });
    el.dispatchEvent(ev);
  }, PNG_1PX_BASE64);

  await expect(page.getByTestId("attachment-chip")).toContainText("pasted.png");

  await page.getByTestId("composer-input").fill("what is this?");
  await page.getByRole("button", { name: "Send" }).click();
  const body = await lastChatBody(page);
  expect(userTurn(body).content).toEqual([
    { type: "text", text: "what is this?" },
    { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_1PX_BASE64}` } },
  ]);
});

test("a pasted text is not swallowed by the file path", async ({ page }) => {
  await openAssistant(page, /oracle-mini/);

  // The other half of the paste handler: a paste with no files must stay an ordinary text paste, or
  // the composer would break the most common thing anyone does in a text box.
  await page.getByTestId("composer-input").focus();
  await page.keyboard.insertText("pasted as text");
  await expect(page.getByTestId("composer-input")).toHaveValue("pasted as text");
  await expect(page.getByTestId("attachment-chip")).toHaveCount(0);
});

test("a document is refused with the route that works, never inlined as text", async ({ page }) => {
  await openAssistant(page, /oracle-flash/);

  // `readAsText` does not fail on a PDF — it succeeds and returns garbage — so the failure this
  // guards against is not an error but a plausible draft full of compressed bytes.
  await attach(page, "paper.pdf", "application/pdf", Buffer.from("%PDF-1.4\n%\x00\x01 binary-ish\n"));

  await expect(page.getByTestId("composer-notice")).toContainText("not document files");
  // Nothing was appended: the refusal is total, not partial.
  await expect(page.getByTestId("composer-input")).toHaveValue("");
  await expect(page.getByTestId("attachment-chip")).toHaveCount(0);
  // And the notice names both working routes rather than only saying no.
  await expect(page.getByTestId("composer-notice")).toContainText("read_document");
});

test("a file with no telling extension is inspected before it is trusted", async ({ page }) => {
  await openAssistant(page, /oracle-flash/);

  // `.dat` says nothing and the browser reports octet-stream, so the only honest move is to look: a
  // NUL byte in the first KB is not something a text file does.
  await attach(page, "blob.dat", "application/octet-stream", Buffer.from([0x00, 0x01, 0x02, 0x03]));

  await expect(page.getByTestId("composer-notice")).toContainText("looks like a binary file");
  await expect(page.getByTestId("composer-input")).toHaveValue("");
});

test("a text file still lands in the draft, and the context meter now counts it", async ({ page }) => {
  await openAssistant(page, /oracle-flash/);

  // The meter is located by its tooltip because it is the only place the estimate is stated.
  const meter = page.locator('[title*="estimated prompt tokens"]');
  await expect(meter).toHaveAttribute("title", /^0 estimated prompt tokens/);

  await attach(page, "notes.md", "text/markdown", Buffer.from("# Notes\n\nSome context.\n", "utf8"));

  await expect(page.getByTestId("composer-input")).toHaveValue(/notes\.md:/);
  await expect(page.getByTestId("composer-input")).toHaveValue(/Some context\./);

  // The repair: the append reports the new draft upward, so the meter counts what just arrived.
  // Before it, the text was in the box while the parent's copy stayed empty and the meter read zero —
  // a meter that is wrong at the exact moment the user watches it change is worse than no meter.
  await expect(meter).toHaveAttribute("title", /^[1-9][\d,]* estimated prompt tokens/);

  // And the badge does not count it, which is the rule rather than an omission: an inlined text file
  // puts its entire body in the box, so nothing about it is hidden. The badge is for context the
  // draft does not show you — a reference's contents, an image's pixels, an instruction's effect.
  await expect(page.getByTestId("add-context-button")).not.toContainText("·");
  await expect(page.getByTestId("add-context-button")).toContainText("Add context");
});

