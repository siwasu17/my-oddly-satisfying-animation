import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * Campfire。
 *
 * 円錐に組んだ薪の芯で小さな炎が揺れ、そこから無数の火の粉が
 * ゆるい渦を巻きながら立ち上って、上空で暗くなって消える。
 * 主役は炎ではなく火の粉の群れで、一粒ごとに寿命と旋回の速さが違うため、
 * 全体としては不規則に見えながら、粒は各自の周期でずっと同じ軌跡を回り続ける。
 * カメラは焚き火の端に座ったくらいの高さから、少し見下ろしている。
 * 音は数秒に一度パチッと爆ぜる短い音と、その下に敷いた低い唸り。
 */

// ---- 調整する数値はここにまとめる ----------------------------------------

/** 火の粉の数 */
const SPARKS = 240;
/** 薪の本数（円錐に立てかける） */
const LOGS = 5;
/** 炎の芯を作る舌の枚数 */
const FLAMES = 4;
/** 薪の根元で明滅する熾火の数 */
const EMBERS = 24;

/** 火の粉が湧き出す高さ */
const SPARK_Y0 = 0.55;
/** 火の粉の粒の基準サイズ */
const SPARK_SIZE = 0.082;
/** 火の粉が上りきる高さの範囲 */
const RISE_MIN = 3.0;
const RISE_MAX = 6.0;
/** 一粒が湧いて消えるまでの秒数 */
const LIFE_MIN = 3.4;
const LIFE_MAX = 7.8;
/** 上るにつれて外へ広がる量 */
const SPREAD = 1.15;
/** 上りながら旋回する角度の最大（ラジアン） */
const TWIST = 3.4;

/** 薪の長さと太さ */
const LOG_LEN = 3.4;
const LOG_R = 0.26;
/** 薪を立てかける円の半径 */
const LOG_FOOT = 1.55;

/** 炎の芯の高さ。薪の交点より低く保つと、束ねた頂点が黒いシルエットとして抜ける */
const FLAME_H = 0.95;
/** 床の半径 */
const FLOOR_R = 8.5;

/** 爆ぜる音の刻み（1 秒あたり。ここから間引いて不規則にする） */
const POP_RATE = 1.15;

// ---------------------------------------------------------------------------

const dummy = new THREE.Object3D();
const color = new THREE.Color();

/** 火の粉ごとの [初期角, 初期半径, 寿命, 位相ずれ, 旋回の速さ, 上る高さ, 横揺れ] */
const sparks = new Float32Array(SPARKS * 7);
/** 熾火ごとの [x, z, 大きさ, 明滅の位相] */
const embers = new Float32Array(EMBERS * 4);

let sparkMesh: THREE.InstancedMesh;
let emberMesh: THREE.InstancedMesh;
let flames: THREE.Mesh[] = [];
let fireLight: THREE.PointLight;

/** 爆ぜる音の刻み。build のたびに作り直す。 */
let tick = ticker();
let pop = 0;

/** 固定シードの乱数。Math.random() を使うと開き直すたびに絵が変わる。 */
let seed = 0.4831;
const rnd = (): number => (seed = (seed * 9301 + 0.49297) % 1);

/** 0..1 を行き来する炎のゆらぎ。update と sound の両方から引くので純関数にする。 */
const flicker = (t: number): number => {
  const a = Math.sin(t * 5.3) + Math.sin(t * 8.7 + 1.4) * 0.6 + Math.sin(t * 13.1 + 2.7) * 0.35;
  return 0.5 + a * 0.255;
};

/** 火の粉の寿命 u（0..1）に対する明るさ。立ち上がりは速く、消えぎわは長く引く。 */
const glowOf = (u: number): number => Math.min(1, u / 0.09) * Math.pow(1 - u, 1.35);

export const campfire: SceneModule = {
  name: 'Campfire',
  desc: '組んだ薪の芯から、火の粉が渦を巻いて立ち上っては消えていく。',
  camera: { pos: [0, 4.9, 9.4], target: [0, 2.9, 0] },

  build(root) {
    tick = ticker();
    pop = 0;
    seed = 0.4831;
    flames = [];

    // ---- 床。薪と炎が薄く映り込んで、焚き火が地面に置かれて見える ----
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(FLOOR_R, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.84, metalness: 0.22 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.01;
    root.add(floor);

    // ---- 薪。円錐に立てかけた中に、地面へ寝かせた 2 本を差し込む ----
    const logGeo = new THREE.CylinderGeometry(LOG_R * 0.8, LOG_R, LOG_LEN, 7);
    logGeo.translate(0, LOG_LEN * 0.5, 0); // 原点を根元へ移して、傾けるだけで立てかかる
    const logMat = new THREE.MeshStandardMaterial({
      color: SURFACE,
      roughness: 0.88,
      metalness: 0.08,
    });
    for (let i = 0; i < LOGS; i++) {
      // 手前の 1 本は組まない。火の粉の噴き出し口が開いて、三脚の交差が読める
      if (i === 1) continue;
      const a = (i / LOGS) * Math.PI * 2 + 0.3;
      const log = new THREE.Mesh(logGeo, logMat);
      log.position.set(Math.cos(a) * LOG_FOOT, 0, Math.sin(a) * LOG_FOOT);
      log.rotation.order = 'YXZ';
      log.rotation.y = -a;
      log.rotation.z = 0.52 + rnd() * 0.08; // 頂点で束ねるところまで倒す
      log.rotation.x = (rnd() - 0.5) * 0.1;
      root.add(log);
    }
    for (let i = 0; i < 2; i++) {
      const a = 1.1 + i * 2.4;
      const log = new THREE.Mesh(logGeo, logMat);
      log.position.set(Math.cos(a) * 2.1, LOG_R, Math.sin(a) * 2.1);
      log.rotation.order = 'YXZ';
      log.rotation.y = -a + 1.4;
      log.rotation.z = Math.PI * 0.5;
      root.add(log);
    }

    // ---- 熾火。薪の足元で不規則に明滅する平たい粒 ----
    for (let i = 0; i < EMBERS; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 0.25 + rnd() * 1.25;
      embers[i * 4] = Math.cos(a) * r;
      embers[i * 4 + 1] = Math.sin(a) * r;
      embers[i * 4 + 2] = 0.1 + rnd() * 0.14;
      embers[i * 4 + 3] = rnd() * Math.PI * 2;
    }
    emberMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 7, 5),
      new THREE.MeshBasicMaterial(),
      EMBERS,
    );
    emberMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(emberMesh);

    // ---- 炎の芯。細い舌を数枚、位相をずらして伸び縮みさせる ----
    const flameGeo = new THREE.ConeGeometry(0.3, FLAME_H, 6, 1, true);
    flameGeo.translate(0, FLAME_H * 0.5, 0);
    for (let i = 0; i < FLAMES; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: emberColor(0.72),
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const flame = new THREE.Mesh(flameGeo, mat);
      const a = (i / FLAMES) * Math.PI * 2;
      flame.position.set(Math.cos(a) * 0.3, 0.1, Math.sin(a) * 0.3);
      flame.userData.phase = rnd() * Math.PI * 2;
      flames.push(flame);
      root.add(flame);
    }

    // ---- 火そのものが光源なので、ここだけは PointLight を足す ----
    fireLight = new THREE.PointLight(emberColor(0.9), 4.2, 9, 2);
    fireLight.position.set(0, 0.9, 0);
    root.add(fireLight);

    // ---- 火の粉 ----
    for (let i = 0; i < SPARKS; i++) {
      const o = i * 7;
      sparks[o] = rnd() * Math.PI * 2; // 初期角
      sparks[o + 1] = 0.12 + rnd() * 0.72; // 初期半径
      sparks[o + 2] = LIFE_MIN + rnd() * (LIFE_MAX - LIFE_MIN); // 寿命
      sparks[o + 3] = rnd() * 40; // 位相ずれ（湧く時刻をばらす）
      sparks[o + 4] = (rnd() < 0.22 ? -1 : 1) * (0.45 + rnd() * 0.85); // 旋回
      sparks[o + 5] = RISE_MIN + rnd() * (RISE_MAX - RISE_MIN); // 上る高さ
      sparks[o + 6] = 0.1 + rnd() * 0.3; // 横揺れ
    }
    sparkMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 6, 4),
      new THREE.MeshBasicMaterial(),
      SPARKS,
    );
    sparkMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(sparkMesh);
  },

  update(t) {
    const hue = drift(t);
    const fl = flicker(t);

    // ---- 火の粉 ----
    for (let i = 0; i < SPARKS; i++) {
      const o = i * 7;
      const a0 = sparks[o];
      const life = sparks[o + 2];
      // 位相を t から作り直す。差分を積み上げないので、いつ開いても同じ軌跡になる
      const u = (((t + sparks[o + 3]) / life) % 1 + 1) % 1;

      const rise = sparks[o + 5];
      const y = SPARK_Y0 + rise * Math.pow(u, 0.82);
      // 上るほど外へ開き、同時に旋回する
      const r = sparks[o + 1] * (1 + u * 0.9) + SPREAD * u * u;
      const ang = a0 + sparks[o + 4] * TWIST * u;
      const wob = sparks[o + 6] * u;

      const g = glowOf(u);
      const s = SPARK_SIZE * (0.4 + 0.6 * g);

      dummy.position.set(
        Math.cos(ang) * r + Math.sin(u * 7.1 + a0 * 3.3) * wob,
        y,
        Math.sin(ang) * r + Math.cos(u * 6.3 + a0 * 2.1) * wob,
      );
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      sparkMesh.setMatrixAt(i, dummy.matrix);

      // 湧いたては橙、上りきるころには暗い薔薇まで落ちる。
      // glow を上げすぎると bloom で白く潰れて「火の色」が飛ぶので、ごく控えめにする
      ember(color, 0.16 + 0.68 * g, hue, 0.1 * g);
      sparkMesh.setColorAt(i, color);
    }
    sparkMesh.instanceMatrix.needsUpdate = true;
    if (sparkMesh.instanceColor) sparkMesh.instanceColor.needsUpdate = true;

    // ---- 熾火 ----
    for (let i = 0; i < EMBERS; i++) {
      const o = i * 4;
      const b = 0.5 + 0.5 * Math.sin(t * 2.3 + embers[o + 3]) * Math.sin(t * 0.9 + embers[o]);
      dummy.position.set(embers[o], 0.06, embers[o + 1]);
      dummy.scale.set(embers[o + 2], embers[o + 2] * 0.45, embers[o + 2]);
      dummy.updateMatrix();
      emberMesh.setMatrixAt(i, dummy.matrix);

      ember(color, 0.3 + 0.55 * b, hue, 0.1 * b);
      emberMesh.setColorAt(i, color);
    }
    emberMesh.instanceMatrix.needsUpdate = true;
    if (emberMesh.instanceColor) emberMesh.instanceColor.needsUpdate = true;

    // ---- 炎の芯 ----
    for (let i = 0; i < FLAMES; i++) {
      const flame = flames[i];
      const p = flame.userData.phase as number;
      const h = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 4.1 + p));
      flame.scale.set(0.8 + 0.2 * h, h, 0.8 + 0.2 * h);
      flame.rotation.z = Math.sin(t * 2.7 + p) * 0.13;
      flame.rotation.x = Math.cos(t * 3.1 + p * 1.7) * 0.13;
      const mat = flame.material as THREE.MeshBasicMaterial;
      // bloom の閾値（明度 0.28）をわずかに超える程度に抑える。
      // ここを明るくすると芯が白く潰れて、薪のシルエットを内側から消してしまう
      mat.opacity = 0.22 + 0.18 * h;
      ember(mat.color, 0.64 + 0.14 * h, hue);
    }

    // ---- 光源。炎の揺らぎに合わせて強さが呼吸する ----
    fireLight.intensity = 3.2 + fl * 1.9;
    fireLight.position.x = Math.sin(t * 1.7) * 0.12;
    fireLight.position.z = Math.cos(t * 2.1) * 0.12;
  },

  sound(t, _dt, sfx) {
    // 焚き火の唸り。炎の揺らぎと同じ式から作るので、映像とずれない
    sfx.drone(tone(0), 0.05 + flicker(t) * 0.03);

    for (let k = tick(t * POP_RATE); k > 0; k--) {
      pop++;
      // 刻みを間引いて「数秒に一度、不規則に」爆ぜる形にする
      const h = (Math.sin(pop * 12.9898) * 43758.5453) % 1;
      const r = h < 0 ? h + 1 : h;
      if (r < 0.42) continue;
      sfx.pluck(tone(7 + Math.floor(r * 9)), {
        gain: 0.1 + r * 0.14,
        decay: 0.2 + r * 0.3,
        pan: Math.sin(pop * 2.7) * 0.6,
      });
    }
  },
};
