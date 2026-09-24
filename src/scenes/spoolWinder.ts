import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { SURFACE, ember, emberColor } from '../palette.ts';

/**
 * Spool Winder — 糸巻きに糸が層になって巻き取られていく。
 *
 * 何が動くか: 横倒しのボビンが回り、上の奥にあるレールをガイドが左右に往復して、
 *   糸を端から端へ 1 巻きずつ並べていく。端で折り返すたびに層が 1 枚増え、胴が太る。
 *   満杯になると一呼吸おいて逆回転し、同じ道を戻ってほどける。
 * 気持ちよさの芯: 隙間なく並んだ巻きが、折り返しのたびに一段ずつ厚みを増す「詰まっていく」過程。
 * ループの周期: 38 秒（巻く 22 秒 / 満杯で 2.5 秒 / ほどく 11 秒 / 空で 2.5 秒）。
 * カメラ: 斜め前の少し上から。ボビンの胴とガイドの往復が一度に見える。
 * 音: 回転中は速さに応じた低いドローン。層が切り替わるたびに 1 音、層ごとに音程を上げる。
 * スコープ外: 糸のたるみ・撚り、巻きの千鳥（半ピッチずらし）、供給側の糸巻き。
 */

/** 1 層あたりの巻き数 */
const TURNS = 20;
/** 層の数 */
const LAYERS = 5;
/** 巻き 1 つぶんの幅（= 糸の太さ） */
const PITCH = 0.36;
/** 糸の断面半径 */
const TUBE = 0.16;
/** 層が 1 枚増えるごとの半径の増え方 */
const LAYER_STEP = 0.31;
/** 胴の半径 */
const CORE = 1.1;
/** 巻ける幅 */
const WIDTH = TURNS * PITCH;
/** 鍔（つば）の半径 */
const FLANGE_R = CORE + LAYERS * LAYER_STEP + 0.55;
/** 鍔の厚み */
const FLANGE_T = 0.22;
/** ガイドのレールの位置（ボビンの上の奥） */
const GUIDE_Y = 3.9;
const GUIDE_Z = -1.7;
/** 糸がやって来る点。ガイドの真後ろの奥、霧の中へ消える */
const SOURCE = new THREE.Vector3(0, GUIDE_Y + 0.4, -16);
/** 鍔と台の柱の間のすき間 */
const STAND_GAP = 1.5;
/** 床の高さ */
const FLOOR_Y = -FLANGE_R - 0.9;

/** 周期の内訳（秒） */
const T_WIND = 22;
const T_FULL = 2.5;
const T_UNWIND = 11;
const T_EMPTY = 2.5;
const CYCLE = T_WIND + T_FULL + T_UNWIND + T_EMPTY;
/** 回り始めと止まり際の加減速にあてる割合 */
const RAMP = 0.1;

const TOTAL = TURNS * LAYERS;

const dummy = new THREE.Object3D();
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

let spinner: THREE.Group;
let layers: THREE.InstancedMesh[] = [];
let carriage: THREE.Group;
let threadIn: THREE.Mesh;
let threadOut: THREE.Mesh;
let threadMat: THREE.MeshStandardMaterial;

let tick = ticker();
let prevW = 0;

/** 台形の速度で 0→1 へ進む。両端で速度 0、中は一定速度。 */
function ramp(x: number): number {
  const k = x < 0 ? 0 : x > 1 ? 1 : x;
  let p: number;
  if (k < RAMP) p = (k * k) / (2 * RAMP);
  else if (k > 1 - RAMP) p = 1 - RAMP - ((1 - k) * (1 - k)) / (2 * RAMP);
  else p = k - RAMP / 2;
  return p / (1 - RAMP);
}

/** t における巻き数（0..TOTAL、連続値）。 */
function wound(t: number): number {
  const p = ((t % CYCLE) + CYCLE) % CYCLE;
  if (p < T_WIND) return TOTAL * ramp(p / T_WIND);
  if (p < T_WIND + T_FULL) return TOTAL;
  const q = p - T_WIND - T_FULL;
  if (q < T_UNWIND) return TOTAL * (1 - ramp(q / T_UNWIND));
  return 0;
}

/** 巻き始めからずっと増え続ける位相。整数をまたぐ = 層が切り替わる。音用。 */
function layerPhase(t: number): number {
  const c = Math.floor(t / CYCLE);
  const p = t - c * CYCLE;
  const w = wound(t) / TURNS;
  const inWind = p < T_WIND + T_FULL;
  return c * LAYERS * 2 + (inWind ? w : LAYERS * 2 - w);
}

/** 層 j の巻きの中心半径 */
function layerRadius(j: number): number {
  return CORE + TUBE + j * LAYER_STEP;
}

/** 層 j の u 番目（0..TURNS、連続値）の巻きの x。偶数層は左から、奇数層は右から。 */
function turnX(j: number, u: number): number {
  const x = -WIDTH / 2 + PITCH / 2 + (WIDTH - PITCH) * (u / (TURNS - 1));
  return j % 2 === 0 ? x : -x;
}

/** 単位長さの円柱 mesh を a→b に張る。 */
function stretch(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3): void {
  tmpA.subVectors(b, a);
  const len = tmpA.length();
  mesh.position.addVectors(a, b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(UP, tmpA.normalize());
  mesh.scale.set(1, len, 1);
}

export const spoolWinder: SceneModule = {
  name: 'Spool Winder',
  desc: 'ガイドが左右に往復して、糸を 1 巻きずつ隙間なく並べていく。折り返すたびに胴が一段太る。',
  camera: { pos: [6, 6.2, 15.5], target: [0, 1.3, 0] },

  build(root) {
    tick = ticker();
    prevW = 0;
    layers = [];

    const wood = new THREE.MeshStandardMaterial({
      color: emberColor(0.12, 0.02),
      roughness: 0.62,
      metalness: 0.1,
    });
    const metal = new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.3, metalness: 0.85 });

    // 回る部分: 胴と鍔。鍔の外側に突起を付けて回転が見えるようにする
    spinner = new THREE.Group();
    root.add(spinner);

    const coreGeo = new THREE.CylinderGeometry(CORE, CORE, WIDTH + FLANGE_T * 2, 48);
    coreGeo.rotateZ(Math.PI / 2);
    spinner.add(new THREE.Mesh(coreGeo, wood));

    const flangeGeo = new THREE.CylinderGeometry(FLANGE_R, FLANGE_R, FLANGE_T, 64);
    flangeGeo.rotateZ(Math.PI / 2);
    const spokeGeo = new THREE.BoxGeometry(0.1, FLANGE_R * 0.8, 0.26);
    spokeGeo.translate(0, FLANGE_R * 0.48, 0);
    const hubGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.2, 32);
    hubGeo.rotateZ(Math.PI / 2);
    const spokeMat = new THREE.MeshStandardMaterial({ color: emberColor(0.3, 0.03), roughness: 0.5 });
    for (const side of [-1, 1]) {
      const fx = side * (WIDTH / 2 + FLANGE_T / 2 + 0.02);
      const flange = new THREE.Mesh(flangeGeo, wood);
      flange.position.x = fx;
      spinner.add(flange);
      // 軸が鍔に入るところのハブ
      const hub = new THREE.Mesh(hubGeo, spokeMat);
      hub.position.x = fx + side * (FLANGE_T / 2 + 0.1);
      spinner.add(hub);
      // 鍔の外側に明るい木の筋を 3 本。回っているのが分かる
      for (let k = 0; k < 3; k++) {
        const spoke = new THREE.Mesh(spokeGeo, spokeMat);
        spoke.position.x = fx + side * (FLANGE_T / 2 + 0.05);
        spoke.rotation.x = (k / 3) * Math.PI * 2;
        spinner.add(spoke);
      }
    }

    // 巻かれた糸。層ごとに 1 つの InstancedMesh にして、count で見せる数を決める
    threadMat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 });
    const color = new THREE.Color();
    for (let j = 0; j < LAYERS; j++) {
      const geo = new THREE.TorusGeometry(layerRadius(j), TUBE, 8, 64);
      geo.rotateY(Math.PI / 2);
      const mesh = new THREE.InstancedMesh(geo, threadMat, TURNS);
      for (let u = 0; u < TURNS; u++) {
        dummy.position.set(turnX(j, u), 0, 0);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(u, dummy.matrix);
        ember(color, 0.4 + 0.05 * j + 0.04 * Math.sin(u * 0.9 + j), 0.01 * (j % 2));
        mesh.setColorAt(u, color);
      }
      mesh.count = 0;
      root.add(mesh);
      layers.push(mesh);
    }

    // 送り出しの糸（供給点→ガイド→ボビン）
    const lineGeo = new THREE.CylinderGeometry(TUBE * 0.55, TUBE * 0.55, 1, 8);
    const lineMat = new THREE.MeshStandardMaterial({ color: emberColor(0.42), roughness: 0.5 });
    threadIn = new THREE.Mesh(lineGeo, lineMat);
    threadOut = new THREE.Mesh(lineGeo, lineMat);
    root.add(threadIn, threadOut);

    // ガイドのレールと、そこを走る台車
    const railGeo = new THREE.CylinderGeometry(0.12, 0.12, WIDTH + 3.4, 12);
    railGeo.rotateZ(Math.PI / 2);
    const rail = new THREE.Mesh(railGeo, metal);
    rail.position.set(0, GUIDE_Y + 0.75, GUIDE_Z);
    root.add(rail);

    carriage = new THREE.Group();
    const brass = new THREE.MeshStandardMaterial({
      color: emberColor(0.55, 0.02),
      roughness: 0.35,
      metalness: 0.6,
    });
    const block = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.55, 0.7), brass);
    block.position.y = 0.75;
    // 糸の通る目。ここだけ少し灯す
    const eye = new THREE.Mesh(
      new THREE.TorusGeometry(0.3, 0.08, 10, 28),
      new THREE.MeshStandardMaterial({ color: emberColor(0.8, 0, 0.08), roughness: 0.3 }),
    );
    const stem = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.12), brass);
    stem.position.y = 0.42;
    carriage.add(block, eye, stem);
    carriage.position.set(0, GUIDE_Y, GUIDE_Z);
    root.add(carriage);

    // 台: 軸を受ける 2 本の柱と、軸
    // 黒いと鍔の輪郭に食い込んで「欠け」に見えるので、暗い木色にして鍔から離して立てる
    const standMat = new THREE.MeshStandardMaterial({ color: emberColor(0.2, 0.02), roughness: 0.6 });
    const postX = WIDTH / 2 + FLANGE_T + STAND_GAP;
    const postH = -FLOOR_Y;
    const postGeo = new THREE.BoxGeometry(0.4, postH, 0.7);
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(postGeo, standMat);
      post.position.set(side * postX, FLOOR_Y + postH / 2, 0);
      root.add(post);
    }
    const axleGeo = new THREE.CylinderGeometry(0.14, 0.14, postX * 2, 16);
    axleGeo.rotateZ(Math.PI / 2);
    root.add(new THREE.Mesh(axleGeo, standMat));

    // 床。映り込みを強くするとリムライトが光だまりになるので、ざらつかせておく
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(16, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.75, metalness: 0.3 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = FLOOR_Y;
    root.add(floor);
  },

  update(t) {
    const w = wound(t);

    // 1 巻きで 1 回転。巻く向きに回り、ほどくときは同じ道を逆に戻る
    spinner.rotation.x = -w * Math.PI * 2;

    // 巻き終わった数だけ見せる
    const done = Math.floor(w + 1e-6);
    for (let j = 0; j < LAYERS; j++) {
      layers[j]!.count = Math.max(0, Math.min(TURNS, done - j * TURNS));
    }

    // いま巻いている層と、その中での位置
    const j = Math.min(LAYERS - 1, Math.floor(w / TURNS));
    const u = Math.min(TURNS - 1, Math.max(0, w - j * TURNS - 0.5));
    const x = turnX(j, u);
    carriage.position.x = x;

    // ガイドの目 → 糸が胴に乗る点（ガイドの方向を向いた胴の表面）
    const r = layerRadius(j);
    const len = Math.hypot(GUIDE_Y, GUIDE_Z);
    tmpB.set(x, (GUIDE_Y / len) * r, (GUIDE_Z / len) * r);
    stretch(threadOut, carriage.position, tmpB);
    stretch(threadIn, SOURCE, carriage.position);
  },

  sound(t, dt, sfx) {
    // 層が切り替わるたびに 1 音。巻くときは層ごとに上がり、ほどくときは下がる
    for (let k = tick(layerPhase(t)); k > 0; k--) {
      const ph = Math.floor(layerPhase(t));
      const m = ph % (LAYERS * 2);
      const step = m <= LAYERS ? m : LAYERS * 2 - m;
      sfx.pluck(tone(5 + step), { gain: 0.26, decay: 2.4, pan: (step % 2 === 0 ? -1 : 1) * 0.35 });
    }

    // 回転の速さに応じた低い唸り
    const w = wound(t);
    const speed = dt > 0 ? Math.abs(w - prevW) / dt : 0;
    prevW = w;
    if (speed > 0.3) sfx.drone(tone(0), Math.min(0.08, speed * 0.008));
    else sfx.drone(null);
  },
};
