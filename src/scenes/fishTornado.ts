import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * 水槽の中で、小魚の群れが竜巻のかたちに回遊しつづける。
 *
 * 何が動くか: 300 匹の小魚が、上ほど広がる漏斗型の渦を描いて泳ぐ。外側をゆっくり上り、
 *   頂点で内側へ倒れ込み、細い中心を速く下って底からまた外へ出る。渦そのものは
 *   23.5 秒かけて締まったり緩んだりを繰り返す。
 * 気持ちよさの芯: 群れ全体が一匹の生き物のように向きを揃えているのに、数匹ずつが
 *   ばらばらの拍で身をひるがえし、そのたび腹が銀色に閃く。
 * カメラ: 水槽を横からやや見下ろす。漏斗が画面の高さいっぱいに立つ距離に置く。
 * 音: 底に低い唸りを敷き、渦が締まりきる瞬間に水の擦れる音、閃きに合わせて疎らな粒。
 * スコープ外: 個体どうしの相互作用（boids）、ガラスの屈折や水面の揺らぎ、泡、餌や捕食者。
 */

const TAU = Math.PI * 2;

// ---- 調整する数値 ----
const FISH = 300; // 小魚の数。増やすほど 1 匹の向きが潰れて粒の雲になる
const TANK_W = 18; // 水槽の内寸（横）
const TANK_H = 14; // 同（高さ）
const TANK_D = 13; // 同（奥行き）

const CORE_R = 3.6; // 渦の断面の中心半径
const CORE_Y = 6.9; // 渦の断面の中心高さ
const CORE_RA = 1.6; // 断面の横径（渦の肉厚）
const CORE_RB = 5.2; // 断面の縦径（渦の背丈）
const SHEAR = 0.42; // 上ほど外へ振る量。漏斗の開き具合（上端半径が下端の約 4 倍）
const BREATH_AMT = 0.17; // 渦が締まる／緩む深さ
const BREATH = 23.5; // 呼吸の周期（秒）
const CIRC = 17.3; // 断面を一巡する秒数（外を上り、内を下る）
const LAP = 9.1; // 中心軸まわりを一周する秒数
const SWIRL = 1.5; // 内側ほど速く回る強さ
const JITTER_R = 0.5; // 個体ごとの半径のばらつき
const JITTER_Y = 0.45; // 同（高さ）
const FISH_LEN = 0.88; // 魚の全長。体は前後に細長い紡錘形、後端に尾びれを付ける
const FLASH_RATE = 0.21; // 腹をひるがえす頻度（回/秒）

/** 魚ごとの [断面位相, 方位角, 半径ジッター, 高さジッター, 速さ倍率, 閃き位相] */
const fish = new Float32Array(FISH * 6);

const dummy = new THREE.Object3D();
const color = new THREE.Color();
const here = new THREE.Vector3();
const ahead = new THREE.Vector3();

let school: THREE.InstancedMesh;
let fins: THREE.InstancedMesh;
let tickBreath = ticker();
let tickFlash = ticker();
let step = 0;

/** 魚 i の位置を t から作る。差分は積み上げない。 */
function place(i: number, t: number, breath: number, out: THREE.Vector3): void {
  const o = i * 6;
  const v = fish[o + 4];
  const theta = TAU * (fish[o] + (t / CIRC) * v);
  const y = CORE_Y + CORE_RB * Math.sin(theta) + fish[o + 3];
  const r = Math.max(
    0.45,
    (CORE_R + CORE_RA * Math.cos(theta)) * breath + SHEAR * (y - CORE_Y) + fish[o + 2],
  );
  // 内側（theta ≒ π）で余分にひねりが乗り、渦の芯ほど速く回って見える
  const a = fish[o + 1] + TAU * (t / LAP) * v - SWIRL * Math.sin(theta);
  out.set(r * Math.cos(a), y, r * Math.sin(a));
}

export const fishTornado: SceneModule = {
  name: 'Fish Tornado',
  desc: '小魚の群れが水槽の中で漏斗状の渦を巻き、ときおり腹をひるがえして光る。',
  camera: { pos: [0, 9.6, 21], target: [0, 6.9, 0] },

  build(root) {
    let s = 0.4173;
    const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);

    for (let i = 0; i < FISH; i++) {
      const o = i * 6;
      fish[o + 0] = rnd();
      fish[o + 1] = rnd() * TAU;
      fish[o + 2] = (rnd() - 0.5) * 2 * JITTER_R;
      fish[o + 3] = (rnd() - 0.5) * 2 * JITTER_Y;
      fish[o + 4] = 0.92 + rnd() * 0.16;
      fish[o + 5] = rnd();
    }

    // 魚体。八面体を前後に引き伸ばし、幅:高さ:全長 ≒ 0.3:0.5:1 の厚みのある紡錘形にする。
    // 平板にすると木の葉や紙片に見えてしまうので、左右を潰しすぎないこと。
    // Object3D.lookAt は +Z 軸を対象へ向ける（-Z なのは Camera と Light）。
    // したがって頭が +Z・尾が -Z 側になる。
    const body = new THREE.OctahedronGeometry(0.5);
    body.scale(FISH_LEN * 0.3, FISH_LEN * 0.52, FISH_LEN);
    school = new THREE.InstancedMesh(
      body,
      new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.55 }),
      FISH,
    );
    school.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(school);

    // 尾びれ。後端に薄い縦板を足すだけでシルエットが魚に寄る
    const tail = new THREE.OctahedronGeometry(0.5);
    tail.scale(FISH_LEN * 0.045, FISH_LEN * 0.5, FISH_LEN * 0.34);
    tail.translate(0, 0, -FISH_LEN * 0.55);
    fins = new THREE.InstancedMesh(
      tail,
      new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.3 }),
      FISH,
    );
    fins.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(fins);

    // 水槽の底。粗めにして、点光源が一点で焼き付かないようにする
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(TANK_W, TANK_D),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.6, metalness: 0.35 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    root.add(floor);

    // 水槽はガラス面を張らず稜線だけ。手前の面で群れを隠さないため
    const frame = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(TANK_W, TANK_H, TANK_D)),
      new THREE.LineBasicMaterial({
        color: emberColor(0.22),
        transparent: true,
        opacity: 0.3,
      }),
    );
    frame.position.y = TANK_H / 2;
    root.add(frame);

    tickBreath = ticker();
    tickFlash = ticker();
    step = 0;
  },

  update(t) {
    const breath = 1 + BREATH_AMT * Math.sin(TAU * (t / BREATH));
    const shift = drift(t);

    for (let i = 0; i < FISH; i++) {
      place(i, t, breath, here);
      place(i, t + 0.06, breath, ahead);

      dummy.position.copy(here);
      dummy.lookAt(ahead);
      dummy.updateMatrix();
      school.setMatrixAt(i, dummy.matrix);
      fins.setMatrixAt(i, dummy.matrix);

      // sin の高い冪で、数匹ずつが一瞬だけ腹を返したように光る
      const o = i * 6;
      const phase = TAU * (fish[o + 5] + t * FLASH_RATE * fish[o + 4]);
      const flash = Math.pow(Math.max(0, Math.sin(phase)), 14);
      const h = Math.min(1, Math.max(0, (here.y - (CORE_Y - CORE_RB)) / (CORE_RB * 2)));
      const n = 0.2 + 0.26 * h + 0.44 * flash;
      ember(color, n, shift, flash * 0.16);
      school.setColorAt(i, color);
      // 尾びれは一段落として、後端が影になるようにする
      ember(color, n * 0.7, shift);
      fins.setColorAt(i, color);
    }
    school.instanceMatrix.needsUpdate = true;
    if (school.instanceColor) school.instanceColor.needsUpdate = true;
    fins.instanceMatrix.needsUpdate = true;
    if (fins.instanceColor) fins.instanceColor.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    sfx.drone(tone(-7), 0.04);

    // 渦が締まりきる瞬間（sin が谷を通る）に水の擦れる音
    for (let k = tickBreath(t / BREATH + 0.26); k > 0; k--) {
      sfx.air({ gain: 0.2, decay: 3.2, freq: 480, q: 1.0, sweep: -0.35 });
    }

    // 閃きは 300 匹ぶん鳴らすと団子になるので、疎らな拍だけを拾う
    for (let k = tickFlash(t * 0.62); k > 0; k--) {
      step++;
      sfx.pluck(tone(9 + ((step * 3) % 5)), {
        gain: 0.16,
        decay: 2.8,
        pan: Math.sin(step * 1.7) * 0.6,
      });
    }
  },
};
