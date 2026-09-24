import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { SURFACE, ember, drift } from '../palette.ts';

/**
 * Soap Carving — 石鹸を削る。
 *
 * 板にのせた石鹸の角ブロックの上面を、両手持ちの刃が端から端へ滑っていく。
 * 刃の前で薄い削りくずがくるくると巻き上がり、刃が通った跡には一段低い平らな面が残る。
 * 巻き終わった削りくずは脇へ転がり落ち、小さな山になっていく。
 * 6 本積んだら板ごと右へ流れ、左から色違いの新しい石鹸が入ってきて繰り返す（28 秒で一巡）。
 * 音は削っている間の擦れる息と、削りくずが落ちるときの柔らかい爪弾き。
 */

// --- 調整する数値 -----------------------------------------------------------

/** 1 ストロークの秒数 */
const P = 4;
/** 1 本の石鹸で削る回数（= 積む削りくずの本数。PILE の数と揃える） */
const K = 6;
/** 板ごと入れ替える秒数 */
const T_SWAP = 4;
/** 一巡の秒数 */
const CYCLE = K * P + T_SWAP;

/** ストローク内の区切り（秒） */
const T_DOWN = 0.5; // 刃が下りきる
const T_END = 3.0; // 刃が反対の端へ着く
const T_FALL = 0.8; // 削りくずが転がり落ちる時間

/** 石鹸の寸法。刃は x 方向へ滑る */
const X0 = -3.0;
const X1 = 1.4;
const SZ = 1.6;
const H0 = 2.0;
/** 角の丸み */
const ROUND = 0.16;
/** 1 回に削る厚み */
const D = 0.1;
/** 削る帯の幅（丸めた角の内側の平らなところ） */
const STRIP_W = SZ - 2 * ROUND + 0.02;

/** 板の上面は y = 0 */
const BOARD_X0 = -4.0;
const BOARD_X1 = 5.0;
const BOARD_Z = 3.8;
const BOARD_H = 0.3;

/** 入れ替えで板が流れる距離 */
const SWAP_DIST = 17;

/** 刃が待機する高さ */
const HOVER_Y = H0 + 0.55;
/** 刃が待機する x（石鹸の左端より手前） */
const HOVER_X = X0 - 1.2;
/** 刃の傾き（水平からの角度） */
const BLADE_LEAN = (24 * Math.PI) / 180;
const BLADE_LEN = 0.85;
const BLADE_W = 2.2;

/** 削りくずの渦巻き: r = CURL_A + CURL_B * φ */
const CURL_A = 0.15;
const CURL_B = 0.0227;
/** 削った長さのうち、巻きに回る割合（細く軽い巻きにするため） */
const CURL_SQUEEZE = 0.69;
const RIBBON_W = STRIP_W - 0.04;
const SEG = 160;
const TAIL = 6;
/** 渦巻きの外端の角度（中心から見て左下） */
const THETA_OUT = (-150 * Math.PI) / 180;

/** 石鹸の色（ember の n）。一巡ごとに順に替わる */
const SOAP_N = [0.95, 0.88, 1.0];
const SOAP_SHIFT = [0.0, 0.03, -0.025];
/** 明度の持ち上げ。白寄りのクリームにする */
const SOAP_GLOW = 0;

// --- 形の計算 ---------------------------------------------------------------

const smooth = (x: number): number => {
  const u = Math.min(1, Math.max(0, x));
  return u * u * (3 - 2 * u);
};
const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;

/** 長さ L を巻いたときの渦巻きの角度の総量 */
const curlPhi = (L: number): number =>
  (-CURL_A + Math.sqrt(CURL_A * CURL_A + 2 * CURL_B * L * CURL_SQUEEZE)) / CURL_B;
const curlR = (L: number): number => CURL_A + CURL_B * curlPhi(L);

const FULL_L = X1 - X0;
const FULL_R = curlR(FULL_L);

/**
 * 長さ L の削りくずの頂点を書き込む。原点は渦巻きの中心。
 * 刃先（渦巻きの中心から見て (-0.85r, -r - D)）から外端までを短い尾でつなぐ。
 */
function writeRibbon(pos: Float32Array, L: number): void {
  const phi = curlPhi(Math.max(L, 1e-4));
  const rOut = CURL_A + CURL_B * phi;
  const ox = rOut * Math.cos(THETA_OUT);
  const oy = rOut * Math.sin(THETA_OUT);
  const ex = -0.85 * rOut;
  const ey = -rOut - D;
  let v = 0;
  const put = (x: number, y: number): void => {
    pos[v++] = x;
    pos[v++] = y;
    pos[v++] = -RIBBON_W / 2;
    pos[v++] = x;
    pos[v++] = y;
    pos[v++] = RIBBON_W / 2;
  };
  for (let i = 0; i < TAIL; i++) {
    const u = i / TAIL;
    put(lerp(ex, ox, u), lerp(ey, oy, u));
  }
  // 外端から内へ
  for (let i = 0; i <= SEG; i++) {
    const f = phi * (1 - i / SEG);
    const r = CURL_A + CURL_B * f;
    const th = THETA_OUT - (phi - f);
    put(r * Math.cos(th), r * Math.sin(th));
  }
}

function ribbonGeometry(): THREE.BufferGeometry {
  const rows = TAIL + SEG + 1;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(rows * 2 * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const idx: number[] = [];
  for (let i = 0; i < rows - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  geo.setIndex(idx);
  return geo;
}

/** 転がり落ちた先 [x, y, z, yaw]。下に 4 つ、上に 2 つ。低く崩れた小山にする */
const PILE: [number, number, number, number][] = (() => {
  const r = FULL_R;
  const x = X1 + 0.3 + r;
  return [
    [x + 1.9, r, -0.35, 0.25],
    [x + 1.05, r, 0.55, -0.2],
    [x + 0.15, r, -0.2, 0.1],
    [x + 1.6, r, 1.35, 0.4],
    [x + 1.3, r * 2.55, 0.15, -0.35],
    [x + 0.55, r * 2.45, 0.9, 0.3],
  ];
})();

// --- 状態 -------------------------------------------------------------------

interface Tray {
  group: THREE.Group;
  mat: THREE.MeshStandardMaterial;
  body: THREE.Mesh;
  slab: THREE.Mesh;
}

let cur: Tray;
let nxt: Tray;
let active: THREE.Mesh;
let activeGeo: THREE.BufferGeometry;
let chips: THREE.Mesh[] = [];
let blade: THREE.Group;
let yawJitter: number[] = [];

const color = new THREE.Color();

let slideTick = ticker();
let fallTick = ticker();
let swapTick = ticker();
let step = 0;

function makeTray(root: THREE.Group): Tray {
  const group = new THREE.Group();
  root.add(group);

  const board = new THREE.Mesh(
    new THREE.BoxGeometry(BOARD_X1 - BOARD_X0, BOARD_H, BOARD_Z),
    new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.55, metalness: 0.2 }),
  );
  board.position.set((BOARD_X0 + BOARD_X1) / 2, -BOARD_H / 2, 0);
  group.add(board);

  const mat = new THREE.MeshStandardMaterial({
    roughness: 0.16,
    metalness: 0.0,
    side: THREE.DoubleSide,
  });

  // 本体は角を丸めた固定の形。削るたびに縮めるのではなく、板の中へ沈めて低くする
  const bodyGeo = new RoundedBoxGeometry(FULL_L, H0, SZ, 4, ROUND);
  bodyGeo.translate(FULL_L / 2, H0 / 2, 0);
  const body = new THREE.Mesh(bodyGeo, mat);
  body.position.x = X0;
  group.add(body);

  // これから削る 1 層。平らな上面に重ねる
  const slabGeo = new THREE.BoxGeometry(1, 1, STRIP_W);
  slabGeo.translate(0.5, 0.5, 0); // 左下の辺を原点に。x と y のスケールで伸ばす
  const slab = new THREE.Mesh(slabGeo, mat);
  group.add(slab);

  return { group, mat, body, slab };
}

/** 1 本の石鹸の姿。k = いま何回目のストロークか（K なら入れ替え中）、p = ストローク内の秒 */
function poseTray(tray: Tray, k: number, bx: number): void {
  const hk = H0 - k * D;
  if (k >= K) {
    tray.body.position.y = hk - H0;
    tray.slab.visible = false;
    return;
  }
  tray.body.position.y = hk - D - H0;
  const end = X1 - ROUND * 0.5;
  const sx = Math.min(end, Math.max(X0 + ROUND * 0.5, bx));
  const len = end - sx;
  tray.slab.visible = len > 1e-3;
  tray.slab.position.set(sx, hk - D, 0);
  tray.slab.scale.set(Math.max(len, 1e-3), D, 1);
}

function soapColor(tray: Tray, cycle: number, t: number): void {
  const i = ((cycle % SOAP_N.length) + SOAP_N.length) % SOAP_N.length;
  ember(color, SOAP_N[i], SOAP_SHIFT[i] + drift(t) * 0.5, SOAP_GLOW);
  tray.mat.color.copy(color);
}

/** 刃先の位置 [x, y]（ストローク k、ストローク内の秒 p） */
function bladeAt(k: number, p: number): [number, number] {
  const cut = H0 - k * D - D;
  const xs = HOVER_X;
  if (p < T_DOWN) {
    const u = smooth(p / T_DOWN);
    return [lerp(xs, X0, u), lerp(HOVER_Y, cut, u)];
  }
  if (p < T_END) {
    const u = smooth((p - T_DOWN) / (T_END - T_DOWN));
    return [lerp(X0, X1, u), cut];
  }
  const u = (p - T_END) / (P - T_END);
  const x = lerp(X1, xs, smooth((u - 0.2) / 0.8));
  const y = lerp(cut, HOVER_Y, smooth(u / 0.35));
  return [x, y];
}

/** 段階ごとの位相。ticker に渡すと、その出来事の回数を数えられる */
const stepPhase = (t: number, offset: number): number => {
  const c = Math.floor(t / CYCLE);
  const tc = t - c * CYCLE;
  return c * K + Math.min(K, Math.max(0, (tc - offset) / P + 1));
};

export const soapCarving: SceneModule = {
  name: 'Soap Carving',
  desc: '刃が石鹸の上面を滑り、削りくずがくるくる巻いて脇に積み上がっていく。',
  camera: { pos: [3.5, 7.2, 10.5], target: [0.3, 1.1, 0] },

  build(root) {
    slideTick = ticker();
    fallTick = ticker();
    swapTick = ticker();
    step = 0;

    cur = makeTray(root);
    nxt = makeTray(root);

    activeGeo = ribbonGeometry();
    active = new THREE.Mesh(activeGeo, cur.mat);
    cur.group.add(active);

    const fullGeo = ribbonGeometry();
    writeRibbon(fullGeo.getAttribute('position').array as Float32Array, FULL_L);
    fullGeo.computeVertexNormals();
    chips = [];
    for (let k = 0; k < K; k++) {
      const m = new THREE.Mesh(fullGeo, cur.mat);
      m.rotation.order = 'YXZ';
      cur.group.add(m);
      chips.push(m);
    }

    let s = 0.417;
    const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);
    yawJitter = Array.from({ length: K }, () => (rnd() - 0.5) * 0.16);

    // 刃: 刃先が原点、+x が刃の背へ向かう板。背に取っ手を渡す
    blade = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0xf0ddcc, roughness: 0.14, metalness: 0.45 });
    const plateGeo = new THREE.BoxGeometry(BLADE_LEN, 0.035, BLADE_W);
    plateGeo.translate(BLADE_LEN / 2, 0, 0);
    blade.add(new THREE.Mesh(plateGeo, steel));
    const wood = new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.7, metalness: 0.05 });
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, BLADE_W + 0.9, 20), wood);
    handle.rotation.x = Math.PI / 2;
    handle.position.x = BLADE_LEN;
    blade.add(handle);
    blade.rotation.z = Math.PI - BLADE_LEAN;
    root.add(blade);
  },

  update(t) {
    const c = Math.floor(t / CYCLE);
    const tc = t - c * CYCLE;
    const k = Math.min(K, Math.floor(tc / P));
    const p = tc - k * P;

    soapColor(cur, c, t);
    soapColor(nxt, c + 1, t);

    // 入れ替え
    const e = k >= K ? smooth((tc - K * P) / T_SWAP) : 0;
    cur.group.position.x = e * SWAP_DIST;
    nxt.group.position.x = -SWAP_DIST + e * SWAP_DIST;
    nxt.group.visible = e > 0;
    poseTray(nxt, 0, X0);

    // 刃
    let bx = X0;
    let by = HOVER_Y;
    if (k < K) [bx, by] = bladeAt(k, p);
    else bx = HOVER_X;
    blade.position.set(bx, by, 0);
    const sliding = k < K && p >= T_DOWN && p < T_END;
    poseTray(cur, k, p < T_DOWN ? X0 : p < T_END ? bx : X1);

    // 巻いている最中の削りくず
    active.visible = sliding && bx - X0 > 0.02;
    if (active.visible) {
      const L = bx - X0;
      const r = curlR(L);
      writeRibbon(activeGeo.getAttribute('position').array as Float32Array, L);
      activeGeo.getAttribute('position').needsUpdate = true;
      activeGeo.computeVertexNormals();
      activeGeo.computeBoundingSphere();
      active.position.set(bx + 0.85 * r, H0 - k * D + r, 0);
    }

    // 巻き終わった削りくず: 転がり落ちて積み上がる
    for (let j = 0; j < K; j++) {
      const m = chips[j];
      const done = j < k || (j === k && p >= T_END);
      m.visible = done;
      if (!done) continue;
      const sx = X1 + 0.85 * FULL_R;
      const sy = H0 - j * D + FULL_R;
      const [rx, ry, rz, yaw] = PILE[j];
      const u = j < k ? 1 : Math.min(1, (p - T_END) / T_FALL);
      const ue = smooth(u);
      const x = lerp(sx, rx, ue);
      const y = lerp(sy, ry, u * u) + 0.45 * 4 * u * (1 - u);
      m.position.set(x, y, rz * ue);
      m.rotation.y = (yaw + yawJitter[j]) * ue;
      m.rotation.z = -(x - sx) / FULL_R;
    }
  },

  sound(t, _dt, sfx) {
    // 刃が石鹸に当たって滑り出す
    for (let n = slideTick(stepPhase(t, T_DOWN)); n > 0; n--) {
      step++;
      sfx.air({ gain: 0.22, decay: 2.4, freq: 1400, q: 0.9, sweep: 0.7 });
    }
    // 削りくずが積み山に落ちる
    for (let n = fallTick(stepPhase(t, T_END + T_FALL * 0.8)); n > 0; n--) {
      sfx.pluck(tone(9 + (step % 4)), { gain: 0.22, decay: 1.2, pan: 0.35 });
    }
    // 板ごと入れ替わる
    for (let n = swapTick((t - K * P) / CYCLE + 1); n > 0; n--) {
      sfx.drop(tone(2), { gain: 0.3, decay: 0.9, bend: 0.8 });
    }
  },
};
