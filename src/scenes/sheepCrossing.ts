import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * Sheep Crossing。
 *
 * 奥へまっすぐ延びる田舎道を、運転席の少し上から眺めている。左の草地から
 * モフモフの羊の群れが現れ、とことこ弾みながら道を横切って右へ抜けていく。
 * 最後の 1 頭が抜けると道はしばらく空になり、また左から次の群れがやってくる。
 *
 * 羊の胴は小さな毛玉を楕円体の表面に 20 個ほど貼り合わせたもの。足が地面を
 * 蹴るたびに胴が跳ね、着地で毛玉ごとぷにっと潰れて戻る。毛玉は 1 つずつ
 * 位相をずらして膨らむので、歩くたびに毛並みがふわふわ揺れて見える。
 * 群れの中に 1 頭だけ焦げ茶の羊が混じっている。
 *
 * 位置はすべて t から作る（x は t の剰余）ので、周期 L / V 秒で必ず元に戻る。
 * 音は羊が道の中央線をまたぐたびに、柔らかい爪弾きが 1 つずつ鳴る。
 */

// ---- 群れ ----
/** 群れの列数（道に沿った奥行き方向） */
const ROWS = 3;
/** 1 列あたりの頭数 */
const COLS = 3;
const S = ROWS * COLS;
/** 列の間隔（z）。胴の幅 0.9 に対して余裕を持たせる */
const ROW_GAP = 2.3;
/** 同じ列の羊どうしの間隔（x） */
const COL_GAP = 3.5;
/** 歩く速さ（単位/秒） */
const V = 1.15;
/** x の周回長。群れの幅 + 画面外 + 空白。周期は L / V ≈ 33 秒 */
const L = 38;
/** 羊が現れる x（画面の左外） */
const X0 = -16;
/** t = 0 の時点で群れの先頭がどこまで来ているか（開いた瞬間を空にしない） */
const T0 = 10;
/** 焦げ茶の羊の番号 */
const BLACK = 4;

// ---- 羊 1 頭の形 ----
/** 1 頭あたりの毛玉の数（胴） */
const PUFFS = 20;
/** 胴の楕円体の半径（x: 前後 / y: 上下 / z: 左右） */
const BODY_R = new THREE.Vector3(0.6, 0.32, 0.34);
/** 胴の中心の高さ */
const BODY_Y = 1.1;
/** 足の長さ（腰から地面まで） */
const LEG_LEN = 0.74;
/** 歩調（歩/秒）。胴が 1 秒にこの回数跳ねる */
const STEP_HZ = 1.9;
/** 胴が跳ねる高さ */
const BOB = 0.09;

// ---- 道 ----
const ROAD_W = 6.4;
const ROAD_LEN = 70;
/** 中央線の破線の本数 */
const DASH_N = 16;

/** 頭と足の色。暗い地面に溶けない中間の明るさで、毛よりははっきり暗くする */
const DARK = emberColor(0.24, 0, -0.05);

const dummy = new THREE.Object3D();
const color = new THREE.Color();
const mSheep = new THREE.Matrix4();
const mBody = new THREE.Matrix4();
const mPart = new THREE.Matrix4();
const q = new THREE.Quaternion();
const v = new THREE.Vector3();
const sc = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);

let wool: THREE.InstancedMesh;
let heads: THREE.InstancedMesh;
let legs: THREE.InstancedMesh;

/** 羊ごとの [x のずらし, z, 歩調の位相, ゆらぎの位相, 毛色 n] */
const sheep = new Float32Array(S * 5);
/** 毛玉ごとの [x, y, z, 半径, 位相]（胴の中心から見た位置） */
const puffs = new Float32Array((PUFFS + 2) * 5);
/** 4 本の足の付け根（x, z）と、歩調に対する位相 */
const HIPS: [number, number, number][] = [
  [0.4, 0.2, 0],
  [0.4, -0.2, Math.PI],
  [-0.4, 0.2, Math.PI],
  [-0.4, -0.2, 0],
];

let ticks = tickers(S);

/** 羊 i の x を返す。道の中央 (x = 0) をまたぐ時刻は phase が整数をまたぐ時刻 */
const march = (t: number, i: number): number => t * V + T0 - sheep[i * 5];

export const sheepCrossing: SceneModule = {
  name: 'Sheep Crossing',
  desc: 'モフモフの羊の群れが、ぷにっと弾みながら目の前の道を横切っていく。',
  camera: { pos: [0, 5, 11.5], target: [0, 0.9, -1] },
  shadows: true,

  build(root) {
    ticks = tickers(S);

    // 配置は固定シードで決める。格子を少し崩して、群れらしいばらつきにする
    let s = 0.731;
    const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const i = r * COLS + c;
        sheep[i * 5] = c * COL_GAP + (r % 2) * COL_GAP * 0.5 + (rnd() - 0.5) * 0.9;
        sheep[i * 5 + 1] = (r - (ROWS - 1) / 2) * ROW_GAP + (rnd() - 0.5) * 0.5;
        sheep[i * 5 + 2] = rnd() * Math.PI * 2;
        sheep[i * 5 + 3] = rnd() * Math.PI * 2;
        sheep[i * 5 + 4] = i === BLACK ? 0.34 : 0.8 + rnd() * 0.08;
      }
    }

    // 毛玉は楕円体の表面にフィボナッチ格子で散らす。最後の 2 つは頭の上の前髪
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let k = 0; k < PUFFS; k++) {
      const y = 1 - (2 * (k + 0.5)) / PUFFS;
      const rr = Math.sqrt(1 - y * y);
      const a = k * golden;
      puffs[k * 5] = Math.cos(a) * rr * BODY_R.x;
      puffs[k * 5 + 1] = y * BODY_R.y;
      puffs[k * 5 + 2] = Math.sin(a) * rr * BODY_R.z;
      puffs[k * 5 + 3] = 0.37 + rnd() * 0.05;
      puffs[k * 5 + 4] = rnd() * Math.PI * 2;
    }
    for (let k = 0; k < 2; k++) {
      const j = (PUFFS + k) * 5;
      puffs[j] = 0.84 + k * 0.08;
      puffs[j + 1] = 0.32 - k * 0.04;
      puffs[j + 2] = (k - 0.5) * 0.12;
      puffs[j + 3] = 0.15;
      puffs[j + 4] = rnd() * Math.PI * 2;
    }

    wool = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 2),
      new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 }),
      S * (PUFFS + 2),
    );
    wool.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    wool.castShadow = true;
    root.add(wool);

    // 頭と耳（1 頭あたり 3 つ）。暗い色で毛の白さを立たせる
    heads = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshStandardMaterial({ color: DARK, roughness: 0.7 }),
      S * 3,
    );
    heads.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    heads.castShadow = true;
    root.add(heads);

    const legGeo = new THREE.CylinderGeometry(0.11, 0.09, LEG_LEN, 10);
    legGeo.translate(0, -LEG_LEN / 2, 0); // 原点を腰へ。回転がそのまま振り子になる
    legs = new THREE.InstancedMesh(
      legGeo,
      new THREE.MeshStandardMaterial({ color: DARK, roughness: 0.7 }),
      S * 4,
    );
    legs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    legs.castShadow = true;
    root.add(legs);

    // 草地と、奥へ延びる道
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(90, ROAD_LEN),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.95 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    root.add(ground);

    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(ROAD_W, ROAD_LEN),
      new THREE.MeshStandardMaterial({ color: new THREE.Color(SURFACE).multiplyScalar(0.55), roughness: 0.6, metalness: 0.3 }),
    );
    road.rotation.x = -Math.PI / 2;
    road.receiveShadow = true;
    root.add(road);

    const lineMat = new THREE.MeshStandardMaterial({ color: emberColor(0.1, 0, -0.04), roughness: 0.8 });
    for (const x of [-ROAD_W / 2 + 0.2, ROAD_W / 2 - 0.2]) {
      const edge = new THREE.Mesh(new THREE.PlaneGeometry(0.12, ROAD_LEN), lineMat);
      edge.rotation.x = -Math.PI / 2;
      edge.position.set(x, 0.01, 0);
      edge.receiveShadow = true;
      root.add(edge);
    }
    const dashes = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.16, 1.6), lineMat, DASH_N);
    dashes.receiveShadow = true;
    for (let k = 0; k < DASH_N; k++) {
      dummy.position.set(0, 0.01, ROAD_LEN / 2 - 2 - k * (ROAD_LEN / DASH_N));
      dummy.rotation.set(-Math.PI / 2, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      dashes.setMatrixAt(k, dummy.matrix);
    }
    root.add(dashes);
  },

  update(t) {
    const hue = drift(t);
    for (let i = 0; i < S; i++) {
      const ph = sheep[i * 5 + 2];
      const wob = sheep[i * 5 + 3];

      // 位置: 周回長 L の剰余で左から右へ。わずかに前後へ揺れて群れがほどける
      const u = (((march(t, i) % L) + L) % L);
      const x = X0 + u + 0.3 * Math.sin(t * 0.6 + wob);
      const z = sheep[i * 5 + 1] + 0.18 * Math.sin(t * 0.37 + wob * 1.3);
      const yaw = 0.1 * Math.sin(t * 0.5 + wob);

      // 歩調: 跳ねる高さ b（0..1）と、着地の潰れ sq（接地の瞬間に 1）
      const g = Math.PI * STEP_HZ * t + ph;
      const b = Math.abs(Math.sin(g));
      const sq = (1 - b) ** 3;
      const bodyY = BODY_Y + BOB * b;

      q.setFromAxisAngle(up, yaw);
      mSheep.compose(v.set(x, 0, z), q, sc.set(1, 1, 1));

      // 胴: 着地で縦に潰れ、横に膨らむ
      q.identity();
      mBody.compose(v.set(0, bodyY, 0), q, sc.set(1 + 0.05 * sq, 1 - 0.1 * sq, 1 + 0.05 * sq));
      mBody.premultiply(mSheep);

      ember(color, sheep[i * 5 + 4], hue, -0.14);
      for (let k = 0; k < PUFFS + 2; k++) {
        const j = k * 5;
        const r = puffs[j + 3] * (1 + 0.08 * Math.sin(2 * g + puffs[j + 4]));
        mPart.compose(v.set(puffs[j], puffs[j + 1], puffs[j + 2]), q, sc.set(r, r, r));
        mPart.premultiply(mBody);
        const n = i * (PUFFS + 2) + k;
        wool.setMatrixAt(n, mPart);
        wool.setColorAt(n, color);
      }

      // 頭: 歩調に合わせて小さくうなずく。耳は頭の左右に寝かせる
      const nod = 0.12 * Math.sin(2 * g + 0.8);
      dummy.rotation.set(0, 0, -0.25 + nod);
      dummy.position.set(1.12, bodyY + 0.1 + nod * 0.3, 0);
      dummy.scale.set(0.5, 0.34, 0.32);
      dummy.updateMatrix();
      heads.setMatrixAt(i * 3, mPart.multiplyMatrices(mSheep, dummy.matrix));
      for (let e = 0; e < 2; e++) {
        const side = e === 0 ? 1 : -1;
        dummy.rotation.set(side * 0.9, 0, 0);
        dummy.position.set(0.98, bodyY + 0.26 + nod * 0.3, side * 0.36);
        dummy.scale.set(0.1, 0.24, 0.08);
        dummy.updateMatrix();
        heads.setMatrixAt(i * 3 + 1 + e, mPart.multiplyMatrices(mSheep, dummy.matrix));
      }

      // 足: 対角の 2 本ずつが同じ向きに振れる
      for (let k = 0; k < 4; k++) {
        const [hx, hz, hp] = HIPS[k];
        dummy.rotation.set(0, 0, 0.38 * Math.sin(g + hp));
        dummy.position.set(hx, LEG_LEN + BOB * b * 0.6, hz);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        legs.setMatrixAt(i * 4 + k, mPart.multiplyMatrices(mSheep, dummy.matrix));
      }
    }
    wool.instanceMatrix.needsUpdate = true;
    if (wool.instanceColor) wool.instanceColor.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
    legs.instanceMatrix.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    // 羊が道の中央線 (x = 0) をまたぐたびに 1 音。列の奥行きでわずかに左右へ振る
    for (let i = 0; i < S; i++) {
      for (let k = ticks[i]((march(t, i) - (0 - X0)) / L); k > 0; k--) {
        sfx.pluck(tone(6 + ((i * 3) % 7)), {
          gain: i === BLACK ? 0.22 : 0.15,
          decay: 1.8,
          pan: sheep[i * 5 + 1] / 8,
        });
      }
    }
  },
};
