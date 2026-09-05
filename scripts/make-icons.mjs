/**
 * PWA 用のアイコン PNG を生成する。
 *
 * 画像を 1 枚バイナリで抱えるより、パレットを共有した生成スクリプトを置いたほうが
 * 色を変えたときに追従しやすい。依存を増やしたくないので、PNG は zlib だけで自前に組む。
 *
 *   node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

// ---------------------------------------------------------------- パレット
// src/palette.ts の ember() と同じ定数。あちらは three.js の Color を返すので、
// ここでは同じ式を素の HSL→RGB で写している。
const HUE_LOW = -0.075;
const HUE_HIGH = 0.11;
const SAT_LOW = 0.55;
const SAT_HIGH = 0.34;
const LIGHT_LOW = 0.11;
const LIGHT_HIGH = 0.55;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/** 0..1 を暖色帯の 1 色（0..1 の RGB）へ写す。palette.ts の ember() 相当。 */
function ember(n, glow = 0) {
  const k = clamp01(n);
  const h = ((((HUE_LOW + (HUE_HIGH - HUE_LOW) * k) % 1) + 1) % 1);
  const s = SAT_LOW + (SAT_HIGH - SAT_LOW) * k;
  const l = clamp01(LIGHT_LOW + (LIGHT_HIGH - LIGHT_LOW) * k + glow);
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
}

// ---------------------------------------------------------------- 図案
/** 内側ほど明るい同心円。Breathing Rings のシーンを 1 枚に畳んだ絵柄。 */
const RINGS = [
  { r: 0.22, n: 1.0 },
  { r: 0.4, n: 0.8 },
  { r: 0.58, n: 0.6 },
  { r: 0.76, n: 0.42 },
  { r: 0.94, n: 0.26 },
];

/** 背景。ほぼ黒だが、中心だけわずかに温度を持たせる。 */
const BG_EDGE = [0x08 / 255, 0x06 / 255, 0x07 / 255];
const BG_CORE = [0x18 / 255, 0x0e / 255, 0x0c / 255];

/**
 * RGB の生ピクセルを返す。
 *
 * @param size  1 辺のピクセル数
 * @param inset リングが占める半径の割合。maskable では安全領域に収めるため小さくする。
 */
function render(size, inset) {
  const px = Buffer.alloc(size * size * 3);
  const half = size / 2;
  // 半径方向のぼかし幅。解像度が変わっても見た目が揃うよう正規化座標で持つ。
  const w = 0.055 * inset;

  const rings = RINGS.map((ring) => ({
    r: ring.r * inset,
    color: ember(ring.n, 0.06),
  }));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // ピクセル中心を使うと、円が半ピクセルずれずに済む
      const dx = (x + 0.5 - half) / half;
      const dy = (y + 0.5 - half) / half;
      const d = Math.hypot(dx, dy);

      const fade = clamp01(1 - d / 1.1);
      const t = fade * fade;
      let r = BG_EDGE[0] + (BG_CORE[0] - BG_EDGE[0]) * t;
      let g = BG_EDGE[1] + (BG_CORE[1] - BG_EDGE[1]) * t;
      let b = BG_EDGE[2] + (BG_CORE[2] - BG_EDGE[2]) * t;

      for (const ring of rings) {
        const e = (d - ring.r) / w;
        const halo = (d - ring.r) / (w * 3.2);
        // 細い芯 + 広いにじみ。輪郭を描かずに発光しているように見せる
        const i = Math.exp(-e * e) + 0.32 * Math.exp(-halo * halo);
        r += ring.color[0] * i;
        g += ring.color[1] * i;
        b += ring.color[2] * i;
      }

      // 中心の残り火
      const c = d / (0.1 * inset);
      const ci = 0.85 * Math.exp(-c * c);
      const core = ember(1, 0.16);
      r += core[0] * ci;
      g += core[1] * ci;
      b += core[2] * ci;

      const o = (y * size + x) * 3;
      px[o] = Math.round(clamp01(r) * 255);
      px[o + 1] = Math.round(clamp01(g) * 255);
      px[o + 2] = Math.round(clamp01(b) * 255);
    }
  }
  return px;
}

// ---------------------------------------------------------------- PNG 出力
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

/** 8bit トゥルーカラー、フィルタなしの PNG を組み立てる。 */
function encodePng(size, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  // 10..12 は compression / filter / interlace すべて 0

  const stride = size * 3;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // フィルタ種別: None
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- 実行
// maskable は中央 80% の円に収める決まりなので、その分だけ図案を縮める。
const TARGETS = [
  { file: 'icon-192.png', size: 192, inset: 0.9 },
  { file: 'icon-512.png', size: 512, inset: 0.9 },
  { file: 'maskable-512.png', size: 512, inset: 0.72 },
  // iOS は角を自前で丸めるので、少し余白を持たせておく
  { file: 'apple-touch-icon.png', size: 180, inset: 0.8 },
];

mkdirSync(OUT_DIR, { recursive: true });
for (const t of TARGETS) {
  const png = encodePng(t.size, render(t.size, t.inset));
  writeFileSync(join(OUT_DIR, t.file), png);
  console.log(`${t.file}  ${t.size}x${t.size}  ${(png.length / 1024).toFixed(1)} kB`);
}
