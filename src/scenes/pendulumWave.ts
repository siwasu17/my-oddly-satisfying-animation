import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * Pendulum Wave — 振り子の波。
 *
 * 横一列に吊った 16 個の振り子は、糸の長さが少しずつ違う。CYCLE 秒のあいだに
 * i 番目はちょうど BASE + i 往復するので、揃って放たれた玉はすぐにずれ始め、
 * 蛇のようにうねり、二列に割れ、三列に割れ……と模様を変えながら、
 * CYCLE 秒後にまた一枚の線へ戻ってくる。
 *
 * 何が動くか: 長さの違う 16 本の振り子（面ではなく、玉の並びが作る線で見せる）
 * 気持ちよさの芯: ばらばらになったはずの玉が、うねりを経て一直線に揃う瞬間
 * ループの周期: 48 秒（半周期の 24 秒で交互に二列へ割れる）
 * カメラ: ほぼ真上から。振れる向きが画面の上下になり、玉の並びがそのまま波として読める
 * 音: 数本おきの振り子が奥の端で折り返すたびに、長さに応じた高さで弾く。低いドローン
 * スコープ外: 空気抵抗による減衰、糸のたわみ、玉どうしの衝突
 */

/** 振り子の本数 */
const N = 16;
/** 一巡の秒数。全員が揃って戻るまで */
const CYCLE = 48;
/** いちばん長い振り子が CYCLE 秒で往復する回数 */
const BASE = 24;
/** 振り子どうしの間隔 */
const GAP = 0.8;
/** 横木の高さ */
const TOP = 9.5;
/** いちばん長い糸の長さ */
const L_MAX = 8.2;
/** 振れ幅（ラジアン）。全員同じ */
const AMP = 0.42;
/** 玉の半径 */
const BALL = 0.26;
/** 何本おきに音を鳴らすか */
const SOUND_EVERY = 3;

const dummy = new THREE.Object3D();
const color = new THREE.Color();

let balls: THREE.InstancedMesh;
let strings: THREE.InstancedMesh;

/** 振り子ごとの [x, 振動数 Hz, 糸の長さ] */
const pend = new Float32Array(N * 3);

let ticks = tickers(N);

function angle(i: number, t: number): number {
  return AMP * Math.cos(2 * Math.PI * pend[i * 3 + 1] * t);
}

export const pendulumWave: SceneModule = {
  name: 'Pendulum Wave',
  desc: '長さの違う 16 個の振り子がうねり、割れ、48 秒ごとに一列へ戻ってくる。',
  camera: { pos: [0, 19, 10.5], target: [0, 3, -0.6] },

  build(root) {
    ticks = tickers(N);

    const f0 = BASE / CYCLE;
    for (let i = 0; i < N; i++) {
      const f = (BASE + i) / CYCLE;
      pend[i * 3] = (i - (N - 1) / 2) * GAP;
      pend[i * 3 + 1] = f;
      // 単振り子の周期は √L に比例するので、長さは振動数の 2 乗に反比例する
      pend[i * 3 + 2] = L_MAX * (f0 / f) ** 2;
    }

    const frameMat = new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.45, metalness: 0.7 });
    const halfW = ((N - 1) / 2) * GAP + 0.7;

    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, halfW * 2, 16), frameMat);
    bar.rotation.z = Math.PI / 2;
    bar.position.y = TOP;
    root.add(bar);

    for (const sx of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, TOP, 16), frameMat);
      post.position.set(sx * halfW, TOP / 2, 0);
      root.add(post);
    }

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(14, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.25, metalness: 0.9 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    root.add(floor);

    // 糸: 上端を原点に置き、Y スケールで長さを決める
    const sGeo = new THREE.CylinderGeometry(0.012, 0.012, 1, 6);
    sGeo.translate(0, -0.5, 0);
    strings = new THREE.InstancedMesh(
      sGeo,
      new THREE.MeshStandardMaterial({ color: emberColor(0.62), roughness: 0.5 }),
      N,
    );
    strings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(strings);

    balls = new THREE.InstancedMesh(
      new THREE.SphereGeometry(BALL, 32, 20),
      new THREE.MeshStandardMaterial({ roughness: 0.22, metalness: 0.55 }),
      N,
    );
    balls.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(balls);
  },

  update(t) {
    const shift = drift(t);
    for (let i = 0; i < N; i++) {
      const x = pend[i * 3];
      const L = pend[i * 3 + 2];
      const th = angle(i, t);

      dummy.position.set(x, TOP, 0);
      dummy.rotation.set(th, 0, 0);
      dummy.scale.set(1, L, 1);
      dummy.updateMatrix();
      strings.setMatrixAt(i, dummy.matrix);

      dummy.position.set(x, TOP - L * Math.cos(th), -L * Math.sin(th));
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      balls.setMatrixAt(i, dummy.matrix);

      // 真下を通る速い瞬間だけ、わずかに明るむ
      const speed = Math.abs(Math.sin(2 * Math.PI * pend[i * 3 + 1] * t));
      ember(color, 0.4 + 0.5 * (i / (N - 1)), shift, 0.03 + 0.06 * speed);
      balls.setColorAt(i, color);
    }
    strings.instanceMatrix.needsUpdate = true;
    balls.instanceMatrix.needsUpdate = true;
    if (balls.instanceColor) balls.instanceColor.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    sfx.drone(tone(0), 0.05);
    for (let i = 0; i < N; i += SOUND_EVERY) {
      // 位相が整数をまたぐ = 奥の端（θ = AMP）で折り返した瞬間
      for (let k = ticks[i](pend[i * 3 + 1] * t); k > 0; k--) {
        sfx.pluck(tone(5 + i / SOUND_EVERY), {
          gain: 0.13,
          decay: 1.8,
          pan: (pend[i * 3] / (N * GAP * 0.5)) * 0.7,
        });
      }
    }
  },
};
