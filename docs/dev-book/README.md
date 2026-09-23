# The developer book

**What this is.** The single place a developer reads to learn how this project is built, what it must not
violate, and what to update when they change something.

**What this is not.** It is not a second copy of the design docs. `ARCHITECTURE.md`, `DECISIONS.md` and
`GATEWAY_MEMORY_LAYER.md` remain the design narrative and the record of *why*. This book owns the **rules and
the interfaces**, and cites the rest rather than restating it.

**Why it exists.** Consistency. Before this book the conventions lived in three places — `CONTRIBUTING.md`
(six rules), `.workbuddy-ai/memory/MEMORY.md` (about forty), and `REFERENCE.md` (the depth) — while the design
docs had drifted behind the code in five measured places ([07](07-drift-register.md) — ten by 2026-09-22, all
closed). A rule kept in three
places is a rule that gets followed in one.

## The rendered HTML

`book.html` is this book as one self-contained page — sidebar navigation, a chapter filter, every
diagram inlined. It is **generated from these markdown files, never edited**:

```bash
pnpm docs:book
```

`scripts/build-dev-book.mjs` has no dependencies. It **fails the build** if any relative link or
image does not resolve, or if two elements claim the same `id` — the two failure modes that
[07](07-drift-register.md) D9 records. Edit the markdown, regenerate, and commit both.

## How to read it

| If you are | Read |
|---|---|
| New to the repository | [01 Orientation](01-orientation.md) → [02 Architecture](02-architecture.md) → [05 Workflow](05-workflow.md) |
| About to change code | [03 Contracts](03-contracts.md) → [06 Conventions](06-conventions.md) → the checklist in [07](07-drift-register.md) |
| About to cut a release | [05 Workflow](05-workflow.md) § Release, then [07](07-drift-register.md) |
| Debugging something that "should work" | [03 Contracts](03-contracts.md) → [04 Data model](04-data-model.md) |
| Wanting the picture rather than the prose | [08 Flows](08-flows.md) → [02 Architecture](02-architecture.md) |
| Picking up the backlog | [09 Status](09-status.md) → [07 Drift register](07-drift-register.md) |
| Planning a major architectural change | [10 Headless service](10-headless-service.md) |

## Chapters

| # | Chapter | Owns |
|---|---|---|
| 01 | [Orientation](01-orientation.md) | What the product is, the repository map, the toolchain, the screen map |
| 02 | [Architecture](02-architecture.md) | The two-runtime split, the layer stack, the one security boundary, self-construction |
| 03 | [Contracts](03-contracts.md) | Invariants, the HTTP surface, the IPC surface, status-code semantics, budgets |
| 04 | [Data model](04-data-model.md) | Schema, migration rules, identifier rules, retention |
| 05 | [Workflow](05-workflow.md) | The gate, the fast loops, the test suites, releasing, verification discipline |
| 06 | [Conventions](06-conventions.md) | Code, test, UI and doc conventions — each with the bug it cost |
| 07 | [Drift register](07-drift-register.md) | Known doc-versus-code disagreements, and the change checklist |
| 08 | [Flows](08-flows.md) | The request lifecycle and the user journey, with diagrams |
| 09 | [Status](09-status.md) | Where the work stands: working, gaps, parked, needs improvement |
| 10 | [Headless service](10-headless-service.md) | Plan for detaching the gateway from the webview process |

## Single ownership — where truth lives

Every fact has exactly one home. If two files state the same fact, one of them is a copy and will rot.

| Subject | Authoritative source |
|---|---|
| Product overview, install, first run, signing | `README.md` |
| What changed, per release | `CHANGELOG.md` |
| Build, test, gate, contribution mechanics | `CONTRIBUTING.md` |
| Vulnerability reporting and threat scope | `SECURITY.md` |
| Design narrative, module map, data flows, acceptance criteria | `docs/ARCHITECTURE.md` |
| Why a decision was made, dated | `docs/DECISIONS.md` |
| Memory and context subsystem design | `docs/GATEWAY_MEMORY_LAYER.md` |
| Control screen design and the audit trails | `docs/CONTROL_SCREEN_BUILD.md` |
| Product-completion **audit** and its dated evidence trail | `docs/PRODUCT_COMPLETION_PLAN.md` |
| Product-completion **current status** (the live snapshot) | [09 Status](09-status.md) |
| Diagrams and visual assets | `diagrams/` — at the repository **root**, not under `docs/` |
| The rendered single-page book | `docs/dev-book/book.html` — **generated**, never hand-edited |
| **Rules, invariants, interfaces, workflow, conventions** | **this book** |
| Working notes discovered while building | `.workbuddy-ai/memory/REFERENCE.md` |
| Known doc-versus-code disagreements | [07 Drift register](07-drift-register.md) |

## The one rule that keeps this honest

**If you change a fact, update its owner — and if you cannot, log it in the drift register.**

The register is not an admission of failure; it is the mechanism. A claim that is known to be stale, and
written down as stale, costs nothing. The same claim left unmarked is what makes a new contributor distrust
every other page. See [07](07-drift-register.md) for the change checklist and the current entries.
