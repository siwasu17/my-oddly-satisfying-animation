import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { SURFACE, ember, drift } from '../palette.ts';

/**
 * Riffle Shuffle。
 *
 * 32 枚のカードの山を半分に割り、左右の山の内側の端を持ち上げて、下から一枚ずつ
 * 交互に落として一つに重ねる（パーフェクト・アウトシャッフル）。最後に左右から
 * 寄せて揃える。カードは元の並び順で薄紅〜琥珀のグラデーションに塗ってあり、
 * 切るたびに縞模様へばらけて、5 回目でまた元のグラデーションに戻る。
 *
 * 何が動くか:     カードの山。割る → 持ち上げる → 交互に落とす → 寄せて揃える
 * 気持ちよさの芯: 左右から一枚ずつ差し込まれるテンポと、縞が 5 回で元の順に戻ること
 * ループの周期:   1 回 8 秒。32 枚のアウトシャッフルは 5 回で元に戻るので 40 秒で一巡
 * カメラ:         斜め上の正面。落ちる点と山の側面の縞が両方見える角度
 * 音:             カードが落ちるたびに左右交互の短い pluck、割るときに air、揃えたときに drop
 * スコープ外:     カードのしなり（曲面）、ブリッジ、絵柄
 */

/** 枚数。アウトシャッフルが 5 回で元に戻る枚数にしてある */
const N = 32;
const H = N / 2;
/** 元の並びに戻るまでの回数（32 枚のアウトシャッフルの位数） */
const PERIOD = 5;

/** カードの寸法。長辺を x に置く */
const CL = 3.6;
const CW = 2.4;
/** 1 枚ぶんの高さの刻み。箱はその GAP 倍の厚みにして、縞の境目を見せる */
const TH = 0.085;
const GAP = 0.58;

/** 割った山を置く位置（中心からの x） */
const SEP = 2.7;
/** 落ちたカードが重なる位置（寄せる前の左右のずれ） */
const STAG = 0.45;
/** 上半分を持ち上げて運ぶときの弧の高さ */
const LIFT = 1.1;
/** 内側の端を持ち上げる角度 */
const TILT = 0.15;

/** 1 回ぶんの時刻表（秒） */
const CYCLE = 8;
const CUT0 = 0.5;
const CUTD = 1.0;
const TILT0 = 1.6;
const TILTD = 0.5;
const REL0 = 2.2;
const STEP = 0.11;
const FALL = 0.2;
const SQ0 = 6.0;
const SQD = 0.7;

const dummy = new THREE.Object3D();
const color = new THREE.Color();

let mesh: THREE.InstancedMesh;

/** 音の拍を数える。build のたびに作り直す */
let landTick = ticker();
let cutTick = ticker();
let squareTick = ticker();
let landed = 0;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number): number => {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
};

/** posAt[m][c] = m 回切ったあとのカード c の位置（上から数えて 0..N-1） */
const posAt: number[][] = [];
{
  let cur = Array.from({ length: N }, (_, c) => c);
  for (let m = 0; m <= PERIOD; m++) {
    posAt.push(cur.slice());
    cur = cur.map((p) => (p < H ? 2 * p : 2 * (p - H) + 1));
  }
}

/** その回の、カードごとの [左右, 山の中の段(下から), 切る前の位置, 切ったあとの位置, 落ちる時刻] */
const side = new Int8Array(N);
const li = new Int8Array(N);
const p0 = new Int8Array(N);
const p1 = new Int8Array(N);
const tr = new Float32Array(N);
let prepared = -1;

function prepare(m: number): void {
  if (prepared === m) return;
  prepared = m;
  for (let c = 0; c < N; c++) {
    const p = posAt[m][c];
    const q = posAt[m + 1][c];
    const s = p < H ? 1 : -1; // 上半分は右へ、下半分は左へ
    side[c] = s;
    li[c] = s > 0 ? H - 1 - p : N - 1 - p;
    p0[c] = p;
    p1[c] = q;
    tr[c] = REL0 + (N - 1 - q) * STEP; // 下になるカードから落ちる
  }
}

/** 時刻 u までに落ち終えた枚数（なめらか）。s を渡すとその側だけ数える */
function released(u: number, s = 0): number {
  let n = 0;
  for (let c = 0; c < N; c++) {
    if (s !== 0 && side[c] !== s) continue;
    n += clamp01((u - tr[c]) / FALL);
  }
  return n;
}

const pose = { x: 0, y: 0, a: 0 };

/** 割った山の中にいるカード c の、時刻 u での姿勢を pose に書く */
function inHalf(c: number, u: number): void {
  const s = side[c];
  const sc = smooth((u - CUT0) / CUTD);
  const st = smooth((u - TILT0) / TILTD);
  const base = released(u) * TH;
  const h = (li[c] - released(u, s)) * TH;

  // 割る: 中央の山から左右の山へ。上半分は弧を描いて持ち上げて運ぶ
  const y0 = (N - 1 - p0[c]) * TH;
  const cx = s * SEP * sc;
  const cy = y0 + (base + h - y0) * sc + (s > 0 ? Math.sin(Math.PI * sc) * LIFT : 0);

  // 持ち上げる: 外側の底の角を軸に、内側の端を上げる
  const a = -s * TILT * st;
  const px = s * (SEP + CL / 2);
  const dx = cx - px;
  const dy = cy - base;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  pose.x = px + dx * ca - dy * sa;
  pose.y = base + dx * sa + dy * ca;
  pose.a = a;
}

/** 32 枚の山を割って交互に落とし、寄せて揃える。5 回で元の並びに戻る。 */
export const riffleShuffle: SceneModule = {
  name: 'Riffle Shuffle',
  desc: '割った山から一枚ずつ交互に落として重ねる。縞にばらけた色は 5 回切ると元の順に戻る。',
  camera: { pos: [0, 8.6, 10.2], target: [0, 1, 0] },

  build(root) {
    landTick = ticker();
    cutTick = ticker();
    squareTick = ticker();
    landed = 0;
    prepared = -1;

    const geo = new THREE.BoxGeometry(CL, TH * GAP, CW);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.15 });
    mesh = new THREE.InstancedMesh(geo, mat, N);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(mesh);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(11, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.35, metalness: 0.8 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    root.add(floor);
  },

  update(t) {
    const cyc = Math.floor(t / CYCLE);
    const u = t - cyc * CYCLE;
    const m = cyc % PERIOD;
    prepare(m);

    const sq = smooth((u - SQ0) / SQD);
    const hue = drift(t);

    for (let c = 0; c < N; c++) {
      const s = side[c];
      let x: number;
      let y: number;
      let a: number;
      if (u < tr[c]) {
        inHalf(c, u);
        x = pose.x;
        y = pose.y;
        a = pose.a;
      } else {
        const ey = (N - 1 - p1[c]) * TH;
        const f = (u - tr[c]) / FALL;
        if (f < 1) {
          // 手を離れた瞬間の姿勢から、重なる位置へ落とす（y は加速しながら）
          inHalf(c, tr[c]);
          const fx = smooth(f);
          x = pose.x + (s * STAG - pose.x) * fx;
          y = pose.y + (ey - pose.y) * f * f;
          a = pose.a * (1 - fx);
        } else {
          x = s * STAG * (1 - sq);
          y = ey;
          a = 0;
        }
      }

      dummy.position.set(x, y + (TH * GAP) / 2, 0);
      dummy.rotation.set(0, 0, a);
      dummy.updateMatrix();
      mesh.setMatrixAt(c, dummy.matrix);

      ember(color, 0.08 + 0.84 * (1 - c / (N - 1)), hue);
      mesh.setColorAt(c, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    const cyc = Math.floor(t / CYCLE);
    const u = t - cyc * CYCLE;

    for (let k = cutTick(cyc + (u >= CUT0 ? 1 : 0)); k > 0; k--) {
      sfx.air({ gain: 0.18, decay: 0.9, freq: 900, sweep: 0.6 });
    }

    // 落ちたカードが山に触れるたび。下から順に、左右交互に落ちる
    const land = cyc * N + clamp01((u - REL0 - FALL) / (STEP * N)) * N;
    for (let k = landTick(land); k > 0; k--) {
      const r = landed % N;
      landed++;
      const right = (N - 1 - r) % 2 === 0; // 偶数の位置は上半分（右の山）から来る
      sfx.pluck(tone((right ? 12 : 10) + ((r >> 1) % 3)), {
        gain: 0.12,
        decay: 0.35,
        pan: right ? 0.4 : -0.4,
      });
    }

    for (let k = squareTick(cyc + (u >= SQ0 + SQD * 0.8 ? 1 : 0)); k > 0; k--) {
      sfx.drop(tone(3), { gain: 0.3, decay: 0.6, bend: 0.8 });
    }
  },
};
