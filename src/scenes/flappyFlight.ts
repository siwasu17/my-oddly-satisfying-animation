import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * Flappy Flight。
 *
 * 丸い小鳥が羽ばたきだけで宙に浮き、右から流れてくる土管の隙間を 1 本ずつ抜けていく、
 * Flappy Bird 風ゲームの「うまい人のプレイ画面」。羽ばたくたびに小さな放物線を描き、
 * 放物線のてっぺんがちょうど隙間の真ん中に来る。抜けた土管は縁がふっと灯る。
 *
 * 鳥の高さは物理を積み上げずに t から直接解いている。羽ばたきは等間隔（土管 1 本に 2 回）で、
 * 羽ばたきごとの初速を「次の羽ばたきで目標の高さに着く」ように決めるので、
 * 見た目は重力と羽ばたきだけで飛んでいるのに、絶対にぶつからない。
 * 隙間の高さは上下へ大きく振り（交互を基本に、ときどき同じ側が続く）、振る量だけを
 * 固定シードで散らす。12 本ぶんで 18 秒、元に戻る。
 * 地面・丘・雲は速さを変えて流し、奥行きを出す。
 *
 * 音: 羽ばたきで短い風切り音、土管を抜けるたびに上がっていく音程で 1 音。
 * スコープ外: 衝突・ゲームオーバー、スコアの数字表示、タップ操作。
 */

/** 横に流れる速さ（ワールド単位/秒） */
const SPEED = 4;
/** 土管どうしの間隔 */
const SPACING = 6;
/** 土管 1 本ぶんの時間 */
const T = SPACING / SPEED;
/** 羽ばたきの間隔（土管 1 本に 2 回） */
const TAU = T / 2;
/** 重力 */
const G = 22;
/** 放物線の頂点が羽ばたき地点より上がる高さ（左右対称な弧のとき） */
const ARC = (G * TAU * TAU) / 8;
/** 隙間の高さのパターン数。T × PATTERN 秒でループ */
const PATTERN = 12;
/** 隙間の中心の基準の高さと、基準から上下へ振る幅 */
const GAP_MID = 5.6;
const GAP_SPREAD = 2.6;
/** 基準から最低でもこれだけ（GAP_SPREAD に対する割合）は離す。高低差をはっきりさせる */
const GAP_MIN_OFFSET = 0.45;
/** 1 本ずつ上に振るか下に振るか。交互を基本に、ときどき同じ側を続けて単調さを崩す */
const GAP_SIDES = [1, -1, 1, 1, -1, -1, 1, -1, -1, 1, -1, 1];
/** 隙間の開き */
const GAP_OPEN = 3.6;
/** 鳥の x 位置 */
const BIRD_X = -3;
/** 鳥の半径 */
const BIRD_R = 0.5;
/** 土管の太さ・縁の太さ・縁の厚み */
const PIPE_R = 0.75;
const CAP_R = 0.92;
const CAP_H = 0.45;
/** 天井（上の土管が伸びてくる高さ）と地面の厚み */
const CEIL = 22;
const GROUND_H = 0.8;
/** 画面に出す範囲（この外では土管を細らせて消す） */
const VIEW_L = -21;
const VIEW_R = 20;
const EDGE_FADE = 2.5;
/** 同時に描く土管の本数 */
const PIPES = 8;
/** 地面の縞の枚数と間隔 */
const STRIPES = 22;
const STRIPE_GAP = 2;
/** 丘と雲（奥の飾り）。流れる速さは SPEED に対する比 */
const HILLS = 7;
const HILL_SPACING = 7;
const HILL_PARALLAX = 0.3;
const CLOUDS = 3;
const CLOUD_SPACING = 13;
const CLOUD_PARALLAX = 0.12;
/** 土管を抜けたときに縁が灯っている時間 */
const FLASH = 0.5;

const dummy = new THREE.Object3D();
const color = new THREE.Color();

/** 土管 i の隙間の中心の高さ（build で決める） */
const gaps = new Float32Array(PATTERN);

let pipeMesh: THREE.InstancedMesh;
let capMesh: THREE.InstancedMesh;
let stripeMesh: THREE.InstancedMesh;
let hillMesh: THREE.InstancedMesh;
let cloudMesh: THREE.InstancedMesh;
let bird: THREE.Group;
let body: THREE.Mesh;
let wing: THREE.Group;

let flapTick = ticker();
let passTick = ticker();
let passCount = 0;

const mod = (a: number, n: number): number => ((a % n) + n) % n;
const gapOf = (i: number): number => gaps[mod(i, PATTERN)];

/** 羽ばたき k の地点の高さ。土管 i を挟む 2 回（2i, 2i+1）は同じ高さにして、弧の頂点を隙間に合わせる */
const flapHeight = (k: number): number => gapOf(Math.floor(k / 2)) - ARC;

/** 時刻 t の鳥の [高さ, 縦の速さ, 直前の羽ばたきからの経過] */
function birdAt(t: number): [number, number, number] {
  const k = Math.floor(t / TAU);
  const s = t - k * TAU;
  const h0 = flapHeight(k);
  const h1 = flapHeight(k + 1);
  const v = (h1 - h0) / TAU + (G * TAU) / 2;
  return [h0 + v * s - (G * s * s) / 2, v - G * s, s];
}

/** 画面の端で細らせて消す係数 */
function edge(x: number): number {
  const a = THREE.MathUtils.clamp((x - VIEW_L) / EDGE_FADE, 0, 1);
  const b = THREE.MathUtils.clamp((VIEW_R - x) / EDGE_FADE, 0, 1);
  return THREE.MathUtils.smoothstep(Math.min(a, b), 0, 1);
}

export const flappyFlight: SceneModule = {
  name: 'Flappy Flight',
  desc: '羽ばたきの放物線が、流れてくる土管の隙間をいつもぴったり抜けていく。',
  camera: { pos: [-1, 5.4, 17], target: [-1, 4.4, 0] },

  build(root) {
    flapTick = ticker();
    passTick = ticker();
    passCount = 0;

    let s = 0.417;
    const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);
    // 上下どちらに振るかは GAP_SIDES で決め、振る量だけを乱数で散らす
    for (let i = 0; i < PATTERN; i++) {
      const amount = GAP_MIN_OFFSET + (1 - GAP_MIN_OFFSET) * rnd();
      gaps[i] = GAP_MID + GAP_SIDES[i % GAP_SIDES.length] * amount * GAP_SPREAD;
    }

    // 土管の胴（上下で 2 本ずつ）。原点を底面に置き、Y スケールで長さを決める
    const pipeGeo = new THREE.CylinderGeometry(PIPE_R, PIPE_R, 1, 28, 1, true);
    pipeGeo.translate(0, 0.5, 0);
    pipeMesh = new THREE.InstancedMesh(
      pipeGeo,
      new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.35, side: THREE.DoubleSide }),
      PIPES * 2,
    );
    pipeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(pipeMesh);

    const capGeo = new THREE.CylinderGeometry(CAP_R, CAP_R, CAP_H, 28);
    capMesh = new THREE.InstancedMesh(
      capGeo,
      new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.4 }),
      PIPES * 2,
    );
    capMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(capMesh);

    // 地面
    const ground = new THREE.Mesh(
      new THREE.BoxGeometry(VIEW_R - VIEW_L + 6, GROUND_H, 5),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.6, metalness: 0.2 }),
    );
    ground.position.set(0, -GROUND_H / 2, 0);
    root.add(ground);

    // 地面の縞。これが流れることで「進んでいる」と分かる
    const stripeGeo = new THREE.BoxGeometry(0.42, 0.06, 5.02);
    stripeMesh = new THREE.InstancedMesh(
      stripeGeo,
      new THREE.MeshStandardMaterial({ color: emberColor(0.05), roughness: 0.8 }),
      STRIPES,
    );
    stripeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(stripeMesh);

    // 奥の丘（つぶした半球）
    const hillGeo = new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
    hillMesh = new THREE.InstancedMesh(
      hillGeo,
      new THREE.MeshStandardMaterial({ color: emberColor(0.05, 0, -0.02), roughness: 0.9 }),
      HILLS,
    );
    hillMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(hillMesh);

    // 雲（つぶした球）
    cloudMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 20, 12),
      new THREE.MeshStandardMaterial({ color: emberColor(0.12), roughness: 1 }),
      CLOUDS * 3,
    );
    cloudMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(cloudMesh);

    // 鳥: 胴・目・くちばし・翼
    bird = new THREE.Group();
    root.add(bird);

    body = new THREE.Mesh(
      new THREE.SphereGeometry(BIRD_R, 32, 20),
      new THREE.MeshStandardMaterial({ color: emberColor(1, 0, 0.12), roughness: 0.35 }),
    );
    bird.add(body);

    // 目は黒い点だけ。胴の表面に半分埋める
    const eye = new THREE.Mesh(
      new THREE.SphereGeometry(BIRD_R * 0.17, 12, 8),
      new THREE.MeshStandardMaterial({ color: 0x1a0c0a, roughness: 0.4 }),
    );
    eye.position.set(0.55, 0.4, 0.73).normalize().multiplyScalar(BIRD_R * 0.96);
    body.add(eye);

    const beak = new THREE.Mesh(
      new THREE.ConeGeometry(BIRD_R * 0.3, BIRD_R * 0.7, 16),
      new THREE.MeshStandardMaterial({ color: emberColor(0.75, 0.03, 0.12), roughness: 0.4 }),
    );
    beak.rotation.z = -Math.PI / 2;
    beak.position.set(BIRD_R * 1.08, -BIRD_R * 0.05, 0);
    body.add(beak);

    // 翼は根元（胴の横）を軸に回すので、ピボットの子に置く
    wing = new THREE.Group();
    wing.position.set(-BIRD_R * 0.1, 0, BIRD_R * 0.85);
    body.add(wing);
    const wingMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 12),
      new THREE.MeshStandardMaterial({ color: emberColor(0.85, 0.02, 0.2), roughness: 0.4 }),
    );
    wingMesh.scale.set(BIRD_R * 0.62, BIRD_R * 0.14, BIRD_R * 0.36);
    wingMesh.position.set(-BIRD_R * 0.35, 0, 0);
    wing.add(wingMesh);
  },

  update(t) {
    const hue = drift(t);

    // 鳥
    const [y, vy, s] = birdAt(t);
    bird.position.set(BIRD_X, y, 0);
    // 上がるときは少し上を向き、落ちるときはくちばしを下げる
    bird.rotation.z = THREE.MathUtils.clamp(Math.atan2(vy, SPEED) * 0.7, -0.9, 0.45);
    // 羽ばたいた瞬間だけ縦に少し伸びる
    const pop = Math.exp(-s * 12);
    body.scale.set(1 - 0.1 * pop, 1 + 0.14 * pop, 1 - 0.1 * pop);
    // 翼: 羽ばたきで上から下へ打ち下ろし、そのあとゆっくり水平へ戻る
    const stroke = 0.28;
    wing.rotation.x =
      s < stroke
        ? 1.0 * Math.cos((Math.PI * s) / stroke)
        : -1.0 + Math.min((s - stroke) / 0.35, 1) * 1.2;

    // 土管。i 本目が鳥の位置を通るのは t = i*T + TAU/2（羽ばたき 2i の弧の頂点）
    const first = Math.floor(t / T) - 3;
    for (let j = 0; j < PIPES; j++) {
      const i = first + j;
      const x = BIRD_X + (i * T + TAU / 2 - t) * SPEED;
      const g = gapOf(i);
      const w = edge(x);
      const bottomTop = g - GAP_OPEN / 2;
      const topBottom = g + GAP_OPEN / 2;

      // 抜けた直後だけ縁が灯る
      const since = t - (i * T + TAU / 2);
      const flash = since >= 0 && since < FLASH ? 1 - since / FLASH : 0;
      const tone01 = 0.38 + (mod(i, 3) - 1) * 0.04;

      dummy.rotation.set(0, 0, 0);
      dummy.position.set(x, 0, 0);
      dummy.scale.set(w, bottomTop, w);
      dummy.updateMatrix();
      pipeMesh.setMatrixAt(j * 2, dummy.matrix);
      dummy.position.set(x, topBottom, 0);
      dummy.scale.set(w, CEIL - topBottom, w);
      dummy.updateMatrix();
      pipeMesh.setMatrixAt(j * 2 + 1, dummy.matrix);
      ember(color, tone01, hue);
      pipeMesh.setColorAt(j * 2, color);
      pipeMesh.setColorAt(j * 2 + 1, color);

      dummy.scale.set(w, 1, w);
      dummy.position.set(x, bottomTop - CAP_H / 2, 0);
      dummy.updateMatrix();
      capMesh.setMatrixAt(j * 2, dummy.matrix);
      dummy.position.set(x, topBottom + CAP_H / 2, 0);
      dummy.updateMatrix();
      capMesh.setMatrixAt(j * 2 + 1, dummy.matrix);
      ember(color, tone01 + 0.05 + flash * 0.18, hue, flash * 0.05);
      capMesh.setColorAt(j * 2, color);
      capMesh.setColorAt(j * 2 + 1, color);
    }
    pipeMesh.instanceMatrix.needsUpdate = true;
    capMesh.instanceMatrix.needsUpdate = true;
    if (pipeMesh.instanceColor) pipeMesh.instanceColor.needsUpdate = true;
    if (capMesh.instanceColor) capMesh.instanceColor.needsUpdate = true;

    // 地面の縞
    const span = STRIPES * STRIPE_GAP;
    dummy.rotation.set(0, 0, 0);
    for (let i = 0; i < STRIPES; i++) {
      const x = mod(i * STRIPE_GAP - t * SPEED + span / 2, span) - span / 2;
      const w = edge(x);
      dummy.position.set(x, 0.01, 0);
      dummy.rotation.y = 0.5;
      dummy.scale.set(w, 1, w);
      dummy.updateMatrix();
      stripeMesh.setMatrixAt(i, dummy.matrix);
    }
    stripeMesh.instanceMatrix.needsUpdate = true;

    // 奥の丘
    const hillSpan = HILLS * HILL_SPACING;
    dummy.rotation.set(0, 0, 0);
    for (let i = 0; i < HILLS; i++) {
      const x = mod(i * HILL_SPACING - t * SPEED * HILL_PARALLAX + hillSpan / 2, hillSpan) - hillSpan / 2;
      const w = edge(x * 0.8);
      const r = 3.2 + ((i * 7) % 3) * 0.9;
      dummy.position.set(x, 0, -7);
      dummy.scale.set(r * w, r * 0.7 * w, 2.2 * w);
      dummy.updateMatrix();
      hillMesh.setMatrixAt(i, dummy.matrix);
    }
    hillMesh.instanceMatrix.needsUpdate = true;

    // 雲（球 3 つで 1 つ）
    const cloudSpan = CLOUDS * CLOUD_SPACING;
    for (let i = 0; i < CLOUDS; i++) {
      const x = mod(i * CLOUD_SPACING - t * SPEED * CLOUD_PARALLAX + cloudSpan / 2, cloudSpan) - cloudSpan / 2;
      const w = edge(x * 0.8);
      const cy = 12.6 + ((i * 5) % 3) * 0.5;
      for (let p = 0; p < 3; p++) {
        const r = p === 1 ? 1.0 : 0.72;
        dummy.position.set(x + (p - 1) * 1.1, cy + (p === 1 ? 0.25 : 0), -10);
        dummy.scale.set(r * 1.3 * w, r * 0.8 * w, r * w);
        dummy.updateMatrix();
        cloudMesh.setMatrixAt(i * 3 + p, dummy.matrix);
      }
    }
    cloudMesh.instanceMatrix.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    for (let k = flapTick(t / TAU); k > 0; k--) {
      sfx.air({ gain: 0.16, decay: 0.22, freq: 900, q: 1.2, sweep: 0.6, pan: -0.2 });
    }
    for (let k = passTick((t - TAU / 2) / T); k > 0; k--) {
      passCount++;
      sfx.pluck(tone(10 + (passCount % 6)), { gain: 0.26, decay: 1.4, pan: -0.2 });
    }
  },
};
