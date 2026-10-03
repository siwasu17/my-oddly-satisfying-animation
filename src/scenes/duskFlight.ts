import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { ember, emberColor, drift } from '../palette.ts';

/**
 * Dusk Flight。
 *
 * 何が動くか: 夕暮れの川の谷を、渡り鳥の目の高さで飛びつづける。足もとを畑の継ぎはぎ・森・
 *   村の灯り・夕空を映す川が流れていき、川の曲がりに合わせて体を傾けるたび、地平線が
 *   左右にゆっくり傾ぐ。前には仲間の鳥が 3 羽、翼を広げて滑空し、ときどき数回だけ羽ばたく。
 * 気持ちよさの芯: 曲がりへ入るたびに地平線が傾いて景色が横へ掃かれ、光る川がまた正面へ
 *   戻ってくるところ。傾きは通り道の曲率から決めた「釣り合った旋回」なので、無理なく傾いで
 *   無理なく戻る。
 * ループの周期: 80 秒で谷を一巡する。景色は前後 720 の長さでつながっていて、川の蛇行・
 *   高度のうねり・仲間の羽ばたきの間隔は、どれも 80 秒を割り切る周期で決めてある。
 * カメラ: 鳥の目。水面から 21 の高さで、進む向きを 5° だけ見下ろす（地平線が画面の上から 4 割）。
 *   カメラは動かさずに景色の側を動かす（前から流し、曲がりでは向きと傾きを付ける）。
 *   自動回転やドラッグでカメラの方位が変わると、少し遅れて鳥がそちらへ向き直るので、
 *   いつ見ても前を向いて飛んでいる。
 * 音: 風のうなり（深く傾くほど強い）、傾きが深まりきるたびの風切り、仲間の羽ばたき、
 *   村の灯りの上を通るたびの小さな一音。
 * スコープ外: 地形が落とす影、自分の翼、水しぶき、日の入りの進み（夕暮れのまま止めてある）、操縦。
 *
 * 地形は 4 刻みの格子を面ごとに平らに塗るローポリで、build で一巡ぶんを 1 度だけ作る。
 * 前後は周期的につながっているので、頂点シェーダで「鳥にいちばん近い写し」へずらすだけで
 * 果てしなく続く谷になる（ずらす量はマスごとにそろえて、三角形が裂けないようにしてある）。
 * 水は谷全体に敷いた 1 枚の平面で、地形がえぐれた川筋にだけ顔を出す。空・霞・水面は同じ
 * 「水平線の帯」の色を共有していて、遠くの尾根は帯より一段暗い影絵に、川は帯を映して光る。
 */

// ---------------------------------------------------------------------------
// 調整する数値
// ---------------------------------------------------------------------------

// ---- 飛び方 ----
/** 一巡の秒数。景色・川の曲がり・高度のうねり・仲間の羽ばたきがこの秒数で元に戻る */
const LOOP = 80;
/** 飛ぶ速さ（ワールド単位/秒） */
const SPEED = 9;
/** 景色が前後につながる長さ */
const PERIOD = LOOP * SPEED;
/** 水面から目までの高さ（の平均） */
const ALT = 21;
/** 高度のうねり。[一巡あたりの回数, 振幅, 位相] */
const GLIDE: readonly (readonly [number, number, number])[] = [
  [3, 1.8, 0.6],
  [7, 0.8, 2.4],
];
/** 高度のうねりを機首の上げ下げにどれだけ映すか。大きいと地平線が上下に逃げる */
const PITCH_K = 0.3;
/** 通り道の曲率から傾きを出す係数。大きいほど深く傾く */
const ROLL_K = 26;
/** カメラの方位へ向き直るまでの時定数（秒） */
const TURN_TAU = 1.5;

// ---- 川と谷 ----
/** 川の蛇行。[一巡あたりの回数, 振幅, 位相]。回数が整数なので PERIOD ごとに元へ戻る */
const MEANDER: readonly (readonly [number, number, number])[] = [
  [2, 30, 0.7],
  [3, 16, 2.1],
  [5, 7, 4.0],
  [8, 2.5, 1.1],
];
/** 鳥の通り道は蛇行をなまらせたもの。MEANDER の各成分をどれだけ追うか */
const FOLLOW = [0.72, 0.45, 0.15, 0];
/** 面の細かさ。PERIOD を割り切ること */
const CELL = 4;
/** 地形の横幅の半分 */
const HALF_W = 260;
/** 谷底の高さと、通り道から谷壁までの距離 */
const FLOOR_Y = 1.3;
const FLOOR_HW = 42;
/** 谷壁の丘の高さ・立ち上がりの距離、奥の山並みの高さ */
const HILL_H = 24;
const HILL_RISE = 26;
const MOUNT_H = 34;
/** 川幅の半分（川底の平らなところ）と川底の深さ */
const RIVER_HW = 3;
const RIVER_BED = -2.6;
/** 畑 1 枚の大きさ（横 / 川に沿った向き）。FIELD_L は PERIOD を割り切ること */
const FIELD_W = 13;
const FIELD_L = 20;

// ---- 光と空 ----
/** 太陽の方位（進む向きから左へ, rad）と高さ（rad） */
const SUN_AZ = 0.55;
const SUN_EL = 0.045;
/** 太陽の円盤の半径（rad）と明るさ。明るすぎると白く飛ぶ */
const SUN_R = 0.028;
const SUN_BRIGHT = 1.6;
/**
 * 空・霞・水面の色は、明るさ s（0..1）ひとつから引く。s が高いほど明るい琥珀、低いほど暗い薔薇色。
 * [s = 0 のとき, s = 1 のとき] の ember の n と明るさ。暗い琥珀はくすんだオリーブに見えるので、
 * 色相と明るさを必ず一緒に動かす。
 */
const SKY_N: readonly [number, number] = [0.36, 0.93];
const SKY_K: readonly [number, number] = [0.02, 0.55];
/** 水平線の帯の強さ。太陽の反対側（太陽の側は 1） */
const SKY_AWAY = 0.55;
/** 帯の上にかかる残照の強さ（太陽の反対側 / 太陽の側） */
const SKY_AFTERGLOW: readonly [number, number] = [0.3, 0.45];
/** 水平線の帯の細さ。大きいほど細い */
const SKY_BAND = 16;
/** 空から回り込む光 / 夕日の直射の強さ */
const AMB = 0.45;
const SUN_K = 0.9;
/** 霞。この距離で 6 割ほど溶ける。近景と中景はほとんど霞ませない */
const HAZE_D = 170;
/** 霞の色を水平線の帯よりどれだけ暗くするか。遠くの尾根が帯を背にした影絵として残る */
const HAZE_DIM = 0.72;
/** 遠くの谷底にたまる靄の濃さ */
const MIST = 0.15;
/** 層雲の高さと模様の大きさ（横 / 前後）。CLOUD_SZ は PERIOD を割り切ること */
const CLOUD_Y = 70;
const CLOUD_SX = 260;
const CLOUD_SZ = 120;
/** 真上から覗いたときの水の明るさ s。手前は暗く透けて、奥ほど空を映して明るくなる */
const WATER_DEEP = 0.3;
/** 見下ろす角度（視線の下向き成分）がこの範囲で、空を映す奥の水から透ける手前の水へ移る */
const WATER_FADE: readonly [number, number] = [0.13, 0.4];
/** 岸寄りの水面を暗くする度合い（岸の影と映り込み）。空を映すぶんにだけかける */
const WATER_SHORE = 0.35;
/** さざ波で映り込みを揺らす強さ */
const RIPPLE = 0.14;
/** 水面の横幅の半分（鳥の真下から） */
const WATER_HW = 130;
/** ember() を焼いておく段数 */
const LUT_N = 16;

// ---- 木と家 ----
/** 木を生やす範囲（通り道からの横の距離） */
const TREE_BAND = 120;
/** 遠くで木・家を芽吹かせる距離。木は地平線の近くで粒にならないよう早めに消す */
const TREE_FADE: readonly [number, number] = [95, 125];
const HOUSE_FADE: readonly [number, number] = [150, 180];
/** 森の塊の大きさ（ノイズの目。PERIOD を割り切ること）と、塊が覆う割合のしきい値 */
const WOOD_CELL = 40;
const WOOD_EDGE: readonly [number, number] = [0.42, 0.62];
/** 木の明るさ（地面に対する比）。地面より暗くして、林として沈める */
const TREE_ALB = 0.6;
/** 村。[前後の位置, 川のどちら側か, 軒数] */
const VILLAGES: readonly (readonly [number, number, number])[] = [
  [95, 1, 9],
  [275, -1, 7],
  [455, 1, 10],
  [640, -1, 8],
];
/** 谷底に点々と建つ一軒家の数 */
const FARMS = 12;
/** 窓の灯りの明るさ */
const LIGHT_BRIGHT = 2.4;

// ---- 仲間の鳥 ----
/** [x, y, z（目から見た位置）, 一巡で羽ばたく回数, 羽ばたきの位相, 傾きの遅れ（秒）] */
const BIRDS: readonly (readonly [number, number, number, number, number, number])[] = [
  [-3.2, 0.75, -12, 9, 0.1, 0.45],
  [5.4, 0.45, -15.5, 11, 0.55, 0.7],
  [-10, 1.3, -21.5, 13, 0.3, 0.95],
];
/** 羽ばたきの速さ（回/秒）と、1 度に打つ回数 */
const FLAP_HZ = 2.4;
const FLAP_BEATS = 3;
/** 翼の開き */
const WING_SPAN = 2.6;
/** 滑空中の翼の形。付け根で持ち上げ、肘から先を垂らす（rad）。カモメの「M」字になる */
const WING_UP = 0.28;
const WING_DROOP = -0.4;
/** 羽ばたきの振れ幅（rad） */
const FLAP_AMP = 0.7;
/** 機首上げ（rad）。真後ろから見ても翼の裏が少し見え、線が痩せない */
const BIRD_AOA = 0.14;

// ---- カメラ ----
/** 目の位置。景色はここを鳥の位置として組み立てる */
const CAMERA_POS: [number, number, number] = [0, 21, 10];
/** 見下ろす角度（rad）。浅いほど空が広く、傾いても地平線が画面から逃げない */
const CAMERA_PITCH = 0.087;
/** 20 先を CAMERA_PITCH だけ見下ろす */
const CAMERA_TARGET: [number, number, number] = [
  CAMERA_POS[0],
  CAMERA_POS[1] - 20 * Math.sin(CAMERA_PITCH),
  CAMERA_POS[2] - 20 * Math.cos(CAMERA_PITCH),
];

// ---------------------------------------------------------------------------
// 景色の式
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;
const K = TAU / PERIOD;
/** 前後のマス数 */
const NZ = PERIOD / CELL;

const mod = (a: number, n: number): number => ((a % n) + n) % n;

function smoothstep(a: number, b: number, x: number): number {
  const u = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return u * u * (3 - 2 * u);
}

/** 整数の格子点から 0..1 を引く。固定の式なので、開き直しても同じ景色になる */
function hash(i: number, j: number, seed: number): number {
  let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 前後に PERIOD で繰り返す値ノイズ（0..1）。cell は PERIOD を割り切ること */
function vnoise(x: number, z: number, cell: number, seed: number): number {
  const gx = x / cell;
  const gz = z / cell;
  const i = Math.floor(gx);
  const j = Math.floor(gz);
  const per = PERIOD / cell;
  const j0 = mod(j, per);
  const j1 = mod(j + 1, per);
  let u = gx - i;
  let v = gz - j;
  u = u * u * (3 - 2 * u);
  v = v * v * (3 - 2 * v);
  const a = hash(i, j0, seed);
  const b = hash(i + 1, j0, seed);
  const c = hash(i, j1, seed);
  const d = hash(i + 1, j1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** 鳥の通り道の横位置（order = 0）と、その z についての 1 階・2 階微分 */
function path(z: number, order: 0 | 1 | 2): number {
  let s = 0;
  for (let k = 0; k < MEANDER.length; k++) {
    const [n, a, p] = MEANDER[k];
    const w = n * K;
    const amp = a * FOLLOW[k];
    if (order === 0) s += amp * Math.sin(w * z + p);
    else if (order === 1) s += amp * w * Math.cos(w * z + p);
    else s -= amp * w * w * Math.sin(w * z + p);
  }
  return s;
}

/** 前後の位置 z で決まる値。川の中心・川の傾きから出す横幅の縮み・通り道 */
interface Row {
  rx: number;
  rsf: number;
  px: number;
}

function rowAt(z: number): Row {
  let rx = 0;
  let slope = 0;
  for (const [n, a, p] of MEANDER) {
    rx += a * Math.sin(n * K * z + p);
    slope += a * n * K * Math.cos(n * K * z + p);
  }
  return { rx, rsf: 1 / Math.sqrt(1 + slope * slope), px: path(z, 0) };
}

/** 地形の高さ。水面が y = 0 */
function heightAt(x: number, z: number, row: Row): number {
  // 谷底: わずかにうねる平地
  let h = FLOOR_Y + 0.9 * (vnoise(x, z, 24, 1) - 0.5);
  // 谷壁: 谷底の縁から立ち上がる丘。尾根の高さは値ノイズで揺らす
  const u = Math.max(Math.abs(x - row.px) - FLOOR_HW, 0);
  const ridge = 0.3 * vnoise(x, z, 90, 2) + 0.45 * vnoise(x, z, 45, 3) + 0.25 * vnoise(x, z, 20, 4);
  h += HILL_H * (1 - Math.exp(-u / HILL_RISE)) * (0.3 + 1.2 * ridge);
  // 奥の山並み
  h += MOUNT_H * smoothstep(50, 150, u) * vnoise(x, z, 120, 5);
  // 川筋: 水面より深くえぐる。水はこの溝にだけ顔を出す
  const dr = Math.abs(x - row.rx) * row.rsf;
  return RIVER_BED + (h - RIVER_BED) * smoothstep(RIVER_HW - 1, RIVER_HW + 4.5, dr);
}

/** マス (i, j) の対角線の向き。ばらつかせて格子の規則正しさを消す */
const diagA = (i: number, j: number): boolean => hash(i, mod(j, NZ), 7) < 0.5;

/** 描いた面の上の高さ。木や家を地面にぴったり置くのに使う（滑らかな式とは少しずれる） */
function facetHeight(x: number, z: number): number {
  const gx = x / CELL;
  const gz = z / CELL;
  const i = Math.floor(gx);
  const j = Math.floor(gz);
  const fx = gx - i;
  const fz = gz - j;
  const za = mod(j, NZ) * CELL;
  const zb = mod(j + 1, NZ) * CELL;
  const ra = rowAt(za);
  const rb = rowAt(zb);
  const h00 = heightAt(i * CELL, za, ra);
  const h10 = heightAt((i + 1) * CELL, za, ra);
  const h01 = heightAt(i * CELL, zb, rb);
  const h11 = heightAt((i + 1) * CELL, zb, rb);
  if (diagA(i, j)) {
    return fx >= fz ? h00 + (h10 - h00) * fx + (h11 - h10) * fz : h00 + (h11 - h01) * fx + (h01 - h00) * fz;
  }
  return fx + fz <= 1
    ? h00 + (h10 - h00) * fx + (h01 - h00) * fz
    : h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
}

/** 畑の番号。区画は川に沿って曲がる */
const fieldId = (x: number, z: number, rx: number): number =>
  Math.floor((x - rx) / FIELD_W) * 4096 + mod(Math.floor(z / FIELD_L), PERIOD / FIELD_L);

/** 畑の境目か。生け垣の木を並べるのに使う */
function fieldEdge(x: number, z: number, rx: number): boolean {
  const id = fieldId(x, z, rx);
  const e = 1.6;
  return (
    id !== fieldId(x + e, z, rx) ||
    id !== fieldId(x - e, z, rx) ||
    id !== fieldId(x, z + e, rx) ||
    id !== fieldId(x, z - e, rx)
  );
}

/** 面の地の色（ember の n）。川底・岸の砂・谷底の畑・丘に塗り分ける */
function faceTone(x: number, y: number, z: number, ny: number, row: Row, salt: number): number {
  const dr = Math.abs(x - row.rx) * row.rsf;
  if (y < -0.2) return 0.3;
  if (dr < RIVER_HW + 5.5 && y < FLOOR_Y + 0.3) return 0.62;
  const jit = 0.06 * (salt - 0.5);
  if (Math.abs(x - row.px) < FLOOR_HW + 2 && ny > 0.985) {
    const f = hash(Math.floor((x - row.rx) / FIELD_W), mod(Math.floor(z / FIELD_L), PERIOD / FIELD_L), 21);
    return 0.34 + 0.32 * f + jit * 0.4;
  }
  return 0.32 + jit + 0.08 * smoothstep(0.92, 0.72, ny) + 0.2 * smoothstep(30, 46, y);
}

/** 太陽の向き（景色の座標で） */
const SUN = new THREE.Vector3(
  -Math.sin(SUN_AZ) * Math.cos(SUN_EL),
  Math.sin(SUN_EL),
  -Math.cos(SUN_AZ) * Math.cos(SUN_EL),
);

// ---------------------------------------------------------------------------
// 飛び方の式
// ---------------------------------------------------------------------------

interface Flight {
  x: number;
  y: number;
  /** 前後の位置。0..PERIOD に畳んである */
  z: number;
  yaw: number;
  roll: number;
  pitch: number;
}

/** t 秒目の鳥の位置と姿勢。向きは通り道の接線、傾きは曲率から決める（右旋回で正） */
function flight(t: number, out: Flight): Flight {
  const z = mod(-SPEED * t, PERIOD);
  const d1 = path(z, 1);
  const d2 = path(z, 2);
  let y = ALT;
  let vy = 0;
  for (const [n, a, p] of GLIDE) {
    const w = (TAU * n) / LOOP;
    y += a * Math.sin(w * t + p);
    vy += a * w * Math.cos(w * t + p);
  }
  out.x = path(z, 0);
  out.y = y;
  out.z = z;
  out.yaw = Math.atan(d1);
  out.roll = Math.atan((ROLL_K * d2) / Math.pow(1 + d1 * d1, 1.5));
  out.pitch = PITCH_K * Math.atan2(vy, SPEED * Math.sqrt(1 + d1 * d1));
  return out;
}

function rollAt(t: number): number {
  const z = mod(-SPEED * t, PERIOD);
  const d1 = path(z, 1);
  return Math.atan((ROLL_K * path(z, 2)) / Math.pow(1 + d1 * d1, 1.5));
}

interface Wing {
  /** 付け根の角度と、肘から先の曲げ（rad） */
  angle: number;
  bend: number;
  env: number;
  bob: number;
  /** 打ち下ろしの通算（音用。打ち下ろすたびに整数をまたぐ） */
  beats: number;
}

/** 仲間 i の羽ばたき。一巡で決まった回数だけ、FLAP_BEATS 回ずつ打って滑空に戻る */
function wing(i: number, t: number, out: Wing): Wing {
  const [, , , flaps, phase] = BIRDS[i];
  const every = LOOP / flaps;
  const x = t / every - phase;
  const k = Math.floor(x);
  const u = (x - k) * every;
  const dur = FLAP_BEATS / FLAP_HZ;
  const env = u < dur ? Math.sin((Math.PI * u) / dur) ** 2 : 0;
  const w = TAU * FLAP_HZ * u;
  out.env = env;
  out.angle = WING_UP + FLAP_AMP * env * Math.sin(w);
  // 翼の先は付け根に遅れて振れる。打ち上げでたたみ、打ち下ろしで伸びる
  out.bend = WING_DROOP * (1 - 0.3 * env) + 0.45 * FLAP_AMP * env * Math.sin(w - 0.9);
  out.bob = -0.07 * env * Math.sin(w);
  out.beats = k * FLAP_BEATS + Math.min(FLAP_HZ * u + 0.5, FLAP_BEATS + 0.5);
  return out;
}

// ---------------------------------------------------------------------------
// シェーダ
// ---------------------------------------------------------------------------

/** GLSL に埋め込む浮動小数の表記 */
const f = (x: number): string => (Number.isInteger(x) ? x.toFixed(1) : String(x));

const uniforms = {
  uLut: { value: Array.from({ length: LUT_N }, () => new THREE.Color()) },
  uSun: { value: SUN.clone() },
  uLandRot: { value: new THREE.Matrix3() },
  uBird: { value: new THREE.Vector3() },
  uTime: { value: 0 },
};

function bakeLut(t: number): void {
  const shift = drift(t, 0.05, 0.02);
  uniforms.uLut.value.forEach((c, i) => ember(c, i / (LUT_N - 1), shift));
}

const COMMON = /* glsl */ `
#define LUT_N ${LUT_N}
uniform vec3 uLut[LUT_N];
uniform vec3 uSun;
uniform mat3 uLandRot;
uniform vec3 uBird;
uniform float uTime;
const float PERIOD = ${f(PERIOD)};

/** 0（暗い薔薇）〜 1（明るい琥珀）。色はすべてここから引く */
vec3 lut(float n) {
  float x = clamp(n, 0.0, 1.0) * float(LUT_N - 1);
  int i = int(floor(x));
  int j = min(i + 1, LUT_N - 1);
  return mix(uLut[i], uLut[j], x - float(i));
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
/** y の向きに per マスで繰り返す値ノイズ。景色の前後のつなぎ目で模様が飛ばない */
float vnoiseP(vec2 p, float per) {
  vec2 i = floor(p);
  vec2 u = fract(p);
  u = u * u * (3.0 - 2.0 * u);
  float y0 = mod(i.y, per);
  float y1 = mod(i.y + 1.0, per);
  return mix(
    mix(hash12(vec2(i.x, y0)), hash12(vec2(i.x + 1.0, y0)), u.x),
    mix(hash12(vec2(i.x, y1)), hash12(vec2(i.x + 1.0, y1)), u.x),
    u.y
  );
}
/** 太陽の方位にどれだけ向いているか（0 = 反対側, 1 = 太陽の側） */
float towardSun(vec3 d) {
  vec2 hz = normalize(d.xz + vec2(1e-5));
  return dot(hz, normalize(uSun.xz)) * 0.5 + 0.5;
}
/** 明るさ s（0..1）を色へ。明るいほど琥珀、暗いほど薔薇色で、色相と明るさを一緒に動かす */
vec3 glowCol(float s) {
  s = clamp(s, 0.0, 1.0);
  return lut(mix(${f(SKY_N[0])}, ${f(SKY_N[1])}, s)) * mix(${f(SKY_K[0])}, ${f(SKY_K[1])}, pow(s, 1.6));
}
/** その方位の水平線の帯の強さ。太陽の側で 1 */
float horizonLevel(float toward) {
  return mix(${f(SKY_AWAY)}, 1.0, toward * toward);
}
/** 空の明るさ。水平線に細い帯、その上にほのかな残照、上へ行くほど暗い */
float skyLevel(vec3 d) {
  float y = max(d.y, 0.0);
  float toward = towardSun(d);
  float band = exp(-y * ${f(SKY_BAND)}) * horizonLevel(toward);
  float after = exp(-y * 4.0) * mix(${f(SKY_AFTERGLOW[0])}, ${f(SKY_AFTERGLOW[1])}, toward * toward);
  return max(band, after);
}
vec3 skyGrad(vec3 d) {
  return glowCol(skyLevel(d));
}
/** 太陽のまわりの暈 */
vec3 halo(vec3 d) {
  float mu = max(dot(d, uSun), 0.0);
  return lut(0.95) * (pow(mu, 8.0) * 0.05 + pow(mu, 200.0) * 0.35);
}
/** 遠くのものが溶けていく色。その方位の水平線の帯より一段暗い */
vec3 hazeColor(vec3 d) {
  vec3 h = normalize(vec3(d.x, 0.0, d.z) + vec3(1e-5, 0.0, 0.0));
  return glowCol(horizonLevel(towardSun(h)) * ${f(HAZE_DIM)}) + halo(h) * 0.3;
}
float hazeAmt(float dist) {
  float k = dist / ${f(HAZE_D)};
  return 1.0 - exp(-k * k);
}
/** 地の色 tn の面を、空の回り込み（上向きほど強い）と夕日の直射で照らす */
vec3 shade(float tn, float lam, float ny) {
  return lut(tn) * (${f(AMB)} * (0.55 + 0.45 * ny)) + lut(tn + 0.3) * (${f(SUN_K)} * lam);
}
/**
 * 霞と、遠くの谷底にたまる靄をかける。e はカメラから見たワールドの向き、lp は景色の座標。
 * 地形の横の端も霞に溶かして、縁が見えないようにする。
 */
vec3 fogged(vec3 col, vec3 e, vec3 lp, float k) {
  float dist = length(e);
  vec3 d = uLandRot * (e / dist);
  float mist = ${f(MIST)} * exp(-max(lp.y, 0.0) / 5.0) * smoothstep(60.0, 220.0, dist);
  float edge = smoothstep(${f(HALF_W - 55)}, ${f(HALF_W - 5)}, abs(lp.x));
  float h = max(clamp(hazeAmt(dist) + mist, 0.0, 1.0), edge);
  return mix(col, hazeColor(d), k * h);
}
/** 前後にずらした写しのうち、鳥にいちばん近いものへ寄せる量 */
float unwrapZ(float z) {
  return PERIOD * floor((uBird.z - z) / PERIOD + 0.5);
}
`;

const OUT = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

const SKY_VERT = /* glsl */ `
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
  gl_Position.z = gl_Position.w * 0.99999; // いつも一番奥に描く
}
`;

const SKY_FRAG = /* glsl */ `
${COMMON}
varying vec3 vW;
/** 横に長い層雲。鳥の真上の高さの面に貼ってあるので、飛ぶと頭上を後ろへ流れていく */
float cloud(vec2 q) {
  vec2 p = q / vec2(${f(CLOUD_SX)}, ${f(CLOUD_SZ)});
  float n = 0.62 * vnoiseP(p, ${f(PERIOD / CLOUD_SZ)})
          + 0.38 * vnoiseP(p * 2.0 + vec2(5.3, 0.0), ${f((2 * PERIOD) / CLOUD_SZ)});
  return smoothstep(0.52, 0.8, n);
}
void main() {
  vec3 d = uLandRot * normalize(vW - cameraPosition);
  // 水平線より下は、遠くの地形が溶けていくのと同じ色にしてつなぐ
  if (d.y < 0.0) {
    gl_FragColor = vec4(hazeColor(d), 1.0);
    ${OUT}
    return;
  }
  vec3 c = skyGrad(d) + halo(d);
  float mu = dot(d, uSun);
  float ang = acos(clamp(mu, -1.0, 1.0));
  c = mix(c, lut(1.0) * ${f(SUN_BRIGHT)}, 1.0 - smoothstep(${f(SUN_R * 0.75)}, ${f(SUN_R)}, ang));
  if (d.y > 0.003) {
    vec2 q = uBird.xz + d.xz * ((${f(CLOUD_Y)} - uBird.y) / d.y);
    float cov = cloud(q) * smoothstep(0.003, 0.06, d.y);
    float toward = towardSun(d);
    // 雲の底は太陽の側だけ下から照らされる
    vec3 cc = glowCol(mix(0.12, 0.7, pow(toward, 3.0)));
    cc += lut(0.95) * pow(max(mu, 0.0), 20.0) * 0.25;
    c = mix(c, cc, cov * 0.7);
  }
  gl_FragColor = vec4(c, 1.0);
  ${OUT}
}
`;

const TERRAIN_VERT = /* glsl */ `
${COMMON}
attribute float aRef;
attribute float aTone;
attribute vec2 aLight;
varying vec3 vCol;
varying vec3 vW;
varying vec3 vLp;
void main() {
  vec3 p = position;
  p.z += unwrapZ(aRef);
  vCol = shade(aTone, aLight.x, aLight.y);
  vLp = p;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** 木・家・窓の灯り。インスタンスごとに鳥に近い写しへ寄せ、遠くでは 0 から芽吹かせる */
const PROP_VERT = /* glsl */ `
${COMMON}
uniform float uGlow;
uniform float uAlb;
uniform float uSoft;
uniform vec2 uFade;
attribute float aTone;
attribute float aOfs;
varying vec3 vCol;
varying vec3 vW;
varying vec3 vLp;
void main() {
  vec3 base = instanceMatrix[3].xyz;
  float dz = unwrapZ(base.z);
  float r = length(vec2(base.x - uBird.x, base.z + dz - uBird.z));
  float grow = 1.0 - smoothstep(uFade.x, uFade.y, r);
  vec4 p = instanceMatrix * vec4(position * grow, 1.0);
  p.z += dz;
  float tn = aTone + aOfs;
  if (uGlow > 0.0) {
    vCol = lut(tn) * uGlow;
  } else {
    // 伸び縮みさせた形でも法線が寝ないよう、拡大率の逆で戻してから回す
    mat3 m = mat3(instanceMatrix);
    vec3 s = vec3(dot(m[0], m[0]), dot(m[1], m[1]), dot(m[2], m[2]));
    vec3 n = m * (normal / s);
    n *= inversesqrt(max(dot(n, n), 1e-8));
    // uSoft で陰影をやわらげる（光の回り込みを広げ、上下の差を詰める）
    float l = dot(n, uSun);
    float lam = mix(max(l, 0.0), max((l + 0.6) / 1.6, 0.0), uSoft);
    float ny = mix(n.y, 0.6 + 0.4 * n.y, uSoft);
    vCol = shade(tn, lam, ny) * uAlb;
  }
  vLp = p.xyz;
  vec4 w = modelMatrix * p;
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const LIT_FRAG = /* glsl */ `
${COMMON}
uniform float uHazeK;
varying vec3 vCol;
varying vec3 vW;
varying vec3 vLp;
void main() {
  gl_FragColor = vec4(fogged(vCol, vW - cameraPosition, vLp, uHazeK), 1.0);
  ${OUT}
}
`;

const WATER_VERT = /* glsl */ `
${COMMON}
varying vec3 vW;
varying vec3 vLp;
void main() {
  vLp = position + vec3(uBird.x, 0.0, uBird.z);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** JS の rowAt と同じ川の中心と傾きの式。岸からの距離を出すのに使う */
const RIVER_GLSL = /* glsl */ `
float riverX(float z) {
  return ${MEANDER.map(([n, a, p]) => `${f(a)} * sin(${f(n * K)} * z + ${f(p)})`).join(' + ')};
}
float riverSlope(float z) {
  return ${MEANDER.map(([n, a, p]) => `${f(a * n * K)} * cos(${f(n * K)} * z + ${f(p)})`).join(' + ')};
}
`;

const WATER_FRAG = /* glsl */ `
${COMMON}
${RIVER_GLSL}
varying vec3 vW;
varying vec3 vLp;
void main() {
  vec3 e = vW - cameraPosition;
  vec3 d = uLandRot * normalize(e);
  float dist = length(e);
  // さざ波。前後の模様は PERIOD でつながる
  vec2 rp = vec2(vLp.x * 0.3, vLp.z / 8.0 + uTime * 0.35);
  vec2 wob = vec2(
    vnoiseP(rp, PERIOD / 8.0),
    vnoiseP(rp * 2.0 + vec2(3.7, 0.0), PERIOD / 4.0)
  ) - 0.5;
  wob *= ${f(RIPPLE)} * (1.0 - smoothstep(40.0, 170.0, dist));
  vec3 n = normalize(vec3(wob.x, 1.0, wob.y));
  vec3 r = reflect(d, n);
  float ry = max(r.y, 0.0);
  float mu = max(dot(r, uSun), 0.0);
  // 水は浅い角度ほど空を映す。手前（真上から覗く側）は暗く透け、奥へ行くほど水平線の帯を映して明るくなる
  float sky = horizonLevel(towardSun(r)) * mix(0.9, 1.05, exp(-ry * 3.0));
  // 岸寄りは岸の影と映り込みで暗い。奥では真ん中だけが空を映して光る筋になる
  float rs = riverSlope(vLp.z);
  float dr = abs(vLp.x - riverX(vLp.z)) / sqrt(1.0 + rs * rs);
  sky *= 1.0 - ${f(WATER_SHORE)} * smoothstep(${f(RIVER_HW - 0.5)}, ${f(RIVER_HW + 2.5)}, dr);
  float fres = 1.0 - smoothstep(${f(WATER_FADE[0])}, ${f(WATER_FADE[1])}, -d.y);
  float lev = mix(${f(WATER_DEEP)}, sky, fres);
  float glint = vnoiseP(rp * 3.0 + vec2(1.3, 0.0), PERIOD * 3.0 / 8.0) - 0.5;
  vec3 c = glowCol(lev) * (1.0 + 0.4 * glint * (1.0 - smoothstep(30.0, 150.0, dist)));
  c += halo(normalize(vec3(r.x, ry, r.z))) * 0.8 * fres;
  // 太陽の方角には、川に沿って照り返しの筋が伸びる
  c += lut(0.97) * (pow(mu, 60.0) * 0.35 + pow(mu, 500.0));
  gl_FragColor = vec4(fogged(c, e, vLp, 1.0), 1.0);
  ${OUT}
}
`;

interface LitOpt {
  hazeK?: number;
  glow?: number;
  alb?: number;
  soft?: number;
  fade?: readonly [number, number];
}

function litMaterial(vert: string, o: LitOpt = {}): THREE.ShaderMaterial {
  const fade = o.fade ?? HOUSE_FADE;
  return new THREE.ShaderMaterial({
    uniforms: {
      ...uniforms,
      uHazeK: { value: o.hazeK ?? 1 },
      uGlow: { value: o.glow ?? 0 },
      uAlb: { value: o.alb ?? 1 },
      uSoft: { value: o.soft ?? 0 },
      uFade: { value: new THREE.Vector2(fade[0], fade[1]) },
    },
    vertexShader: vert,
    fragmentShader: LIT_FRAG,
  });
}

// ---------------------------------------------------------------------------
// 組み立て
// ---------------------------------------------------------------------------

/** 一巡ぶんの地形。面ごとに平らに塗る（頂点を面で共有しない） */
function buildTerrain(): THREE.Mesh {
  const nx = (2 * HALF_W) / CELL;
  const i0 = -HALF_W / CELL;
  const w = nx + 1;
  const H = new Float32Array(w * (NZ + 1));
  for (let j = 0; j <= NZ; j++) {
    const z = (j % NZ) * CELL;
    const row = rowAt(z);
    for (let i = 0; i <= nx; i++) H[j * w + i] = heightAt((i0 + i) * CELL, z, row);
  }

  const verts = nx * NZ * 6;
  const pos = new Float32Array(verts * 3);
  const ref = new Float32Array(verts);
  const tn = new Float32Array(verts);
  const light = new Float32Array(verts * 2);
  let v = 0;
  let row = rowAt(0);
  let zc = 0;
  let salt = 0;

  const tri = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): void => {
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    let nx_ = uy * vz - uz * vy;
    let ny_ = uz * vx - ux * vz;
    let nz_ = ux * vy - uy * vx;
    const len = Math.hypot(nx_, ny_, nz_) || 1;
    nx_ /= len;
    ny_ /= len;
    nz_ /= len;
    const lam = Math.max(0, nx_ * SUN.x + ny_ * SUN.y + nz_ * SUN.z);
    const t = faceTone((ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3, ny_, row, salt);
    const p = [ax, ay, az, bx, by, bz, cx, cy, cz];
    for (let k = 0; k < 3; k++) {
      pos[v * 3] = p[k * 3];
      pos[v * 3 + 1] = p[k * 3 + 1];
      pos[v * 3 + 2] = p[k * 3 + 2];
      ref[v] = zc;
      tn[v] = t;
      light[v * 2] = lam;
      light[v * 2 + 1] = ny_;
      v++;
    }
  };

  for (let j = 0; j < NZ; j++) {
    zc = (j + 0.5) * CELL;
    row = rowAt(zc);
    const za = j * CELL;
    const zb = za + CELL;
    for (let i = 0; i < nx; i++) {
      const xa = (i0 + i) * CELL;
      const xb = xa + CELL;
      const h00 = H[j * w + i];
      const h10 = H[j * w + i + 1];
      const h01 = H[(j + 1) * w + i];
      const h11 = H[(j + 1) * w + i + 1];
      salt = hash(i0 + i, j, 9);
      if (diagA(i0 + i, j)) {
        tri(xa, h00, za, xb, h11, zb, xb, h10, za);
        tri(xa, h00, za, xa, h01, zb, xb, h11, zb);
      } else {
        tri(xa, h00, za, xa, h01, zb, xb, h10, za);
        tri(xb, h10, za, xa, h01, zb, xb, h11, zb);
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aRef', new THREE.BufferAttribute(ref, 1));
  g.setAttribute('aTone', new THREE.BufferAttribute(tn, 1));
  g.setAttribute('aLight', new THREE.BufferAttribute(light, 2));
  const mesh = new THREE.Mesh(g, litMaterial(TERRAIN_VERT));
  mesh.frustumCulled = false; // 描くときに前後へずらすので、置いた場所の外接球は当てにならない
  return mesh;
}

/** インスタンスの並びから InstancedMesh を作る。items は [x, y, z, 向き, 横の拡大, 縦の拡大, 地の色] の繰り返し */
function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, items: number[]): THREE.InstancedMesh {
  const count = items.length / 7;
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const tones = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    const o = k * 7;
    p.set(items[o], items[o + 1], items[o + 2]);
    q.setFromAxisAngle(up, items[o + 3]);
    s.set(items[o + 4], items[o + 5], items[o + 4]);
    mesh.setMatrixAt(k, m.compose(p, q, s));
    tones[k] = items[o + 6];
  }
  geo.setAttribute('aTone', new THREE.InstancedBufferAttribute(tones, 1));
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * 形を継ぎ合わせて 1 つにする。parts は [形, 地の色のずらし] の組（幹は暗く、壁は明るく、など）。
 * 頂点を面で共有させず、面ごとに平らな法線にする。
 */
function mergeParts(parts: [THREE.BufferGeometry, number][]): THREE.BufferGeometry {
  const flat = parts.map(([g, o]): [THREE.BufferGeometry, number] => [g.index ? g.toNonIndexed() : g, o]);
  const n = flat.reduce((sum, [g]) => sum + g.attributes.position.count, 0);
  const pos = new Float32Array(n * 3);
  const ofs = new Float32Array(n);
  let k = 0;
  for (const [g, o] of flat) {
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array, k * 3);
    ofs.fill(o, k, k + c);
    k += c;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aOfs', new THREE.BufferAttribute(ofs, 1));
  geo.computeVertexNormals();
  return geo;
}

/**
 * 谷壁の森、川沿いの並木、畑の境の生け垣。細い幹に丸い樹冠を載せ、地面より暗く、陰影をやわらげて置く。
 * 森はノイズで塊にまとめ、塊のあいだは何も無い斜面として残す。
 */
function buildTrees(): THREE.InstancedMesh {
  const crown = new THREE.IcosahedronGeometry(1, 0);
  crown.scale(1, 1.15, 1);
  crown.translate(0, 1.9, 0);
  const trunk = new THREE.CylinderGeometry(0.1, 0.15, 1.2, 4, 1, true);
  trunk.translate(0, 0.6, 0);
  const items: number[] = [];
  for (let j = 0; j < NZ; j++) {
    const row = rowAt((j + 0.5) * CELL);
    const lo = Math.floor((row.px - TREE_BAND) / CELL);
    const hi = Math.ceil((row.px + TREE_BAND) / CELL);
    for (let i = lo; i < hi; i++) {
      const x = (i + 0.15 + 0.7 * hash(i, j, 32)) * CELL;
      const z = (j + 0.15 + 0.7 * hash(i, j, 33)) * CELL;
      const dr = Math.abs(x - row.rx) * row.rsf;
      if (dr < RIVER_HW + 6) continue;
      const dv = Math.abs(x - row.px);
      let p: number;
      let t: number;
      if (dv > FLOOR_HW + 4) {
        p = 0.6 * smoothstep(WOOD_EDGE[0], WOOD_EDGE[1], vnoise(x, z, WOOD_CELL, 8));
        t = 0.36;
      } else if (dr < RIVER_HW + 11) {
        p = 0.25;
        t = 0.4;
      } else if (fieldEdge(x, z, row.rx)) {
        p = 0.18;
        t = 0.38;
      } else {
        p = 0.006;
        t = 0.38;
      }
      if (hash(i, j, 31) > p) continue;
      const y = facetHeight(x, z);
      if (y > 44) continue;
      const s = 0.8 + 0.5 * hash(i, j, 34);
      items.push(x, y - 0.15, z, hash(i, j, 35) * TAU, 1.2 * s, 1.3 * s, t + 0.06 * (hash(i, j, 36) - 0.5));
    }
  }
  return instanced(
    mergeParts([
      [crown, 0],
      [trunk, -0.12],
    ]),
    litMaterial(PROP_VERT, { alb: TREE_ALB, soft: 1, fade: TREE_FADE }),
    items,
  );
}

interface House {
  x: number;
  y: number;
  z: number;
  rot: number;
  lit: boolean;
  /** 同じ村の中で、鳥が上を通る順番 */
  rank: number;
}

/** 村と一軒家の位置。川から離し、谷底の平らなところにだけ建てる */
function placeHouses(): House[] {
  const out: House[] = [];
  const ok = (x: number, z: number): boolean => {
    const rw = rowAt(z);
    if (Math.abs(x - rw.rx) * rw.rsf < RIVER_HW + 8) return false;
    if (Math.abs(x - rw.px) > FLOOR_HW - 3) return false;
    return out.every((h) => (h.x - x) ** 2 + (h.z - z) ** 2 > 10);
  };
  const add = (x: number, z: number, seed: number): void => {
    const rw = rowAt(z);
    const along = -Math.atan((rowAt(z + 0.5).rx - rowAt(z - 0.5).rx) * rw.rsf * rw.rsf);
    out.push({
      x,
      y: facetHeight(x, z) - 0.15,
      z,
      rot: along + (hash(seed, 1, 43) < 0.5 ? 0 : Math.PI / 2) + 0.3 * (hash(seed, 2, 43) - 0.5),
      lit: hash(seed, 3, 43) < 0.78,
      rank: 0,
    });
  };
  VILLAGES.forEach(([zc, side, n], v) => {
    const cx = rowAt(zc).rx + side * (RIVER_HW + 19);
    const start = out.length;
    for (let k = 0; k < n * 3 && out.length - start < n; k++) {
      const a = TAU * hash(v, k, 41);
      const r = 3 + 12 * Math.sqrt(hash(v, k, 42));
      const x = cx + r * Math.cos(a);
      const z = zc + 1.5 * r * Math.sin(a);
      if (ok(x, z)) add(x, z, v * 100 + k);
    }
    // 鳥は z の大きいほうから小さいほうへ飛ぶので、z の大きい家から順に番号を振る
    out
      .slice(start)
      .sort((p, q) => q.z - p.z)
      .forEach((h, k) => {
        h.rank = k;
      });
  });
  for (let k = 0; k < FARMS; k++) {
    const z = (k + 0.3 + 0.4 * hash(k, 0, 44)) * (PERIOD / FARMS);
    const side = hash(k, 1, 44) < 0.5 ? -1 : 1;
    const x = rowAt(z).rx + side * (RIVER_HW + 12 + 20 * hash(k, 2, 44));
    if (ok(x, z)) add(x, z, 1000 + k);
  }
  return out;
}

/** 箱の母屋に寄棟の屋根。壁は明るく、屋根は暗く塗る */
function buildHouses(houses: House[]): THREE.InstancedMesh {
  const body = new THREE.BoxGeometry(2, 1.3, 1.5).toNonIndexed();
  body.translate(0, 0.65, 0);
  const roof = new THREE.ConeGeometry(1, 1, 4, 1, true).toNonIndexed();
  roof.rotateY(Math.PI / 4);
  roof.scale(1.62, 0.85, 1.25);
  roof.translate(0, 1.3 + 0.425, 0);
  const items: number[] = [];
  houses.forEach((h, k) => items.push(h.x, h.y, h.z, h.rot, 1, 1, 0.5 + 0.12 * hash(k, 0, 45)));
  return instanced(
    mergeParts([
      [body, 0.12],
      [roof, -0.22],
    ]),
    litMaterial(PROP_VERT),
    items,
  );
}

/** 窓の灯り。家の長い壁に 1〜2 個。霞に沈みきらないよう、霞は弱めにかける */
function buildLights(houses: House[]): THREE.InstancedMesh {
  const box = new THREE.BoxGeometry(0.34, 0.3, 0.08);
  const items: number[] = [];
  const local = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  houses.forEach((h, k) => {
    if (!h.lit) return;
    const spots: [number, number][] = [[hash(k, 1, 46) < 0.5 ? -0.45 : 0.45, 0.77]];
    if (hash(k, 2, 46) < 0.45) spots.push([0.3, -0.77]);
    for (const [lx, lz] of spots) {
      local.set(lx, 0, lz).applyAxisAngle(up, h.rot);
      items.push(h.x + local.x, h.y + 0.62, h.z + local.z, h.rot, 1, 1, 0.93 + 0.07 * hash(k, 3, 46));
    }
  });
  return instanced(mergeParts([[box, 0]]), litMaterial(PROP_VERT, { hazeK: 0.7, glow: LIGHT_BRIGHT }), items);
}

/** 谷に敷く水面。鳥の真下に付いてまわり、地形のえぐれた川筋にだけ見える */
function buildWater(): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  const wx = WATER_HW;
  const wz = PERIOD / 2;
  g.setAttribute('position', new THREE.Float32BufferAttribute([-wx, 0, -wz, wx, 0, -wz, wx, 0, wz, -wx, 0, wz], 3));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  const mesh = new THREE.Mesh(
    g,
    new THREE.ShaderMaterial({ uniforms, vertexShader: WATER_VERT, fragmentShader: WATER_FRAG }),
  );
  mesh.renderOrder = 1; // 地形の後に描けば、隠れたところは深度で早々に捨てられる
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * 翼の 1 区間。付け根（x = 0）から先へ細くなる薄い角柱で、side = -1 で左右を裏返す。
 * 真後ろから見ても線が痩せないよう、前縁に厚みを持たせる。
 */
function wingPart(side: number, len: number, c0: number, c1: number, t0: number, t1: number, sweep: number): THREE.BufferGeometry {
  const v = [
    [0, t0, -c0 / 2],
    [0, t0 * 0.3, c0 / 2],
    [0, -t0 * 0.5, -c0 / 2],
    [0, -t0 * 0.2, c0 / 2],
    [len, t1, sweep - c1 / 2],
    [len, t1 * 0.3, sweep + c1 / 2],
    [len, -t1 * 0.5, sweep - c1 / 2],
    [len, -t1 * 0.2, sweep + c1 / 2],
  ];
  const quads = [
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
    [0, 2, 3, 1],
    [4, 5, 7, 6],
  ];
  const pos: number[] = [];
  for (const [a, b, c, d] of quads) {
    for (const k of [a, b, c, a, c, d]) pos.push(v[k][0] * side, v[k][1], v[k][2]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

interface Bird {
  g: THREE.Group;
  /** [右, 左] の付け根と肘 */
  shoulders: THREE.Group[];
  elbows: THREE.Group[];
}

/** 前を飛ぶ仲間。夕空に抜ける影絵なので、照らさずに暗い色で塗る */
function buildBird(mat: THREE.Material): Bird {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.OctahedronGeometry(1, 0), mat);
  body.scale.set(0.16, 0.14, 0.52);
  const head = new THREE.Mesh(new THREE.OctahedronGeometry(1, 0), mat);
  head.scale.set(0.1, 0.09, 0.16);
  head.position.set(0, 0.05, -0.52);
  const tail = new THREE.Mesh(wingPart(1, 0.36, 0.1, 0.34, 0.03, 0.02, 0), mat);
  tail.rotation.y = -Math.PI / 2; // 付け根から後ろへ伸ばし、先で扇に広げる
  tail.position.set(0, 0, 0.36);
  g.add(body, head, tail);
  const half = WING_SPAN / 2;
  const shoulders: THREE.Group[] = [];
  const elbows: THREE.Group[] = [];
  for (const side of [1, -1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(0.1 * side, 0.05, -0.08);
    shoulder.add(new THREE.Mesh(wingPart(side, 0.5 * half, 0.5, 0.42, 0.06, 0.05, 0.02), mat));
    const elbow = new THREE.Group();
    elbow.position.set(0.48 * half * side, 0, 0.02);
    elbow.add(new THREE.Mesh(wingPart(side, 0.58 * half, 0.42, 0.1, 0.05, 0.02, 0.3), mat));
    shoulder.add(elbow);
    g.add(shoulder);
    shoulders.push(shoulder);
    elbows.push(elbow);
  }
  return { g, shoulders, elbows };
}

// ---------------------------------------------------------------------------
// シーン
// ---------------------------------------------------------------------------

/** カメラの注視点のまわりを回す。自動回転やドラッグの方位に、景色ごと遅れて付いていく */
let follow: THREE.Group;
/** 目の位置で、旋回の傾きと機首の上げ下げを付ける */
let bank: THREE.Group;
/** 進む向きを付ける */
let heading: THREE.Group;
/** 景色の座標。鳥の位置を目へ持ってくる */
let land: THREE.Group;
let water: THREE.Mesh;
let birds: Bird[] = [];

/** 最後に描いたカメラ。空の onBeforeRender で受け取る */
let seenCam: THREE.Camera | null = null;
let turnAz = 0;

const F: Flight = { x: 0, y: 0, z: 0, yaw: 0, roll: 0, pitch: 0 };
const W: Wing = { angle: 0, bend: 0, env: 0, bob: 0, beats: 0 };
const SW: Wing = { angle: 0, bend: 0, env: 0, bob: 0, beats: 0 };

// 音
let flapTicks = tickers(BIRDS.length);
let passTicks: ((phase: number) => number)[] = [];
/** 灯りのともる家。[前後の位置, 音程, 定位] */
let passes: [number, number, number][] = [];
let lastRate = 0;

export const duskFlight: SceneModule = {
  name: 'Dusk Flight',
  desc: '夕暮れの川の谷を鳥の目で渡っていく。曲がりに合わせて体を傾けるたび、地平線がゆっくり傾いで戻る。',
  camera: { pos: CAMERA_POS, target: CAMERA_TARGET },
  environment: 0,

  build(root) {
    seenCam = null;
    turnAz = 0;
    lastRate = 0;
    bakeLut(0);

    follow = new THREE.Group();
    follow.position.set(...CAMERA_TARGET);
    root.add(follow);
    const eye = new THREE.Group();
    eye.position.set(
      CAMERA_POS[0] - CAMERA_TARGET[0],
      CAMERA_POS[1] - CAMERA_TARGET[1],
      CAMERA_POS[2] - CAMERA_TARGET[2],
    );
    follow.add(eye);
    bank = new THREE.Group();
    bank.rotation.order = 'ZXY'; // 傾き（z）をいちばん外側にかける
    eye.add(bank);
    heading = new THREE.Group();
    bank.add(heading);
    land = new THREE.Group();
    heading.add(land);

    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(400, 32, 16),
      new THREE.ShaderMaterial({
        uniforms,
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    );
    sky.renderOrder = -1;
    sky.frustumCulled = false;
    sky.onBeforeRender = (_r, _s, camera) => {
      seenCam = camera;
    };
    heading.add(sky);

    land.add(buildTerrain());
    land.add(buildTrees());
    const houses = placeHouses();
    land.add(buildHouses(houses));
    land.add(buildLights(houses));
    water = buildWater();
    land.add(water);

    const birdMat = new THREE.MeshBasicMaterial({
      color: emberColor(0.4).multiplyScalar(0.18),
      side: THREE.DoubleSide,
      fog: false,
    });
    birds = BIRDS.map(() => buildBird(birdMat));
    for (const b of birds) eye.add(b.g);

    // 灯りの上を通るたびの一音。村の中では通る順に音程を上げていく
    passes = houses
      .filter((h) => h.lit)
      .map((h) => [h.z, 8 + (h.rank % 5), Math.max(-0.8, Math.min(0.8, (h.x - path(h.z, 0)) / 35))]);
    passTicks = tickers(passes.length);
    flapTicks = tickers(BIRDS.length);
  },

  update(t, dt) {
    bakeLut(t);
    flight(t, F);

    // カメラの方位へ遅れて向き直る。景色ごと注視点のまわりに回すので、いつも前を向いて見える
    if (seenCam) {
      const c = seenCam.position;
      const az = Math.atan2(c.x - CAMERA_TARGET[0], c.z - CAMERA_TARGET[2]);
      const gap = mod(az - turnAz + Math.PI, TAU) - Math.PI;
      turnAz = mod(turnAz + gap * (1 - Math.exp(-dt / TURN_TAU)) + Math.PI, TAU) - Math.PI;
    }
    follow.rotation.y = turnAz;
    bank.rotation.set(-F.pitch, 0, F.roll);
    heading.rotation.y = -F.yaw;
    land.position.set(-F.x, -F.y, -F.z);
    water.position.set(F.x, 0, F.z);

    land.updateWorldMatrix(true, false);
    uniforms.uLandRot.value.setFromMatrix4(land.matrixWorld).transpose();
    uniforms.uBird.value.set(F.x, F.y, F.z);
    uniforms.uTime.value = t;

    // 仲間は一緒に旋回するので、こちらの傾きに少し遅れて付いてくるぶんだけ傾いて見える
    const a = (TAU * t) / LOOP;
    BIRDS.forEach(([bx, by, bz, , ph, lag], i) => {
      const b = birds[i];
      wing(i, t, W);
      b.g.position.set(
        bx + 0.5 * Math.sin(a * 5 + ph * 7),
        by + 0.3 * Math.sin(a * 7 + ph * 11) + 0.18 * W.env + W.bob,
        bz + 0.8 * Math.sin(a * 3 + ph * 5),
      );
      b.g.rotation.set(
        BIRD_AOA + 0.07 * W.env,
        0,
        F.roll - rollAt(t - lag) + 0.05 * Math.sin(a * 11 + ph * 3),
      );
      for (let s = 0; s < 2; s++) {
        const side = s === 0 ? 1 : -1;
        b.shoulders[s].rotation.z = side * W.angle;
        b.elbows[s].rotation.z = side * W.bend;
      }
    });
  },

  sound(t, _dt, sfx) {
    const roll = rollAt(t);
    const deep = Math.min(Math.abs(roll) / 0.32, 1);
    sfx.drone(tone(-5), 0.03 + 0.035 * deep);

    // 傾きが深まりきった瞬間（傾きの増減が入れ替わるとき）に、下がった翼の側で風切り
    const rate = roll - rollAt(t - 0.1);
    if (rate * lastRate < 0 && Math.abs(roll) > 0.1) {
      sfx.air({ gain: 0.08 + 0.2 * deep, decay: 3.2, freq: 340, q: 0.7, sweep: 0.6, pan: Math.sign(roll) * 0.4 });
    }
    lastRate = rate;

    // 仲間の羽ばたき。打ち下ろすたびに小さく
    BIRDS.forEach(([bx], i) => {
      wing(i, t, SW);
      for (let k = flapTicks[i](SW.beats); k > 0; k--) {
        sfx.air({
          gain: 0.035 + 0.05 * SW.env,
          decay: 0.26,
          freq: 1050 + 140 * i,
          q: 1.1,
          sweep: 0.6,
          pan: Math.max(-0.8, Math.min(0.8, bx / 10)),
        });
      }
    });

    // 灯りのともる家の上を通るたびに一音
    const s = SPEED * t;
    passes.forEach(([z, note, pan], j) => {
      for (let k = passTicks[j]((s + z) / PERIOD); k > 0; k--) {
        sfx.pluck(tone(note), { gain: 0.08, decay: 2.8, pan });
      }
    });
  },
};
