import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import type { Sfx } from '../audio.ts';
import { tone } from '../audio.ts';
import { SURFACE, ember, drift } from '../palette.ts';

/**
 * Sorting Bars — 挿入ソートで、ばらばらの高さのバーが一本ずつ正しい位置へ収まっていく。
 *
 * 何が動くか: 横一列に並んだ 20 本のバー。手に取られた 1 本が手前へ引き出され、
 *   左へ滑るあいだ、通り過ぎたバーが 1 つずつ右へ詰めて場所を空け、最後に押し込まれる。
 * 気持ちよさの芯: 入れ替わりのたびに高さと色のグラデーションが少しずつ揃っていき、
 *   最後に一本の斜面が完成する。完成の瞬間に光が左から右へ一度だけ走る。
 * ループの周期: 並べ替え → 完成の余韻 → 床へ沈んで並びを混ぜ直す、を 3 通りの並びで回し、約 100 秒で一巡。
 * カメラ: 少し右上の正面から、列全体と手前へ引き出される 1 本を見る。
 * 音: 押し込んだ瞬間にそのバーの高さの音程で pluck。完成時は光に合わせて上がるアルペジオ、
 *   混ぜ直しは air のひと吹き。
 * スコープ外: 他のソートアルゴリズム、比較の可視化（矢印や数字）、操作での並べ替え。
 */

/** バーの本数 */
const N = 20;
/** 隣のバーとの間隔 */
const GAP = 0.9;
/** バーの幅と奥行き */
const BAR_W = 0.66;
/** いちばん低いバーと、1 段ごとの伸び */
const H0 = 0.55;
const H_STEP = 0.29;
/** 手前へ引き出す距離と、そのときの浮き。引き出したバーだけ少し光らせる */
const PULL = 2.6;
const LIFT = 0.22;
const PULL_GLOW = 0.2;
/** 混ぜ直す並びの数（固定シードで作る） */
const CYCLES = 3;

/** 1 手の時間配分（秒） */
const OUT = 0.32;
const IN = 0.3;
const SLIDE0 = 0.22;
const SLIDE_PER = 0.12;
/** すでに正しい位置にあったバーを「確かめる」だけの時間 */
const IDLE = 0.42;
/** 完成してから光が走り終わるまで */
const HOLD = 3.6;
/** 光が列を走る速さ（本/秒） */
const WAVE_SPEED = 9;
/** 沈んで混ぜ直す時間と、バーごとのずれ */
const SHUFFLE = 3.2;
const SHUFFLE_STAGGER = 0.05;
/** 沈んだときに残る高さの割合 */
const SINK = 0.12;

/** カメラ */
const CAM_POS: [number, number, number] = [3.2, 6.4, 15.5];
const CAM_TARGET: [number, number, number] = [0, 2.3, 0.6];

const K_STEP = 0;
const K_HOLD = 1;
const K_SHUFFLE = 2;

const dummy = new THREE.Object3D();
const color = new THREE.Color();

let mesh: THREE.InstancedMesh;

/** 区間ごとの [開始, 長さ, 種類, i, j, 並びの位置] */
let segs: Float64Array = new Float64Array(0);
let segCount = 0;
/** 各区間の開始時点の並び（slot → バーの値）。混ぜ直し区間は「行き先の slot」（値 → slot） */
let orders: Int16Array = new Int16Array(0);
let period = 1;

/** 音を鳴らす時刻と、その中身 [時刻, 種類, 値] */
let events: Float64Array = new Float64Array(0);
let eventCount = 0;
let lastEvent = -1;

const E_PLACE = 0;
const E_CHECK = 1;
const E_WAVE = 2;
const E_SHUFFLE = 3;

const ease = (x: number): number => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * c * (c * (c * 6 - 15) + 10);
};
const slotX = (s: number): number => (s - (N - 1) / 2) * GAP;
const stepDur = (d: number): number => (d === 0 ? IDLE : OUT + SLIDE0 + SLIDE_PER * d + IN);

/** 区間表と音の時刻表を作る。並びは固定シードなので、開くたびに同じ。 */
function plan(): void {
  let s = 0.731;
  const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);

  const perms: number[][] = [];
  for (let c = 0; c < CYCLES; c++) {
    const p = Array.from({ length: N }, (_, k) => k);
    for (let k = N - 1; k > 0; k--) {
      const r = Math.floor(rnd() * (k + 1));
      [p[k], p[r]] = [p[r], p[k]];
    }
    perms.push(p);
  }

  const segList: number[] = [];
  const orderList: number[] = [];
  const evList: number[] = [];
  let time = 0;

  const push = (kind: number, dur: number, i: number, j: number, order: number[]): void => {
    segList.push(time, dur, kind, i, j, orderList.length);
    orderList.push(...order);
    time += dur;
  };

  for (let c = 0; c < CYCLES; c++) {
    const a = perms[c].slice();
    for (let i = 1; i < N; i++) {
      const key = a[i];
      let j = i;
      while (j > 0 && a[j - 1] > key) j--;
      const d = i - j;
      const start = time;
      push(K_STEP, stepDur(d), i, j, a);
      if (d === 0) evList.push(start + IDLE * 0.5, E_CHECK, key);
      else evList.push(start + stepDur(d) - IN * 0.35, E_PLACE, key);
      a.splice(i, 1);
      a.splice(j, 0, key);
    }

    const holdStart = time;
    push(K_HOLD, HOLD, 0, 0, a);
    for (let v = 0; v < N; v += 2) evList.push(holdStart + 0.3 + v / WAVE_SPEED, E_WAVE, v);

    // 次の並びへ: 値 v のバーが向かう slot
    const next = perms[(c + 1) % CYCLES];
    const dest = new Array<number>(N);
    for (let k = 0; k < N; k++) dest[next[k]] = k;
    evList.push(time + 0.1, E_SHUFFLE, 0);
    push(K_SHUFFLE, SHUFFLE, 0, 0, dest);
  }

  segs = Float64Array.from(segList);
  segCount = segList.length / 6;
  orders = Int16Array.from(orderList);
  events = Float64Array.from(evList);
  eventCount = evList.length / 3;
  period = time;
}

function place(v: number, x: number, y: number, z: number, h: number, glow: number, hue: number): void {
  dummy.position.set(x, y, z);
  dummy.scale.set(1, h, 1);
  dummy.updateMatrix();
  mesh.setMatrixAt(v, dummy.matrix);
  ember(color, 0.12 + 0.72 * (v / (N - 1)), hue, glow);
  mesh.setColorAt(v, color);
}

const height = (v: number): number => H0 + H_STEP * v;

/** ループ開始から tl 秒の時点で、何個の音が鳴り終わっているか（周回をまたいで数える） */
function eventsBefore(t: number): number {
  const loops = Math.floor(t / period);
  const tl = t - loops * period;
  let k = 0;
  while (k < eventCount && events[k * 3] <= tl) k++;
  return loops * eventCount + k;
}

function fire(e: number, sfx: Sfx): void {
  const kind = events[e * 3 + 1];
  const v = events[e * 3 + 2];
  const pan = ((v / (N - 1)) * 2 - 1) * 0.6;
  if (kind === E_PLACE) {
    sfx.pluck(tone(2 + Math.round((v / (N - 1)) * 9)), { gain: 0.32, decay: 1.8, pan });
  } else if (kind === E_CHECK) {
    sfx.drop(tone(9 + Math.round((v / (N - 1)) * 4)), { gain: 0.08, decay: 0.25, bend: 0.9, pan });
  } else if (kind === E_WAVE) {
    sfx.pluck(tone(7 + v / 2), { gain: 0.2, decay: 2.6, pan });
  } else {
    sfx.air({ gain: 0.16, decay: 2.4, freq: 420, q: 0.9, sweep: 0.6 });
  }
}

export const sortingBars: SceneModule = {
  name: 'Sorting Bars',
  desc: 'ばらばらのバーが一本ずつ引き出され、場所を空けてもらって収まり、斜面が揃う。',
  camera: { pos: CAM_POS, target: CAM_TARGET },

  build(root) {
    plan();
    lastEvent = -1;

    const geo = new THREE.BoxGeometry(BAR_W, 1, BAR_W);
    geo.translate(0, 0.5, 0); // 原点を底面へ移し、Y スケールだけで伸ばせるようにする
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.34, metalness: 0.4 });

    mesh = new THREE.InstancedMesh(geo, mat, N);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(mesh);

    // 床は艶を抑える。鏡面だとリムライトの照り返しが主役より明るく滲む
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(16, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.62, metalness: 0.55 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    root.add(floor);
  },

  update(t) {
    const hue = drift(t);
    const tl = ((t % period) + period) % period;

    let g = 0;
    while (g < segCount - 1 && segs[(g + 1) * 6] <= tl) g++;
    const base = g * 6;
    const u = tl - segs[base];
    const dur = segs[base + 1];
    const kind = segs[base + 2];
    const off = segs[base + 5];

    if (kind === K_STEP) {
      const i = segs[base + 3];
      const j = segs[base + 4];
      const d = i - j;
      const key = orders[off + i];

      // 手に取ったバーの位置 s（slot 単位）と、引き出し量 pz（0..1）
      let s = i;
      let pz: number;
      if (d === 0) {
        pz = 0.3 * Math.sin((Math.PI * u) / dur);
      } else {
        const slide = dur - OUT - IN;
        if (u < OUT) pz = ease(u / OUT);
        else if (u < OUT + slide) {
          pz = 1;
          s = i - d * ease((u - OUT) / slide);
        } else {
          pz = 1 - ease((u - OUT - slide) / IN);
          s = j;
        }
      }

      for (let m = 0; m < N; m++) {
        if (m === i) continue;
        const v = orders[off + m];
        // 手に取ったバーが上を通り過ぎたら、1 つ右へ詰めて場所を空ける
        const shift = m >= j && m < i ? ease(m + 1 - s) : 0;
        place(v, slotX(m + shift), 0, 0, height(v), 0, hue);
      }
      place(key, slotX(s), LIFT * pz, PULL * pz, height(key), PULL_GLOW * pz, hue);
    } else if (kind === K_HOLD) {
      // 完成した斜面を、光が左から右へ一度だけ走る
      const front = (u - 0.3) * WAVE_SPEED;
      for (let v = 0; v < N; v++) {
        const b = Math.exp(-((front - v) ** 2) / 2.2);
        place(v, slotX(v), 0, 0, height(v) * (1 + 0.05 * b), 0.2 * b, hue);
      }
    } else {
      // 床へ沈みながら次の並びへ移り、また伸びる
      const span = dur - SHUFFLE_STAGGER * (N - 1);
      for (let v = 0; v < N; v++) {
        const w = Math.min(1, Math.max(0, (u - v * SHUFFLE_STAGGER) / span));
        const dest = orders[off + v];
        const sink = 1 - (1 - SINK) * Math.sin(Math.PI * w) ** 0.6;
        place(v, slotX(v + (dest - v) * ease((w - 0.2) / 0.6)), 0, 0, height(v) * sink, 0, hue);
      }
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    const c = eventsBefore(t);
    if (lastEvent < 0 || c < lastEvent || c - lastEvent > 4) {
      // 開き直し・タブ復帰で溜まった分はまとめて鳴らさない
      lastEvent = c;
      return;
    }
    for (let e = lastEvent; e < c; e++) fire(e % eventCount, sfx);
    lastEvent = c;
  },
};
