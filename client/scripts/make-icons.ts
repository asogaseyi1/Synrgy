/**
 * Generates the PWA icons (a white clock on the brand orange) without any image library.
 *   node client/scripts/make-icons.ts
 * Writes PNGs to client/public/icons/. Re-run only if the design changes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/icons');
mkdirSync(out, { recursive: true });

// ---- minimal PNG encoder ----
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf: Buffer) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size: number, rgba: Uint8Array) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- shapes in unit coordinates (0..1) ----
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const TOP = hex('#fb8a3c');
const BOTTOM = hex('#c2410c');

function inRoundedRect(x: number, y: number, r: number) {
  const dx = Math.max(r - x, 0, x - (1 - r));
  const dy = Math.max(r - y, 0, y - (1 - r));
  return dx * dx + dy * dy <= r * r;
}
/** Distance from point to segment a-b. */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const vx = bx - ax;
  const vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

function render(size: number, { maskable }: { maskable: boolean }) {
  const scale = maskable ? 0.78 : 1; // keep the mark inside the maskable safe zone
  const ringR = 0.3 * scale;
  const stroke = 0.058 * scale;
  const hand = 0.05 * scale;
  const corner = maskable ? 0 : 0.22;
  const px = new Uint8Array(size * size * 4);
  const SS = 4; // supersampling per axis

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          if (!inRoundedRect(u, v, corner)) continue;
          bg++;
          const d = Math.hypot(u - 0.5, v - 0.5);
          const ring = Math.abs(d - ringR) <= stroke / 2;
          const minute = segDist(u, v, 0.5, 0.5, 0.5, 0.5 - 0.2 * scale) <= hand / 2; // 12 o'clock
          const hour = segDist(u, v, 0.5, 0.5, 0.5 + 0.14 * scale, 0.5) <= hand / 2; // 3 o'clock
          if (ring || minute || hour) fg++;
        }
      }
      const n = SS * SS;
      const t = y / (size - 1);
      const base = TOP.map((c, i) => c + (BOTTOM[i] - c) * t);
      const f = fg / Math.max(bg, 1);
      const i = (y * size + x) * 4;
      px[i] = Math.round(base[0] + (255 - base[0]) * f);
      px[i + 1] = Math.round(base[1] + (255 - base[1]) * f);
      px[i + 2] = Math.round(base[2] + (255 - base[2]) * f);
      px[i + 3] = Math.round((bg / n) * 255);
    }
  }
  return png(size, px);
}

const files: [string, number, boolean][] = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true], // iOS rounds the corners itself and dislikes transparency
];
for (const [name, size, maskable] of files) {
  writeFileSync(path.join(out, name), render(size, { maskable }));
  console.log(`wrote ${name}`);
}
