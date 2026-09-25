import * as THREE from 'three';
import type { SceneModule } from '../../types.ts';
import { tone, ticker } from '../../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../../palette.ts';

/**
 * Wok Fried Rice。
 *
 * 火にかけた中華鍋が一定のリズムであおられ、山になったご飯が奥の壁から順に
 * ふわっと宙へ舞い上がり、弧を描いて鍋へ戻る。着地した粒は小さく跳ねて落ち着き、
 * また次のひとあおりを待つ。数十秒かけてご飯は淡い色からきつね色へ炒まり、また戻る。
 * 粒の着地点は「次の回の寝床」をハッシュで決めてあるので、あおるたびに山の顔ぶれが変わる。
 * カメラはコンロの正面やや上から。あおりの軸を画面の左右に取り、粒の弧を横から見せる。
 * 音は鍋を返すコツッという金属音と、着地のジャッという音、その下で鳴り続ける火の唸り。
 */

// ---- 調整する数値はここにまとめる ----------------------------------------

/** ご飯粒の数 */
const GRAINS = 900;
/** 具（焼豚の角切り）の数。ご飯より暗く、少し大きい */
const BITS = 36;

/** 鍋の球面の半径と、縁の半径（深さはこの 2 つで決まる） */
const BOWL_R = 4.6;
const RIM_R = 4.0;
/** 鍋の底の高さ */
const WOK_Y = 1.0;

/** ひとあおりの周期（秒） */
const PERIOD = 2.4;
/** 鍋が動いている区間（周期の先頭からの秒数） */
const SWING = 0.72;
/** 粒が鍋を離れる時刻（周期の先頭から）。奥の粒ほど早く離れる */
const LAUNCH = 0.36;
const LAUNCH_SPREAD = 0.3;
/** 滞空時間の範囲 */
const FLIGHT_MIN = 0.55;
const FLIGHT_MAX = 1.05;
/** 放物線の強さ（見た目用の重力） */
const GRAVITY = 26;
/** 宙で奥へ膨らむ量（あおりの「巻き」） */
const CURL = 1.3;
/** 宙で前後（z）へ散る量。塊のまま持ち上がって見えないように */
const SCATTER = 1.1;

/** ご飯の山の半径と高さ */
const PILE_R = 2.4;
const PILE_H = 0.9;

/** 鍋の押し引きの量と、奥の縁を持ち上げる角度 */
const PUSH = 0.9;
const TILT = 0.32;

/** 炒まり具合が一巡する秒数 */
const TOAST_PERIOD = 44;

/** コンロの火の数と輪の半径 */
const FLAMES = 12;
const FLAME_RING = 1.15;

// ---- ここまで ------------------------------------------------------------

const dummy = new THREE.Object3D();
const color = new THREE.Color();
const v = new THREE.Vector3();
const va = new THREE.Vector3();
const wokM = new THREE.Matrix4();
const restM = new THREE.Matrix4();
const pose = new THREE.Object3D();

let grains: THREE.InstancedMesh;
let bits: THREE.InstancedMesh;
let flames: THREE.InstancedMesh;
let wok: THREE.Group;

const TOTAL = GRAINS + BITS;
/** 粒ごとの [色のゆらぎ, 回転 x, 回転 y, 回し量, 滞空の係数] */
const props = new Float32Array(TOTAL * 5);

let tossTick = ticker();
let landTick = ticker();
let tosses = 0;

/** 固定シードの漸化式。build で 1 度だけ使う */
let seed = 0.731;
const rnd = (): number => (seed = (seed * 9301 + 0.49297) % 1);

/** 粒 i・回 c の寝床を決めるハッシュ。t から毎回同じ値が出る */
function hash(i: number, c: number, k: number): number {
  const x = Math.sin(i * 127.1 + c * 311.7 + k * 74.7) * 43758.5453;
  return x - Math.floor(x);
}

/** 鍋の内面の高さ（鍋ローカル、底が 0） */
function bowl(r: number): number {
  return BOWL_R - Math.sqrt(BOWL_R * BOWL_R - r * r);
}

/** 粒 i が回 c のあいだ寝ている位置（鍋ローカル） */
function rest(i: number, c: number, out: THREE.Vector3): THREE.Vector3 {
  const r = PILE_R * Math.sqrt(hash(i, c, 1));
  const a = hash(i, c, 2) * Math.PI * 2;
  const x = Math.cos(a) * r;
  const z = Math.sin(a) * r;
  const mound = PILE_H * (1 - (r / PILE_R) ** 2) * (0.35 + 0.65 * hash(i, c, 3));
  return out.set(x, bowl(r) + 0.06 + mound, z);
}

/** 周期内の時刻 tau での鍋の姿勢を行列に書く。SWING 以降は静止 */
function wokPose(tau: number, out: THREE.Matrix4): THREE.Matrix4 {
  const u = Math.min(Math.max(tau / SWING, 0), 1);
  // 奥へ押し出してから手前へ引き戻し、その引きで奥の縁が持ち上がる
  const push = -PUSH * Math.sin(Math.PI * u) * (1 - 1.6 * u);
  const lift = Math.sin(Math.PI * u) ** 2;
  pose.position.set(push, WOK_Y + 0.25 * lift, 0);
  pose.rotation.set(0, 0, -TILT * lift);
  pose.updateMatrix();
  return out.copy(pose.matrix);
}

/** 粒 i が鍋を離れる周期内の時刻 */
function launchAt(i: number, c: number): number {
  rest(i, c, v);
  // 奥（-x）の粒ほど早く跳ぶので、波が奥から手前へ抜けていく
  return LAUNCH + LAUNCH_SPREAD * ((v.x + PILE_R) / (2 * PILE_R));
}

export const wokFriedRice: SceneModule = {
  name: 'Wok Fried Rice',
  desc: '中華鍋をあおるたび、ご飯が奥から宙へ舞って弧を描き、ジャッと鍋へ戻る。',
  camera: { pos: [0, 10.5, 12], target: [0.4, 2.2, 0] },

  build(root) {
    tossTick = ticker();
    landTick = ticker();
    tosses = 0;

    seed = 0.731;
    for (let i = 0; i < TOTAL; i++) {
      props[i * 5] = rnd();
      props[i * 5 + 1] = rnd() * Math.PI * 2;
      props[i * 5 + 2] = rnd() * Math.PI * 2;
      props[i * 5 + 3] = (rnd() - 0.5) * 14;
      props[i * 5 + 4] = rnd();
    }

    // 床とコンロ
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(40, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.6, metalness: 0.5 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    root.add(floor);

    const stove = new THREE.Mesh(
      new THREE.CylinderGeometry(1.7, 1.9, 0.5, 48, 1, true),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.55, metalness: 0.6, side: THREE.DoubleSide }),
    );
    stove.position.y = 0.25;
    root.add(stove);

    const burner = new THREE.Mesh(
      new THREE.TorusGeometry(FLAME_RING, 0.12, 10, 48),
      new THREE.MeshStandardMaterial({ color: 0x2a1c18, roughness: 0.6, metalness: 0.7 }),
    );
    burner.rotation.x = Math.PI / 2;
    burner.position.y = 0.45;
    root.add(burner);

    const flameGeo = new THREE.ConeGeometry(0.09, 1, 8);
    flameGeo.translate(0, 0.5, 0);
    flames = new THREE.InstancedMesh(
      flameGeo,
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.6, depthWrite: false }),
      FLAMES,
    );
    flames.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(flames);

    // 中華鍋。球面の一部を旋盤で回し、縁に輪、右に柄を付ける
    wok = new THREE.Group();
    wok.matrixAutoUpdate = false;
    const profile: THREE.Vector2[] = [];
    for (let k = 0; k <= 32; k++) {
      const r = 0.001 + (RIM_R * k) / 32;
      profile.push(new THREE.Vector2(r, bowl(r)));
    }
    const wokMat = new THREE.MeshStandardMaterial({
      color: emberColor(0.08, 0, -0.04),
      roughness: 0.55,
      metalness: 0.6,
      side: THREE.DoubleSide,
    });
    wok.add(new THREE.Mesh(new THREE.LatheGeometry(profile, 72), wokMat));

    const rim = new THREE.Mesh(new THREE.TorusGeometry(RIM_R, 0.11, 10, 96), wokMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = bowl(RIM_R);
    wok.add(rim);

    const handle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.13, 0.17, 3.2, 16),
      new THREE.MeshStandardMaterial({ color: emberColor(0.18, 0, -0.05), roughness: 0.7, metalness: 0.1 }),
    );
    handle.rotation.z = Math.PI / 2 + 0.22;
    handle.position.set(RIM_R + 1.5, bowl(RIM_R) + 0.25, 0);
    wok.add(handle);
    root.add(wok);

    // ご飯粒と具
    grains = new THREE.InstancedMesh(
      new THREE.CapsuleGeometry(0.055, 0.12, 2, 6),
      new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 }),
      GRAINS,
    );
    grains.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(grains);

    bits = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.2, 0.16, 0.2),
      new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.05 }),
      BITS,
    );
    bits.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(bits);
  },

  update(t) {
    const c = Math.floor(t / PERIOD);
    const tau = t - c * PERIOD;
    const hue = drift(t);

    wok.matrix.copy(wokPose(tau, wokM));
    wok.matrixWorldNeedsUpdate = true;
    wokPose(SWING, restM); // 静止した鍋。着地点はこの姿勢で決める

    // 炒まり具合: 淡い色 → きつね色 → 淡い色
    const toast = 0.5 - 0.5 * Math.cos((t / TOAST_PERIOD) * Math.PI * 2);

    for (let i = 0; i < TOTAL; i++) {
      const p = i * 5;
      const tl = launchAt(i, c);
      const flight = FLIGHT_MIN + (FLIGHT_MAX - FLIGHT_MIN) * props[p + 4]!;
      let spin = 0;

      if (tau < tl) {
        // 前の回で着地した寝床に乗って、鍋と一緒に動く
        rest(i, c, v).applyMatrix4(wokM);
      } else if (tau < tl + flight) {
        const s = (tau - tl) / flight;
        wokPose(tl, dummy.matrix);
        const a = rest(i, c, va).applyMatrix4(dummy.matrix);
        const b = rest(i, c + 1, v).applyMatrix4(restM);
        const h = (GRAVITY * flight * flight) / 8;
        v.lerpVectors(a, b, s);
        v.y += 4 * h * s * (1 - s);
        v.x -= CURL * (0.5 + props[p]!) * Math.sin(Math.PI * s) * (1 - s) * 2;
        v.z += SCATTER * (props[p + 4]! - 0.5 + 0.6 * (hash(i, c, 4) - 0.5)) * Math.sin(Math.PI * s) * 2;
        spin = s;
      } else {
        // 着地して小さく跳ね、落ち着く
        const e = tau - tl - flight;
        rest(i, c + 1, v).applyMatrix4(wokM);
        v.y += 0.14 * Math.abs(Math.sin(e * 16)) * Math.exp(-e * 7);
        spin = 1;
      }

      dummy.position.copy(v);
      dummy.rotation.set(props[p + 1]! + (c + spin) * props[p + 3]!, props[p + 2]!, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();

      const k = props[p]!;
      if (i < GRAINS) {
        grains.setMatrixAt(i, dummy.matrix);
        // ご飯は明るい帯。ところどころ卵のように少し持ち上げる
        const egg = k > 0.86 ? 0.06 : 0;
        ember(color, 0.93 - 0.18 * toast + 0.05 * k, hue, -0.05 + egg);
        grains.setColorAt(i, color);
      } else {
        bits.setMatrixAt(i - GRAINS, dummy.matrix);
        ember(color, 0.28 + 0.1 * k, hue, -0.03);
        bits.setColorAt(i - GRAINS, color);
      }
    }
    grains.instanceMatrix.needsUpdate = true;
    bits.instanceMatrix.needsUpdate = true;
    if (grains.instanceColor) grains.instanceColor.needsUpdate = true;
    if (bits.instanceColor) bits.instanceColor.needsUpdate = true;

    // コンロの火。長さを少しずつずらして揺らす
    for (let i = 0; i < FLAMES; i++) {
      const a = (i / FLAMES) * Math.PI * 2;
      const f = 0.5 + 0.5 * Math.sin(t * 9 + i * 2.3) * Math.sin(t * 5.3 + i * 1.7);
      dummy.position.set(Math.cos(a) * FLAME_RING, 0.5, Math.sin(a) * FLAME_RING);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(0.8 + 0.5 * hash(i, 0, 6), (0.45 + 0.2 * f) * (0.8 + 0.4 * hash(i, 0, 5)), 1);
      dummy.updateMatrix();
      flames.setMatrixAt(i, dummy.matrix);
      ember(color, 0.45 + 0.15 * f, hue, -0.06);
      flames.setColorAt(i, color);
    }
    flames.instanceMatrix.needsUpdate = true;
    if (flames.instanceColor) flames.instanceColor.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    // 鍋を返す瞬間に金属の短い音
    for (let k = tossTick((t - LAUNCH) / PERIOD); k > 0; k--) {
      tosses++;
      sfx.pluck(tone(2 + (tosses % 3)), { gain: 0.16, decay: 0.5, pan: 0.25 });
    }
    // 着地のジャッ。高い帯域のノイズを下へ撫でる
    const land = LAUNCH + LAUNCH_SPREAD * 0.5 + (FLIGHT_MIN + FLIGHT_MAX) * 0.5;
    for (let k = landTick((t - land) / PERIOD); k > 0; k--) {
      sfx.air({ freq: 3200, q: 0.7, gain: 0.3, decay: 0.7, sweep: 0.55, pan: -0.1 });
    }
    sfx.drone(tone(-5), 0.05);
  },
};
