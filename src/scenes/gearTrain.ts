import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * Gear Train。
 *
 * 何が動くか: 背板に留められた 6 枚の歯車が数珠つなぎに噛み合い、いちばん大きな
 * 歯車から順に回転が伝わっていく。隣り合う歯車は必ず逆向きに回り、歯数が半分に
 * なれば倍の速さで回る。歯は互いの谷へ吸い込まれるように入り、噛み合いが外れない。
 * 気持ちよさの芯: 速さも向きもばらばらな 6 枚が、歯 1 枚ぶんもずれずに噛み合ったまま
 * 回り続けるところ。どこを見ても辻褄が合っている。
 * ループの周期: 36 秒。歯数をすべて BASE(96) の約数にしてあるので、この 1 周期で
 * 全部の歯車が寸分違わず初期姿勢へ戻る。
 * カメラ: 装置の正面から、わずかに右上へ振って厚みを見せる。
 * 音: 歯車が 1 回転するたびに 1 音。大きい歯車ほど低く、まれにしか鳴らない。
 * 底に機械の低いうなりを敷く。
 * スコープ外: 物理演算、外部アセット、遊星機構や内歯車。
 *
 * 歯の位相は式で決めている。歯車 i-1 から見て角度 a の方向に歯車 i を置くとき、
 *   θ_i = -(n_{i-1}/n_i)·θ_{i-1} + a·(1 + n_{i-1}/n_i) + π/n_i
 * とすれば、相手の歯山がこちらの歯谷の中心へ来る。θ_{i-1} が時刻の一次式なので
 * θ_i も一次式になり、係数と定数を build で 1 度だけ畳んでおけば
 * update は rotation.z への代入 1 行で済む。
 */

// ---- 調整する数値 ----
const TEETH = [48, 12, 24, 16, 24, 12] as const; // 歯数。すべて BASE の約数にする
// 前の歯車から次を置く方向（ラジアン）。噛み合わない歯車どうしが重ならない値を選んである
// （振ると簡単に食い込むので、変えたら全ペアの中心距離を確かめること）。
const LINKS = [0.97, -0.36, 0.25, -1.26, 0.91];
const BASE = 96; // 回転比の基準。TEETH がこの約数でないとループが閉じない
const MODULE = 0.16; // 歯 1 枚ぶんの大きさ。歯先円の半径 = MODULE * 歯数 / 2
const BACKLASH = 0.44; // 歯の太さ。0.5 でぴったり、それ未満が遊び
const THICK = 0.8; // 歯車の厚み
const CYCLE = 36; // 全部の歯車が初期姿勢へ戻るまでの秒数
const SPOKE_MIN = 20; // これ以上の歯数の歯車には腕を入れる
const SPOKES = 5; // 腕の本数
const PLATE_Z = -1.15; // 背板の位置（歯車は z = 0 の面に並ぶ）

const N = TEETH.length;

/** 歯先円の半径 */
const radius: number[] = TEETH.map((n) => (MODULE * n) / 2);
/** 歯車の本体（歯を除いた円盤）の半径 */
const bodyR: number[] = radius.map((r) => r - MODULE * 0.9);

/** 歯車の中心。連結方向に順に置いてから、全体を原点へ寄せる。 */
const cx = new Float64Array(N);
const cy = new Float64Array(N);

/** 回転角 = spin[i] * t + phase[i]。噛み合い条件を畳んだもの。 */
const spin = new Float64Array(N);
const phase = new Float64Array(N);

{
  for (let i = 1; i < N; i++) {
    const d = radius[i - 1] + radius[i];
    cx[i] = cx[i - 1] + Math.cos(LINKS[i - 1]) * d;
    cy[i] = cy[i - 1] + Math.sin(LINKS[i - 1]) * d;
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < N; i++) {
    minX = Math.min(minX, cx[i] - radius[i]);
    maxX = Math.max(maxX, cx[i] + radius[i]);
    minY = Math.min(minY, cy[i] - radius[i]);
    maxY = Math.max(maxY, cy[i] + radius[i]);
  }
  const ox = (minX + maxX) / 2;
  const oy = (minY + maxY) / 2;
  for (let i = 0; i < N; i++) {
    cx[i] -= ox;
    cy[i] -= oy;
  }

  spin[0] = ((Math.PI * 2) / CYCLE) * (BASE / TEETH[0]);
  for (let i = 1; i < N; i++) {
    const k = TEETH[i - 1] / TEETH[i];
    const a = Math.atan2(cy[i] - cy[i - 1], cx[i] - cx[i - 1]);
    spin[i] = -k * spin[i - 1];
    phase[i] = -k * phase[i - 1] + a * (1 + k) + Math.PI / TEETH[i];
  }
}

/** 速い歯車ほど明るい琥珀へ寄せる。 */
const tintOf = (i: number): number => {
  const fast = BASE / TEETH[i]; // 2 (48枚) 〜 8 (12枚)
  return 0.34 + 0.4 * ((fast - 2) / 6);
};

const dummy = new THREE.Object3D();
const color = new THREE.Color();

const gears: THREE.Group[] = [];
const bodyMats: THREE.MeshStandardMaterial[] = [];
const toothMats: THREE.MeshStandardMaterial[] = [];

/** 歯車ごとに「1 回転した回数」を数える */
let ticks = tickers(N);

export const gearTrain: SceneModule = {
  name: 'Gear Train',
  desc: '噛み合った歯車の列。小さいものほど速く、隣どうしは必ず逆へ回る。',
  camera: { pos: [1.8, 2.0, 13], target: [0, 0.1, 0] },

  build(root) {
    ticks = tickers(N);
    gears.length = 0;
    bodyMats.length = 0;
    toothMats.length = 0;

    // 背板。歯車が浮いて見えないよう、暗い面を 1 枚だけ後ろへ置く。
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(46, 28),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.85, metalness: 0.2 }),
    );
    plate.position.z = PLATE_Z;
    root.add(plate);

    // 歯はすべて同じ大きさ（モジュールが共通なら歯の形も共通）なので 1 つを使い回す。
    const toothGeo = new THREE.BoxGeometry(MODULE * 2, MODULE * Math.PI * BACKLASH, THICK);
    const pinGeo = new THREE.CylinderGeometry(0.11, 0.11, -PLATE_Z, 10);
    const pinMat = new THREE.MeshStandardMaterial({
      color: SURFACE,
      roughness: 0.5,
      metalness: 0.4,
    });

    for (let i = 0; i < N; i++) {
      // 背板から生えた軸。歯車と一緒には回さない。
      const pin = new THREE.Mesh(pinGeo, pinMat);
      pin.rotation.x = Math.PI / 2;
      pin.position.set(cx[i], cy[i], PLATE_Z / 2);
      root.add(pin);

      const g = new THREE.Group();
      g.position.set(cx[i], cy[i], 0);
      root.add(g);
      gears.push(g);

      const tint = tintOf(i);
      const bodyMat = new THREE.MeshStandardMaterial({
        color: emberColor(tint),
        roughness: 0.46,
        metalness: 0.34,
      });
      const toothMat = new THREE.MeshStandardMaterial({
        color: emberColor(tint, 0, 0.12),
        roughness: 0.34,
        metalness: 0.42,
      });
      bodyMats.push(bodyMat);
      toothMats.push(toothMat);

      const r = bodyR[i];
      const seg = Math.max(28, TEETH[i] * 2);

      // 縁。両端の蓋を持たない筒にすると、内側が窪んで輪に見える。
      const rim = new THREE.Mesh(
        new THREE.CylinderGeometry(r, r, THICK, seg, 1, true),
        bodyMat,
      );
      rim.rotation.x = Math.PI / 2;
      g.add(rim);

      // 縁の内側を埋める薄い円盤。
      const web = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.995, r * 0.995, THICK * 0.36, seg),
        bodyMat,
      );
      web.rotation.x = Math.PI / 2;
      g.add(web);

      // 軸受け。少しだけ前後へ出しておくと回転が読みやすい。
      const hubR = Math.max(0.2, r * 0.26);
      const hub = new THREE.Mesh(
        new THREE.CylinderGeometry(hubR, hubR, THICK * 1.3, 18),
        toothMat,
      );
      hub.rotation.x = Math.PI / 2;
      g.add(hub);

      // 腕。大きい歯車だけに入れる。歯だけだと回転の向きが読み取りにくい。
      if (TEETH[i] >= SPOKE_MIN) {
        const armLen = r - hubR;
        const armGeo = new THREE.BoxGeometry(armLen, MODULE * 1.5, THICK * 0.62);
        for (let s = 0; s < SPOKES; s++) {
          const a = (s / SPOKES) * Math.PI * 2;
          const arm = new THREE.Mesh(armGeo, bodyMat);
          arm.position.set(Math.cos(a) * (hubR + armLen / 2), Math.sin(a) * (hubR + armLen / 2), 0);
          arm.rotation.z = a;
          g.add(arm);
        }
      }

      // 歯。歯車ごとに 1 つの InstancedMesh へ詰め、姿勢は build で決めきる。
      const teeth = new THREE.InstancedMesh(toothGeo, toothMat, TEETH[i]);
      for (let k = 0; k < TEETH[i]; k++) {
        const a = (k / TEETH[i]) * Math.PI * 2;
        dummy.position.set(Math.cos(a) * radius[i], Math.sin(a) * radius[i], 0);
        dummy.rotation.set(0, 0, a);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        teeth.setMatrixAt(k, dummy.matrix);
      }
      teeth.instanceMatrix.needsUpdate = true;
      g.add(teeth);
    }
  },

  update(t) {
    const shift = drift(t);
    for (let i = 0; i < N; i++) {
      gears[i].rotation.z = spin[i] * t + phase[i];

      const tint = tintOf(i);
      ember(color, tint, shift);
      bodyMats[i].color.copy(color);
      ember(color, tint, shift, 0.12);
      toothMats[i].color.copy(color);
    }
  },

  sound(t, _dt, sfx) {
    for (let i = 0; i < N; i++) {
      // 1 回転を 1 拍として数える。向きは符号で入っているので絶対値で見る。
      const turns = (Math.abs(spin[i]) * t) / (Math.PI * 2);
      for (let k = ticks[i](turns); k > 0; k--) {
        sfx.pluck(tone(Math.round(20 - TEETH[i] * 0.28)), {
          gain: 0.1 + (0.2 * TEETH[i]) / TEETH[0],
          decay: 1.4 + (2.2 * TEETH[i]) / TEETH[0],
          pan: Math.max(-1, Math.min(1, cx[i] / 9)),
        });
      }
    }
    sfx.drone(tone(-7), 0.035 + 0.012 * Math.sin(t * 0.6));
  },
};
