import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { SURFACE, ember, drift } from '../palette.ts';

/**
 * Bounce Grid。
 *
 * 何が動くか: 7x7 に並んだ球が、着地の瞬間だけ潰れ、跳ね上がる瞬間だけ縦に伸びて
 * また落ちていく。位相は格子の対角線（i + j）に沿ってずらしてあるので、
 * 全体としては波が斜めに何度も横切っていくように見える。床の薄いグリッド線が
 * 行・列の目印になる。
 * 気持ちよさの芯: 「潰れる → 伸びる → 浮く → また潰れる」という弾性の間（ま）が、
 * 斜めの波に乗って次々と伝わっていくところ。
 * ループの周期: 1 個あたりの跳躍は約 2.4 秒。波が格子を何周分ずらすかは固定なので、
 * 開き直しても同じ波が同じ位置から始まる。
 * カメラ: 斜め45度・急な俯角から見下ろし、格子の行と列の隙間が読めるようにする。
 * 音: 対角線の帯ごとに、着地の瞬間だけ短い撥音を鳴らす。波の進む向きに合わせて
 * 音像も左右に流れる。
 * スコープ外: 球同士の衝突や、床のたわみは扱わない。
 */

/** 一辺に並べる球の数（COUNT = GRID * GRID） */
const GRID = 7;
const COUNT = GRID * GRID;
/** 格子の間隔 */
const SPACING = 2.2;
/** 球の半径（潰れていない状態） */
const BALL_RADIUS = 0.4;
/** 跳躍の高さ（球の底が浮く最大量） */
const AMPLITUDE = 1.4;
/** 1 秒あたりの跳躍回数 */
const BOUNCE_FREQ = 0.42;
/** 対角線の端から端まで、位相をどれだけずらすか（周期の何個ぶんか） */
const WAVE_CYCLES = 3.4;
/** 接地判定の狭さ。小さいほど「潰れる瞬間」が短く鋭くなる */
const SQUASH_SIGMA = 0.035;
/** 接地時に潰れる深さ */
const SQUASH_DEPTH = 0.4;
/** 離陸・着地の直前直後に伸びる深さ */
const STRETCH_DEPTH = 0.18;
/** 位置と位相に足す、格子っぽさを崩すための小さな乱れ */
const JITTER_POS = 0.03;
const JITTER_PHASE = 0.025;

/** 床の半径 */
const FLOOR_RADIUS = 10.5;
/** 対角線の本数（0 〜 2*(GRID-1)） */
const DIAG_COUNT = 2 * (GRID - 1) + 1;

const dummy = new THREE.Object3D();
const color = new THREE.Color();

let mesh: THREE.InstancedMesh;

/** 球ごとの [x, z, 位相ずれ(視覚用), 対角線帯番号] */
const balls = new Float32Array(COUNT * 4);

/** 固定シードの疑似乱数（開き直すたびに同じ配置になる） */
let seed = 0.612;
const rnd = (): number => (seed = (seed * 9301 + 0.49297) % 1);

/** 対角線帯ごとの着地カウンタ。build のたびに作り直す。 */
let ticks: ((phase: number) => number)[] = [];

const wrap01 = (x: number): number => x - Math.floor(x);

export const bounceGrid: SceneModule = {
  name: 'Bounce Grid',
  desc: '球のグリッドが斜めの波に乗って、次々に潰れては跳ね上がる。',
  camera: { pos: [8.8, 11.4, 8.8], target: [0, 1, 0] },

  build(root) {
    seed = 0.612;
    ticks = tickers(DIAG_COUNT);

    const half = (GRID - 1) / 2;
    let idx = 0;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const diag = i + j;
        const x = (i - half) * SPACING + (rnd() - 0.5) * 2 * JITTER_POS;
        const z = (j - half) * SPACING + (rnd() - 0.5) * 2 * JITTER_POS;
        const phaseJitter = (rnd() - 0.5) * 2 * JITTER_PHASE;

        balls[idx * 4 + 0] = x;
        balls[idx * 4 + 1] = z;
        balls[idx * 4 + 2] = (diag / (DIAG_COUNT - 1)) * WAVE_CYCLES + phaseJitter;
        balls[idx * 4 + 3] = diag;
        idx++;
      }
    }

    const geo = new THREE.SphereGeometry(BALL_RADIUS, 20, 16);
    geo.translate(0, BALL_RADIUS, 0); // 底を原点に。Y スケールで「潰れ・伸び」を作る
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.32 });

    mesh = new THREE.InstancedMesh(geo, mat, COUNT);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(mesh);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(FLOOR_RADIUS, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.5, metalness: 0.28 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    root.add(floor);

    // 行・列の基準線。球の並びが格子だと一目で読めるようにする
    const edge = half * SPACING + SPACING * 0.55;
    const linePts: number[] = [];
    for (let i = 0; i < GRID; i++) {
      const c = (i - half) * SPACING;
      linePts.push(-edge, 0.01, c, edge, 0.01, c);
      linePts.push(c, 0.01, -edge, c, 0.01, edge);
    }
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePts, 3));
    const lineMat = new THREE.LineBasicMaterial({ color: SURFACE, transparent: true, opacity: 0.5 });
    root.add(new THREE.LineSegments(lineGeo, lineMat));
  },

  update(t) {
    const hue = drift(t);
    for (let idx = 0; idx < COUNT; idx++) {
      const x = balls[idx * 4 + 0];
      const z = balls[idx * 4 + 1];
      const offset = balls[idx * 4 + 2];

      const p = wrap01(t * BOUNCE_FREQ - offset);
      const y = AMPLITUDE * Math.sin(Math.PI * p);

      const d = Math.min(p, 1 - p); // 接地点（p=0 相当）までの位相距離
      const squash = Math.exp(-(d * d) / (2 * SQUASH_SIGMA * SQUASH_SIGMA));
      const stretch = (1 - squash) * Math.abs(Math.cos(Math.PI * p));

      const sy = 1 - SQUASH_DEPTH * squash + STRETCH_DEPTH * stretch;
      const sxz = 1 + SQUASH_DEPTH * 0.7 * squash - STRETCH_DEPTH * 0.5 * stretch;

      dummy.position.set(x, y, z);
      dummy.scale.set(sxz, sy, sxz);
      dummy.updateMatrix();
      mesh.setMatrixAt(idx, dummy.matrix);

      const n = 0.4 + 0.2 * (y / AMPLITUDE);
      ember(color, n, hue, squash * 0.3);
      mesh.setColorAt(idx, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  },

  // 音が ON のときだけ、update と同じ t で呼ばれる。映像には影響しない。
  sound(t, _dt, sfx) {
    for (let d = 0; d < DIAG_COUNT; d++) {
      const offset = (d / (DIAG_COUNT - 1)) * WAVE_CYCLES;
      const hits = ticks[d](t * BOUNCE_FREQ - offset);
      if (hits <= 0) continue;
      const pan = (d / (DIAG_COUNT - 1)) * 2 - 1;
      for (let k = hits; k > 0; k--) {
        sfx.pluck(tone(2 + (d % 5)), { gain: 0.22, decay: 1.3, pan });
      }
    }
  },
};
