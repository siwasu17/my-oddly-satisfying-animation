import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker, tickers } from '../audio.ts';
import { ember, drift } from '../palette.ts';

/**
 * 夕暮れの棚田。入り江から立ち上がる斜面に、うねる等高線に沿って田が 8 段重なり、
 * 稜線の向こうに夕日が沈みかけている。
 *
 * 最上段の端の水口から水が入り、田を 1 枚ずつ満たしては畦を越えて隣へ進み、
 * 段の端まで来ると下の段へ落ちて、今度は逆向きに進む。水は段ごとに折り返しながら
 * 入り江へ下りていき、乾いた土の段が 1 枚ずつ夕空を映す水鏡に変わる。全部が満ちると
 * 斜面一面が残照を映す鏡の階段になる。この「暗い段が端から空の色に変わっていく連鎖」が芯。
 * 40 秒で一巡し、21 秒かけて満ち、6 秒そのまま、9 秒かけて同じ順に水が抜けていく。
 *
 * 水面・海・空は同じ空の式を共有する。水面は視線を水平面で折り返した向きの空の色を
 * 塗っているだけで、映り込みを描き直してはいない。カメラは入り江の上から斜面を見上げる。
 * 音は田が満ちるたびの水音、段を落ちるたびに一音ずつ下がる弦、低い持続音。
 * 稲・人・鳥、夕日が沈んでいく光の移ろい、畦や山の映り込みはスコープ外。
 */

// ---- 棚田の形（以下の長さは設計上の単位。SCALE を掛けて置く） --------------------

/** 設計上の単位から、ステージの単位への縮尺。大きく作ると霧に沈むので縮めて置く */
const SCALE = 0.45;
/** 段の数。0 が最上段 */
const TIERS = 8;
/** 田面の幅（段ごとに ±15% ばらつく） */
const FLOOR_W = 2.4;
/** 畦の内側の立ち上がりの奥行き、天端の幅、高さ */
const LIP_IN = 0.06;
const LIP_W = 0.3;
const LIP_H = 0.16;
/** 段の法面の奥行きと、段どうしの高低差（±15% ばらつく） */
const RISER_W = 0.5;
const STEP_H = 1.0;
/** 最下段の田面の高さ。海面は y = 0 */
const BOTTOM_H = 1.2;
/** 最下段の畦の z。これより手前（+z）が入り江 */
const BOTTOM_Z = 1.5;
/** 田の並ぶ左右の範囲と、段の端のぶれ */
const XP = 20;
const X_JIT = 2.5;
/** 段の端から、ならされて自然の斜面になるまでの幅 */
const FADE = 5;
/** 陸の左右の広がりと分割数 */
const XMAX = 70;
const COLS = 280;
/** 左右の山の盛り上がり */
const SIDE_H = 7;
/** 等高線のうねり: 尾根の張り出し（下の段ほど大きい）と、細かな波 */
const SPUR = 3.2;
const WAVE_A = 0.8;
const WAVE_B = 0.35;
/** 稜線の高さのうねり */
const RIDGE_VAR = 2.2;
/** 田 1 枚の長さの目安と、畦の位置のぶれ */
const PADDY_LEN = 10;
const PADDY_JITTER = 0.4;
/** 最上段より山側: [最上段の外縁からの距離（負が山側）, 最上段の田面からの高さ, 稜線のうねりの効き] */
const HILL: readonly (readonly [number, number, number])[] = [
  [-42, 2, 1],
  [-23, 6.5, 1],
  [-16, 8, 1],
  [-11, 6.5, 0.8],
  [-6, 4, 0.5],
  [-2.5, 2, 0.2],
  [-RISER_W, STEP_H, 0],
];
/** 最下段の畦から入り江へ下りる浜: [畦からの距離, 高さ, 左右の山の効き] */
const SHORE: readonly (readonly [number, number, number])[] = [
  [0.8, BOTTOM_H - 0.5, 0.6],
  [2, 0.2, 0.3],
  [3.5, -1.5, 0],
];

/** 陸の色: [ember の n, 明るさの倍率] */
const MUD: readonly [number, number] = [0.45, 0.28];
const LIP: readonly [number, number] = [0.6, 0.42];
const RISER: readonly [number, number] = [0.38, 0.2];
const FOREST: readonly [number, number] = [0.32, 0.16];
/**
 * 陸の陰影は頂点色に焼き込む（環境光 + 右上手前からの光）。ステージの点光源は
 * 左の丘の斜面にほぼ接する位置にあって赤く焼けるので、陸には光を当てない
 */
const SHADE_AMB = 0.3;
const SHADE_KEY = 0.45;
const SHADE_DIR = new THREE.Vector3(8, 18, 10).normalize();
/** 段の端で田面を細らせて消す幅（この先で斜面へならす） */
const TAPER = 3;

// ---- 水 --------------------------------------------------------------------

/** 一巡の秒数と、その中の区切り（秒） */
const PERIOD = 40;
const FILL0 = 1;
const FILL1 = 22;
const DRAIN0 = 28;
const DRAIN1 = 37;
/** 1 枚の田から水が抜けきるまでの秒数 */
const DRAIN_EACH = 2.4;
/** 満ちる時間の配分（田の長さ換算）: 1 枚ぶんの基本、畦を越える間、段を落ちる間 */
const FILL_BASE = 0.8;
const LEVEE_GAP = 0.3;
const DROP_GAP = 0.9;
/** 水面 1 枚の分割、田面からの持ち上げ、縁からの控え */
const PADDY_COLS = 24;
const WATER_LIFT = 0.05;
const WATER_INSET = 0.03;
/** 水の先端で、田の中ほどが縁より先へ進む量（田の長さに対する比） */
const FRONT_LAG = 0.12;
/** 水の先端の照り。先端からこの長さで消える */
const FRONT_GLOW = 0.35;
const FRONT_LEN = 1.2;
/** 水鏡の明るさ、琥珀色への寄せ具合、さざ波の強さ・細かさ（ステージの単位） */
const WATER_GAIN = 2.2;
const WATER_AMBER = 0.9;
const WATER_RIPPLE = 0.012;
const WATER_FREQ = 3.8;
/** 段を落ちる水の幅、分割、段の端からの控え、明るさ */
const FALL_W = 0.3;
const FALL_SEG = 5;
const FALL_IN = 0.6;
const FALL_GLOW = 0.04;
const FALL_ALPHA = 0.45;

// ---- 空と海（ステージの単位） ------------------------------------------------

/** 夕日の向き。稜線のすぐ上、わずかに左 */
const SUN_DIR = new THREE.Vector3(-0.25, 0.06, -1).normalize();
/** 太陽の円盤の見かけの半径（ラジアン）と明るさ */
const SUN_R = 0.025;
const SUN_DISC = 1.8;
/** 空の色: [ember の n, 明るさ]。天頂 / 太陽と反対側の地平 / 太陽側の地平 / 太陽 */
const ZEN: readonly [number, number] = [0.32, 0.05];
const HOR: readonly [number, number] = [0.5, 0.1];
const GLOW: readonly [number, number] = [0.78, 0.28];
const SUN: readonly [number, number] = [1, 1];
/** 地平の明るさが上へ抜けていく速さ。太陽と反対側 / 太陽側 */
const SKY_FALL_AWAY = 7;
const SKY_FALL_SUN = 2.2;
/** 地平の明るさを太陽の方位へ寄せる鋭さ */
const SKY_TOWARD = 5;
// 縦長画面ではカメラが最大 3 倍まで下がるので、それより外に置く
const SKY_R = 220;
const SEA_R = 210;
const SEA_RIPPLE = 0.05;
const SEA_TINT = 0.5;
/** 海に映す空の色を、地平の薔薇色へ寄せる割合（暗い琥珀はオリーブに見えるので） */
const SEA_ROSE = 0.6;

/** 入り江の上から、斜面を少し右寄りに見上げる（設計上の単位） */
const CAM: readonly [number, number, number] = [12, 20, 46];
const CAM_TARGET: readonly [number, number, number] = [0, 6, -14];

// ---------------------------------------------------------------------------

const scaled = (v: readonly [number, number, number]): [number, number, number] => [
  v[0] * SCALE,
  v[1] * SCALE,
  v[2] * SCALE,
];

let seed = 0.4127;
/** 固定シードの乱数。Math.random() を使うと開き直すたびに絵が変わる。 */
const rnd = (): number => (seed = (seed * 9301 + 0.49297) % 1);

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth01 = (x: number): number => {
  const k = clamp01(x);
  return k * k * (3 - 2 * k);
};
const smoothstep = (a: number, b: number, x: number): number => smooth01((x - a) / (b - a));
/** a から fin 秒で立ち上がり、b から fout 秒で消える */
const envelope = (x: number, a: number, b: number, fin: number, fout: number): number =>
  smooth01((x - a) / fin) * (1 - smooth01((x - b) / fout));

/** 段 i の水の流れる向き。偶数段は左から右、奇数段は右から左 */
const forward = (i: number): boolean => i % 2 === 0;

// ---- 段の寸法（build で決める） -----------------------------------------------

/** 段ごとの外縁（山側）と内縁の、斜面を下る向きの距離 s。0 が最上段の外縁 */
let sOut: number[] = [];
let sIn: number[] = [];
/** 段ごとの田面の高さ、左右の端 */
let hFloor: number[] = [];
let xL: number[] = [];
let xR: number[] = [];
/** 段を並べ終えた深さ（最上段の外縁から最下段の畦まで） */
let depth = 1;

/** 等高線のうねり。s（斜面を下る距離）でゆっくり変わるので、隣り合う段の縁は交わらない */
function meander(s: number, x: number): number {
  const d = clamp01(s / depth);
  const g = Math.exp(-(((x - 5) / 10) ** 2)) - 0.7 * Math.exp(-(((x + 12) / 7) ** 2));
  return (
    SPUR * g * (0.25 + 0.75 * d) +
    WAVE_A * Math.sin(x * 0.16 + 0.8 + s * 0.04) +
    WAVE_B * Math.sin(x * 0.37 - s * 0.07 + 2.1)
  );
}
/** 斜面を s だけ下った等高線の、x での z */
const zOf = (s: number, x: number): number => BOTTOM_Z - depth + s + meander(s, x);

function planTiers(): void {
  sOut = [];
  sIn = [];
  hFloor = [];
  xL = [];
  xR = [];
  // 段の端は、水が落ちていく側を上下の段で揃える（右端は 0-1, 2-3 段、左端は 1-2, 3-4 段が共有）
  const jr: number[] = [];
  const jl: number[] = [];
  for (let k = 0; k <= TIERS / 2 + 1; k++) {
    jr.push((rnd() - 0.5) * 2 * X_JIT);
    jl.push((rnd() - 0.5) * 2 * X_JIT);
  }
  let s = 0;
  const steps: number[] = [];
  for (let i = 0; i < TIERS; i++) {
    const w = FLOOR_W * (0.85 + 0.3 * rnd());
    sOut.push(s);
    sIn.push(s + w);
    s += w + LIP_IN + LIP_W + RISER_W;
    steps.push(STEP_H * (0.85 + 0.3 * rnd()));
    xR.push(XP + jr[Math.floor(i / 2)]!);
    xL.push(-XP + jl[Math.floor((i + 1) / 2)]!);
  }
  depth = s - RISER_W;
  let h = BOTTOM_H;
  for (let i = TIERS - 1; i >= 0; i--) {
    hFloor[i] = h;
    h += steps[i]!;
  }
}

/** 田面 1 枚ぶん。a が水の入る側、b が出ていく側の x。時刻は周期の中の秒 */
interface Paddy {
  tier: number;
  a: number;
  b: number;
  /** 満ち始め / 満ちきり / 抜け始め */
  fs: number;
  fe: number;
  ds: number;
}

/** 段へ落ちる水（0 は最上段へ入る水口）。on は満ちるとき、dr は抜けるときに流れる区間 */
interface Fall {
  x: number;
  on0: number;
  on1: number;
  dr0: number;
  dr1: number;
}

// ---- 空・海・水面が共有する式 -------------------------------------------------

const U = {
  uSun: { value: SUN_DIR.clone() },
  uZen: { value: new THREE.Color() },
  uHor: { value: new THREE.Color() },
  uGlow: { value: new THREE.Color() },
  uSunC: { value: new THREE.Color() },
  uTime: { value: 0 },
};

const f = (x: number): string => x.toFixed(5);

const SKY_GLSL = /* glsl */ `
uniform vec3 uSun;
uniform vec3 uZen;
uniform vec3 uHor;
uniform vec3 uGlow;
uniform vec3 uSunC;
uniform float uTime;
varying vec3 vW;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 u = fract(p);
  u = u * u * (3.0 - 2.0 * u);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + 17.1;
    a *= 0.5;
  }
  return s;
}

/** 空の色。d は単位ベクトルで、上半分だけを扱う。disc が 0 なら太陽の円盤を描かない（映り込み用） */
vec3 skyCol(vec3 d, float disc) {
  float y = max(d.y, 0.0);
  vec2 hz = normalize(d.xz + vec2(1e-5));
  float toward = dot(hz, normalize(uSun.xz)) * 0.5 + 0.5;
  float tw = pow(toward, ${f(SKY_TOWARD)});
  // 地平の色は太陽の側ほど明るい琥珀。太陽の側ほど明るさが高くまで残る
  vec3 hor = mix(uHor, uGlow, tw);
  vec3 c = mix(uZen, hor, exp(-y * mix(${f(SKY_FALL_AWAY)}, ${f(SKY_FALL_SUN)}, tw)));
  float mu = max(dot(d, uSun), 0.0);
  c += uSunC * (pow(mu, 8.0) * 0.12 + pow(mu, 80.0) * 0.3);

  float ang = sqrt(max(2.0 * (1.0 - dot(d, uSun)), 0.0));
  c = mix(c, uSunC * ${f(SUN_DISC)}, disc * (1.0 - smoothstep(${f(SUN_R * 0.8)}, ${f(SUN_R)}, ang)));

  // 横に流れる薄い雲。太陽の側だけ下から照らされる
  vec2 p = d.xz / (d.y + 0.1);
  float cov = smoothstep(0.5, 0.78, fbm(p * vec2(0.35, 1.4) + vec2(uTime * 0.01, 0.0)));
  cov *= smoothstep(0.03, 0.1, d.y) * (1.0 - smoothstep(0.22, 0.45, d.y));
  vec3 cc = mix(uZen * 0.8, uGlow * 1.1, pow(toward, 4.0)) + uSunC * pow(mu, 16.0) * 0.5;
  return mix(c, cc, cov * 0.8);
}

/** 海の色。V は視線、q は海面上の点、dist はそこまでの距離 */
vec3 seaCol(vec3 V, vec2 q, float dist) {
  // 遠くのさざ波は画素より細かくなってちらつくので、平らな鏡へ寄せる
  float amp = ${f(SEA_RIPPLE)} * (1.0 - smoothstep(20.0, 150.0, dist));
  vec2 g = vec2(
    sin(q.x * 0.8 + q.y * 0.3 + uTime * 1.2) * 0.6 + sin(q.x * 1.9 - q.y * 1.3 - uTime * 1.7) * 0.4,
    sin(q.y * 0.9 - q.x * 0.4 + uTime * 1.0) * 0.6 + sin(q.y * 2.2 + q.x * 1.1 + uTime * 1.5) * 0.4);
  vec3 N = normalize(vec3(g.x * amp, 1.0, g.y * amp));
  vec3 R = reflect(V, N);
  R.y = max(R.y, 0.003);
  vec3 c = skyCol(normalize(R), 0.0) * ${f(SEA_TINT)};
  vec3 lw = vec3(0.2126, 0.7152, 0.0722);
  c = mix(c, uHor / max(dot(uHor, lw), 1e-4) * dot(c, lw), ${f(SEA_ROSE)});
  // 夕日の照り返しの道。太陽と同じ方位にだけ、きらめきが縦に並ぶ
  vec2 hz = normalize(V.xz + vec2(1e-5));
  float path = exp(-(1.0 - dot(hz, normalize(uSun.xz))) / 0.0012);
  float spark = smoothstep(0.35, 0.95, vnoise(q * vec2(0.6, 0.25) + vec2(0.0, uTime * 0.5)));
  return c + uSunC * path * exp(V.y / 0.12) * (0.12 + 0.3 * spark);
}
`;

/**
 * 空の式で色を塗る MeshBasicMaterial。body は vec3 を返す GLSL の関数本体。
 * glow を立てると頂点属性 aGlow を vGlow として body から読める。
 * onBeforeCompile の中身が同じ文字列だと three がプログラムを使い回すので、key で分ける
 */
function skyShaded(
  key: string,
  body: string,
  opt: THREE.MeshBasicMaterialParameters,
  glow = false,
): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial(opt);
  const vDecl = glow ? 'attribute float aGlow;\nvarying float vGlow;\n' : '';
  const vSet = glow ? '\n  vGlow = aGlow;' : '';
  const fDecl = glow ? 'varying float vGlow;\n' : '';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `${vDecl}varying vec3 vW;\nvoid main() {`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n  vW = (modelMatrix * vec4(transformed, 1.0)).xyz;${vSet}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${fDecl}${SKY_GLSL}\nvec3 shade() {\n${body}\n}\nvoid main() {`)
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( shade(), opacity );');
  };
  mat.customProgramCacheKey = () => `riceTerraces-${key}`;
  return mat;
}

const SKY_BODY = /* glsl */ `
  vec3 d = normalize(vW - cameraPosition);
  if (d.y >= 0.0) return skyCol(d, 1.0);
  // 海の円盤より外は、空の球の下半分に同じ海を描き足す
  float k = min(cameraPosition.y / max(-d.y, 1e-4), 4000.0);
  return seaCol(d, cameraPosition.xz + d.xz * k, k);
`;

const SEA_BODY = /* glsl */ `
  vec3 V = normalize(vW - cameraPosition);
  return seaCol(V, vW.xz, length(vW - cameraPosition));
`;

const WATER_BODY = /* glsl */ `
  vec3 V = normalize(vW - cameraPosition);
  vec2 q = vW.xz * ${f(WATER_FREQ)};
  vec2 g = vec2(sin(q.x * 1.7 + uTime * 0.9) + sin(q.y * 2.3 - uTime * 1.3),
                sin(q.y * 1.9 + uTime * 1.1) + sin(q.x * 2.1 + q.y * 0.7 - uTime * 0.8));
  vec3 N = normalize(vec3(g.x * ${f(WATER_RIPPLE)}, 1.0, g.y * ${f(WATER_RIPPLE)}));
  vec3 R = reflect(V, N);
  R.y = max(R.y, 0.01);
  // 本物のフレネルより強めに映す。見下ろしていても水鏡に見えるように
  float F = mix(0.5, 1.0, pow(1.0 - clamp(-dot(V, N), 0.0, 1.0), 2.0));
  // 映した空の明るさはそのままに、色を残照の琥珀へ寄せる（灰白に見えないように）
  vec3 s = skyCol(normalize(R), 0.0);
  vec3 lw = vec3(0.2126, 0.7152, 0.0722);
  vec3 amber = uGlow / max(dot(uGlow, lw), 1e-4);
  s = mix(s, amber * dot(s, lw), ${f(WATER_AMBER)});
  vec3 c = mix(uZen * 0.3, s * ${f(WATER_GAIN)}, F);
  return c + uSunC * vGlow * ${f(FRONT_GLOW)};
`;

// ---- build で作り直すもの ---------------------------------------------------

let paddies: Paddy[] = [];
let falls: Fall[] = [];
/** 田を横切る畦: [段, x] */
let levees: (readonly [number, number])[] = [];

let waterGeo: THREE.BufferGeometry;
let waterPos: Float32Array;
let waterGlow: Float32Array;
let fallGeo: THREE.BufferGeometry;
let fallCol: Float32Array;

const fallTint = new THREE.Color();

let fillTicks: ((phase: number) => number)[] = [];
let dropTicks: ((phase: number) => number)[] = [];
let fullTick = ticker();
let drainTick = ticker();

/** 田を区切り、水が入る順に並べて、満ちる / 抜ける時刻を割り振る */
function planPaddies(): void {
  paddies = [];
  levees = [];
  let c = 0;
  for (let i = 0; i < TIERS; i++) {
    const l = xL[i]!;
    const r = xR[i]!;
    const n = Math.max(2, Math.round((r - l) / PADDY_LEN));
    const b: number[] = [l];
    for (let j = 1; j < n; j++) b.push(l + ((r - l) * (j + (rnd() - 0.5) * PADDY_JITTER)) / n);
    b.push(r);
    // 段の両端には置かない（細っていく田の先で、杭が立っているように見える）
    for (const x of b.slice(1, -1)) levees.push([i, x]);

    const fwd = forward(i);
    for (let j = 0; j < n; j++) {
      const jj = fwd ? j : n - 1 - j;
      const a = fwd ? b[jj]! : b[jj + 1]!;
      const e = fwd ? b[jj + 1]! : b[jj]!;
      const dur = FILL_BASE + Math.abs(e - a) / PADDY_LEN;
      paddies.push({ tier: i, a, b: e, fs: c, fe: c + dur, ds: 0 });
      c += dur + (j < n - 1 ? LEVEE_GAP : DROP_GAP);
    }
  }
  // 時刻を FILL0..FILL1 に収め、抜ける順も満ちた順に揃える
  const k = (FILL1 - FILL0) / (c - DROP_GAP);
  for (const p of paddies) {
    p.fs = FILL0 + p.fs * k;
    p.fe = FILL0 + p.fe * k;
    p.ds = DRAIN0 + ((p.fs - FILL0) / (FILL1 - FILL0)) * (DRAIN1 - DRAIN_EACH - DRAIN0);
  }

  falls = [];
  for (let i = 0; i < TIERS; i++) {
    const first = paddies.find((p) => p.tier === i)!;
    const prevLast = i > 0 ? paddies.filter((p) => p.tier === i - 1).pop()! : null;
    falls.push({
      x: first.a + (forward(i) ? FALL_IN : -FALL_IN),
      on0: first.fs - 0.3,
      on1: FILL1 + 0.4,
      dr0: prevLast ? prevLast.ds : -1,
      dr1: prevLast ? first.ds + DRAIN_EACH * 0.6 : -1,
    });
  }
}

/** 山・段・浜を 1 枚の格子で作る。行は山側から入り江側へ、列は x */
function buildLand(): THREE.BufferGeometry {
  interface Row {
    s: number;
    h: number;
    /** 段をならしたときの高さ */
    hs: number;
    c: THREE.Color;
    /** 段の左右の端と、段の端で行を寄せていく先の s（段でない行は NaN） */
    l: number;
    r: number;
    sc: number;
    /** 稜線のうねりと、左右の山の効き */
    ridge: number;
    side: number;
  }
  const rows: Row[] = [];
  const col = (n: readonly [number, number]): THREE.Color => ember(new THREE.Color(), n[0]).multiplyScalar(n[1]);
  const mud = col(MUD);
  const lip = col(LIP);
  const riser = col(RISER);
  const forest = col(FOREST);

  // 段をならしたときの斜面。段の端はこの高さへ溶けていく
  const top = hFloor[0]!;
  const slope = (top - BOTTOM_H) / (sIn[TIERS - 1]! - sOut[0]!);
  const hs = (s: number): number => top + LIP_H * 0.5 - s * slope;

  for (const [s, dh, ridge] of HILL) {
    rows.push({ s, h: top + dh, hs: top + dh, c: forest, l: NaN, r: NaN, sc: NaN, ridge, side: 1 });
  }
  // 折れ目は同じ位置に色違いの行を 2 本置く。法線も色も折れ目で切れる
  for (let i = 0; i < TIERS; i++) {
    const so = sOut[i]!;
    const si = sIn[i]!;
    const s2 = si + LIP_IN;
    const s3 = s2 + LIP_W;
    const h = hFloor[i]!;
    const sc = (so + s3) / 2;
    const tier = (s: number, y: number, c: THREE.Color): void => {
      rows.push({ s, h: y, hs: hs(s), c, l: xL[i]!, r: xR[i]!, sc, ridge: 0, side: 1 });
    };
    tier(so, h, riser);
    tier(so, h, mud);
    tier(si, h, mud);
    tier(si, h, lip);
    tier(s2, h + LIP_H, lip);
    tier(s3, h + LIP_H, lip);
    tier(s3, h + LIP_H, riser);
  }
  const last = sIn[TIERS - 1]! + LIP_IN + LIP_W;
  for (const [d, h, side] of SHORE) {
    rows.push({ s: last + d, h, hs: h, c: forest, l: NaN, r: NaN, sc: NaN, ridge: 0, side });
  }

  const NR = rows.length;
  const W = COLS + 1;
  const pos = new Float32Array(NR * W * 3);
  const colors = new Float32Array(NR * W * 3);
  const tmp = new THREE.Color();
  for (let row = 0; row < NR; row++) {
    const R = rows[row]!;
    for (let j = 0; j < W; j++) {
      const x = -XMAX + (2 * XMAX * j) / COLS;
      // 段の端を越えると、田面を細らせて段の中ほどの一本の線へ寄せ（法面だけが残る）、
      // その先で斜面へならして森にする。さらに外で左右の山へ持ち上げる
      let s = R.s;
      let flat = 1;
      let hsv = R.hs;
      if (!Number.isNaN(R.l)) {
        // 寄せ方を楕円にして、段の端を刃のように尖らせず丸く閉じる
        const q = clamp01(Math.max(x - R.r, R.l - x) / TAPER);
        const over = q * TAPER;
        s += (R.sc - R.s) * (1 - Math.sqrt(1 - q * q));
        flat = smoothstep(TAPER * 0.5, TAPER + FADE, over);
        hsv = hs(s);
      }
      let h = R.h + (hsv - R.h) * flat;
      h += SIDE_H * R.side * smoothstep(XP + 3, XP + 28, Math.abs(x));
      h += RIDGE_VAR * R.ridge * (0.6 * Math.sin(x * 0.07 + 1) + 0.4 * Math.sin(x * 0.17 + 2));
      const o = (row * W + j) * 3;
      pos[o] = x;
      pos[o + 1] = h;
      pos[o + 2] = zOf(s, x);
      tmp.copy(R.c).lerp(forest, flat);
      colors[o] = tmp.r;
      colors[o + 1] = tmp.g;
      colors[o + 2] = tmp.b;
    }
  }
  const index: number[] = [];
  for (let row = 0; row < NR - 1; row++) {
    for (let j = 0; j < COLS; j++) {
      const a = row * W + j;
      const b = a + 1;
      const c = a + W;
      const d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(index);
  // 陰影を頂点色に焼き込み、法線は捨てる
  geo.computeVertexNormals();
  const nrm = geo.attributes.normal!;
  for (let v = 0; v < NR * W; v++) {
    const d = nrm.getX(v) * SHADE_DIR.x + nrm.getY(v) * SHADE_DIR.y + nrm.getZ(v) * SHADE_DIR.z;
    const k = SHADE_AMB + SHADE_KEY * Math.max(0, d);
    colors[v * 3] *= k;
    colors[v * 3 + 1] *= k;
    colors[v * 3 + 2] *= k;
  }
  geo.deleteAttribute('normal');
  return geo;
}

/** 田を横切る畦。区切りの x に、田面の奥行きいっぱいの低い土手を置く */
function buildLevees(): THREE.InstancedMesh {
  const lit = SHADE_AMB + SHADE_KEY * SHADE_DIR.y;
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: ember(new THREE.Color(), LIP[0]).multiplyScalar(LIP[1] * lit) }),
    levees.length,
  );
  const dummy = new THREE.Object3D();
  levees.forEach(([i, x], k) => {
    const zo = zOf(sOut[i]!, x);
    const zi = zOf(sIn[i]!, x);
    dummy.position.set(x, hFloor[i]!, (zo + zi) / 2);
    dummy.scale.set(LIP_W * 0.7, LIP_H * 2, zi - zo + 0.1);
    dummy.updateMatrix();
    mesh.setMatrixAt(k, dummy.matrix);
  });
  return mesh;
}

/** 水面。田 1 枚ごとに [x 方向 PADDY_COLS+1] x [山側・中ほど・海側] の帯。形は毎フレーム書き直す */
function buildWater(): THREE.BufferGeometry {
  const per = (PADDY_COLS + 1) * 3;
  waterPos = new Float32Array(paddies.length * per * 3);
  waterGlow = new Float32Array(paddies.length * per);
  const index: number[] = [];
  for (let k = 0; k < paddies.length; k++) {
    const base = k * per;
    for (let j = 0; j < PADDY_COLS; j++) {
      for (let row = 0; row < 2; row++) {
        const a = base + j * 3 + row;
        const b = a + 3;
        index.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  const p = new THREE.BufferAttribute(waterPos, 3);
  p.setUsage(THREE.DynamicDrawUsage);
  const g = new THREE.BufferAttribute(waterGlow, 1);
  g.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', p);
  geo.setAttribute('aGlow', g);
  geo.setIndex(index);
  return geo;
}

/** 段を落ちる水の帯。法面に沿って、少し手前へふくらませる。形は固定で、濃さだけ動かす */
function buildFalls(): THREE.BufferGeometry {
  const per = (FALL_SEG + 1) * 2;
  const pos = new Float32Array(falls.length * per * 3);
  fallCol = new Float32Array(falls.length * per * 4);
  const index: number[] = [];
  for (let i = 0; i < TIERS; i++) {
    const x = falls[i]!.x;
    const sTop = i === 0 ? -RISER_W - 0.1 : sIn[i - 1]! + LIP_IN + LIP_W * 0.5;
    const yTop = i === 0 ? hFloor[0]! + STEP_H + 0.02 : hFloor[i - 1]! + LIP_H + 0.02;
    const sBot = sOut[i]! + 0.2;
    const yBot = hFloor[i]! + WATER_LIFT;
    for (let s = 0; s <= FALL_SEG; s++) {
      const u = s / FALL_SEG;
      const bulge = Math.sin(Math.PI * u);
      const y = yTop + (yBot - yTop) * Math.pow(u, 1.3) + 0.06 * bulge;
      for (let side = 0; side < 2; side++) {
        const xx = x + (side - 0.5) * FALL_W * (0.8 + 0.4 * u);
        const o = ((i * (FALL_SEG + 1) + s) * 2 + side) * 3;
        pos[o] = xx;
        pos[o + 1] = y;
        pos[o + 2] = zOf(sTop + (sBot - sTop) * u, xx) + 0.15 * bulge;
      }
    }
    for (let s = 0; s < FALL_SEG; s++) {
      const a = (i * (FALL_SEG + 1) + s) * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const c = new THREE.BufferAttribute(fallCol, 4);
  c.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('color', c);
  geo.setIndex(index);
  return geo;
}

/** 周期の中の、田の水の量のおおまかな割合 0..1（持続音の強さに使う） */
function fullness(tc: number): number {
  if (tc < FILL0) return 0;
  if (tc < FILL1) return (tc - FILL0) / (FILL1 - FILL0);
  if (tc < DRAIN0) return 1;
  if (tc < DRAIN1) return 1 - (tc - DRAIN0) / (DRAIN1 - DRAIN0);
  return 0;
}

export const riceTerraces: SceneModule = {
  name: 'Rice Terraces',
  desc: '夕暮れの棚田。水が段を折り返しながら下りてきて、田が一枚ずつ夕空を映す水鏡に変わっていく。',
  camera: { pos: scaled(CAM), target: scaled(CAM_TARGET) },
  environment: 0,

  build(root) {
    seed = 0.4127;
    planTiers();
    planPaddies();
    fillTicks = tickers(paddies.length);
    dropTicks = tickers(TIERS);
    fullTick = ticker();
    drainTick = ticker();

    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(SKY_R, 48, 24),
      skyShaded('sky', SKY_BODY, { side: THREE.BackSide, fog: false, depthWrite: false }),
    );
    sky.renderOrder = -1;
    root.add(sky);

    const sea = new THREE.Mesh(new THREE.CircleGeometry(SEA_R, 128), skyShaded('sea', SEA_BODY, { fog: false }));
    sea.rotation.x = -Math.PI / 2;
    root.add(sea);

    // 陸と水は設計上の単位で作り、まとめて縮めて置く
    const world = new THREE.Group();
    world.scale.setScalar(SCALE);
    root.add(world);

    world.add(new THREE.Mesh(buildLand(), new THREE.MeshBasicMaterial({ vertexColors: true })));
    world.add(buildLevees());

    waterGeo = buildWater();
    const water = new THREE.Mesh(waterGeo, skyShaded('water', WATER_BODY, { side: THREE.DoubleSide }, true));
    // 形を毎フレーム書き換えるので、囲む球を計算させずに常に描く
    water.frustumCulled = false;
    world.add(water);

    fallGeo = buildFalls();
    const fallMesh = new THREE.Mesh(
      fallGeo,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    fallMesh.renderOrder = 2;
    world.add(fallMesh);
  },

  update(t) {
    const tc = ((t % PERIOD) + PERIOD) % PERIOD;
    const hue = drift(t);
    U.uTime.value = t;
    ember(U.uZen.value, ZEN[0], hue).multiplyScalar(ZEN[1]);
    ember(U.uHor.value, HOR[0], hue).multiplyScalar(HOR[1]);
    ember(U.uGlow.value, GLOW[0], hue).multiplyScalar(GLOW[1]);
    ember(U.uSunC.value, SUN[0], hue * 0.5, 0.1).multiplyScalar(SUN[1]);

    // ---- 田の水 ----
    // 満ちるときは入る側から先端が進み、抜けるときは入った側から乾いていく
    const per = (PADDY_COLS + 1) * 3;
    let o = 0;
    let g = 0;
    for (const p of paddies) {
      const u1 = smooth01((tc - p.fs) / (p.fe - p.fs));
      const u0 = smooth01((tc - p.ds) / DRAIN_EACH);
      if (u1 - u0 < 1e-3) {
        for (let v = 0; v < per; v++) {
          waterPos[o++] = 0;
          waterPos[o++] = -50;
          waterPos[o++] = 0;
          waterGlow[g++] = 0;
        }
        continue;
      }
      // 先端は田の中ほどが先に進み、縁が遅れてついてくる
      const u1e = Math.max(u0, u1 - Math.min(FRONT_LAG, 1 - u1));
      // 先端の照りは、満ちきるにつれて消える
      const shine = 1 - smooth01((u1 - 0.85) / 0.15);
      const len = Math.abs(p.b - p.a) * (u1 - u0);
      const so = sOut[p.tier]!;
      const si = sIn[p.tier]!;
      const y = hFloor[p.tier]! + WATER_LIFT;
      for (let j = 0; j <= PADDY_COLS; j++) {
        const s = j / PADDY_COLS;
        const glow = shine * Math.exp((-(1 - s) * len) / FRONT_LEN);
        for (let row = 0; row < 3; row++) {
          const ue = row === 1 ? u1 : u1e;
          const x = p.a + (p.b - p.a) * (u0 + (ue - u0) * s);
          const z0 = zOf(so, x) + WATER_INSET;
          const z1 = zOf(si, x) - WATER_INSET;
          waterPos[o++] = x;
          waterPos[o++] = y;
          waterPos[o++] = row === 0 ? z0 : row === 2 ? z1 : (z0 + z1) * 0.5;
          waterGlow[g++] = glow;
        }
      }
    }
    waterGeo.attributes.position!.needsUpdate = true;
    waterGeo.attributes.aGlow!.needsUpdate = true;

    // ---- 段を落ちる水 ----
    ember(fallTint, 0.85, hue * 0.5, FALL_GLOW);
    for (let i = 0; i < falls.length; i++) {
      const fl = falls[i]!;
      const vis = Math.max(
        envelope(tc, fl.on0, fl.on1, 0.3, 1.5),
        fl.dr0 < 0 ? 0 : envelope(tc, fl.dr0, fl.dr1, 0.3, 0.8),
      );
      for (let s = 0; s <= FALL_SEG; s++) {
        // 上から下へ流れる明暗。落ち口ほど濃く、下で水面に溶ける
        const u = s / FALL_SEG;
        const a = vis * FALL_ALPHA * (1 - 0.6 * u) * (0.55 + 0.45 * Math.sin(s * 2.1 - t * 11 + i * 1.7));
        for (let side = 0; side < 2; side++) {
          const q = ((i * (FALL_SEG + 1) + s) * 2 + side) * 4;
          fallCol[q] = fallTint.r;
          fallCol[q + 1] = fallTint.g;
          fallCol[q + 2] = fallTint.b;
          fallCol[q + 3] = a;
        }
      }
    }
    fallGeo.attributes.color!.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    const tc = ((t % PERIOD) + PERIOD) % PERIOD;
    const ph = t / PERIOD;
    sfx.drone(tone(-5), 0.025 + 0.03 * fullness(tc));

    // 田が満ちきるたびに小さな水音。下の段ほど低い
    for (let k = 0; k < paddies.length; k++) {
      const p = paddies[k]!;
      for (let n = fillTicks[k]!(ph - p.fe / PERIOD); n > 0; n--) {
        sfx.drop(tone(13 - p.tier + (k % 2) * 2), {
          gain: 0.08,
          decay: 0.5,
          pan: ((p.a + p.b) / (2 * XP)) * 0.6,
        });
      }
    }
    // 水が下の段へ落ちるたびに、一音ずつ下がる弦
    for (let i = 1; i < TIERS; i++) {
      const fl = falls[i]!;
      for (let n = dropTicks[i]!(ph - (fl.on0 + 0.3) / PERIOD); n > 0; n--) {
        sfx.pluck(tone(11 - i), { gain: 0.18, decay: 2.8, pan: (fl.x / XP) * 0.5 });
      }
    }
    // 全部が満ちたとき
    for (let n = fullTick(ph - FILL1 / PERIOD); n > 0; n--) {
      sfx.pluck(tone(12), { gain: 0.2, decay: 3.5, pan: -0.15 });
      sfx.pluck(tone(7), { gain: 0.14, decay: 3.5, pan: 0.15 });
    }
    // 水が抜け始めるとき
    for (let n = drainTick(ph - DRAIN0 / PERIOD); n > 0; n--) {
      sfx.air({ gain: 0.14, decay: 5, freq: 500, q: 0.8 });
    }
  },
};
