/**
 * copy-pdfjs-assets.mjs — stage pdf.js's runtime assets into `public/pdfjs/`.
 *
 * Why a copy step instead of committing them: the cmaps (1.6 MB), standard fonts (816 KB), wasm
 * decoders and ICC profiles total ~3.9 MB across ~200 files, all of it Apache-2.0 content that
 * already ships inside the `pdfjs-dist` dependency. Vendoring it into git would duplicate the
 * dependency and add megabytes to every clone; staging it at build time keeps the repo the source
 * of truth and still gives the offline app real files to read.
 *
 * Why each directory is needed (from the dependency review, 2026-10-09):
 *  - `cmaps` — CJK fonts parse only if these resolve; a missing URL is a page ERROR, not a
 *    graceful glyph fallback. 1.6 MB of insurance.
 *  - `standard_fonts` — Symbol/ZapfDingbats; degrades quietly when absent.
 *  - `wasm` — the app's CSP has no `wasm-unsafe-eval`, so the wasm decoders will not RUN; but
 *    this directory also holds the JS fallbacks (`*_nowasm_fallback.js`) whose location is
 *    derived from `wasmUrl`. Without it, scanned (CCITT/JBIG2) and JPEG2000 images in a PDF
 *    decode to nothing at all.
 *  - `iccs` — one ICC profile; color management degrades quietly when absent.
 *
 * Deliberately skipped: `*.map` (7.5 MB of source maps) and the QuickJS pair (only reachable with
 * PDF scripting enabled, which the viewer does not enable).
 */
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");
const SRC = join(APP, "node_modules", "pdfjs-dist");
const DEST = join(APP, "public", "pdfjs");

/** The kept subdirectories, each copied verbatim minus source maps. */
const DIRS = ["cmaps", "standard_fonts", "wasm", "iccs"];

/** Files this script will never stage — see the header. */
const SKIP = [/\.map$/, /^quickjs-eval\./];

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Recursive copy that honours SKIP. */
async function copyFiltered(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (SKIP.some((re) => re.test(entry.name))) continue;
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory()) await copyFiltered(src, dest);
    else await cp(src, dest);
  }
}

async function countFiles(dir) {
  let n = 0;
  let bytes = 0;
  const walk = async (d) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else {
        n += 1;
        bytes += (await stat(p)).size;
      }
    }
  };
  await walk(dir);
  return { n, bytes };
}

if (!(await exists(SRC))) {
  // Not a hard failure: the harness and a dev server that never opens a PDF do not need these,
  // and failing the build over a missing optional dev dependency helps nobody.
  console.warn(`[pdfjs] ${SRC} not found — skipping asset staging (PDF previews will degrade).`);
  process.exit(0);
}

await rm(DEST, { recursive: true, force: true });
for (const dir of DIRS) {
  const from = join(SRC, dir);
  if (!(await exists(from))) {
    console.warn(`[pdfjs] ${dir}/ is not shipped by this pdfjs-dist version — skipped.`);
    continue;
  }
  await copyFiltered(from, join(DEST, dir));
}
const { n, bytes } = await countFiles(DEST);
console.log(`[pdfjs] staged ${n} files (${(bytes / 1024 / 1024).toFixed(1)} MB) into public/pdfjs/`);
