import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { SURFACE, emberColor } from '../palette.ts';

/**
 * 宙に浮いた 3×3×3 のキューブが、1 レイヤーずつ 90° だけ回る。
 * 溜めてから一息に回り、角がぴたりと揃って止まる——その決まり方が芯。
 * 12 手のうち後半 6 手が前半の逆手なので、16.8 秒でステッカーの並びが完全に元へ戻る。
 * 面の色は 6 色ではなく暖色帯の 6 段階の濃淡（青を画面へ入れないため）。
 * カメラは少し斜め上から。手が決まった瞬間だけ pluck が 1 音鳴る。
 */

const CUBIE = 1.86; // 小立方体の一辺
const SPACING = 2.0; // 中心間の距離。差の 0.14 が溝になる
const STICKER = 1.64; // ステッカーの一辺。溝を細くして 3×3 の格子と色面を読ませる
const CENTER_Y = 3.6; // キューブの中心高さ。レイヤーが回っても角が床を割らない高さ
const STEP_DUR = 1.4; // 1 手にかける秒数
const HOLD = 0.18; // 各手の前後の静止（1 手のうちの割合）
const SPIN = 0.05; // 全体がゆっくり流れる速さ（rad/s）
const TILT = 0.5; // 初期のヨー角。角が正面に来ないようずらす
const FLOOR_R = 11;
const GLOW = 0.02; // ステッカーだけをわずかに持ち上げる。上げすぎるとブルームで白く飛ぶ

/**
 * 面ごとの [ember の n, 色相のずらし]。6 色は青が入るので暖色帯の濃淡で区別する。
 * カメラから同時に見えるのは +X / +Y / +Z の 3 面なので、その 3 つを大きく離してある。
 */
const FACE_TONE: [number, number][] = [
  [0.72, 0.03], // +X 琥珀寄り。上限はここまで（ブルーム閾値 0.28 に触れさせない）
  [0.3, -0.02], // -X
  [0.46, 0.0], // +Y 上面。天井光を受けるぶん控えめにする
  [0.1, 0.02], // -Y
  [0.18, -0.03], // +Z 暗い薔薇
  [0.6, 0.01], // -Z
];

/** 面ごとの [軸, 符号, ステッカーの姿勢] */
const FACES: { ax: 0 | 1 | 2; sg: 1 | -1; rot: [number, number, number] }[] = [
  { ax: 0, sg: 1, rot: [0, Math.PI / 2, 0] },
  { ax: 0, sg: -1, rot: [0, -Math.PI / 2, 0] },
  { ax: 1, sg: 1, rot: [-Math.PI / 2, 0, 0] },
  { ax: 1, sg: -1, rot: [Math.PI / 2, 0, 0] },
  { ax: 2, sg: 1, rot: [0, 0, 0] },
  { ax: 2, sg: -1, rot: [0, Math.PI, 0] },
];

const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];

type Move = { axis: 0 | 1 | 2; layer: 1 | -1; dir: 1 | -1 };

/** 前半 6 手。軸と層を散らして、同じ面ばかり回らないようにしてある */
const HALF: Move[] = [
  { axis: 0, layer: 1, dir: -1 },
  { axis: 1, layer: 1, dir: -1 },
  { axis: 2, layer: 1, dir: 1 },
  { axis: 0, layer: -1, dir: 1 },
  { axis: 1, layer: -1, dir: -1 },
  { axis: 2, layer: -1, dir: 1 },
];

/** 後半は前半の逆順・逆回転。これで 1 周すると必ず初期状態へ戻る */
const MOVES: Move[] = [
  ...HALF,
  ...HALF.slice()
    .reverse()
    .map((m): Move => ({ axis: m.axis, layer: m.layer, dir: (-m.dir) as 1 | -1 })),
];

const CYCLE = MOVES.length * STEP_DUR;
const SETTLE = (1 - HOLD) * STEP_DUR; // 回り終わって静止に入る時刻（1 手のうち）

/** 中心を除く 26 個の論理座標 */
const CELLS: [number, number, number][] = [];
for (let x = -1; x <= 1; x++) {
  for (let y = -1; y <= 1; y++) {
    for (let z = -1; z <= 1; z++) {
      if (x !== 0 || y !== 0 || z !== 0) CELLS.push([x, y, z]);
    }
  }
}
const N = CELLS.length;

/**
 * 各手の「開始時点」の姿勢を先に全部作っておく。
 * update は t から手番号を引いて、その状態に進行中の回転を足すだけになる（差分を積まない）。
 */
const STATE_POS: Float32Array[] = [];
const STATE_QUAT: Float32Array[] = [];
{
  const pos = new Float32Array(N * 3);
  const quat = new Float32Array(N * 4);
  CELLS.forEach((c, i) => {
    pos[i * 3] = c[0];
    pos[i * 3 + 1] = c[1];
    pos[i * 3 + 2] = c[2];
    quat[i * 4 + 3] = 1;
  });

  const v = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const qm = new THREE.Quaternion();
  for (const m of MOVES) {
    STATE_POS.push(pos.slice());
    STATE_QUAT.push(quat.slice());
    qm.setFromAxisAngle(AXES[m.axis], (m.dir * Math.PI) / 2);
    for (let i = 0; i < N; i++) {
      if (Math.round(pos[i * 3 + m.axis]) !== m.layer) continue;
      v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyQuaternion(qm);
      pos[i * 3] = Math.round(v.x);
      pos[i * 3 + 1] = Math.round(v.y);
      pos[i * 3 + 2] = Math.round(v.z);
      q.set(quat[i * 4], quat[i * 4 + 1], quat[i * 4 + 2], quat[i * 4 + 3]).premultiply(qm);
      quat[i * 4] = q.x;
      quat[i * 4 + 1] = q.y;
      quat[i * 4 + 2] = q.z;
      quat[i * 4 + 3] = q.w;
    }
  }
}

/** 前後に静止を挟んだ smootherstep。溜めてから一息に回る */
const ease = (p: number): number => {
  const u = Math.min(1, Math.max(0, (p - HOLD) / (1 - 2 * HOLD)));
  return u * u * u * (u * (u * 6 - 15) + 10);
};

const qLayer = new THREE.Quaternion();
const qBase = new THREE.Quaternion();
const vBase = new THREE.Vector3();

let pivot: THREE.Group;
let cubies: THREE.Group[] = [];
let tick = ticker();
let turn = 0;

export const rubiksCube: SceneModule = {
  name: 'Rubiks Cube',
  desc: '一層ずつ 90° だけ回って、12 手で元の並びへ戻ってくる立方体。',
  // 方位を振って 3 面目を薄く見せ、注視点をキューブより下へ置いて浮いて見せる
  camera: { pos: [9.5, 7.5, 10.9], target: [0, 2.9, 0] },

  build(root) {
    tick = ticker();
    turn = 0;

    pivot = new THREE.Group();
    pivot.position.y = CENTER_Y;
    root.add(pivot);

    const body = new THREE.BoxGeometry(CUBIE, CUBIE, CUBIE);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: SURFACE,
      roughness: 0.62,
      metalness: 0.3,
    });
    const sticker = new THREE.PlaneGeometry(STICKER, STICKER);
    const stickerMats = FACE_TONE.map(
      ([n, shift]) =>
        new THREE.MeshStandardMaterial({
          color: emberColor(n, shift, GLOW),
          roughness: 0.34,
          metalness: 0.22,
        }),
    );

    cubies = CELLS.map((cell) => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(body, bodyMat));

      FACES.forEach((f, i) => {
        if (cell[f.ax] !== f.sg) return; // 外を向いている面にだけ貼る
        const s = new THREE.Mesh(sticker, stickerMats[i]);
        s.rotation.set(f.rot[0], f.rot[1], f.rot[2]);
        s.position.setComponent(f.ax, f.sg * (CUBIE / 2 + 0.012));
        g.add(s);
      });

      pivot.add(g);
      return g;
    });

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(FLOOR_R, 96),
      // 粗めにして、リムライトが床で鋭い光点にならないようにする（主役より明るくしない）
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.58, metalness: 0.68 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    root.add(floor);
  },

  update(t) {
    pivot.rotation.y = TILT + t * SPIN;

    const ph = (t % CYCLE) / STEP_DUR;
    const k = Math.min(MOVES.length - 1, Math.floor(ph));
    const m = MOVES[k];
    const pos = STATE_POS[k];
    const quat = STATE_QUAT[k];
    qLayer.setFromAxisAngle(AXES[m.axis], (ease(ph - k) * m.dir * Math.PI) / 2);

    for (let i = 0; i < N; i++) {
      vBase.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      qBase.set(quat[i * 4], quat[i * 4 + 1], quat[i * 4 + 2], quat[i * 4 + 3]);
      if (Math.round(vBase.getComponent(m.axis)) === m.layer) {
        vBase.applyQuaternion(qLayer);
        qBase.premultiply(qLayer);
      }
      const c = cubies[i];
      c.position.copy(vBase).multiplyScalar(SPACING);
      c.quaternion.copy(qBase);
    }
  },

  sound(t, _dt, sfx) {
    // 手が決まる瞬間（回り終わって静止に入る点）で位相が整数をまたぐようにずらしてある
    for (let n = tick((t + STEP_DUR - SETTLE) / STEP_DUR); n > 0; n--) {
      const m = MOVES[turn % MOVES.length];
      turn++;
      sfx.pluck(tone(4 + (turn % 5)), { gain: 0.3, decay: 1.9, pan: m.layer * 0.35 });
    }
  },
};
