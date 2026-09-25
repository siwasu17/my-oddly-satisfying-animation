import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * Hamster Wheel。
 *
 * 縦に立てた回し車の底で、まん丸のフワフワのハムスターが走り続ける。
 * 毛はシェル法で描く。体と同じ形の殻を 36 枚重ね、殻ごとに細い毛の断面だけを
 * 縁をぼかして残すので、根元が密で毛先ほど細く透ける、触れそうな細かい毛になる。
 * ひと蹴りごとに体が弾むと、毛先が鼻先からお尻へ少し遅れて波打つ。
 * 足は前後の 2 組が交互に地面を掻き、お腹の毛の下から短い脚と薄紅の足先がのぞく。
 *
 * 気持ちよさの芯は「足の運びと車輪の回転が完全に噛み合っている」こと。
 * 接地中の足は車輪の周速とちょうど同じ速さで後ろへ流れるので、滑らない。
 * 走る速さは 19 秒周期でわずかに緩急し、そのぶんハムスターは車輪の坂を
 * 少し登ったり戻ったりする。足・車輪・位置はすべて同じ積分 u(t) から作る。
 *
 * カメラは斜め前の少し上から、毛並みが読める距離まで寄る。音は横桟が足元を 4 本通るごとに柔らかく鳴る。
 * スコープ外: 巣材や餌皿などの小道具、瞬きや毛づくろいなどの別の仕草。
 */

// ---- 回し車 ----
/** 車輪の半径（横桟の中心まで） */
const R = 3.3;
/** 車輪の奥行き */
const W = 2.5;
/** 横桟の本数 */
const RUNGS = 44;
/** 横桟の太さ（半径） */
const RUNG_R = 0.055;
/** 車輪の中心の高さ */
const HUB_Y = R + 1.0;
/** 裏側のスポークの本数 */
const SPOKES = 6;

// ---- 走り ----
/** 車輪の周速の基準（単位/秒） */
const V0 = 2.6;
/** 1 歩（前足→後ろ足で 1 周）にかかる秒数 */
const STRIDE = 0.34;
/** 速さの緩急の周期と振れ幅 */
const EASE_T = 19;
const EASE_A = 0.12;
/** 車輪の坂を登る角度（底からの傾き、ラジアン）。負で進行方向 -x 側へ登る */
const CLIMB = -0.16;
/** 緩急に合わせて坂を登り降りする幅 */
const CLIMB_SWAY = 0.08;

// ---- ハムスター ----
/** 胴の半径（x: 前後, y: 上下, z: 左右） */
const BODY = [1.05, 0.78, 0.8] as const;
/** 頭の中心（胴の中心から）と半径 */
const HEAD_C = [-0.82, 0.14, 0] as const;
const HEAD_R = 0.62;
/** 地面から胴の中心までの高さ */
const BODY_H = 0.96;
/**
 * 毛はシェル法で描く。芯と同じ形を少しずつ外へふくらませた殻を何十枚も重ね、
 * 殻ごとに「毛の断面」だけを残して他を捨てる。根元では断面が太く、外の殻ほど
 * 細くなるので、1 本 1 本が先細りの細い毛になり、輪郭も柔らかくけば立つ。
 */
/** 殻の枚数。多いほど毛が滑らかにつながる */
const FUR_LAYERS = 36;
/** 毛の長さ（いちばん外の殻までの距離） */
const FUR_LEN = 0.16;
/** 毛の間隔。小さいほど細かい毛になる（単位長さあたりの本数の逆数） */
const FUR_GAP = 0.013;
/** 毛先をお尻側へ寝かせる度合いと、重みで垂れる度合い */
const FUR_COMB = 0.9;
const FUR_DROOP = 0.3;
/** 弾みで毛先が波打つ大きさ */
const FUR_WAVE = 0.4;
/** 弾みの大きさ */
const BOUNCE = 0.07;
/** 足の上げ幅 */
const FOOT_LIFT = 0.2;

// ---- カメラまわり ----
const FLOOR_R = 9;

const dummy = new THREE.Object3D();
const color = new THREE.Color();
const up = new THREE.Vector3(0, 1, 0);

/** 毛先の波の位相。全部の毛のマテリアルで共有する */
const furWave = { value: 0 };

let wheel: THREE.Group;
let hamPivot: THREE.Group;
let ham: THREE.Group;
let feet: THREE.Mesh[] = [];
let legs: THREE.Mesh[] = [];
const legDir = new THREE.Vector3();
const down = new THREE.Vector3(0, -1, 0);
let rungMat: THREE.MeshStandardMaterial;

let tick = ticker();
let step = 0;

/** 緩急を積分した「走った量」。足・車輪・位置はすべてここから作る */
function travel(t: number): number {
  const w = (Math.PI * 2) / EASE_T;
  return t + (EASE_A / w) * (1 - Math.cos(w * t));
}

/** 2 点のあいだに円柱を渡す */
function beam(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material): THREE.Mesh {
  const d = new THREE.Vector3().subVectors(b, a);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.length(), 12), mat);
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(up, d.normalize());
  return m;
}

/**
 * 毛の殻を差し込む。three はプログラムを「パラメータ」で引いたキャッシュから使い回すが、
 * そのキーに onBeforeCompile の中身は入らないので、キーを自分で分けておく。
 */
function furMaterial(ox: number, oy: number, density: THREE.Vector2): THREE.MeshStandardMaterial {
  // 毛の縁をぼかして重ねるので半透明。殻は内から外の順に描かれ、そのまま奥から手前になる
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, vertexColors: true, transparent: true });
  mat.customProgramCacheKey = () => 'hamsterWheel-fur';
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uWave = furWave;
    sh.uniforms.uLen = { value: FUR_LEN };
    sh.uniforms.uOff = { value: new THREE.Vector2(ox, oy) };
    sh.uniforms.uDensity = { value: density };
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aLayer;
attribute float aLen;
attribute vec2 aFurUv;
uniform float uWave;
uniform float uLen;
uniform vec2 uOff;
varying float vH;
varying vec2 vFurUv;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vH = aLayer;
vFurUv = aFurUv;
{
  float h = aLayer;
  float L = uLen * aLen;
  vec3 fn = normalize(objectNormal);
  // 弾みが鼻先からお尻へ遅れて伝わり、毛先ほど大きく揺れる
  float wave = sin(uWave - (position.x + uOff.x) * 1.8);
  vec3 comb = vec3(${FUR_COMB.toFixed(3)}, -${FUR_DROOP.toFixed(3)}, 0.0);
  transformed += fn * L * h + comb * L * h * h + (fn * 0.6 + vec3(0.6, 0.0, 0.0)) * L * ${FUR_WAVE.toFixed(3)} * wave * h * h;
}`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec2 uDensity;
varying float vH;
varying vec2 vFurUv;
float furHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  vec2 cell = vFurUv * uDensity;
  vec2 id = floor(cell);
  vec2 f = fract(cell) - 0.5;
  vec2 jit = vec2(furHash(id + 1.7), furHash(id + 9.2)) - 0.5;
  // 1 本ごとに長さを散らす。短い毛が混じると毛先がそろわず柔らかく見える
  float len = 0.5 + 0.5 * furHash(id);
  float r = 0.72 * (1.0 - vH / len);
  float d = length(f - jit * 0.45);
  // 縁を画素 1 つぶんぼかす。二値で切ると輪郭が砂目になる
  float w = max(fwidth(d), 0.02) * 1.2;
  float a = 1.0 - smoothstep(r - w, r + w, d);
  a *= 1.0 - 0.55 * vH;
  if (a < 0.02) discard;
  diffuseColor.a *= a;
  // 根元ほど少し暗く（毛の奥の影）、毛先ほど明るい。差は控えめにしてなじませる
  diffuseColor.rgb *= mix(0.66, 1.18, vH) * (0.96 + 0.08 * furHash(id + 4.4));
}`,
      );
  };
  return mat;
}

/**
 * 芯の形から毛の殻を作る。lenAt は胴の座標で毛の長さの倍率を返す
 * （顔のまわりやお腹の下は短くする）。
 */
function furShells(
  geo: THREE.BufferGeometry,
  ox: number,
  oy: number,
  oz: number,
  density: THREE.Vector2,
  lenAt: (x: number, y: number, z: number) => number,
): THREE.InstancedMesh {
  const g = geo.clone();
  const pos = g.attributes.position;
  const lens = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) lens[i] = lenAt(pos.getX(i) + ox, pos.getY(i) + oy, pos.getZ(i) + oz);
  g.setAttribute('aLen', new THREE.BufferAttribute(lens, 1));
  g.setAttribute('aFurUv', g.attributes.uv.clone());
  const layers = new Float32Array(FUR_LAYERS);
  for (let i = 0; i < FUR_LAYERS; i++) layers[i] = (i + 1) / FUR_LAYERS;
  g.setAttribute('aLayer', new THREE.InstancedBufferAttribute(layers, 1));

  const m = new THREE.InstancedMesh(g, furMaterial(ox, oy, density), FUR_LAYERS);
  dummy.position.set(0, 0, 0);
  dummy.rotation.set(0, 0, 0);
  dummy.scale.set(1, 1, 1);
  dummy.updateMatrix();
  for (let i = 0; i < FUR_LAYERS; i++) m.setMatrixAt(i, dummy.matrix);
  // 殻は頂点シェーダで外へ押し出すので、境界球が合わない
  m.frustumCulled = false;
  return m;
}

export const hamsterWheel: SceneModule = {
  name: 'Hamster Wheel',
  desc: 'フワフワのハムスターが回し車の底で走り続ける。足の運びと車輪の回転がぴたりと噛み合う。',
  camera: { pos: [-2.3, 3.1, 5.85], target: [-0.25, 2.15, 0] },
  shadows: true,

  build(root) {
    tick = ticker();
    step = 0;

    // ---- 床 ----
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(FLOOR_R, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.3, metalness: 0.85 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    floor.receiveShadow = true;
    root.add(floor);

    // ---- 回し車 ----
    const metal = new THREE.MeshStandardMaterial({
      color: emberColor(0.3, -0.01),
      roughness: 0.5,
      metalness: 0.55,
    });
    rungMat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.55 });
    rungMat.color.copy(emberColor(0.36));

    wheel = new THREE.Group();
    wheel.position.set(0, HUB_Y, 0);
    root.add(wheel);

    for (const z of [-W / 2, W / 2]) {
      const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.09, 12, 120), metal);
      rim.position.z = z;
      rim.castShadow = true;
      wheel.add(rim);
    }

    const rungs = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(RUNG_R, RUNG_R, W, 8).rotateX(Math.PI / 2),
      rungMat,
      RUNGS,
    );
    for (let i = 0; i < RUNGS; i++) {
      const a = (i / RUNGS) * Math.PI * 2;
      dummy.position.set(Math.cos(a) * R, Math.sin(a) * R, 0);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      rungs.setMatrixAt(i, dummy.matrix);
    }
    rungs.castShadow = true;
    wheel.add(rungs);

    // 裏側だけにスポーク。表は開けてハムスターを見せる
    const zb = -W / 2;
    for (let i = 0; i < SPOKES; i++) {
      const a = (i / SPOKES) * Math.PI * 2 + 0.3;
      wheel.add(
        beam(
          new THREE.Vector3(0, 0, zb),
          new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, zb),
          0.05,
          metal,
        ),
      );
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.3, 24).rotateX(Math.PI / 2), metal);
    hub.position.z = zb;
    wheel.add(hub);

    // ---- 台（回らない） ----
    const standMat = new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.45, metalness: 0.6 });
    const axleBack = new THREE.Vector3(0, HUB_Y, -W / 2 - 0.55);
    root.add(beam(new THREE.Vector3(0, HUB_Y, -W / 2), axleBack, 0.09, standMat));
    for (const x of [-1, 1]) {
      const leg = beam(axleBack, new THREE.Vector3(x * 2.1, 0.05, -W / 2 - 0.55), 0.1, standMat);
      leg.castShadow = true;
      root.add(leg);
    }
    const base = new THREE.Mesh(new THREE.BoxGeometry(5, 0.1, 0.7), standMat);
    base.position.set(0, 0.05, -W / 2 - 0.55);
    root.add(base);

    // ---- ハムスター ----
    hamPivot = new THREE.Group();
    hamPivot.position.set(0, HUB_Y, 0);
    root.add(hamPivot);
    ham = new THREE.Group();
    hamPivot.add(ham);

    // 背中は濃い琥珀、お腹・頬・鼻先はクリーム。芯と毛で同じ塗り分けを使う
    const shade = (out: THREE.Color, x: number, y: number, z: number, jit: number): THREE.Color => {
      const cheek = x < -0.45 ? THREE.MathUtils.smoothstep(-x, 0.45, 1.3) * 0.5 : 0;
      const belly = THREE.MathUtils.smoothstep(-y + cheek - Math.abs(z) * 0.15, -0.15, 0.45);
      return ember(out, 0.66 + 0.34 * belly + jit, 0, 0.16 * belly);
    };

    // 芯: 滑らかな胴と頭。頂点色で塗り分ける。
    // 毛の殻の UV が極で詰まらないよう、球の極を前後（鼻先とお尻）へ向けておく
    const coreMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, vertexColors: true });
    const paint = (geo: THREE.BufferGeometry, ox: number, oy: number, oz: number): THREE.BufferGeometry => {
      const pos = geo.attributes.position;
      const col = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        shade(color, pos.getX(i) + ox, pos.getY(i) + oy, pos.getZ(i) + oz, 0).toArray(col, i * 3);
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      return geo;
    };
    const mz = [HEAD_C[0] - HEAD_R * 0.78, HEAD_C[1] - 0.14, 0] as const;
    // 毛の長さの倍率: 顔の正面とお腹の下は短く、背中と頬はたっぷり
    const lenAt = (x: number, y: number, z: number): number => {
      const face = THREE.MathUtils.smoothstep(-(x - HEAD_C[0]) - Math.abs(z) * 0.1, 0.18, 0.42);
      const under = THREE.MathUtils.smoothstep(-y, 0.45, 0.8);
      return (1 - 0.75 * face) * (1 - 0.55 * under);
    };
    const parts: [THREE.BufferGeometry, readonly [number, number, number], number][] = [
      [new THREE.SphereGeometry(1, 48, 32).rotateZ(-Math.PI / 2).scale(BODY[0], BODY[1], BODY[2]), [0, 0, 0], 0.79],
      [new THREE.SphereGeometry(HEAD_R, 40, 28).rotateZ(-Math.PI / 2), HEAD_C, HEAD_R],
      [new THREE.SphereGeometry(0.3, 24, 16).rotateZ(-Math.PI / 2).scale(1, 0.8, 1.1), mz, 0.3],
    ];
    for (const [geo, c, ring] of parts) {
      paint(geo, c[0], c[1] - (geo === parts[2][0] ? 0.3 : 0), c[2]);
      const core = new THREE.Mesh(geo, coreMat);
      core.position.set(c[0], c[1], c[2]);
      core.castShadow = true;
      ham.add(core);
      // 毛の本数は周の長さ（u）と前後の長さ（v）から、間隔 FUR_GAP で決める
      const bb = (geo.boundingBox ?? (geo.computeBoundingBox(), geo.boundingBox))!;
      const around = (Math.PI * 2 * ring) / FUR_GAP;
      const along = ((bb.max.x - bb.min.x) * 1.57) / FUR_GAP;
      const shells = furShells(geo, c[0], c[1], c[2], new THREE.Vector2(Math.round(around), Math.round(along)), lenAt);
      shells.position.set(c[0], c[1], c[2]);
      ham.add(shells);
    }

    // 顔: 目・鼻・耳
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x0a0506, roughness: 0.1, metalness: 0.3 });
    const pinkMat = new THREE.MeshStandardMaterial({ color: emberColor(0.3, 0.02, 0.16), roughness: 0.7 });
    const hc = new THREE.Vector3(HEAD_C[0], HEAD_C[1], HEAD_C[2]);
    for (const sd of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), eyeMat);
      eye.position.set(-0.62, 0.34, sd * 0.62).normalize().multiplyScalar(HEAD_R * 1.0).add(hc);
      ham.add(eye);

      // 耳: 毛色の外側と、ピンクの内側
      const ear = new THREE.Group();
      ear.position.set(HEAD_C[0] + 0.12, HEAD_C[1] + HEAD_R * 0.82, sd * 0.34);
      ear.rotation.set(sd * 0.45, 0, -0.25);
      const outer = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 12), coreMat);
      paint(outer.geometry, 0, 1, 0);
      outer.scale.set(0.35, 1, 1);
      const inner = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 12), pinkMat);
      inner.scale.set(0.3, 1, 1);
      inner.position.set(-0.05, 0.02, 0);
      ear.add(outer, inner);
      ham.add(ear);
    }
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 10), pinkMat);
    nose.position.set(mz[0] - 0.3, mz[1] + 0.04, 0);
    ham.add(nose);

    // 足 4 本（前左, 前右, 後左, 後右）。毛色の短い脚で胴とつなぎ、先に薄紅の足先
    feet = [];
    legs = [];
    const footGeo = new THREE.SphereGeometry(0.11, 14, 10);
    footGeo.scale(1.5, 0.6, 1.1);
    const legGeo = new THREE.CylinderGeometry(0.085, 0.07, 1, 10);
    legGeo.translate(0, -0.5, 0);
    const legMat = new THREE.MeshStandardMaterial({ color: emberColor(0.8), roughness: 0.9 });
    for (let i = 0; i < 4; i++) {
      const f = new THREE.Mesh(footGeo, pinkMat);
      feet.push(f);
      ham.add(f);
      const leg = new THREE.Mesh(legGeo, legMat);
      legs.push(leg);
      ham.add(leg);
    }
  },

  update(t) {
    const u = travel(t);
    const speed = 1 + EASE_A * Math.sin(((Math.PI * 2) / EASE_T) * t);

    // 車輪: 底が +x へ流れる向き（ハムスターは -x へ走る）
    wheel.rotation.z = (V0 * u) / R;
    rungMat.color.copy(ember(color, 0.36, drift(t)));

    // 速いときは少し坂を登り、緩むと戻る
    hamPivot.rotation.z = CLIMB - CLIMB_SWAY * (speed - 1) / EASE_A;

    const g = u / STRIDE; // 歩の位相（整数で 1 歩）
    const gf = g - Math.floor(g);
    const bounce = BOUNCE * Math.abs(Math.sin(Math.PI * 2 * g));
    ham.position.set(0, -(R - RUNG_R) + BODY_H + bounce, 0);
    ham.rotation.z = 0.05 * Math.sin(Math.PI * 2 * g + 0.6);
    ham.scale.set(1 + bounce * 0.5, 1 - bounce * 0.8, 1 + bounce * 0.5);

    // 足: 接地の半周は周速 V0 で後ろ (+x) へ流れ、残り半周で浮いて前へ戻る
    const d = (V0 * STRIDE) / 4;
    const groundY = -BODY_H + 0.09;
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const side = i % 2 === 0 ? -1 : 1;
      let p = gf + (front ? 0 : 0.5) + (side > 0 ? 0.08 : 0);
      p -= Math.floor(p);
      let x: number, lift: number;
      if (p < 0.5) {
        x = -d + 4 * d * p;
        lift = 0;
      } else {
        const q = (p - 0.5) * 2;
        x = d - 2 * d * (0.5 - 0.5 * Math.cos(Math.PI * q));
        lift = FOOT_LIFT * Math.sin(Math.PI * q);
      }
      const f = feet[i];
      const hipX = front ? -0.5 : 0.48;
      const hipZ = side * (front ? 0.32 : 0.4);
      f.position.set(hipX + x, groundY + lift - bounce, hipZ);
      // 脚: お腹の中の付け根から足先まで
      const leg = legs[i];
      leg.position.set(hipX, -0.66, hipZ);
      legDir.subVectors(f.position, leg.position);
      leg.scale.set(1, legDir.length(), 1);
      leg.quaternion.setFromUnitVectors(down, legDir.normalize());
    }

    // 毛先の波: 1 歩で 2 回弾むのに合わせる
    furWave.value = Math.PI * 4 * g;
  },

  sound(t, _dt, sfx) {
    // 横桟が足元を 4 本通るごとに 1 回
    const rungsPassed = ((V0 * travel(t)) / R / (Math.PI * 2)) * RUNGS;
    for (let k = tick(rungsPassed / 4); k > 0; k--) {
      step++;
      sfx.pluck(tone(3 + [0, 2, 4, 2][step % 4]), {
        gain: 0.16,
        decay: 0.7,
        pan: -0.15,
      });
    }
  },
};
