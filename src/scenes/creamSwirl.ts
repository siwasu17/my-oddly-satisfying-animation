import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * 浅い器に注がれた 2 種類の液体が、渦に巻かれて混ざり、そのままほどけて元へ戻る。
 * 中心ほど速く回る差動回転で境界がらせんの筋に引き伸ばされ、細くなった筋はにじんで
 * 一様な色へ溶ける。渦の向きが反転すると筋は逆にたどられ、再びきれいな 2 色へ戻る。
 * 液面はひとつづきのポリゴン円盤で、頂点色だけが毎フレーム t から作り直される。
 * 混ざりは実流体ではなく、回転させた座標で元の 2 色配置を引き直しているだけ。
 * ループ 24 秒 / 俯瞰やや斜め / 渦の速さに追従するドローンと折り返しの水音。
 */

// ---- 調整する数値 ----------------------------------------------------------
const R = 9;            // 液面の半径
const RINGS = 84;       // 液面の半径方向の分割数。らせんの筋はここで解像する
const SECTORS = 128;    // 液面の円周方向の分割数
const PERIOD = 24;      // 巻いて戻るまでの秒数
const TWIST = 26;       // 中心での最大ねじれ角（rad）。約 4 巻き。大きいほど筋が細かい
const RIGID = 0.08;     // 全体をゆっくり回す角速度（rad/s）
const EDGE = 0.04;      // 静止時の境界のシャープさ
const BLUR = 0.3;       // ねじれが最大のとき境界がにじむ量
const TONE_A = 0.1;     // 液体 A（暗い薔薇）
const TONE_B = 0.95;    // 液体 B（明るい琥珀）
const FLECKS = 26;      // 流れに乗る粒の数
const FLECK_R = 0.09;   // 粒の半径
const WALL_H = 1.7;     // 器の深さ
const CAM = { pos: [0, 18, 12.5] as [number, number, number], target: [0, 0, 0] as [number, number, number] };

const TAU = Math.PI * 2;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (w: number, x: number): number => {
  const u = clamp01((x + w) / (2 * w));
  return u * u * (3 - 2 * u);
};

let s = 0.731;
const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);

const dummy = new THREE.Object3D();
const colA = new THREE.Color();
const colB = new THREE.Color();

let surface: THREE.Mesh;
let surfCol: THREE.BufferAttribute;
let flecks: THREE.InstancedMesh;

/** 液面の頂点ごとの半径と角度。update はここから引く */
let vr = new Float32Array(0);
let vth = new Float32Array(0);
/** 粒ごとの [半径, 角度, 上下のゆらぎ位相] */
let fleck = new Float32Array(0);

let tick = ticker();
let step = 0;

/** 極座標グリッドの円盤を作る。法線は真上で固定、色は毎フレーム書き換える */
function buildDisc(): THREE.BufferGeometry {
  const v = (RINGS + 1) * SECTORS;
  const pos = new Float32Array(v * 3);
  const nor = new Float32Array(v * 3);
  const col = new Float32Array(v * 3);
  vr = new Float32Array(v);
  vth = new Float32Array(v);

  for (let i = 0; i <= RINGS; i++) {
    // 中心付近を細かく取ると、いちばんねじれる場所の筋が潰れない
    const rn = (i / RINGS) ** 1.35;
    for (let j = 0; j < SECTORS; j++) {
      const k = i * SECTORS + j;
      const th = (j / SECTORS) * TAU;
      vr[k] = rn * R;
      vth[k] = th;
      pos[k * 3] = Math.cos(th) * rn * R;
      pos[k * 3 + 1] = 0;
      pos[k * 3 + 2] = Math.sin(th) * rn * R;
      nor[k * 3 + 1] = 1;
    }
  }

  const idx = new Uint16Array(RINGS * SECTORS * 6);
  let o = 0;
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SECTORS; j++) {
      const j2 = (j + 1) % SECTORS;
      const a = i * SECTORS + j;
      const b = i * SECTORS + j2;
      const c = (i + 1) * SECTORS + j;
      const d = (i + 1) * SECTORS + j2;
      idx[o++] = a; idx[o++] = b; idx[o++] = c;
      idx[o++] = b; idx[o++] = d; idx[o++] = c;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}

/** 器。液面より下だけに置いて、上から覗いたときに縁が細く光る */
function buildBowl(root: THREE.Group): void {
  const metal = { color: SURFACE, roughness: 0.44, metalness: 0.7 };

  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 1.015, R * 0.94, WALL_H, 96, 1, true),
    new THREE.MeshStandardMaterial({ ...metal, side: THREE.DoubleSide }),
  );
  wall.position.y = -WALL_H / 2;
  root.add(wall);

  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(R * 1.015, 0.15, 10, 120),
    new THREE.MeshStandardMaterial({ ...metal, roughness: 0.42 }),
  );
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.02;
  root.add(rim);

  const base = new THREE.Mesh(
    new THREE.CircleGeometry(R * 0.94, 96),
    new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.5, metalness: 0.6 }),
  );
  base.rotation.x = -Math.PI / 2;
  base.position.y = -WALL_H + 0.01;
  root.add(base);

  // 器の外は鍔の幅だけに留め、つやも落としてある。広く磨いた床を敷くと
  // stage のリムライトの写り込みが器の脇に丸く浮いて、主役より光ってしまう
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(R * 1.3, 96),
    new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.78, metalness: 0.22 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -WALL_H - 0.02;
  root.add(floor);
}

export const creamSwirl: SceneModule = {
  name: 'Cream Swirl',
  desc: '2 色の液体がらせんに巻き込まれ、細い筋へ溶けて、そのままほどけて元に戻る',
  camera: CAM,

  build(root) {
    s = 0.731;
    tick = ticker();
    step = 0;

    buildBowl(root);

    surface = new THREE.Mesh(
      buildDisc(),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.34, metalness: 0.3 }),
    );
    surface.position.y = 0;
    root.add(surface);
    surfCol = surface.geometry.getAttribute('color') as THREE.BufferAttribute;

    fleck = new Float32Array(FLECKS * 3);
    for (let i = 0; i < FLECKS; i++) {
      fleck[i * 3] = R * (0.18 + 0.74 * Math.sqrt(rnd()));
      fleck[i * 3 + 1] = rnd() * TAU;
      fleck[i * 3 + 2] = rnd() * TAU;
    }

    flecks = new THREE.InstancedMesh(
      new THREE.SphereGeometry(FLECK_R, 8, 6),
      new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.2 }),
      FLECKS,
    );
    flecks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(flecks);

    const fc = emberColor(0.72);
    for (let i = 0; i < FLECKS; i++) flecks.setColorAt(i, fc);
    if (flecks.instanceColor) flecks.instanceColor.needsUpdate = true;
  },

  update(t) {
    const ph = (t / PERIOD) * TAU;
    const sw = Math.sin(ph);          // -1..1。渦の巻き量
    const rigid = t * RIGID;
    const sh = drift(t);

    ember(colA, TONE_A, sh);
    ember(colB, TONE_B, sh, 0.06);

    const arr = surfCol.array as Float32Array;
    const n = vr.length;
    for (let i = 0; i < n; i++) {
      const rn = vr[i] / R;
      const fall = 1 - rn * rn;                 // 中心ほど速く、縁は器に張り付いて動かない
      const a = vth[i] - TWIST * sw * fall - rigid;
      const w = EDGE + BLUR * Math.abs(sw) * fall;
      const c = smoothstep(w, Math.cos(a));
      arr[i * 3] = colA.r + (colB.r - colA.r) * c;
      arr[i * 3 + 1] = colA.g + (colB.g - colA.g) * c;
      arr[i * 3 + 2] = colA.b + (colB.b - colA.b) * c;
    }
    surfCol.needsUpdate = true;

    for (let i = 0; i < FLECKS; i++) {
      const r = fleck[i * 3];
      const rn = r / R;
      const a = fleck[i * 3 + 1] + TWIST * sw * (1 - rn * rn) + rigid;
      dummy.position.set(
        Math.cos(a) * r,
        0.05 + 0.03 * Math.sin(t * 0.9 + fleck[i * 3 + 2]),
        Math.sin(a) * r,
      );
      dummy.scale.setScalar(0.7 + 0.3 * Math.sin(t * 0.6 + fleck[i * 3 + 2]));
      dummy.updateMatrix();
      flecks.setMatrixAt(i, dummy.matrix);
    }
    flecks.instanceMatrix.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    const ph = t / PERIOD;
    const spin = Math.abs(Math.cos(ph * TAU));   // 渦がいちばん速く回っているとき 1
    sfx.drone(tone(0), 0.04 + 0.09 * spin);

    // 6 秒に 1 度、巻きと戻りの節目で水の音を置く
    for (let k = tick(ph * 4); k > 0; k--) {
      step++;
      if (step % 2 === 1) {
        sfx.air({ gain: 0.2, decay: 2.0, freq: 520, q: 1.1, sweep: -0.4 });
      } else {
        sfx.drop(tone(5 + (step % 5)), { gain: 0.22, decay: 0.9, pan: Math.sin(step * 1.7) * 0.4 });
      }
    }
  },
};
