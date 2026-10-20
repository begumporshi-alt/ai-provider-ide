/**
 * The spec's acceptance test, against the harness: seven facts, a foreign workspace, and the
 * assertion that only global identity reaches the model.
 */
import { expect, test, type Page } from "@playwright/test";
import { pickModel } from "./model-picker";

const APP = "/web-test/";

type Call = (...a: unknown[]) => unknown;
interface Host { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> }

async function seed(page: Page, layer: string, text: string, pinned = false): Promise<string> {
  return page.evaluate(
    async ({ layer, text, pinned }) => {
      const h = (window as unknown as { __webTest: Host }).__webTest;
      const m = (await h.invoke("memory_capture", {
        layer, text, sessionId: null, subject: null, pinned,
      })) as { id: string };
      return m.id;
    },
    { layer, text, pinned },
  );
}

async function scope(
  page: Page,
  id: string,
  target: { kind: "global" } | { kind: "project"; project: string },
): Promise<void> {
  await page.evaluate(
    async ({ id, target }) => {
      const h = (window as unknown as { __webTest: Host }).__webTest;
      await h.invoke("memory_assign_scope", {
        id,
        scope: {
          kind: target.kind,
          project: target.kind === "project" ? target.project : null,
          agent: null,
        },
      });
    },
    { id, target },
  );
}

/** Last body sent to /chat/completions — the model request. */
async function lastBody(page: Page): Promise<string> {
  return page.evaluate(() => {
    const h = (window as unknown as { __webTest: { store: Record<string, Call> } }).__webTest;
    const reqs = h.store["requests"]!() as Array<{ url: string; body: string | null }>;
    return [...reqs].reverse().find((r) => r.url.endsWith("/chat/completions") && r.body)?.body ?? "";
  });
}

test("scoped recall: a foreign workspace's facts never reach the model", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);

  const name = await seed(page, "L3", "I am Tushu", true);
  const role = await seed(page, "L3", "I am a Software Engineer", true);
  await scope(page, name, { kind: "global" });
  await scope(page, role, { kind: "global" });

  const tauri = await seed(page, "L1", "The Tauri context graph engine lives at apps/desktop/src/lib/context/engine.ts");
  const graph = await seed(page, "L1", "ForceGraph.tsx renders the graph");
  const schema = await seed(page, "L2", "The graph has 4 node kinds and 9 edge kinds");
  for (const id of [tauri, graph, schema]) {
    await scope(page, id, { kind: "project", project: "/tmp/tauri-app" });
  }
  // Old capability prose, never scoped: it must stay capture-only.
  await seed(page, "L1", "The assistant cannot run git clone or git fetch");

  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);
  await page.getByPlaceholder(/Message your assistant/)
    .fill("how does the context graph engine work?");
  await page.getByRole("button", { name: "Send" }).click();

  await expect.poll(() => lastBody(page), { timeout: 30_000 }).not.toBe("");

  const text = await lastBody(page);
  expect(text).toContain("I am Tushu");
  expect(text).toContain("I am a Software Engineer");
  // The query matches these words, but their scope is another workspace.
  expect(text).not.toContain("context/engine.ts");
  expect(text).not.toContain("ForceGraph");
  expect(text).not.toContain("git clone");
  // And the stable half is there too: identity is carried by the manifest header, not by the
  // query, which is the difference between "what this question matched" and "what is always true".
  expect(text).toContain("Session manifest");
  expect(text).toContain("identity");
});

test("a contradicted capability stays out of the prompt", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  // One includable row so the manifest block is non-empty; the assertion below is that the
  // header arrives WITHOUT the capability line, not that no header arrives at all.
  const id = await seed(page, "L3", "I am Tushu", true);
  await scope(page, id, { kind: "global" });
  const cap = await seed(page, "L1", "The assistant cannot run git clone or git fetch");
  await scope(page, cap, { kind: "global" });

  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);
  await page.getByPlaceholder(/Message your assistant/).fill("what can you do?");
  await page.getByRole("button", { name: "Send" }).click();

  await expect.poll(() => lastBody(page), { timeout: 30_000 }).not.toBe("");
  const body = await lastBody(page);

  // The row is scoped global, so it reaches the composer. The probe sees that `git clone`
  // is in the sandbox allowlist and marks the claim contradicted; a contradicted capability
  // is echoed to the user but never sent to the model. The unit test pins the verdict; this
  // pins the prompt-side exclusion. The same assertion also pins exclusion from recall: "can"
  // is a token of the question, so without `excludeIds` this row would re-enter through the
  // recalled-memory block instead.
  expect(body).toContain("Session manifest");
  expect(body).toContain("identity");
  expect(body).not.toContain("cannot run git clone");
});

test("the manifest card lists entries and forgets one by id", async ({ page }) => {
  await page.goto(`${APP}?seed=systemai`);
  const id = await seed(page, "L3", "I am Tushu", true);
  await scope(page, id, { kind: "global" });

  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await pickModel(page, /oracle-mini/);
  await page.getByPlaceholder(/Message your assistant/).fill("hello");
  await page.getByRole("button", { name: "Send" }).click();

  const card = page.getByTestId("manifest-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  // The card is a <details>: its entries are not in the accessibility tree until it is opened.
  await card.locator("summary").click();
  // The session-skills rail floats over the card's right edge; dispatch on the element itself so
  // the test exercises the handler rather than fighting the layout overlay.
  await card.getByRole("button", { name: `Forget ${id}` }).dispatchEvent("click");
  await expect(card.getByText("I am Tushu")).toHaveCount(0);
});
