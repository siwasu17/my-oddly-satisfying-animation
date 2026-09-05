import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { SURFACE, ember, drift } from '../palette.ts';

const COUNT = 84; // 円周に並べる枚数
const R = 9.4; // 円の半径
const TH = 1.9; // 牌の高さ
const TW = 0.9; // 牌の幅
const TD = 0.2; // 牌の厚み
const CYCLE = 9; // 波が一周するのにかける秒数
const TIP = Math.PI * 0.46; // 倒れきったときの角度

/** 倒れる → 寝たまま待つ → 起き上がる、を 1 とする配分。 */
const FALL = 0.06;
const REST = 0.62;
const RISE = 0.2;

const dummy = new THREE.Object3D();
dummy.rotation.order = 'YXZ'; // 先に向きを決め、その軸まわりに倒す
const color = new THREE.Color();

let mesh: THREE.InstancedMesh;

const smooth = (x: number): number => x * x * (3 - 2 * x);

/** 位相 p（波が通り過ぎてからの進み具合）から傾きを返す。 */
function tilt(p: number): number {
  if (p < FALL) return TIP * (1 - Math.cos((p / FALL) * Math.PI * 0.5)); // 加速しながら倒れる
  if (p < FALL + REST) return TIP;
  if (p < FALL + REST + RISE) return TIP * (1 - smooth((p - FALL - REST) / RISE));
  return 0;
}

/** 円環に並んだドミノが、倒れては静かに起き上がるのを繰り返す。 */
export const dominoRing: SceneModule = {
  name: 'Domino Ring',
  desc: '円く並んだ 84 枚のドミノが倒れ、一周したころには静かに起き上がっている。',
  camera: { pos: [0, 11, 22], target: [0, 0.8, 0] },

  build(root) {
    const geo = new THREE.BoxGeometry(TW, TH, TD);
    geo.translate(0, TH / 2, -TD / 2); // 倒れる側の底辺を回転軸にする

    mesh = new THREE.InstancedMesh(
      geo,
      new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.5 }),
      COUNT,
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(mesh);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(R * 1.9, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.2, metalness: 0.9 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.01;
    root.add(floor);
  },

  update(t) {
    const d = drift(t);
    const head = (t / CYCLE) % 1; // 波の先頭がいまいる位置（0..1）

    for (let i = 0; i < COUNT; i++) {
      const u = i / COUNT;
      const a = u * Math.PI * 2;
      const p = ((head - u) % 1 + 1) % 1; // 先頭が通り過ぎてからの進み具合
      const th = tilt(p);

      dummy.position.set(Math.cos(a) * R, 0, Math.sin(a) * R);
      dummy.rotation.set(th, -a, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      // 倒れかけの数枚だけが明るくなり、波の先頭が光って見える
      const hot = th > 0 && th < TIP ? 1 : 0;
      ember(color, 0.3 + (th / TIP) * 0.4 + hot * 0.3, d);
      mesh.setColorAt(i, color);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  },
};
