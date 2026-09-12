import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * Fluff Belt。
 *
 * やや高めの斜め横から見たベルトコンベア。平たいクッションがベルトの入口へ
 * ふわりと降りてきて着地し、潰れて戻りながら一定速度で流れていく。
 * 終点のローラーを越えると放物線を描いて右の箱へ落ち、暗がりへ沈んで消える。
 * ベルトは無端ループとして作ってあり、桟は上面を進んだあとローラーの曲面を
 * 回り込んで裏側を戻ってくる。ローラーの回転もベルト速度に同期している。
 *
 * 気持ちよさの芯は「着地でぷにっと潰れて戻る」反復と、等間隔で進む一定速度。
 */

// ---- ベルト ----
/** ローラー中心までの距離（ベルトの直線部の半分） */
const BELT_HALF = 6.5;
/** ローラーの半径。大きく露出させるほど「回っている機械」に見える */
const ROLLER_R = 1.5;
/** ローラー中心の高さ */
const ROLLER_Y = 3.4;
/** ベルトの幅（奥行き） */
const BELT_W = 4.2;
/** ベルト上面の高さ */
const BELT_TOP = ROLLER_Y + ROLLER_R;
/** ベルトが流れる速さ（単位/秒） */
const BELT_SPEED = 2.37;
/** ベルト表面の桟の数。細かく並べると網に見えるので粗くしてある */
const CLEAT_N = 18;

// ---- クッション ----
/** 同時に流れているクッションの数 */
const COUNT = 4;
/** 1 個分のライフサイクル（秒） */
const CYCLE = 7.3;
/** クッションの幅・厚み・奥行き */
const CUSHION_W = 3;
const CUSHION_H = 0.95;
const CUSHION_D = 3;
/** 立方体をどれだけ球へ寄せるか。上げすぎるとパンになり、座布団に見えなくなる */
const CUSHION_ROUND = 0.42;
/** ベルト上でのクッション中心の高さ */
const RIDE_Y = BELT_TOP + CUSHION_H / 2;

// ---- ライフサイクルの位相（0..1） ----
/** 上空から降りてきてベルトに着地するまで */
const P_LAND = 0.1;
/** ベルトを離れて落下し始める */
const P_LEAVE = 0.75;
/** 箱の底に届く */
const P_HIT = 0.88;
/** 投入時にどれだけ上から降りてくるか */
const DROP_IN_H = 2.8;
/** 落下で進む水平距離と落差 */
const FALL_DX = 2.8;
const FALL_DY = 4.2;

// ---- 受け箱 ----
const BOX_X = BELT_HALF + FALL_DX;
const BOX_SIZE = 5;
const BOX_H = 2.6;

const dummy = new THREE.Object3D();
const color = new THREE.Color();
const vec = new THREE.Vector3();

let cleats: THREE.InstancedMesh;
let cushions: THREE.InstancedMesh;
let rollerIn: THREE.Mesh;
let rollerOut: THREE.Mesh;

/** クッションごとの明度のばらつき（固定シードで散らす） */
const shades = new Float32Array(COUNT);
/** クッションごとの向きのばらつき */
const yaws = new Float32Array(COUNT);

let landTicks: ((phase: number) => number)[] = [];
let dropTicks: ((phase: number) => number)[] = [];

/** ベルトの周長。上下の直線 2 本と、両端のローラー半周ずつ。 */
const PATH_LEN = 4 * BELT_HALF + 2 * Math.PI * ROLLER_R;

/**
 * ベルト周上の距離 s から桟の位置を out に書き込み、板の傾き（Z 回転）を返す。
 * 上面 → 出口ローラー → 裏面 → 入口ローラー の順に一周する。
 */
function beltPose(s: number, out: THREE.Vector3): number {
  let u = s % PATH_LEN;
  if (u < 0) u += PATH_LEN;
  const straight = 2 * BELT_HALF;
  const arc = Math.PI * ROLLER_R;

  if (u < straight) {
    out.set(-BELT_HALF + u, BELT_TOP, 0);
    return 0;
  }
  u -= straight;
  if (u < arc) {
    const a = u / ROLLER_R;
    out.set(BELT_HALF + Math.sin(a) * ROLLER_R, ROLLER_Y + Math.cos(a) * ROLLER_R, 0);
    return -a;
  }
  u -= arc;
  if (u < straight) {
    out.set(BELT_HALF - u, ROLLER_Y - ROLLER_R, 0);
    return -Math.PI;
  }
  u -= straight;
  const a = Math.PI + u / ROLLER_R;
  out.set(-BELT_HALF + Math.sin(a) * ROLLER_R, ROLLER_Y + Math.cos(a) * ROLLER_R, 0);
  return -a;
}

/** 立方体の頂点を球へ寄せた、角の丸い座布団型。 */
function cushionGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const sphere = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).multiplyScalar(2);
    sphere.copy(v).normalize();
    v.lerp(sphere, CUSHION_ROUND).multiplyScalar(0.5);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

/** 受け箱。底と 4 枚の壁。落ちたクッションはこの内側の暗がりへ沈む。 */
function buildBox(): THREE.Group {
  const g = new THREE.Group();
  // 落下先が読めないと「終点で箱へ落ちる」が伝わらないので、少し明るい木箱にする
  const mat = new THREE.MeshStandardMaterial({
    color: emberColor(0.3, 0, -0.01),
    roughness: 0.6,
    metalness: 0.3,
  });
  const half = BOX_SIZE / 2;

  const floor = new THREE.Mesh(new THREE.BoxGeometry(BOX_SIZE, 0.2, BOX_SIZE), mat);
  floor.position.y = 0.1;
  g.add(floor);

  for (const sign of [-1, 1]) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(BOX_SIZE, BOX_H, 0.18), mat);
    side.position.set(0, BOX_H / 2, sign * half);
    g.add(side);
    const end = new THREE.Mesh(new THREE.BoxGeometry(0.18, BOX_H, BOX_SIZE), mat);
    end.position.set(sign * half, BOX_H / 2, 0);
    g.add(end);
  }
  g.position.x = BOX_X;
  return g;
}

export const fluffBelt: SceneModule = {
  name: 'Fluff Belt',
  desc: 'ふわふわのクッションがベルトに乗って流れ、終点で箱へ落ちていく。',
  camera: { pos: [9, 10, 21], target: [1.5, 4.2, 0] },

  build(root) {
    landTicks = tickers(COUNT);
    dropTicks = tickers(COUNT);

    // 固定シードで個体差を作る（開き直しても同じ絵になる）
    let s = 0.731;
    const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);
    for (let i = 0; i < COUNT; i++) {
      shades[i] = 0.56 + rnd() * 0.3;
      yaws[i] = (rnd() - 0.5) * 0.5;
    }

    // フレームと脚は暗く細く。本体の下を横切るので、目立たせるとシルエットを汚す
    const frameMat = new THREE.MeshStandardMaterial({
      color: emberColor(0.08, 0, -0.02),
      roughness: 0.6,
      metalness: 0.6,
    });

    // ベルトの中身。桟の隙間から向こう側が抜けないように詰めておく
    const core = new THREE.Mesh(
      new THREE.BoxGeometry(2 * BELT_HALF, 2 * ROLLER_R * 0.98, BELT_W * 0.94),
      new THREE.MeshStandardMaterial({
        color: emberColor(0.16, 0, -0.02),
        roughness: 0.92,
        metalness: 0.2,
      }),
    );
    core.position.y = ROLLER_Y;
    root.add(core);

    // ローラー。面が粗いほど回転が読み取れる
    const rollerGeo = new THREE.CylinderGeometry(ROLLER_R, ROLLER_R, BELT_W * 1.02, 14);
    const rollerMat = new THREE.MeshStandardMaterial({
      color: emberColor(0.24, 0, -0.02),
      roughness: 0.5,
      metalness: 0.6,
      flatShading: true,
    });
    rollerIn = new THREE.Mesh(rollerGeo, rollerMat);
    rollerIn.position.set(-BELT_HALF, ROLLER_Y, 0);
    root.add(rollerIn);
    rollerOut = new THREE.Mesh(rollerGeo, rollerMat);
    rollerOut.position.set(BELT_HALF, ROLLER_Y, 0);
    root.add(rollerOut);

    // 両脇のフレームと脚（ベルト上面より低いので、クッションを隠さない）
    for (const sign of [-1, 1]) {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(2 * (BELT_HALF + ROLLER_R), 0.16, 0.16),
        frameMat,
      );
      rail.position.set(0, ROLLER_Y, sign * (BELT_W / 2 + 0.2));
      root.add(rail);

      for (const sx of [-1, 1]) {
        const leg = new THREE.Mesh(
          new THREE.CylinderGeometry(0.13, 0.13, ROLLER_Y, 10),
          frameMat,
        );
        leg.position.set(sx * (BELT_HALF - 1.2), ROLLER_Y / 2, sign * (BELT_W / 2 + 0.2));
        root.add(leg);
      }
    }

    // ベルト表面の桟。上面を進み、ローラーを回り込んで裏を戻る
    // 桟は薄く広く。ベルト面からほとんど出さないとクッションの輪郭を切ってしまう
    const cleatGeo = new THREE.BoxGeometry(0.55, 0.09, BELT_W);
    cleatGeo.translate(0, 0.045, 0);
    cleats = new THREE.InstancedMesh(
      cleatGeo,
      // 暗いベルト地とのコントラストで、流れる縞として読ませる
      new THREE.MeshStandardMaterial({
        color: emberColor(0.42, 0, 0.02),
        roughness: 0.65,
        metalness: 0.45,
      }),
      CLEAT_N,
    );
    cleats.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(cleats);

    cushions = new THREE.InstancedMesh(
      cushionGeometry(),
      new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0.04 }),
      COUNT,
    );
    cushions.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(cushions);

    root.add(buildBox());

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(24, 96),
      // 磨きすぎるとライトの反射が床で光柱になり、主役より明るくなる
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.58, metalness: 0.45 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    root.add(floor);
  },

  update(t) {
    const hue = drift(t);
    const travel = t * BELT_SPEED;

    for (let i = 0; i < CLEAT_N; i++) {
      const tilt = beltPose(travel + (i / CLEAT_N) * PATH_LEN, vec);
      dummy.position.copy(vec);
      dummy.rotation.set(0, 0, tilt);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      cleats.setMatrixAt(i, dummy.matrix);
    }
    cleats.instanceMatrix.needsUpdate = true;

    // ローラーはベルト速度に同期して回す（上面が +X へ流れる向き）
    const spin = -travel / ROLLER_R;
    rollerIn.rotation.set(Math.PI / 2, spin, 0);
    rollerOut.rotation.set(Math.PI / 2, spin, 0);

    for (let i = 0; i < COUNT; i++) {
      const p = (t / CYCLE + i / COUNT) % 1;

      // x はベルトに乗っている間ずっと等速。降りてくる間も一緒に進む
      const run = Math.min(p, P_LEAVE) / P_LEAVE;
      let x = -BELT_HALF + run * 2 * BELT_HALF;
      let y = RIDE_Y;
      let visible = 1;
      let tumble = 0;

      if (p < P_LAND) {
        // 上空からふわりと降りてくる
        const d = 1 - p / P_LAND;
        y += DROP_IN_H * d * d;
      } else if (p > P_LEAVE) {
        // 終点を離れて放物線で箱へ
        const u = Math.min((p - P_LEAVE) / (P_HIT - P_LEAVE), 1.25);
        x = BELT_HALF + FALL_DX * u;
        y = RIDE_Y - FALL_DY * u * u;
        tumble = u * 0.45;
        // 箱の暗がりへ沈むように、着地の直前から縮めて消す
        visible = 1 - Math.max(0, (u - 0.86) / 0.24);
      }

      // 着地したあとのばね。潰れて戻るのを数回繰り返す
      let squash = 0;
      if (p >= P_LAND && p <= P_LEAVE) {
        const since = (p - P_LAND) * CYCLE;
        squash = Math.exp(-since * 4.2) * Math.cos(since * 13);
      }
      // ベルト上での呼吸とゆらぎ
      const breath = p >= P_LAND && p <= P_LEAVE ? Math.sin(t * 1.9 + i * 2.1) * 0.02 : 0;
      const sway = p >= P_LAND && p <= P_LEAVE ? Math.sin(t * 1.3 + i) * 0.05 : 0;
      const hover = p >= P_LAND && p <= P_LEAVE ? Math.sin(t * 2.2 + i * 1.7) * 0.05 : 0;

      const flat = Math.max(0, squash);
      const sy = (1 - flat * 0.42 + breath) * visible;
      const sxz = (1 + flat * 0.2 - breath * 0.5) * visible;

      dummy.position.set(x, y + hover - flat * CUSHION_H * 0.2, 0);
      dummy.rotation.order = 'YXZ';
      dummy.rotation.set(0, yaws[i], sway + tumble);
      dummy.scale.set(CUSHION_W * sxz, CUSHION_H * sy, CUSHION_D * sxz);
      dummy.updateMatrix();
      cushions.setMatrixAt(i, dummy.matrix);

      // 主役なので常に少し持ち上げ、潰れた瞬間にさらに明るくする
      ember(color, shades[i], hue, 0.06 + flat * 0.05);
      cushions.setColorAt(i, color);
    }
    cushions.instanceMatrix.needsUpdate = true;
    if (cushions.instanceColor) cushions.instanceColor.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    // モーターの薄い唸り
    sfx.drone(tone(-5), 0.022);

    for (let i = 0; i < COUNT; i++) {
      const ph = t / CYCLE + i / COUNT;
      for (let k = landTicks[i](ph - P_LAND); k > 0; k--) {
        sfx.air({ gain: 0.16, freq: 640, decay: 0.6, pan: -0.45 });
      }
      for (let k = dropTicks[i](ph - P_HIT); k > 0; k--) {
        sfx.drop(tone(2 + ((i * 2) % 5)), { gain: 0.3, decay: 0.8, bend: 0.7, pan: 0.45 });
      }
    }
  },
};
