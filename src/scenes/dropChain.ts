import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone } from '../audio.ts';
import { SURFACE, ember, drift } from '../palette.ts';

/**
 * Drop Chain。
 *
 * 落ち物パズルの「連鎖」。縦長の盤へ、ぷるんとした 4 色の玉が 2 つずつ降ってきて積み上がる。
 * 最後の 1 組が落ちると、同じ色が 4 つつながったところから弾けて、上の玉が落ちて次がつながり、
 * また弾ける……を 9 回くり返して盤がまっさらになる。盤の右の灯が、連鎖の数だけ下から灯っていく。
 * 積み方は固定（探索で見つけた 9 連鎖・全消しの配置）なので、何度見ても同じ連鎖が起きる。
 * 音は玉が着地する小さな音と、連鎖ごとに一段ずつ上がっていく弾ける音。
 */

// ---- 盤 ----------------------------------------------------------------
const W = 6;
const H = 12;
const CELL = 1;
const BLOB_R = 0.47;
/** くっつきの胴の太さ（玉の半径に対する比） */
const BRIDGE_R = 0.34;

/**
 * 積んでおく玉（列ごとに下から）。0..3 は色。最後に TRIGGER_COL へ TRIGGER_COLOR の縦 2 つを落とす。
 * 同じ色が 4 つ以上つながったところは無い（落とすまで何も起きない）。
 */
const STACK: number[][] = [
  [0, 0, 2, 0, 0, 1],
  [1, 1, 2],
  [1, 2, 0, 0, 0, 2, 2, 0, 3],
  [3, 3, 1, 2, 3, 0, 3, 0, 0],
  [1, 3, 1, 2, 0, 3],
  [1, 0, 3],
];
const TRIGGER_COL = 5;
const TRIGGER_COLOR = 2;

/** 色ごとの [ember の n, 色相のずらし, 明度の持ち上げ]。暖色帯の中で明度と色相をできるだけ離す */
const COLORS: [number, number, number][] = [
  [0.0, -0.04, 0.1],
  [0.33, 0.04, 0.05],
  [0.66, -0.035, 0.0],
  [1.0, 0.04, 0.1],
];

// ---- 時間 --------------------------------------------------------------
/** 落下の加速度（マス/秒²） */
const G = 38;
/** 積むときに落とす高さ（どの玉も同じだけ落ちる = 同じ時間で着く） */
const DROP_H = 13;
/** 積み始める時刻と、玉を 2 つずつ落とす間隔 */
const BUILD0 = 0.6;
const PAIR_GAP = 0.34;
/** 最後の 1 組を落とすまでの間 */
const TRIGGER_WAIT = 0.9;
/** 着地から弾けるまでの間 */
const SETTLE = 0.3;
/** 弾ける演出の長さ */
const POP = 0.55;
/** 全部消えてから次を積み始めるまで */
const HOLD = 1.6;

/** 弾けた玉 1 つから飛ぶ火の粉の数と寿命 */
const SPARKS = 5;
const SPARK_LIFE = 0.8;

const dummy = new THREE.Object3D();
const color = new THREE.Color();

/** 玉ごとの落下（t0 に y0 から落ち始めて y1 で止まる）。y はマス単位の段 */
interface Fall {
  t0: number;
  y0: number;
  y1: number;
  dur: number;
}
interface Blob {
  col: number;
  color: number;
  spawn: number;
  falls: Fall[];
  pop: number;
}
interface Ev {
  t: number;
  kind: 'land' | 'pop';
  k: number;
  x: number;
}

let blobs: Blob[] = [];
let events: Ev[] = [];
/** 連鎖 k 段目が弾けた時刻 */
let chainAt: number[] = [];
let period = 20;

let balls: THREE.InstancedMesh;
let bridges: THREE.InstancedMesh;
let sparks: THREE.InstancedMesh;
let lamps: THREE.InstancedMesh;

/** 盤の中の「いま止まっている玉」の番号（毎フレーム詰め直す） */
const grid = new Int32Array(W * H);

/** 音だけが使う状態 */
let prevCycle = -1;
let prevU = 0;

const fallDur = (d: number): number => Math.sqrt((2 * d) / G);
const worldX = (col: number): number => (col - (W - 1) / 2) * CELL;
const worldY = (row: number): number => (row + 0.5) * CELL;

/** 盤の中で同じ色が 4 つ以上つながった玉の番号を集める */
function findGroups(cols: number[][]): number[][] {
  const seen = cols.map((c) => c.map(() => false));
  const out: number[][] = [];
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < cols[x].length; y++) {
      if (seen[x][y]) continue;
      const c = blobs[cols[x][y]].color;
      const stack: [number, number][] = [[x, y]];
      seen[x][y] = true;
      const g: number[] = [];
      while (stack.length) {
        const [a, b] = stack.pop() as [number, number];
        g.push(cols[a][b]);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = a + dx;
          const ny = b + dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= cols[nx].length) continue;
          if (seen[nx][ny] || blobs[cols[nx][ny]].color !== c) continue;
          seen[nx][ny] = true;
          stack.push([nx, ny]);
        }
      }
      if (g.length >= 4) out.push(g);
    }
  }
  return out;
}

/** 積む → 落とす → 連鎖、を最初から最後まで計算して、時刻つきの台本にする */
function simulate(): void {
  blobs = [];
  events = [];
  chainAt = [];

  // 積む順番: 下の段から。2 つずつ組にして同じ時刻に落とす
  const order: [number, number][] = [];
  for (let row = 0; row < H; row++) {
    for (let x = 0; x < W; x++) if (row < STACK[x].length) order.push([x, row]);
  }
  const cols: number[][] = Array.from({ length: W }, () => []);
  const place = (x: number, row: number, c: number, spawn: number): void => {
    const id = blobs.length;
    const dur = fallDur(DROP_H);
    blobs.push({ col: x, color: c, spawn, falls: [{ t0: spawn, y0: row + DROP_H, y1: row, dur }], pop: Infinity });
    cols[x][row] = id;
    events.push({ t: spawn + dur, kind: 'land', k: row, x });
  };
  order.forEach(([x, row], i) => place(x, row, STACK[x][row], BUILD0 + Math.floor(i / 2) * PAIR_GAP));

  // 最後の 1 組（縦 2 つ）
  const trig = BUILD0 + Math.ceil(order.length / 2) * PAIR_GAP + TRIGGER_WAIT;
  const h = STACK[TRIGGER_COL].length;
  place(TRIGGER_COL, h, TRIGGER_COLOR, trig);
  place(TRIGGER_COL, h + 1, TRIGGER_COLOR, trig);

  let now = trig + fallDur(DROP_H) + SETTLE;
  for (let k = 0; k < 40; k++) {
    const groups = findGroups(cols);
    if (!groups.length) break;
    chainAt.push(now);
    let sx = 0;
    let n = 0;
    const dead = new Set<number>();
    for (const g of groups) {
      for (const id of g) {
        blobs[id].pop = now;
        dead.add(id);
        sx += worldX(blobs[id].col);
        n++;
      }
    }
    events.push({ t: now, kind: 'pop', k, x: sx / n });

    // 弾けたぶん上の玉を落とす
    const popEnd = now + POP * 0.7;
    let last = popEnd;
    for (let x = 0; x < W; x++) {
      const keep = cols[x].filter((id) => !dead.has(id));
      keep.forEach((id, row) => {
        const b = blobs[id];
        const from = b.falls[b.falls.length - 1].y1;
        if (from !== row) {
          const dur = fallDur(from - row);
          b.falls.push({ t0: popEnd, y0: from, y1: row, dur });
          last = Math.max(last, popEnd + dur);
          events.push({ t: popEnd + dur, kind: 'land', k: row, x });
        }
      });
      cols[x] = keep;
    }
    now = last + SETTLE;
  }
  period = now + HOLD;
  events.sort((a, b) => a.t - b.t);
}

/** 玉の段（マス単位）。落ちている途中は重力で加速する */
function rowAt(b: Blob, u: number): number {
  let y = b.falls[0].y0;
  for (const f of b.falls) {
    if (u < f.t0) break;
    const s = u - f.t0;
    y = s < f.dur ? f.y0 - 0.5 * G * s * s : f.y1;
  }
  return y;
}

/** 最後に着地してからの秒数（着地前なら -1） */
function sinceLand(b: Blob, u: number): number {
  let best = -1;
  for (const f of b.falls) {
    const s = u - (f.t0 + f.dur);
    if (s >= 0) best = s;
  }
  return best;
}

export const dropChain: SceneModule = {
  name: 'Drop Chain',
  desc: '積み上がった 4 色の玉に最後の 1 組を落とすと、弾けては落ちてつながり、9 連鎖で盤が空になる。',
  camera: { pos: [2, 6.8, 16.5], target: [0, 6, 0] },

  build(root) {
    prevCycle = -1;
    prevU = 0;
    simulate();

    const N = blobs.length;
    const frame = new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.45, metalness: 0.6 });

    // 床
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(9, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.7, metalness: 0.3 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    root.add(floor);

    // 盤: 背板と左右の壁、底
    const back = new THREE.Mesh(new THREE.BoxGeometry(W * CELL + 0.3, H * CELL + 0.3, 0.2), frame);
    back.position.set(0, (H * CELL) / 2, -0.62);
    root.add(back);
    for (const side of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(0.22, H * CELL + 0.3, 1.4), frame);
      wall.position.set(side * ((W * CELL) / 2 + 0.11), (H * CELL) / 2, 0);
      root.add(wall);
    }
    const sill = new THREE.Mesh(new THREE.BoxGeometry(W * CELL + 0.66, 0.2, 1.4), frame);
    sill.position.set(0, -0.1, 0);
    root.add(sill);

    // 玉
    balls = new THREE.InstancedMesh(
      new THREE.SphereGeometry(BLOB_R, 32, 20),
      new THREE.MeshStandardMaterial({ roughness: 0.22, metalness: 0.05 }),
      N,
    );
    balls.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // 最初のフレームは全部隠れているので、そこで測った外接球で間引かれないようにする
    balls.frustumCulled = false;
    root.add(balls);

    // 同じ色どうしの「くっつき」（隣の玉へ伸ばす短い胴）
    const brGeo = new THREE.CylinderGeometry(BLOB_R * BRIDGE_R, BLOB_R * BRIDGE_R, CELL, 16, 1, true);
    brGeo.translate(0, CELL / 2, 0);
    bridges = new THREE.InstancedMesh(brGeo, new THREE.MeshStandardMaterial({ roughness: 0.22, metalness: 0.05 }), N * 2);
    bridges.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    bridges.frustumCulled = false;
    root.add(bridges);

    // 弾けたときの火の粉
    sparks = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.07, 8, 6),
      new THREE.MeshBasicMaterial(),
      N * SPARKS,
    );
    sparks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    sparks.frustumCulled = false;
    root.add(sparks);

    // 連鎖の数を数える灯（盤の右の柱）
    const nLamp = Math.max(1, chainAt.length);
    lamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.2, 16, 12), new THREE.MeshBasicMaterial(), nLamp);
    const step = (H * CELL - 1.2) / nLamp;
    for (let k = 0; k < nLamp; k++) {
      dummy.position.set((W * CELL) / 2 + 0.62, 0.8 + k * step, 0.2);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      lamps.setMatrixAt(k, dummy.matrix);
    }
    root.add(lamps);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.34, H * CELL, 0.34), frame);
    post.position.set((W * CELL) / 2 + 0.62, (H * CELL) / 2, -0.12);
    root.add(post);
  },

  update(t) {
    const cycle = Math.floor(t / period);
    const u = t - cycle * period;
    const hue = drift(t);
    const N = blobs.length;
    grid.fill(-1);

    for (let i = 0; i < N; i++) {
      const b = blobs[i];
      const [cn, cs, cg] = COLORS[b.color];
      const x = worldX(b.col);
      const p = (u - b.pop) / POP; // 弾けの進み具合（負 = まだ）

      if (u < b.spawn || p >= 1) {
        dummy.scale.setScalar(0);
        dummy.position.set(0, -10, 0);
        dummy.updateMatrix();
        balls.setMatrixAt(i, dummy.matrix);
        balls.setColorAt(i, color.setRGB(0, 0, 0));
        continue;
      }

      const row = rowAt(b, u);
      let sx = 1;
      let sy = 1;
      // 着地したらぷるんと潰れて戻る
      const sl = sinceLand(b, u);
      if (sl >= 0 && sl < 0.8) {
        const w = Math.exp(-sl * 7) * Math.cos(sl * 20);
        sy -= 0.22 * w;
        sx += 0.13 * w;
      }
      let glow = 0;
      if (p >= 0) {
        // 震えながら膨らみ、光って、縮んで消える
        const q = p < 0.45 ? p / 0.45 : 1;
        const jig = p < 0.45 ? Math.sin(p * 60) * 0.05 * q : 0;
        const size = p < 0.45 ? 1 + 0.12 * q : (1.12 * (1 - (p - 0.45) / 0.55)) ** 1.5;
        sx = size + jig;
        sy = size - jig;
        glow = 0.25 * q;
      }
      dummy.position.set(x, worldY(row) - (1 - sy) * BLOB_R, 0);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(sx, sy, sx);
      dummy.updateMatrix();
      balls.setMatrixAt(i, dummy.matrix);
      ember(color, cn, hue + cs, cg + glow);
      if (p >= 0) color.multiplyScalar(1 + 0.8 * (p < 0.45 ? p / 0.45 : 1));
      balls.setColorAt(i, color);

      // 止まっている玉だけ盤に載せる（くっつき判定用）
      const r = Math.round(row);
      if (Math.abs(row - r) < 0.02 && r < H && (p < 0 || p < 0.45)) grid[b.col + r * W] = i;
    }

    // くっつき: 右と上の同じ色へ胴を伸ばす
    let nb = 0;
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        const i = grid[c + r * W];
        if (i < 0) continue;
        const b = blobs[i];
        for (const [dc, dr] of [[1, 0], [0, 1]]) {
          const cc = c + dc;
          const rr = r + dr;
          if (cc >= W || rr >= H) continue;
          const j = grid[cc + rr * W];
          if (j < 0 || blobs[j].color !== b.color) continue;
          dummy.position.set(worldX(c), worldY(r), 0);
          dummy.rotation.set(0, 0, dc ? -Math.PI / 2 : 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          bridges.setMatrixAt(nb, dummy.matrix);
          const [cn, cs, cg] = COLORS[b.color];
          bridges.setColorAt(nb, ember(color, cn, hue + cs, cg));
          nb++;
        }
      }
    }
    bridges.count = nb;

    // 火の粉
    for (let i = 0; i < N; i++) {
      const b = blobs[i];
      const s = u - b.pop - POP * 0.45;
      for (let j = 0; j < SPARKS; j++) {
        const k = i * SPARKS + j;
        if (s < 0 || s > SPARK_LIFE) {
          dummy.scale.setScalar(0);
          dummy.updateMatrix();
          sparks.setMatrixAt(k, dummy.matrix);
          sparks.setColorAt(k, color.setRGB(0, 0, 0));
          continue;
        }
        const a = (j / SPARKS) * Math.PI * 2 + i * 1.3;
        const v = 2.6 + ((i * 7 + j * 3) % 5) * 0.35;
        const row = b.falls[b.falls.length - 1].y1;
        dummy.position.set(
          worldX(b.col) + Math.cos(a) * v * s,
          worldY(row) + Math.sin(a) * v * s - 4 * s * s,
          0.3 + Math.sin(a * 2) * 0.3 * s,
        );
        dummy.scale.setScalar(1 - s / SPARK_LIFE);
        dummy.updateMatrix();
        sparks.setMatrixAt(k, dummy.matrix);
        const [cn, cs] = COLORS[b.color];
        ember(color, Math.min(1, cn + 0.3), hue + cs, 0.2).multiplyScalar(1 - s / SPARK_LIFE);
        sparks.setColorAt(k, color);
      }
    }

    // 連鎖の灯: 連鎖ごとに 1 つずつ灯り、全消しのあと一斉に落ちる
    const off = 1 - Math.min(1, Math.max(0, (u - (period - HOLD * 0.6)) / (HOLD * 0.5)));
    for (let k = 0; k < lamps.count; k++) {
      const s = k < chainAt.length ? u - chainAt[k] : -1;
      const on = s < 0 ? 0 : Math.min(1, s / 0.15);
      const flash = s < 0 ? 0 : Math.exp(-s * 4);
      ember(color, 0.35 + 0.55 * (k / Math.max(1, lamps.count - 1)), hue, on * (0.08 + 0.2 * flash));
      color.multiplyScalar(0.12 + on * off * (0.75 + 0.5 * flash));
      lamps.setColorAt(k, color);
    }

    for (const m of [balls, bridges, sparks, lamps]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  },

  sound(t, _dt, sfx) {
    const cycle = Math.floor(t / period);
    const u = t - cycle * period;
    if (cycle === prevCycle && u > prevU) {
      let landed = -1;
      for (const e of events) {
        if (e.t <= prevU) continue;
        if (e.t > u) break;
        const pan = (e.x / (W * CELL)) * 1.2;
        if (e.kind === 'pop') {
          // 連鎖ごとに一段ずつ上がる
          sfx.pluck(tone(6 + e.k * 2), { gain: 0.32, decay: 2.4, pan });
          sfx.drop(tone(13 + e.k), { gain: 0.16, decay: 0.4, pan });
        } else {
          landed = e.x;
        }
      }
      // 着地はフレームに 1 つだけ（2 つずつ落ちてくるので団子にしない）
      if (landed >= 0) sfx.drop(tone(2), { gain: 0.09, decay: 0.25, bend: 0.8, pan: (worldX(landed) / W) * 1.2 });
    }
    prevCycle = cycle;
    prevU = u;
  },
};
