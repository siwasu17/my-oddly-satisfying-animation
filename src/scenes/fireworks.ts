import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * Fireworks。
 *
 * 川べりから見上げる、打ち上げ花火の一幕。尾を引いて昇った玉が頂点で割れ、
 * 星がきれいな球に開いて、空気に減速されながら重力で垂れて消える。
 * 型は 3 つ — 尾を引いて色が変わる「菊」、点で咲く「牡丹」、金色の尾が
 * 柳のように長く垂れて最後にちらちら瞬く「冠菊」。大玉には芯（内側の小さな球）が入る。
 * 番組は 38 秒で一巡する。単発 → 左右の対 → 冠菊 → 八重芯 → 小玉の速射 → 尺玉の締め。
 * 星と昇り曲導はすべて頂点シェーダで t から軌跡を組み立て、水面に鏡映しで揺れる。
 * 色は palette の ember を LUT に焼いて引くので、琥珀と薔薇の帯から出ない。
 * 音は昇る笛（air）、割れる音（低い drop）、冠菊の残り火のぱちぱち（小さな pluck）。
 */

// ---- 調整する数値はここにまとめる ----------------------------------------

/** 番組が一巡する秒数。最後の玉が消えきってから頭に戻る */
const PERIOD = 38;

/** 星の大きさ（px。カメラからの距離で割る） */
const STAR_PX = 330;
/** 昇り曲導の大きさ（px） */
const RISE_PX = 240;
/** 星全体の明るさの倍率。bloom（明度 0.28）で滲む量はほぼこれで決まる */
const STAR_GAIN = 1.8;
/** 水面に映る明るさ */
const MIRROR_GAIN = 0.22;
/** 水面の揺らぎで映り込みが横にぶれる量 */
const MIRROR_WOBBLE = 0.18;

/** 玉が開く大きさの倍率（全玉共通）。星の速さに掛ける */
const SPREAD = 1.15;

/** 昇る速さ。玉が頂点に着くまでの秒数 = RISE_BASE + 高さ * RISE_PER_H */
const RISE_BASE = 1.5;
const RISE_PER_H = 0.07;
/** 昇り曲導の尾のサンプル数と間隔（秒） */
const RISE_TAIL = 22;
const RISE_TAIL_DT = 0.028;

/** 水面の半径と、遠くの土手（稜線）の半径 */
const WATER_R = 220;
const RIDGE_R = 70;
/** 対岸の灯り。水平線の目印になる。半径・数・大きさ・明るさ */
const SHORE_R = 52;
const SHORE_N = 150;
const SHORE_PX = 130;
const SHORE_GAIN = 0.55;

/** 閃光で水面と土手を照らす点光源の強さ */
const FLASH_POWER = 220;

/** ember を焼き込む LUT の段数。シェーダ側の配列長と必ず揃える */
const LUT_N = 24;

// ---- 玉の型 ---------------------------------------------------------------

interface Kind {
  /** 星の数（芯は別に数える） */
  stars: number;
  /** 開く速さ。開いた球の半径はおよそ speed / drag */
  speed: number;
  /** 空気の抵抗。大きいほど早く止まって球の形を保つ */
  drag: number;
  /** 重力。止まったあとに垂れる速さはおよそ gravity / drag */
  gravity: number;
  /** 星の寿命（秒） */
  life: number;
  /** 尾のサンプル数と間隔（秒）。1 なら尾を引かない */
  tail: number;
  tailDt: number;
  /** 咲いた瞬間と消えぎわの色（LUT の 0..1） */
  lutA: number;
  lutB: number;
  /** 星の大きさの倍率 */
  size: number;
  /** 消えぎわの瞬き（0..1） */
  glitter: number;
}

const KINDS = {
  /** 菊。尾を引いて開き、琥珀から薔薇へ色が変わる */
  kiku: {
    stars: 300, speed: 8.2, drag: 1.55, gravity: 1.4, life: 2.9,
    tail: 8, tailDt: 0.04, lutA: 0.88, lutB: 0.5, size: 1.0, glitter: 0,
  },
  /** 牡丹。尾を引かず点で咲く */
  botan: {
    stars: 260, speed: 9.0, drag: 2.0, gravity: 0.9, life: 2.3,
    tail: 2, tailDt: 0.03, lutA: 0.62, lutB: 0.95, size: 1.25, glitter: 0,
  },
  /** 冠菊。金色の長い尾が柳のように垂れ、最後に瞬いて消える */
  kamuro: {
    stars: 230, speed: 6.8, drag: 1.1, gravity: 2.5, life: 6.2,
    tail: 13, tailDt: 0.06, lutA: 1.0, lutB: 0.82, size: 0.9, glitter: 1,
  },
  /** 小玉。速射に使う小さな牡丹 */
  small: {
    stars: 110, speed: 6.0, drag: 2.1, gravity: 0.9, life: 1.7,
    tail: 3, tailDt: 0.035, lutA: 0.9, lutB: 0.6, size: 0.9, glitter: 0,
  },
} satisfies Record<string, Kind>;

/** 芯。親玉の内側に小さく開く球 */
const PISTIL: Kind = {
  stars: 90, speed: 4.2, drag: 2.0, gravity: 1.0, life: 1.9,
  tail: 4, tailDt: 0.035, lutA: 0.55, lutB: 0.4, size: 0.95, glitter: 0,
};

interface Shell {
  /** 打ち上げの時刻（番組の頭からの秒） */
  at: number;
  x: number;
  z: number;
  /** 割れる高さ */
  h: number;
  kind: keyof typeof KINDS;
  /** 球の大きさの倍率 */
  scale: number;
  /** 芯の数（0 / 1 / 2 = 八重芯） */
  pistil: number;
}

/** 割れる高さの倍率（全玉共通）。映り込みが画面下の文字にかからない高さに収める */
const BURST_H = 0.85;

/** 番組。間を空けて、最後に向けて詰めていく */
const PROGRAM: Shell[] = ([
  { at: 0.3, x: 0, z: 0, h: 14, kind: 'kiku', scale: 1.0, pistil: 1 },
  { at: 4.2, x: -8, z: -3, h: 11, kind: 'botan', scale: 0.8, pistil: 0 },
  { at: 4.9, x: 8, z: -3, h: 11.5, kind: 'botan', scale: 0.8, pistil: 0 },
  { at: 8.6, x: 0, z: -2, h: 15, kind: 'kamuro', scale: 1.1, pistil: 0 },
  { at: 14.8, x: 1.5, z: 1, h: 16, kind: 'kiku', scale: 1.2, pistil: 2 },
  { at: 18.8, x: -10, z: 2, h: 8.5, kind: 'small', scale: 1, pistil: 0 },
  { at: 19.3, x: -4, z: 0, h: 9.5, kind: 'small', scale: 1, pistil: 0 },
  { at: 19.8, x: 3, z: 0, h: 9.0, kind: 'small', scale: 1, pistil: 0 },
  { at: 20.3, x: 10, z: 2, h: 10, kind: 'small', scale: 1, pistil: 0 },
  { at: 22.6, x: -6, z: -1, h: 12.5, kind: 'kiku', scale: 0.8, pistil: 0 },
  { at: 23.4, x: 6, z: -1, h: 13, kind: 'kiku', scale: 0.8, pistil: 0 },
  { at: 26.6, x: 0, z: -4, h: 15.5, kind: 'kamuro', scale: 1.3, pistil: 1 },
] as Shell[]).map((s) => ({ ...s, h: s.h * BURST_H }));

const riseTime = (h: number): number => RISE_BASE + h * RISE_PER_H;
/** 玉が割れる時刻 */
const burstAt = (s: Shell): number => s.at + riseTime(s.h);

// ---- シェーダから共有する状態 --------------------------------------------

const uTime = { value: 0 };
const uLut = { value: new Float32Array(LUT_N * 3) };
const uPixelRatio = { value: 1 };

const lutColor = new THREE.Color();

/** palette の ember を LUT に焼く。drift のゆらぎもここで乗る。 */
const refreshLut = (t: number): void => {
  const hue = drift(t);
  for (let i = 0; i < LUT_N; i++) {
    ember(lutColor, i / (LUT_N - 1), hue);
    lutColor.toArray(uLut.value, i * 3);
  }
};

/** LUT を n（0..1）で引く。GLSL ES 1.00 では uniform 配列を任意の添字で引けないので重みで足す。 */
const GLSL_LUT = /* glsl */ `
  uniform vec3 uLut[${LUT_N}];
  vec3 lut(float n) {
    float f = clamp(n, 0.0, 1.0) * float(${LUT_N - 1});
    vec3 c = vec3(0.0);
    for (int i = 0; i < ${LUT_N}; i++) {
      c += uLut[i] * max(0.0, 1.0 - abs(float(i) - f));
    }
    return c;
  }
`;

/** 鏡映し。水面（y = 0）で折り返し、波で横に揺らす */
const GLSL_MIRROR = /* glsl */ `
  uniform float uMirror;
  uniform float uWobble;
  vec3 mirror(vec3 p) {
    if (uMirror < 0.5) return p;
    float w = sin(p.y * 0.45 + uTime * 1.1) + 0.5 * sin(p.y * 0.9 - uTime * 1.6 + p.x * 0.3);
    return vec3(p.x + w * uWobble, -p.y, p.z);
  }
`;

const HIDE = /* glsl */ `
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  gl_PointSize = 0.0;
  vGlow = 0.0;
  vN = 0.0;
  return;
`;

// ---- 星 -------------------------------------------------------------------

/**
 * 星 1 粒 × 尾のサンプル数だけ頂点がある。尾は「少し前の時刻の自分」を描いているだけなので、
 * 星が減速すると尾も自然に縮む。
 */
const STAR_VERT = /* glsl */ `
  attribute vec4 aShell;  // 割れる時刻 / 割れる位置 xyz
  attribute vec4 aStar;   // 方向 xyz / 速さ
  attribute vec4 aPhys;   // 抵抗 / 重力 / 寿命 / 尾の遅れ（秒）
  attribute vec4 aLook;   // 咲いた色 / 消える色 / 大きさ / 瞬き
  attribute float aTailW; // 尾の中での明るさ（先頭 = 1）
  uniform float uTime;
  uniform float uPeriod;
  uniform float uSizePx;
  uniform float uPixelRatio;
  uniform float uGain;
  varying float vGlow;
  varying float vN;
  ${GLSL_MIRROR}

  float hash(float x) { return fract(sin(x * 91.345) * 47453.5453); }

  void main() {
    float life = aPhys.z;
    // 位相は t から作り直す。差分を積まないので、いつ開いても同じ絵になる
    float tau = mod(uTime - aShell.x, uPeriod) - aPhys.w;
    if (tau < 0.0 || tau > life) { ${HIDE} }

    float k = aPhys.x;
    float g = aPhys.y;
    // 速度に比例する空気抵抗の下での放物運動（閉じた式）
    float e = (1.0 - exp(-k * tau)) / k;
    vec3 p = aShell.yzw + aStar.xyz * aStar.w * e;
    p.y -= g / k * (tau - e);

    float u = tau / life;
    // 割れた瞬間の閃光 → 落ち着いた光 → 消えぎわ
    float flash = 1.0 + 1.1 * exp(-tau * 9.0);
    float fade = 1.0 - smoothstep(0.55, 1.0, u);
    float glow = flash * fade * aTailW;

    // 冠菊の瞬き。後半ほど強くちらつく
    float id = dot(aStar.xyz, vec3(12.9, 78.2, 37.7)) + aShell.x;
    float blink = step(0.45, hash(floor(uTime * 22.0) + id));
    glow *= mix(1.0, 0.15 + 1.1 * blink, aLook.w * smoothstep(0.3, 0.7, u));

    vN = mix(aLook.x, aLook.y, smoothstep(0.15, 0.85, u));
    vGlow = glow * uGain;

    vec4 mv = modelViewMatrix * vec4(mirror(p), 1.0);
    float size = aLook.z * (0.55 + 0.45 * aTailW) * (0.7 + 0.3 * fade);
    gl_PointSize = uSizePx * size * uPixelRatio / max(-mv.z, 0.1);
    gl_Position = projectionMatrix * mv;
  }
`;

/** 昇り曲導。頂点に向かって減速しながら昇り、細かく揺れる尾を引く */
const RISE_VERT = /* glsl */ `
  attribute vec4 aRise;   // 打ち上げ時刻 / x / 割れる高さ / z
  attribute vec4 aRj;     // 尾の遅れ（秒） / 昇る秒数 / 揺れの位相 / 尾の中での明るさ
  uniform float uTime;
  uniform float uPeriod;
  uniform float uSizePx;
  uniform float uPixelRatio;
  uniform float uGain;
  varying float vGlow;
  varying float vN;
  ${GLSL_MIRROR}

  void main() {
    float dur = aRj.y;
    float tau = mod(uTime - aRise.x, uPeriod) - aRj.x;
    if (tau < 0.0 || tau > dur) { ${HIDE} }

    float s = tau / dur;
    float y = aRise.z * (1.0 - (1.0 - s) * (1.0 - s));
    float sway = sin(tau * 13.0 + aRj.z) * 0.05 * (1.0 - s);
    vec3 p = vec3(aRise.y + sway, y, aRise.w);

    // 頂点の手前で火が細り、割れる直前に消える
    float fade = 1.0 - smoothstep(0.82, 1.0, s);
    float flick = 0.75 + 0.25 * sin(uTime * 40.0 + aRj.x * 300.0);
    vGlow = aRj.w * fade * flick * uGain;
    vN = 0.78 + 0.2 * aRj.w;

    vec4 mv = modelViewMatrix * vec4(mirror(p), 1.0);
    gl_PointSize = uSizePx * (0.35 + 0.65 * aRj.w) * uPixelRatio / max(-mv.z, 0.1);
    gl_Position = projectionMatrix * mv;
  }
`;

/** 対岸の灯り。動かない小さな灯がゆっくり揺らぐだけ */
const SHORE_VERT = /* glsl */ `
  attribute vec2 aL;      // 色 / 揺らぎの位相
  uniform float uTime;
  uniform float uSizePx;
  uniform float uPixelRatio;
  uniform float uGain;
  varying float vGlow;
  varying float vN;
  ${GLSL_MIRROR}

  void main() {
    vN = aL.x;
    vGlow = uGain * (0.8 + 0.2 * sin(uTime * 1.3 + aL.y));
    vec4 mv = modelViewMatrix * vec4(mirror(position), 1.0);
    gl_PointSize = uSizePx * uPixelRatio / max(-mv.z, 0.1);
    gl_Position = projectionMatrix * mv;
  }
`;

const SPARK_FRAG = /* glsl */ `
  ${GLSL_LUT}
  varying float vGlow;
  varying float vN;

  void main() {
    // 芯を残した丸い粒。二乗で締めると光の点に見える
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float disk = 1.0 - smoothstep(0.15, 1.0, d);
    disk *= disk;
    if (disk * vGlow <= 0.003) discard;
    gl_FragColor = vec4(lut(vN) * vGlow * disk, 1.0);
  }
`;

let seed = 0.6173;
/** 固定シードの乱数。Math.random() を使うと開き直すたびに絵が変わる。 */
const rnd = (): number => (seed = (seed * 9301 + 0.49297) % 1);

/** 星の頂点をまとめて作る。1 玉 = 本体 + 芯 */
const makeStarGeometry = (): THREE.BufferGeometry => {
  const shell: number[] = [];
  const star: number[] = [];
  const phys: number[] = [];
  const look: number[] = [];
  const tailW: number[] = [];

  const push = (s: Shell, k: Kind, speedMul: number): void => {
    const t0 = burstAt(s);
    // フィボナッチ球で均等に散らす。きれいな球に開くのが「本気」の玉
    const tilt = rnd() * Math.PI * 2;
    for (let i = 0; i < k.stars; i++) {
      const y = 1 - (2 * (i + 0.5)) / k.stars;
      const r = Math.sqrt(1 - y * y);
      const a = i * 2.39996323 + tilt;
      const jitter = 1 + (rnd() - 0.5) * 0.06;
      const dx = Math.cos(a) * r;
      const dz = Math.sin(a) * r;
      for (let j = 0; j < k.tail; j++) {
        shell.push(t0, s.x, s.h, s.z);
        star.push(dx, y, dz, k.speed * speedMul * SPREAD * jitter);
        phys.push(k.drag, k.gravity, k.life, j * k.tailDt);
        look.push(k.lutA, k.lutB, k.size, k.glitter);
        tailW.push(Math.pow(1 - j / k.tail, 1.5));
      }
    }
  };

  for (const s of PROGRAM) {
    push(s, KINDS[s.kind], s.scale);
    for (let p = 0; p < s.pistil; p++) push(s, PISTIL, s.scale * (p === 0 ? 1 : 0.55));
  }

  const n = tailW.length;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('aShell', new THREE.Float32BufferAttribute(shell, 4));
  geo.setAttribute('aStar', new THREE.Float32BufferAttribute(star, 4));
  geo.setAttribute('aPhys', new THREE.Float32BufferAttribute(phys, 4));
  geo.setAttribute('aLook', new THREE.Float32BufferAttribute(look, 4));
  geo.setAttribute('aTailW', new THREE.Float32BufferAttribute(tailW, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 60);
  return geo;
};

const makeRiseGeometry = (): THREE.BufferGeometry => {
  const rise: number[] = [];
  const rj: number[] = [];
  for (const s of PROGRAM) {
    const phase = rnd() * 6.28;
    for (let j = 0; j < RISE_TAIL; j++) {
      rise.push(s.at, s.x, s.h, s.z);
      rj.push(j * RISE_TAIL_DT, riseTime(s.h), phase, Math.pow(1 - j / RISE_TAIL, 1.8));
    }
  }
  const n = rj.length / 4;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('aRise', new THREE.Float32BufferAttribute(rise, 4));
  geo.setAttribute('aRj', new THREE.Float32BufferAttribute(rj, 4));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 60);
  return geo;
};

/** 対岸の灯り。いくつかの集落のように固まって並ぶ */
const makeShoreGeometry = (): THREE.BufferGeometry => {
  const pos: number[] = [];
  const l: number[] = [];
  let a = 0;
  for (let i = 0; i < SHORE_N; i++) {
    // たまに大きく飛ばして、灯りの無い暗い区間を作る
    a += rnd() < 0.08 ? 0.35 + rnd() * 0.5 : 0.012 + rnd() * 0.03;
    const r = SHORE_R + (rnd() - 0.5) * 3;
    pos.push(Math.cos(a) * r, 0.25 + rnd() * 0.5, Math.sin(a) * r);
    l.push(0.55 + rnd() * 0.3, rnd() * 6.28);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aL', new THREE.Float32BufferAttribute(l, 2));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), SHORE_R + 5);
  return geo;
};

const makeSparkMaterial = (
  vert: string,
  sizePx: number,
  mirror: boolean,
  gain = STAR_GAIN,
): THREE.ShaderMaterial =>
  new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: SPARK_FRAG,
    uniforms: {
      uTime,
      uLut,
      uPixelRatio,
      uPeriod: { value: PERIOD },
      uSizePx: { value: sizePx },
      uGain: { value: mirror ? gain * MIRROR_GAIN : gain },
      uMirror: { value: mirror ? 1 : 0 },
      uWobble: { value: MIRROR_WOBBLE },
    },
    transparent: true,
    depthWrite: false,
    // 映り込みは水面の下にあるので、水面の深度に消されないようにする
    depthTest: !mirror,
    blending: THREE.AdditiveBlending,
  });

/** 遠くの土手。ゆるい起伏の稜線をぐるりと一周させる（自動回転しても空が抜けない） */
const makeRidge = (): THREE.Mesh => {
  const SEG = 256;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= SEG; i++) {
    const a = (i / SEG) * Math.PI * 2;
    const h =
      3.2 + 1.6 * Math.sin(a * 3 + 0.7) + 1.1 * Math.sin(a * 7 + 2.1) + 0.5 * Math.sin(a * 17 + 0.3);
    const x = Math.cos(a) * RIDGE_R;
    const z = Math.sin(a) * RIDGE_R;
    pos.push(x, -0.5, z, x, h, z);
    if (i < SEG) {
      const b = i * 2;
      idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 1, metalness: 0, side: THREE.DoubleSide }),
  );
};

// ---------------------------------------------------------------------------

let flashLight: THREE.PointLight;

/** 玉が割れてからの秒数（番組の周期で折り返す）。update と sound の両方から引くので純関数にする。 */
const burstAge = (s: Shell, t: number): number => (((t - burstAt(s)) % PERIOD) + PERIOD) % PERIOD;

/** 打ち上げ / 割れ / 冠菊のぱちぱち の刻み。build のたびに作り直す。 */
let launchTicks = tickers(PROGRAM.length);
let burstTicks = tickers(PROGRAM.length);
let crackleTicks = tickers(PROGRAM.length);
let crackle = 0;

export const fireworks: SceneModule = {
  name: 'Fireworks',
  desc: '尾を引いて昇った玉が夜空で球に割れ、菊・牡丹・冠菊が咲いては垂れて、川面に揺れて映る。',
  camera: { pos: [0, 5.5, 53], target: [0, 6.5, 0] },
  environment: 0.2,

  build(root) {
    seed = 0.6173;
    launchTicks = tickers(PROGRAM.length);
    burstTicks = tickers(PROGRAM.length);
    crackleTicks = tickers(PROGRAM.length);
    crackle = 0;
    uPixelRatio.value = Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio, 2);
    refreshLut(0);

    // ---- 川面。星は鏡映しで別に描くので、ここは光を受けない暗い面だけ ----
    // （照明を受けると stage のリムライトが水面に丸い照り返しを作り、正体不明の光に見える）
    const water = new THREE.Mesh(
      new THREE.CircleGeometry(WATER_R, 96),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(SURFACE).multiplyScalar(0.6) }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = -0.02;
    root.add(water);

    root.add(makeRidge());

    // ---- 星と昇り曲導と対岸の灯り。映り込み → 本体の順に描く ----
    const starGeo = makeStarGeometry();
    const riseGeo = makeRiseGeometry();
    const shoreGeo = makeShoreGeometry();
    const layers: [THREE.BufferGeometry, string, number, number][] = [
      [starGeo, STAR_VERT, STAR_PX, STAR_GAIN],
      [riseGeo, RISE_VERT, RISE_PX, STAR_GAIN],
      [shoreGeo, SHORE_VERT, SHORE_PX, SHORE_GAIN],
    ];
    for (const mirror of [true, false]) {
      for (const [geo, vert, px, gain] of layers) {
        const pts = new THREE.Points(geo, makeSparkMaterial(vert, px, mirror, gain));
        pts.frustumCulled = false;
        pts.renderOrder = mirror ? 1 : 2;
        root.add(pts);
      }
    }

    // ---- 割れた瞬間だけ川面と土手を照らす。花火そのものが光源なので、ここは光を足す ----
    flashLight = new THREE.PointLight(emberColor(0.95), 0, 0, 2);
    flashLight.position.set(0, 14, 0);
    root.add(flashLight);
  },

  update(t) {
    uTime.value = t;
    refreshLut(t);

    // いちばん強く光っている玉の位置へ光を寄せる
    let best = 0;
    let sum = 0;
    for (const s of PROGRAM) {
      const age = burstAge(s, t);
      const k = KINDS[s.kind];
      const w = s.scale * s.scale * (age < k.life ? Math.exp(-age * 3.2) + 0.12 * (1 - age / k.life) : 0);
      sum += w;
      if (w > best) {
        best = w;
        flashLight.position.set(s.x, s.h, s.z);
      }
    }
    flashLight.intensity = FLASH_POWER * sum;
  },

  sound(t, _dt, sfx) {
    PROGRAM.forEach((s, i) => {
      const k = KINDS[s.kind];
      const pan = Math.max(-0.8, Math.min(0.8, s.x / 12));
      const big = s.scale * (s.kind === 'small' ? 0.6 : 1);

      // 昇る笛。細い風の音を上へ掃く
      if (launchTicks[i]((t - s.at) / PERIOD) > 0) {
        sfx.air({ gain: 0.07 * big, decay: riseTime(s.h), freq: 900, q: 6, sweep: 2.4, pan });
      }

      // 割れる音。低い打音を大きく曲げて、どんと鳴らす
      if (burstTicks[i]((t - burstAt(s)) / PERIOD) > 0) {
        sfx.drop(tone(s.kind === 'small' ? 5 : 0), {
          gain: 0.55 * big,
          decay: 1.4 * big,
          bend: 0.35,
          pan,
        });
        sfx.air({ gain: 0.18 * big, decay: 1.6 * big, freq: 260, q: 0.8, sweep: 0.6, pan });
      }

      // 冠菊の残り火のぱちぱち。瞬きの始まるころから散発的に
      if (k.glitter > 0) {
        const age = burstAge(s, t);
        const on = age > k.life * 0.35 && age < k.life * 0.9;
        for (let n = crackleTicks[i](t * 9 + i * 0.37); n > 0; n--) {
          crackle++;
          if (!on || (crackle * 0.618) % 1 > 0.45) continue;
          sfx.pluck(tone(14 + (crackle % 4)), {
            gain: 0.035,
            decay: 0.12,
            pan: pan + Math.sin(crackle * 2.3) * 0.3,
          });
        }
      }
    });
  },
};
