# User guide

AI-Provider Router is a macOS desktop app that puts every AI provider you have a key for behind **one
local endpoint**. You add providers, and any other tool — an editor, a script, a chat client — can then
talk to all of them through `http://127.0.0.1:<port>/v1` using one credential.

This guide is for **using** the app. To build it, change it, or run the test gate, see
[`CONTRIBUTING.md`](CONTRIBUTING.md) and the [developer book](docs/dev-book/README.md).

---

## Before you start: there is no download yet

**No release is published.** The release pipeline builds and signs a bundle, but it attaches the result to
a **draft** GitHub Release, and a draft is not downloadable. So today the only way to run this is to
**build it from source**, which needs a development toolchain.

That is not an accident of process. A macOS app that other people can double-click must be signed with a
**Developer ID** certificate and notarized by Apple, which requires a **paid Apple Developer Program
membership**. Until that exists there is no launchable download, and no code change can substitute for it.
Without notarization a build is only *ad-hoc* signed — it runs on the machine that built it, and macOS
Gatekeeper refuses it on any other Mac.

**What that means for you:**

| You are | Your path |
|---|---|
| Comfortable installing Node, pnpm and Rust | Build from source below — about 10 minutes, most of it Rust compiling |
| Not comfortable with a toolchain | This app is not installable for you yet. Nothing here is broken; there is simply no signed download |

---

## Build from source

**Prerequisites**

| Tool | Version | Why |
|---|---|---|
| Node.js | 22 | CI runs 22 |
| pnpm | 10.12.4 | pinned via `packageManager`; corepack picks it up automatically |
| Rust | stable | no `rust-toolchain` file, so your default is used |
| Xcode command line tools | — | needed for `codesign` |

**Build and launch**

```bash
git clone https://github.com/begumporshi-alt/ai-provider-ide.git
cd ai-provider-ide
pnpm install
cd apps/desktop
./node_modules/.bin/tauri build --bundles app
```

The app lands in
`apps/desktop/src-tauri/target/release/bundle/macos/AI-Provider Router.app`. Open it from Finder.

The first build takes a while — it compiles the Rust host from scratch. Later builds are incremental.

> The `.dmg` step may fail on some machines (`hdiutil`). That is cosmetic: the `.app` is already complete
> at that point, which is why the command above asks only for `--bundles app`.

For a faster loop while developing, `pnpm --filter ai-provider-router-desktop tauri dev` runs the app with
hot reloading. That is a developer workflow — see [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## First run

**1 · Launch the app.** It starts with no providers. The home screen asks you to add one.

**2 · Add a provider** — **Providers → + Add Provider**. Three ways in:

- **Quick add** — a known profile: OpenRouter, OpenCode Zen, b.ai.
- **Manual** — anything OpenAI- or Anthropic-compatible: name, base URL, auth header, dialect.
- **Guided setup** — for anything else. It probes the API, identifies the dialect, runs free contract
  checks, and only enables the provider after you approve what it found.

**3 · Add a key** — **+ Add key** on the provider's card. The key is written to a local secrets file
(mode 600) and never to the database. The screen shows the last four characters afterwards so you can tell
keys apart; the value itself is revealed once and is not readable again.

**4 · Enable it.** Enabling a provider makes it eligible for routing. The gateway itself is a separate
switch — **Control → Local Gateway** — which shows the current port and the master key. A fresh install
starts on **8787**.

**5 · Check it works.** **Models** lists what the provider actually serves, discovered from the provider
rather than hardcoded. If a model list is empty, the provider's key or base URL is wrong, not the model.

---

## Pointing another tool at the gateway

This is the point of the app: one endpoint, one credential, every provider.

| | |
|---|---|
| **Base URL** | `http://127.0.0.1:8787/v1` — change the port in Control → Local Gateway |
| **Credential** | the **master key** (Control → Local Gateway), or a **per-app key** you create for one client |
| **Routes** | `/v1/chat/completions`, `/v1/models`, `/v1/images/generations` |
| **Unauthenticated** | `GET /health` only, by design — so a client can tell the service is up before it has a key |

The gateway binds to `127.0.0.1` only. It is not reachable from your network.

**Test it from a terminal first:**

```bash
curl -s http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $MASTER_KEY" | head
```

Then point the other tool at the same base URL and credential, exactly as you would point it at OpenAI.

**Models are named `provider/model`** — for example `openrouter/anthropic-claude-4.5-sonnet`. A bare model
name resolves through the alias map, but the qualified form is never ambiguous when two providers offer
the same model.

**Prefer a per-app key over the master key.** A per-app key can be revoked on its own, can carry a
**monthly spend cap**, and its usage is attributed separately in the ledger. The master key is the key that
can do everything, including minting more keys — treat it as an admin credential.

**The gateway runs while the app is open.** Closing the window is fine; quitting the app is not. If you
want it to survive without the UI, **Control → Service** installs a login item that runs a headless
`aiproviderd` on the same port, and hands the port over when you start it.

---

## Where your data lives

Everything is local. There is no telemetry and no cloud copy.

```
~/Library/Application Support/dev.aiprovider.router/
├── ai-provider-router.db     providers, manifests, aliases, key metadata, usage ledger
└── .secrets.json             the raw secrets, mode 600
```

- The **database** holds no raw credentials — only a `secret_ref` pointing into the secrets file.
- The **secrets file** is a plain JSON file owned by your user account. Its protection is the file mode
  (600) plus your macOS login, **not** the Keychain, and the app never asks for approval to read it.
- The database is gitignored in the repository, so a fresh clone always starts empty. That is correct.

**To start over completely:** quit the app, then delete that folder. You lose every provider, key and the
usage ledger. There is no backup in the cloud and no undo.

---

## When something goes wrong

Most failures here are local and the status code tells you which kind.

| What you see | What it means |
|---|---|
| `401 no master key configured` | The secrets file has no `masterkey` yet. Open Control → Local Gateway and generate one |
| `401 invalid gateway key` | The credential you sent is wrong or was revoked. Re-copy the master key, or re-create the per-app key |
| `503 master key unavailable — the secrets file could not be read` | A **local** fault, not a bad credential: the app could not read `.secrets.json`. Check that the data folder is readable, then retry |
| `503 ... core unavailable — is the app open?` | The gateway is listening but the router behind it is gone — the app was quit or its window crashed. Reopen the app |
| `429 router at capacity` | The gateway's own admission ceiling. Retry |
| `429 too many failed auth attempts` | Something is polling with a dead credential. Fix the credential rather than waiting |
| `429` with `Retry-After` | An upstream provider rate-limited you, or a key is in cooldown. **`Retry-After` is the shortest wait** — respect it |
| A provider shows **invalid** | Its key is not in the secrets file. Common after restoring a database onto a new machine — re-enter the key |
| A provider's model list is empty | Usually a wrong base URL or auth header, not a missing model. Re-run the provider's contract check |
| "Port already in use" | Another process holds the port. Control → Local Gateway, choose a different one |
| macOS refuses to open the app | Gatekeeper, because the build is ad-hoc signed. Build it on that machine, or use the notarized release once one exists |

**Two things worth knowing about the status codes.** There are three different `429`s and two different
`503`s, so **read the body before concluding anything**. And `503` is deliberately *not* a `401`: a `401`
blames your credential, so a purely local fault must not be reported as one.

---

## Getting help

- **A bug or a feature** — open a GitHub issue.
- **A vulnerability** — do **not** open a public issue. See [`SECURITY.md`](SECURITY.md).
- **How it works, and why** — [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and
  [`docs/DECISIONS.md`](docs/DECISIONS.md).
- **Working on the code** — [`CONTRIBUTING.md`](CONTRIBUTING.md), then the
  [developer book](docs/dev-book/README.md).
