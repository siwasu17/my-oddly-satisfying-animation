import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * Mission Impossible。天井から吊るされて金庫室へ降りる、あの場面。
 *
 * 天井の蓋が開き、ワイヤーに吊られた人影が降りてくる。途中には赤いレーザーが 3 段、
 * 格子を組んで左右・前後に掃いている。人影は各段の上でぴたりと止まって待ち、
 * 隙間が真下を通る瞬間にだけ一気に抜ける。台座の宝石を手に取ると同じ隙間を逆にたどって昇り、
 * 蓋が閉じる。台座の奥から次の宝石がせり上がって 24 秒で一巡する。
 * 音は隙間を抜ける風切りと爪弾き、蓋の低い音、宝石を取った瞬間の和音、レーザーのかすかな唸り。
 */

// --- 調整する数値 ---------------------------------------------------------

/** 1 周の秒数（レーザーの往復 4 秒の倍数にする） */
const CYCLE = 24;
/** レーザーが 1 往復する秒数。奇数秒ちょうどに隙間が中心を通る */
const SWEEP = 4;
/** レーザー格子の段の高さ（上から） */
const LAYERS = [10.5, 7.5, 4.5];
/** 1 段あたりのレーザーの本数と間隔。中央の 2 本の間が人の抜ける隙間 */
const BEAMS = 4;
const GAP = 2.6;
/** レーザーの長さ（レールからレールまで）と太さ */
const BEAM_LEN = 9.6;
const BEAM_R = 0.028;
/** レーザーの明るさ（ember の n と glow） */
const BEAM_N = 0.22;
const BEAM_GLOW = 0.3;

/** 天井の高さと、蓋の開口の一辺 */
const CEIL_Y = 13.6;
const HATCH = 1.8;

/** 人影の足元の高さの時刻表 [秒, y]。同じ y が続く区間は静止 */
const PATH: [number, number][] = [
  [0, 15.5], [1.0, 15.5], [2.6, 11],
  [2.7, 11], [3.3, 8], // 1 段目を 3 秒で抜ける
  [6.7, 8], [7.3, 5], // 2 段目は 1 回見送って 7 秒で抜ける
  [8.7, 5], [9.3, 2], // 3 段目を 9 秒で抜ける
  [12.7, 2], [13.3, 5],
  [14.7, 5], [15.3, 8],
  [16.7, 8], [17.3, 11],
  [17.6, 11], [19.2, 15.5], [CYCLE, 15.5],
];

/** 蓋の開閉の時刻 */
const HATCH_OPEN: [number, number] = [0.1, 1.0];
const HATCH_CLOSE: [number, number] = [19.4, 20.4];
/** 宝石を手に取る時刻と、次の宝石がせり上がる時刻 */
const GEM_LIFT: [number, number] = [10.0, 11.0];
const GEM_RISE: [number, number] = [21.0, 23.0];
/** 台座の高さと、宝石が載る高さ */
const PEDESTAL_H = 1.2;
const GEM_Y = 1.55;

/** 音を鳴らす時刻 */
const PASS_TIMES = [3, 7, 9, 13, 15, 17];
const PICK_TIME = 10.5;

const camera = { pos: [8, 12.5, 12] as [number, number, number], target: [0, 6.2, 0] as [number, number, number] };

// --------------------------------------------------------------------------

const dummy = new THREE.Object3D();
const color = new THREE.Color();

let beams: THREE.InstancedMesh;
let beamMat: THREE.MeshBasicMaterial;
let agent: THREE.Group;
let wire: THREE.Mesh;
let doors: THREE.Mesh[] = [];
let gem: THREE.Mesh;
let gemMat: THREE.MeshStandardMaterial;

/** 通過・蓋・宝石の音のタイミングを数える。build のたびに作り直す */
let passTicks = tickers(PASS_TIMES.length);
let hatchTicks = tickers(2);
let pickTick = tickers(1);

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smooth = (x: number): number => {
  const u = clamp01(x);
  return u * u * u * (u * (u * 6 - 15) + 10);
};
const span = (u: number, [a, b]: [number, number]): number => smooth((u - a) / (b - a));

/** 足元の y。時刻表を補間し、止まった直後にワイヤーの伸びで小さく弾む */
function feetY(u: number): number {
  for (let i = 1; i < PATH.length; i++) {
    const [t1, y1] = PATH[i];
    if (u > t1) continue;
    const [t0, y0] = PATH[i - 1];
    const y = y0 + (y1 - y0) * smooth((u - t0) / (t1 - t0));
    if (y0 !== y1) return y;
    // 静止区間: 直前の移動の終わりから減衰振動を足す
    const yp = PATH[i - 2]?.[1] ?? y0;
    if (yp === y0) return y;
    const dir = Math.sign(y0 - yp);
    const s = u - t0;
    return y + dir * 0.14 * Math.exp(-5 * s) * Math.sin(13 * s);
  }
  return PATH[PATH.length - 1][1];
}

/** 段 i のレーザー格子のずれ。奇数秒に 0（隙間が中心）を速く通り抜ける */
function beamOffset(i: number, t: number): number {
  const sign = i % 2 === 0 ? 1 : -1;
  return sign * (GAP / 2) * Math.cos((Math.PI * 2 * t) / SWEEP);
}

/** 人影を組む。足元が原点。明るめの灰で、暗がりでもシルエットが読めるように */
function buildAgent(): THREE.Group {
  const g = new THREE.Group();
  const suit = new THREE.MeshStandardMaterial({
    color: emberColor(0.55, 0, -0.18),
    roughness: 0.55,
    metalness: 0.2,
  });
  const cap = (r: number, len: number): THREE.CapsuleGeometry => new THREE.CapsuleGeometry(r, len, 6, 12);

  const torso = new THREE.Mesh(cap(0.23, 0.5), suit);
  torso.position.y = 1.2;
  g.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 20, 14), suit);
  head.position.y = 1.66;
  g.add(head);

  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(cap(0.1, 0.62), suit);
    leg.position.set(s * 0.21, 0.44, 0);
    leg.rotation.z = s * 0.28;
    g.add(leg);

    const arm = new THREE.Mesh(cap(0.075, 0.55), suit);
    arm.position.set(s * 0.56, 1.2, 0);
    arm.rotation.z = s * 1.1;
    g.add(arm);
  }

  // 背中の吊り金具
  const clip = new THREE.Mesh(
    new THREE.TorusGeometry(0.07, 0.02, 6, 16),
    new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.3, metalness: 0.9 }),
  );
  clip.position.set(0, 1.5, -0.2);
  g.add(clip);
  return g;
}

export const missionImpossible: SceneModule = {
  name: 'Mission Impossible',
  desc: '天井から吊られた人影が、掃いていく赤いレーザーの隙間を段ごとに待って抜け、宝石を取って昇っていく。',
  camera,

  build(root) {
    passTicks = tickers(PASS_TIMES.length);
    hatchTicks = tickers(2);
    pickTick = tickers(1);

    const dark = new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.9, metalness: 0.1 });
    const metal = new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.55, metalness: 0.5 });

    // 床
    const floor = new THREE.Mesh(new THREE.CircleGeometry(12, 96), metal);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    root.add(floor);

    // 天井: 開口を囲む 4 枚の板
    const W = 14;
    const side = (W - HATCH) / 2;
    const off = HATCH / 2 + side / 2;
    for (const [x, z, w, d] of [
      [off, 0, side, W], [-off, 0, side, W],
      [0, off, HATCH, side], [0, -off, HATCH, side],
    ] as [number, number, number, number][]) {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, d), dark);
      slab.position.set(x, CEIL_Y + 0.15, z);
      root.add(slab);
    }
    // 蓋: 左右に引き戸で開く 2 枚
    doors = [];
    for (let s = 0; s < 2; s++) {
      const door = new THREE.Mesh(new THREE.BoxGeometry(HATCH / 2, 0.12, HATCH), metal);
      door.position.y = CEIL_Y + 0.06;
      root.add(door);
      doors.push(door);
    }

    // 台座
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.7, PEDESTAL_H, 32), dark);
    ped.position.y = PEDESTAL_H / 2;
    root.add(ped);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.08, 32), metal);
    top.position.y = PEDESTAL_H + 0.04;
    root.add(top);

    // 宝石
    gemMat = new THREE.MeshStandardMaterial({
      color: emberColor(0.95, 0, 0.12),
      emissive: emberColor(0.9, 0, -0.1),
      emissiveIntensity: 0.9,
      roughness: 0.15,
      metalness: 0.3,
      flatShading: true,
    });
    gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.22, 0), gemMat);
    gem.scale.set(1, 1.35, 1);
    root.add(gem);

    // レーザー格子とレール
    const railGeo = new THREE.BoxGeometry(11.4, 0.14, 0.14);
    LAYERS.forEach((y, i) => {
      for (const s of [-1, 1]) {
        const rail = new THREE.Mesh(railGeo, dark);
        rail.position.y = y;
        if (i % 2 === 0) {
          rail.position.z = s * (BEAM_LEN / 2 + 0.07);
        } else {
          rail.rotation.y = Math.PI / 2;
          rail.position.x = s * (BEAM_LEN / 2 + 0.07);
        }
        root.add(rail);
      }
    });

    beamMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const beamGeo = new THREE.CylinderGeometry(BEAM_R, BEAM_R, BEAM_LEN, 6);
    beamGeo.rotateX(Math.PI / 2); // 既定で z 方向に伸ばす
    beams = new THREE.InstancedMesh(beamGeo, beamMat, LAYERS.length * BEAMS);
    beams.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(beams);

    // 人影とワイヤー
    agent = buildAgent();
    root.add(agent);
    const wireGeo = new THREE.CylinderGeometry(0.022, 0.022, 1, 5);
    wireGeo.translate(0, 0.5, 0);
    wire = new THREE.Mesh(wireGeo, new THREE.MeshBasicMaterial({ color: emberColor(0.8, 0, 0.12) }));
    root.add(wire);
  },

  update(t) {
    const u = ((t % CYCLE) + CYCLE) % CYCLE;

    // 蓋
    const open = span(u, HATCH_OPEN) * (1 - span(u, HATCH_CLOSE));
    doors.forEach((door, s) => {
      const dir = s === 0 ? -1 : 1;
      door.position.x = dir * (HATCH / 4 + open * (HATCH / 2 + 0.05));
    });

    // 人影
    const y = feetY(u);
    agent.position.set(0, y, 0);
    agent.rotation.y = 0.35 * Math.sin(t * 0.4) + 0.4;
    const attach = y + 1.5;
    wire.position.set(0, attach, -0.2);
    wire.scale.y = Math.max(0.01, 20 - attach);

    // 宝石: 台座から手元へ浮き、人影と一緒に去る。あとで台座の奥から次が出る
    const handY = y + 1.0;
    const lift = span(u, GEM_LIFT);
    const rise = span(u, GEM_RISE);
    if (u < GEM_LIFT[0]) {
      gem.position.set(0, GEM_Y, 0);
      gem.scale.set(1, 1.35, 1);
    } else if (u < GEM_RISE[0]) {
      gem.position.set(0, GEM_Y + (handY - GEM_Y) * lift, 0.4 * lift);
      gem.scale.set(1, 1.35, 1);
    } else {
      gem.position.set(0, GEM_Y - 0.4 * (1 - rise), 0);
      gem.scale.set(rise, 1.35 * rise, rise);
    }
    gem.visible = u < GEM_RISE[0] ? gem.position.y < CEIL_Y : rise > 0.01;
    gem.rotation.y = t * 0.7;
    gemMat.emissiveIntensity = 0.7 + 0.5 * Math.sin(Math.PI * lift) + 0.15 * Math.sin(t * 2.1);

    // レーザー
    ember(color, BEAM_N, drift(t) * 0.5, BEAM_GLOW);
    beamMat.color.copy(color);
    let k = 0;
    LAYERS.forEach((ly, i) => {
      const o = beamOffset(i, t);
      for (let b = 0; b < BEAMS; b++) {
        const p = o + (b - (BEAMS - 1) / 2) * GAP;
        if (i % 2 === 0) {
          dummy.position.set(p, ly, 0);
          dummy.rotation.set(0, 0, 0);
        } else {
          dummy.position.set(0, ly, p);
          dummy.rotation.set(0, Math.PI / 2, 0);
        }
        dummy.updateMatrix();
        beams.setMatrixAt(k++, dummy.matrix);
      }
    });
    beams.instanceMatrix.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    sfx.drone(tone(0), 0.035);

    PASS_TIMES.forEach((T, i) => {
      for (let n = passTicks[i]((t - T) / CYCLE); n > 0; n--) {
        const up = i >= 3;
        sfx.air({ gain: 0.22, decay: 0.45, freq: up ? 1100 : 800, q: 1.2 });
        sfx.pluck(tone(up ? 7 + (i - 3) * 2 : 11 - i * 2), { gain: 0.26, decay: 1.8, pan: (i % 2 ? -1 : 1) * 0.3 });
      }
    });

    [HATCH_OPEN[0], HATCH_CLOSE[1]].forEach((T, i) => {
      for (let n = hatchTicks[i]((t - T) / CYCLE); n > 0; n--) {
        sfx.drop(tone(i === 0 ? 2 : 0), { gain: 0.3, decay: 0.6, bend: 0.7 });
      }
    });

    for (let n = pickTick[0]((t - PICK_TIME) / CYCLE); n > 0; n--) {
      sfx.pluck(tone(12), { gain: 0.24, decay: 2.8, pan: -0.2 });
      sfx.pluck(tone(14), { gain: 0.2, decay: 2.8 });
      sfx.pluck(tone(16), { gain: 0.18, decay: 2.8, pan: 0.2 });
    }
  },
};
