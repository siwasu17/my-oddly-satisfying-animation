import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * 夜の池と錦鯉。
 *
 * このシーンの主役は魚ではなく水面で、他のシーンのように形を CPU で作らず、
 * 「ある点の水面の高さと傾きを返す 1 つの式」をシェーダへ差し込んでいる。
 * その式を
 *   水面   … 頂点をその高さへ持ち上げ、画素ごとに傾きから法線を作る
 *   水底   … その式の 2 階微分から集光模様を描く
 *   浮き葉 … 葉の頂点をその高さに乗せる
 * の 3 つが共有するので、波・波紋・集光・葉の揺れは決してずれない。
 *
 * 水面はガラスと同じ透過（transmission）材で、屈折率は水の 1.333。
 * 鯉が水越しにゆがんで見えるのはそのため。
 */

/** 水面の半径と水深。 */
const POND_R = 13;
const DEPTH = 3.2;
/** 岸の波が立たなくなる幅。この幅の中で波の振幅を 0 へ落とす。 */
const SHORE = 3.5;

/** 錦鯉の数 */
const KOI = 9;
/** 同時に走らせる波紋の数。使い切ったら古いものから上書きする。 */
const RIPPLES = 8;
/** 波紋が広がる速さ（単位/秒）と、消えるまでの秒数。 */
const RIPPLE_SPEED = 2.1;
const RIPPLE_LIFE = 7;

/**
 * さざ波。[進む向き(rad), 波長, 振幅]。
 *
 * 速さは指定しない。深い水の波は波長が長いほど速く進む（ω=√(gk)）ので、
 * 波長から角速度を計算している。大きなうねりはゆっくり、細かい波は速く
 * 走るというだけで、水面の動きは一気に水らしくなる。
 */
const WAVES: readonly (readonly [number, number, number])[] = [
  [0.35, 13.5, 0.088],
  [2.1, 9.2, 0.064],
  [-1.2, 5.4, 0.044],
  [3.0, 3.3, 0.024],
  [0.15, 2.4, 0.015],
  [1.35, 1.7, 0.0085],
  [2.45, 1.15, 0.0045],
  [0.85, 0.8, 0.0022],
];
/** 分散関係で使う重力の代わり。小さくするほど水面全体がゆったりする。 */
const GRAVITY = 2.4;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number): number => x * x * (3 - 2 * x);

/** 毎回同じ池になるよう、固定の漸化式で散らす。 */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 0.49297) % 1;
    return s;
  };
}

// ---------------------------------------------------------------------------
// 水面の式（シェーダへ差し込む共通部分）
// ---------------------------------------------------------------------------

/**
 * 高さ・傾き・ラプラシアンをまとめて返す関数。
 *
 * 有限差分ではなく式のまま微分しているので、1 回の呼び出しで法線まで求まる。
 * 頂点シェーダでも画素シェーダでも同じものを呼ぶため、水面の細かい揺らぎは
 * 頂点の粗さに縛られない。
 */
const WAVE_GLSL = /* glsl */ `
#define RIPPLE_K 2.4   // 波紋の細かさ（波数）

uniform float uTime;
uniform float uPondR;
uniform vec4 uWaves[${WAVES.length}];   // xy = 進む向き * 波数, z = 角速度, w = 振幅
uniform vec4 uRipples[${RIPPLES}];      // xy = 中心, z = 生まれた時刻, w = 強さ
varying vec3 vPondPos;

/** 岸際では波を寝かせる。ここを削らないと、水面が石の上へせり上がる。 */
float shore(vec2 p) {
  return 1.0 - smoothstep(uPondR - ${SHORE.toFixed(1)}, uPondR, length(p));
}

/** 高さと傾き。x = 高さ、yz = ∂h/∂x と ∂h/∂z。 */
vec3 waveField(vec2 p, float time) {
  vec3 f = vec3(0.0);

  for (int i = 0; i < ${WAVES.length}; i++) {
    vec4 w = uWaves[i];
    float phase = dot(w.xy, p) + time * w.z;
    f.x += w.w * sin(phase);
    f.yz += w.w * cos(phase) * w.xy;
  }

  // 鯉が背を出したところから広がる波紋。波頭から離れるほど弱める。
  for (int i = 0; i < ${RIPPLES}; i++) {
    vec4 r = uRipples[i];
    float age = time - r.z;
    if (age >= 0.0 && age < ${RIPPLE_LIFE.toFixed(1)}) {
      vec2 d = p - r.xy;
      float dist = max(length(d), 1e-3);
      float band = dist - age * ${RIPPLE_SPEED.toFixed(2)};
      float env = exp(-band * band * 0.2) * exp(-age * 0.42) * r.w;
      f.x += sin(band * RIPPLE_K) * env;
      f.yz +=
        (RIPPLE_K * cos(band * RIPPLE_K) - 0.4 * band * sin(band * RIPPLE_K)) * env * d / dist;
    }
  }

  return f * shore(p);
}

/**
 * 曲がり具合（2 階微分）。x = ∂²h/∂x²、y = ∂²h/∂z²、z = ∂²h/∂x∂z。
 * 水底の集光模様だけが使う。波紋は進む向きの平面波とみなして近似している。
 */
vec3 waveCurve(vec2 p, float time) {
  vec3 c = vec3(0.0);

  for (int i = 0; i < ${WAVES.length}; i++) {
    vec4 w = uWaves[i];
    float h = -w.w * sin(dot(w.xy, p) + time * w.z);
    c += h * vec3(w.x * w.x, w.y * w.y, w.x * w.y);
  }

  for (int i = 0; i < ${RIPPLES}; i++) {
    vec4 r = uRipples[i];
    float age = time - r.z;
    if (age >= 0.0 && age < ${RIPPLE_LIFE.toFixed(1)}) {
      vec2 d = p - r.xy;
      float dist = max(length(d), 1e-3);
      float band = dist - age * ${RIPPLE_SPEED.toFixed(2)};
      float env = exp(-band * band * 0.2) * exp(-age * 0.42) * r.w;
      float h = -RIPPLE_K * RIPPLE_K * sin(band * RIPPLE_K) * env;
      vec2 u = d / dist;
      c += h * vec3(u.x * u.x, u.y * u.y, u.x * u.y);
    }
  }

  return c * shore(p);
}
`;

/** 水面へ映り込む夜空。テクスチャは持たず、暖色の勾配と灯り 1 つで作る。 */
const SKY_GLSL = /* glsl */ `
uniform vec3 uSkyLow;
uniform vec3 uSkyHigh;
uniform vec3 uLanternDir;
uniform vec3 uLanternColor;

/** 灯り 1 つぶんの映り。鋭い芯と広い暈でできている。 */
float glint(vec3 dir, vec3 lamp, float strength) {
  float g = max(dot(dir, lamp), 0.0);
  return (pow(g, 300.0) * 3.6 + pow(g, 22.0) * 0.2) * strength;
}

vec3 skyLook(vec3 dir) {
  vec3 col = mix(uSkyLow, uSkyHigh, clamp(dir.y * 1.4, 0.0, 1.0));
  // 岸に灯りが 3 つ。さざ波が向きを変えるたびに、それぞれが砕けて粒になる。
  col += uLanternColor * glint(dir, uLanternDir, 1.0);
  col += uLanternColor * glint(dir, normalize(vec3(0.78, 0.26, -0.57)), 0.62);
  col += uLanternColor * glint(dir, normalize(vec3(-0.86, 0.2, 0.47)), 0.4);
  return col;
}
`;

/** 水面・水底・浮き葉で共有するユニフォーム。1 か所直せば全部が揃う。 */
let uniforms: {
  uTime: { value: number };
  uPondR: { value: number };
  uWaves: { value: Float32Array };
  uRipples: { value: Float32Array };
  uSkyLow: { value: THREE.Color };
  uSkyHigh: { value: THREE.Color };
  uLanternDir: { value: THREE.Vector3 };
  uLanternColor: { value: THREE.Color };
  uCausticColor: { value: THREE.Color };
  uFocus: { value: number };
};

function makeUniforms(): typeof uniforms {
  const waves = new Float32Array(WAVES.length * 4);
  WAVES.forEach(([dir, len, amp], i) => {
    const k = (Math.PI * 2) / len;
    waves[i * 4] = Math.cos(dir) * k;
    waves[i * 4 + 1] = Math.sin(dir) * k;
    waves[i * 4 + 2] = Math.sqrt(GRAVITY * k); // 深い水の分散関係
    waves[i * 4 + 3] = amp;
  });

  const ripples = new Float32Array(RIPPLES * 4);
  // まだ 1 つも起きていない状態にする（負の時刻なら寿命の外）
  for (let i = 0; i < RIPPLES; i++) ripples[i * 4 + 2] = -100;

  return {
    uTime: { value: 0 },
    uPondR: { value: POND_R },
    uWaves: { value: waves },
    uRipples: { value: ripples },
    uSkyLow: { value: emberColor(0.36).multiplyScalar(0.42) },
    uSkyHigh: { value: emberColor(0.05).multiplyScalar(0.5) },
    uLanternDir: { value: new THREE.Vector3(-0.28, 0.34, -0.9).normalize() },
    uLanternColor: { value: emberColor(0.9) },
    uCausticColor: { value: emberColor(0.9).multiplyScalar(1.15) },
    // 水面のたわみが底でどれだけ効くか。水深 × (1 - 1/屈折率)。
    uFocus: { value: DEPTH * (1 - 1 / 1.333) },
  };
}

/** 頂点を水面の高さへ持ち上げ、法線も同じ式から作る。 */
function displaceByWave(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${WAVE_GLSL}`)
    .replace(
      '#include <beginnormal_vertex>',
      /* glsl */ `
      #include <beginnormal_vertex>
      vec3 nWorld = (modelMatrix * vec4(position, 1.0)).xyz;
      vec3 nField = waveField(nWorld.xz, uTime);
      objectNormal = normalize(vec3(-nField.y, 1.0, -nField.z));
      `,
    )
    .replace(
      '#include <begin_vertex>',
      /* glsl */ `
      #include <begin_vertex>
      vPondPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      float lift = waveField(vPondPos.xz, uTime).x;
      transformed.y += lift;
      vPondPos.y += lift;
      `,
    );
}

// ---------------------------------------------------------------------------
// 錦鯉
// ---------------------------------------------------------------------------

/** 背骨と断面の分割数。1 匹あたり (RINGS+1)*(RADIALS+1) 頂点。 */
const RINGS = 30;
const RADIALS = 12;
const VERTS = (RINGS + 1) * (RADIALS + 1);

/** 背骨をさかのぼるときの刻み（秒）と、拾うサンプル数。 */
const TRAIL_STEP = 0.08;
const TRAIL = 48;

/** 尾を振る速さ（Hz）と、体長に対する振れ幅。 */
const WAG_RATE = 0.62;
const WAG_AMP = 0.05;
/** 体に乗るうねりの波数。1 未満なので、体には山が 1 つも入りきらない。 */
const WAG_WAVES = 0.75;

/**
 * 体の断面。体長を 1 としたときの [横幅の半分, 高さの半分] を返す。
 *
 * u = 0.74 から先は横幅を潰しつつ高さを広げるだけで、胴が尾びれへ化ける。
 * びれを別のメッシュにしないので、体と尾のつなぎ目が割れない。
 */
function section(u: number): [number, number] {
  const girth = Math.pow(Math.sin(Math.PI * Math.pow(u, 0.55)), 0.8);
  const tail = smooth(clamp01((u - 0.74) / 0.26));
  return [
    0.075 * girth * (1 - tail) + 0.008 * tail,
    0.115 * girth * (1 - tail) + (0.035 + 0.1 * tail) * tail,
  ];
}

/** 背びれの高さ。断面の真上の頂点だけを持ち上げて稜にする。 */
const dorsal = (u: number): number =>
  Math.pow(Math.sin(Math.PI * clamp01((u - 0.28) / 0.42)), 0.6) * 0.05;

/** 尾びれの切れ込み。上下の先ほど後ろへ伸ばすと二又になる。 */
const fork = (u: number): number => smooth(clamp01((u - 0.8) / 0.2)) * 0.09;

interface Koi {
  geo: THREE.BufferGeometry;
  pos: THREE.BufferAttribute;
  len: number;
  /** 泳ぐ道。2 つの円を足し合わせた花びら形。 */
  r1: number;
  a1: number;
  p1: number;
  r2: number;
  a2: number;
  p2: number;
  /** ふだんの深さと、上下のゆらぎの位相 */
  depth: number;
  bob: number;
  wag: number;
  /** 水面へ背を出す周期とその位相 */
  risePeriod: number;
  riseOffset: number;
}

/** 背を出している割合（0..1）。1 周のうち RISE_SPAN の間だけ浮く。 */
const RISE_SPAN = 0.16;
function rise(k: Koi, s: number): number {
  const p = ((s / k.risePeriod + k.riseOffset) % 1 + 1) % 1;
  if (p > RISE_SPAN) return 0;
  return Math.pow(Math.sin((p / RISE_SPAN) * Math.PI), 2);
}

/** 時刻 s に頭がいた場所。体はここをさかのぼって作る。 */
function pathAt(k: Koi, s: number, out: THREE.Vector3): THREE.Vector3 {
  const t1 = k.a1 * s + k.p1;
  const t2 = k.a2 * s + k.p2;
  return out.set(
    k.r1 * Math.cos(t1) + k.r2 * Math.cos(t2),
    -k.depth + 0.32 * Math.sin(s * 0.27 + k.bob) + rise(k, s) * (k.depth - 0.55),
    k.r1 * Math.sin(t1) + k.r2 * Math.sin(t2),
  );
}

/** 1 匹ぶんの体を作る。位置は毎フレーム書き換えるので、ここでは色と面だけ決める。 */
function koiGeometry(rand: () => number): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(VERTS * 3), 3));

  // 紅白の模様。白地にいくつか斑を落とし、腹は白く抜く。
  const spots = 3 + Math.floor(rand() * 3);
  const su: number[] = [];
  const sa: number[] = [];
  const sr: number[] = [];
  const sv: number[] = [];
  for (let s = 0; s < spots; s++) {
    su.push(0.08 + rand() * 0.72);
    sa.push(rand() * Math.PI * 2);
    sr.push(0.1 + rand() * 0.16);
    sv.push(rand() < 0.4 ? 0.24 : 0.44);
  }
  const base = 0.8 + rand() * 0.12;
  const shift = (rand() - 0.5) * 0.03;

  const col = new Float32Array(VERTS * 3);
  const c = new THREE.Color();
  for (let i = 0; i <= RINGS; i++) {
    const u = i / RINGS;
    for (let j = 0; j <= RADIALS; j++) {
      const a = (j / RADIALS) * Math.PI * 2;
      let v = base;
      for (let s = 0; s < spots; s++) {
        let da = Math.abs(a - sa[s]!);
        if (da > Math.PI) da = Math.PI * 2 - da;
        const d = Math.hypot(u - su[s]!, (da / (Math.PI * 2)) * 1.6) / sr[s]!;
        v += (sv[s]! - v) * Math.exp(-d * d);
      }
      v += 0.08 * clamp01(-Math.sin(a)); // 腹は白く
      ember(c, clamp01(v), shift);
      const n = (i * (RADIALS + 1) + j) * 3;
      col[n] = c.r;
      col[n + 1] = c.g;
      col[n + 2] = c.b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

  const idx: number[] = [];
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < RADIALS; j++) {
      const a = i * (RADIALS + 1) + j;
      const b = a + RADIALS + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  geo.setIndex(idx);
  return geo;
}

// ---------------------------------------------------------------------------

const koi: Koi[] = [];
let fins: THREE.InstancedMesh;
let pads: THREE.Mesh[] = [];
let ripplePtr = 0;

/** 背骨をさかのぼって拾った [x, y, z, 頭からの距離] */
const trail = new Float32Array(TRAIL * 4);
/** 各節の中心と、そこでの向き */
const spine = new Float32Array((RINGS + 1) * 3);
const dirs = new Float32Array((RINGS + 1) * 3);

const vA = new THREE.Vector3();
const vB = new THREE.Vector3();
const vC = new THREE.Vector3();
const vRight = new THREE.Vector3();
const vUp = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const dummy = new THREE.Object3D();
const basis = new THREE.Matrix4();
const vSide = new THREE.Vector3();
const vBack = new THREE.Vector3();
const color = new THREE.Color();

let ticks = { rise: tickers(KOI), breeze: ticker() };

/** 頭からの距離 d の位置を trail から拾う。 */
function trailAt(used: number, d: number, out: THREE.Vector3): void {
  let i = 1;
  while (i < used - 1 && trail[i * 4 + 3]! < d) i++;
  const d0 = trail[(i - 1) * 4 + 3]!;
  const d1 = trail[i * 4 + 3]!;
  const f = d1 > d0 ? clamp01((d - d0) / (d1 - d0)) : 0;
  out.set(
    trail[(i - 1) * 4]! + (trail[i * 4]! - trail[(i - 1) * 4]!) * f,
    trail[(i - 1) * 4 + 1]! + (trail[i * 4 + 1]! - trail[(i - 1) * 4 + 1]!) * f,
    trail[(i - 1) * 4 + 2]! + (trail[i * 4 + 2]! - trail[(i - 1) * 4 + 2]!) * f,
  );
}

/** 節の並びから、各節での進行方向を取り直す。 */
function retrace(): void {
  for (let i = 0; i <= RINGS; i++) {
    const a = Math.max(i - 1, 0) * 3;
    const b = Math.min(i + 1, RINGS) * 3;
    vA.set(spine[a]! - spine[b]!, spine[a + 1]! - spine[b + 1]!, spine[a + 2]! - spine[b + 2]!);
    if (vA.lengthSq() < 1e-8) vA.set(1, 0, 0);
    vA.normalize();
    dirs[i * 3] = vA.x;
    dirs[i * 3 + 1] = vA.y;
    dirs[i * 3 + 2] = vA.z;
  }
}

/** 1 匹ぶんの体を、いまの時刻の形に書き換える。 */
function swim(k: Koi, t: number, index: number): void {
  // 頭がたどってきた道を体長ぶんさかのぼる。時間で等分すると速さのむらで
  // 体が伸び縮みするので、距離を積みながら拾う。
  pathAt(k, t, vA);
  trail[0] = vA.x;
  trail[1] = vA.y;
  trail[2] = vA.z;
  trail[3] = 0;
  vB.copy(vA);
  let dist = 0;
  let used = 1;
  for (let n = 1; n < TRAIL; n++) {
    pathAt(k, t - n * TRAIL_STEP, vA);
    dist += vA.distanceTo(vB);
    trail[n * 4] = vA.x;
    trail[n * 4 + 1] = vA.y;
    trail[n * 4 + 2] = vA.z;
    trail[n * 4 + 3] = dist;
    vB.copy(vA);
    used = n + 1;
    if (dist > k.len) break;
  }

  for (let i = 0; i <= RINGS; i++) {
    trailAt(used, (i / RINGS) * k.len, vA);
    spine[i * 3] = vA.x;
    spine[i * 3 + 1] = vA.y;
    spine[i * 3 + 2] = vA.z;
  }
  retrace();

  // 尾を振る。頭から尾へ進む波なので、位相は u が増えるほど遅れる。
  for (let i = 0; i <= RINGS; i++) {
    const u = i / RINGS;
    vA.set(dirs[i * 3]!, dirs[i * 3 + 1]!, dirs[i * 3 + 2]!);
    vRight.crossVectors(UP, vA).normalize();
    const swing =
      k.len *
      WAG_AMP *
      u *
      u *
      Math.sin(Math.PI * 2 * (WAG_WAVES * u - WAG_RATE * t) + k.wag);
    spine[i * 3] += vRight.x * swing;
    spine[i * 3 + 2] += vRight.z * swing;
  }
  retrace(); // 振った後の形で向きを取り直す

  const pos = k.pos;
  for (let i = 0; i <= RINGS; i++) {
    const u = i / RINGS;
    const [hw, hh] = section(u);
    const ridge = dorsal(u);
    const back = fork(u) * k.len;
    vC.set(spine[i * 3]!, spine[i * 3 + 1]!, spine[i * 3 + 2]!);
    vA.set(dirs[i * 3]!, dirs[i * 3 + 1]!, dirs[i * 3 + 2]!);
    vRight.crossVectors(UP, vA).normalize();
    vUp.crossVectors(vA, vRight);

    for (let j = 0; j <= RADIALS; j++) {
      const a = (j / RADIALS) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      // 背の 1 点だけを持ち上げて背びれの稜にする
      const h = (hh + ridge * Math.pow(Math.max(sa, 0), 14)) * k.len;
      const w = hw * k.len;
      const n = i * (RADIALS + 1) + j;
      pos.setXYZ(
        n,
        vC.x + vRight.x * ca * w + vUp.x * sa * h - vA.x * back * Math.abs(sa),
        vC.y + vRight.y * ca * w + vUp.y * sa * h - vA.y * back * Math.abs(sa),
        vC.z + vRight.z * ca * w + vUp.z * sa * h - vA.z * back * Math.abs(sa),
      );
    }
  }
  pos.needsUpdate = true;
  k.geo.computeVertexNormals();

  // 胸びれ。u=0.3 の節に貼り付けて、ゆっくり漕がせる。
  const ring = Math.round(RINGS * 0.3);
  vC.set(spine[ring * 3]!, spine[ring * 3 + 1]!, spine[ring * 3 + 2]!);
  vA.set(dirs[ring * 3]!, dirs[ring * 3 + 1]!, dirs[ring * 3 + 2]!);
  vRight.crossVectors(UP, vA).normalize();
  vUp.crossVectors(vA, vRight);
  const [fw] = section(0.3);
  const row = Math.sin(t * 2.1 + k.wag) * 0.3;
  for (let s = 0; s < 2; s++) {
    const side = s === 0 ? 1 : -1;
    dummy.position
      .copy(vC)
      .addScaledVector(vRight, side * fw * k.len * 0.85)
      .addScaledVector(vUp, -0.02 * k.len);
    dummy.scale.set(k.len * 0.13, k.len * 0.055, 1);
    vBack.copy(vA).negate();
    vSide.copy(vRight).multiplyScalar(side);
    dummy.quaternion.setFromRotationMatrix(basis.makeBasis(vBack, vUp, vSide));
    dummy.rotateY(side * (0.5 + row));
    dummy.updateMatrix();
    fins.setMatrixAt(index * 2 + s, dummy.matrix);
  }
}

/** 水面へ波紋を 1 つ落とす。古い枠から順に使い回す。 */
function addRipple(x: number, z: number, t: number, amp: number): void {
  const i = ripplePtr % RIPPLES;
  ripplePtr++;
  const r = uniforms.uRipples.value;
  r[i * 4] = x;
  r[i * 4 + 1] = z;
  r[i * 4 + 2] = t;
  r[i * 4 + 3] = amp;
}

/** 夜の池。錦鯉が水底の光を横切り、背を出しては波紋を残していく。 */
export const koiPond: SceneModule = {
  name: 'Koi Pond',
  desc: '夜の池を錦鯉がゆっくり回り、水面に灯りと波紋だけが残る。',
  camera: { pos: [0, 10.5, 19.5], target: [0, -0.6, 0] },

  build(root) {
    ticks = { rise: tickers(KOI), breeze: ticker() };
    uniforms = makeUniforms();
    ripplePtr = 0;
    koi.length = 0;
    pads = [];

    const rand = rng(0.4271);

    // --- 水面 -------------------------------------------------------------
    // 板は四角いまま作り、池の外は画素シェーダで捨てる。切り口は岸の石で隠す。
    const waterGeo = new THREE.PlaneGeometry(POND_R * 2, POND_R * 2, 180, 180);
    waterGeo.rotateX(-Math.PI / 2);
    const waterMat = new THREE.MeshPhysicalMaterial({
      color: emberColor(0.04),
      // つるつるに磨くと、共通ライトの照り返しが波の筋に沿って並んでしまう。
      // 少し荒らして散らし、輝きは自前の映り込み（skyLook）に受け持たせる。
      roughness: 0.24,
      metalness: 0,
      specularIntensity: 0.22,
      transmission: 1,
      ior: 1.333, // 水
      thickness: 1.8,
      attenuationColor: emberColor(0.34),
      attenuationDistance: 8,
    });
    waterMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      displaceByWave(shader);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${WAVE_GLSL}\n${SKY_GLSL}`)
        .replace(
          '#include <clipping_planes_fragment>',
          /* glsl */ `
          #include <clipping_planes_fragment>
          if (length(vPondPos.xz) > uPondR) discard;
          `,
        )
        .replace(
          '#include <normal_fragment_begin>',
          /* glsl */ `
          #include <normal_fragment_begin>
          // 法線は頂点の粗さに縛らず、画素ごとに式から作り直す。
          // 細かいさざ波が消えないので、灯りが粒に割れて水面らしくなる。
          vec3 wf = waveField(vPondPos.xz, uTime);
          vec3 waterNormal = normalize(vec3(-wf.y, 1.0, -wf.z));
          normal = normalize((viewMatrix * vec4(waterNormal, 0.0)).xyz);
          `,
        )
        .replace(
          '#include <opaque_fragment>',
          /* glsl */ `
          // 映り込み。浅い角度ほど強く映る（フレネル）ので、遠くは空、
          // 手前は水底が透ける。屈折そのものは transmission が受け持つ。
          vec3 view = normalize(vPondPos - cameraPosition);
          float fres = pow(1.0 - clamp(dot(-view, waterNormal), 0.0, 1.0), 5.0);
          outgoingLight += skyLook(reflect(view, waterNormal)) * (0.03 + 0.97 * fres);
          #include <opaque_fragment>
          `,
        );
    };
    root.add(new THREE.Mesh(waterGeo, waterMat));

    // --- 水底 -------------------------------------------------------------
    const floorGeo = new THREE.CircleGeometry(POND_R + 0.8, 96);
    floorGeo.rotateX(-Math.PI / 2);
    const floorMat = new THREE.MeshStandardMaterial({
      color: SURFACE,
      roughness: 0.95,
      metalness: 0.05,
    });
    floorMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${WAVE_GLSL}`)
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvPondPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>\n${WAVE_GLSL}\nuniform vec3 uCausticColor;\nuniform float uFocus;`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          /* glsl */ `
          #include <emissivemap_fragment>
          // 集光模様。水面のたわみで屈折した光は、底に着くまでに束ねられたり
          // 散らされたりする。その面積の変わりぶん（ヤコビアン）の逆数が明るさで、
          // 潰れて 0 に近づくところだけが細い筋になって光る。
          // 光は斜めに差すので、真上ではなく少しずらした水面を見に行く。
          vec3 hess = waveCurve(vPondPos.xz + vec2(1.3, 0.9), uTime);
          float sq = uFocus * uFocus;
          float area = (1.0 + uFocus * hess.x) * (1.0 + uFocus * hess.y) - sq * hess.z * hess.z;
          float caustic = 1.0 / max(abs(area), 0.05);
          totalEmissiveRadiance += uCausticColor * min(pow(max(caustic - 0.85, 0.0), 1.2), 6.0);
          `,
        );
    };
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.position.y = -DEPTH;
    root.add(floor);

    // 水底の小石。屈折は下に模様が無いと見えないので、ゆがむ相手を置いておく。
    const pebbleMat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.1 });
    const pebbles = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), pebbleMat, 90);
    for (let i = 0; i < 90; i++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * (POND_R - 1);
      const s = 0.16 + rand() * 0.3;
      dummy.position.set(Math.cos(a) * r, -DEPTH + s * 0.4, Math.sin(a) * r);
      dummy.rotation.set(rand() * 3, rand() * 3, rand() * 3);
      dummy.scale.set(s, s * 0.55, s * (0.8 + rand() * 0.5));
      dummy.updateMatrix();
      pebbles.setMatrixAt(i, dummy.matrix);
      pebbles.setColorAt(i, ember(color, 0.09 + rand() * 0.12, (rand() - 0.5) * 0.03));
    }
    root.add(pebbles);

    // --- 岸 ---------------------------------------------------------------
    const bank = new THREE.Mesh(
      new THREE.RingGeometry(POND_R - 0.3, POND_R + 13, 96, 1),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.95, metalness: 0.1 }),
    );
    bank.rotation.x = -Math.PI / 2;
    bank.position.y = 0.05;
    root.add(bank);

    const stoneMat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.15 });
    const STONES = 64;
    const stones = new THREE.InstancedMesh(
      new THREE.DodecahedronGeometry(1, 0),
      stoneMat,
      STONES,
    );
    for (let i = 0; i < STONES; i++) {
      const a = (i / STONES) * Math.PI * 2 + rand() * 0.05;
      const r = POND_R + 0.1 + rand() * 0.5;
      const s = 0.5 + rand() * 0.55;
      dummy.position.set(Math.cos(a) * r, s * 0.25, Math.sin(a) * r);
      dummy.rotation.set(rand() * 3, rand() * 3, rand() * 3);
      dummy.scale.set(s, s * (0.5 + rand() * 0.3), s * (0.8 + rand() * 0.4));
      dummy.updateMatrix();
      stones.setMatrixAt(i, dummy.matrix);
      stones.setColorAt(i, ember(color, 0.1 + rand() * 0.14, (rand() - 0.5) * 0.03));
    }
    root.add(stones);

    // --- 浮き葉 -----------------------------------------------------------
    // 水面と同じ式で持ち上げるので、葉は波に乗って傾き、たわむ。
    const padMat = new THREE.MeshStandardMaterial({
      color: emberColor(0.12, -0.02),
      roughness: 0.72,
      metalness: 0.12,
      side: THREE.DoubleSide,
    });
    padMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      displaceByWave(shader);
    };
    for (let i = 0; i < 8; i++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * (POND_R - 3);
      const rad = 0.5 + rand() * 0.42;
      // 切れ込みの向きは葉ごとに変える。板を回すと波の式とずれるので回さない。
      const geo = new THREE.CircleGeometry(rad, 26, rand() * Math.PI * 2, Math.PI * 2 - 0.34);
      geo.rotateX(-Math.PI / 2);
      // 縁を持ち上げて、皿のように反らせる
      const p = geo.attributes.position as THREE.BufferAttribute;
      for (let n = 0; n < p.count; n++) {
        const d = Math.hypot(p.getX(n), p.getZ(n)) / rad;
        p.setY(n, 0.06 + Math.pow(d, 3) * 0.16 * rad);
      }
      geo.computeVertexNormals();
      const pad = new THREE.Mesh(geo, padMat);
      pad.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      root.add(pad);
      pads.push(pad);
    }

    // --- 錦鯉 -------------------------------------------------------------
    const koiMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.44,
      metalness: 0.12,
      emissive: emberColor(0.15),
      side: THREE.DoubleSide, // 尾びれは紙のように薄い
    });
    for (let i = 0; i < KOI; i++) {
      const geo = koiGeometry(rand);
      const mesh = new THREE.Mesh(geo, koiMat);
      mesh.frustumCulled = false; // 頂点を毎フレーム動かすので判定を任せない
      root.add(mesh);
      const spin = rand() < 0.5 ? 1 : -1;
      koi.push({
        geo,
        pos: geo.attributes.position as THREE.BufferAttribute,
        len: 3.2 + rand() * 1.4,
        r1: 3.4 + rand() * 4.4,
        a1: spin * (0.1 + rand() * 0.055),
        p1: rand() * Math.PI * 2,
        r2: 1.1 + rand() * 1.2,
        a2: -spin * (0.15 + rand() * 0.12),
        p2: rand() * Math.PI * 2,
        depth: 0.62 + rand() * 1.05,
        bob: rand() * Math.PI * 2,
        wag: rand() * Math.PI * 2,
        risePeriod: 11 + rand() * 9,
        riseOffset: rand(),
      });
    }

    const finGeo = new THREE.CircleGeometry(1, 12);
    fins = new THREE.InstancedMesh(finGeo, koiMat.clone(), KOI * 2);
    (fins.material as THREE.MeshStandardMaterial).vertexColors = false;
    (fins.material as THREE.MeshStandardMaterial).color = emberColor(0.5);
    (fins.material as THREE.MeshStandardMaterial).transparent = true;
    (fins.material as THREE.MeshStandardMaterial).opacity = 0.55;
    fins.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    fins.frustumCulled = false;
    root.add(fins);

    // 水中の灯り。上からの光だけでは、水越しの鯉が沈んで見えない。
    const lampA = new THREE.PointLight(0xffb37a, 74, 26, 2);
    lampA.position.set(-7, -1.1, 5);
    root.add(lampA);
    const lampB = new THREE.PointLight(0xff8f6a, 56, 26, 2);
    lampB.position.set(8, -1.4, -6);
    root.add(lampB);
  },

  update(t) {
    const d = drift(t);
    uniforms.uTime.value = t;
    ember(uniforms.uLanternColor.value, 0.9, d);
    ember(uniforms.uCausticColor.value, 0.9, d).multiplyScalar(1.15);

    for (let i = 0; i < koi.length; i++) {
      const k = koi[i]!;
      swim(k, t, i);

      // 背が水面を割った瞬間に波紋を落とす。位置は頭のいまいる場所。
      const phase = t / k.risePeriod + k.riseOffset - RISE_SPAN * 0.5;
      for (let n = ticks.rise[i]!(phase); n > 0; n--) {
        pathAt(k, t, vA);
        addRipple(vA.x, vA.z, t, 0.075 + k.len * 0.012);
      }
    }
    fins.instanceMatrix.needsUpdate = true;

    // 葉はゆっくり向きを変える。上下はシェーダ側で波に乗せている。
    for (let i = 0; i < pads.length; i++) {
      pads[i]!.position.y = Math.sin(t * 0.11 + i) * 0.01;
    }
  },

  sound(t, _dt, sfx) {
    // 水底の低い響き。池そのものの音として鳴らし続ける。
    sfx.drone(tone(-3), 0.13 + 0.04 * Math.sin(t * 0.19));

    for (let i = 0; i < koi.length; i++) {
      const k = koi[i]!;
      const phase = t / k.risePeriod + k.riseOffset - RISE_SPAN * 0.5;
      for (let n = ticks.rise[i]!(phase); n > 0; n--) {
        pathAt(k, t, vA);
        sfx.drop(tone(6 + (i % 4)), {
          gain: 0.4,
          decay: 0.7,
          pan: vA.x / POND_R,
          bend: 0.5,
        });
      }
    }

    // ときどき水面を風が渡る
    for (let n = ticks.breeze(t / 9.3); n > 0; n--) {
      sfx.air({ gain: 0.26, decay: 3.6, freq: 520, q: 0.8, sweep: 0.6, pan: -0.4 });
    }
  },
};
