import * as THREE from 'three';
import type { SceneModule } from '../../types.ts';
import { tone, ticker } from '../../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../../palette.ts';

/**
 * Soap Carving — 石鹸を削る（ASMR の定番「格子切り」）。
 *
 * 板にのせた淡い色の石鹸キューブの正面に、細いカッターが縦 7 本・横 7 本の切り込みを
 * 1 本ずつ引いて碁盤の目を刻む。続いて大きな包丁がその面のすぐ内側を上から下へ削ぎ下ろし、
 * 刃が通った段から小さなサイコロがぽろぽろと崩れ落ちて、手前に小山を作る。
 * これを 3 層くり返したら板ごと右へ流れ、左から色違いの新しい石鹸が入ってくる（28 秒で一巡）。
 * 音は切り込みの擦れる音と、サイコロが落ちるたびの小さな爪弾き。
 */

// --- 調整する数値 -----------------------------------------------------------

/** 石鹸キューブの一辺と、正面の格子の分割数 */
const S = 3;
const GRID = 8;
const CELL = S / GRID;

/** 1 本の石鹸で削る層の数 */
const LAYERS = 3;
/** 1 層の秒数 */
const P = 8;
/** 板ごと入れ替える秒数 */
const T_SWAP = 4;
const CYCLE = LAYERS * P + T_SWAP;

/** 層の中の区切り（秒） */
const T_SCORE0 = 0.6; // 切り込みを引きはじめる
const LINE_DUR = 0.3; // 1 本あたり（引く 0.22 + 次へ移る 0.08）
const LINE_DRAW = 0.22;
const LINES = (GRID - 1) * 2;
const T_SCORE1 = T_SCORE0 + LINES * LINE_DUR; // 4.8
const T_SLICE0 = 5.2; // 包丁が上端に着く
const T_SLICE1 = 7.0; // 包丁が板に着く
/** 包丁・カッターが待機する高さ（画面の外） */
const TOOL_UP = S + 6;
/** 包丁の刃の高さ（低いほど正面を隠さない） */
const KNIFE_H = 0.7;

/** 落ちるサイコロ */
const GRAVITY = 14;
const GAP = 0.94;
/** 同じ段の中で列ごとに離れる時刻をずらす幅（秒）。一度にどさっと落とさない */
const RELEASE_STAGGER = 0.06; // 削いだあとのサイコロの大きさ（隙間が格子に見える）

/** 板（上面が y = 0） */
const BOARD_X0 = -2.6;
const BOARD_X1 = 2.6;
const BOARD_Z0 = -1.9;
const BOARD_Z1 = 3.6;
const BOARD_H = 0.3;
const SWAP_DIST = 14;

/** 石鹸の色: ember の n と、淡くするために混ぜる暖かい白と、その割合 */
const SOAP_N = [0.12, 0.3, 0.97];
const SOAP_SHIFT = [0.0, 0.02, -0.02];
const SOAP_PALE = new THREE.Color(0xfff0ea);
const SOAP_PALE_MIX = 0.82;
/**
 * 上を向いた面だけに掛ける陰。天面は平行光をまともに受けてブルームでにじむので、
 * 正面を淡いまま保ちつつ、天面だけしきい値の下へ抑える
 */
const TOP_SHADE = 0.62;
/** 切り込みの溝の暗さ（石鹸色に掛ける） */
const GROOVE_DARK = 0.5;
/** 溝の太さと、面から出す厚み */
const GROOVE_W = 0.05;
const GROOVE_D = 0.02;

// --- 小道具 -----------------------------------------------------------------

const smooth = (x: number): number => {
  const u = Math.min(1, Math.max(0, x));
  return u * u * (3 - 2 * u);
};
const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;

/** 層 j を削る前の、石鹸の正面の z */
const frontZ = (j: number): number => S / 2 - j * CELL;

const CELLS = GRID * GRID;
const CUBES = CELLS * LAYERS;

/** サイコロごとの [離れる時刻の遅れ, vx, vz, 休む高さ, 回転 x, yaw, 回転 z] */
const FALL = new Float32Array(CUBES * 7);

interface Tray {
  group: THREE.Group;
  mat: THREE.MeshStandardMaterial;
  grooveMat: THREE.MeshStandardMaterial;
  body: THREE.Mesh;
  cubes: THREE.InstancedMesh;
  grooves: THREE.InstancedMesh;
}

let cur: Tray;
let nxt: Tray;
let cutter: THREE.Group;
let knife: THREE.Group;

const dummy = new THREE.Object3D();
const color = new THREE.Color();

let lineTick = ticker();
let rowTick = ticker();
let swapTick = ticker();

/** 上を向いた面の頂点だけ TOP_SHADE で暗くする頂点カラーを付ける */
function shadeTop(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = geo.getAttribute('normal');
  const c = new Float32Array(n.count * 3);
  for (let i = 0; i < n.count; i++) {
    const k = n.getY(i) > 0.5 ? TOP_SHADE : 1;
    c[i * 3] = k;
    c[i * 3 + 1] = k;
    c[i * 3 + 2] = k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

function makeTray(root: THREE.Group): Tray {
  const group = new THREE.Group();
  root.add(group);

  const board = new THREE.Mesh(
    new THREE.BoxGeometry(BOARD_X1 - BOARD_X0, BOARD_H, BOARD_Z1 - BOARD_Z0),
    new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.6, metalness: 0.15 }),
  );
  board.position.set((BOARD_X0 + BOARD_X1) / 2, -BOARD_H / 2, (BOARD_Z0 + BOARD_Z1) / 2);
  group.add(board);

  const mat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.0, vertexColors: true });
  const grooveMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.0 });

  // 本体: 背面から「いま削っている層」の手前までの直方体。z のスケールで奥行きを変える
  const bodyGeo = shadeTop(new THREE.BoxGeometry(S, S, 1));
  bodyGeo.translate(0, S / 2, 0.5); // 背面を原点に
  const body = new THREE.Mesh(bodyGeo, mat);
  body.position.z = -S / 2;
  group.add(body);

  const cubes = new THREE.InstancedMesh(shadeTop(new THREE.BoxGeometry(CELL, CELL, CELL)), mat, CUBES);
  cubes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // 最初のフレームの配置で包み球が決まってしまうので、視錐台カリングを切る
  cubes.frustumCulled = false;
  group.add(cubes);

  // 切り込み: 縦 7 本・横 7 本の細い溝。長さを伸ばして「引いている」ように見せる
  const grooves = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), grooveMat, LINES);
  grooves.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  grooves.frustumCulled = false;
  group.add(grooves);

  return { group, mat, grooveMat, body, cubes, grooves };
}

function soapColor(tray: Tray, cycle: number, t: number): void {
  const i = ((cycle % SOAP_N.length) + SOAP_N.length) % SOAP_N.length;
  ember(color, SOAP_N[i], SOAP_SHIFT[i] + drift(t) * 0.5);
  color.lerp(SOAP_PALE, SOAP_PALE_MIX);
  tray.mat.color.copy(color);
  tray.grooveMat.color.copy(color).multiplyScalar(GROOVE_DARK);
}

/** 切り込み i 本目の [始点 x, 始点 y, 終点 x, 終点 y]。縦は上から下、横は左から右 */
function lineEnds(i: number): [number, number, number, number] {
  if (i < GRID - 1) {
    const x = -S / 2 + (i + 1) * CELL;
    return [x, S, x, 0];
  }
  const y = S - (i - (GRID - 1) + 1) * CELL;
  return [-S / 2, y, S / 2, y];
}

/**
 * 1 本の石鹸の姿。layer = いま削っている層（LAYERS なら入れ替え中）、p = 層の中の秒。
 */
function poseTray(tray: Tray, layer: number, p: number): void {
  const L = Math.min(layer, LAYERS);
  // 本体は「いまの層」の背後まで。入れ替え中は削り終えた面まで
  const bodyFront = L < LAYERS ? frontZ(L) - CELL : frontZ(LAYERS);
  tray.body.scale.z = bodyFront + S / 2;

  const sliceY = S - Math.min(1, Math.max(0, (p - T_SLICE0) / (T_SLICE1 - T_SLICE0))) * S;
  const slicing = L < LAYERS && p >= T_SLICE0;

  for (let j = 0; j < LAYERS; j++) {
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        const idx = j * CELLS + r * GRID + c;
        const x0 = -S / 2 + (c + 0.5) * CELL;
        const y0 = S - (r + 0.5) * CELL;
        const z0 = frontZ(j) - CELL / 2;
        dummy.rotation.set(0, 0, 0);

        if (j > L || (j === L && L >= LAYERS)) {
          dummy.position.set(0, -10, 0);
          dummy.scale.setScalar(0.0001);
        } else if (j === L && !slicing) {
          // 削ぐ前: 隙間なく詰めて、1 枚の面に見せる
          dummy.position.set(x0, y0, z0);
          dummy.scale.setScalar(1);
        } else {
          const f = idx * 7;
          // 刃が段の下端を通り過ぎた瞬間に離れる
          const release = T_SLICE0 + ((r + 1) / GRID) * (T_SLICE1 - T_SLICE0) + FALL[f];
          const tau = j < L ? 99 : p - release;
          const g = 1 - (j === L ? smooth((S - sliceY - r * CELL) / CELL) : 1);
          dummy.scale.setScalar(lerp(GAP, 1, g));
          if (tau <= 0) {
            dummy.position.set(x0, y0, z0);
          } else {
            const yRest = FALL[f + 3];
            const tl = Math.sqrt((2 * Math.max(0, y0 - yRest)) / GRAVITY);
            const tc = Math.min(tau, tl);
            const u = tl > 0 ? tc / tl : 1;
            dummy.position.set(
              x0 + FALL[f + 1] * tc,
              Math.max(yRest, y0 - 0.5 * GRAVITY * tc * tc),
              z0 + FALL[f + 2] * tc,
            );
            dummy.rotation.set(FALL[f + 4] * u, FALL[f + 5] * u, FALL[f + 6] * u);
          }
        }
        dummy.updateMatrix();
        tray.cubes.setMatrixAt(idx, dummy.matrix);
      }
    }
  }
  tray.cubes.instanceMatrix.needsUpdate = true;

  // 切り込みの溝
  const zf = L < LAYERS ? frontZ(L) : 0;
  for (let i = 0; i < LINES; i++) {
    const [ax, ay, bx] = lineEnds(i);
    const vertical = ax === bx;
    let u = L < LAYERS ? smooth((p - T_SCORE0 - i * LINE_DUR) / LINE_DRAW) : 0;
    let top = ay;
    if (slicing) {
      // 削いでいる間は、刃がまだ通っていない段の溝だけを残す
      if (vertical) {
        top = sliceY;
        u = sliceY / S;
      } else if (ay > sliceY - CELL * 0.5) {
        u = 0;
      }
    }
    const len = u * S;
    if (len < 1e-3) {
      dummy.position.set(0, -10, 0);
      dummy.scale.setScalar(0.0001);
    } else if (vertical) {
      dummy.position.set(ax, top - len / 2, zf + GROOVE_D / 2);
      dummy.scale.set(GROOVE_W, len, GROOVE_D);
    } else {
      dummy.position.set(ax + len / 2, ay, zf + GROOVE_D / 2);
      dummy.scale.set(len, GROOVE_W, GROOVE_D);
    }
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    tray.grooves.setMatrixAt(i, dummy.matrix);
  }
  tray.grooves.instanceMatrix.needsUpdate = true;
}

/** カッターの刃先の位置（層 L、層の中の秒 p） */
function cutterAt(L: number, p: number): [number, number, number] {
  const zf = frontZ(L);
  const [sx, sy] = lineEnds(0);
  if (p < T_SCORE0) {
    const u = smooth(p / T_SCORE0);
    return [sx, lerp(TOOL_UP, sy, u), zf + 0.25 * (1 - u)];
  }
  if (p < T_SCORE1) {
    const i = Math.floor((p - T_SCORE0) / LINE_DUR);
    const q = p - T_SCORE0 - i * LINE_DUR;
    const [ax, ay, bx, by] = lineEnds(i);
    if (q < LINE_DRAW) {
      const u = smooth(q / LINE_DRAW);
      return [lerp(ax, bx, u), lerp(ay, by, u), zf];
    }
    // 次の線の始点へ、刃先を浮かせて移る
    const [nx, ny] = i + 1 < LINES ? lineEnds(i + 1) : [bx, by + 1.5];
    const u = smooth((q - LINE_DRAW) / (LINE_DUR - LINE_DRAW));
    return [lerp(bx, nx, u), lerp(by, ny, u), zf + Math.sin(Math.PI * u) * 0.3];
  }
  // 刻み終えたら、右上の画面外へすばやく退く
  const u = smooth((p - T_SCORE1) / 0.3);
  return [S / 2 + u * 4, lerp(S - (GRID - 1) * CELL + 1.5, TOOL_UP, u), zf + 0.3];
}

/** 包丁の刃先の高さ（層の中の秒 p） */
function knifeY(p: number): number {
  if (p < T_SLICE0 - 0.6) return TOOL_UP;
  if (p < T_SLICE0) return lerp(TOOL_UP, S + 0.02, smooth((p - (T_SLICE0 - 0.6)) / 0.6));
  // 削いでいる間は等速。サイコロが離れる時刻と刃の位置を一致させる
  if (p < T_SLICE1) return S - ((p - T_SLICE0) / (T_SLICE1 - T_SLICE0)) * S;
  return lerp(0, TOOL_UP, smooth((p - T_SLICE1) / (P - T_SLICE1)));
}

/** 出来事が起きた回数（単調に増える）。ticker に渡すと鳴らす回数が分かる */
function eventPhase(t: number, count: (p: number) => number, perLayer: number): number {
  const c = Math.floor(t / CYCLE);
  const tc = t - c * CYCLE;
  const L = Math.floor(tc / P);
  if (L >= LAYERS) return (c + 1) * LAYERS * perLayer;
  return (c * LAYERS + L) * perLayer + count(tc - L * P);
}

export const soapCarving: SceneModule = {
  name: 'Soap Carving',
  desc: '石鹸の面に碁盤の目を刻み、包丁で削ぐと小さなサイコロがぽろぽろ崩れ落ちる。',
  camera: { pos: [6.2, 7.4, 8.6], target: [0, 1.1, 0.8] },

  build(root) {
    lineTick = ticker();
    rowTick = ticker();
    swapTick = ticker();

    let s = 0.583;
    const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);
    for (let i = 0; i < CUBES; i++) {
      const f = i * 7;
      const j = Math.floor(i / CELLS);
      FALL[f] = (i % GRID) * RELEASE_STAGGER + rnd() * 0.1;
      FALL[f + 1] = (rnd() - 0.5) * 0.9;
      FALL[f + 2] = 0.5 + rnd() * 1.4;
      FALL[f + 3] = CELL / 2 + rnd() * 0.12 * (j + 1);
      // 落ちる間に 1 回転するか、しないか。着地では元の上面が上に戻るので、
      // 陰を付けた面が上を向き、山が本体より明るく光らない
      FALL[f + 4] = rnd() < 0.5 ? 0 : Math.PI * 2;
      FALL[f + 5] = (rnd() - 0.5) * 1.6;
      FALL[f + 6] = 0;
    }

    cur = makeTray(root);
    nxt = makeTray(root);

    const steel = new THREE.MeshStandardMaterial({ color: 0xe2d6cc, roughness: 0.25, metalness: 0.25 });
    const grip = new THREE.MeshStandardMaterial({ color: emberColor(0.25), roughness: 0.7, metalness: 0.05 });

    // カッター: 刃先が原点。刃は手前（+z）の斜め上へ伸び、その先に柄
    cutter = new THREE.Group();
    const arm = new THREE.Group();
    arm.rotation.x = -0.6;
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.6), steel);
    blade.position.set(0, 0.04, 0.3);
    arm.add(blade);
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.8, 16), grip);
    handle.rotation.x = Math.PI / 2;
    handle.position.set(0, 0.04, 1.5);
    arm.add(handle);
    cutter.add(arm);
    root.add(cutter);

    // 包丁: 刃先（下辺）が原点の薄い板。柄は右へ
    knife = new THREE.Group();
    const plate = new THREE.Mesh(new THREE.BoxGeometry(S + 1.0, KNIFE_H, 0.025), steel);
    plate.position.set(0.2, KNIFE_H / 2, 0);
    knife.add(plate);
    const kHandle = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.6, 16), grip);
    kHandle.rotation.z = Math.PI / 2;
    kHandle.position.set(0.2 + (S + 1.0) / 2 + 0.8, KNIFE_H * 0.7, 0);
    knife.add(kHandle);
    root.add(knife);
  },

  update(t) {
    const c = Math.floor(t / CYCLE);
    const tc = t - c * CYCLE;
    const L = Math.min(LAYERS, Math.floor(tc / P));
    const p = tc - L * P;

    soapColor(cur, c, t);
    soapColor(nxt, c + 1, t);

    const e = L >= LAYERS ? smooth((tc - LAYERS * P) / T_SWAP) : 0;
    cur.group.position.x = e * SWAP_DIST;
    nxt.group.position.x = -SWAP_DIST + e * SWAP_DIST;
    nxt.group.visible = e > 0;

    poseTray(cur, L, p);
    poseTray(nxt, 0, 0);

    if (L < LAYERS) {
      const [x, y, z] = cutterAt(L, p);
      cutter.position.set(x, y, z);
      knife.position.set(0, knifeY(p), frontZ(L) - CELL);
    } else {
      cutter.position.set(S / 2, TOOL_UP, frontZ(0));
      knife.position.set(0, TOOL_UP, frontZ(0) - CELL);
    }
  },

  sound(t, _dt, sfx) {
    // 切り込みを 1 本引くごと
    const lines = (p: number): number =>
      Math.min(LINES, Math.max(0, Math.floor((p - T_SCORE0) / LINE_DUR + 1)));
    for (let n = lineTick(eventPhase(t, lines, LINES)); n > 0; n--) {
      sfx.air({ gain: 0.12, decay: 0.25, freq: 2600, q: 2.2 });
    }
    // サイコロが 1 段崩れ落ちるごと
    const rows = (p: number): number =>
      Math.min(GRID, Math.max(0, Math.floor(((p - T_SLICE0) / (T_SLICE1 - T_SLICE0)) * GRID)));
    for (let n = rowTick(eventPhase(t, rows, GRID)); n > 0; n--) {
      const k = Math.floor(t * 7) % 5;
      sfx.pluck(tone(10 + k), { gain: 0.16, decay: 0.6, pan: (k - 2) * 0.15 });
    }
    // 板ごと入れ替わる
    for (let n = swapTick((t - LAYERS * P) / CYCLE + 1); n > 0; n--) {
      sfx.drop(tone(2), { gain: 0.3, decay: 0.9, bend: 0.8 });
    }
  },
};
