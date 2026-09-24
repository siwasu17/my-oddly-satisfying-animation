import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { SURFACE, emberColor, drift } from '../palette.ts';

/**
 * Cube Net Fold。
 *
 * 床に十字の展開図が寝ていて、4 枚の側板が蝶番を軸に 1 枚ずつ起き上がり、
 * 最後に奥の板についた蓋が倒れてきて、隙間なく箱として閉じる。
 * 板の内側だけが琥珀色にほんのり灯っていて、閉じると光が中へ仕舞われる。
 * しばらく閉じたまま置いてから逆の順に開き、平らな展開図へ戻る。26 秒で一巡。
 *
 * 気持ちよさの芯は、立ち切った板が小さく「コトン」と跳ね返る手応えと、蓋が落ちて閉じる瞬間。
 * 板は入れ子の Group で蝶番につないであり、角度はすべて t から直接決める。
 * 音: 側板が立つたびに pluck が 1 音ずつ上がり、蓋が閉じると低い drop。
 *     開くときは短い air、板が床へ戻るたびに小さな pluck。
 * スコープ外: 複数の箱、展開図の種類の切り替え、箱ごと転がす動き。
 */

/** 板の一辺 */
const S = 3;
/** 板の厚み */
const T = 0.12;
/** 一巡の秒数 */
const PERIOD = 26;

/** 平らなまま置いておく秒数（周期の頭） */
const FLAT_HOLD = 2;
/** 側板が 1 枚起き上がるのにかける秒数 */
const SIDE_DUR = 1.5;
/** 側板どうしの起き上がり開始の間隔 */
const SIDE_GAP = 1.1;
/** 蓋が倒れてくるのにかける秒数 */
const LID_DUR = 1.6;
/** 閉じてから開き始めるまで */
const CLOSED_HOLD = 5;
/** 開くときの側板どうしの間隔 */
const OPEN_GAP = 0.9;
/** 着地したときの跳ね返りの大きさ（1 = 90 度） */
const BOUNCE = 0.045;

/** 内側の灯り */
const INNER_GLOW = 0.2;
/** 底板の内側は周りの板より少し明るく（光源が箱の中にある感じ） */
const BASE_GLOW = 0.34;

const CAMERA_POS: [number, number, number] = [10, 13, 15];
const CAMERA_TARGET: [number, number, number] = [0, 1.2, -1.8];

/** 側板の向き（ラジアン、yaw）。起き上がる順に並べる。奥の板（-Z）に蓋がつく */
const SIDES = [Math.PI / 2, Math.PI, 0, -Math.PI / 2];
/** SIDES のうち蓋がつく板の添字 */
const LID_ON = 0;

// --- 時刻表 ---------------------------------------------------------------
const foldStart = SIDES.map((_, i) => FLAT_HOLD + i * SIDE_GAP);
const lidStart = foldStart[SIDES.length - 1] + SIDE_DUR + 0.4;
const lidOpen = lidStart + LID_DUR + CLOSED_HOLD;
/** 開くときは起き上がりと逆の順（最後に立った板から寝る） */
const openStart = SIDES.map((_, i) => lidOpen + LID_DUR + 0.2 + (SIDES.length - 1 - i) * OPEN_GAP);

const ease = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** 着地後の小さな跳ね返り。s = 着地からの秒数 */
function bounce(s: number): number {
  if (s <= 0) return 0;
  return BOUNCE * Math.abs(Math.sin(s * 14)) * Math.exp(-s * 7);
}

/** c = 周期内の時刻。閉じる向きに 0..1（1 = 直角に立っている） */
function hinge(c: number, start: number, dur: number, back: number): number {
  const shut = start + dur;
  const open = back + dur;
  if (c < start) return 0;
  if (c < shut) return ease((c - start) / dur);
  if (c < back) return 1 - bounce(c - shut);
  if (c < open) return 1 - ease(clamp01((c - back) / dur));
  return bounce(c - open);
}

let folds: THREE.Group[] = [];
let lidFold: THREE.Group;
let innerMat: THREE.MeshStandardMaterial;
let outerMat: THREE.MeshStandardMaterial;
let baseMat: THREE.MeshStandardMaterial;

let ticks = tickers(0);

/** 厚みのある板。上面（+Y）だけ内側のマテリアルにする */
function panel(w: number, len: number, inner = innerMat): THREE.Mesh {
  const geo = new THREE.BoxGeometry(len, T, w);
  geo.translate(len / 2, T / 2, 0); // 蝶番（原点）から +X へ伸びる
  // BoxGeometry の面順は +x, -x, +y, -y, +z, -z
  return new THREE.Mesh(geo, [outerMat, outerMat, inner, outerMat, outerMat, outerMat]);
}

export const cubeNetFold: SceneModule = {
  name: 'Cube Net Fold',
  desc: '十字の展開図が一枚ずつ起き上がり、蓋が落ちて箱になる。しばらくして、また平らに開く。',
  camera: { pos: CAMERA_POS, target: CAMERA_TARGET },

  build(root) {
    // 側板の着地 4 / 蓋 1 / 開いて床に戻る 4 / 開き始め 1
    ticks = tickers(SIDES.length * 2 + 2);

    outerMat = new THREE.MeshStandardMaterial({
      color: emberColor(0.08),
      roughness: 0.5,
      metalness: 0.3,
    });
    innerMat = new THREE.MeshStandardMaterial({
      color: emberColor(0.7),
      emissive: emberColor(0.85),
      emissiveIntensity: INNER_GLOW,
      roughness: 0.55,
      metalness: 0.1,
    });

    baseMat = innerMat.clone();
    baseMat.emissiveIntensity = BASE_GLOW;

    const net = new THREE.Group();
    root.add(net);

    // 底板（中央）
    const base = panel(S, S, baseMat);
    base.position.x = -S / 2;
    net.add(base);

    folds = [];
    SIDES.forEach((yaw, i) => {
      const arm = new THREE.Group();
      arm.rotation.y = yaw;
      arm.position.set(Math.cos(yaw) * (S / 2), 0, -Math.sin(yaw) * (S / 2));
      net.add(arm);

      const fold = new THREE.Group();
      arm.add(fold);
      folds.push(fold);

      // ±Z の板は幅いっぱい、±X の板はその内側に収まる幅。蓋の下に潜る板は T だけ短い
      const alongX = Math.abs(Math.cos(yaw)) > 0.5;
      const w = alongX ? S - 2 * T : S;
      const len = i === LID_ON ? S : S - T;
      fold.add(panel(w, len));

      if (i === LID_ON) {
        const lidHinge = new THREE.Group();
        lidHinge.position.x = S;
        fold.add(lidHinge);
        lidFold = new THREE.Group();
        lidHinge.add(lidFold);
        lidFold.add(panel(S, S));
      }
    });

    // 床。金属っぽくしすぎると左奥のリムライトが床に白く映り込むので、粗めにしておく
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(S * 5, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.75, metalness: 0.4 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -0.02, -S);
    root.add(floor);
  },

  update(t) {
    const c = ((t % PERIOD) + PERIOD) % PERIOD;
    for (let i = 0; i < folds.length; i++) {
      folds[i].rotation.z = (Math.PI / 2) * hinge(c, foldStart[i], SIDE_DUR, openStart[i]);
    }
    lidFold.rotation.z = (Math.PI / 2) * hinge(c, lidStart, LID_DUR, lidOpen);

    // 内側の灯りは色相だけゆっくり揺らす
    innerMat.emissive.copy(emberColor(0.85, drift(t)));
    baseMat.emissive.copy(innerMat.emissive);
  },

  sound(t, _dt, sfx) {
    const n = SIDES.length;
    const at = (k: number, time: number): number => ticks[k]((t - time) / PERIOD);

    for (let i = 0; i < n; i++) {
      const pan = Math.cos(SIDES[i]) * 0.5;
      // 立ち切った瞬間。1 枚ごとに音が上がる
      for (let k = at(i, foldStart[i] + SIDE_DUR); k > 0; k--) {
        sfx.pluck(tone(7 + i), { gain: 0.32, decay: 1.8, pan });
      }
      // 開いて床に戻った瞬間。小さく低く
      for (let k = at(n + i, openStart[i] + SIDE_DUR); k > 0; k--) {
        sfx.pluck(tone(3 + i), { gain: 0.16, decay: 1.2, pan });
      }
    }
    // 蓋が閉じた
    for (let k = at(2 * n, lidStart + LID_DUR); k > 0; k--) {
      sfx.drop(tone(0), { gain: 0.5, decay: 0.9, bend: 0.8 });
    }
    // 蓋が開き始める
    for (let k = at(2 * n + 1, lidOpen); k > 0; k--) {
      sfx.air({ gain: 0.22, decay: 1.4, freq: 500, sweep: 1.6 });
    }
  },
};
