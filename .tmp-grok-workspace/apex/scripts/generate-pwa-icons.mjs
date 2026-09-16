import { deflateSync } from 'zlib';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

// Minimal pure-JS PNG encoder (no dependencies) — generates RGBA PNGs.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function createPNG(width, height, drawFn) {
  const rowLen = width * 4 + 1; // +1 for filter byte
  const raw = Buffer.alloc(rowLen * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowLen] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = drawFn(x, y, width, height);
      const off = y * rowLen + 1 + x * 4;
      raw[off] = r; raw[off + 1] = g; raw[off + 2] = b; raw[off + 3] = a;
    }
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

// Draw the APEX mountain-peak icon.
// Triangle: (0.5, 0.20) top → (0.80, 0.78) bottom-right → (0.20, 0.78) bottom-left.
// Gradient: cyan #00e5ff at top → purple #b84cff at bottom.
// Inner cutout (darker triangle) for depth: smaller triangle inside.
function drawIcon(x, y, w, h, maskable = false) {
  const px = x / w;
  const py = y / h;

  // For maskable, shrink the triangle into the 80% safe zone
  const scale = maskable ? 0.64 : 0.76;
  const cx = 0.5;
  const top = cx + (0.20 - cx) * scale;
  const botL = cx + (0.20 - cx) * scale;
  const botR = cx + (0.80 - cx) * scale;
  const topY = 0.20 + (0.50 - 0.20) * (1 - scale);
  const botY = 0.78 - (0.78 - 0.50) * (1 - scale);

  // Barycentric point-in-triangle test
  const v0x = cx, v0y = topY;
  const v1x = botR, v1y = botY;
  const v2x = botL, v2y = botY;
  const d = (v1y - v2y) * (v0x - v2x) + (v2x - v1x) * (v0y - v2y);
  const a_b = ((v1y - v2y) * (px - v2x) + (v2x - v1x) * (py - v2y)) / d;
  const b_b = ((v2y - v0y) * (px - v2x) + (v0x - v2x) * (py - v2y)) / d;
  const c_b = 1 - a_b - b_b;

  // Background: #07080d
  let r = 0x07, g = 0x08, b = 0x0d, a = 255;

  if (a_b >= 0 && b_b >= 0 && c_b >= 0) {
    // Inside main triangle — gradient cyan→purple
    const t = (py - topY) / (botY - topY); // 0 at top, 1 at bottom
    r = Math.round(0x00 + (0xb8 - 0x00) * t);
    g = Math.round(0xe5 + (0x4c - 0xe5) * t);
    b = 0xff;

    // Inner cutout (smaller triangle, 60% size, darker)
    const innerScale = 0.5;
    const iv0x = cx, iv0y = topY + (botY - topY) * (1 - innerScale) * 0.5;
    const iv1x = cx + (botR - cx) * innerScale, iv1y = botY - (botY - topY) * (1 - innerScale) * 0.5;
    const iv2x = cx + (botL - cx) * innerScale, iv2y = iv1y;
    const id = (iv1y - iv2y) * (iv0x - iv2x) + (iv2x - iv1x) * (iv0y - iv2y);
    const ia = ((iv1y - iv2y) * (px - iv2x) + (iv2x - iv1x) * (py - iv2y)) / id;
    const ib = ((iv2y - iv0y) * (px - iv2x) + (iv0x - iv2x) * (py - iv2y)) / id;
    const ic = 1 - ia - ib;
    if (ia >= 0 && ib >= 0 && ic >= 0) {
      r = Math.round(r * 0.35 + 0x07 * 0.65);
      g = Math.round(g * 0.35 + 0x08 * 0.65);
      b = Math.round(b * 0.35 + 0x0d * 0.65);
    }
  }

  return [r, g, b, a];
}

const dir = resolve('packages/dashboard/public');

// Generate icons at required sizes
const sizes = [192, 512, 180]; // 180 for apple-touch-icon
for (const size of sizes) {
  const buf = createPNG(size, size, (x, y, w, h) => drawIcon(x, y, w, h, false));
  writeFileSync(resolve(dir, `icon-${size}.png`), buf);
  console.log(`Generated icon-${size}.png (${buf.length} bytes)`);
}

// Maskable 512 (triangle shrunk to safe zone, full-bleed background)
const maskable = createPNG(512, 512, (x, y, w, h) => drawIcon(x, y, w, h, true));
writeFileSync(resolve(dir, 'icon-maskable-512.png'), maskable);
console.log(`Generated icon-maskable-512.png (${maskable.length} bytes)`);
