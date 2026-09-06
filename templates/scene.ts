import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { SURFACE, ember, drift } from '../palette.ts';

/**
 * __TITLE__。
 *
 * ここに「何をしているか」を数行で書く。README にはシーン表を置いていないので、
 * この冒頭コメントと下の desc が唯一の説明になる。
 *
 * この雛形は、円周に並べたバーを進行波で持ち上げるだけのもの。
 * 動きの骨格ができたら、まるごと書き換えてよい。
 */

/** 円周に並べるバーの本数 */
const N = 64;
/** 円の半径 */
const R = 9;

const dummy = new THREE.Object3D();
const color = new THREE.Color();

let mesh: THREE.InstancedMesh;

/** 波の山が通過した回数を数える。build のたびに作り直す。 */
let tick = ticker();
let step = 0;

export const __NAME__: SceneModule = {
  name: '__TITLE__',
  desc: 'ここに 1 行の説明を書く（タイトルの下に出る）。',
  camera: { pos: [0, 14, 26], target: [0, 1, 0] },

  build(root) {
    // build はシーンを開くたびに呼ばれる。状態を持つものはここで作り直す。
    tick = ticker();
    step = 0;

    const geo = new THREE.BoxGeometry(0.4, 1, 0.4);
    geo.translate(0, 0.5, 0); // 原点を底面へ移し、Y スケールだけで伸ばせるようにする
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.34, metalness: 0.45 });

    mesh = new THREE.InstancedMesh(geo, mat, N);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(mesh);

    // 金属質の床。バーが薄く映り込んで奥行きが出る
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(R * 1.6, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.25, metalness: 0.9 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    root.add(floor);
  },

  // 形は毎フレーム t から作り直す。前フレームからの差分で積み上げない
  // （タブを離れて戻ったときに崩れないし、いつ見ても同じ動きになる）。
  update(t) {
    const hue = drift(t);
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const w = Math.sin(a * 3 - t * 1.6);
      const n = 0.5 + 0.5 * w; // 0..1

      dummy.position.set(Math.cos(a) * R, 0, Math.sin(a) * R);
      dummy.rotation.y = -a;
      dummy.scale.set(1, 0.4 + n * 4.2, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      ember(color, n, hue);
      mesh.setColorAt(i, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  },

  // 音が ON のときだけ、update と同じ t で呼ばれる。
  // ここに映像へ影響する処理を書かないこと（OFF の間は呼ばれない）。
  sound(t, _dt, sfx) {
    for (let k = tick(t * 1.6); k > 0; k--) {
      step++;
      sfx.pluck(tone(7 + (step % 5)), {
        gain: 0.3,
        decay: 2.2,
        pan: Math.sin(step * 1.1) * 0.5,
      });
    }
  },
};
