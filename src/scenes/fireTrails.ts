import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * Fire Trails。バック・トゥ・ザ・フューチャーの、時速 88 マイルで消える車と炎の轍。
 *
 * ステンレスのくさび形の車が閃光とともに道の端へ現れ、加速しながら走る。
 * 後輪が通ったところから路面に炎が点き、2 本の平行な線が車を追いかけて伸びる。
 * 車体のまわりに火花が走り、ぱっと光った瞬間に車は消え、炎の線だけが残る。
 * 炎は点いた順に燃え尽き、焦げ跡の赤みが引くと、また閃光から始まる。14 秒で一巡する。
 *
 * 気持ちよさの芯は、2 本の炎がぴたりと平行に伸びていくことと、消えた瞬間の空白、
 * そして点いた順に火が引いていく波。音は炎の低いうなりと、消える瞬間の沈む音。
 * 本物の稲妻は青いが、このシーンでは琥珀色の火花にしてある（青い光は使わない）。
 */

// --- 調整する数値 ----------------------------------------------------------

/** 1 ループの秒数 */
const PERIOD = 14;
/** 車が現れる時刻と位置（車体中心の x） */
const T_IN = 0.8;
const X_IN = -19;
/** 車が消える時刻と位置 */
const T_OUT = 7.2;
const X_OUT = 10;
/** 現れた瞬間の速さ（単位/秒）。そこから等加速度で X_OUT に着く */
const V0 = 1;
/** 等加速度。T_IN〜T_OUT で X_IN〜X_OUT を走り切るように決める */
const ACC = (2 * (X_OUT - X_IN - V0 * (T_OUT - T_IN))) / (T_OUT - T_IN) ** 2;

/** 炎が点き始める x（後輪がここを越えたところから燃える） */
const FIRE_X0 = -8;
/** 炎の間隔 */
const FIRE_STEP = 0.3;
/** 車体の拡大率 */
const CAR_SCALE = 1.5;
/** 後輪の車体中心からの x のずれと、左右の z（拡大前の寸法） */
const REAR_X = -1.35;
const WHEEL_Z = 0.8;
/** 車輪の半径（拡大前） */
const WHEEL_R = 0.44;
/** 炎の背丈と太さ */
const FLAME_H = 1.1;
const FLAME_R = 0.2;
/** 点いてから燃え尽き始めるまでの秒数と、燃え尽きるまでの秒数 */
const BURN = 3.0;
const FADE = 0.9;
/** 燃え尽きたあと焦げ跡の赤みが引くまでの秒数 */
const SCORCH = 2.2;

/** 消える前に火花が走り始めるまでの秒数 */
const SPARK_LEAD = 1.5;
/** 火花の本数と 1 本の折れ数 */
const ARCS = 10;
const ARC_SEGS = 6;

/** 閃光の大きさと、光が引くまでの秒数 */
const FLASH_R = 3.2;
const FLASH_T = 0.55;

/** 道の長さと幅 */
const ROAD_LEN = 80;
const ROAD_W = 7;

// --------------------------------------------------------------------------

/** 片側の炎の数 */
const FLAMES = Math.floor((X_OUT + REAR_X * CAR_SCALE - FIRE_X0) / FIRE_STEP) + 1;

const dummy = new THREE.Object3D();
const color = new THREE.Color();

let car: THREE.Group;
let flames: THREE.InstancedMesh;
let scorch: THREE.InstancedMesh;
let sparks: THREE.LineSegments;
let sparkPos: Float32Array;
let flash: THREE.Mesh;
let flashMat: THREE.MeshBasicMaterial;
let ring: THREE.Mesh;
let ringMat: THREE.MeshBasicMaterial;
/** 炎ごとの点火時刻（ループ内の秒）。build で一度だけ決める */
let ignite: Float32Array;
/** 炎ごとのゆらぎの位相と、背丈のばらつき */
let phase: Float32Array;
let tall: Float32Array;

let tickIn = ticker();
let tickOut = ticker();
/** 炎のうなりの大きさ。update が書き、sound が読む（映像へは影響しない） */
let roar = 0;

const smooth = (a: number, b: number, x: number): number => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/** ループ内の時刻 u での車体中心の x。走っていない間は NaN */
function carX(u: number): number {
  if (u < T_IN || u >= T_OUT) return NaN;
  const s = u - T_IN;
  return X_IN + V0 * s + 0.5 * ACC * s * s;
}

/** 車体中心が x を通過する時刻 */
function timeAt(x: number): number {
  const d = x - X_IN;
  return T_IN + (-V0 + Math.sqrt(V0 * V0 + 2 * ACC * d)) / ACC;
}

/** 固定シードの乱数。火花の形はフレーム番号から毎回同じものを作り直す */
function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** くさび形の車体。前が +x */
function buildCar(): THREE.Group {
  const g = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0xe8e5e2, roughness: 0.36, metalness: 0.45 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x120a09, roughness: 0.12, metalness: 0.6 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x0c0808, roughness: 0.85 });

  const extrude = (pts: [number, number][], w: number, mat: THREE.Material): THREE.Mesh => {
    const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: w,
      bevelEnabled: true,
      bevelSize: 0.04,
      bevelThickness: 0.04,
      bevelSegments: 1,
    });
    geo.translate(0, 0, -w / 2);
    return new THREE.Mesh(geo, mat);
  };

  // 下半身: 低く長いくさび
  g.add(
    extrude(
      [[-2.1, 0.36], [2.05, 0.36], [2.15, 0.5], [2.1, 0.62], [0.6, 0.8], [-2.1, 0.9]],
      1.84,
      steel,
    ),
  );
  // 屋根まわり: 暗いガラスの箱に、ステンレスの屋根板を載せる
  g.add(
    extrude(
      [[0.6, 0.78], [-0.25, 1.26], [-1.25, 1.26], [-2.0, 0.92], [-2.0, 0.8]],
      1.5,
      glass,
    ),
  );
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.05, 1.52), steel);
  roof.position.set(-0.75, 1.31, 0);
  g.add(roof);

  // 尾灯と前照灯。尾灯だけ少し光らせる
  const tail = new THREE.MeshBasicMaterial({ color: emberColor(0.36, 0, 0.08) });
  const head = new THREE.MeshBasicMaterial({ color: emberColor(0.95, 0, 0.12) });
  for (const z of [-0.62, 0.62]) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.5), tail);
    t.position.set(-2.16, 0.74, z);
    g.add(t);
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.34), head);
    h.position.set(2.15, 0.52, z);
    g.add(h);
  }

  // 車輪は車体の下からはっきりはみ出す大きさにして、銀のホイールキャップで輪だと分からせる
  const wheel = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.32, 24);
  wheel.rotateX(Math.PI / 2);
  const cap = new THREE.CylinderGeometry(WHEEL_R * 0.6, WHEEL_R * 0.6, 0.34, 20);
  cap.rotateX(Math.PI / 2);
  for (const x of [REAR_X, 1.35]) {
    for (const z of [-WHEEL_Z, WHEEL_Z]) {
      const w = new THREE.Mesh(wheel, rubber);
      w.position.set(x, WHEEL_R, z);
      g.add(w);
      const c = new THREE.Mesh(cap, steel);
      c.position.set(x, WHEEL_R, z);
      g.add(c);
    }
  }
  return g;
}

export const fireTrails: SceneModule = {
  name: 'Fire Trails',
  desc: '加速した車が閃光とともに消え、路面に 2 本の炎の轍だけが残って、点いた順に燃え尽きる。',
  camera: { pos: [-3, 6.5, 14.5], target: [1, 0.8, 0] },

  build(root) {
    tickIn = ticker();
    tickOut = ticker();
    roar = 0;

    // 地面と道。金属質の床に炎が映り込む
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(ROAD_LEN * 2, 160),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.55, metalness: 0.6 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    root.add(ground);

    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(ROAD_LEN, ROAD_W),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.3, metalness: 0.85 }),
    );
    road.rotation.x = -Math.PI / 2;
    root.add(road);

    // 路肩の線と中央の破線。暗い色で道だと分かる程度に
    const lineMat = new THREE.MeshStandardMaterial({ color: emberColor(0.55, 0, -0.28), roughness: 0.6 });
    for (const z of [-ROAD_W / 2 + 0.3, ROAD_W / 2 - 0.3]) {
      const edge = new THREE.Mesh(new THREE.BoxGeometry(ROAD_LEN, 0.01, 0.1), lineMat);
      edge.position.set(0, 0.005, z);
      root.add(edge);
    }
    const dashes = Math.floor(ROAD_LEN / 3);
    const dash = new THREE.InstancedMesh(new THREE.BoxGeometry(1.4, 0.01, 0.1), lineMat, dashes);
    for (let i = 0; i < dashes; i++) {
      dummy.position.set(-ROAD_LEN / 2 + 1.5 + i * 3, 0.005, 0);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      dash.setMatrixAt(i, dummy.matrix);
    }
    root.add(dash);

    car = buildCar();
    car.scale.setScalar(CAR_SCALE);
    root.add(car);

    // 炎: 底を原点にした円錐を、Y スケールだけで伸び縮みさせる
    // 炎: 根元がふくらみ先が細い涙形。根元を明るく、先へ向かって暗く落とす
    const drop = new THREE.LatheGeometry(
      [[0, 0], [0.7, 0.07], [1, 0.2], [0.85, 0.4], [0.5, 0.66], [0.2, 0.87], [0, 1]].map(
        ([r, y]) => new THREE.Vector2(r * FLAME_R, y),
      ),
      8,
    );
    const ys = drop.getAttribute('position');
    const shade = new Float32Array(ys.count * 3);
    for (let i = 0; i < ys.count; i++) {
      const k = 1 - 0.7 * ys.getY(i);
      shade.set([k, k * 0.85, k * 0.8], i * 3);
    }
    drop.setAttribute('color', new THREE.BufferAttribute(shade, 3));
    flames = new THREE.InstancedMesh(
      drop,
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.92 }),
      FLAMES * 2,
    );
    flames.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    flames.frustumCulled = false;
    root.add(flames);

    // 焦げ跡: 路面に貼りつく細い板。燃えている間は明るく、消えたあと赤みが引く
    scorch = new THREE.InstancedMesh(
      new THREE.BoxGeometry(FIRE_STEP * 1.05, 0.012, 0.16),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      FLAMES * 2,
    );
    scorch.frustumCulled = false;
    root.add(scorch);

    ignite = new Float32Array(FLAMES);
    phase = new Float32Array(FLAMES * 2);
    let s = 0.731;
    const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);
    for (let i = 0; i < FLAMES; i++) {
      ignite[i] = timeAt(FIRE_X0 + i * FIRE_STEP - REAR_X * CAR_SCALE);
    }
    tall = new Float32Array(FLAMES * 2);
    for (let i = 0; i < FLAMES * 2; i++) {
      phase[i] = rnd() * Math.PI * 2;
      tall[i] = 0.55 + rnd() * 0.75;
    }

    // 動かない焦げ跡の位置は build で決めてしまう
    for (let side = 0; side < 2; side++) {
      for (let i = 0; i < FLAMES; i++) {
        dummy.position.set(FIRE_X0 + i * FIRE_STEP, 0.008, (side ? WHEEL_Z : -WHEEL_Z) * CAR_SCALE);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        scorch.setMatrixAt(side * FLAMES + i, dummy.matrix);
        scorch.setColorAt(side * FLAMES + i, color.setRGB(0, 0, 0));
      }
    }

    // 火花: 車体のまわりを走る折れ線。頂点は毎フレーム作り直す
    sparkPos = new Float32Array(ARCS * ARC_SEGS * 2 * 3);
    const sparkGeo = new THREE.BufferGeometry();
    sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3).setUsage(THREE.DynamicDrawUsage));
    sparks = new THREE.LineSegments(
      sparkGeo,
      new THREE.LineBasicMaterial({
        color: emberColor(0.82, 0, 0.02),
        transparent: true,
        opacity: 0.6,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    sparks.frustumCulled = false;
    root.add(sparks);

    // 閃光と、路面を走る輪
    flashMat = new THREE.MeshBasicMaterial({
      color: emberColor(1, 0, 0.25),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    flash = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), flashMat);
    root.add(flash);

    ringMat = new THREE.MeshBasicMaterial({
      color: emberColor(0.75, 0.02, 0.05),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 64), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    root.add(ring);
  },

  update(t) {
    const u = ((t % PERIOD) + PERIOD) % PERIOD;
    const hue = drift(t);

    // --- 車 ---
    const cx = carX(u);
    car.visible = Number.isFinite(cx);
    if (car.visible) car.position.set(cx, 0, 0);

    // --- 炎と焦げ跡 ---
    let total = 0;
    for (let side = 0; side < 2; side++) {
      const z = (side ? WHEEL_Z : -WHEEL_Z) * CAR_SCALE;
      for (let i = 0; i < FLAMES; i++) {
        const k = side * FLAMES + i;
        const age = u - ignite[i];
        // 点いてすぐ背伸びし、BURN 秒で縮み始め、FADE 秒で消える
        const life = age < 0 ? 0 : smooth(0, 0.12, age) * (1 - smooth(BURN, BURN + FADE, age));
        // 点きたては背が高く、時間が経つほど低くなる（車に近いほど高い炎になる）
        const surge = (1 + 0.7 * Math.exp(-Math.max(0, age) * 1.8)) * (1 - 0.4 * smooth(0, BURN, age));
        const p = phase[k];
        const flick = 0.72 + 0.28 * Math.sin(t * 17 + p) * Math.sin(t * 11.3 + p * 1.7);
        const h = FLAME_H * tall[k] * life * surge * flick;
        total += life;

        dummy.position.set(FIRE_X0 + (i + (tall[k] - 0.9) * 0.6) * FIRE_STEP, 0, z + Math.sin(t * 9 + p) * 0.04 * life);
        dummy.rotation.set(0, p, Math.sin(t * 6 + p) * 0.08);
        const w = life > 0.001 ? 0.7 + 0.3 * life : 0;
        dummy.scale.set(w, Math.max(h, 0.0001), w);
        dummy.updateMatrix();
        flames.setMatrixAt(k, dummy.matrix);
        ember(color, 0.6 + 0.3 * flick * Math.min(1, surge - 0.4), hue);
        flames.setColorAt(k, color);

        // 焦げ跡: 燃えている間は明るく、燃え尽きたあと SCORCH 秒で暗くなる
        const heat =
          age < 0 ? 0 : life > 0.02 ? 0.6 + 0.4 * life : Math.max(0, 1 - (age - BURN - FADE) / SCORCH) * 0.6;
        if (heat > 0) ember(color, 0.15 + 0.5 * heat, hue, -0.08 + 0.2 * heat).multiplyScalar(heat);
        else color.setRGB(0, 0, 0);
        scorch.setColorAt(k, color);
      }
    }
    flames.instanceMatrix.needsUpdate = true;
    if (flames.instanceColor) flames.instanceColor.needsUpdate = true;
    if (scorch.instanceColor) scorch.instanceColor.needsUpdate = true;
    roar = total / (FLAMES * 2);

    // --- 火花: 消える直前に増えていき、現れた直後にも少しだけ ---
    let arcs = 0;
    if (car.visible) {
      const pre = smooth(T_OUT - SPARK_LEAD, T_OUT, u);
      const post = 1 - smooth(T_IN, T_IN + 0.7, u);
      arcs = Math.ceil(Math.max(pre, post * 0.5) * ARCS);
    }
    const frame = Math.floor(t * 24);
    let v = 0;
    for (let a = 0; a < arcs; a++) {
      const seed = frame * 31 + a * 7;
      // 車体のまわりの楕円上の 2 点を、ぎざぎざに結ぶ
      const a0 = hash(seed) * Math.PI * 2;
      const a1 = a0 + (hash(seed + 1) - 0.5) * 1.2;
      const y0 = 0.3 + hash(seed + 2) * 1.1;
      const y1 = 0.3 + hash(seed + 3) * 1.1;
      const ex = 2.25 * CAR_SCALE;
      const ez = 1.05 * CAR_SCALE;
      const ey = CAR_SCALE;
      let px = cx + Math.cos(a0) * ex;
      let py = y0 * ey;
      let pz = Math.sin(a0) * ez;
      for (let sgi = 1; sgi <= ARC_SEGS; sgi++) {
        const f = sgi / ARC_SEGS;
        const ang = a0 + (a1 - a0) * f;
        const j = sgi === ARC_SEGS ? 0 : 0.3;
        const nx = cx + Math.cos(ang) * ex + (hash(seed + sgi * 5) - 0.5) * j;
        const ny = (y0 + (y1 - y0) * f) * ey + (hash(seed + sgi * 5 + 1) - 0.5) * j;
        const nz = Math.sin(ang) * ez + (hash(seed + sgi * 5 + 2) - 0.5) * j;
        sparkPos.set([px, py, pz, nx, ny, nz], v * 3);
        v += 2;
        px = nx;
        py = ny;
        pz = nz;
      }
    }
    sparks.geometry.setDrawRange(0, v);
    (sparks.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;

    // --- 閃光: 現れる瞬間は小さく、消える瞬間は大きく ---
    const dOut = u - T_OUT;
    const dIn = u - T_IN;
    let fx = 0;
    let fs = 0;
    let fo = 0;
    if (dOut >= 0 && dOut < FLASH_T) {
      const k = dOut / FLASH_T;
      fx = X_OUT;
      fs = FLASH_R * (0.4 + 0.6 * Math.sqrt(k));
      fo = (1 - k) ** 2 * 0.9;
    } else if (dIn >= -0.15 && dIn < FLASH_T) {
      const k = Math.max(0, dIn) / FLASH_T;
      fx = X_IN;
      fs = FLASH_R * 0.6 * (0.4 + 0.6 * Math.sqrt(k));
      fo = (1 - k) ** 2 * 0.7 * smooth(-0.15, 0, dIn);
    }
    flash.visible = fo > 0.002;
    flash.position.set(fx, 0.8 * CAR_SCALE, 0);
    flash.scale.setScalar(Math.max(fs, 0.001));
    flashMat.opacity = fo;

    // 消えた瞬間だけ、路面を輪が広がる
    const rk = dOut / 0.9;
    ring.visible = rk >= 0 && rk < 1;
    if (ring.visible) {
      ring.position.x = X_OUT;
      ring.scale.setScalar(0.5 + rk * 4.5);
      ringMat.opacity = (1 - rk) ** 2 * 0.5;
    }
  },

  sound(t, _dt, sfx) {
    // 現れる瞬間: 風を切る音
    for (let k = tickIn((t - T_IN) / PERIOD); k > 0; k--) {
      sfx.air({ gain: 0.35, decay: 1.4, freq: 900, q: 1.2, pan: -0.5 });
    }
    // 消える瞬間: 沈む音と、高い弦を 2 つ
    for (let k = tickOut((t - T_OUT) / PERIOD); k > 0; k--) {
      sfx.drop(tone(3), { gain: 0.55, decay: 1.6, bend: 0.4, pan: 0.3 });
      sfx.pluck(tone(12), { gain: 0.25, decay: 2.6, pan: 0.35 });
      sfx.pluck(tone(16), { gain: 0.18, decay: 3.2, pan: 0.2 });
    }
    // 炎が燃えている間だけ、低いうなり
    sfx.drone(roar > 0.01 ? tone(0) : null, Math.min(0.2, roar * 0.4));
  },
};
