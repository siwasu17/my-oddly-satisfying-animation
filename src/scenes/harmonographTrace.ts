import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { ember, drift } from '../palette.ts';

/**
 * Harmonograph Trace。
 *
 * 何が動くか: 振り子2つ分の正弦波を合成した1本の曲線を、光る「ペン先」が
 *   先端から描き足しながら、古い部分から順に薄れて消えていく。
 * 気持ちよさの芯: 複雑に見える曲線が、実は単純な円運動2つの重ね合わせだと
 *   ペン先の動きから納得できるところ。曲線は DRAW_PERIOD 秒でちょうど一周して
 *   閉じ、そこからまた同じ軌跡をなぞり直す。
 * ループの周期: DRAW_PERIOD 秒（30秒）。
 * カメラ: 少し斜め上から見下ろす固定位置。
 * 音: ペン先の速さにわずかに連動する持続音を薄く敷き、曲線が一周して
 *   始点へ戻るたびにベルを1つ鳴らす。
 * スコープ外: 曲線の形そのものをユーザーが選べるようにすること。
 */

/** 曲線が一周して閉じるまでの秒数 */
const DRAW_PERIOD = 30;
/** 見えている軌跡の長さ（秒換算）。短くして一筆書きらしさを保つ */
const WINDOW = 11;
/** 軌跡を刻む点の数 */
const TRAIL_POINTS = 220;
/** 曲線の中心の高さ */
const BASE_Y = 3;

/** x / y / z 成分の振幅（主振動・副振動の順）。副振動は小さく添えるだけに留める */
const AX1 = 9;
const AX2 = 2;
const AY1 = 7.5;
const AY2 = 2;
const AZ = 2.4;

/** 各成分の角振動数。DRAW_PERIOD に対する整数比にして、必ず一周で閉じるようにする。
 *  主振動同士を 3:2 の単純比にし、副振動は隣り合う整数にして緩やかな首振りだけを添える */
const NX1 = 3;
const NX2 = 4;
const NY1 = 2;
const NY2 = 3;
const NZ = 5;

/** 初期位相（固定値。開き直すたびに同じ絵になるよう Math.random は使わない） */
const P1 = 0;
const P2 = 1.15;
const P3 = 2.35;
const P4 = 0.62;
const P5 = 3.4;

/** 全体がゆっくり回る速さ（rad/s） */
const PIVOT_SPIN = 0.045;

/** ペン先の速さを測るための微小時間 */
const SPEED_EPS = 0.05;

const W0 = (Math.PI * 2) / DRAW_PERIOD;

const tmp = new THREE.Vector3();
const tmpPrev = new THREE.Vector3();
const color = new THREE.Color();
const penColor = new THREE.Color();

/** 曲線上の位置を、経過秒 s から求める（差分を積み上げない） */
function curvePoint(s: number, out: THREE.Vector3): THREE.Vector3 {
  out.set(
    AX1 * Math.sin(NX1 * W0 * s + P1) + AX2 * Math.sin(NX2 * W0 * s + P2),
    BASE_Y + AY1 * Math.sin(NY1 * W0 * s + P3) + AY2 * Math.sin(NY2 * W0 * s + P4),
    AZ * Math.sin(NZ * W0 * s + P5),
  );
  return out;
}

let pivot: THREE.Group;
let line: THREE.Line;
let pen: THREE.Mesh;
let penMat: THREE.MeshStandardMaterial;
let positions: Float32Array;
let colors: Float32Array;

/** 一周して始点へ戻った回数を数える。build のたびに作り直す */
let loopTick = ticker();

export const harmonographTrace: SceneModule = {
  name: 'Harmonograph Trace',
  desc: '振り子2つ分の波が描く曲線を、光るペン先が繰り返しなぞる。',
  camera: { pos: [4, BASE_Y + 2, 19], target: [0, BASE_Y, 0] },

  build(root) {
    loopTick = ticker();

    pivot = new THREE.Group();
    root.add(pivot);

    positions = new Float32Array(TRAIL_POINTS * 3);
    colors = new Float32Array(TRAIL_POINTS * 3);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));

    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true });
    line = new THREE.Line(geo, mat);
    pivot.add(line);

    penMat = new THREE.MeshStandardMaterial({ roughness: 0.25, metalness: 0.35 });
    pen = new THREE.Mesh(new THREE.SphereGeometry(0.24, 20, 20), penMat);
    pivot.add(pen);
  },

  update(t, dt) {
    pivot.rotation.y += dt * PIVOT_SPIN;

    const head = t;
    const hue = drift(t);

    for (let i = 0; i < TRAIL_POINTS; i++) {
      const u = i / (TRAIL_POINTS - 1); // 0 = 尾, 1 = 先端
      const s = head - WINDOW * (1 - u);
      curvePoint(s, tmp);

      positions[i * 3] = tmp.x;
      positions[i * 3 + 1] = tmp.y;
      positions[i * 3 + 2] = tmp.z;

      // 大部分は落ち着いた同じ調子の暖色にし、先端の近くだけ穏やかに明るくする
      // （白と赤が別物として分断して見えないよう、コントラストを緩やかにする）
      const n = 0.42 + u * 0.16;
      const glow = u > 0.82 ? ((u - 0.82) / 0.18) * 0.45 : 0;
      ember(color, n, hue, glow);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    (line.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (line.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;

    curvePoint(head, tmp);
    pen.position.copy(tmp);
    ember(penColor, 0.95, hue, 0.85);
    penMat.color.copy(penColor);
  },

  sound(t, _dt, sfx) {
    curvePoint(t, tmp);
    curvePoint(t - SPEED_EPS, tmpPrev);
    const speed = tmp.distanceTo(tmpPrev) / SPEED_EPS;

    sfx.drone(tone(4) + Math.min(speed * 1.4, 36), 0.14);

    for (let k = loopTick(t / DRAW_PERIOD); k > 0; k--) {
      sfx.pluck(tone(12), { gain: 0.55, decay: 3.2, pan: 0 });
    }
  },
};
