import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * 百鬼夜行。
 *
 * 闇に浮かぶ環状の夜道を、提灯を提げた百体の妖怪がひたすら練り歩く。
 * 道は円ではなく、半径と高さに整数倍の波を重ねた閉曲線なので、
 * 行列は膨らんだり窄まったり、丘を越えて上下しながら、必ず元の場所へ帰ってくる。
 *
 * 一体が持っているのは「道のどこにいるか」だけで、位置も向きも毎フレーム
 * その 1 つの式から作り直す。前後の間隔をわずかにばらしてあるので、
 * 列は詰まったり途切れたりしながらも、灯りのひと連なりとしては崩れない。
 * 行列と一緒に 3 つの灯りが動いていて、通り過ぎたところだけ道が明るむ。
 *
 * 一周はおよそ 54 秒。手前の鳥居をくぐるたびに、遠くで鈴が鳴る。
 */

/** 頭数。名前のとおり百。 */
const COUNT = 100;
/** 行列が道を一周するのにかかる秒数。 */
const LAP = 54;
/** 道の基準半径。 */
const R = 15;
/** 道幅の半分。 */
const ROAD_W = 1.7;
/** 道を刻む分割数。 */
const SEG = 240;
/** 提灯を提げる高さ（体の大きさに比例する）。 */
const LANTERN_Y = 1.05;
/** 行列と一緒に動く灯りの数。 */
const LAMPS = 3;
/**
 * 鳥居を置く位置（道のパラメータ 0..1）。
 * ここは道が丘の上でカメラの方へ向き直る地点なので、鳥居が正面から見える。
 */
const GATE = 0.0375;
/** 何体おきに音を鳴らすか。全部鳴らすと団子になる。 */
const SOUND_EVERY = 4;

const TAU = Math.PI * 2;
/** 進行方向を数値微分で拾うときの刻み。 */
const DU = 0.0015;

const dummy = new THREE.Object3D();
const color = new THREE.Color();
const here = new THREE.Vector3();
const ahead = new THREE.Vector3();

/** 妖怪ごとの [道の位置, 道幅方向のずれ, 大きさ, 歩調, 位相] */
const oni = new Float32Array(COUNT * 5);

let bodies: THREE.InstancedMesh;
let lanterns: THREE.InstancedMesh;
let lamps: THREE.PointLight[] = [];

/** 一体ごとに、鳥居をくぐった回数を数える */
let ticks = tickers(COUNT);
/** 風がひと吹きする間隔を数える */
let tickWind = ticker();

/** 道の上の点を out に書き込む。u は 0..1 で、1 増えるとちょうど一周する。 */
function roadAt(u: number, out: THREE.Vector3): THREE.Vector3 {
  const a = u * TAU;
  // 半径と高さに整数倍の波だけを重ねてあるので、一周すれば必ず元へ戻る
  const r = R + 3.0 * Math.sin(a * 3) + 1.4 * Math.sin(a * 5 + 0.7);
  const y = 2.1 + 1.15 * Math.sin(a * 2 + 0.4) + 0.62 * Math.sin(a * 5 + 1.9);
  return out.set(Math.cos(a) * r, y, Math.sin(a) * r);
}

/** 道を帯として起こす。ほぼ水平なので、法線は上向きで足りる。 */
function buildRoad(): THREE.Mesh {
  const pos = new Float32Array(SEG * 2 * 3);
  const nor = new Float32Array(SEG * 2 * 3);
  const idx = new Uint16Array(SEG * 6);

  for (let i = 0; i < SEG; i++) {
    roadAt(i / SEG, here);
    roadAt((i + 1) / SEG, ahead);
    const dx = ahead.x - here.x;
    const dz = ahead.z - here.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = dz / len;
    const nz = -dx / len;

    const o = i * 6;
    pos[o] = here.x + nx * ROAD_W;
    pos[o + 1] = here.y - 0.06;
    pos[o + 2] = here.z + nz * ROAD_W;
    pos[o + 3] = here.x - nx * ROAD_W;
    pos[o + 4] = here.y - 0.06;
    pos[o + 5] = here.z - nz * ROAD_W;
    nor[o + 1] = 1;
    nor[o + 4] = 1;

    const a0 = i * 2;
    const a1 = i * 2 + 1;
    const b0 = ((i + 1) % SEG) * 2;
    const b1 = ((i + 1) % SEG) * 2 + 1;
    const j = i * 6;
    idx[j] = a0;
    idx[j + 1] = b0;
    idx[j + 2] = a1;
    idx[j + 3] = a1;
    idx[j + 4] = b0;
    idx[j + 5] = b1;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));

  return new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      color: SURFACE,
      roughness: 0.42,
      metalness: 0.75,
      side: THREE.DoubleSide,
    }),
  );
}

/** 行列がくぐる鳥居。道の GATE の地点に、進行方向へ向けて立てる。 */
function buildGate(): THREE.Group {
  roadAt(GATE, here);
  roadAt(GATE + DU, ahead);
  const top = here.y + 3.0;
  const half = ROAD_W + 0.5;

  const gate = new THREE.Group();
  gate.position.set(here.x, 0, here.z);
  // Y 回転をこう取ると、局所 +Z が進行方向、局所 +X が道幅方向になる
  gate.rotation.y = Math.atan2(ahead.x - here.x, ahead.z - here.z);

  const mat = new THREE.MeshStandardMaterial({
    color: emberColor(0.3),
    roughness: 0.62,
    metalness: 0.25,
  });

  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, top, 0.3), mat);
    post.position.set(half * side, top / 2, 0);
    gate.add(post);
  }
  const kasagi = new THREE.Mesh(new THREE.BoxGeometry(half * 2 + 1.1, 0.24, 0.36), mat);
  kasagi.position.y = top;
  gate.add(kasagi);
  const nuki = new THREE.Mesh(new THREE.BoxGeometry(half * 2 + 0.3, 0.16, 0.24), mat);
  nuki.position.y = top - 0.72;
  gate.add(nuki);

  return gate;
}

/** 提灯を提げた妖怪の行列が、うねる夜道をどこまでも巡っていく。 */
export const nightParade: SceneModule = {
  name: 'Night Parade',
  desc: '百の提灯がひと連なりになって、闇の環をゆっくり練り歩く。',
  // 俯瞰しすぎると鳥居が潰れるので、環が見える高さぎりぎりまで下げている
  camera: { pos: [0, 11, 33], target: [0, 1.6, 0] },

  build(root) {
    ticks = tickers(COUNT);
    tickWind = ticker();
    dummy.rotation.order = 'YXZ';

    // 固定シード。開き直しても同じ行列になる
    let s = 0.4137;
    const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);

    for (let i = 0; i < COUNT; i++) {
      const o = i * 5;
      // 等間隔を基本にしつつ前後へ散らすと、詰まりと隙間ができて行列らしくなる
      oni[o] = (i + rnd() * 0.6 - 0.3) / COUNT;
      oni[o + 1] = (rnd() * 2 - 1) * (ROAD_W - 0.5);
      oni[o + 2] = 0.6 + rnd() * 0.66;
      oni[o + 3] = 5.0 + rnd() * 2.8;
      oni[o + 4] = rnd() * TAU;
    }

    // 五角錐にしておくと、衣の折り目のような陰影が出る
    const body = new THREE.ConeGeometry(0.42, 1.15, 5);
    body.translate(0, 0.575, 0);
    bodies = new THREE.InstancedMesh(
      body,
      new THREE.MeshStandardMaterial({ roughness: 0.86, metalness: 0.1, flatShading: true }),
      COUNT,
    );
    bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(bodies);

    // 提灯は光そのものなので、陰影を付けずブルームに拾わせる
    lanterns = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.17, 10, 8),
      new THREE.MeshBasicMaterial(),
      COUNT,
    );
    lanterns.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(lanterns);

    // 行列と一緒に動く灯り。通り過ぎたところだけ道と衣が明るむ
    lamps = [];
    for (let k = 0; k < LAMPS; k++) {
      const lamp = new THREE.PointLight(0xffa055, 26, 20, 2);
      lamps.push(lamp);
      root.add(lamp);
    }

    root.add(buildRoad());
    root.add(buildGate());

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(R * 2.4, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.3, metalness: 0.92 }),
    );
    floor.rotation.x = -Math.PI / 2;
    root.add(floor);
  },

  update(t) {
    const hue = drift(t);
    // 行列の先頭が道のどこにいるか。各自の位置に足すだけで、全員が同じ速さで進む
    const head = t / LAP;

    for (let i = 0; i < COUNT; i++) {
      const o = i * 5;
      const size = oni[o + 2]!;
      const gait = t * oni[o + 3]! + oni[o + 4]!;

      const u = head + oni[o]!;
      roadAt(u, here);
      roadAt(u + DU, ahead);
      const dx = ahead.x - here.x;
      const dz = ahead.z - here.z;
      const len = Math.hypot(dx, dz) || 1;
      const tx = dx / len;
      const tz = dz / len;
      const nx = tz;
      const nz = -tx;

      const side = oni[o + 1]!;
      const bob = Math.abs(Math.sin(gait)) * 0.17 * size;
      const x = here.x + nx * side;
      const y = here.y + bob;
      const z = here.z + nz * side;

      dummy.position.set(x, y, z);
      dummy.rotation.y = Math.atan2(tx, tz);
      dummy.rotation.x = -0.07 - Math.sin(gait * 2) * 0.05; // 前かがみに、一歩ごとに頷く
      dummy.rotation.z = Math.sin(gait) * 0.1; // 左右の揺れ
      dummy.scale.setScalar(size);
      dummy.updateMatrix();
      bodies.setMatrixAt(i, dummy.matrix);

      // 衣は沈んだ色。歩調にあわせてわずかに明暗するだけ
      ember(color, 0.15 + 0.08 * (0.5 + 0.5 * Math.sin(gait)), hue);
      bodies.setColorAt(i, color);

      // 提灯は体の脇に提げ、歩調の半分の周期で前後に振れる
      const swing = Math.sin(gait * 0.5 + 0.8) * 0.24;
      dummy.position.set(
        x + nx * 0.44 * size + tx * swing,
        y + LANTERN_Y * size + Math.sin(gait * 0.5 + 1.1) * 0.06,
        z + nz * 0.44 * size + tz * swing,
      );
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(0.72 + size * 0.4);
      dummy.updateMatrix();
      lanterns.setMatrixAt(i, dummy.matrix);

      // 明度を上げすぎるとブルームで白く飛ぶので、琥珀の手前で止める
      const flick = 0.48 + 0.09 * Math.sin(t * 2.7 + oni[o + 4]! * 3.3);
      ember(color, flick, hue, 0.05);
      lanterns.setColorAt(i, color);
    }

    bodies.instanceMatrix.needsUpdate = true;
    lanterns.instanceMatrix.needsUpdate = true;
    if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
    if (lanterns.instanceColor) lanterns.instanceColor.needsUpdate = true;

    for (let k = 0; k < lamps.length; k++) {
      const lamp = lamps[k];
      if (!lamp) continue;
      roadAt(head + k / LAMPS, here);
      lamp.position.set(here.x, here.y + 1.2, here.z);
      lamp.intensity = 24 + Math.sin(t * 1.7 + k * 2.1) * 3;
    }
  },

  sound(t, _dt, sfx) {
    // 遠くの地鳴り。行列が続くあいだ途切れない
    sfx.drone(tone(-7), 0.05);

    const head = t / LAP;
    for (let i = 0; i < COUNT; i += SOUND_EVERY) {
      const tick = ticks[i];
      if (!tick) continue;
      // 位相が整数をまたぐ瞬間が、そのまま鳥居をくぐる瞬間になる
      for (let k = tick(head + oni[i * 5]! - GATE); k > 0; k--) {
        sfx.pluck(tone(9 + ((i / SOUND_EVERY) % 5)), {
          gain: 0.22,
          decay: 2.8,
          pan: (oni[i * 5 + 1]! / ROAD_W) * 0.6,
        });
      }
    }

    for (let k = tickWind(t * 0.16); k > 0; k--) {
      sfx.air({ gain: 0.15, decay: 3.6, freq: 520, q: 0.9, sweep: -0.4 });
    }
  },
};
