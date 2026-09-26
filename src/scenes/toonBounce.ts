import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { emberColor } from '../palette.ts';

/**
 * Toon Bounce。
 *
 * セル調（トゥーン）の陰影と黒い輪郭線をまとったゴム鞠が 7 つ、一列に並んで弾む。
 * 陰影は 3 段しか無いので、鞠が床で潰れて伸びるたびに明暗の境目がパキッと動き、
 * 手描きアニメのスカッシュ＆ストレッチがそのまま立体になる。
 *
 * 着地の順番は、端から端へ流れる波（ずれが最大）と、全員が同時に着地する瞬間
 * （ずれが 0）のあいだを 28.8 秒かけて往復する。周期は弾む周期 1.2 秒のちょうど 24 倍なので、
 * 28.8 秒で完全に元へ戻る。音は着地ごとに鞠ごとの音程で 1 つ弾く。揃う瞬間は和音になる。
 *
 * スコープ外: 着地の衝撃線・土煙などの漫画的な効果、鞠の模様（回転が見えないため）。
 */

/** 鞠の数 */
const N = 7;
/** 鞠の半径 */
const R = 0.9;
/** 鞠どうしの間隔 */
const GAP = 2.45;
/** 跳ね上がる高さ（鞠の底から） */
const HEIGHT = 4.2;
/** 1 回弾む周期（秒） */
const PERIOD = 1.2;
/** 着地のずれが「揃う ⇄ 波」を往復する周期（秒）。PERIOD の整数倍にする */
const CYCLE = PERIOD * 24;
/** 波のときの、隣どうしの位相のずれ（周期に対する割合） */
const SPREAD = 1 / N;
/** 1 周期のうち床に接して潰れている割合 */
const CONTACT = 0.16;
/** 着地でどこまで潰れるか（縦の縮み） */
const SQUASH = 0.42;
/** 落下の速さで縦にどこまで伸びるか */
const STRETCH = 0.24;
/** 輪郭線の太さ（ワールド単位） */
const OUTLINE = 0.07;
/** 輪郭線の色 */
const INK = 0x1a0c0a;
/** セルの段（0..255）。暗い順 */
const BANDS = [25, 100, 255];
/** ホリゾントの色（ember の n）。鞠より暗くして主役を立てる */
const STAGE_TONE = 0.03;
/** ホリゾントの幅・手前の端・奥の壁の位置・曲がりの半径・壁の高さ */
const STAGE_W = 80;
const STAGE_FRONT = 24;
const STAGE_BACK = -6;
const STAGE_BEND = 4;
const STAGE_H = 30;

const shell = new THREE.Vector3();

let balls: THREE.Mesh[] = [];
let inks: THREE.Mesh[] = [];
let ticks = tickers(N);

/** 鞠 i の位相（整数をまたぐ瞬間 = 床に触れた瞬間） */
function phase(i: number, t: number): number {
  // ずれの量は 0（全員同時）〜 SPREAD を cos で往復する。t = 0 で揃っている
  const k = 0.5 - 0.5 * Math.cos((t / CYCLE) * Math.PI * 2);
  return t / PERIOD - (i - (N - 1) / 2) * SPREAD * k;
}

function smooth(e0: number, e1: number, x: number): number {
  const u = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return u * u * (3 - 2 * u);
}

/** 3 段のセル陰影を作るグラデーション。Nearest で引くので段が混ざらない */
function makeGradient(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array(BANDS), BANDS.length, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** 床（y = 0）が奥で 1/4 円を描いて壁へ立ち上がる面を、断面を x 方向へ引き伸ばして作る */
function makeCyclorama(): THREE.BufferGeometry {
  // 断面 (z, y) を手前から奥・上へ並べる
  const prof: [number, number][] = [];
  const zb = STAGE_BACK + STAGE_BEND;
  for (let j = 0; j <= 8; j++) prof.push([STAGE_FRONT + ((zb - STAGE_FRONT) * j) / 8, 0]);
  for (let j = 1; j <= 16; j++) {
    const a = (j / 16) * (Math.PI / 2);
    prof.push([zb - Math.sin(a) * STAGE_BEND, STAGE_BEND - Math.cos(a) * STAGE_BEND]);
  }
  for (let j = 1; j <= 6; j++) prof.push([STAGE_BACK, STAGE_BEND + ((STAGE_H - STAGE_BEND) * j) / 6]);

  const pos: number[] = [];
  const idx: number[] = [];
  for (const [z, y] of prof) pos.push(-STAGE_W / 2, y, z, STAGE_W / 2, y, z);
  for (let j = 0; j < prof.length - 1; j++) {
    const a = j * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export const toonBounce: SceneModule = {
  name: 'Toon Bounce',
  desc: 'セル調の陰影と輪郭線のゴム鞠が、潰れて伸びて弾む。着地の波が流れては揃う。',
  camera: { pos: [0, 4.2, 15.5], target: [0, 2.4, 0] },
  environment: 0,
  shadows: true,

  build(root) {
    ticks = tickers(N);
    balls = [];
    inks = [];

    const gradient = makeGradient();
    const geo = new THREE.SphereGeometry(R, 48, 32);
    const inkMat = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide });

    for (let i = 0; i < N; i++) {
      const mat = new THREE.MeshToonMaterial({
        color: emberColor(0.5 + (0.45 * i) / (N - 1)),
        gradientMap: gradient,
      });
      const ball = new THREE.Mesh(geo, mat);
      root.add(ball);
      balls.push(ball);

      // 裏面だけを少し大きく描くと、表の縁から黒がはみ出して輪郭線になる
      const ink = new THREE.Mesh(geo, inkMat);
      ink.userData.shadow = false;
      root.add(ink);
      inks.push(ink);
    }

    // 床から奥の壁へ丸く立ち上がるホリゾント。セルの段が曲面の上で帯になり、
    // 黒い輪郭線が乗る「地」にもなる
    const stage = new THREE.Mesh(
      makeCyclorama(),
      new THREE.MeshToonMaterial({ color: emberColor(STAGE_TONE), gradientMap: gradient, side: THREE.DoubleSide }),
    );
    root.add(stage);
  },

  update(t) {
    for (let i = 0; i < N; i++) {
      const p = phase(i, t);
      const u = p - Math.floor(p);

      let sy: number;
      let y: number;
      if (u < CONTACT) {
        // 床に触れている間: 潰れてから戻る。底は床に付いたまま
        sy = 1 - SQUASH * Math.sin((u / CONTACT) * Math.PI);
        y = R * sy;
      } else {
        // 宙にいる間: 放物線。速いほど縦に伸びる（離陸直後と着地直前でならす）
        const s = (u - CONTACT) / (1 - CONTACT);
        const speed = Math.abs(1 - 2 * s);
        const ease = smooth(0, 0.1, s) * smooth(1, 0.94, s);
        sy = 1 + STRETCH * speed * speed * ease;
        y = R * sy + HEIGHT * 4 * s * (1 - s);
      }
      const sxz = 1 / Math.sqrt(sy); // 体積を保つ

      const ball = balls[i];
      // 影は落とすが受けない。球が自分の影を受けると、セルの段に筋が走る
      ball.receiveShadow = false;
      ball.position.set((i - (N - 1) / 2) * GAP, y, 0);
      ball.scale.set(sxz, sy, sxz);

      // 輪郭は軸ごとに一定の厚みだけ大きくする（潰れても線の太さが変わらない）
      shell.set(sxz + OUTLINE / R, sy + OUTLINE / R, sxz + OUTLINE / R);
      const ink = inks[i];
      ink.position.copy(ball.position);
      ink.scale.copy(shell);
    }
  },

  sound(t, _dt, sfx) {
    for (let i = 0; i < N; i++) {
      for (let k = ticks[i](phase(i, t)); k > 0; k--) {
        sfx.pluck(tone(5 + i), {
          gain: 0.14,
          decay: 1.1,
          pan: ((i - (N - 1) / 2) / N) * 1.4,
        });
      }
    }
  },
};
