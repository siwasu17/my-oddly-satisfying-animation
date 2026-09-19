import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * Fluff Belt。
 *
 * 高さの違う 3 本のベルトコンベアを、平面で見て「コ」の字に組んだ搬送路。
 * 最上段は右から左へ、中段は奥から手前へ、最下段は左から右へ流れる。
 * 段が変わるたびに進行方向が 90 度折れるので、どこを運ばれているのかが
 * 一目で追えて、同時に 3 本が奥行きの違う位置に並ぶ。
 *
 * 平たいクッションが最上段の入口へふわりと降りてきて着地し、潰れて戻り
 * ながら一定速度で流れる。終点を越えるとそのままの向きに放り出され、
 * 放物線を描いて 1 つ下の段へ落ちる。落ちながら次の段の向きへ body を
 * 回し、着地でまた潰れる。3 段下りきると最後は箱へ落ちて暗がりへ沈む。
 *
 * ベルトは無端ループとして作ってあり、桟は上面を進んだあとローラーの曲面を
 * 回り込んで裏側を戻ってくる。ローラーの回転もベルト速度に同期している。
 *
 * 気持ちよさの芯は「着地でぷにっと潰れて戻る」反復と、コの字を折り返しながら
 * 下りていく見通しの良さ。落下は重力加速だけで決めてあるので、着地点は必ず
 * 次の段に乗る。
 */

// ---- ベルト 1 本ぶんの寸法 ----
/** ローラー中心までの距離（ベルトの直線部の半分） */
const BELT_HALF = 6;
/** ローラーの半径。大きく露出させるほど「回っている機械」に見える */
const ROLLER_R = 1.1;
/** ベルトの幅 */
const BELT_W = 3.4;
/** ベルトが流れる速さ（単位/秒） */
const BELT_SPEED = 2.37;
/** ベルト 1 本あたりの桟の数。細かく並べると網に見えるので粗くしてある */
const CLEAT_N = 16;

// ---- 段の積み方 ----
/**
 * 段ごとの進行方向（x, z）。平面で見て「コ」の字を描く。
 * カメラは +z 側（手前）から見ているので、+z が手前、-z が奥。
 */
const DIRS: readonly (readonly [number, number])[] = [
  [-1, 0], // 最上段: 右から左へ
  [0, 1], //  中段: 奥から手前へ
  [1, 0], //  最下段: 左から右へ
];
const TIERS_N = DIRS.length;
/** 最下段のローラー中心の高さ */
const BASE_Y = 2.6;
/** 段どうしの高低差。クッションの落差そのもの */
const TIER_GAP = 3.6;
/** 落下の重力。弱いほど放物線が伸び、ふわふわした落ち方になる */
const GRAV = 5.5;
/** 段から段への落下にかかる時間。TIER_GAP をちょうど落ちきる長さ */
const FALL_T = Math.sqrt((2 * TIER_GAP) / GRAV);
/** その間に進む水平距離。次の段はこれだけ先に置く */
const FALL_DX = BELT_SPEED * FALL_T;
/** 次の段の端から、どれだけ内側に着地させるか */
const LAND_MARGIN = 0.9;

// ---- クッション ----
/** 同時に流れているクッションの数 */
const COUNT = 12;
/** クッションの幅・厚み・奥行き */
const CUSHION_W = 2;
const CUSHION_H = 0.7;
const CUSHION_D = 2;
/** 立方体をどれだけ球へ寄せるか。上げすぎるとパンになり、座布団に見えなくなる */
const CUSHION_ROUND = 0.42;
/** 投入時にどれだけ上から降りてくるか、その所要時間 */
const DROP_IN_H = 2.6;
const DROP_IN_T = 1;

/** 最下段でクッションが乗っている高さ */
const BOTTOM_RIDE_Y = BASE_Y + ROLLER_R + CUSHION_H / 2;
/** 箱に届くまでの落下時間。底の少し上まで落ちたら沈めて消す */
const BOX_FALL_T = Math.sqrt((2 * (BOTTOM_RIDE_Y - 1)) / GRAV);
const BOX_SIZE = 4.4;
const BOX_H = 2.2;

/** 1 段ぶんの諸元。ベルトの向き・位置と、その段に乗っている時間。 */
interface Tier {
  /** 進行方向（単位ベクトル） */
  dx: number;
  dz: number;
  /** その向きへ向けるための Y 回転 */
  ry: number;
  /** 次の段へ向き直るときの回転量（最下段は 0） */
  turn: number;
  /** ベルト中心の座標（高さはローラー中心） */
  cx: number;
  cy: number;
  cz: number;
  /** ベルトに乗っているクッション中心の高さ */
  rideY: number;
  /** 乗り始め・降り際の平面座標 */
  entryX: number;
  entryZ: number;
  exitX: number;
  exitZ: number;
  /** ライフサイクル中、この段に乗っている区間（秒） */
  start: number;
  end: number;
  /** その段で鳴らす音の定位 */
  pan: number;
}

/** -PI..PI に畳んだ角度差。段をまたぐときの回転を最短で回すのに使う。 */
function wrapPi(a: number): number {
  return a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
}

/**
 * コの字の搬送路を組み立てる。
 *
 * 各段は「前の段の終点から、その段の向きへ FALL_DX だけ放り出された点」に
 * 着地するように置く。落下は前の段の進行方向をそのまま延長するだけなので、
 * 段の向きが 90 度折れても着地点の計算は 1 本の式で済む。
 * 最後に全体を原点まわりへ寄せて、カメラの真ん中に収まるようにする。
 */
function buildTiers(): { tiers: Tier[]; boxX: number; boxZ: number } {
  const tiers: Tier[] = [];
  // 「クッションが乗り始める点」を段から段へ引き継いでいく
  let ex = 0;
  let ez = 0;
  let clock = 0;

  for (let k = 0; k < TIERS_N; k++) {
    const [dx, dz] = DIRS[k]!;
    // 2 段目以降は端より内側に着地するので、ベルトの始端はその分だけ手前
    const margin = k === 0 ? 0 : LAND_MARGIN;
    const sx = ex - dx * margin;
    const sz = ez - dz * margin;
    const exitX = sx + dx * 2 * BELT_HALF;
    const exitZ = sz + dz * 2 * BELT_HALF;
    const cy = BASE_Y + (TIERS_N - 1 - k) * TIER_GAP;
    const start = clock;
    clock += (2 * BELT_HALF - margin) / BELT_SPEED;

    tiers.push({
      dx,
      dz,
      // ローカルの +X をこの向きへ倒す角度
      ry: Math.atan2(-dz, dx),
      turn: 0,
      cx: sx + dx * BELT_HALF,
      cy,
      cz: sz + dz * BELT_HALF,
      rideY: cy + ROLLER_R + CUSHION_H / 2,
      entryX: ex,
      entryZ: ez,
      exitX,
      exitZ,
      start,
      end: clock,
      pan: 0,
    });

    if (k < TIERS_N - 1) clock += FALL_T;
    ex = exitX + dx * FALL_DX;
    ez = exitZ + dz * FALL_DX;
  }

  // 最下段を出たあとは箱へ。落下時間が段間とは違うので別に出す
  const last = tiers[TIERS_N - 1]!;
  let boxX = last.exitX + last.dx * BELT_SPEED * BOX_FALL_T;
  let boxZ = last.exitZ + last.dz * BELT_SPEED * BOX_FALL_T;

  // 全体の外接矩形を測って原点へ寄せる
  let minX = boxX - BOX_SIZE / 2;
  let maxX = boxX + BOX_SIZE / 2;
  let minZ = boxZ - BOX_SIZE / 2;
  let maxZ = boxZ + BOX_SIZE / 2;
  for (const t of tiers) {
    const halfX = Math.abs(t.dx) * (BELT_HALF + ROLLER_R) + Math.abs(t.dz) * (BELT_W / 2);
    const halfZ = Math.abs(t.dz) * (BELT_HALF + ROLLER_R) + Math.abs(t.dx) * (BELT_W / 2);
    minX = Math.min(minX, t.cx - halfX);
    maxX = Math.max(maxX, t.cx + halfX);
    minZ = Math.min(minZ, t.cz - halfZ);
    maxZ = Math.max(maxZ, t.cz + halfZ);
  }
  const ox = -(minX + maxX) / 2;
  const oz = -(minZ + maxZ) / 2;
  for (const t of tiers) {
    t.cx += ox;
    t.cz += oz;
    t.entryX += ox;
    t.entryZ += oz;
    t.exitX += ox;
    t.exitZ += oz;
    // 定位は段の中心の左右で決める
    t.pan = Math.max(-1, Math.min(1, t.cx / (maxX + ox))) * 0.4;
  }
  boxX += ox;
  boxZ += oz;

  // 落下中に次の段の向きへ回り込むための角度
  for (let k = 0; k < TIERS_N - 1; k++) {
    tiers[k]!.turn = wrapPi(tiers[k + 1]!.ry - tiers[k]!.ry);
  }

  return { tiers, boxX, boxZ };
}

const { tiers: TIERS, boxX: BOX_X, boxZ: BOX_Z } = buildTiers();
const LAST = TIERS[TIERS_N - 1]!;

/** 1 個分のライフサイクル（秒）。最後の落下と沈み込みまで含める */
const CYCLE = LAST.end + BOX_FALL_T + 0.45;

const dummy = new THREE.Object3D();
const color = new THREE.Color();
const vec = new THREE.Vector3();

let tierCleats: THREE.InstancedMesh[] = [];
let rollers: THREE.Mesh[] = [];
let cushions: THREE.InstancedMesh;

/** クッションごとの明度のばらつき（固定シードで散らす） */
const shades = new Float32Array(COUNT);
/** クッションごとの向きのばらつき */
const yaws = new Float32Array(COUNT);

/** 段ごとの着地音 */
let landTicks: ((phase: number) => number)[][] = [];
/** 箱へ落ちたときの音 */
let dropTicks: ((phase: number) => number)[] = [];

/** ベルトの周長。上下の直線 2 本と、両端のローラー半周ずつ。 */
const PATH_LEN = 4 * BELT_HALF + 2 * Math.PI * ROLLER_R;

/**
 * ベルト周上の距離 s から桟の位置を out に書き込み、板の傾き（Z 回転）を返す。
 * 座標は段のローカル系（ローラー中心が原点、上面が +X へ流れる）。
 * 上面 → 出口ローラー → 裏面 → 入口ローラー の順に一周する。
 */
function beltPose(s: number, out: THREE.Vector3): number {
  let u = s % PATH_LEN;
  if (u < 0) u += PATH_LEN;
  const straight = 2 * BELT_HALF;
  const arc = Math.PI * ROLLER_R;

  if (u < straight) {
    out.set(-BELT_HALF + u, ROLLER_R, 0);
    return 0;
  }
  u -= straight;
  if (u < arc) {
    const a = u / ROLLER_R;
    out.set(BELT_HALF + Math.sin(a) * ROLLER_R, Math.cos(a) * ROLLER_R, 0);
    return -a;
  }
  u -= arc;
  if (u < straight) {
    out.set(BELT_HALF - u, -ROLLER_R, 0);
    return -Math.PI;
  }
  u -= straight;
  const a = Math.PI + u / ROLLER_R;
  out.set(-BELT_HALF + Math.sin(a) * ROLLER_R, Math.cos(a) * ROLLER_R, 0);
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

/** 段を組むのに使う材質一式。3 段で使い回す。 */
interface BeltMats {
  frame: THREE.Material;
  core: THREE.Material;
  roller: THREE.Material;
  cleat: THREE.Material;
}

/**
 * 段 1 本ぶんのベルト。原点をローラー中心に置いたローカル系で組み、
 * グループごと Y 回転で進行方向へ倒す。こうしておくと桟とローラーの
 * 計算が 3 段とも同じ式で済む。
 */
function buildTier(tier: Tier, cleatGeo: THREE.BufferGeometry, mats: BeltMats): THREE.Group {
  const g = new THREE.Group();
  g.position.set(tier.cx, tier.cy, tier.cz);
  g.rotation.y = tier.ry;

  // ベルトの中身。桟の隙間から向こう側が抜けないように詰めておく
  const core = new THREE.Mesh(
    new THREE.BoxGeometry(2 * BELT_HALF, 2 * ROLLER_R * 0.98, BELT_W * 0.94),
    mats.core,
  );
  g.add(core);

  // ローラー。面が粗いほど回転が読み取れる
  const rollerGeo = new THREE.CylinderGeometry(ROLLER_R, ROLLER_R, BELT_W * 1.02, 14);
  for (const sx of [-1, 1]) {
    const r = new THREE.Mesh(rollerGeo, mats.roller);
    r.position.x = sx * BELT_HALF;
    g.add(r);
    rollers.push(r);
  }

  // 両脇のフレーム。脚は付けない（段が空中に浮いているほうが経路が読める）
  for (const sz of [-1, 1]) {
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(2 * (BELT_HALF + ROLLER_R), 0.16, 0.16),
      mats.frame,
    );
    rail.position.z = sz * (BELT_W / 2 + 0.2);
    g.add(rail);
  }

  const cleats = new THREE.InstancedMesh(cleatGeo, mats.cleat, CLEAT_N);
  cleats.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  g.add(cleats);
  tierCleats.push(cleats);

  return g;
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
  g.position.set(BOX_X, 0, BOX_Z);
  return g;
}

export const fluffBelt: SceneModule = {
  name: 'Fluff Belt',
  desc: 'ふわふわのクッションがコの字に組んだ 3 段のベルトを下り、箱へ落ちていく。',
  camera: { pos: [13, 19.5, 19.5], target: [0, 6, 0] },

  build(root) {
    tierCleats = [];
    rollers = [];
    landTicks = TIERS.map(() => tickers(COUNT));
    dropTicks = tickers(COUNT);

    // 固定シードで個体差を作る（開き直しても同じ絵になる）
    let s = 0.731;
    const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);
    for (let i = 0; i < COUNT; i++) {
      shades[i] = 0.56 + rnd() * 0.3;
      yaws[i] = (rnd() - 0.5) * 0.5;
    }

    // 桟は薄く広く。ベルト面からほとんど出さないとクッションの輪郭を切ってしまう
    const cleatGeo = new THREE.BoxGeometry(0.55, 0.09, BELT_W);
    cleatGeo.translate(0, 0.045, 0);

    const mats: BeltMats = {
      // フレームは暗く細く。目立たせるとクッションのシルエットを汚す
      frame: new THREE.MeshStandardMaterial({
        color: emberColor(0.08, 0, -0.02),
        roughness: 0.6,
        metalness: 0.6,
      }),
      core: new THREE.MeshStandardMaterial({
        color: emberColor(0.16, 0, -0.02),
        roughness: 0.92,
        metalness: 0.2,
      }),
      roller: new THREE.MeshStandardMaterial({
        color: emberColor(0.24, 0, -0.02),
        roughness: 0.5,
        metalness: 0.6,
        flatShading: true,
      }),
      // 暗いベルト地とのコントラストで、流れる縞として読ませる
      cleat: new THREE.MeshStandardMaterial({
        color: emberColor(0.42, 0, 0.02),
        roughness: 0.65,
        metalness: 0.45,
      }),
    };

    for (const tier of TIERS) root.add(buildTier(tier, cleatGeo, mats));

    cushions = new THREE.InstancedMesh(
      cushionGeometry(),
      new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0.04 }),
      COUNT,
    );
    cushions.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(cushions);

    root.add(buildBox());

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(30, 96),
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

    // 桟のローカル姿勢はどの段も同じなので、1 度だけ作って 3 本へ配る
    for (let i = 0; i < CLEAT_N; i++) {
      const tilt = beltPose(travel + (i / CLEAT_N) * PATH_LEN, vec);
      dummy.position.copy(vec);
      dummy.rotation.set(0, 0, tilt);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      for (const mesh of tierCleats) mesh.setMatrixAt(i, dummy.matrix);
    }
    for (const mesh of tierCleats) mesh.instanceMatrix.needsUpdate = true;

    // ローラーはベルト速度に同期して回す（ローカルの上面が +X へ流れる向き）
    const spin = -travel / ROLLER_R;
    for (const r of rollers) r.rotation.set(Math.PI / 2, spin, 0);

    for (let i = 0; i < COUNT; i++) {
      const age = (t + (i * CYCLE) / COUNT) % CYCLE;

      // どの段に乗っているか／段のあいだを落ちているかを、経過秒から割り出す
      let k = TIERS_N - 1;
      while (k > 0 && age < TIERS[k]!.start) k--;
      const tier = TIERS[k]!;

      let x: number;
      let y: number;
      let z: number;
      let yaw = tier.ry;
      let visible = 1;
      let tumble = 0;
      // 着地してからの経過秒。負の値は「まだベルトに乗っていない」
      let since: number;

      if (age < tier.end) {
        // ベルトに乗って等速で流れている
        const run = age - tier.start;
        x = tier.entryX + tier.dx * BELT_SPEED * run;
        z = tier.entryZ + tier.dz * BELT_SPEED * run;
        y = tier.rideY;
        since = run;
        if (k === 0 && run < DROP_IN_T) {
          // 最上段の入口だけは、上空からふわりと降りてくる
          const d = 1 - run / DROP_IN_T;
          y += DROP_IN_H * d * d;
          since = run - DROP_IN_T;
        }
      } else {
        // 段を離れて落下中。水平速度はベルト速度のまま、鉛直だけ加速する
        const u = age - tier.end;
        x = tier.exitX + tier.dx * BELT_SPEED * u;
        z = tier.exitZ + tier.dz * BELT_SPEED * u;
        y = tier.rideY - 0.5 * GRAV * u * u;
        tumble = u * 0.3;
        since = -1;
        if (k < TIERS_N - 1) {
          // 落ちながら次の段の向きへ回り込む
          const e = u / FALL_T;
          yaw += tier.turn * e * e * (3 - 2 * e);
        } else {
          // 箱の暗がりへ沈むように、着地の直前から縮めて消す
          visible = 1 - Math.max(0, (u - BOX_FALL_T * 0.86) / (BOX_FALL_T * 0.3));
        }
      }

      // 着地したあとのばね。潰れて戻るのを数回繰り返す
      const onBelt = since >= 0;
      const squash = onBelt ? Math.exp(-since * 4.2) * Math.cos(since * 13) : 0;
      // ベルト上での呼吸とゆらぎ
      const breath = onBelt ? Math.sin(t * 1.9 + i * 2.1) * 0.02 : 0;
      const sway = onBelt ? Math.sin(t * 1.3 + i) * 0.05 : 0;
      const hover = onBelt ? Math.sin(t * 2.2 + i * 1.7) * 0.05 : 0;

      const flat = Math.max(0, squash);
      const fade = Math.max(visible, 0);
      const sy = (1 - flat * 0.42 + breath) * fade;
      const sxz = (1 + flat * 0.2 - breath * 0.5) * fade;

      dummy.position.set(x, y + hover - flat * CUSHION_H * 0.2, z);
      // YXZ なので Z 回転は「進行方向を向いたあとの前後の傾き」になる
      dummy.rotation.order = 'YXZ';
      dummy.rotation.set(0, yaw + yaws[i]!, sway + tumble);
      dummy.scale.set(CUSHION_W * sxz, CUSHION_H * sy, CUSHION_D * sxz);
      dummy.updateMatrix();
      cushions.setMatrixAt(i, dummy.matrix);

      // 主役なので常に少し持ち上げ、潰れた瞬間にさらに明るくする
      ember(color, shades[i]!, hue, 0.06 + flat * 0.05);
      cushions.setColorAt(i, color);
    }
    cushions.instanceMatrix.needsUpdate = true;
    if (cushions.instanceColor) cushions.instanceColor.needsUpdate = true;
  },

  sound(t, _dt, sfx) {
    // モーターの薄い唸り
    sfx.drone(tone(-5), 0.026);

    const hit = (LAST.end + BOX_FALL_T) / CYCLE;
    for (let i = 0; i < COUNT; i++) {
      const ph = t / CYCLE + i / COUNT;
      for (let k = 0; k < TIERS_N; k++) {
        const tier = TIERS[k]!;
        // 段ごとの着地。下の段ほど低く、定位はその段がいる左右に合わせる
        const at = (tier.start + (k === 0 ? DROP_IN_T : 0)) / CYCLE;
        for (let n = landTicks[k]![i]!(ph - at); n > 0; n--) {
          sfx.air({ gain: 0.1, freq: 720 - k * 130, decay: 0.55, pan: tier.pan });
        }
      }
      for (let n = dropTicks[i]!(ph - hit); n > 0; n--) {
        sfx.drop(tone(2 + ((i * 2) % 5)), { gain: 0.26, decay: 0.8, bend: 0.7, pan: 0.45 });
      }
    }
  },
};
