import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * 何が動くか: 一列に吊るした金属球のうち両端の球だけが振れ、中央の球列は静止したまま
 * 衝撃だけを瞬時に伝える。気持ちよさの芯: 動かない球の列を、衝撃が音もなく一瞬で
 * 通り抜ける「動」と「静」のコントラスト。ループの周期: 左が降りる→右が上がる→
 * 右が降りる→左が上がるの 4 拍で 1 周（約 4 秒）。カメラ: 少し斜めから列全体を見る
 * 定番アングル。音: 球が列へ戻る瞬間だけ硬いクリック音を左右交互に鳴らす。
 * スコープ外: 複数球を同時に持ち上げる演出、フレームのたわみ。
 */

const N = 7; // 球の数（奇数にして中央を対称にする）
const RADIUS = 1; // 球の半径
const SPACING = RADIUS * 2.05; // 球の間隔（わずかに隙間）
const STRING_LEN = 6.2; // 支柱から球中心までの長さ
const BAR_Y = 8.6; // 上部バーの高さ
const AMPLITUDE = 0.62; // 端の球が振れる最大角（ラジアン）
const QUARTER = 1.0; // 1 拍（降下 or 上昇）の秒数。4 拍で 1 周

const dummy = new THREE.Object3D();
const color = new THREE.Color();

let balls: THREE.InstancedMesh;
let strings: THREE.InstancedMesh;

/** 拍の境界を跨いだ回数を数える。build のたびに作り直す。 */
let tick = ticker();
let step = 0;

export const newtonsCradle: SceneModule = {
  name: "Newton's Cradle",
  desc: '端の球だけが振れ、静止した球列を衝撃が一瞬で通り抜ける。',
  camera: { pos: [2.6, 6, 11], target: [-1, 4.6, 0] },

  build(root) {
    tick = ticker();
    step = 0;

    const ballGeo = new THREE.SphereGeometry(RADIUS, 24, 18);
    const ballMat = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.5 });
    balls = new THREE.InstancedMesh(ballGeo, ballMat, N);
    balls.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(balls);

    // 支柱(ピボット)を原点にして、下向きに STRING_LEN だけ伸ばす
    const stringGeo = new THREE.CylinderGeometry(0.09, 0.09, STRING_LEN, 8);
    stringGeo.translate(0, -STRING_LEN / 2, 0);
    const stringMat = new THREE.MeshStandardMaterial({ color: emberColor(0.3), roughness: 0.6, metalness: 0.2 });
    strings = new THREE.InstancedMesh(stringGeo, stringMat, N);
    strings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(strings);

    const halfWidth = ((N - 1) / 2) * SPACING;
    const frameMat = new THREE.MeshStandardMaterial({ color: emberColor(0.24), roughness: 0.5, metalness: 0.4 });

    const bar = new THREE.Mesh(new THREE.BoxGeometry(halfWidth * 2 + 4.6, 0.5, 0.5), frameMat);
    bar.position.set(0, BAR_Y, 0);
    root.add(bar);

    const postGeo = new THREE.BoxGeometry(0.5, BAR_Y, 0.5);
    postGeo.translate(0, BAR_Y / 2, 0);
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(postGeo, frameMat);
      post.position.set(side * (halfWidth + 2), 0, 0);
      root.add(post);
    }

    // 控えめな床。球とフレームがうっすら映り込む程度に留める
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(halfWidth * 1.3, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.85, metalness: 0.05 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    root.add(floor);
  },

  // 角度は毎フレーム t から作り直す。差分を積み上げない
  // （タブを離れて戻ったときに崩れないし、いつ見ても同じ動きになる）。
  update(t) {
    const q = (((t / QUARTER) % 4) + 4) % 4; // 0..4 の連続位相（4 拍で 1 周）
    const seg = Math.floor(q);
    const frac = q - seg;

    let angleLeft = 0;
    let angleRight = 0;
    if (seg === 0) angleLeft = -AMPLITUDE * Math.cos((Math.PI / 2) * frac); // 左: 振れ切り→中央
    else if (seg === 1) angleRight = AMPLITUDE * Math.sin((Math.PI / 2) * frac); // 右: 中央→振れ切り
    else if (seg === 2) angleRight = AMPLITUDE * Math.cos((Math.PI / 2) * frac); // 右: 振れ切り→中央
    else angleLeft = -AMPLITUDE * Math.sin((Math.PI / 2) * frac); // 左: 中央→振れ切り

    const hue = drift(t);

    for (let i = 0; i < N; i++) {
      const theta = i === 0 ? angleLeft : i === N - 1 ? angleRight : 0;
      const px = (i - (N - 1) / 2) * SPACING;

      dummy.position.set(px, BAR_Y, 0);
      dummy.rotation.set(0, 0, theta);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      strings.setMatrixAt(i, dummy.matrix);

      const bx = px + Math.sin(theta) * STRING_LEN;
      const by = BAR_Y - Math.cos(theta) * STRING_LEN;
      dummy.position.set(bx, by, 0);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      balls.setMatrixAt(i, dummy.matrix);

      const glow = (Math.abs(theta) / AMPLITUDE) * 0.03; // 振れている球だけごくわずかに明るく
      ember(color, 0.5, hue, glow);
      balls.setColorAt(i, color);
    }

    balls.instanceMatrix.needsUpdate = true;
    if (balls.instanceColor) balls.instanceColor.needsUpdate = true;
    strings.instanceMatrix.needsUpdate = true;
  },

  // 音が ON のときだけ、update と同じ t で呼ばれる。
  // ここに映像へ影響する処理を書かないこと（OFF の間は呼ばれない）。
  sound(t, _dt, sfx) {
    for (let k = tick(t / QUARTER); k > 0; k--) {
      step++;
      const beat = step % 4;
      if (beat === 1) sfx.pluck(tone(4), { gain: 0.5, decay: 0.35, pan: -0.6 }); // 左へ帰着
      else if (beat === 3) sfx.pluck(tone(4), { gain: 0.5, decay: 0.35, pan: 0.6 }); // 右へ帰着
    }
  },
};
