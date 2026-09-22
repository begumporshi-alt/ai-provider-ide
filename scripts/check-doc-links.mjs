#!/usr/bin/env node
/**
 * check-doc-links.mjs — every relative link and image in every markdown file must resolve.
 *
 * Why this exists: on 2026-09-22 a documentation reorganisation moved 19 files into `docs/`
 * and reported "17 markdown links across 36 files, 0 broken" — but that check validated `.md`
 * targets only. Every `.html`, `.svg` and bare-directory link broke silently, including two
 * image embeds that rendered as broken images. The same class of bug recurred within the hour
 * in a new chapter. Both are drift register D9.
 *
 * A property you check by hand is a property you will get wrong. So it is checked here instead.
 *
 * Zero dependencies. Usage:
 *   node scripts/check-doc-links.mjs            # tracked + untracked-but-not-ignored
 *   node scripts/check-doc-links.mjs --quiet    # only report failures
 *
 * Exits 1 if anything does not resolve.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUIET = process.argv.includes('--quiet');

const problems = [];
const rel = (p) => path.relative(ROOT, p);

/* ------------------------------------------------------------ enumeration */

// `--cached --others --exclude-standard` = tracked files plus anything that would be committed.
// In CI (fresh checkout) this is exactly the tracked set; locally it also covers new files, so a
// chapter that is not yet committed is still checked rather than silently skipped.
function markdownFiles() {
  let out;
  try {
    out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
  } catch (e) {
    const detail = String(e.stderr || e.message).trim().split('\n')[0];
    console.error(
      `✗ check-doc-links: \`git ls-files\` failed in ${ROOT}\n` +
        `  This script must stay at <repo>/scripts/ and run inside a git working tree\n` +
        `  (it derives the repo root as the parent of its own directory).\n` +
        `  ${detail}`
    );
    process.exit(2);
  }
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((f) => fs.existsSync(path.join(ROOT, f)))
    .sort();
}

/* --------------------------------------------------------------- stripping */

/**
 * Remove fenced blocks and inline code spans.
 *
 * Both matter. The memory logs and the completion plan *quote* link syntax to discuss it —
 * `[MASTER_PROMPT.md](MASTER_PROMPT.md)` and ``[`x`](../../diagrams/x.html)`` — and those
 * quotations are not references. Without this the checker reports them as broken links, which
 * is how a gate earns a reputation for crying wolf.
 */
function stripCode(src) {
  const kept = [];
  let fence = null;
  for (const line of src.split('\n')) {
    const m = line.match(/^\s*(`{3,}|~{3,})/);
    if (m) {
      fence = fence ? null : m[1][0];
      continue;
    }
    if (fence) continue;
    kept.push(line);
  }
  // Longest delimiter first: ``a `b` c`` must not be split by the single-backtick rule.
  return kept.join('\n').replace(/``[\s\S]*?``/g, '').replace(/`[^`]*`/g, '');
}

/* ------------------------------------------------------------------ anchors */

/**
 * GitHub's heading slug: lowercase, drop everything that is not a letter, digit, space,
 * underscore or hyphen, then spaces to hyphens. Repeated headings get -1, -2, … in document
 * order, which is why this needs the whole file rather than one heading at a time.
 */
function anchorsOf(src) {
  const body = stripCode(src);
  const seen = new Map();
  const out = new Set();

  const add = (text) => {
    let slug = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .trim()
      .replace(/\s+/g, '-');
    if (!slug) return;
    const n = seen.get(slug);
    if (n !== undefined) {
      seen.set(slug, n + 1);
      slug = `${slug}-${n}`;
    } else {
      seen.set(slug, 1);
    }
    out.add(slug);
  };

  for (const line of body.split('\n')) {
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) add(h[1]);
  }
  // Explicit HTML anchors and ids.
  for (const m of body.matchAll(/<a[^>]+(?:name|id)="([^"]+)"/g)) out.add(m[1]);
  for (const m of body.matchAll(/<[a-z][^>]*\sid="([^"]+)"/gi)) out.add(m[1]);
  return out;
}

const anchorCache = new Map();
function anchorsFor(absPath) {
  if (!anchorCache.has(absPath)) {
    anchorCache.set(absPath, fs.existsSync(absPath) ? anchorsOf(fs.readFileSync(absPath, 'utf8')) : new Set());
  }
  return anchorCache.get(absPath);
}

/* ------------------------------------------------------------------- check */

const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i; // http:, https:, mailto:, tel:, data:
const LINK = /!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

let linkCount = 0;

for (const file of markdownFiles()) {
  const abs = path.join(ROOT, file);
  const body = stripCode(fs.readFileSync(abs, 'utf8'));
  const dir = path.dirname(abs);

  for (const m of body.matchAll(LINK)) {
    const raw = m[2];
    if (EXTERNAL.test(raw)) continue;

    linkCount++;
    const lineNo = body.slice(0, m.index).split('\n').length;
    const where = `${file}:${lineNo}`;

    // Same-file anchor.
    if (raw.startsWith('#')) {
      const id = raw.slice(1);
      if (!anchorsFor(abs).has(id)) problems.push(`${where}  #${id} — no such heading in this file`);
      continue;
    }

    const hashAt = raw.indexOf('#');
    const target = hashAt === -1 ? raw : raw.slice(0, hashAt);
    const fragment = hashAt === -1 ? '' : raw.slice(hashAt + 1);
    const resolved = path.resolve(dir, decodeURIComponent(target));

    if (!fs.existsSync(resolved)) {
      problems.push(`${where}  ${raw} — target does not exist (resolved to ${rel(resolved)})`);
      continue;
    }

    // A trailing slash asserts a directory; catch the case where a file took its place.
    if (target.endsWith('/') && !fs.statSync(resolved).isDirectory()) {
      problems.push(`${where}  ${raw} — expected a directory, found a file`);
      continue;
    }

    if (fragment && /\.md$/i.test(target)) {
      if (!anchorsFor(resolved).has(fragment)) {
        problems.push(`${where}  ${raw} — ${rel(resolved)} has no heading "#${fragment}"`);
      }
    }
  }
}

/* ------------------------------------------------------ self-check + report */

// Guard against the check silently passing because it found nothing to check. This is the
// documented failure mode in this repo: a scan that never reached the directory returns a
// confident zero. A green run must prove it looked.
const filesChecked = markdownFiles().length;
if (filesChecked < 10 || linkCount < 20) {
  console.error(
    `✗ check-doc-links: implausible scan — ${filesChecked} files, ${linkCount} links.\n` +
      `  Expected the whole documentation set. Refusing to report success on a scan that ` +
      `probably never ran.`
  );
  process.exit(1);
}

if (problems.length) {
  console.error(`\n✗ check-doc-links — ${problems.length} unresolved reference(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  console.error(`\n  ${filesChecked} files, ${linkCount} links checked.\n`);
  process.exit(1);
}

if (!QUIET) console.log(`✓ check-doc-links — ${filesChecked} files, ${linkCount} links, all resolve`);
