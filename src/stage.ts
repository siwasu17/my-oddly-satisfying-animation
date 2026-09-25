import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BG } from './palette.ts';

/** 16:9 で見たときの霧の濃さ。画面比に応じて resize で薄める。 */
const FOG_DENSITY = 0.018;
/** 16:9 で見たときのズームアウト上限。こちらも画面比で伸ばす。 */
const MAX_DISTANCE = 90;
/** 各シーンのカメラ位置を決めたときの画面比。 */
const REF_ASPECT = 16 / 9;
/** 縦長画面での引きすぎ防止。被写体が小さくなりすぎない範囲に収める。 */
const MAX_FIT = 3;
/**
 * 環境マップの映り込みの強さ（scene.environmentIntensity）。
 * 金属やガラスに「部屋の明かり」が薄く映る程度に留める。上げすぎると暗部が持ち上がって眠くない。
 */
const ENV_INTENSITY = 0.3;

/**
 * 画面が縦長なほどカメラを後ろへ下げる倍率。
 *
 * PerspectiveCamera の fov は垂直方向なので、横幅が狭くなるとその分だけ
 * 水平画角が削れて被写体が左右にはみ出す。REF_ASPECT との比で距離を伸ばし、
 * 水平方向の見え方をだいたい一定に保つ。
 */
export function fitScale(): number {
  const aspect = window.innerWidth / window.innerHeight;
  if (aspect >= REF_ASPECT) return 1;
  return Math.min(REF_ASPECT / aspect, MAX_FIT);
}

export interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  composer: EffectComposer;
  resize(): void;
  /**
   * 環境マップの映り込みを、既定の強さに対する倍率で決める。0 で映さない。
   * シーンを切り替えるたびに SceneModule.environment を渡して呼ぶ。
   */
  setEnvironment(scale: number): void;
}

/** レンダラ・カメラ・ライティング・ポストプロセスをまとめて用意する。 */
export function createStage(container: HTMLElement): Stage {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // 就寝前に眺める前提なので、全体の明るさは控えめに
  renderer.toneMappingExposure = 0.92;
  // 透過（transmission）を使うのはピタゴラ装置の珠と水面くらい。その 1 パスのために
  // 毎フレーム全画面をもう一度描くのは重いので、半分の解像度で足りるようにする。
  renderer.transmissionResolutionScale = 0.5;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  const fog = new THREE.FogExp2(BG, FOG_DENSITY);
  scene.fog = fog;
  scene.environment = warmEnvironment(renderer);
  scene.environmentIntensity = ENV_INTENSITY;

  const camera = new THREE.PerspectiveCamera(
    48,
    window.innerWidth / window.innerHeight,
    0.1,
    500,
  );
  camera.position.set(0, 18, 30);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.enablePan = false;
  controls.minDistance = 6;
  controls.maxPolarAngle = Math.PI * 0.495; // 地面より下へ潜らせない
  controls.autoRotateSpeed = 0.22;

  // 光源も青を避け、ろうそくの灯りのような色温度で揃える
  scene.add(new THREE.HemisphereLight(0xffd0a8, 0x140d0c, 0.9));
  const key = new THREE.DirectionalLight(0xffd9b4, 1.25);
  key.position.set(8, 18, 10);
  scene.add(key);
  const rimA = new THREE.PointLight(0xff9457, 200, 120, 2);
  rimA.position.set(-18, 10, -14);
  scene.add(rimA);
  const rimB = new THREE.PointLight(0xd2708c, 150, 120, 2);
  rimB.position.set(18, 8, 14);
  scene.add(rimB);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(
    new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      // 明度を落とした分、にじみは弱く広くして輪郭をやわらげる
      0.42, // strength
      0.85, // radius
      0.28, // threshold
    ),
  );
  composer.addPass(new OutputPass());

  function resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const fit = fitScale();

    // 別解像度のディスプレイへ移すと devicePixelRatio が変わるので毎回入れ直す
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    composer.setSize(w, h);

    camera.aspect = w / h;
    camera.updateProjectionMatrix();

    // カメラを引いた分だけ霧を薄くしないと、縦画面で被写体が霧に沈む
    fog.density = FOG_DENSITY / fit;
    controls.maxDistance = MAX_DISTANCE * fit;
  }

  // resize イベントを伴わない DPR の変化（ディスプレイ間の移動など）を拾う
  let dprQuery: MediaQueryList | null = null;
  function onDprChange(): void {
    resize();
    watchDpr();
  }
  function watchDpr(): void {
    dprQuery?.removeEventListener('change', onDprChange);
    dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    dprQuery.addEventListener('change', onDprChange);
  }

  resize();
  watchDpr();

  function setEnvironment(scale: number): void {
    scene.environmentIntensity = ENV_INTENSITY * Math.max(scale, 0);
  }

  return { renderer, scene, camera, controls, composer, resize, setEnvironment };
}

/**
 * 金属やガラスに映り込ませる「ろうそくが数本灯った暗い部屋」を焼く。
 *
 * envMap が無いと、艶のある面は「暗い面に白い点が 1 つ」になりやすい。
 * かといって RoomEnvironment は白い蛍光灯の部屋なので、映り込みに青白さが混ざる。
 * ここでは暖色の光だけで小さな部屋を組み、PMREM でぼかして使う。
 * 色は palette.ts の帯（薔薇〜琥珀）に合わせ、青の成分を赤・緑より大きくしない。
 *
 * 1 度だけ焼けばよいので、シーン側からは触らない。
 * シーンが自前で material.envMap を持っている場合（Dice Field など）はそちらが優先される。
 */
function warmEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const room = new THREE.Scene();
  const disposables: { dispose(): void }[] = [];
  const add = (
    geo: THREE.BufferGeometry,
    rgb: readonly [number, number, number],
    gain: number,
    at: readonly [number, number, number],
    side: THREE.Side = THREE.FrontSide,
  ): void => {
    const mat = new THREE.MeshBasicMaterial({ side });
    // 1 を超える値を入れて HDR の光源にする（PMREM は浮動小数のターゲットへ焼く）
    mat.color.setRGB(rgb[0] * gain, rgb[1] * gain, rgb[2] * gain, THREE.LinearSRGBColorSpace);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(...at);
    room.add(mesh);
    disposables.push(geo, mat);
  };

  // 壁・床・天井。ほぼ黒だが、映り込んだときに輪郭が溶けない程度の暖色を残す
  add(new THREE.SphereGeometry(10, 32, 16), [0.05, 0.028, 0.022], 1, [0, 0, 0], THREE.BackSide);
  // 床からの照り返し。艶のある床に置いた物の下半分が沈みすぎないように
  const floor = new THREE.CircleGeometry(9, 32);
  floor.rotateX(-Math.PI / 2);
  add(floor, [0.09, 0.045, 0.03], 1, [0, -6, 0]);
  // ろうそく色の光源を 3 つ。高さと大きさを散らし、ハイライトが 1 点に揃わないようにする
  add(new THREE.SphereGeometry(0.9, 16, 8), [1, 0.56, 0.26], 16, [6, 3.5, 4]);
  add(new THREE.SphereGeometry(1.4, 16, 8), [1, 0.42, 0.24], 7, [-7, 2, -3]);
  add(new THREE.SphereGeometry(0.6, 16, 8), [1, 0.36, 0.3], 10, [1.5, 5, -7]);
  // 天井の大きく弱い明かり。上を向いた面が真っ黒にならないように
  const ceil = new THREE.CircleGeometry(4, 32);
  ceil.rotateX(Math.PI / 2);
  add(ceil, [1, 0.62, 0.4], 0.9, [0, 7.5, 0]);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(room, 0.04);
  pmrem.dispose();
  for (const d of disposables) d.dispose();
  return target.texture;
}

/** シーン切替時に、そのシーンが確保した GPU リソースを解放する。 */
export function disposeGroup(group: THREE.Object3D): void {
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const mat = mesh.material;
    if (!mat) return;
    for (const m of Array.isArray(mat) ? mat : [mat]) m.dispose();
  });
}
