/**
 * make-fixture-pdf.mjs — regenerate TINY_PDF_B64 for web-test/mock.mjs.
 *
 * The PDF-artifact spec needs a fixture the real pdf.js can parse. Hand-writing one risks
 * plausible-looking bytes with wrong xref offsets, which fails inside the renderer where it reads
 * as a broken viewer rather than a bad fixture — so the fixture is generated here and verified by
 * running it through pdf.js before it is pasted into the mock.
 *
 *   node scripts/make-fixture-pdf.mjs            # prints the base64 to paste into mock.mjs
 *   node scripts/make-fixture-pdf.mjs --check    # parses it with pdf.js and reports what it saw
 */
/** Build a minimal, spec-valid one-page PDF with correct xref offsets. */
function buildPdf() {
  const objs = [];
  objs.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  objs.push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  objs.push(
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] " +
      "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
  );
  objs.push("4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");
  const text = "BT /F1 14 Tf 20 45 Td (Artifact preview) Tj ET";
  objs.push(`5 0 obj\n<< /Length ${text.length} >>\nstream\n${text}\nendstream\nendobj\n`);

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const o of objs) {
    offsets.push(pdf.length);
    pdf += o;
  }
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  // latin1: byte values must survive the string round-trip that builds the offsets.
  return Buffer.from(pdf, "latin1");
}

const bytes = buildPdf();
const base64 = bytes.toString("base64");

if (!process.argv.includes("--check")) {
  console.log("bytes:", bytes.length);
  console.log("base64:", base64);
} else {
  // Resolved by path, not by package name: pdf.js is ESM-only and its entry is not resolvable
  // from every directory by specifier alone.
  const entry = new URL("../node_modules/pdfjs-dist/build/pdf.mjs", import.meta.url).href;
  const pdfjs = await import(entry);
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useWasm: false });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const text = (await page.getTextContent()).items.map((i) => i.str).join("");
  const ok = doc.numPages === 1 && text.trim() === "Artifact preview";
  console.log(`pages: ${doc.numPages}`);
  console.log(`viewport: ${Math.round(viewport.width)}x${Math.round(viewport.height)}`);
  console.log(`text: "${text}"`);
  console.log(ok ? "CHECK OK — the fixture parses and carries its text" : "CHECK FAILED");
  // `destroy` is on the LOADING TASK, not the document proxy, in v6 — the proxy has no destroy.
  await task.destroy();
  process.exit(ok ? 0 : 1);
}
