import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tickers } from '../audio.ts';
import { ember, emberColor, drift } from '../palette.ts';

/**
 * Laundry Line — 草原に並んだ物干し紐のシーツが、風を受けてなびく。
 *
 * 何が動くか: 闇に浮かぶ草原に 3 竿の物干し紐。それぞれに洗濯ばさみで留めたシーツが並ぶ。
 *   足元の草はシェル法（地面を薄い層に重ね、層ごとに草の断面だけを残す）で描き、
 *   同じ風で穂先がなびく。
 * 気持ちよさの芯: 絶えず吹く風でシーツがゆるく膨らみ、周期的に来る突風が
 *   奥の左から手前の右へ抜けるたびに、竿ごと・1 枚ごとに順番に裾が持ち上がってはためく。
 *   突風の通り道は草の上にも明るい帯になって見え、シーツへ届く前に風が来るのが分かる。
 * ループの周期: 突風は 8 秒ごと。すべて t の関数で、開き直しても同じ絵になる。
 * カメラ: 少し斜め前の目の高さから、手前の竿を中心に奥の竿まで入れる。
 * 音: 突風が各シーツを抜けるたびに、その位置で布のはためく風音（air）。
 * スコープ外: 布どうしの衝突、洗濯ばさみが外れて飛ぶ、昼夜の変化、草の影。
 *
 * シーツは縦の列ごとに、上端（紐）から裾へ向かって「傾き β」を積分して作る。
 * 長さが保たれるので、風が強いほど裾が持ち上がり、短く見える。
 * 風の式は JS（シーツ・紐）と GLSL（草）で同じものを使い、両者の動きを揃えている。
 */

// ---- 調整する数値 ----
/** 竿の位置 [中心 x, z, 柱の間隔の半分, シーツの枚数] */
const LINES: readonly [number, number, number, number][] = [
  [-1.5, 0, 6.3, 4],
  [5.5, -12, 6.3, 4],
  [-5, -24, 6.3, 4],
];
/** 柱の高さ（紐の結び目の高さ） */
const POLE_H = 5.4;
/** 紐のたるみ（中央でどれだけ下がるか） */
const SAG = 0.5;
/** シーツの幅・間隔・丈 */
const SHEET_W = 2.5;
const SHEET_GAP = 0.4;
const SHEET_H = [3.0, 3.35, 2.8, 3.2];
/** 布の分割数（横・縦） */
const COLS = 16;
const ROWS = 22;
/** 常に吹いている風の強さ（rad。布が鉛直から傾く角度） */
const BASE_WIND = 0.32;
/** 突風で足される強さ */
const GUST = 0.78;
/** 突風の周期・進む速さ・鋭さ（大きいほど短く強い） */
const GUST_PERIOD = 8;
const GUST_SPEED = 7;
const GUST_SHARP = 3;
/** 突風が進む向き（xz 平面の単位ベクトル）。風そのものは +z へ吹く */
const GUST_DX = 0.55;
const GUST_DZ = 0.835;
/** 布を流れる波紋の強さ・細かさ・速さ */
const RIPPLE = 0.34;
const RIPPLE_K = 2.1;
const RIPPLE_W = 4.2;
/** 洗濯ばさみの間が風をはらんで膨らむ分 */
const BELLY = 0.28;
/** 紐が風に押されて前へ出る量 */
const ROPE_PUSH = 0.35;
/** 紐を描く区間の数（1 竿あたり） */
const ROPE_SEG = 24;

/** 草原の広さ（幅・奥行き）・中心の z・分割数。物干し竿の並ぶ範囲だけに敷く */
const FIELD_W = 27;
const FIELD_D = 31;
const FIELD_Z = -11;
const FIELD_SEG_W = 30;
const FIELD_SEG_D = 34;
/** 草原の縁で草が低くなって闇に溶けていく幅 */
const FIELD_FADE = 3;
/** 草の層の数・丈・1 単位あたりの株の数。層の数がそのまま描画の重さになる */
const SHELLS = 14;
const GRASS_H = 0.6;
const GRASS_DENSITY = 3;
/** 風で穂先が倒れる量 */
const GRASS_BEND = 0.55;
/** 草の根元（最下層）と穂先の明るさ（光源を使わない材質なので、ここで陰影を付ける） */
const GROUND_DIM = 0.1;
const TIP_LIGHT = 0.42;

// ---- 導出値 ----
const COL_V = COLS + 1;
const VERTS = COL_V * (ROWS + 1);
const PINS_PER = 3; // 両端と真ん中
const TAU = Math.PI * 2;
const SHEET_COUNT = LINES.reduce((a, l) => a + l[3], 0);

/** 位置 (x, z)・時刻 t での風の強さ（rad）。GLSL 側の gustWind() と同じ式 */
function wind(x: number, z: number, t: number): number {
  // 突風の山は GUST_D の向きへ進む。位相の小数部を山 1 つの形にして、周期的に通過させる
  const g = x * GUST_DX + z * GUST_DZ;
  const p = (t - g / GUST_SPEED) / GUST_PERIOD;
  const bump = Math.pow(0.5 - 0.5 * Math.cos(TAU * p), GUST_SHARP);
  const breathe = 0.06 * Math.sin(t * 0.7 + x * 0.25) + 0.04 * Math.sin(t * 1.9 - x * 0.6 + z * 0.3);
  return BASE_WIND + GUST * bump + breathe;
}

/** 同じ式の GLSL 版。定数は TS から埋め込む */
const f = (n: number): string => (Number.isInteger(n) ? `${n}.0` : `${n}`);
const GLSL_WIND = /* glsl */ `
float gustWind(vec2 p, float t) {
  float g = p.x * ${f(GUST_DX)} + p.y * ${f(GUST_DZ)};
  float ph = (t - g / ${f(GUST_SPEED)}) / ${f(GUST_PERIOD)};
  float bump = pow(0.5 - 0.5 * cos(6.2831853 * ph), ${f(GUST_SHARP)});
  float breathe = 0.06 * sin(t * 0.7 + p.x * 0.25) + 0.04 * sin(t * 1.9 - p.x * 0.6 + p.y * 0.3);
  return ${f(BASE_WIND)} + ${f(GUST)} * bump + breathe;
}
float grassHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
`;

/** 竿 li の紐の上の点。lx は竿の中心からの x（-half..half） */
function ropeAt(li: number, lx: number, t: number, out: THREE.Vector3): THREE.Vector3 {
  const [cx, cz, half] = LINES[li]!;
  const q = 1 - (lx / half) ** 2; // 両端 0、中央 1
  const x = cx + lx;
  const push = ROPE_PUSH * q * (wind(x, cz, t) - BASE_WIND * 0.5);
  return out.set(x, POLE_H - SAG * q, cz + push);
}

/** 竿 li の k 枚目のシーツの左端（竿の中心からの x） */
function sheetX0(li: number, k: number): number {
  const n = LINES[li]![3];
  const total = n * SHEET_W + (n - 1) * SHEET_GAP;
  return -total / 2 + k * (SHEET_W + SHEET_GAP);
}

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const dummy = new THREE.Object3D();
const color = new THREE.Color();
const up = new THREE.Vector3(0, 1, 0);

interface Sheet {
  line: number;
  x0: number;
  h: number;
  seed: number;
  geo: THREE.BufferGeometry;
  pos: THREE.BufferAttribute;
}
let sheets: Sheet[] = [];
let rope: THREE.InstancedMesh;
let ropeMat: THREE.MeshLambertMaterial;
let pins: THREE.InstancedMesh;
const grassTime = { value: 0 };

/** シーツごとに、突風が通り抜けた回数を数える */
let ticks = tickers(SHEET_COUNT);

/** シェル法の草原。層ごとに持ち上げ、風の分だけ穂先側を +z へずらす */
function makeGrass(): THREE.InstancedMesh {
  const geo = new THREE.PlaneGeometry(FIELD_W, FIELD_D, FIELD_SEG_W, FIELD_SEG_D);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, FIELD_Z);
  const layers = new Float32Array(SHELLS);
  for (let i = 0; i < SHELLS; i++) layers[i] = i / (SHELLS - 1);
  geo.setAttribute('aLayer', new THREE.InstancedBufferAttribute(layers, 1));

  // 層の数だけ画面を塗り重ねるので、光の計算をしない材質で軽くする
  const mat = new THREE.MeshBasicMaterial({ color: emberColor(0.24, 0.03) });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = grassTime;
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aLayer;
uniform float uTime;
varying float vLayer;
varying vec2 vGrass;
varying float vWind;
${GLSL_WIND}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vLayer = aLayer;
vGrass = transformed.xz;
float w = gustWind(transformed.xz, uTime);
vWind = w;
float lean = aLayer * aLayer;
float sway = 0.12 * sin(uTime * 2.3 + transformed.x * 1.7 + transformed.z * 1.3);
transformed.y += aLayer * ${f(GRASS_H)} * (1.0 - 0.35 * lean * w);
transformed.z += (w + sway) * ${f(GRASS_BEND)} * lean;
transformed.x += sway * 0.3 * lean;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vLayer;
varying vec2 vGrass;
varying float vWind;
float grassHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
vec2 cp = vGrass * ${f(GRASS_DENSITY)};
vec2 id = floor(cp);
float h = grassHash(id);
// 縁に近いほど草を低く、地面を暗くして、端を闇に溶かす
float edge = min(${f(FIELD_W / 2)} - abs(vGrass.x), ${f(FIELD_D / 2)} - abs(vGrass.y - ${f(FIELD_Z)}));
float fade = smoothstep(0.0, ${f(FIELD_FADE)}, edge);
float bladeH = mix(0.15, 1.0, h * h) * fade;
diffuseColor.rgb *= fade;
if (vLayer > 0.0) {
  if (vLayer > bladeH) discard;
  vec2 off = vec2(grassHash(id + 3.1), grassHash(id + 7.7)) - 0.5;
  vec2 q = fract(cp) - 0.5 - off * 0.4;
  float rad = (1.0 - vLayer / bladeH) * 0.7;
  if (length(q) > rad) discard;
}
// 根元は暗く、穂先ほど明るい。風に倒れている所は穂先が光を返して明るく見える
float tipLight = mix(${f(GROUND_DIM)}, ${f(TIP_LIGHT)}, vLayer) * mix(0.8, 1.1, h);
tipLight *= 1.0 + 0.4 * max(vWind - ${f(BASE_WIND)}, 0.0) * vLayer;
diffuseColor.rgb *= tipLight;`,
      );
  };

  const mesh = new THREE.InstancedMesh(geo, mat, SHELLS);
  for (let i = 0; i < SHELLS; i++) mesh.setMatrixAt(i, new THREE.Matrix4());
  // 層の影は形を持たない板の影になるので、影は落とさせない
  mesh.userData.shadow = false;
  mesh.frustumCulled = false;
  return mesh;
}

/** 草原の物干し紐。シーツが風をはらみ、突風が来るたび奥から手前へ順にはためいていく。 */
export const laundryLine: SceneModule = {
  name: 'Laundry Line',
  desc: '草原に並んだ物干し紐のシーツが風をはらみ、草を渡ってきた突風に順にはためく。',
  camera: { pos: [4.5, 9.8, 15], target: [0, 2.6, -9] },
  shadows: true,

  build(root) {
    ticks = tickers(SHEET_COUNT);
    sheets = [];

    root.add(makeGrass());

    // シーツ: 格子の頂点は毎フレーム作り直すので、ここでは面の張り方だけ決める
    const idx: number[] = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const a = r * COL_V + c;
        idx.push(a, a + COL_V, a + 1, a + 1, a + COL_V, a + COL_V + 1);
      }
    }
    let n = 0;
    LINES.forEach(([, , , count], li) => {
      for (let k = 0; k < count; k++, n++) {
        const geo = new THREE.BufferGeometry();
        const pos = new THREE.BufferAttribute(new Float32Array(VERTS * 3), 3);
        pos.setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute('position', pos);
        geo.setIndex(idx);
        const mesh = new THREE.Mesh(
          geo,
          // つや消しの布なので、軽い Lambert で足りる
          new THREE.MeshLambertMaterial({
            color: emberColor(0.7 + 0.05 * Math.sin(n * 2.3), 0.025 * Math.cos(n * 1.7)),
            side: THREE.DoubleSide,
          }),
        );
        root.add(mesh);
        sheets.push({
          line: li,
          x0: sheetX0(li, k),
          h: SHEET_H[n % SHEET_H.length]!,
          seed: n * 1.618,
          geo,
          pos,
        });
      }
    });

    // 紐: 細い円柱を区間ごとに並べる
    ropeMat = new THREE.MeshLambertMaterial({ color: emberColor(0.45) });
    rope = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.025, 0.025, 1, 6),
      ropeMat,
      ROPE_SEG * LINES.length,
    );
    rope.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(rope);

    // 洗濯ばさみ
    pins = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.07, 0.3, 0.1),
      new THREE.MeshStandardMaterial({ roughness: 0.5 }),
      SHEET_COUNT * PINS_PER,
    );
    pins.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(pins);
    for (let i = 0; i < SHEET_COUNT * PINS_PER; i++) {
      pins.setColorAt(i, emberColor(0.3 + 0.125 * (i % 3), 0.02));
    }

    // 柱
    const postGeo = new THREE.CylinderGeometry(0.055, 0.07, POLE_H + 0.3, 10);
    const postMat = new THREE.MeshStandardMaterial({ color: emberColor(0.2), roughness: 0.6 });
    for (const [cx, cz, half] of LINES) {
      for (const s of [-1, 1]) {
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(cx + s * half, (POLE_H + 0.3) / 2 - 0.1, cz);
        root.add(post);
      }
    }
  },

  update(t) {
    grassTime.value = t;

    // シーツ
    for (const { line, x0, h, seed, geo, pos } of sheets) {
      const cz = LINES[line]![1];
      const arr = pos.array as Float32Array;
      const dv = h / ROWS;

      for (let c = 0; c <= COLS; c++) {
        const un = c / COLS; // 0..1（シーツの左端から右端）
        ropeAt(line, x0 + un * SHEET_W, t, tmp);
        // 洗濯ばさみの間はわずかに垂れる
        const pinSag = 0.07 * Math.abs(Math.sin(un * Math.PI * 2));
        let x = tmp.x;
        let y = tmp.y - 0.05 - pinSag;
        let z = tmp.z;

        const w = wind(tmp.x, cz, t);
        // 洗濯ばさみの間が膨らむ
        const belly = BELLY * w * Math.sin(un * Math.PI * 2 - 0.3) ** 2;
        const edge = (un - 0.5) * 2;

        for (let r = 0; r <= ROWS; r++) {
          const i = r * COL_V + c;
          arr[i * 3] = x;
          arr[i * 3 + 1] = y;
          arr[i * 3 + 2] = z;

          const vn = r / ROWS; // 0 = 紐、1 = 裾
          // 裾ほど風に持ち上げられる。波紋は上から裾へ流れる
          const ripple =
            RIPPLE * w * vn * Math.sin(RIPPLE_K * r * dv - RIPPLE_W * t + un * 2.3 + seed);
          const beta = w * (0.35 + 0.85 * vn) + belly * (1 - vn * 0.5) + ripple;
          y -= Math.cos(beta) * dv;
          z += Math.sin(beta) * dv;
          // 裾の角だけ、横にもひらひらと振れる
          x += 0.2 * w * vn * edge * Math.sin(t * 3.1 + seed + vn * 3) * dv;
        }
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
    }

    // 紐
    for (let li = 0; li < LINES.length; li++) {
      const half = LINES[li]![2];
      for (let i = 0; i < ROPE_SEG; i++) {
        ropeAt(li, -half + (i / ROPE_SEG) * half * 2, t, tmp);
        ropeAt(li, -half + ((i + 1) / ROPE_SEG) * half * 2, t, tmp2);
        dummy.position.copy(tmp).add(tmp2).multiplyScalar(0.5);
        tmp2.sub(tmp);
        const len = tmp2.length();
        dummy.quaternion.setFromUnitVectors(up, tmp2.normalize());
        dummy.scale.set(1, len, 1);
        dummy.updateMatrix();
        rope.setMatrixAt(li * ROPE_SEG + i, dummy.matrix);
      }
    }
    rope.instanceMatrix.needsUpdate = true;

    // 洗濯ばさみ（シーツの両端と真ん中）
    sheets.forEach(({ line, x0 }, k) => {
      for (let p = 0; p < PINS_PER; p++) {
        ropeAt(line, x0 + (p / (PINS_PER - 1)) * SHEET_W, t, tmp);
        dummy.position.set(tmp.x, tmp.y - 0.06, tmp.z + 0.02);
        dummy.quaternion.identity();
        dummy.rotation.set(wind(tmp.x, tmp.z, t) * 0.3, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        pins.setMatrixAt(k * PINS_PER + p, dummy.matrix);
      }
    });
    pins.instanceMatrix.needsUpdate = true;

    // 紐の色だけ、ゆっくり色相を漂わせる
    ropeMat.color.copy(ember(color, 0.45, drift(t)));
  },

  sound(t, _dt, sfx) {
    // 突風の山がシーツの真ん中を通る瞬間に、その位置で布の風音を鳴らす
    sheets.forEach(({ line, x0 }, k) => {
      const [cx, cz] = LINES[line]!;
      const x = cx + x0 + SHEET_W / 2;
      const phase = (t - (x * GUST_DX + cz * GUST_DZ) / GUST_SPEED) / GUST_PERIOD - 0.5;
      for (let n = ticks[k]!(phase); n > 0; n--) {
        // 奥の竿ほど小さく
        sfx.air({
          gain: 0.13 / (1 + line * 0.7),
          decay: 1.1,
          freq: 560 + (k % 4) * 70,
          q: 0.9,
          sweep: 0.55,
          pan: Math.max(-1, Math.min(1, x / 10)),
        });
      }
    });
  },
};
