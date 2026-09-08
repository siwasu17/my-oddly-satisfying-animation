import * as THREE from 'three';
import type { SceneModule } from '../../types.ts';
import { tone, tickers } from '../../audio.ts';
import { ember, drift, SURFACE } from '../../palette.ts';

/**
 * Harmonograph Trace。
 *
 * 何が動くか: 振り子2つ分の正弦波を合成した同じ軌道を、LINE_COUNT 本の光る
 *   「ペン」が時間差を付けて追いかけっこしながらなぞる。ペン先はそれぞれ実際の
 *   点光源になっていて、背後の暗い板をほのかに照らす。
 * 気持ちよさの芯: 同じ曲線を追う光が少しずつずれて連なることで、1本だけでは
 *   読み取りにくかった「軌道」全体の形が浮かび上がるところ。
 * ループの周期: DRAW_PERIOD 秒（30秒）で軌道が一周して閉じ、また同じ軌跡へ戻る。
 * カメラ: 少し斜め上から見下ろす固定位置。
 * 音: 先頭のペンの速さにわずかに連動する持続音を薄く敷き、各ペンが一周して
 *   始点へ戻るたびに音程を変えたベルを鳴らす。
 * スコープ外: 線の本数や配色をユーザーが選べるようにすること。
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

/** 各ペンの出発時刻のずれ（秒）。曲線の主振動（10秒・15秒周期）と単純な整数比に
 *  ならない値を選び、時間差を付けたつもりのペン同士が周期的に同じ位置へ重なって
 *  見えてしまう共振を避ける */
const LINE_OFFSETS = [0, 8.3, 19.1];
/** 線（ペン）の本数。同じ軌道を時間差で追いかけっこする */
const LINE_COUNT = LINE_OFFSETS.length;
/** 線ごとの色相のずらし幅（±この範囲に収め、青を混ぜない） */
const HUE_STEP = 0.035;

/** ペン先の点光源の明るさ・届く距離・減衰。背後の板がはっきり見える強さにする */
const LIGHT_INTENSITY = 6;
const LIGHT_DISTANCE = 11;
const LIGHT_DECAY = 2;

/** 背後に置く暗い板。ペン先の光源が実際に照らす相手になる */
const BACKDROP_Z = -5;
const BACKDROP_W = 26;
const BACKDROP_H = 20;

/** 全体がゆっくり回る速さ（rad/s） */
const PIVOT_SPIN = 0.045;

/** 先頭のペンの速さを測るための微小時間 */
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
let backdrop: THREE.Mesh;
let lines: THREE.Line[] = [];
let positionsArr: Float32Array[] = [];
let colorsArr: Float32Array[] = [];
let pens: THREE.Mesh[] = [];
let penMats: THREE.MeshBasicMaterial[] = [];
let penLights: THREE.PointLight[] = [];

/** 各ペンが一周して始点へ戻った回数を数える。build のたびに作り直す */
let loopTicks = tickers(LINE_COUNT);

export const harmonographTrace: SceneModule = {
  name: 'Harmonograph Trace',
  desc: '同じ軌道を追いかけっこする、光るペン先が3本。',
  camera: { pos: [4, BASE_Y + 2, 19], target: [0, BASE_Y, 0] },

  build(root) {
    loopTicks = tickers(LINE_COUNT);

    pivot = new THREE.Group();
    root.add(pivot);

    backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(BACKDROP_W, BACKDROP_H),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.6, metalness: 0.15 }),
    );
    backdrop.position.set(0, BASE_Y, BACKDROP_Z);
    pivot.add(backdrop);

    lines = [];
    positionsArr = [];
    colorsArr = [];
    pens = [];
    penMats = [];
    penLights = [];

    for (let li = 0; li < LINE_COUNT; li++) {
      const positions = new Float32Array(TRAIL_POINTS * 3);
      const colors = new Float32Array(TRAIL_POINTS * 3);
      positionsArr.push(positions);
      colorsArr.push(colors);

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));

      const lineMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true });
      const ln = new THREE.Line(geo, lineMat);
      pivot.add(ln);
      lines.push(ln);

      // ペン先は光を反射するのではなく自ら光る。MeshBasicMaterial は光源の影響を受けない
      const penMat = new THREE.MeshBasicMaterial();
      const pen = new THREE.Mesh(new THREE.SphereGeometry(0.22, 20, 20), penMat);
      pivot.add(pen);
      pens.push(pen);
      penMats.push(penMat);

      const light = new THREE.PointLight(0xffffff, LIGHT_INTENSITY, LIGHT_DISTANCE, LIGHT_DECAY);
      pen.add(light); // ペンの子にして、位置更新を追随させる
      penLights.push(light);
    }
  },

  update(t, dt) {
    pivot.rotation.y += dt * PIVOT_SPIN;
    const hue = drift(t);

    for (let li = 0; li < LINE_COUNT; li++) {
      const head = t - LINE_OFFSETS[li];
      const shift = hue + (li - (LINE_COUNT - 1) / 2) * HUE_STEP;
      const positions = positionsArr[li];
      const colors = colorsArr[li];

      for (let i = 0; i < TRAIL_POINTS; i++) {
        const u = i / (TRAIL_POINTS - 1); // 0 = 尾, 1 = 先端
        const s = head - WINDOW * (1 - u);
        curvePoint(s, tmp);

        positions[i * 3] = tmp.x;
        positions[i * 3 + 1] = tmp.y;
        positions[i * 3 + 2] = tmp.z;

        // 大部分は落ち着いた同じ調子の暖色にし、先端の近くだけ穏やかに明るくする
        const n = 0.42 + u * 0.16;
        const glow = u > 0.82 ? ((u - 0.82) / 0.18) * 0.45 : 0;
        ember(color, n, shift, glow);
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
      }
      const geo = lines[li].geometry;
      (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;

      curvePoint(head, tmp);
      pens[li].position.copy(tmp);
      ember(penColor, 0.95, shift, 0.9);
      penMats[li].color.copy(penColor);
      penLights[li].color.copy(penColor);
    }
  },

  sound(t, _dt, sfx) {
    curvePoint(t, tmp);
    curvePoint(t - SPEED_EPS, tmpPrev);
    const speed = tmp.distanceTo(tmpPrev) / SPEED_EPS;
    sfx.drone(tone(4) + Math.min(speed * 1.4, 36), 0.14);

    for (let li = 0; li < LINE_COUNT; li++) {
      const head = t - LINE_OFFSETS[li];
      for (let k = loopTicks[li](head / DRAW_PERIOD); k > 0; k--) {
        sfx.pluck(tone(12 - li * 2), {
          gain: 0.45,
          decay: 3.2,
          pan: (li - (LINE_COUNT - 1) / 2) * 0.4,
        });
      }
    }
  },
};
