import * as THREE from 'three';
import { createStage, disposeGroup, fitScale } from './stage.ts';
import { createUi } from './ui.ts';
import { createSfx } from './audio.ts';
import { SCENES } from './scenes/index.ts';
import { registerServiceWorker } from './pwa.ts';

/** 自動切替の間隔（秒）。眺めている間に切り替わりすぎないよう長めに取る。 */
const AUTO_SWITCH_SEC = 34;
/** カメラが定位置へ移動しきるまでの秒数 */
const CAM_TWEEN_SEC = 2.0;
/** 効果音の ON/OFF を覚えておく localStorage のキー */
const SOUND_KEY = 'oddly:sound';

const stage = createStage(document.getElementById('app')!);
const { scene, camera, controls, composer } = stage;

let current = -1;
let root: THREE.Group | null = null;
let sceneTime = 0;
let autoPlay = false;
let autoTimer = 0;

const sfx = createSfx();
let soundOn = readSound();

/** 設定の読み書き。プライベートモードでは localStorage が使えないことがある。 */
function readSound(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) === '1';
  } catch {
    return false;
  }
}
function writeSound(on: boolean): void {
  try {
    localStorage.setItem(SOUND_KEY, on ? '1' : '0');
  } catch {
    // 保存できなくても、このセッション中の ON/OFF には影響しない
  }
}

// カメラ移動の補間用
const camFrom = new THREE.Vector3();
const camTo = new THREE.Vector3();
const targetFrom = new THREE.Vector3();
const targetTo = new THREE.Vector3();
let camT = 1;

const easeInOutCubic = (x: number): number =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

/** 縦長画面でのカメラの引きしろ。resize のたびに取り直す。 */
let fit = fitScale();

/** center を中心に、そこからの距離だけを k 倍する。 */
function scaleAround(v: THREE.Vector3, center: THREE.Vector3, k: number): void {
  v.sub(center).multiplyScalar(k).add(center);
}

const ui = createUi(SCENES, {
  select,
  toggleAutoPlay() {
    autoPlay = !autoPlay;
    autoTimer = 0;
    return autoPlay;
  },
  toggleSound() {
    soundOn = !soundOn;
    sfx.setEnabled(soundOn);
    writeSound(soundOn);
    return soundOn;
  },
});

ui.showSound(soundOn);
ui.showAutoPlay(autoPlay);

// 前回 ON だった場合の復元。ブラウザは操作なしに音を出せないので、
// AudioContext を作るのは最初のクリックかキー入力まで待つ。
if (soundOn) {
  const start = (): void => {
    if (soundOn) sfx.setEnabled(true);
  };
  window.addEventListener('pointerdown', start, { once: true });
  window.addEventListener('keydown', start, { once: true });
}

function select(index: number): void {
  const next = ((index % SCENES.length) + SCENES.length) % SCENES.length;
  if (next === current) return;

  ui.flash();
  sfx.reset(); // 前のシーンの持続音を引きずらない

  if (root) {
    scene.remove(root);
    disposeGroup(root);
  }
  root = new THREE.Group();
  scene.add(root);

  current = next;
  const mod = SCENES[current]!;
  mod.build(root);
  sceneTime = 0;
  autoTimer = 0;

  camFrom.copy(camera.position);
  targetFrom.copy(controls.target);
  targetTo.set(...mod.camera.target);
  camTo.set(...mod.camera.pos);
  scaleAround(camTo, targetTo, fit);
  camT = 0;
  controls.autoRotate = false; // 移動中は自動回転を止める

  ui.show(current, mod);
  writeHash();
}

/**
 * リロードしても同じシーンから始められるよう URL に残す。
 * キーを連打されたときに replaceState が続くとブラウザ側の
 * ナビゲーション抑制に引っかかるので、落ち着いてから1回だけ書く。
 */
let hashTimer = 0;
function writeHash(): void {
  clearTimeout(hashTimer);
  hashTimer = window.setTimeout(() => {
    const next = `#${current + 1}`;
    if (location.hash !== next) history.replaceState(null, '', next);
  }, 1500);
}

/** URL の #2 のような指定を初期シーンとして読む。 */
function initialIndex(): number {
  const n = Number(location.hash.slice(1));
  return Number.isInteger(n) && n >= 1 && n <= SCENES.length ? n - 1 : 0;
}

window.addEventListener('resize', () => {
  stage.resize();

  const next = fitScale();
  if (next === fit) return;
  // 視点の角度とユーザーのズームは保ったまま、必要になった引きしろだけ足す
  const k = next / fit;
  scaleAround(camera.position, controls.target, k);
  scaleAround(camFrom, targetFrom, k);
  scaleAround(camTo, targetTo, k);
  fit = next;
});

const timer = new THREE.Timer();
timer.connect(document); // タブが非表示の間の時間を delta に含めない

function animate(): void {
  requestAnimationFrame(animate);

  // 重いフレームの後でもアニメーションが飛ばないよう上限をかける
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.05);
  sceneTime += dt;

  if (camT < 1) {
    camT = Math.min(camT + dt / CAM_TWEEN_SEC, 1);
    const k = easeInOutCubic(camT);
    camera.position.lerpVectors(camFrom, camTo, k);
    controls.target.lerpVectors(targetFrom, targetTo, k);
    if (camT === 1) controls.autoRotate = true;
  }

  const mod = SCENES[current]!;
  mod.update(sceneTime, dt);
  // 音は鳴らせるときだけ。OFF の間は呼ばないので、映像側に影響しない
  if (soundOn && sfx.active) mod.sound?.(sceneTime, dt, sfx);

  if (autoPlay) {
    autoTimer += dt;
    if (autoTimer > AUTO_SWITCH_SEC) select(current + 1);
  }

  controls.update();
  composer.render();
}

select(initialIndex());
animate();
registerServiceWorker();
