import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { SURFACE, ember, drift } from '../palette.ts';

/**
 * Internet。
 *
 * 床に描かれた小さなネットワーク（中央のハブ・内側 6 台・外側 12 台のルーター）の上を、
 * 光の粒（パケット）が一斉に 1 ホップずつ跳ねていく。全員が同じ拍で動き出し、
 * 同じ拍でノードに滑り込んで止まるので、網全体が時計のように「カチッ」と刻む。
 * 各パケットは自宅の端末からハブを経由して別の端末へ行き、また戻ってくる往復を
 * 6 秒で 1 巡する。行き先は巡ごとに固定シードで選び直すので、経路は毎巡少しずつ変わる。
 *
 * 何が動くか: 経路をホップするパケット、通過中の線と到着したノードの灯り
 * 気持ちよさの芯: 全パケットが同じ拍でノードに吸い込まれて止まる、そろった刻み
 * ループの周期: 1 ホップ 0.75 秒 / 8 ホップ（往復）で 6 秒
 * カメラ: 斜め上からの俯瞰
 * 音: 拍ごとに 1 音。ハブに届いた拍だけ少し明るく鳴らす
 * スコープ外: 地球儀・大陸の形、文字やアイコン、パケットの衝突や混雑
 */

// ---- 調整用の定数 ---------------------------------------------------------

/** 内側リングの半径 */
const R1 = 3.1;
/** 外側リングの半径 */
const R2 = 6.6;
/** 内側リングの台数（外側はその 2 倍） */
const N1 = 6;
const N2 = N1 * 2;
/** パケットの数 */
const PACKETS = 10;
/** 1 ホップの秒数 */
const HOP = 0.75;
/** ホップのうち移動に使う割合。残りはノードで止まっている */
const MOVE = 0.66;
/** パケットの残像の数と間隔（ホップ単位） */
const GHOSTS = 4;
const GHOST_LAG = 0.028;
/** パケットの浮く高さと、ホップ中の弧の高さ */
const PACKET_Y = 0.32;
const ARC = 0.55;
/** 大きさ */
const PACKET_R = 0.16;
const NODE_R = 0.42;
const HUB_R = 0.8;
const EDGE_W = 0.055;
/** 到着の灯りが引く速さ */
const GLOW_DECAY = 4.2;

// ---- 網の形 --------------------------------------------------------------

const HUB = 0;
const ring1 = (k: number): number => 1 + (((k % N1) + N1) % N1);
const ring2 = (j: number): number => 1 + N1 + (((j % N2) + N2) % N2);
/** 外側のノード j がぶら下がる内側のノード */
const parentOf = (j: number): number => ring1(Math.floor(j / 2));

const NODE_COUNT = 1 + N1 + N2;
/** ノードの [x, z] */
const nodePos = new Float32Array(NODE_COUNT * 2);
{
  for (let k = 0; k < N1; k++) {
    const a = (k / N1) * Math.PI * 2 + Math.PI / N2 / 2;
    nodePos[ring1(k) * 2] = Math.cos(a) * R1;
    nodePos[ring1(k) * 2 + 1] = Math.sin(a) * R1;
  }
  for (let j = 0; j < N2; j++) {
    const a = (j / N2) * Math.PI * 2;
    nodePos[ring2(j) * 2] = Math.cos(a) * R2;
    nodePos[ring2(j) * 2 + 1] = Math.sin(a) * R2;
  }
}

/** 線の [ノード a, ノード b] */
const edges: [number, number][] = [];
for (let k = 0; k < N1; k++) edges.push([HUB, ring1(k)]);
for (let j = 0; j < N2; j++) edges.push([parentOf(j), ring2(j)]);
for (let k = 0; k < N1; k++) edges.push([ring1(k), ring1(k + 1)]);
for (let j = 0; j < N2; j++) edges.push([ring2(j), ring2(j + 1)]);
const edgeKey = (a: number, b: number): number => Math.min(a, b) * 64 + Math.max(a, b);
const edgeIndex = new Map<number, number>();
edges.forEach(([a, b], i) => edgeIndex.set(edgeKey(a, b), i));

// ---- パケット --------------------------------------------------------------

/** パケットごとの自宅（外側リングの番号）と、拍のずれ */
const home = new Int32Array(PACKETS);
const offset = new Int32Array(PACKETS);
{
  let s = 0.731;
  const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);
  for (let k = 0; k < PACKETS; k++) {
    home[k] = Math.floor(rnd() * N2);
    offset[k] = Math.floor(rnd() * 8);
  }
}

/** パケット k が c 巡目に向かう外側ノードの番号。t だけで決まるよう、ハッシュで引く */
function target(k: number, c: number): number {
  const h = Math.sin(k * 12.9898 + c * 78.233) * 43758.5453;
  const r = h - Math.floor(h);
  // 自宅と同じ枝（同じ親）には行かない
  const j = home[k] + 2 + Math.floor(r * (N2 - 3));
  return ((j % N2) + N2) % N2;
}

/** 8 ホップの往復経路。path[8] は path[0] に戻る */
const path = new Int32Array(9);
function fillPath(k: number, c: number): void {
  const a = home[k];
  const b = target(k, c);
  path[0] = ring2(a);
  path[1] = parentOf(a);
  path[2] = HUB;
  path[3] = parentOf(b);
  path[4] = ring2(b);
  path[5] = parentOf(b);
  path[6] = HUB;
  path[7] = parentOf(a);
  path[8] = ring2(a);
}

const smooth = (x: number): number => {
  const u = Math.min(1, Math.max(0, x));
  return u * u * u * (u * (u * 6 - 15) + 10);
};

/** ホップ内の経過 frac から、移動の進み具合 0..1 */
const ease = (frac: number): number => smooth(frac / MOVE);

const dummy = new THREE.Object3D();
const color = new THREE.Color();
const nodeGlow = new Float32Array(NODE_COUNT);
const edgeGlow = new Float32Array(edges.length);

let packetMesh: THREE.InstancedMesh;
let capMesh: THREE.InstancedMesh;
let edgeMesh: THREE.InstancedMesh;

let tick = ticker();
let beat = 0;

/** s（ホップ単位の時刻）のパケットの位置を dummy に書く */
function placePacket(k: number, s: number): void {
  const c = Math.floor(s / 8);
  fillPath(k, c);
  const hs = s - c * 8;
  const h = Math.floor(hs);
  const p = ease(hs - h);
  const a = path[h];
  const b = path[h + 1];
  const ax = nodePos[a * 2];
  const az = nodePos[a * 2 + 1];
  const bx = nodePos[b * 2];
  const bz = nodePos[b * 2 + 1];
  dummy.position.set(
    ax + (bx - ax) * p,
    PACKET_Y + Math.sin(Math.PI * p) * ARC,
    az + (bz - az) * p,
  );
}

export const internet: SceneModule = {
  name: 'Internet',
  desc: '光のパケットが網の上を一斉に 1 ホップずつ跳ね、同じ拍でルーターに吸い込まれる。',
  camera: { pos: [0, 12.5, 12.5], target: [0, 0, 0.4] },

  build(root) {
    tick = ticker();
    beat = 0;

    // 床
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(R2 * 1.3, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.45, metalness: 0.55 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    root.add(floor);

    // ノードの台座（光らない）
    const baseGeo = new THREE.CylinderGeometry(1, 1.08, 1, 32);
    baseGeo.translate(0, 0.5, 0);
    const baseMesh = new THREE.InstancedMesh(
      baseGeo,
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.45, metalness: 0.6 }),
      NODE_COUNT,
    );
    for (let i = 0; i < NODE_COUNT; i++) {
      const r = i === HUB ? HUB_R : NODE_R;
      dummy.position.set(nodePos[i * 2], 0, nodePos[i * 2 + 1]);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(r, i === HUB ? 0.34 : 0.2, r);
      dummy.updateMatrix();
      baseMesh.setMatrixAt(i, dummy.matrix);
    }
    root.add(baseMesh);

    // ノードの上面の灯り
    const capGeo = new THREE.CylinderGeometry(1, 1, 0.04, 32);
    capMesh = new THREE.InstancedMesh(capGeo, new THREE.MeshBasicMaterial(), NODE_COUNT);
    capMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(capMesh);

    // 線
    const edgeGeo = new THREE.BoxGeometry(1, 0.02, EDGE_W);
    edgeMesh = new THREE.InstancedMesh(edgeGeo, new THREE.MeshBasicMaterial(), edges.length);
    edges.forEach(([a, b], i) => {
      const ax = nodePos[a * 2];
      const az = nodePos[a * 2 + 1];
      const bx = nodePos[b * 2];
      const bz = nodePos[b * 2 + 1];
      dummy.position.set((ax + bx) / 2, 0.03, (az + bz) / 2);
      dummy.rotation.set(0, -Math.atan2(bz - az, bx - ax), 0);
      dummy.scale.set(Math.hypot(bx - ax, bz - az), 1, 1);
      dummy.updateMatrix();
      edgeMesh.setMatrixAt(i, dummy.matrix);
    });
    root.add(edgeMesh);

    // パケットと残像
    packetMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(PACKET_R, 16, 12),
      new THREE.MeshBasicMaterial(),
      PACKETS * (1 + GHOSTS),
    );
    packetMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(packetMesh);
  },

  update(t) {
    const hue = drift(t);
    nodeGlow.fill(0);
    edgeGlow.fill(0);

    for (let k = 0; k < PACKETS; k++) {
      const s = t / HOP + offset[k];

      // 本体と残像
      for (let g = 0; g <= GHOSTS; g++) {
        placePacket(k, s - g * GHOST_LAG);
        const sc = 1 - g * 0.17;
        dummy.rotation.set(0, 0, 0);
        dummy.scale.setScalar(sc);
        dummy.updateMatrix();
        const idx = k * (1 + GHOSTS) + g;
        packetMesh.setMatrixAt(idx, dummy.matrix);
        ember(color, 0.9 - g * 0.16, hue, -0.04 - g * 0.03);
        packetMesh.setColorAt(idx, color);
      }

      // 今いるホップの線と、到着したノードの灯り
      const c = Math.floor(s / 8);
      fillPath(k, c);
      const hs = s - c * 8;
      const h = Math.floor(hs);
      const frac = hs - h;
      const p = ease(frac);
      const e = edgeIndex.get(edgeKey(path[h], path[h + 1]));
      if (e !== undefined) edgeGlow[e] = Math.max(edgeGlow[e], Math.sin(Math.PI * p));
      // path[h] には (1 - MOVE) ホップ前に着いている
      nodeGlow[path[h]] += Math.exp(-(frac + 1 - MOVE) * GLOW_DECAY);
      if (frac > MOVE) nodeGlow[path[h + 1]] += Math.exp(-(frac - MOVE) * GLOW_DECAY);
    }

    for (let i = 0; i < NODE_COUNT; i++) {
      // ハブは面積が大きいので一段暗く灯す
      const g = Math.min(1, nodeGlow[i]) * (i === HUB ? 0.55 : 0.8);
      const r = (i === HUB ? HUB_R : NODE_R) * 0.86;
      const top = i === HUB ? 0.34 : 0.2;
      dummy.position.set(nodePos[i * 2], top + 0.02, nodePos[i * 2 + 1]);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(r * (1 + g * 0.08), 1, r * (1 + g * 0.08));
      dummy.updateMatrix();
      capMesh.setMatrixAt(i, dummy.matrix);
      ember(color, 0.12 + g * 0.75, hue, -0.08 * g);
      capMesh.setColorAt(i, color);
    }

    for (let i = 0; i < edges.length; i++) {
      const g = edgeGlow[i];
      ember(color, 0.05 + g * 0.55, hue, g * 0.04 - 0.02);
      edgeMesh.setColorAt(i, color);
    }

    packetMesh.instanceMatrix.needsUpdate = true;
    capMesh.instanceMatrix.needsUpdate = true;
    if (packetMesh.instanceColor) packetMesh.instanceColor.needsUpdate = true;
    if (capMesh.instanceColor) capMesh.instanceColor.needsUpdate = true;
    if (edgeMesh.instanceColor) edgeMesh.instanceColor.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    // パケットがノードに着く瞬間（ホップの MOVE 地点）を拍として数える
    for (let n = tick(t / HOP - MOVE); n > 0; n--) {
      const b = beat++;
      let atHub = 0;
      for (let k = 0; k < PACKETS; k++) {
        const m = (((b + offset[k]) % 8) + 8) % 8;
        if (m === 1 || m === 5) atHub++;
      }
      const hub = atHub > 0;
      sfx.pluck(tone((hub ? 9 : 4) + (b % 4) + (b % 8 < 4 ? 0 : 1)), {
        gain: hub ? 0.28 : 0.14,
        decay: hub ? 2.0 : 1.2,
        pan: Math.sin(b * 0.9) * 0.4,
      });
    }
  },
};
