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
 * The second thing worth proving is what happens when the chosen model CANNOT see the image.
 * Nothing is refused: the image is attached, a model that declares vision reads it, and the
 * answering turn carries that reading instead of the image. The old behaviour refused the file and
 * explained the model's limitation, which read as this app being broken and as the model being worse
 * than it is.
 *
 * # The three vision states
 *
 * `?seed=systemai` deliberately carries all of them: `oracle-vision` declares image input,
 * `oracle-flash` is reachable and declares nothing, and a provider that publishes no capabilities
 * at all yields the third. The difference decides WHO READS an image — never whether you may attach
 * one — and the badge in the picker shows it beside the model rather than in the composer.
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
  // Poll rather than read once: between clicking Send and the request appearing in the log sit
  // the app's own pre-send work (state assembly, memory recall, the agent loop's first hop), and
  // on the ~2.5× slower hosted runner that gap has occasionally outlived a single read
  // (2026-10-03 CI: "no chat request was sent" on different specs across two runs, every one
  // passing locally and on retry). A single read turns that latency into a failure; polling
  // turns it into what it is — waiting for the turn to start.
  let last: EgressLogEntry | undefined;
  await expect(async () => {
    const reqs = await page.evaluate(
      () =>
        (
          (window as unknown as { __webTest: { store: Record<string, () => unknown> } }).__webTest.store
            .requests!() as EgressLogEntry[]
        ),
    );
    last = [...reqs].reverse().find((r) => r.url.endsWith("/chat/completions") && r.body);
    expect(last, "no chat request was sent").toBeDefined();
  }).toPass({ timeout: process.env.CI ? 60_000 : 15_000 });
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

/**
 * Paste files onto the composer exactly as a clipboard paste delivers them: a real ClipboardEvent
 * carrying a File. The default handler does nothing with a screenshot on the clipboard, which is
 * why the path exists at all. `clipboardData` is defined rather than passed to the constructor:
 * it is a readonly member and some Chromium builds ignore it in the init dictionary.
 */
async function pasteIntoComposer(page: Page, base64: string, name = "pasted.png"): Promise<void> {
  await page.getByTestId("composer-input").evaluate((el, payload) => {
    const bin = atob(payload.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], payload.name, { type: "image/png" }));
    const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: dt });
    el.dispatchEvent(ev);
  }, { b64: base64, name });
}

/** How many chat requests the harness has recorded so far. */
async function chatRequestCount(page: Page): Promise<number> {
  const reqs = await page.evaluate(
    () =>
      (
        (window as unknown as { __webTest: { store: Record<string, () => unknown> } }).__webTest.store
          .requests!() as { url: string; body: string | null }[]
      ),
  );
  return reqs.filter((r) => r.url.endsWith("/chat/completions") && r.body).length;
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

/**
 * The capability this replaced the refusal with: a model that cannot see still answers about the
 * image, because a model that can see reads it first.
 *
 * Asserted on the WIRE, not only on the screen: the reading must reach the answering model as text,
 * and the image bytes must NOT be sent to a model that cannot use them — a UI-only assertion would
 * pass while the image went nowhere and the answer was invented.
 */
test("an image attached to a model that cannot see is read by one that can", async ({ page }) => {
  await openAssistant(page, /oracle-flash/);

  await attach(page, "pixel.png", "image/png", Buffer.from(PNG_1PX_BASE64, "base64"));

  // Attached, not refused — the chip is the visible half of that, and no notice scolds the model.
  await expect(page.getByTestId("attachment-chip")).toBeVisible();
  await expect(page.getByTestId("composer-notice")).toHaveCount(0);

  await page.getByTestId("composer-input").fill("what is this?");
  await page.getByRole("button", { name: "Send" }).click();

  // Two requests: the reading, then the turn that answers from it.
  await expect.poll(() => chatRequestCount(page), { timeout: 30_000 }).toBe(2);

  const body = await lastChatBody(page);
  const turn = userTurn(body);
  expect(typeof turn.content, "the turn carries text, not image parts").toBe("string");
  const text = String(turn.content);
  expect(text).toContain('<images read-by="sysai/oracle-vision"');
  // The mock's own answer to the reading request, proving it came from the model rather than from
  // a string this app made up.
  expect(text).toContain("Seen 1 image in this request.");
  expect(text).toContain("what is this?");
  expect(text).toContain("do not claim to have seen the images themselves");
  // And the image itself never went to the blind model.
  expect(JSON.stringify(body)).not.toContain("image_url");

  // The user is told what happened, in the composer's notice line.
  await expect(page.getByTestId("composer-notice")).toContainText("sysai/oracle-vision");

  // --- a follow-up does not pay for the same reading twice --------------------------------
  // The image stays on its turn and rides along with the next question. Re-reading it would cost a
  // model call and return the same text, so the reading is cached per attachment: the follow-up
  // costs ONE request, and its turn still carries the reading rather than the image.
  const before = await chatRequestCount(page);
  await page.getByTestId("composer-input").fill("and what colour is the button?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => chatRequestCount(page), { timeout: 30_000 }).toBe(before + 1);

  const followUp = await lastChatBody(page);
  expect(String(userTurn(followUp).content)).toContain('<images read-by="sysai/oracle-vision"');
  expect(JSON.stringify(followUp)).not.toContain("image_url");
});

/**
 * The escape hatch for a model that can see but does not say so — ZCode's `inputFormat.supportsImage`
 * equivalent, declared per model in the Models screen.
 *
 * Without it, such a model is sent images through a vision model's reading: true, but lossy, and it
 * costs a call on every turn that carries the picture. The declaration is what turns the direct path
 * back on, and this is the test that proves the whole chain — the stored flag, the badge, and the
 * wire.
 */
test("declaring image support on a silent model sends the image straight to it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${APP}?seed=systemai`);

  // Declare it, the way the operator would: Models → the model's Images column → yes.
  await page.getByRole("button", { name: "Model Browser", exact: true }).click();
  await page.getByTestId("model-vision-sysai-oracle-flash").selectOption("yes");

  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-flash/);

  // The picker now badges it — the declaration is visible where the model is chosen.
  await page.getByRole("button", { name: /open picker/ }).click();
  await expect(page.getByRole("option").filter({ hasText: "oracle-flash" }).getByTestId("model-vision-badge")).toBeVisible();
  // Close it by its own overlay: the panel covers the composer, so a Send click made while it is
  // open lands on the overlay instead — which is how this test failed twice before.
  await page.getByTestId("model-picker-overlay").click();
  await expect(page.getByTestId("model-picker-overlay")).toHaveCount(0);

  await attach(page, "pixel.png", "image/png", Buffer.from(PNG_1PX_BASE64, "base64"));
  await page.getByTestId("composer-input").fill("what is this?");
  await page.getByRole("button", { name: "Send" }).click();

  // Seen by the model itself: ONE request, carrying the image, and no reading step at all.
  await expect(page.getByText(/Seen 1 image in this request/)).toBeVisible({ timeout: 30_000 });
  expect(await chatRequestCount(page)).toBe(1);
  expect(JSON.stringify(await lastChatBody(page))).toContain("image_url");
});

test("the reading is not attempted when the chosen model can see for itself", async ({ page }) => {
  await openAssistant(page, /oracle-vision/);

  await attach(page, "pixel.png", "image/png", Buffer.from(PNG_1PX_BASE64, "base64"));
  await page.getByTestId("composer-input").fill("what is this?");
  await page.getByRole("button", { name: "Send" }).click();

  // ONE request: no reading step, because the answering model is the one that can see.
  await expect(page.getByText(/Seen 1 image in this request/)).toBeVisible({ timeout: 30_000 });
  expect(await chatRequestCount(page)).toBe(1);
  const body = await lastChatBody(page);
  expect(JSON.stringify(body)).toContain("image_url");
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

test("the slash menu lists commands, and /model opens the picker from it", async ({ page }) => {
  await openAssistant(page, /oracle-flash/);

  await page.getByTestId("composer-input").type("/");
  const menu = page.getByRole("listbox", { name: "Slash commands" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("option", { name: /compact/ })).toBeVisible();

  // Typing the whole name and pressing Enter runs it (the menu closes once the name is complete).
  await page.getByTestId("composer-input").type("model");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox", { name: "Pick a model" })).toBeVisible();
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
  // Wait for the run to END, not just the reply text to appear: commands submitted mid-run are
  // refused by design, and on the slow runner the reply text beats the run's completion (CI
  // artifact, 2026-10-04 — /clear typed and swallowed, transcript never cleared).
  await expect(page.getByText("System AI (mock)")).toBeVisible({ timeout: 60_000 });

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

  await pasteIntoComposer(page, PNG_1PX_BASE64);

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


test("two text files in one gesture both land in the draft", async ({ page }) => {
  await openAssistant(page, /oracle-flash/);

  // One gesture, two files: addFiles appends once per file with an await between appends, and the
  // append used to compose from the render's draft — the second file's block overwrote the
  // first's, silently losing attached context with no notice.
  await page.getByTestId("composer-file-input").setInputFiles([
    { name: "first.md", mimeType: "text/markdown", buffer: Buffer.from("# First\n\nalpha content\n", "utf8") },
    { name: "second.md", mimeType: "text/markdown", buffer: Buffer.from("# Second\n\nbeta content\n", "utf8") },
  ]);

  const draft = page.getByTestId("composer-input");
  await expect(draft).toHaveValue(/first\.md:/);
  await expect(draft).toHaveValue(/alpha content/);
  await expect(draft).toHaveValue(/second\.md:/);
  await expect(draft).toHaveValue(/beta content/);
  // Both, in order — not the second having replaced the first.
  const value = await draft.inputValue();
  expect(value.indexOf("first.md")).toBeLessThan(value.indexOf("second.md"));
  expect(value.indexOf("alpha content")).toBeLessThan(value.indexOf("beta content"));
});

test("a double Enter sends one turn, not two", async ({ page }) => {
  await openAssistant(page, /oracle-mini/);

  // The @-expansion awaits the host per path before the parent can go busy — the window a second
  // Enter used to fall straight through. Both keydowns are dispatched in the same tick, because a
  // Playwright-serialised second press would land after the expansion resolved and never hit the
  // window the bug lives in.
  await page.getByTestId("composer-input").type("summarise @read");
  const menu = page.getByTestId("mention-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("option", { name: /README\.md/ }).click();
  await expect(page.getByTestId("composer-input")).toHaveValue(/@README\.md/);

  await page.getByTestId("composer-input").evaluate((el) => {
    for (let i = 0; i < 2; i += 1) {
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    }
  });

  // One user turn in the transcript, and exactly one chat request on the wire.
  await expect(page.getByText("summarise @README.md")).toHaveCount(1);
  await expect(page.locator("div.whitespace-pre-wrap").last()).toBeVisible({ timeout: 30_000 });
  expect(await chatRequestCount(page)).toBe(1);
});

test("a send that races a pending paste still carries the image, once", async ({ page }) => {
  await openAssistant(page, /oracle-vision/);

  // Text first, so a send during the paste has something to send: the old composer fired a turn
  // without the image (the base64 read was still pending), then the chip ghosted onto the next
  // turn. Paste and Enter are dispatched in the SAME JS tick — a forced branch, since no async
  // read can resolve inside one tick — so the send is deterministically refused by the attaching
  // gate, the chip appears, and the second Enter sends text and image together. Without the gate
  // this spec sees two chat requests, the first image-less.
  await page.getByTestId("composer-input").fill("what is this?");
  await page.getByTestId("composer-input").evaluate((el, b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: dt });
    el.dispatchEvent(ev);
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  }, PNG_1PX_BASE64);

  await expect(page.getByTestId("attachment-chip")).toContainText("pasted.png");
  await page.getByTestId("composer-input").press("Enter");

  const body = await lastChatBody(page);
  expect(userTurn(body).content).toEqual([
    { type: "text", text: "what is this?" },
    { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_1PX_BASE64}` } },
  ]);
  // The refused Enter must not have produced a second, image-less request.
  expect(await chatRequestCount(page)).toBe(1);
});
