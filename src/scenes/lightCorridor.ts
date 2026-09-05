import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { ember, drift } from '../palette.ts';

const COUNT = 70; // 輪の枚数
const GAP = 1.5; // 輪の間隔
const NEAR = 2; // 手前の端（ここを過ぎた輪は奥へ戻す）
const R = 4.6; // 輪の半径
const SPEED = 2.6; // 近づいてくる速さ

const LEN = COUNT * GAP;

const dummy = new THREE.Object3D();
const color = new THREE.Color();

let mesh: THREE.InstancedMesh;

/** 輪が脇を通り過ぎた回数を数える */
let tickPass = ticker();
let pass = 0;

/** 奥から手前へ流れてくる輪の回廊。霧に溶ける奥行きを眺め続けられる。 */
export const lightCorridor: SceneModule = {
  name: 'Light Corridor',
  desc: '奥から手前へ流れてくる輪の回廊。近づくほど明るく、離れると霧に溶ける。',
  camera: { pos: [0, 2.2, 17], target: [0, 0, -8] },

  build(root) {
    tickPass = ticker();
    pass = 0;

    const geo = new THREE.TorusGeometry(1, 0.05, 8, 128);
    mesh = new THREE.InstancedMesh(
      geo,
      new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.5 }),
      COUNT,
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(mesh);
  },

  update(t) {
    const d = drift(t);
    const flow = t * SPEED;

    for (let i = 0; i < COUNT; i++) {
      // 手前まで来た輪は奥の端へ戻す。剰余なので継ぎ目は出ない
      const z = NEAR - (((i * GAP + flow) % LEN) + LEN) % LEN;
      // 回廊そのものが息をするように、太さがゆっくり波打つ
      const r = R * (1 + 0.12 * Math.sin(z * 0.14 - t * 0.5));

      dummy.position.set(
        Math.sin(z * 0.05 + t * 0.15) * 1.4, // 通路がゆるやかに蛇行する
        Math.cos(z * 0.04 - t * 0.11) * 0.9,
        z,
      );
      dummy.rotation.z = z * 0.03 + t * 0.05;
      dummy.scale.setScalar(r);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      const near = 1 - Math.min(Math.abs(z - NEAR) / LEN, 1);
      ember(color, 0.25 + near * 0.6, d);
      mesh.setColorAt(i, color);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    sfx.drone(tone(-5), 0.16); // 回廊に溜まった低い響き

    // 輪が 2 枚に 1 度、脇を通り抜ける
    for (let k = tickPass((t * SPEED) / (GAP * 2)); k > 0; k--) {
      pass++;
      sfx.air({
        gain: 0.3,
        decay: 1.4,
        freq: 520,
        q: 1.1,
        sweep: 0.4, // 通り過ぎたあとほど低く落ちる
        pan: pass % 2 ? 0.6 : -0.6,
      });
      if (pass % 4 === 0) sfx.pluck(tone(2), { gain: 0.26, decay: 3 });
    }
  },
};
