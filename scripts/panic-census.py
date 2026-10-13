#!/usr/bin/env python3
"""Panic-source census for the Rust host — production code only.

**Why this is a script and not a number in a document.** `docs/dev-book/06-conventions.md` records
the rule the hard way: a census "goes stale the moment code lands, so re-derive it rather than
quoting it". The figure that chapter quotes (the 2026-09-27 re-run: eleven) was accurate for that
tree and wrong within days. Run this instead of citing it.

    python3 scripts/panic-census.py                 # the whole host
    python3 scripts/panic-census.py path/to/src     # a subtree

What "production" means here, and why it takes this much code to say it:

1.  **Test-only modules are blanked, not guessed at by filename.** A module declared
    `#[cfg(test)] mod …` and a file declared `#[cfg(test)] #[path = "…"] mod …;` are both excluded —
    see `TEST_ONLY`, which is verified against the tree rather than trusted.
2.  **Braces are counted on masked source, and line numbers are preserved.** The first version of
    this instrument brace-counted raw text, so a fixture containing `"{"` un-balanced the count and
    the skip ended *inside* the test module — reporting four test-only `.unwrap()`s as production.
    The masked pass also removes a whole class of false positive: a doc comment that *mentions*
    `.unwrap()` is not a call site. And the stripper **blanks** lines rather than deleting them,
    because deleting renumbers the file and every finding is reported by line.
3.  **A `.unwrap()` is classified by its receiver, looking back a short window.** `.lock()` /
    `.read()` / `.write()` unwraps are unreachable under `panic = "abort"` — poisoning is set while
    unwinding, and abort does not unwind — so they are counted apart from the ones that can actually
    end the process. The window matters: a `.lock()\n.unwrap()` chain has an empty receiver on its
    own line and reads as non-lock without it.
"""

from __future__ import annotations

import pathlib
import re
import sys

# --- masking ------------------------------------------------------------------------------------


def mask(src: str) -> str:
    """Blank out comments and string/char literals, preserving newlines and offsets.

    Only enough of Rust's lexical grammar to make brace counting and pattern matching trustworthy:
    line comments, nested block comments, strings (plain and raw, with any hash count), byte strings
    and char literals. Lifetimes (`'static`) are deliberately not treated as char literals.
    """
    out = list(src)
    i = 0
    n = len(src)

    def blank(start: int, end: int) -> None:
        for k in range(start, min(end, n)):
            if out[k] != "\n":
                out[k] = " "

    while i < n:
        c = src[i]
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            j = src.find("\n", i)
            j = n if j < 0 else j
            blank(i, j)
            i = j
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            depth = 1
            j = i + 2
            while j < n and depth:
                if src.startswith("/*", j):
                    depth += 1
                    j += 2
                elif src.startswith("*/", j):
                    depth -= 1
                    j += 2
                else:
                    j += 1
            blank(i, j)
            i = j
            continue
        m = re.match(r'(?:b?r)(#*)"', src[i:])
        if m:
            close = '"' + m.group(1)
            start = i + m.end()
            j = src.find(close, start)
            j = n if j < 0 else j + len(close)
            blank(i, j)
            i = j
            continue
        if c == '"' or (c == "b" and i + 1 < n and src[i + 1] == '"'):
            start = i
            j = i + (2 if c == "b" else 1)
            while j < n:
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == '"':
                    j += 1
                    break
                j += 1
            blank(start, j)
            i = j
            continue
        m = re.match(r"'(?:\\.|[^\\'])'", src[i:])
        if m:
            blank(i, i + m.end())
            i += m.end()
            continue
        i += 1
    return "".join(out)


def strip_test_items(src: str) -> list[str]:
    """Masked source with every `#[cfg(test)]` item blanked.

    **Line count is preserved on purpose** — the test-item lines become empty strings rather than
    being removed. A stripper that deletes lines renumbers the file, and every finding below is
    reported by line number, so the numbers would silently point at unrelated code.
    """
    lines = src.split("\n")
    keep = list(lines)
    i = 0
    pending = False
    while i < len(lines):
        s = lines[i].strip()
        if re.match(r"^#\[cfg\((test|all\(test|any\(test)", s):
            keep[i] = ""
            pending = True
            i += 1
            continue
        if pending:
            if s.startswith("#[") or s == "" or s.startswith("//"):
                keep[i] = ""
                i += 1
                continue
            pending = False
            if "{" in s:
                depth = 0
                while i < len(lines):
                    depth += lines[i].count("{") - lines[i].count("}")
                    keep[i] = ""
                    i += 1
                    if depth <= 0:
                        break
                continue
            keep[i] = ""
            i += 1
            continue
        i += 1
    return keep


# --- census -------------------------------------------------------------------------------------

UNWRAP = re.compile(r"\.unwrap\(\)")
EXPECT = re.compile(r"\.expect\(")
PANIC_PROMISE = re.compile(r"\b(?:panic|todo|unimplemented|unreachable)!")
# `debug_assertions` is a cfg name, not an assertion — hence the `!`.
ASSERT = re.compile(r"\b(?:debug_)?assert(?:_eq|_ne)?!")
LOCK_CALL = re.compile(r"\.(lock|read|write)\(\)")

# Files reached ONLY through a `#[cfg(test)]` module declaration, so their own text carries no
# marker to strip. Listed rather than resolved: a correct resolver needs Rust's module rules
# (`mod x;` → `x.rs` or `x/mod.rs`, plus nesting), and a half-correct one is worse than a list. Each
# entry is verified to exist, and the run warns about any unlisted file that *looks* test-only, so a
# rename or an addition is loud rather than silent.
TEST_ONLY: dict[str, str] = {
    "core/gateway_tests.rs": '#[cfg(test)] #[path = "gateway_tests.rs"] mod tests;  (gateway.rs)',
    "core/tools_agent_tests.rs": '#[cfg(test)] #[path = "tools_agent_tests.rs"] mod agent_tests;  (tools.rs)',
    "core/router_bridge/tests/conformance.rs": "mod conformance; inside `#[cfg(test)] mod tests`  (router_bridge.rs)",
}


def verify_test_only(root: pathlib.Path) -> list[str]:
    problems: list[str] = []
    for rel in TEST_ONLY:
        if not (root / rel).exists():
            problems.append(f"TEST_ONLY lists a file that does not exist: {rel}")
    for path in sorted(root.rglob("*.rs")):
        rel = str(path.relative_to(root))
        if rel in TEST_ONLY:
            continue
        if path.name.endswith("_tests.rs") or "/tests/" in f"/{rel}":
            problems.append(
                "test-shaped file is NOT excluded (check how it is declared, then add it to "
                f"TEST_ONLY): {rel}"
            )
    return problems


def main() -> int:
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "apps/desktop/src-tauri/src")
    if not root.is_dir():
        print(f"not a directory: {root}", file=sys.stderr)
        return 2

    stale = [p for p in verify_test_only(root) if "does not exist" in p]
    if stale:
        print("instrument is stale:", file=sys.stderr)
        for p in stale:
            print(f"  - {p}", file=sys.stderr)
        return 2

    totals = {"unwrap": 0, "lock": 0, "nonlock": 0, "expect": 0, "promise": 0, "assert": 0}
    by_file: dict[str, int] = {}
    nonlock: list[str] = []
    expects: list[str] = []
    promises: list[str] = []
    asserts: list[str] = []

    for path in sorted(root.rglob("*.rs")):
        rel = str(path.relative_to(root))
        if rel in TEST_ONLY:
            continue
        original = path.read_text().split("\n")
        masked = mask("\n".join(original)).split("\n")
        lines = strip_test_items("\n".join(masked))
        for n, line in enumerate(lines, 1):
            if not line.strip():
                continue
            shown = original[n - 1].strip() if n - 1 < len(original) else line.strip()
            # Look back a short window: a lock unwrap chained across lines has an empty receiver on
            # its own line, and reading it as non-lock is how one `.lock()\n.unwrap()` in `web.rs`
            # looked like the single real non-lock unwrap in the host.
            window = " ".join(masked[max(0, n - 4) : n])
            is_lock = bool(LOCK_CALL.search(window))
            for _ in UNWRAP.finditer(line):
                totals["unwrap"] += 1
                if is_lock:
                    totals["lock"] += 1
                    by_file[rel] = by_file.get(rel, 0) + 1
                else:
                    totals["nonlock"] += 1
                    nonlock.append(f"{rel}:{n}: {shown}")
            for _ in EXPECT.finditer(line):
                totals["expect"] += 1
                expects.append(f"{rel}:{n}: {shown}")
            if PANIC_PROMISE.search(line):
                totals["promise"] += 1
                promises.append(f"{rel}:{n}: {shown}")
            if ASSERT.search(line):
                totals["assert"] += 1
                asserts.append(f"{rel}:{n}: {shown}")

    print("=== panic sources in production code ===")
    print(f"  .unwrap() total   : {totals['unwrap']}")
    print(f"    on a lock call  : {totals['lock']}   (unreachable under panic = \"abort\")")
    print(f"    NOT on a lock   : {totals['nonlock']}   <-- the ones that can end the process")
    print(f"  .expect()         : {totals['expect']}")
    print(f"  panic promises    : {totals['promise']}   (panic!/todo!/unimplemented!/unreachable!)")
    print(f"  assertions        : {totals['assert']}   (assert!/assert_eq!/debug_assert!)")

    def section(title: str, items: list[str]) -> None:
        print(f"\n=== {title} ===")
        print("\n".join(items) if items else "  (none)")

    section("NON-LOCK unwraps — classify each as construction-time or request-reachable", nonlock)
    section(".expect()", expects)
    section("panic promises", promises)
    section("assertions", asserts)
    print("\n=== lock-call unwraps by file ===")
    for f, c in sorted(by_file.items(), key=lambda kv: (-kv[1], kv[0])):
        print(f"  {c:>3}  {f}")

    warnings = verify_test_only(root)
    if warnings:
        print("\n=== instrument warnings ===")
        print("\n".join(f"  ! {w}" for w in warnings))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
