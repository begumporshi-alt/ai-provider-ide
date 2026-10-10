/**
 * make-fixture-png.mjs — regenerate TINY_PNG_B64 for web-test/mock.mjs.
 *
 * The image-artifact spec needs a picture, not a pixel: a 1x1 fixture renders as an invisible
 * dot, so a screenshot of that card looks broken and a reviewer cannot tell a layout bug from a
 * fixture that carries no content. This one is 96x48 with a visible two-tone mark.
 *
 *   node scripts/make-fixture-png.mjs          # prints the base64 to paste into mock.mjs
 *   node scripts/make-fixture-png.mjs --check  # decodes it back and reports what it is
 */
import { deflateSync, inflateSync } from "node:zlib";

const W = 96;
const H = 48;

/** One scanline per row: each row is a filter byte (0) plus RGB triples. */
function rawPixels() {
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    const row = y * (1 + W * 3);
    raw[row] = 0;
    for (let x = 0; x < W; x++) {
      const i = row + 1 + x * 3;
      // A teal field with a black diagonal band — large flat areas so the PNG compresses tiny.
      const band = Math.abs(x - y * 2) < 6;
      const [r, g, b] = band ? [16, 24, 48] : [42, 157, 143];
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  return raw;
}

/** CRC32, as PNG chunks require. */
function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function buildPng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rawPixels(), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const png = buildPng();
const base64 = png.toString("base64");

if (!process.argv.includes("--check")) {
  console.log("bytes:", png.length);
  console.log("base64:", base64);
} else {
  // Verify by decoding: parse the IHDR back out and inflate the IDAT to count real pixels.
  const sigOk = png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  // Chunks: 8-byte signature, then length(4)+type(4)+data+crc(4).
  let off = 8;
  let idat = Buffer.alloc(0);
  let crcOk = true;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString("ascii", off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    const want = png.readUInt32BE(off + 8 + len);
    if (crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) !== want) crcOk = false;
    if (type === "IDAT") idat = Buffer.concat([idat, data]);
    off += 12 + len;
  }
  const pixels = inflateSync(idat);
  const expected = h * (1 + w * 3);
  const ok = sigOk && crcOk && w === W && h === H && pixels.length === expected;
  console.log(`signature ok: ${sigOk}, all CRCs ok: ${crcOk}`);
  console.log(`size: ${w}x${h}, inflated bytes: ${pixels.length} (expected ${expected})`);
  console.log(`base64 length: ${base64.length}`);
  console.log(ok ? "CHECK OK — the fixture is a valid PNG with real pixels" : "CHECK FAILED");
  process.exit(ok ? 0 : 1);
}
