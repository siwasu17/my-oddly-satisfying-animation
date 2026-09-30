import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { ticker } from '../audio.ts';
import { ember, emberColor, drift } from '../palette.ts';

/**
 * 日没の砂浜。
 *
 * 何が動くか: 沖から 8 秒ごとにうねりが寄せ、浅瀬で前のめりに切り立って端から順に崩れ、
 *   白波の段になって岸へ走る。波打ち際で薄い水の膜になって砂を駆け上がり、止まって引いていく。
 * 気持ちよさの芯: 引いたあとの濡れた砂が、沈みかけた太陽と空を鏡のように映し、
 *   数秒かけて乾いて艶が消えていくところ。泡の網目が砂の上に取り残され、ほどけていく。
 * ループの周期: 波 1 本 8 秒。大きさ・崩れ始める位置・駆け上がりの形は波ごとに違い、
 *   6 本で大小の「セット」が一巡する。すべて t から決まるので、開き直しても同じ波が来る。
 * カメラ: 波打ち際から少し下がって腰を下ろした目の高さから、沖の水平線を望む。
 * 音: 崩れる瞬間の低い砕け音、駆け上がる水のざわめき、引き波の泡がはじける細かい音。
 * 浜の小道具: 右手の波打ち際に流木と岩（左端にも小岩を 1 つ）、満潮線に沿って貝殻、背後の砂丘に風にそよぐ草、
 *   右手の水平線に遠い岬の影、風に乗って沖の空に留まるカモメ 2 羽。太陽の光の道が降りてくる
 *   中央と左は空けておく。
 * スコープ外: 巻き波の筒（チューブ）、しぶきの粒、足跡、潮の満ち引き。
 *
 * 形は CPU で作らず、「ある点の水面の高さ」と「ある点の砂の高さ」を返す式を
 * 海・砂・空の 3 つのシェーダで共有している。海は浅いところで砂の式から水深を出して
 * 砂を透かし、砂は同じ波の番号から遡上の縁を割り出すので、両者の境目は決してずれない。
 * 空・海・濡れた砂は同じ空の式を映し合い、色はすべて ember() を焼いた表から引く。
 */

// ---------------------------------------------------------------------------
// 調整する数値
// ---------------------------------------------------------------------------

/** 波 1 本の周期（秒）。t = k * WAVE_T に k 本目の波が汀線へ届く。 */
const WAVE_T = 8;
/** うねりの山が岸へ進む速さ（単位/秒）。 */
const CREST_C = 4.2;
/** うねりの高さの基準。 */
const AMP = 0.6;
/** 波が崩れ始める位置（汀線からの距離、沖が負）。波ごとに ±数単位ずれる。 */
const BREAK_Z = -10.5;
/** 遡上の届く距離の基準（汀線から陸へ向かう水平距離）。 */
const RUN = 6.4;
/** 駆け上がりにかかる秒数と、引いていく秒数。足して WAVE_T を超えないこと。 */
const RUN_UP = 2.5;
const RUN_DOWN = 4.7;
/** 浜の勾配。 */
const SLOPE = 0.055;
/** 濡れた砂の艶が消えるまでの時定数（秒）。 */
const DRY = 3.4;

/** 太陽の方位（水平面の向き）と、中心の仰角・見かけの半径（ラジアン）。 */
const SUN_AZIMUTH: [number, number] = [-0.2, -1];
const SUN_ELEVATION = 0.006;
const SUN_RADIUS = 0.016;
/** 太陽の円盤と、水面に落ちる照り返しの明るさ。 */
const SUN_DISC = 7;
const SUN_GLINT = 2.2;

/** 遠景が空の色へ溶ける距離。 */
const HAZE = 120;

/** ember() を焼いておく段数。 */
const LUT_N = 24;

/** カメラ。波打ち際から少し下がって腰を下ろした目の高さ。 */
const CAMERA_POS: [number, number, number] = [0, 3.0, 15];
const CAMERA_TARGET: [number, number, number] = [0, 0.9, -6];

/**
 * 沖から寄せる細かいうねり。[進む向きのずれ(rad), 波長, 振幅]。
 * 速さは深い水の分散関係 ω=√(gk) から決める（長い波ほど速い）。
 */
const SWELL: readonly (readonly [number, number, number])[] = [
  [0.22, 11.5, 0.07],
  [-0.38, 7.3, 0.048],
  [0.62, 4.6, 0.028],
  [-0.95, 3.1, 0.017],
];
/**
 * 画素の法線だけに足すさざ波。[向き(rad), 波長]。振幅は波長に比例させる。
 * 頂点を動かさないので、板の分割数に縛られずに照り返しが粒に割れる。
 */
const RIPPLE: readonly (readonly [number, number])[] = [
  [1.2, 2.3],
  [2.6, 1.7],
  [0.4, 1.25],
  [-0.9, 0.95],
  [2.0, 0.7],
  [-2.3, 0.52],
  [0.9, 0.4],
];
const GRAVITY = 6;

/** 流木。中心 [x, z]、長さ、根元の太さ、向き（rad）。砂に少し埋める。 */
const LOG: { x: number; z: number; len: number; r: number; yaw: number } = {
  x: 3.2,
  z: 7.6,
  len: 3.8,
  r: 0.2,
  yaw: -0.35,
};
/** 岩。[x, z, 半径]。 */
const ROCKS: readonly (readonly [number, number, number])[] = [
  [5.0, 5.9, 0.45],
  [5.9, 6.7, 0.3],
  [4.4, 6.9, 0.22],
  [-4.6, 7.0, 0.28],
];
/** 砂丘に植える草の株の数と、1 株あたりの葉の数。 */
const TUFTS_DUNE = 10;
const BLADES = 11;
/** カモメ。留まる位置 [x, y, z]、横へ漂う幅、漂う速さ、位相。 */
const GULLS: readonly (readonly [number, number, number, number, number, number])[] = [
  [8, 7.5, -18, 3.5, 0.05, 0.0],
  [-5, 9, -24, 4.5, 0.04, 2.1],
];
/** カモメの大きさ（翼開長はおよそこの 1.7 倍）。 */
const GULL_SCALE = 2;

// ---------------------------------------------------------------------------
// 共通の式
// ---------------------------------------------------------------------------

const f = (x: number): string => x.toFixed(5);

/** [kx, kz, ω, 振幅] に直す。どれも +z（岸）へ向かって進む。 */
function swellVec(): string {
  return SWELL.map(([a, len, amp]) => {
    const k = (Math.PI * 2) / len;
    const w = Math.sqrt(GRAVITY * k);
    return `vec4(${f(Math.sin(a) * k)}, ${f(Math.cos(a) * k)}, ${f(w)}, ${f(amp)})`;
  }).join(',\n  ');
}

function rippleVec(): string {
  return RIPPLE.map(([a, len]) => {
    const k = (Math.PI * 2) / len;
    const w = Math.sqrt(GRAVITY * k);
    return `vec4(${f(Math.cos(a) * k)}, ${f(Math.sin(a) * k)}, ${f(w)}, ${f(len * 0.008)})`;
  }).join(',\n  ');
}

const COMMON_GLSL = /* glsl */ `
#define LUT_N ${LUT_N}
uniform float uTime;
uniform vec3 uLut[LUT_N];
uniform vec3 uSun;
varying vec3 vW;

const float WAVE_T = ${f(WAVE_T)};
const float CREST_C = ${f(CREST_C)};
const float AMP = ${f(AMP)};
const float BREAK_Z = ${f(BREAK_Z)};
const float RUN = ${f(RUN)};
const float RUN_UP = ${f(RUN_UP)};
const float RUN_DOWN = ${f(RUN_DOWN)};
const float SLOPE = ${f(SLOPE)};
const float DRY = ${f(DRY)};
const float HAZE = ${f(HAZE)};

const vec4 SWELL[${SWELL.length}] = vec4[](
  ${swellVec()}
);
const vec4 RIPPLE[${RIPPLE.length}] = vec4[](
  ${rippleVec()}
);

/** 0（暗い薔薇）〜 1（明るい琥珀）。色はすべてここから引く。 */
vec3 lut(float n) {
  float x = clamp(n, 0.0, 1.0) * float(LUT_N - 1);
  int i = int(floor(x));
  int j = min(i + 1, LUT_N - 1);
  return mix(uLut[i], uLut[j], x - float(i));
}

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 u = fract(p);
  u = u * u * (3.0 - 2.0 * u);
  return mix(
    mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
    mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}
float fbm3(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return s / 0.875;
}
/** 泡の網目。セルの境目で 0 になる（F2 - F1）。 */
float lace(vec2 p) {
  vec2 i = floor(p);
  vec2 fr = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 r = g + hash22(i + g) - fr;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; }
      else if (d < d2) { d2 = d; }
    }
  }
  return sqrt(d2) - sqrt(d1);
}
/** 泡の量 amt を網目に変える。少ないと細い糸、多いと塗りつぶしの白波になる。 */
float foamMask(float amt, vec2 uv, float dist) {
  if (amt < 0.02) return 0.0;
  float n = fbm3(uv * 0.45);
  float body = smoothstep(0.15, 1.1, amt * (0.55 + 0.9 * n));
  float net = 1.0 - smoothstep(0.0, 0.18 + 0.25 * min(amt, 1.0), lace(uv));
  net *= smoothstep(0.02, 0.4, amt) * (1.0 - smoothstep(12.0, 40.0, dist));
  return clamp(body * 0.8 + net * 0.14 * (1.0 - body), 0.0, 1.0);
}

// --- 空 ---------------------------------------------------------------------

/** 空の地のグラデーション。夕焼けは太陽の方角に寄せて、横へは暗く落とす。 */
vec3 skyGrad(vec3 d) {
  float y = max(d.y, 0.0);
  vec2 hz = normalize(d.xz + vec2(1e-5));
  float toward = dot(hz, normalize(uSun.xz)) * 0.5 + 0.5;
  // 太陽と反対側の空。水平線のすぐ上に地球の影のくすんだ帯、その上に淡い薔薇色の帯
  // （ビーナスベルト）がかかる。これが無いと陸側を向いたとき空も海も遠景も真っ黒になる。
  // ember は n < 0.4 で色相が赤より青い側へ回り、暗いと紫に見えるので、こちら側は n を上げる
  float away = pow(1.0 - toward, 2.0);
  vec3 zen = lut(mix(0.1, 0.45, away)) * 0.045;
  vec3 hor = mix(lut(mix(0.16, 0.45, away)) * 0.12, lut(0.68) * 0.6, pow(toward, 7.0));
  vec3 c = mix(zen, hor, exp(-y * mix(6.0, 11.0, toward)));
  float shadow = exp(-y / 0.06);
  float belt = exp(-pow((y - 0.12) / 0.07, 2.0));
  return c + away * (lut(0.6) * 0.6 * belt + lut(0.45) * 0.2 * shadow);
}
/** 空の地の色（太陽の円盤と雲を除く）。暈は太陽を中心に円く減衰させる。 */
vec3 skyBase(vec3 d) {
  float mu = max(dot(d, uSun), 0.0);
  return skyGrad(d) + lut(0.94) * (pow(mu, 90.0) * 0.6 + pow(mu, 14.0) * 0.07) * step(0.0, d.y);
}
/** 遠くのものが溶けていく色。その方位の水平線の色と、ごく薄い暈。 */
vec3 hazeColor(vec3 d) {
  vec3 h = normalize(vec3(d.x, 0.0, d.z));
  return skyGrad(h) + lut(0.94) * pow(max(dot(h, uSun), 0.0), 40.0) * 0.12;
}
vec3 sky(vec3 d) {
  vec3 c = skyBase(d);
  if (d.y <= 0.0) return c;
  // 右手の水平線に低く横たわる遠い岬。霞んで空に溶けかけている
  float az = atan(d.x, -d.z);
  float cape = smoothstep(0.2, 0.34, az) * (1.0 - smoothstep(0.8, 1.15, az));
  float ridge = cape * (0.016 + 0.012 * smoothstep(0.3, 0.62, az) + 0.006 * vnoise(vec2(az * 22.0, 3.0)));
  if (d.y < ridge) {
    return mix(lut(0.08) * 0.05, hazeColor(d), 0.4 + 0.4 * (1.0 - d.y / max(ridge, 1e-4)));
  }
  float mu = dot(d, uSun);
  // 沈みかけた太陽の円盤。下半分は海に隠れる（水平線より下は描かない）
  float ang = sqrt(max(2.0 * (1.0 - mu), 0.0));
  float disc = 1.0 - smoothstep(${f(SUN_RADIUS * 0.8)}, ${f(SUN_RADIUS)}, ang);
  c = mix(c, lut(1.0) * ${f(SUN_DISC)}, disc);
  // 横に流れる層雲。太陽の側だけ下から照らされる
  vec2 p = d.xz / (d.y + 0.07);
  vec2 q = p * vec2(0.2, 0.8) + vec2(uTime * 0.006, 0.0);
  float cov = smoothstep(0.52, 0.8, fbm3(q));
  cov *= smoothstep(0.01, 0.07, d.y) * (1.0 - smoothstep(0.3, 0.65, d.y));
  vec2 hz = normalize(d.xz + vec2(1e-5));
  float toward = dot(hz, normalize(uSun.xz)) * 0.5 + 0.5;
  vec3 cc = mix(lut(0.04) * 0.04, lut(0.62) * 0.42, pow(toward, 5.0));
  cc += lut(0.92) * pow(max(mu, 0.0), 40.0) * 0.8;
  return mix(c, cc, cov * 0.92);
}

// --- 砂 ---------------------------------------------------------------------

/** 汀線の z。ゆるく弓なりに曲がる。 */
float shoreZ(float x) {
  return 0.9 * sin(x * 0.045 + 0.6) + 0.35 * sin(x * 0.13 + 2.0);
}
/** 砂の高さ。汀線で 0、陸へ向かって上がり、奥に低い砂丘が続く。 */
float sandH(vec2 xz) {
  float d = xz.y - shoreZ(xz.x);
  float h = SLOPE * d;
  // 奥の砂丘。陸側を向いたとき、空の明るい帯を背にした稜線として読める高さまで盛る
  h += 2.8 * smoothstep(19.0, 38.0, d) * (0.55 + 0.3 * sin(xz.x * 0.09 + 1.3) + 0.15 * sin(xz.x * 0.23 + 0.4));
  return h;
}

// --- 波 ---------------------------------------------------------------------

/** k 本目の波の大きさ。6 本で大小のセットが一巡する。 */
float ampK(float k) {
  float s = sin(k * 0.5236);
  return 0.72 + 0.3 * hash11(k * 7.13 + 1.7) + 0.38 * s * s;
}
/** 波の山の曲がり。沖ではうねり、岸に近づくほど汀線に沿って揃う。 */
float bendK(float x, float k) {
  return 1.6 * sin(x * 0.038 + k * 1.3) + 0.7 * sin(x * 0.1 - k * 0.7);
}
/** 崩れ始める位置。場所ごとにずらしてあるので、波は端から順に崩れていく。 */
float breakZ(float x, float k) {
  return BREAK_Z + 2.6 * sin(x * 0.06 + k * 2.1) + 1.8 * sin(x * 0.17 + k * 1.3) + 2.0 * (hash11(k * 3.7 + 0.3) - 0.5)
    - 3.0 * (ampK(k) - 0.9);
}

/**
 * k 本目の波の山。x = 高さ、y = 山からの距離（岸側が正）、
 * z = 崩れの進み具合（0..1）、w = 山の位置（汀線から、沖が負）。
 */
vec4 crestK(vec2 xz, float k, float t) {
  float s = shoreZ(xz.x);
  float dist = CREST_C * (k * WAVE_T - t);
  float zRel = -0.5 - dist + bendK(xz.x, k) * clamp(dist / 25.0, 0.0, 1.0);
  float zb = breakZ(xz.x, k);
  float b = smoothstep(zb, zb + 2.2, zRel);
  float steep = smoothstep(zb - 14.0, zb, zRel);
  float A = AMP * ampK(k) * (1.0 + 0.8 * steep);
  A *= mix(1.0, 0.72, b);
  A *= 1.0 - 0.6 * smoothstep(zb + 2.2, -1.0, zRel);
  A *= 1.0 - smoothstep(-2.5, -0.5, zRel);
  float u = xz.y - (s + zRel);
  // 前の面は崩れる直前ほど切り立ち、崩れたあとは段（ボア）になって後ろへ長く尾を引く
  float wf = mix(mix(4.5, 1.2, steep), 0.6, b);
  float wb = mix(mix(4.5, 3.2, steep), 6.0, b);
  float q = clamp(u / (u > 0.0 ? wf : wb), -12.0, 12.0);
  float sh = 1.0 / cosh(q);
  return vec4(A * sh * sh, u, b, zRel);
}

/** その点を最後に通り過ぎた波の番号。これと次の 1 本だけを見れば足りる。 */
float passedK(vec2 xz, float t) {
  float zp = xz.y - shoreZ(xz.x);
  return floor((t + (-0.5 - zp) / CREST_C) / WAVE_T);
}

/** 水面の高さ。頂点でも画素でも同じ式を呼ぶ。 */
float seaH(vec2 xz, float t) {
  float zp = xz.y - shoreZ(xz.x);
  float kc = passedK(xz, t);
  float h = crestK(xz, kc, t).x + crestK(xz, kc + 1.0, t).x;
  float calm = 1.0 - smoothstep(-12.0, -1.0, zp);
  for (int i = 0; i < ${SWELL.length}; i++) {
    vec4 w = SWELL[i];
    h += w.w * calm * sin(dot(w.xy, xz) - t * w.z);
  }
  return h;
}

/** 画素の法線に足すさざ波の傾き。遠いほど弱め、照り返しの広がりで代わりに受ける。 */
vec2 rippleGrad(vec2 xz, float t, float dist, float amount) {
  vec2 g = vec2(0.0);
  for (int i = 0; i < ${RIPPLE.length}; i++) {
    vec4 w = RIPPLE[i];
    float len = w.w * 50.0;
    float fade = 1.0 - smoothstep(len * 8.0, len * 24.0, dist);
    g += w.w * cos(dot(w.xy, xz) - t * w.z) * w.xy * fade;
  }
  return g * amount;
}

// --- 遡上 -------------------------------------------------------------------

/** k 本目の波が駆け上がる距離。縁は舌のように出入りする。 */
float runMax(float x, float k) {
  float a = ampK(k);
  return RUN * (0.5 + 0.5 * a)
    * (1.0 + 0.16 * sin(x * 0.19 + k * 2.3) + 0.13 * sin(x * 0.43 - k * 1.1)
       + 0.1 * sin(x * 0.71 + k * 4.0) + 0.05 * sin(x * 1.37 - k * 2.6));
}
/** 波が汀線に届いてから tau 秒後の水の縁。上がるときは減速し、引くときは加速する。 */
float runEdge(float rm, float tau) {
  if (tau < RUN_UP) {
    float s = 1.0 - tau / RUN_UP;
    return rm * (1.0 - s * s);
  }
  float s = min((tau - RUN_UP) / RUN_DOWN, 1.0);
  return rm * (1.0 - s * s);
}

float fresnel(float c) {
  return 0.02 + 0.98 * pow(1.0 - clamp(c, 0.0, 1.0), 5.0);
}
/** 砂を照らす光（空の半球 + 地平すれすれの太陽）。 */
vec3 sandLight(vec3 n) {
  vec3 amb = lut(0.28) * 0.3 + lut(0.7) * 0.32 * (0.35 + 0.65 * n.y);
  return amb + lut(0.97) * 2.2 * max(dot(n, uSun), 0.0);
}
/** 濡れた砂。乾いた砂を暗くしただけだと黄味が残ってオリーブに見えるので、赤茶に寄せる。 */
vec3 wetAlbedo() {
  return lut(0.5) * 0.3;
}
vec3 sandAlbedo() {
  // 黄寄りの琥珀は暗いところでオリーブに転ぶので、少し赤い琥珀にしておく
  return lut(0.72) * 0.9;
}
`;

const VERT = /* glsl */ `
${COMMON_GLSL}
uniform float uDisplace;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  if (uDisplace > 0.5) {
    // 近景の板だけを波の高さへ持ち上げる。縁では 0 に戻して遠景の板と継ぎ目を合わせる
    float fade = (1.0 - smoothstep(30.0, 39.0, abs(w.x))) * smoothstep(-40.0, -32.0, w.z);
    w.y += seaH(w.xz, uTime) * fade;
  } else if (uDisplace < -0.5) {
    w.y += sandH(w.xz);
  }
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const OUT = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

const SKY_FRAG = /* glsl */ `
${COMMON_GLSL}
void main() {
  vec3 d = normalize(vW - cameraPosition);
  gl_FragColor = vec4(sky(d), 1.0);
  ${OUT}
}
`;

const SEA_FRAG = /* glsl */ `
${COMMON_GLSL}
void main() {
  vec2 xz = vW.xz;
  // 汀線より陸側は砂のシェーダが水の膜を描く。境目を格子の粗さに任せず式で切る
  if (xz.y > shoreZ(xz.x)) discard;
  float t = uTime;
  vec3 toCam = cameraPosition - vW;
  float dist = length(toCam);
  vec3 V = toCam / dist;

  // 法線は頂点ではなく画素ごとに、高さの式から作り直す
  float e = 0.05 + dist * 0.004;
  float h0 = seaH(xz, t);
  vec2 g = vec2(seaH(xz + vec2(e, 0.0), t) - h0, seaH(xz + vec2(0.0, e), t) - h0) / e;
  g += rippleGrad(xz, t, dist, 1.0);
  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));

  // 白波。崩れた面を転げ落ち、段の後ろへ網目になって広がりながら消えていく
  float s = shoreZ(xz.x);
  float kc = passedK(xz, t);
  float foam = 0.0;
  float crestLift = 0.0;
  float face = 0.0;
  for (int i = -1; i <= 1; i++) {
    float k = kc + float(i);
    vec4 c = crestK(xz, k, t);
    crestLift = max(crestLift, c.x);
    if (c.z <= 0.0) continue;
    float zb = breakZ(xz.x, k);
    float age = max(c.w - zb, 0.0) / CREST_C;
    float front = c.y > 0.0 ? exp(-c.y / 1.6) : 1.0;
    float trail = c.y < 0.0 ? exp(c.y / min(3.5 + age * 2.5, 12.0)) : 1.0;
    // 泡が出るのは崩れた線より岸側だけ。沖へは尾を引かない
    float zone = smoothstep(zb - 3.0, zb + 1.0, xz.y - s);
    // 白波は一様な帯にせず、場所ごとに太さを 0.3〜1.5 倍にばらつかせて途切れさせる
    float patchy = 0.3 + 1.2 * smoothstep(0.2, 0.8, vnoise(vec2(xz.x * 0.16 + k * 3.1, c.y * 0.12 + k)));
    float amt = c.z * front * trail * zone * patchy * exp(-age / 6.5) * 2.2;
    // 崩れる前の面の斜面。泡の手前（岸側）を暗くして、立ち上がった波に見せる
    face = max(face, exp(-pow((c.y - 1.1) / 0.9, 2.0)) * smoothstep(0.0, 0.3, c.z + 0.3 * c.x) * patchy * 0.6);
    float drift = min(c.w, 0.0) * 0.55 + max(c.w, 0.0) * 0.1;
    vec2 uv = vec2(xz.x, xz.y - s - drift) * vec2(1.0, 1.25) + vec2(k * 17.3, k * 5.1);
    foam = max(foam, foamMask(amt, uv, dist));
  }

  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  float F = fresnel(dot(N, V));
  vec3 refl = sky(R);

  // 照り返し。遠いほどさざ波が細かく揃って見えなくなるぶん、広がった帯で受ける
  float shin = mix(1600.0, 70.0, clamp(dist / 170.0, 0.0, 1.0));
  float glint = pow(max(dot(R, uSun), 0.0), shin) * shin * 0.004 * ${f(SUN_GLINT)};

  // 水の中。浅いところは砂が透け、崩れる前の薄い山は夕日に透ける
  float depth = max(h0 - sandH(xz), 0.0);
  vec3 wetSand = wetAlbedo() * sandLight(vec3(0.0, 1.0, 0.0));
  vec3 deep = lut(0.05) * 0.035;
  vec3 body = mix(deep, wetSand, exp(-depth * 1.7));
  float back = pow(max(dot(-V, uSun), 0.0), 3.0);
  body += lut(0.64) * 0.9 * back * smoothstep(0.15, 0.75, crestLift) * clamp(dot(N, V) * 1.6, 0.0, 1.0);

  vec3 col = (mix(body, refl, F) + lut(1.0) * glint) * (1.0 - 0.5 * min(face, 1.0));
  // 泡は空の明かりで淡く、太陽の光の道の上だけ夕日に透けて明るい
  float path = pow(max(dot(-V, uSun), 0.0), 30.0);
  // 泡の色は黄寄りの琥珀にすると暗いところでカーキに濁るので、淡い薔薇寄りの琥珀にする
  vec3 foamCol = lut(0.62) * (0.2 + 0.15 * N.y + 0.75 * path);
  col = mix(col, foamCol, foam);

  col = mix(col, hazeColor(-V), 1.0 - exp(-pow(dist / HAZE, 2.0)));
  gl_FragColor = vec4(col, 1.0);
  ${OUT}
}
`;

const SAND_FRAG = /* glsl */ `
${COMMON_GLSL}
uniform vec4 uLog;                      // 流木の両端 (x0, z0, x1, z1)
uniform vec4 uRocks[${ROCKS.length}];   // x, z, 半径

/** 流木と岩の根元の陰。置いた物が砂に沈んで見えるように。 */
float occlusion(vec2 p) {
  vec2 pa = p - uLog.xy;
  vec2 ba = uLog.zw - uLog.xy;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  float o = 1.0 - 0.6 * exp(-pow(length(pa - ba * h) / 0.42, 2.0));
  for (int i = 0; i < ${ROCKS.length}; i++) {
    vec4 r = uRocks[i];
    o *= 1.0 - 0.55 * exp(-pow(length(p - r.xy) / (r.z * 1.45), 2.0));
  }
  return o;
}

void main() {
  vec2 xz = vW.xz;
  float t = uTime;
  vec3 toCam = cameraPosition - vW;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  float s = shoreZ(xz.x);
  float d = xz.y - s;

  float e = 0.1;
  float hs = sandH(xz);
  vec2 g = vec2(sandH(xz + vec2(e, 0.0)) - hs, sandH(xz + vec2(0.0, e)) - hs) / e;

  // 乾いた砂には風紋。波が洗うところは平らに均されている
  float dryZone = smoothstep(RUN * 1.0, RUN * 1.7, d) * (1.0 - smoothstep(18.0, 30.0, dist));
  float rp = xz.y * 15.0 + xz.x * 2.5 + vnoise(xz * 0.7) * 7.0 + vnoise(xz * 2.3) * 1.5;
  g.y += cos(rp) * 0.14 * dryZone * smoothstep(0.25, 0.65, vnoise(xz * 0.45 + 3.1));

  // 直近 3 本の波の遡上を古い順に重ねる
  float cover = d < 0.0 ? 1.0 : 0.0;
  float sheet = max(-d, 0.0) * 0.06;
  float gloss = d < 0.0 ? 1.0 : 0.0;
  float foam = 0.0;
  float flow = 0.0;
  float k0 = floor(t / WAVE_T);
  for (int i = 2; i >= 0; i--) {
    float k = k0 - float(i);
    float tau = t - k * WAVE_T;
    float rm = runMax(xz.x, k);
    float edge = runEdge(rm, tau);
    bool up = tau < RUN_UP;
    if (d < edge) {
      // いま水の膜の下。縁は泡の帯になり、膜の中にも網目が流れる
      float behind = edge - d;
      cover = max(cover, smoothstep(0.0, 0.35, behind));
      gloss = 1.0;
      sheet = max(sheet, min(behind * 0.03, 0.12));
      flow = up ? 1.0 : -1.0;
      float edgeFoam = exp(-pow((behind - 0.15) / (up ? 0.45 : 0.25), 2.0)) * (up ? 1.6 : 0.5);
      float bodyFoam = exp(-behind / 1.6) * (up ? 1.0 : 0.4) * exp(-tau / 4.5);
      vec2 uv = vec2(xz.x, d - edge * 0.85) * vec2(1.1, 1.6) + vec2(k * 9.1, k * 3.3);
      foam = foamMask(edgeFoam + bodyFoam, uv, dist);
    } else if (d < rm) {
      // 水が引いたあと。艶が数秒かけて消え、取り残された泡の網目がほどけていく
      float sq = sqrt(max(1.0 - d / rm, 0.0));
      float tout = RUN_UP + RUN_DOWN * sq;
      if (tau > tout) {
        float age = tau - tout;
        gloss = max(gloss, exp(-age / DRY));
        vec2 uv = vec2(xz.x, d * 0.15) * vec2(1.1, 1.6) + vec2(k * 9.1, k * 3.3);
        foam = max(foam, foamMask(0.5 * exp(-age / 1.8), uv, dist));
      }
    }
    // いちばん上まで届いたところに残る泡の線
    if (tau > RUN_UP) {
      float mark = exp(-pow((rm - d) / 0.3, 2.0)) * exp(-(tau - RUN_UP) / 5.0) * 0.8;
      vec2 uv = vec2(xz.x, d) * vec2(1.4, 2.4) + vec2(k * 4.7, 0.0);
      foam = max(foam, foamMask(mark, uv, dist));
    }
  }

  // 波の届く帯は、艶が消えても湿って暗い
  float damp = 1.0 - smoothstep(RUN * 0.55, RUN * 1.35, d);
  vec3 alb = mix(sandAlbedo(), wetAlbedo(), max(damp * 0.75, gloss));
  // 奥の砂丘は一段暗い薔薇茶にして、手前の明るい浜と見分けられるようにする
  alb = mix(alb, lut(0.5) * 0.45, smoothstep(18.0, 28.0, d) * 0.7);

  // 貝殻と小石。波の届く帯にまばらに散らばり、濡れると光る
  vec2 cp = xz * 2.2;
  vec2 cell = floor(cp);
  float pick = hash12(cell + 17.0);
  float shell = 0.0;
  float tideLine = exp(-pow((d - RUN * 1.15) / 1.6, 2.0));
  if (pick > 1.0 - 0.07 * tideLine && dist < 24.0) {
    vec2 q = fract(cp) - 0.5 - (hash22(cell) - 0.5) * 0.5;
    float a = hash12(cell + 5.0) * 6.2832;
    q = mat2(cos(a), -sin(a), sin(a), cos(a)) * q;
    q.x *= 1.5;
    float r = 0.15 + 0.08 * hash12(cell + 3.0);
    shell = (1.0 - smoothstep(r * 0.6, r, length(q))) * (1.0 - smoothstep(12.0, 24.0, dist));
    vec3 sc = hash12(cell + 9.0) > 0.5 ? lut(0.97) * 1.25 : lut(0.8) * 1.05;
    alb = mix(alb, sc * mix(1.0, 0.7, gloss), shell);
  }

  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 col = alb * sandLight(N) * occlusion(xz);

  // 濡れた砂と水の膜は空を映す。膜はさざ波が流れ、濡れ砂は少しだけぼやける
  vec2 wg = vec2(0.0);
  if (cover > 0.0) {
    float ph = d * 5.5 + xz.x * 1.7 - flow * t * 7.0;
    float ph2 = d * 3.1 - xz.x * 2.3 - flow * t * 4.3;
    wg = vec2(0.02 * cos(ph2) * -2.3 + 0.03 * cos(ph) * 1.7, 0.03 * cos(ph) * 5.5 + 0.02 * cos(ph2) * 3.1) * 0.12;
    wg += rippleGrad(xz, t, dist, 0.12);
  } else {
    wg = vec2(vnoise(xz * 3.0) - 0.5, vnoise(xz * 3.0 + 7.3) - 0.5) * 0.05;
  }
  vec3 Nw = normalize(vec3(-(g.x * (1.0 - gloss) + wg.x), 1.0, -(g.y * (1.0 - gloss) + wg.y)));
  vec3 R = reflect(-V, Nw);
  R.y = abs(R.y);
  float F = fresnel(dot(Nw, V));
  vec3 refl = sky(R);
  float mirror = max(cover, gloss * 0.75);
  col = mix(col * mix(1.0, exp(-sheet * 6.0), cover), refl, F * mirror);
  float shin = mix(160.0, 900.0, max(cover, shell * gloss));
  col += lut(1.0) * pow(max(dot(R, uSun), 0.0), shin) * shin * 0.003 * mirror * ${f(SUN_GLINT)};
  // 濡れた面には、太陽の方角へ伸びる幅の広い照り返しの帯が立つ
  col += lut(0.9) * pow(max(dot(R, uSun), 0.0), 40.0) * 0.6 * mirror;

  vec3 foamCol = lut(0.62) * (0.34 + 0.26 * Nw.y);
  col = mix(col, foamCol, foam);

  col = mix(col, hazeColor(-V), 1.0 - exp(-pow(dist / HAZE, 2.0)));
  gl_FragColor = vec4(col, 1.0);
  ${OUT}
}
`;

/** 流木・岩・草。浜と同じ光で照らし、夕日を背にした縁だけ明るく縁取る。 */
const PROP_VERT = /* glsl */ `
${COMMON_GLSL}
uniform float uSway;
varying vec3 vN;
void main() {
  vec4 w = vec4(position, 1.0);
  vec3 n = normal;
  #ifdef USE_INSTANCING
    w = instanceMatrix * w;
    n = mat3(instanceMatrix) * n;
  #endif
  w = modelMatrix * w;
  if (uSway > 0.0) {
    // 草は根元を留めたまま、先ほど大きく風に振れる
    float k = position.y * position.y;
    float gust = sin(uTime * 1.1 + w.x * 0.35 + w.z * 0.2) * 0.6 + sin(uTime * 2.3 + w.x * 1.3) * 0.25;
    w.x += gust * uSway * k;
    w.z += gust * uSway * k * 0.4;
  }
  vN = normalize(mat3(modelMatrix) * n);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const PROP_FRAG = /* glsl */ `
${COMMON_GLSL}
uniform float uTone;
uniform float uAlb;
uniform float uGrain;
varying vec3 vN;
void main() {
  vec3 toCam = cameraPosition - vW;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec3 N = normalize(vN);
  if (dot(N, V) < 0.0) N = -N;
  // 木目・岩肌のむら
  float grain = vnoise(vec2(vW.x * 1.3 + vW.z * 1.3, vW.y * 14.0)) * 0.6 + vnoise(vW.xz * 5.0 + vW.y * 5.0) * 0.4;
  vec3 alb = lut(uTone) * uAlb * mix(1.0, 0.55 + 0.9 * grain, uGrain);
  vec3 col = alb * sandLight(N);
  // 砂からの照り返し
  col += alb * lut(0.7) * 0.12 * max(-N.y, 0.0);
  // 逆光の縁取り
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0) * pow(max(dot(-V, uSun), 0.0), 2.0);
  col += lut(0.9) * rim * 0.3;
  col = mix(col, hazeColor(-V), 1.0 - exp(-pow(dist / HAZE, 2.0)));
  gl_FragColor = vec4(col, 1.0);
  ${OUT}
}
`;

// ---------------------------------------------------------------------------

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a: number, b: number, x: number): number => {
  const k = clamp01((x - a) / (b - a));
  return k * k * (3 - 2 * k);
};
/** シェーダの shoreZ / sandH と同じ式。小道具を砂の上に置くのに使う。 */
const shoreZ = (x: number): number => 0.9 * Math.sin(x * 0.045 + 0.6) + 0.35 * Math.sin(x * 0.13 + 2.0);
function sandHeight(x: number, z: number): number {
  const d = z - shoreZ(x);
  return (
    SLOPE * d +
    2.8 * smoothstep(19, 38, d) * (0.55 + 0.3 * Math.sin(x * 0.09 + 1.3) + 0.15 * Math.sin(x * 0.23 + 0.4))
  );
}

/** 毎回同じ浜になるよう、固定の漸化式で散らす。 */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 0.49297) % 1;
    return s;
  };
}

const uniforms = {
  uTime: { value: 0 },
  uLut: { value: Array.from({ length: LUT_N }, () => new THREE.Color()) },
  uSun: { value: new THREE.Vector3() },
  uLog: { value: new THREE.Vector4() },
  uRocks: { value: ROCKS.map(() => new THREE.Vector4()) },
};

function bakeLut(t: number): void {
  const shift = drift(t);
  uniforms.uLut.value.forEach((c, i) => ember(c, i / (LUT_N - 1), shift));
}

function material(frag: string, displace: number, side: THREE.Side = THREE.FrontSide): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uDisplace: { value: displace } },
    vertexShader: VERT,
    fragmentShader: frag,
    side,
    depthWrite: displace !== 0,
  });
}

function propMaterial(tone: number, alb: number, grain: number, sway = 0): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...uniforms,
      uTone: { value: tone },
      uAlb: { value: alb },
      uGrain: { value: grain },
      uSway: { value: sway },
    },
    vertexShader: PROP_VERT,
    fragmentShader: PROP_FRAG,
    side: sway > 0 ? THREE.DoubleSide : THREE.FrontSide,
  });
}

/**
 * 流木。波に洗われて白く乾いた幹。根元は太くこぶになり、先へ細ってゆき、
 * 途中で横へ 2 度曲がる。短く折れた枝の付け根を 2 本残す。
 *
 * 幹は y 軸に沿って作り、最後に寝かせる。寝かせると局所の x が上下、z が水平になるので、
 * 曲げは z にだけ入れて、両端を砂から浮かせない。
 */
function buildLog(root: THREE.Group): void {
  const mat = propMaterial(0.9, 0.45, 0.55);
  const { x, z, len, r, yaw } = LOG;
  const cy = sandHeight(x, z) + r * 0.35;
  /** 幹の芯の横ずれ。y は -len/2（根元）〜 len/2（先）。 */
  const bend = (y: number): number => 0.3 * Math.sin(y * 0.9 + 0.4) + 0.12 * Math.sin(y * 2.3);
  /** 太さの輪郭。根元は太く、先は細く。 */
  const girth = (y: number): number => {
    const u = y / len + 0.5;
    return r * (1.25 - 0.95 * Math.pow(u, 0.8));
  };
  const place = (g: THREE.BufferGeometry): void => {
    g.rotateZ(Math.PI / 2);
    g.rotateY(yaw);
    g.translate(x, cy, z);
    g.computeVertexNormals();
    root.add(new THREE.Mesh(g, mat));
  };

  const trunk = new THREE.CylinderGeometry(1, 1, len, 18, 24, true);
  const p = trunk.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const py = p.getY(i);
    const th = Math.atan2(p.getZ(i), p.getX(i));
    const k = girth(py) * (1 + 0.1 * Math.sin(py * 2.1 + th * 2) + 0.06 * Math.sin(py * 5.3 - th * 3) + 0.04 * Math.sin(th * 9 + py * 3));
    p.setXYZ(i, Math.cos(th) * k, py, Math.sin(th) * k + bend(py));
  }
  place(trunk);

  // 両端は平らな切り口にせず、丸めて閉じる（根元はこぶ、先は裂けて細った丸み）
  const cap = (y: number, rr: number, squash: number): void => {
    const g = new THREE.SphereGeometry(rr, 14, 10);
    g.scale(1, squash, 1);
    g.translate(0, y, bend(y));
    place(g);
  };
  cap(-len / 2, girth(-len / 2) * 1.08, 0.8);
  cap(len / 2, girth(len / 2) * 1.02, 1.6);

  // 折れた枝の付け根。水平に近く張り出させ、砂に刺さらないようにする
  const branch = (along: number, spin: number, l: number, br: number): void => {
    const g = new THREE.CylinderGeometry(br * 0.35, br, l, 8, 3);
    g.translate(0, l / 2, 0);
    g.rotateX(Math.PI / 2 - 0.5);
    g.rotateY(spin);
    g.translate(0, along, bend(along));
    place(g);
  };
  branch(-0.5, 0.35, 0.75, girth(-0.5) * 0.45);
  branch(0.8, Math.PI + 0.3, 0.5, girth(0.8) * 0.5);

  const dx = Math.cos(yaw) * (len / 2);
  const dz = -Math.sin(yaw) * (len / 2);
  uniforms.uLog.value.set(x - dx, z - dz, x + dx, z + dz);
}

/** 岩。球をでこぼこに崩し、平たく潰して砂に半分埋める。 */
function buildRocks(root: THREE.Group): void {
  const mat = propMaterial(0.12, 0.2, 0.8);
  const rand = rng(0.417);
  ROCKS.forEach(([x, z, r], i) => {
    const g = new THREE.SphereGeometry(1, 22, 16);
    const p = g.attributes.position as THREE.BufferAttribute;
    const a = rand() * 6;
    const b = rand() * 6;
    for (let j = 0; j < p.count; j++) {
      const vx = p.getX(j);
      const vy = p.getY(j);
      const vz = p.getZ(j);
      const k =
        1 +
        0.18 * Math.sin(vx * 2.3 + a) * Math.sin(vz * 2.1 + b) +
        0.08 * Math.sin(vy * 5 + vx * 4 + a) +
        0.05 * Math.sin(vz * 9 + b);
      p.setXYZ(j, vx * k, vy * k, vz * k);
    }
    g.scale(r * 1.25, r * 0.72, r);
    g.rotateY(rand() * 6);
    g.translate(x, sandHeight(x, z) + r * 0.12, z);
    g.computeVertexNormals();
    root.add(new THREE.Mesh(g, mat));
    uniforms.uRocks.value[i].set(x, z, r, 0);
  });
}

/** 浜の草。細い葉を株ごとに束ね、背後の砂丘に植える（波打ち際には生やさない）。 */
function buildGrass(root: THREE.Group): void {
  const blade = new THREE.PlaneGeometry(0.035, 1, 1, 5);
  blade.translate(0, 0.5, 0);
  // 先を細らせる
  const p = blade.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setX(i, p.getX(i) * (1 - p.getY(i) * 0.9));

  const tufts: [number, number][] = [];
  const rand = rng(0.2831);
  for (let i = 0; i < TUFTS_DUNE; i++) {
    const x = -30 + rand() * 60;
    tufts.push([x, shoreZ(x) + 16 + rand() * 7]);
  }

  const mesh = new THREE.InstancedMesh(blade, propMaterial(0.42, 0.34, 0.3, 0.1), tufts.length * BLADES);
  const dummy = new THREE.Object3D();
  dummy.rotation.order = 'YXZ';
  let n = 0;
  for (const [tx, tz] of tufts) {
    const size = 1.2 + rand() * 0.8;
    for (let b = 0; b < BLADES; b++) {
      const a = rand() * Math.PI * 2;
      const rr = rand() * 0.22;
      const bx = tx + Math.cos(a) * rr;
      const bz = tz + Math.sin(a) * rr;
      dummy.position.set(bx, sandHeight(bx, bz) - 0.03, bz);
      dummy.rotation.set(0.15 + rand() * 0.45, a, 0);
      const h = (0.35 + rand() * 0.45) * size;
      dummy.scale.set(1, h, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(n++, dummy.matrix);
    }
  }
  // 株は浜じゅうに散っているので、1 枚の葉の大きさで画面外と判定させない
  mesh.frustumCulled = false;
  root.add(mesh);
}

/** カモメ 1 羽。胴と、付け根と先の 2 節に分けた翼（先を下げて M 字に見せる）。 */
interface Gull {
  body: THREE.Group;
  inner: THREE.Object3D[];
  outer: THREE.Object3D[];
}
let gulls: Gull[] = [];

function buildGulls(root: THREE.Group): void {
  const mat = new THREE.MeshBasicMaterial({ color: emberColor(0.3, 0, -0.2), side: THREE.DoubleSide });
  const bodyGeo = new THREE.SphereGeometry(0.1, 8, 6);
  bodyGeo.scale(0.8, 0.7, 3.2);
  const wingGeo = (w: number, root0: number, tip: number): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry();
    // 付け根 (x=0) から先 (x=w) へ。前縁は直線、後縁を細らせる
    g.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, -root0 * 0.4, w, 0, -tip * 0.3, w, 0, tip * 0.7, 0, 0, root0 * 0.6], 3),
    );
    g.setIndex([0, 1, 2, 0, 2, 3]);
    return g;
  };
  // 遠目でも翼が途切れて見えないよう、付け根側は幅を持たせる
  const innerGeo = wingGeo(0.42, 0.3, 0.25);
  const outerGeo = wingGeo(0.4, 0.25, 0.06);

  gulls = GULLS.map(() => {
    const body = new THREE.Group();
    body.rotation.order = 'YXZ';
    body.scale.setScalar(GULL_SCALE);
    body.add(new THREE.Mesh(bodyGeo, mat));
    const inner: THREE.Object3D[] = [];
    const outer: THREE.Object3D[] = [];
    for (const side of [1, -1]) {
      const a = new THREE.Group();
      a.scale.x = side;
      const iw = new THREE.Mesh(innerGeo, mat);
      const b = new THREE.Group();
      b.position.x = 0.42;
      b.add(new THREE.Mesh(outerGeo, mat));
      iw.add(b);
      a.add(iw);
      body.add(a);
      inner.push(iw);
      outer.push(b);
    }
    root.add(body);
    return { body, inner, outer };
  });
}

/**
 * 海から吹く風に向かって空に留まり、ゆっくり横へ漂う。ときどき数回だけ羽ばたく。
 * 旋回させると、真横を向いた瞬間に翼が奥行きに潰れて鳥に見えなくなるので、
 * 機首はいつも沖へ向けたまま、わずかに振るだけにする。
 */
function updateGulls(t: number): void {
  gulls.forEach((g, i) => {
    const [cx, cy, cz, drift, w, ph] = GULLS[i];
    const a = ph + t * w * Math.PI * 2;
    g.body.position.set(
      cx + Math.sin(a) * drift,
      cy + Math.sin(t * 0.3 + ph) * 0.6,
      cz + Math.sin(a * 0.7 + 1.3) * drift * 0.5,
    );
    // 漂う向きへ少しだけ機首を振り、その側へ傾ける
    const yaw = -Math.cos(a) * 0.3;
    g.body.rotation.y = yaw;
    g.body.rotation.z = yaw * 0.8;
    const burst = smoothstep(0.55, 0.95, Math.sin(t * 0.35 + ph * 1.7));
    const flap = Math.sin(t * 6.5 + ph) * 0.55 * burst;
    for (let k = 0; k < 2; k++) {
      g.inner[k].rotation.z = 0.28 + flap;
      g.outer[k].rotation.z = -0.5 - flap * 0.5;
    }
  });
}

/** 平面を XZ に寝かせて置く。 */
function plane(w: number, d: number, sx: number, sz: number, x: number, z: number): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(w, d, sx, sz);
  g.rotateX(-Math.PI / 2);
  g.translate(x, 0, z);
  return g;
}

let tickBreak = ticker();
let tickRush = ticker();
let tickFizz = ticker();
let wave = 0;

export const sunsetCoast: SceneModule = {
  name: 'Sunset Coast',
  desc: '沈む夕日の砂浜。うねりが端から崩れて駆け上がり、引いたあとの濡れた砂が空を映して乾いていく。',
  camera: { pos: CAMERA_POS, target: CAMERA_TARGET },
  environment: 0,

  build(root) {
    tickBreak = ticker();
    tickRush = ticker();
    tickFizz = ticker();
    wave = 0;

    const [ax, az] = SUN_AZIMUTH;
    const h = Math.hypot(ax, az);
    uniforms.uSun.value
      .set((ax / h) * Math.cos(SUN_ELEVATION), Math.sin(SUN_ELEVATION), (az / h) * Math.cos(SUN_ELEVATION))
      .normalize();
    bakeLut(0);

    // 空。奥行きを書かない大きな球の内側に、方向だけで決まる色を塗る
    const dome = new THREE.Mesh(new THREE.SphereGeometry(320, 48, 24), material(SKY_FRAG, 0, THREE.BackSide));
    dome.renderOrder = -1;
    root.add(dome);

    // 海。近景だけ細かく割って波の高さへ持ち上げ、遠景は平らな板に画素の法線だけで波を描く
    const seaMat = material(SEA_FRAG, 1);
    root.add(new THREE.Mesh(plane(80, 44, 220, 150, 0, -19), seaMat));
    root.add(new THREE.Mesh(plane(520, 220, 8, 8, 0, -151), seaMat));
    root.add(new THREE.Mesh(plane(220, 44, 8, 8, -150, -19), seaMat));
    root.add(new THREE.Mesh(plane(220, 44, 8, 8, 150, -19), seaMat));

    // 砂浜。浅瀬の下から陸の奥まで 1 枚
    root.add(new THREE.Mesh(plane(520, 230, 260, 115, 0, 109), material(SAND_FRAG, -1)));

    // 浜の小道具
    buildLog(root);
    buildRocks(root);
    buildGrass(root);
    buildGulls(root);
    updateGulls(0);
  },

  update(t) {
    uniforms.uTime.value = t;
    bakeLut(t);
    updateGulls(t);
  },

  sound(t, _dt, sfx) {
    // 崩れる瞬間（汀線に届く約 3 秒前）の低い砕け音
    for (let n = tickBreak((t + (-0.5 - BREAK_Z) / CREST_C) / WAVE_T); n > 0; n--) {
      wave++;
      const big = 0.75 + 0.25 * Math.sin(wave * 0.5236) ** 2;
      sfx.air({ freq: 230, q: 0.5, gain: 0.34 * big, decay: 3.6, sweep: 0.55, pan: Math.sin(wave * 1.7) * 0.25 });
    }
    // 水の膜が砂を駆け上がるざわめき
    for (let n = tickRush(t / WAVE_T); n > 0; n--) {
      sfx.air({ freq: 850, q: 0.6, gain: 0.18, decay: RUN_UP + 0.6, sweep: 1.7 });
    }
    // 引き波の泡がはじける細かい音
    for (let n = tickFizz((t - RUN_UP) / WAVE_T); n > 0; n--) {
      sfx.air({ freq: 2600, q: 1.2, gain: 0.08, decay: RUN_DOWN, sweep: 0.5 });
    }
  },
};
