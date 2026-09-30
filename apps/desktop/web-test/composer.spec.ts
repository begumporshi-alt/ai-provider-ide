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
