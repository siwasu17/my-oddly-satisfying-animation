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
/**
 * 暗い水面の上に浮かぶ、内側から灯った琥珀色の球。
 * 球の真下から楕円の波紋が広がり、水面には球の光が縦に伸びて映り込む。
 * 「3D」「ループ」「就寝前」を 1 枚で言えて、小さく縮めても球の形だけは残る。
 *
 * 座標は -1..1 の正規化座標（y は下向き）。inset を掛けて全体を縮める。
 */

/** 背景。ほぼ黒だが、青みを消すためにわずかに暖色へ寄せている。 */
const BG_EDGE = [0x08 / 255, 0x06 / 255, 0x07 / 255];
const BG_CORE = [0x1a / 255, 0x0f / 255, 0x0d / 255];

const ORB = { x: 0, y: -0.12, r: 0.44 };
/** 水面の高さ（波紋の中心）と、楕円の縦横比。小さいほど水面を浅い角度で見る。 */
const WATER_Y = 0.54;
const FLAT = 0.28;
/** 内側ほど明るく、太く、はっきりした波紋。 */
const RIPPLES = [
  { r: 0.3, n: 0.85, a: 0.95 },
  { r: 0.55, n: 0.62, a: 0.6 },
  { r: 0.8, n: 0.42, a: 0.34 },
];

const norm = (v) => {
  const l = Math.hypot(...v);
  return v.map((c) => c / l);
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const smooth = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** 左上手前からの光。球を「光る点」ではなく立体に見せるための向き。 */
const LIGHT = norm([-0.55, -0.7, 0.6]);
const HALF = norm([LIGHT[0], LIGHT[1], LIGHT[2] + 1]);

const C_SPEC = ember(1, 0.3);
const C_CORE = ember(1, 0.12);
const C_HALO = ember(0.55, 0.05);
const C_RIM = ember(0.15, 0.1);

/** 1 点の色（0..1 の RGB、はみ出してよい）。s は inset。 */
function shade(x, y, s) {
  const d = Math.hypot(x, y);

  // 背景: 中心から少しだけ下（水面の照り返し）に温度を持たせる
  const bgT = clamp01(1 - Math.hypot(x, (y - 0.1) * 1.1) / 1.25) ** 2;
  let c = BG_EDGE.map((e, i) => e + (BG_CORE[i] - e) * bgT);
  const add = (col, k) => {
    c[0] += col[0] * k;
    c[1] += col[1] * k;
    c[2] += col[2] * k;
  };

  const ox = ORB.x * s;
  const oy = ORB.y * s;
  const orr = ORB.r * s;
  const wy = WATER_Y * s;

  // ---- 水面（地平線より下だけ）
  const horizon = wy - 0.34 * s;
  const below = smooth(horizon, horizon + 0.12 * s, y);
  if (below > 0) {
    // 波紋: 楕円距離で測ると、上下が自然に細くなって奥行きが出る
    const ed = Math.hypot(x, (y - wy) / FLAT);
    for (const rp of RIPPLES) {
      const e = (ed - rp.r * s) / (0.022 * s);
      const glow = (ed - rp.r * s) / (0.09 * s);
      // 手前（下半分）ほど明るい。奥は球の影に入って沈む
      const front = 0.45 + 0.55 * smooth(-0.6, 0.6, (y - wy) / (rp.r * s * FLAT));
      const k = rp.a * front * below * (Math.exp(-e * e) + 0.28 * Math.exp(-glow * glow));
      add(ember(rp.n, 0.05), k);
    }
    // 球の映り込み: 縦に伸びた光の柱が、水面の揺れで横に少し滲む
    const ry = (y - (wy - 0.04 * s)) / (0.42 * s);
    const rx = x / (0.12 * s * (1 + 0.8 * Math.max(0, ry)));
    const refl = Math.exp(-rx * rx) * Math.exp(-ry * ry * 1.6) * below;
    add(C_HALO, 0.6 * refl);
  }

  // ---- 球
  const px = (x - ox) / orr;
  const py = (y - oy) / orr;
  const q = px * px + py * py;

  // 外側のにじみ（ブルームの代わり）
  const out = Math.sqrt(q);
  if (out > 0.9) {
    const h = Math.max(0, out - 1);
    add(C_HALO, 0.55 * Math.exp(-h * 3.2) * smooth(0.9, 1.0, out));
  }

  // 輪郭は 1.5px 程度の幅でなめらかに切る（呼び出し側でも超標本化している）
  const edge = 1 - smooth(1 - 0.012 / s, 1 + 0.012 / s, out);
  if (edge > 0) {
    const nz = Math.sqrt(Math.max(0, 1 - q));
    const n = [px, py, nz];
    const diff = Math.max(0, dot(n, LIGHT));
    // 内側から灯っているように、正面ほど明るい自己発光を足す
    const glowIn = Math.pow(nz, 1.6);
    const base = ember(0.3 + 0.45 * diff + 0.35 * glowIn, 0.02);
    const spec = Math.pow(Math.max(0, dot(n, HALF)), 60);
    // 下側の縁に水面からの照り返し
    const rim = Math.pow(1 - nz, 2.5) * smooth(-0.2, 0.9, py);
    const col = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      col[i] =
        base[i] * (0.55 + 0.65 * diff) +
        C_CORE[i] * 0.55 * glowIn * glowIn * glowIn +
        C_SPEC[i] * 1.1 * spec +
        C_RIM[i] * 1.4 * rim;
    }
    c = c.map((v, i) => v * (1 - edge) + col[i] * edge);
  }

  return c;
}

/** 強い光を白飛びさせず、なめらかに頭打ちさせる。 */
const tone = (v) => (v < 0.75 ? v : 0.75 + 0.25 * (1 - Math.exp(-(v - 0.75) * 4)));

/**
 * RGB の生ピクセルを返す。
 *
 * @param size  1 辺のピクセル数
 * @param inset 図案が占める割合。maskable では安全領域に収めるため小さくする。
 */
function render(size, inset) {
  const px = Buffer.alloc(size * size * 3);
  const half = size / 2;
  // 4x4 の超標本化で、球の輪郭と細い波紋のギザギザを消す
  const SS = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = (x + (sx + 0.5) / SS - half) / half;
          const dy = (y + (sy + 0.5) / SS - half) / half;
          const c = shade(dx, dy, inset);
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const k = 1 / (SS * SS);
      const o = (y * size + x) * 3;
      px[o] = Math.round(clamp01(tone(r * k)) * 255);
      px[o + 1] = Math.round(clamp01(tone(g * k)) * 255);
      px[o + 2] = Math.round(clamp01(tone(b * k)) * 255);
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
