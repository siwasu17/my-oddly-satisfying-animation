import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * Nesting Cups。
 *
 * 真ん中にいちばん大きなカップがあり、そのまわりに並んだ 6 つのカップが、大きい順に 1 つずつ
 * ふわりと弧を描いて真上へ来て、ひと回り大きいカップの中へ沈んでいく。
 * 隙間の空気がクッションになるように、沈む終わりだけ長く減速して「すーっ…ことん」と座る。
 * 全部収まったら、小さい順に抜き取られて元の場所へ帰る（24 秒で一巡）。
 * カメラは斜め上からの俯瞰。音は沈むあいだの air と、座ったときの pluck（小さいほど高い）、
 * 抜き取るときの drop。
 * スコープ外: 逆さにして塔に積む遊びかた、カップ同士の衝突判定。
 */

/** カップの数（真ん中の 1 つを含む） */
const N = 7;
/** いちばん大きいカップの寸法（底の外半径 / 口の外半径 / 高さ / 肉厚） */
const RB = 1.15;
const RT = 1.6;
const CUP_H = 1.8;
const WALL = 0.07;
/** 1 つ小さくなるごとの縮み */
const SHRINK = 0.115;
/** まわりに並べる輪の半径 */
const HOME_R = 3.9;

/** 入れる動き：1 つあたりの秒数と、そのうち弧を描いて真上へ運ぶ割合 */
const D_IN = 2.2;
const TRAVEL = 0.42;
/** 真上で止まる高さ（座る位置からの差）と、運ぶときの弧のふくらみ */
const SINK_H = 2.3;
const ARC = 0.9;
/** 運ぶときの傾き（rad） */
const TILT = 0.28;
/** 全部入ってからの間 / 抜く 1 つあたりの秒数 / 抜き終えてからの間 */
const HOLD_IN = 2.0;
const D_OUT = 1.3;
const HOLD_OUT = 1.0;

const NEST_END = (N - 1) * D_IN;
const OUT_START = NEST_END + HOLD_IN;
const PERIOD = OUT_START + (N - 1) * D_OUT + HOLD_OUT;

/** カメラ */
const CAM_POS: [number, number, number] = [0, 8.2, 8.4];
const CAM_TARGET: [number, number, number] = [0, 0.4, 0.6];

const scaleOf = (k: number): number => 1 - k * SHRINK;

/** 座ったときの底の高さ。1 つ大きいカップの内底に乗る */
const seat: number[] = [0];
for (let k = 1; k < N; k++) seat.push(seat[k - 1] + WALL * scaleOf(k - 1));

const smooth = (x: number): number => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};

const cups: THREE.Group[] = [];
const mats: THREE.MeshStandardMaterial[] = [];
const home: [number, number][] = [];
const axis = new THREE.Vector3();

/** 鳴らす瞬間ごとに 1 本。[沈み始め, 座る, 抜ける] × (N - 1) */
let ticks = tickers(3 * (N - 1));

/** 一巡の中の時刻 tc での、カップ k の進み具合（0 = 自分の場所 / 1 = 座った） */
function progress(k: number, tc: number): number {
  const outStart = OUT_START + (N - 1 - k) * D_OUT;
  if (tc >= outStart) return 1 - Math.min(1, (tc - outStart) / D_OUT);
  return Math.min(1, Math.max(0, (tc - (k - 1) * D_IN) / D_IN));
}

/** カップ k を進み具合 p の位置へ置く */
function place(k: number, p: number): void {
  const cup = cups[k];
  const [hx, hz] = home[k];
  const hover = seat[k] + SINK_H;
  cup.quaternion.identity();
  if (p < TRAVEL) {
    const q = smooth(p / TRAVEL);
    cup.position.set(hx * (1 - q), hover * q + ARC * Math.sin(Math.PI * q), hz * (1 - q));
    // 進む向きへ少し傾く
    axis.set(-hz, 0, hx).normalize();
    cup.quaternion.setFromAxisAngle(axis, -TILT * Math.sin(Math.PI * q));
  } else {
    // 沈む：動き出しはなめらかに、終わりは空気に支えられて長く減速する
    const s = (p - TRAVEL) / (1 - TRAVEL);
    const g = 1 - Math.pow(1 - Math.pow(s, 1.6), 3);
    cup.position.set(0, hover - SINK_H * g, 0);
  }
}

function makeCup(k: number): THREE.Group {
  const s = scaleOf(k);
  const pts = [
    new THREE.Vector2(0, 0),
    new THREE.Vector2(RB - 0.05, 0),
    new THREE.Vector2(RB, 0.05),
    new THREE.Vector2(RT, CUP_H),
    new THREE.Vector2(RT - WALL, CUP_H),
    new THREE.Vector2(RB - WALL, WALL),
    new THREE.Vector2(0, WALL),
  ];
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.38, metalness: 0.12 });
  mats.push(mat);

  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.LatheGeometry(pts, 96), mat);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const lip = new THREE.Mesh(new THREE.TorusGeometry(RT - WALL / 2, WALL * 0.62, 8, 96), mat);
  lip.rotation.x = Math.PI / 2;
  lip.position.y = CUP_H;
  group.add(lip);

  group.scale.setScalar(s);
  return group;
}

export const nestingCups: SceneModule = {
  name: 'Nesting Cups',
  desc: 'カップが 1 つずつ、ひと回り大きいカップへすーっと沈んで、ことんと座る。',
  camera: { pos: CAM_POS, target: CAM_TARGET },
  shadows: true,

  build(root) {
    ticks = tickers(3 * (N - 1));
    cups.length = 0;
    mats.length = 0;
    home.length = 0;

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(HOME_R * 1.9, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.62, metalness: 0.45 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.01;
    floor.receiveShadow = true;
    root.add(floor);

    for (let k = 0; k < N; k++) {
      // 大きい順に、奥から時計回りに並べる
      const a = k === 0 ? 0 : -Math.PI / 2 + ((k - 1) / (N - 1)) * Math.PI * 2;
      home.push(k === 0 ? [0, 0] : [Math.cos(a) * HOME_R, Math.sin(a) * HOME_R]);
      const cup = makeCup(k);
      cup.position.set(home[k][0], 0, home[k][1]);
      root.add(cup);
      cups.push(cup);
    }
    // 出しておいた色が初回から入るように
    for (let k = 0; k < N; k++) mats[k].color.copy(emberColor(0.34 + (k / (N - 1)) * 0.58));
  },

  update(t) {
    const tc = t - Math.floor(t / PERIOD) * PERIOD;
    const hue = drift(t);
    for (let k = 0; k < N; k++) {
      ember(mats[k].color, 0.34 + (k / (N - 1)) * 0.58, hue);
      if (k > 0) place(k, progress(k, tc));
    }
  },

  sound(t, _dt, sfx) {
    for (let k = 1; k < N; k++) {
      const i = (k - 1) * 3;
      const pan = home[k][0] / HOME_R * 0.3;
      const inStart = (k - 1) * D_IN;
      // 沈み始め：すーっ
      for (let c = ticks[i]((t - inStart - TRAVEL * D_IN) / PERIOD); c > 0; c--) {
        sfx.air({ gain: 0.16, decay: 1.4, freq: 900 - k * 70, q: 2.2, sweep: 0.55 });
      }
      // 座る：ことん。小さいカップほど高い
      for (let c = ticks[i + 1]((t - inStart - D_IN) / PERIOD); c > 0; c--) {
        sfx.pluck(tone(2 + k), { gain: 0.38, decay: 1.1, pan: 0 });
      }
      // 抜ける：ぽん
      const outStart = OUT_START + (N - 1 - k) * D_OUT;
      for (let c = ticks[i + 2]((t - outStart - 0.25 * D_OUT) / PERIOD); c > 0; c--) {
        sfx.drop(tone(7 + k), { gain: 0.3, decay: 0.45, pan });
      }
    }
  },
};
