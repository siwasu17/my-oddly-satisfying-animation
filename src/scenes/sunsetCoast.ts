import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { ticker } from '../audio.ts';
import { ember, drift } from '../palette.ts';

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
 * スコープ外: 巻き波の筒（チューブ）、しぶきの粒、足跡や貝殻、潮の満ち引き。
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
  vec3 zen = lut(0.0) * 0.045;
  vec3 hor = mix(lut(0.16) * 0.12, lut(0.68) * 0.6, pow(toward, 7.0));
  return mix(zen, hor, exp(-y * mix(6.0, 11.0, toward)));
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
  h += 1.5 * smoothstep(24.0, 46.0, d) * (0.62 + 0.38 * sin(xz.x * 0.07 + 1.3));
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
vec3 sandAlbedo() {
  return lut(0.84) * 0.75;
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
  vec3 wetSand = sandAlbedo() * 0.4 * sandLight(vec3(0.0, 1.0, 0.0));
  vec3 deep = lut(0.05) * 0.035;
  vec3 body = mix(deep, wetSand, exp(-depth * 1.7));
  float back = pow(max(dot(-V, uSun), 0.0), 3.0);
  body += lut(0.64) * 0.9 * back * smoothstep(0.15, 0.75, crestLift) * clamp(dot(N, V) * 1.6, 0.0, 1.0);

  vec3 col = (mix(body, refl, F) + lut(1.0) * glint) * (1.0 - 0.5 * min(face, 1.0));
  // 泡は空の明かりで淡く、太陽の光の道の上だけ夕日に透けて明るい
  float path = pow(max(dot(-V, uSun), 0.0), 30.0);
  vec3 foamCol = lut(0.92) * (0.12 + 0.1 * N.y + 0.5 * path);
  col = mix(col, foamCol, foam);

  col = mix(col, hazeColor(-V), 1.0 - exp(-pow(dist / HAZE, 2.0)));
  gl_FragColor = vec4(col, 1.0);
  ${OUT}
}
`;

const SAND_FRAG = /* glsl */ `
${COMMON_GLSL}
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
  vec3 alb = sandAlbedo() * mix(1.0, 0.3, max(damp * 0.75, gloss));

  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 col = alb * sandLight(N);

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
  float shin = mix(160.0, 900.0, cover);
  col += lut(1.0) * pow(max(dot(R, uSun), 0.0), shin) * shin * 0.003 * mirror * ${f(SUN_GLINT)};
  // 濡れた面には、太陽の方角へ伸びる幅の広い照り返しの帯が立つ
  col += lut(0.9) * pow(max(dot(R, uSun), 0.0), 40.0) * 0.6 * mirror;

  vec3 foamCol = lut(0.9) * (0.2 + 0.16 * Nw.y);
  col = mix(col, foamCol, foam);

  col = mix(col, hazeColor(-V), 1.0 - exp(-pow(dist / HAZE, 2.0)));
  gl_FragColor = vec4(col, 1.0);
  ${OUT}
}
`;

// ---------------------------------------------------------------------------

const uniforms = {
  uTime: { value: 0 },
  uLut: { value: Array.from({ length: LUT_N }, () => new THREE.Color()) },
  uSun: { value: new THREE.Vector3() },
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
  },

  update(t) {
    uniforms.uTime.value = t;
    bakeLut(t);
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
