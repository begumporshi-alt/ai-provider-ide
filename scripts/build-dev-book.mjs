#!/usr/bin/env node
/**
 * build-dev-book.mjs — render docs/dev-book/*.md into one self-contained HTML file.
 *
 * Zero dependencies by design. The book uses a narrow markdown subset (headings,
 * paragraphs, GFM tables, blockquotes, fenced code, flat ul/ol, inline code/bold/
 * italic/links/images) — measured, not assumed — so a full CommonMark parser would
 * add a lockfile entry and an audit-gate surface for no gain.
 *
 * The output is a RENDERING, never a source. Do not hand-edit book.html.
 * Regenerate with:  pnpm docs:book
 *
 * Fails (exit 1) if any reference does not resolve, or if two elements claim the
 * same id. That check is the point: a documentation link that silently breaks is
 * the failure mode this book exists to prevent, and it has already happened twice
 * (drift register D9).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOK_DIR = path.join(ROOT, 'docs', 'dev-book');
const DIAGRAM_DIR = path.join(ROOT, 'diagrams');
const OUT_FILE = path.join(BOOK_DIR, 'book.html');

const problems = [];
const note = (msg) => problems.push(msg);

/* ------------------------------------------------------------------ helpers */

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const slug = (s) =>
  s.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

/** Return only the <svg>…</svg> element from a standalone diagram page. */
function extractSvg(html) {
  const m = html.match(/<svg[\s\S]*?<\/svg>/);
  return m ? m[0] : null;
}

/**
 * Namespace every id inside one inlined SVG, and every reference to it.
 *
 * Every diagram in diagrams/ defines its own <marker id="arrow">. Inlining three
 * of them into one document without this makes `marker-end="url(#arrow)"` resolve
 * to whichever definition happens to come first — the other diagrams then render
 * with the wrong arrowhead, silently.
 *
 * A sequence number is included so that inlining the same diagram twice still
 * yields unique ids.
 */
let svgSeq = 0;
function namespaceSvg(svg, absPath) {
  const base = path.basename(absPath).replace(/\.(svg|html)$/i, '').replace(/[^A-Za-z0-9-]/g, '');
  const prefix = `${base}-${++svgSeq}-`;
  return svg
    .replace(/\sid="([^"]+)"/g, (_m, id) => ` id="${prefix}${id}"`)
    .replace(/url\(#([^)]+)\)/g, (_m, id) => `url(#${prefix}${id})`)
    .replace(/(\s(?:xlink:)?href)="#([^"]+)"/g, (_m, attr, id) => `${attr}="#${prefix}${id}"`)
    .replace(
      /(aria-(?:labelledby|describedby))="([^"]+)"/g,
      (_m, attr, list) => `${attr}="${list.split(/\s+/).map((x) => prefix + x).join(' ')}"`
    );
}

/** Read an SVG file from disk, or extract one from a diagram .html page. */
function svgFor(absPath) {
  const raw = fs.readFileSync(absPath, 'utf8');
  const svg = absPath.endsWith('.svg') ? raw : extractSvg(raw);
  return svg ? namespaceSvg(svg, absPath) : null;
}

function loadDiagram(relFromBook) {
  const abs = path.resolve(BOOK_DIR, relFromBook);
  if (!fs.existsSync(abs)) {
    note(`diagram not found on disk: ${relFromBook}`);
    return null;
  }
  const svg = svgFor(abs);
  if (!svg) {
    note(`no <svg> element extractable from: ${relFromBook}`);
    return null;
  }
  return svg;
}

/* ------------------------------------------------------- chapter discovery */

const mdFiles = fs
  .readdirSync(BOOK_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort();

// README is the book's front matter and reads first; numbered chapters follow.
const ordered = [
  ...mdFiles.filter((f) => f === 'README.md'),
  ...mdFiles.filter((f) => f !== 'README.md'),
];

const chapters = ordered.map((file, i) => {
  const src = fs.readFileSync(path.join(BOOK_DIR, file), 'utf8');
  const h1 = src.match(/^#\s+(.+)$/m);
  const num = file.match(/^(\d+)/);
  return {
    file,
    key: file.replace(/\.md$/, ''),
    id: num ? `ch-${num[1]}` : 'ch-00',
    title: h1 ? h1[1].trim() : file,
    index: i,
    src,
  };
});

const chapterByKey = new Map(chapters.map((c) => [c.key, c]));
const inlinedDiagrams = new Set(); // absolute paths already rendered inline
const headingIds = new Set(); // every heading id emitted, for disambiguation

/* ------------------------------------------------------------- inline pass */

// Shared across recursive calls, deliberately. A link label such as
// [`../diagrams/x.html`](../../diagrams/x.html) recurses into inline() while the
// outer frame still holds a \u0000C0\u0000 placeholder. With a per-call registry the
// inner frame cannot resolve that index and ends up escaping `undefined`.
// One registry per document keeps every index globally valid.
const codes = [];
const tokens = [];

function inline(text) {
  // 1. Code spans are literal — protect before anything else can touch them.
  text = text.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(c);
    return `\u0000C${codes.length - 1}\u0000`;
  });

  // 2. Links and images. Labels are rendered recursively so `[**bold**](x)` works.
  text = text.replace(/!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, label, href) => {
    const isImage = m.startsWith('!');
    tokens.push(
      isImage
        ? { kind: 'image', label: inline(label), href }
        : { kind: 'link', label: inline(label), href: resolveHref(href) }
    );
    return `\u0000L${tokens.length - 1}\u0000`;
  });

  // 3. Escape the remaining literal text.
  text = esc(text);

  // 4. Emphasis. Bold first, so `**x**` is not consumed as two italics.
  //    The bold pattern is non-greedy and must tolerate a single `*` inside: the
  //    book writes `**Unset … *and* on the app.**`, which `[^*]+` cannot match.
  text = text
    .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s.,;:)]|$)/g, '$1<em>$2</em>');

  // 5. Restore code spans.
  text = text.replace(/\u0000C(\d+)\u0000/g, (_m, i) => `<code>${esc(codes[+i])}</code>`);

  // 6. Restore links and images.
  text = text.replace(/\u0000L(\d+)\u0000/g, (_m, i) => {
    const t = tokens[+i];
    if (t.kind === 'link') {
      const ext = /^https?:/.test(t.href) ? ' target="_blank" rel="noopener"' : '';
      return `<a href="${esc(t.href)}"${ext}>${t.label}</a>`;
    }
    return renderImage(t);
  });

  return text;
}

const stripTags = (s) => s.replace(/<[^>]*>/g, '');

function renderImage(t) {
  const href = t.href;
  if (/^https?:/.test(href)) {
    return `<img src="${esc(href)}" alt="${esc(stripTags(t.label))}" loading="lazy">`;
  }
  if (href.includes('diagrams/')) {
    const svg = loadDiagram(href);
    if (svg) {
      inlinedDiagrams.add(path.resolve(BOOK_DIR, href));
      return `<figure class="diagram">${svg}<figcaption>${t.label}</figcaption></figure>`;
    }
    return `<span class="broken">[missing diagram: ${esc(href)}]</span>`;
  }
  return `<img src="${esc(href)}" alt="${esc(stripTags(t.label))}" loading="lazy">`;
}

/**
 * Rewrite a link target for the rendered document.
 *  - sibling chapter  -> in-page anchor
 *  - anything else    -> kept relative, and proven to exist on disk
 */
function resolveHref(href) {
  if (/^https?:/.test(href) || href.startsWith('#')) return href;

  const [file, hash] = href.split('#');

  if (file && !file.includes('/') && file.endsWith('.md')) {
    const target = chapterByKey.get(file.replace(/\.md$/, ''));
    if (!target) {
      note(`link to a markdown file that is not a book chapter: ${href}`);
      return href;
    }
    return `#${target.id}${hash ? `-${hash}` : ''}`;
  }

  // Relative link out of the book (to docs/*.md, README.md, diagrams/*.html).
  // book.html lives in docs/dev-book/, so these resolve unchanged.
  if (file) {
    const abs = path.resolve(BOOK_DIR, file);
    if (!fs.existsSync(abs)) note(`link target does not exist on disk: ${href}`);
    return href;
  }
  return href;
}

/* -------------------------------------------------------------- block pass */

/**
 * `idPrefix` scopes heading ids to their chapter. Every chapter ends with a
 * `## Next` heading; unscoped, seven chapters would all emit id="next".
 */
function renderBlocks(lines, idPrefix = '') {
  const out = [];
  let i = 0;

  const isBlank = (l) => /^\s*$/.test(l);

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      i++;
      continue;
    }

    // fenced code
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1];
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence
      const cls = lang ? ` class="language-${lang}"` : '';
      out.push(`<pre><code${cls}>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const body = inline(h[2].trim());
      // Scope the id to its chapter, then disambiguate repeats within it — two
      // `## Notes` headings in one chapter would otherwise both claim `ch-0N-notes`.
      const base = `${idPrefix}${slug(stripTags(body))}`;
      let hid = base;
      for (let n = 2; headingIds.has(hid); n++) hid = `${base}-${n}`;
      headingIds.add(hid);
      out.push(`<h${level} id="${hid}">${body}</h${level}>`);
      i++;
      continue;
    }

    // table — header row, delimiter row, then body rows
    if (line.trim().startsWith('|') && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const cells = (l) =>
        l
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());

      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) =>
        /^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : ''
      );
      i += 2;

      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));

      for (const r of rows) {
        if (r.length !== head.length) {
          note(`table row has ${r.length} cells but the header has ${head.length}: "${r.join(' | ')}"`);
        }
      }

      const th = head
        .map((c, n) => `<th${align[n] ? ` style="text-align:${align[n]}"` : ''}>${inline(c)}</th>`)
        .join('');
      const tb = rows
        .map(
          (r) =>
            `<tr>${r
              .map((c, n) => `<td${align[n] ? ` style="text-align:${align[n]}"` : ''}>${inline(c)}</td>`)
              .join('')}</tr>`
        )
        .join('');
      out.push(`<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`);
      continue;
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${renderBlocks(buf, idPrefix)}</blockquote>`);
      continue;
    }

    // unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        let item = lines[i++].replace(/^\s*[-*+]\s+/, '');
        while (i < lines.length && !isBlank(lines[i]) && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-*+]\s/.test(lines[i])) {
          item += ' ' + lines[i++].trim();
        }
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        let item = lines[i++].replace(/^\s*\d+[.)]\s+/, '');
        while (i < lines.length && !isBlank(lines[i]) && /^\s{2,}\S/.test(lines[i]) && !/^\s*\d+[.)]\s/.test(lines[i])) {
          item += ' ' + lines[i++].trim();
        }
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // paragraph — consume until a blank line or the start of another block
    const buf = [line];
    i++;
    while (
      i < lines.length &&
      !isBlank(lines[i]) &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !lines[i].trim().startsWith('|')
    ) {
      buf.push(lines[i++]);
    }
    out.push(`<p>${inline(buf.join(' ').trim())}</p>`);
  }

  return out.join('\n');
}

/* ------------------------------------------------------------------- build */

const bodyParts = [];

for (const c of chapters) {
  const html = renderBlocks(c.src.split('\n'), `${c.id}-`);
  bodyParts.push(
    `<section class="chapter" id="${c.id}" data-title="${esc(c.title)}">\n${html}\n</section>`
  );
}

/* Appendix — diagrams that no chapter rendered inline.
   Reading a book about a system without seeing its diagrams is a poor trade, and
   the .html diagram pages cannot be iframed from file:// reliably. */

const diagramFiles = fs.existsSync(DIAGRAM_DIR)
  ? fs.readdirSync(DIAGRAM_DIR).filter((f) => /\.(svg|html)$/.test(f)).sort()
  : [];

const appendix = [];
for (const f of diagramFiles) {
  const rel = `../../diagrams/${f}`;
  const abs = path.resolve(BOOK_DIR, rel);
  if (inlinedDiagrams.has(abs)) continue; // already shown in a chapter

  const svg = fs.existsSync(abs) ? svgFor(abs) : null;
  const caption = `<a href="${rel}">diagrams/${f}</a>`;

  if (svg) {
    appendix.push(`<figure class="diagram">${svg}<figcaption>${caption}</figcaption></figure>`);
  } else {
    appendix.push(
      `<p class="diagram-link">${caption} — standalone page, no inline figure available.</p>`
    );
  }
}

if (appendix.length) {
  bodyParts.push(
    `<section class="chapter" id="appendix-diagrams" data-title="Appendix — Diagram index">\n` +
      `<h1>Appendix — Diagram index</h1>\n` +
      `<p>Every diagram in <code>diagrams/</code> that a chapter does not already render. ` +
      `Generated from disk at build time, so it cannot drift.</p>\n` +
      appendix.join('\n') +
      `\n</section>`
  );
}

/* ---------------------------------------------------------------- assemble */

const nav = [
  ...chapters.map(
    (c) =>
      `<a class="nav-item" href="#${c.id}" data-target="${c.id}">` +
      `<span class="nav-num">${c.id === 'ch-00' ? '—' : c.id.replace('ch-', '')}</span>` +
      `<span class="nav-title">${esc(c.title)}</span></a>`
  ),
  appendix.length
    ? `<a class="nav-item" href="#appendix-diagrams" data-target="appendix-diagrams">` +
      `<span class="nav-num">A</span><span class="nav-title">Diagram index</span></a>`
    : '',
]
  .filter(Boolean)
  .join('\n');

const css = `
*,*::before,*::after{box-sizing:border-box}
:root{
  --paper:#f5f5f5; --surface:#ffffff; --ink:#2d3142; --muted:#4f5d75;
  --soft:#7a8399; --accent:#eb6c36; --link:#2e5aa8;
  --rule:#e3e5ea; --rule-soft:#eef0f3; --code-bg:#f0f1f4;
  --sidebar:#fbfbfc;
  --font-sans:'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  --font-serif:'Instrument Serif',Georgia,serif;
  --font-mono:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
}
html{scroll-behavior:smooth}
body{
  margin:0;background:var(--paper);color:var(--ink);
  font-family:var(--font-sans);font-size:15.5px;line-height:1.68;
  -webkit-font-smoothing:antialiased;
}
.layout{display:grid;grid-template-columns:296px minmax(0,1fr);align-items:start}

/* ---- sidebar ---- */
.sidebar{
  position:sticky;top:0;height:100vh;overflow-y:auto;
  background:var(--sidebar);border-right:1px solid var(--rule);
  padding:1.75rem 1rem 3rem;
}
.brand{padding:0 .6rem 1rem;border-bottom:1px solid var(--rule-soft);margin-bottom:1rem}
.brand .eyebrow{
  font-family:var(--font-mono);font-size:.62rem;font-weight:500;
  letter-spacing:.18em;text-transform:uppercase;color:var(--soft);
}
.brand h1{
  font-family:var(--font-serif);font-size:1.5rem;font-weight:400;
  line-height:1.15;margin:.35rem 0 0;
}
.nav-filter{
  width:100%;margin:0 0 .75rem;padding:.5rem .65rem;
  font-family:var(--font-sans);font-size:.82rem;color:var(--ink);
  background:var(--surface);border:1px solid var(--rule);border-radius:7px;
}
.nav-filter:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:transparent}
.nav-item{
  display:flex;gap:.6rem;align-items:baseline;
  padding:.42rem .6rem;border-radius:7px;text-decoration:none;
  color:var(--muted);font-size:.855rem;line-height:1.35;
}
.nav-item:hover{background:var(--rule-soft);color:var(--ink)}
.nav-item.active{background:#fff;color:var(--ink);box-shadow:inset 2px 0 0 var(--accent)}
.nav-item.active .nav-title{font-weight:600}
.nav-num{
  font-family:var(--font-mono);font-size:.68rem;color:var(--soft);
  min-width:1.5rem;flex:none;padding-top:.1rem;
}
.nav-item.active .nav-num{color:var(--accent)}

/* ---- main ---- */
main{max-width:920px;padding:3.25rem 3.5rem 8rem;min-width:0}
.chapter{
  padding-bottom:3rem;margin-bottom:3rem;
  border-bottom:1px solid var(--rule);
  scroll-margin-top:1.5rem;
}
.chapter:last-child{border-bottom:none;margin-bottom:0}

h1,h2,h3,h4{line-height:1.25;font-weight:600}
.chapter>h1:first-child{
  font-family:var(--font-serif);font-weight:400;font-size:2.45rem;
  letter-spacing:-.01em;margin:0 0 1.5rem;
}
h2{font-size:1.32rem;margin:2.6rem 0 .85rem;padding-top:.4rem}
h3{font-size:1.06rem;margin:1.9rem 0 .6rem}
h4{font-size:.94rem;margin:1.5rem 0 .5rem;color:var(--muted)}
p{margin:0 0 1.05rem}
a{color:var(--link);text-decoration:none;border-bottom:1px solid rgba(46,90,168,.28)}
a:hover{border-bottom-color:var(--link)}
strong{font-weight:600;color:var(--ink)}
em{font-style:italic}
code{
  font-family:var(--font-mono);font-size:.845em;
  background:var(--code-bg);padding:.12em .38em;border-radius:4px;
  color:#3d4257;
}
pre{
  background:var(--code-bg);border:1px solid var(--rule);border-radius:9px;
  padding:1rem 1.1rem;overflow-x:auto;margin:0 0 1.3rem;
}
pre code{background:none;padding:0;font-size:.82rem;line-height:1.6;color:#3d4257}
blockquote{
  margin:0 0 1.3rem;padding:.85rem 1.15rem;
  background:#fbfaf8;border-left:3px solid var(--accent);border-radius:0 8px 8px 0;
  color:var(--muted);font-size:.95rem;
}
blockquote p:last-child{margin-bottom:0}
ul,ol{margin:0 0 1.15rem;padding-left:1.35rem}
li{margin:.28rem 0}
li>code{font-size:.83em}

/* ---- tables ---- */
.table-wrap{overflow-x:auto;margin:0 0 1.5rem;border:1px solid var(--rule);border-radius:9px;background:var(--surface)}
table{border-collapse:collapse;width:100%;font-size:.855rem}
th,td{padding:.6rem .8rem;text-align:left;vertical-align:top;border-bottom:1px solid var(--rule-soft)}
th{
  background:#f7f8fa;font-weight:600;font-size:.78rem;
  letter-spacing:.02em;text-transform:uppercase;color:var(--muted);
  border-bottom:1px solid var(--rule);
}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover{background:#fcfcfd}
td code{font-size:.82em;white-space:nowrap}

/* ---- diagrams ---- */
figure.diagram{
  margin:0 0 1.75rem;padding:1.1rem;background:var(--surface);
  border:1px solid var(--rule);border-radius:11px;
}
figure.diagram svg{display:block;width:100%;height:auto;max-width:100%}
figure.diagram figcaption{
  margin-top:.85rem;padding-top:.7rem;border-top:1px solid var(--rule-soft);
  font-size:.78rem;color:var(--soft);font-family:var(--font-mono);
}
figure.diagram figcaption a{border-bottom:none}
.diagram-link{font-family:var(--font-mono);font-size:.82rem}
.broken{color:#b23b3b;font-family:var(--font-mono);font-size:.85rem}
.generated-note{
  margin:0 0 2rem;padding:.7rem .9rem;background:#fdf6f1;
  border:1px solid #f3d9c9;border-radius:8px;font-size:.78rem;color:var(--muted);
}
.generated-note code{background:#f8ece3}

@media (max-width:1000px){
  .layout{grid-template-columns:1fr}
  .sidebar{position:static;height:auto;border-right:none;border-bottom:1px solid var(--rule)}
  main{padding:2rem 1.25rem 5rem}
  .chapter>h1:first-child{font-size:1.9rem}
}
@media print{
  .sidebar,.generated-note{display:none}
  .layout{grid-template-columns:1fr}
  main{max-width:none;padding:0}
  .chapter{page-break-after:always;border-bottom:none}
  body{background:#fff;font-size:10.5pt}
  a{color:var(--ink);border-bottom:none}
  figure.diagram{page-break-inside:avoid;border:none;padding:0}
}
`;

const js = `
const items=[...document.querySelectorAll('.nav-item')];
const filter=document.getElementById('nav-filter');
if(filter){
  filter.addEventListener('input',()=>{
    const q=filter.value.trim().toLowerCase();
    for(const it of items){
      it.style.display=(it.textContent||'').toLowerCase().includes(q)?'':'none';
    }
  });
}
const sections=[...document.querySelectorAll('section.chapter')];
const byId=new Map(items.map(i=>[i.dataset.target,i]));
const io=new IntersectionObserver((entries)=>{
  for(const e of entries){
    if(!e.isIntersecting)continue;
    for(const it of items)it.classList.remove('active');
    const el=byId.get(e.target.id);
    if(el)el.classList.add('active');
  }
},{rootMargin:'-10% 0px -80% 0px',threshold:0});
for(const s of sections)io.observe(s);
`;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI-Provider Router — Developer Book</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&amp;family=Geist:wght@400;500;600&amp;family=Geist+Mono:wght@400;500&amp;display=swap" rel="stylesheet">
<style>${css}</style>
</head>
<body>
<!-- GENERATED FILE — do not edit. Source: docs/dev-book/*.md. Regenerate: pnpm docs:book -->
<div class="layout">
<nav class="sidebar">
  <div class="brand">
    <p class="eyebrow">AI-Provider Router</p>
    <h1>Developer Book</h1>
  </div>
  <input id="nav-filter" class="nav-filter" type="search" placeholder="Filter chapters…" aria-label="Filter chapters">
  ${nav}
</nav>
<main>
  <p class="generated-note">
    Generated from <code>docs/dev-book/</code> — ${chapters.length} chapters.
    Edit the markdown, then run <code>pnpm docs:book</code>. Never edit this file.
  </p>
${bodyParts.join('\n')}
</main>
</div>
<script>${js}</script>
</body>
</html>
`;

/* ------------------------------------------------- verify, then write once */

// Every in-page anchor must have a matching id.
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
for (const m of html.matchAll(/href="#([^"]+)"/g)) {
  if (!ids.has(m[1])) note(`in-page anchor has no matching id: #${m[1]}`);
}

// No id may be claimed twice. Inlined SVGs each define their own markers and
// gradients; without namespacing they collide and references resolve to the
// wrong definition. Scoped heading ids guard the same property for chapters.
const seen = new Map();
for (const m of html.matchAll(/\sid="([^"]+)"/g)) {
  seen.set(m[1], (seen.get(m[1]) || 0) + 1);
}
for (const [id, n] of seen) {
  if (n > 1) note(`duplicate id "${id}" appears ${n} times`);
}

// No placeholder may survive into the output.
if (html.includes('\u0000')) note('an inline placeholder survived rendering (unbalanced markdown?)');

// Tag balance for the elements this renderer emits.
for (const tag of ['section', 'nav', 'main', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'blockquote', 'ul', 'ol', 'li', 'pre', 'p', 'figure', 'div']) {
  const open = (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
  const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
  if (open !== close) note(`unbalanced <${tag}>: ${open} open, ${close} close`);
}

if (problems.length) {
  console.error(`\n✗ dev-book build failed — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  • ${p}`);
  console.error('');
  process.exit(1);
}

fs.writeFileSync(OUT_FILE, html, 'utf8');

const kb = (fs.statSync(OUT_FILE).size / 1024).toFixed(1);
console.log(`✓ docs/dev-book/book.html — ${chapters.length} chapters, ${inlinedDiagrams.size} inline diagrams, ${appendix.length} in appendix, ${ids.size} ids, ${kb} KB`);
