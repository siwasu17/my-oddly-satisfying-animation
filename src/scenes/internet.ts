import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { ember } from '../palette.ts';

/**
 * Internet。
 *
 * 暗い空間に、粒子がたくさん寄り集まって渦を巻く「ハブ」がいくつか浮かんでいる。
 * ハブどうしの間を、トラフィックの粒子が塊（バースト）になって流れていく。流れは
 * curl noise（発散の無いベクトル場）で道筋をゆがめてあるので、線ではなく煙や水のように
 * うねりながら届き、ハブに吸い込まれて消える。届いた塊のぶんだけハブがふっと明るむ。
 *
 * 何が動くか: ハブ間を流れる粒子の帯（両方向）と、ハブの中で渦を巻く粒子の塊
 * 気持ちよさの芯: 塊がうねりながら運ばれ、ハブへ吸い込まれて灯りが膨らむ
 * ループの周期: 経路ごとに 9〜14 秒で一巡。周期をずらしてあるので同じ絵は続かない
 * カメラ: 斜め上から、網全体を見渡す
 * 音: 大きなハブにバーストが届くたび、送り元のハブで決まる音程を 1 音
 * スコープ外: 地図・地球儀の形、文字、ノードやケーブルの実体
 *
 * 粒子の位置はすべて頂点シェーダーで t から計算する（CPU では状態を持たない）。
 */

// ---- 調整用の定数 ---------------------------------------------------------

/** ハブの位置 */
const HUBS: [number, number, number][] = [
  [0, 0.6, 0],
  [-7.5, 1.6, -2.5],
  [7, 1.2, -3.5],
  [-4, -0.6, 4],
  [5, -0.4, 4],
  [-10.5, -0.2, 3],
  [1.5, 2.2, -7.5],
];
/** 経路（ハブの組）。各組に行きと帰りの 2 本を流す */
const LINKS: [number, number][] = [
  [0, 1], [0, 2], [0, 3], [0, 4], [0, 6],
  [1, 5], [1, 6], [2, 6], [2, 4], [3, 5], [3, 4],
];
/** 音を鳴らす（大きな）ハブ */
const LOUD_HUB = 0;

/** 1 本の経路に流す粒子の数 */
const PER_ROUTE = 900;
/** うち、塊にならず細く流れ続ける粒子の割合 */
const TRICKLE = 0.3;
/** 1 本の経路に同時に乗っているバーストの数 */
const BURSTS = 2;
/** バーストの長さ（経路に対する割合） */
const BURST_SPREAD = 0.07;
/** 経路の一巡にかかる秒数の範囲 */
const LAP_MIN = 9;
const LAP_MAX = 14;
/** 帯の太さ */
const LANE = 0.28;
/** 経路の山なりの高さ（距離に対する割合）と、行き帰りを左右に離す量 */
const BOW_UP = 0.16;
const BOW_SIDE = 0.12;

/** ハブの格（1 = 最大）。主役は 2〜3 個に絞り、残りは小さく暗くする */
const HUB_SCALE = [1, 0.72, 0.66, 0.45, 0.42, 0.34, 0.4];
/** 格 1 のハブの粒子の数と半径（数は格の 2 乗、半径は格に比例） */
const HUB_MAX = 4200;
const HUB_RMAX = 2.4;
/** 渦の腕の数と巻きの強さ、渦が回る速さ（rad/秒） */
const ARMS = 2;
const ARM_WIND = 1.6;
const HUB_SPIN = 0.32;

/** curl noise の空間の細かさ、ゆがみの強さ、流れの速さ */
const CURL_FREQ = 0.32;
const CURL_AMP = 1.15;
const CURL_SPEED = 0.18;

/** 粒子の大きさ（ワールド単位）と明るさ */
const ROUTE_SIZE = 0.075;
const HUB_SIZE = 0.075;
const ROUTE_GAIN = 0.34;
const HUB_GAIN = 0.13;
/** バーストが届いたときにハブが明るむ量と、引く速さ（秒） */
const ARRIVE_GLOW = 0.55;
const ARRIVE_DECAY = 2.2;

// ---- シェーダー ------------------------------------------------------------

/** curl noise。sin のポテンシャル場を重ね、その回転（curl）を解析的に取る。発散がゼロになる */
const CURL_GLSL = /* glsl */ `
uniform float uTime;
vec3 curlField(vec3 p) {
  float t = uTime * ${CURL_SPEED.toFixed(3)};
  vec3 c = vec3(0.0);
  // curl( sin(k·p + w t) e ) = cos(k·p + w t) (k × e)
  vec3 k; vec3 e;
  k = vec3(1.00, 0.35, 0.62); e = vec3(0.0, 1.0, 0.3);  c += cos(dot(k, p) + 1.0 * t)       * cross(k, e);
  k = vec3(-0.42, 1.10, 0.28); e = vec3(0.8, 0.0, 0.6); c += cos(dot(k, p) - 0.8 * t + 1.7) * cross(k, e);
  k = vec3(0.30, -0.55, 1.05); e = vec3(0.5, 0.7, 0.0); c += cos(dot(k, p) + 1.3 * t + 4.1) * cross(k, e);
  k = vec3(1.90, 0.80, -1.30); e = vec3(0.2, 0.5, 0.8); c += 0.5 * cos(dot(k, p) - 1.7 * t + 2.3) * cross(k, e);
  k = vec3(-1.40, -1.60, 1.70); e = vec3(0.9, 0.1, 0.3); c += 0.5 * cos(dot(k, p) + 2.1 * t + 5.2) * cross(k, e);
  k = vec3(2.70, -2.20, 2.10); e = vec3(0.3, 0.9, 0.4); c += 0.25 * cos(dot(k, p) - 2.6 * t + 0.6) * cross(k, e);
  return c;
}
/** 場に沿って数歩流したときのずれ。流線に沿ってゆがむので、帯が煙のようにうねる */
vec3 flowWarp(vec3 p) {
  vec3 q = p * ${CURL_FREQ.toFixed(3)};
  vec3 d = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    vec3 v = curlField(q + d);
    d += v * 0.09;
  }
  return d / ${CURL_FREQ.toFixed(3)};
}
`;

const POINT_GLSL = /* glsl */ `
uniform float uScreenH;
float pointSize(vec4 mv, float worldSize) {
  return worldSize * projectionMatrix[1][1] * uScreenH * 0.5 / max(0.1, -mv.z);
}
`;

const ROUTE_VERT = /* glsl */ `
attribute vec3 aA;
attribute vec3 aB;
attribute vec3 aC;
attribute vec4 aParam; // u0, 速さ, 帯の中での横, 帯の中での縦
attribute vec3 aCol;
varying vec3 vCol;
varying float vAlpha;
${CURL_GLSL}
${POINT_GLSL}
void main() {
  float u = fract(aParam.x + uTime * aParam.y);
  float w = 1.0 - u;
  vec3 base = w * w * aA + 2.0 * w * u * aC + u * u * aB;
  vec3 dir = normalize(2.0 * w * (aC - aA) + 2.0 * u * (aB - aC));
  vec3 side = normalize(cross(dir, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(side, dir);
  // 両端（ハブの中）では 0、途中ほど大きくゆがむ
  float env = pow(sin(3.14159 * u), 0.8);
  vec3 p = base + (side * aParam.z + up * aParam.w) * ${LANE.toFixed(3)} * (0.3 + env);
  p += flowWarp(base) * ${CURL_AMP.toFixed(3)} * env;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = pointSize(mv, ${ROUTE_SIZE.toFixed(3)});
  vCol = aCol;
  vAlpha = smoothstep(0.0, 0.06, u) * smoothstep(1.0, 0.9, u);
}
`;

const HUB_VERT = /* glsl */ `
attribute vec3 aCenter;
attribute vec4 aSph; // 方位, 仰角, 半径, 自転の速さ
attribute float aHub;
attribute vec3 aCol;
uniform float uGlow[${HUBS.length}];
varying vec3 vCol;
varying float vAlpha;
${CURL_GLSL}
${POINT_GLSL}
void main() {
  // 渦: 腕の形ごと回し、粒ごとに少しだけ遅れ進みさせる
  float a = aSph.x + uTime * ${HUB_SPIN.toFixed(3)} + sin(uTime * aSph.w + aSph.x * 7.0) * 0.08;
  float c = cos(aSph.y);
  vec3 local = vec3(cos(a) * c, sin(aSph.y), sin(a) * c) * aSph.z;
  int h = int(aHub + 0.5);
  float g = 0.0;
  for (int i = 0; i < ${HUBS.length}; i++) if (i == h) g = uGlow[i];
  local *= 1.0 + g * 0.12;
  vec3 p = aCenter + local;
  p += flowWarp(p) * 0.18 * aSph.z;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = pointSize(mv, ${HUB_SIZE.toFixed(3)});
  vCol = aCol;
  vAlpha = 1.0 + g;
}
`;

const FRAG = /* glsl */ `
uniform float uGain;
varying vec3 vCol;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  a *= a;
  gl_FragColor = vec4(vCol * a * vAlpha * uGain, 1.0);
  #include <colorspace_fragment>
}
`;

// ---- 組み立て ---------------------------------------------------------------

const uTime = { value: 0 };
const uScreenH = { value: 600 };
const uGlow = { value: new Array<number>(HUBS.length).fill(0) };

interface Route {
  from: number;
  to: number;
  speed: number;
  offset: number;
}
let routes: Route[] = [];
let ticks = tickers(1);

function makeMaterial(vert: string, gain: number, withGlow: boolean): THREE.ShaderMaterial {
  const uniforms: Record<string, THREE.IUniform> = {
    uTime,
    uScreenH,
    uGain: { value: gain },
  };
  if (withGlow) uniforms.uGlow = uGlow;
  return new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: FRAG,
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

export const internet: SceneModule = {
  name: 'Internet',
  desc: '粒子の渦になったハブのあいだを、トラフィックが煙のようにうねりながら流れて吸い込まれる。',
  camera: { pos: [-1.2, 8.4, 17.5], target: [-1.2, 0.4, -0.6] },

  build(root) {
    let s = 0.731;
    const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);
    const color = new THREE.Color();

    // 経路: 各リンクに行きと帰り
    routes = [];
    for (const [a, b] of LINKS) {
      for (const [from, to] of [[a, b], [b, a]]) {
        routes.push({
          from,
          to,
          speed: 1 / (LAP_MIN + rnd() * (LAP_MAX - LAP_MIN)),
          offset: rnd(),
        });
      }
    }
    ticks = tickers(routes.length);

    // ---- トラフィックの粒子
    const n = routes.length * PER_ROUTE;
    const aA = new Float32Array(n * 3);
    const aB = new Float32Array(n * 3);
    const aC = new Float32Array(n * 3);
    const aParam = new Float32Array(n * 4);
    const aCol = new Float32Array(n * 3);
    const va = new THREE.Vector3();
    const vb = new THREE.Vector3();
    const vc = new THREE.Vector3();
    const side = new THREE.Vector3();
    routes.forEach((r, ri) => {
      va.fromArray(HUBS[r.from]);
      vb.fromArray(HUBS[r.to]);
      const dist = va.distanceTo(vb);
      side.subVectors(vb, va).cross(THREE.Object3D.DEFAULT_UP).normalize();
      // 山なりにし、行きと帰りを左右へ離す
      vc.addVectors(va, vb).multiplyScalar(0.5);
      vc.y += dist * BOW_UP;
      vc.addScaledVector(side, dist * BOW_SIDE);
      for (let k = 0; k < PER_ROUTE; k++) {
        const i = ri * PER_ROUTE + k;
        va.toArray(aA, i * 3);
        vb.toArray(aB, i * 3);
        vc.toArray(aC, i * 3);
        let u0: number;
        if (rnd() < TRICKLE) {
          u0 = rnd();
        } else {
          // 塊: 中心の周りに寄せる（3 つの和でなだらかな山にする）
          const b = Math.floor(rnd() * BURSTS);
          const j = (rnd() + rnd() + rnd() - 1.5) / 1.5;
          u0 = b / BURSTS + j * BURST_SPREAD;
        }
        // 帯の断面（円の中に一様に）
        const ang = rnd() * Math.PI * 2;
        const rad = Math.sqrt(rnd());
        aParam.set(
          [r.offset + u0 + 1, r.speed * (0.97 + rnd() * 0.06), Math.cos(ang) * rad, Math.sin(ang) * rad],
          i * 4,
        );
        ember(color, 0.5 + rnd() * 0.4, (rnd() - 0.5) * 0.04);
        color.toArray(aCol, i * 3);
      }
    });
    const routeGeo = new THREE.BufferGeometry();
    routeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    routeGeo.setAttribute('aA', new THREE.BufferAttribute(aA, 3));
    routeGeo.setAttribute('aB', new THREE.BufferAttribute(aB, 3));
    routeGeo.setAttribute('aC', new THREE.BufferAttribute(aC, 3));
    routeGeo.setAttribute('aParam', new THREE.BufferAttribute(aParam, 4));
    routeGeo.setAttribute('aCol', new THREE.BufferAttribute(aCol, 3));
    routeGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 40);
    root.add(new THREE.Points(routeGeo, makeMaterial(ROUTE_VERT, ROUTE_GAIN, false)));

    // ---- ハブの粒子
    const counts = HUB_SCALE.map((k) => Math.round(HUB_MAX * k * k));
    const m = counts.reduce((x, y) => x + y, 0);
    const hCenter = new Float32Array(m * 3);
    const hSph = new Float32Array(m * 4);
    const hHub = new Float32Array(m);
    const hCol = new Float32Array(m * 3);
    let i = 0;
    HUBS.forEach((c, h) => {
      const R = HUB_RMAX * HUB_SCALE[h];
      const dim = 0.55 + 0.45 * HUB_SCALE[h];
      for (let k = 0; k < counts[h]; k++, i++) {
        hCenter.set(c, i * 3);
        // 平たい渦巻きの円盤。粒は腕に沿って寄せ、中心の芯は小さく抑える
        const q = rnd();
        const r = R * (0.08 + 0.92 * Math.pow(q, 0.85));
        const arm = Math.floor(rnd() * ARMS);
        const spread = (rnd() + rnd() - 1) * (0.25 + 0.5 * (1 - q));
        const az = (arm / ARMS) * Math.PI * 2 + (r / R) * ARM_WIND * Math.PI + spread;
        const el = (rnd() + rnd() - 1) * 0.28 * (1 - q * 0.6);
        hSph.set([az, el, r, 0.4 + rnd() * 0.8], i * 4);
        hHub[i] = h;
        // 白に近いのは中心のごく小さな範囲だけ。渦の腕は薔薇〜琥珀の中ほどに抑える
        ember(color, q < 0.05 ? 0.92 : 0.42 + 0.22 * Math.sin(q * Math.PI), (rnd() - 0.5) * 0.04);
        color.multiplyScalar(dim);
        color.toArray(hCol, i * 3);
      }
    });
    const hubGeo = new THREE.BufferGeometry();
    hubGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m * 3), 3));
    hubGeo.setAttribute('aCenter', new THREE.BufferAttribute(hCenter, 3));
    hubGeo.setAttribute('aSph', new THREE.BufferAttribute(hSph, 4));
    hubGeo.setAttribute('aHub', new THREE.BufferAttribute(hHub, 1));
    hubGeo.setAttribute('aCol', new THREE.BufferAttribute(hCol, 3));
    hubGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 40);
    root.add(new THREE.Points(hubGeo, makeMaterial(HUB_VERT, HUB_GAIN, true)));
  },

  update(t) {
    uTime.value = t;
    uScreenH.value = window.innerHeight;

    // バーストが届いてからの秒数で、届き先のハブを明るませる
    const glow = uGlow.value;
    glow.fill(0);
    for (const r of routes) {
      const f = ((r.offset + 1 + t * r.speed) * BURSTS) % 1;
      const sec = f / (r.speed * BURSTS);
      glow[r.to] += Math.exp(-sec * ARRIVE_DECAY) * ARRIVE_GLOW;
    }
  },

  sound(t, _dt, sfx) {
    routes.forEach((r, ri) => {
      for (let k = ticks[ri]((r.offset + 1 + t * r.speed) * BURSTS); k > 0; k--) {
        if (r.to !== LOUD_HUB) continue;
        sfx.pluck(tone(6 + r.from), {
          gain: 0.22,
          decay: 2.4,
          pan: Math.max(-1, Math.min(1, HUBS[r.from][0] / 10)),
        });
      }
    });
  },
};
