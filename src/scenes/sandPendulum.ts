import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * Sand Pendulum。
 *
 * 天井から吊るした砂の漏斗が振れ、こぼれた砂が床に軌跡を描いていく。
 * 揺れは x と z で 5 : 7 の周期を持ち、図形そのものも 48 秒で一周ぶん歳差するので、
 * 描かれる帯は同じ場所を二度なぞらずに少しずつ隣へずれていく。
 * 古い砂粒から順に痩せて暗くなって消えるため、模様が床に溜まりきることはない。
 * 48 秒でちょうど元の位置・元の模様へ戻る。
 */

/** ループ 1 周の秒数。すべての周期がこれの整数倍なので、48 秒後に同じ絵へ戻る */
const LOOP = 48;
/** 床に残る砂粒の数 */
const GRAINS = 900;
/** 何秒ぶんの軌跡を残すか */
const TRAIL_SEC = 11;
/** 揺れの大きさ。紐の長さ（PIVOT_Y - REST_Y）より小さく保つこと */
const AMP = 5.2;
/** x / z の主となる往復回数（LOOP あたり）。互いに素にしてあるので図が閉じない */
const KX = 5;
const KZ = 7;
/** 副次的な揺れ。軌跡に細いくびれを作る */
const KX2 = 13;
const KZ2 = 11;
const SECOND = 0.24;
/** 砂粒 1 粒の半径 */
const GRAIN_R = 0.13;
/** 吊り元の高さ。これ以上上げると吊り元がタブ列の裏へ切れる */
const PIVOT_Y = 8.2;
/** 中央にいるときの漏斗の先端の高さ */
const REST_Y = 1.2;
/** 振れ幅がいっぱいのときに漏斗が持ち上がる量 */
const LIFT = 0.95;
/** 砂皿の半径 */
const TRAY_R = 9;

const TAU = Math.PI * 2;
/** 揺れが届く最大の半径 */
const RMAX = AMP * (1 + SECOND);
/** 砂粒 1 つぶんの時間差 */
const DS = TRAIL_SEC / GRAINS;

const dummy = new THREE.Object3D();
const color = new THREE.Color();
const bob = new THREE.Vector3();
const pivot = new THREE.Vector3(0, PIVOT_Y, 0);
const dir = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

let grains: THREE.InstancedMesh;
let cord: THREE.Mesh;
let funnel: THREE.Group;

/** 砂粒ごとの散らし [dx, dz, dy]。固定シードなので開き直しても同じ絵になる */
const jitter = new Float32Array(GRAINS * 3);
let seed = 0.731;
const rnd = (): number => (seed = (seed * 9301 + 0.49297) % 1);
for (let i = 0; i < GRAINS; i++) {
  jitter[i * 3] = (rnd() - 0.5) * 0.34;
  jitter[i * 3 + 1] = (rnd() - 0.5) * 0.34;
  jitter[i * 3 + 2] = rnd() * 0.05;
}

/** 時刻 sec に砂が落ちた床の位置。純関数なので、いつでも t から引き直せる */
function fall(sec: number, out: THREE.Vector3): void {
  const w = TAU / LOOP;
  const env = 0.8 + 0.2 * Math.sin(w * sec);
  const x = (Math.sin(w * KX * sec) + SECOND * Math.sin(w * KX2 * sec + 1.1)) * AMP * env;
  const z = (Math.sin(w * KZ * sec + 0.6) + SECOND * Math.sin(w * KZ2 * sec)) * AMP * env;
  const a = w * sec; // 48 秒かけて 1 周ぶん歳差する
  const c = Math.cos(a);
  const n = Math.sin(a);
  out.set(x * c - z * n, 0, x * n + z * c);
}

/** 揺れの端をまたいだ回数。build のたびに作り直す */
let tickX = ticker();
let tickZ = ticker();
let stepX = 0;
let stepZ = 0;

export const sandPendulum: SceneModule = {
  name: 'Sand Pendulum',
  desc: '吊るした漏斗がこぼす砂が床に模様を描き、古い砂から順に消えていく。',
  // 吊り元から砂皿までを縦にちょうど収める。これ以上引くと軌跡が豆粒になる
  camera: { pos: [0, 11.5, 18.5], target: [0, 2.4, 0] },

  build(root) {
    tickX = ticker();
    tickZ = ticker();
    stepX = 0;
    stepZ = 0;

    const tray = new THREE.Mesh(
      new THREE.CircleGeometry(TRAY_R, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.38, metalness: 0.6 }),
    );
    tray.rotation.x = -Math.PI / 2;
    tray.position.y = -0.03;
    root.add(tray);

    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(TRAY_R, 0.16, 8, 120),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.45, metalness: 0.7 }),
    );
    rim.rotation.x = -Math.PI / 2;
    root.add(rim);

    grains = new THREE.InstancedMesh(
      new THREE.SphereGeometry(GRAIN_R, 8, 6),
      new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.2 }),
      GRAINS,
    );
    grains.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(grains);

    // 吊り紐。長さ 1 の円柱を毎フレーム伸ばして向きを与える。
    // SURFACE のままだと背景に溶けて振り子に見えないので、暗い暖色を持たせている
    cord = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, 1, 6),
      new THREE.MeshStandardMaterial({ color: emberColor(0.28), roughness: 0.5, metalness: 0.5 }),
    );
    root.add(cord);

    const anchor = new THREE.Mesh(
      new THREE.SphereGeometry(0.34, 16, 12),
      new THREE.MeshStandardMaterial({ color: emberColor(0.2), roughness: 0.5, metalness: 0.6 }),
    );
    anchor.position.copy(pivot);
    root.add(anchor);

    funnel = new THREE.Group();
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.8, 1.6, 20, 1, true),
      new THREE.MeshStandardMaterial({
        color: emberColor(0.34),
        roughness: 0.4,
        metalness: 0.55,
        side: THREE.DoubleSide,
      }),
    );
    cone.rotation.x = Math.PI; // 先端を下へ向ける
    cone.position.y = 0.8;
    funnel.add(cone);
    const lip = new THREE.Mesh(
      new THREE.TorusGeometry(0.8, 0.075, 8, 24),
      new THREE.MeshStandardMaterial({ color: emberColor(0.52, 0, 0.1), roughness: 0.35, metalness: 0.6 }),
    );
    lip.rotation.x = -Math.PI / 2;
    lip.position.y = 1.58;
    funnel.add(lip);
    root.add(funnel);
  },

  update(t) {
    // いま漏斗がいる場所。振れ幅が大きいほど持ち上がる。
    // 紐の長さから厳密に解くと吊り元が画面外まで上がるので、持ち上がりだけ切り出してある
    fall(t, bob);
    const r = Math.hypot(bob.x, bob.z);
    bob.y = REST_Y + LIFT * (r / RMAX) ** 2;

    dir.copy(bob).sub(pivot);
    const d = dir.length();
    dir.divideScalar(d);
    cord.position.copy(pivot).addScaledVector(dir, d * 0.5);
    cord.quaternion.setFromUnitVectors(UP, dir);
    cord.scale.set(1, d, 1);

    funnel.position.copy(bob);
    funnel.quaternion.copy(cord.quaternion); // 漏斗は紐と同じだけ傾く

    const shift = drift(t);
    for (let i = 0; i < GRAINS; i++) {
      const age01 = (i * DS) / TRAIL_SEC; // 0 = 落ちたて、1 = 消える寸前
      fall(t - i * DS, dummy.position);
      dummy.position.x += jitter[i * 3];
      dummy.position.z += jitter[i * 3 + 1];
      dummy.position.y = GRAIN_R * 0.7 + jitter[i * 3 + 2];
      dummy.scale.setScalar(1 - 0.72 * age01 * age01); // 古い砂ほど痩せる
      dummy.updateMatrix();
      grains.setMatrixAt(i, dummy.matrix);

      const fade = 1 - age01;
      // 落ちたての数粒だけが 0.28 を越えて滲む。あとは床の上でくすんでいく
      ember(color, 0.2 + 0.78 * fade * fade, shift, 0.18 * fade ** 6);
      grains.setColorAt(i, color);
    }
    grains.instanceMatrix.needsUpdate = true;
    if (grains.instanceColor) grains.instanceColor.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    // x 方向の折り返しで 1 つ。LOOP あたり KX 往復 = 端は 2 倍
    for (let k = tickX(t * ((2 * KX) / LOOP)); k > 0; k--) {
      stepX++;
      sfx.pluck(tone(7 + (stepX % 5)), { gain: 0.26, decay: 2.8, pan: stepX % 2 ? 0.45 : -0.45 });
    }
    // z 方向の折り返しで、5 : 7 のずれたぶんだけ間に落ちる
    for (let k = tickZ(t * ((2 * KZ) / LOOP) + 0.5); k > 0; k--) {
      stepZ++;
      sfx.drop(tone(2 + ((stepZ * 2) % 5)), { gain: 0.18, decay: 0.9, bend: 0.4, pan: stepZ % 2 ? -0.3 : 0.3 });
    }
    // 揺れの大きさに合わせて薄く鳴り続ける低音
    sfx.drone(tone(0) * 0.5, 0.028 + 0.016 * (0.5 + 0.5 * Math.sin((TAU * t) / LOOP)));
  },
};
