import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * Lazy River。流れるプール。
 *
 * ドーナツ型の水路をひとつだけ置いて、水面をぐるりと一方向へ流し続ける。
 * 水面は環に沿って進む波でうねり、その上に浮かべた浮き輪が波の高さをそのまま
 * 拾って上下しながら、それぞれ少しずつ違う速さで回り続ける。
 * 速さが違うので追い越しは起きるが、向きは全員同じで、渋滞も逆流も起きない。
 * 浮き輪が水路の右手にある噴き出し口を通り過ぎるたびに、水の落ちる音がひとつ鳴る。
 * 一周はおよそ 40 秒。
 */

// ---- 調整する数値はここに集める -------------------------------------------

/** 水路の内側の半径 */
const RIN = 5.6;
/** 水路の外側の半径 */
const ROUT = 10.2;
/** 水路の中央の半径 */
const RMID = (RIN + ROUT) / 2;

/** 水面の分割数（周方向 / 半径方向） */
const SEG_A = 160;
const SEG_R = 8;

/** 一周にかかる秒数（浮き輪と水面の基準） */
const LAP = 40;
/** 基準の角速度 [rad/s] */
const FLOW = (Math.PI * 2) / LAP;

/** 波の高さ */
const WAVE_H = 0.34;

/** 波の谷の明るさ。ここは沈ませておく */
const WATER_LOW = 0.06;
/** 波の峰の明るさ。ブルームの閾値（明度 0.28）を超えるところまで持ち上げる */
const CREST_N = 0.64;
/** 峰の鋭さ。大きいほど筋が細くなる */
const CREST_SHARP = 1.4;
/** 斜面を 0..1 に正規化する基準 */
const SLOPE_SCALE = 0.22;
/** 水際が壁で光る量 */
const RIM_N = 0.1;

/** 水路の縁（島の側面・外壁）を SURFACE より暗く落とす係数。水面との断面差になる */
const EDGE_DIM = 0.72;
/** 島の天面の明るさ。暗すぎると環の中心が「穴」に見える */
const ISLAND_TOP_N = 0.08;
/** 島の側面。真っ黒にすると天面が浮いた板に見えるので、天面と連続させる */
const ISLAND_SIDE_N = 0.09;

/** 浮き輪の数 */
const FLOATS = 7;
/** 浮き輪の外径 / 太さ */
const RING_R = 0.82;
const RING_T = 0.3;

/** 壁の高さ。水面が窪みに収まって見える程度に立てる（俯瞰なので隠れない） */
const WALL_H = 0.42;

/** 噴き出し口の角度。ここを通ると音が鳴る */
const GATE_A = 0;

// ---------------------------------------------------------------------------

const dummy = new THREE.Object3D();
const color = new THREE.Color();

let s = 0.731;
const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);

let water: THREE.Mesh;
let waterPos: THREE.BufferAttribute;
let waterCol: THREE.BufferAttribute;
/** 水面の各頂点の [角度, 半径] を build で 1 度だけ求めておく */
let vAng = new Float32Array(0);
let vRad = new Float32Array(0);

let rings: THREE.InstancedMesh;
/** 浮き輪ごとの [初期角, 角速度, 半径オフセット, 大きさ, 色] */
const floats = new Float32Array(FLOATS * 5);

let ticks = tickers(FLOATS);

/** 水路のどこにいるか（0 = 内壁際, 1 = 外壁際）に応じて波を弱める */
function waveAt(a: number, r: number, t: number): number {
  const k = (r - RIN) / (ROUT - RIN);
  const edge = Math.sin(Math.PI * Math.min(1, Math.max(0, k)));
  // 波は細かいほうが水に見える。周期を整数比にしないので同じ形が戻ってこない
  const w =
    Math.sin(a * 4 - t * FLOW * 4 + k * 1.2) * 0.5 +
    Math.sin(a * 7 + t * 0.44 - k * 0.8) * 0.3 +
    Math.sin(a * 11 - t * FLOW * 9) * 0.16;
  return w * edge * WAVE_H;
}

/** 噴き出し口に近いほど 1 に寄る。水面の色と浮き輪の照り返しに使う */
function gateGlow(a: number): number {
  const d = Math.abs(Math.atan2(Math.sin(a - GATE_A), Math.cos(a - GATE_A)));
  return Math.max(0, 1 - d / 0.55);
}

export const lazyRiver: SceneModule = {
  name: 'Lazy River',
  desc: '環になった水路を水が流れ、浮き輪が同じ向きにゆっくり回り続ける。',
  camera: { pos: [0, 13.5, 21], target: [0, 0, 0] },

  build(root) {
    s = 0.731;
    ticks = tickers(FLOATS);

    // 水路の縁は SURFACE をさらに暗くする。明るい水面との差が「窪み」に見える
    const edgeColor = new THREE.Color(SURFACE).multiplyScalar(EDGE_DIM);

    // --- 床 ---
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(ROUT * 1.7, 96),
      // 磨いた床にするとリムライトが大きなにじみになって水路の外で目を引く。鈍く沈めておく
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.72, metalness: 0.2 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.5;
    root.add(floor);

    // --- 水路の内側の島 ---
    // CylinderGeometry のマテリアルは [側面, 天面, 底面]。天面だけ明るくして
    // 「水路に囲まれた島」であることを見せる（暗いままだと中心が穴に見える）
    const islandSide = new THREE.MeshStandardMaterial({
      color: emberColor(ISLAND_SIDE_N, 0, 0),
      roughness: 0.85,
      metalness: 0.1,
    });
    const islandTop = new THREE.MeshStandardMaterial({
      color: emberColor(ISLAND_TOP_N, 0, 0),
      roughness: 0.8,
      metalness: 0.1,
    });
    const island = new THREE.Mesh(new THREE.CylinderGeometry(RIN, RIN, WALL_H + 0.5, 96), [
      islandSide,
      islandTop,
      islandSide,
    ]);
    island.position.y = (WALL_H + 0.5) / 2 - 0.5;
    root.add(island);

    // --- 外側の壁 ---
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(ROUT + 0.35, ROUT + 0.35, WALL_H + 0.5, 96, 1, true),
      new THREE.MeshStandardMaterial({
        color: edgeColor,
        roughness: 0.85,
        metalness: 0.1,
        side: THREE.BackSide,
      }),
    );
    wall.position.y = (WALL_H + 0.5) / 2 - 0.5;
    root.add(wall);

    // --- 水面 ---
    const geo = new THREE.RingGeometry(RIN, ROUT, SEG_A, SEG_R);
    const n = geo.attributes.position.count;
    vAng = new Float32Array(n);
    vRad = new Float32Array(n);
    const arr = geo.attributes.position.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const x = arr[i * 3];
      const y = arr[i * 3 + 1];
      vAng[i] = Math.atan2(y, x);
      vRad[i] = Math.hypot(x, y);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));

    water = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        // 艶を強くするとスペキュラが片側だけに寄って「一箇所が燃えている輪」になる。
        // 拡散主体にして、明るさを頂点カラー（＝周方向の位相）だけで決める
        vertexColors: true,
        roughness: 0.55,
        metalness: 0.05,
        side: THREE.DoubleSide,
      }),
    );
    water.rotation.x = -Math.PI / 2;
    root.add(water);
    waterPos = geo.attributes.position as THREE.BufferAttribute;
    waterCol = geo.attributes.color as THREE.BufferAttribute;

    // --- 噴き出し口。外壁に埋めた小さな口だけ光らせる ---
    const gate = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.22, 1.1),
      new THREE.MeshStandardMaterial({ color: emberColor(0.4, 0, 0), roughness: 0.7 }),
    );
    gate.position.set(Math.cos(GATE_A) * (ROUT - 0.1), 0.02, -Math.sin(GATE_A) * (ROUT - 0.1));
    gate.rotation.y = -GATE_A;
    root.add(gate);

    // --- 浮き輪 ---
    for (let i = 0; i < FLOATS; i++) {
      floats[i * 5] = (i / FLOATS) * Math.PI * 2 + rnd() * 0.5;
      floats[i * 5 + 1] = FLOW * (0.84 + rnd() * 0.34);
      floats[i * 5 + 2] = (rnd() - 0.5) * (ROUT - RIN) * 0.52;
      floats[i * 5 + 3] = 0.93 + rnd() * 0.14;
      floats[i * 5 + 4] = 0.44 + rnd() * 0.3;
    }

    const rgeo = new THREE.TorusGeometry(RING_R, RING_T, 12, 28);
    rgeo.rotateX(Math.PI / 2);
    rings = new THREE.InstancedMesh(
      rgeo,
      new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.28 }),
      FLOATS,
    );
    rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(rings);
  },

  update(t) {
    const sh = drift(t);

    // 水面
    for (let i = 0; i < vAng.length; i++) {
      const a = vAng[i];
      const r = vRad[i];
      const h = waveAt(a, r, t);
      waterPos.setZ(i, h);

      // 波の「上り斜面」だけを鋭く光らせる。暗い谷の中を細い筋が流れていく絵になる
      const slope = (waveAt(a + 0.05, r, t) - h) / WAVE_H / SLOPE_SCALE;
      const crest = Math.pow(Math.max(0, Math.min(1, slope)), CREST_SHARP);
      // 壁際で水がわずかに光る（水際）
      const k = (r - RIN) / (ROUT - RIN);
      const rim = Math.pow(Math.abs(k * 2 - 1), 6) * RIM_N;
      const n = WATER_LOW + crest * CREST_N + rim + gateGlow(a) * 0.1;
      ember(color, Math.min(1, Math.max(0, n)), sh, 0.02);
      waterCol.setXYZ(i, color.r, color.g, color.b);
    }
    waterPos.needsUpdate = true;
    waterCol.needsUpdate = true;
    // computeVertexNormals() は呼ばない。法線を上向きのまま保つことで、
    // 明るさがライトの角度ではなく頂点カラーだけで決まり、筋が全周に均等に出る

    // 浮き輪
    for (let i = 0; i < FLOATS; i++) {
      const a = floats[i * 5] + t * floats[i * 5 + 1];
      const r = RMID + floats[i * 5 + 2] + Math.sin(t * 0.23 + i) * 0.32;
      const sc = floats[i * 5 + 3];
      const h = waveAt(a, r, t);

      // 水面に半分沈める。浮いていることは波の上下だけで伝わる
      dummy.position.set(Math.cos(a) * r, h - RING_T * 0.3, -Math.sin(a) * r);
      // 波の傾きに合わせて少しだけ傾ける（やりすぎると騒がしい）
      dummy.rotation.order = 'YXZ';
      dummy.rotation.y = -a + t * 0.12 * (i % 2 ? 1 : -1);
      dummy.rotation.x = (waveAt(a + 0.08, r, t) - h) * 0.9;
      dummy.rotation.z = (waveAt(a, r + 0.5, t) - h) * 0.7;
      dummy.scale.setScalar(sc);
      dummy.updateMatrix();
      rings.setMatrixAt(i, dummy.matrix);

      ember(color, floats[i * 5 + 4] + gateGlow(a) * 0.22, sh, 0.04);
      rings.setColorAt(i, color);
    }
    rings.instanceMatrix.needsUpdate = true;
    if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    // 水路そのものの低い響き
    sfx.drone(tone(0) * 0.5, 0.05 + Math.sin(t * 0.21) * 0.012);

    // 浮き輪が噴き出し口をくぐるたびに、水の落ちる音がひとつ
    for (let i = 0; i < FLOATS; i++) {
      const phase = (floats[i * 5] - GATE_A + t * floats[i * 5 + 1]) / (Math.PI * 2);
      for (let k = ticks[i](phase); k > 0; k--) {
        sfx.drop(tone(5 + (i % 4) * 2), { gain: 0.26, decay: 0.7, bend: 0.5, pan: 0.45 });
      }
    }
  },
};
