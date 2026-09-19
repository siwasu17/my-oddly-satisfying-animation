import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * Fluff Belt。
 *
 * やや高めの斜め横から見た、3 段組みのベルトコンベア。平たいクッションが
 * 最上段の入口へふわりと降りてきて着地し、潰れて戻りながら一定速度で流れる。
 * 段の終点を越えると放物線を描いて 1 つ下の段へ落ち、そこは逆向きに流れている
 * ので折り返す。3 段を蛇行して下りきると、最後は右の箱へ落ちて暗がりへ沈む。
 *
 * 段ごとに x を互い違いにずらし、さらに 1 段ごとに手前へ寄せてあるので、
 * 斜めから見たときに 3 本のベルトが重ならず、奥行きのある足場として読める。
 * ベルトは無端ループとして作ってあり、桟は上面を進んだあとローラーの曲面を
 * 回り込んで裏側を戻ってくる。ローラーの回転もベルト速度に同期している。
 *
 * 気持ちよさの芯は「着地でぷにっと潰れて戻る」反復と、段を折り返して下りていく
 * 見通しの良さ。落下は重力加速だけで決めてあるので、着地点は必ず次の段に乗る。
 */

// ---- ベルト 1 本ぶんの寸法 ----
/** ローラー中心までの距離（ベルトの直線部の半分） */
const BELT_HALF = 7;
/** ローラーの半径。大きく露出させるほど「回っている機械」に見える */
const ROLLER_R = 1.1;
/** ベルトの幅（奥行き） */
const BELT_W = 3.4;
/** ベルトが流れる速さ（単位/秒） */
const BELT_SPEED = 2.37;
/** ベルト 1 本あたりの桟の数。細かく並べると網に見えるので粗くしてある */
const CLEAT_N = 18;

// ---- 段の積み方 ----
/** 段の数 */
const TIERS_N = 3;
/** 最下段のローラー中心の高さ */
const BASE_Y = 2.6;
/** 段どうしの高低差。クッションの落差そのもの */
const TIER_GAP = 3.6;
/** 段を 1 つ下るごとに手前へずらす量。斜めから見て重ならないようにする */
const TIER_DZ = 1.2;
/** 落下の重力。弱いほど放物線が伸び、ふわふわした落ち方になる */
const GRAV = 5.5;
/** 落下にかかる時間。TIER_GAP をちょうど落ちきる長さ */
const FALL_T = Math.sqrt((2 * TIER_GAP) / GRAV);
/** 落下で進む水平距離 */
const FALL_DX = BELT_SPEED * FALL_T;
/** 次の段の端から、どれだけ内側に着地させるか */
const LAND_MARGIN = 0.9;
/** 段どうしの x のずれ。これだけずらすと落下の着地点が次の段に乗る */
const TIER_DX = FALL_DX + LAND_MARGIN;

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

/** 1 段ぶんの諸元。ベルトの向き・位置と、その段に乗っている時間。 */
interface Tier {
  /** ベルトが流れる向き（+1 / -1）。段ごとに反転する */
  dir: number;
  /** ベルト中心の座標（高さはローラー中心） */
  cx: number;
  cy: number;
  cz: number;
  /** ベルトに乗っているクッション中心の高さ */
  rideY: number;
  /** 乗り始め・降り際の x */
  entryX: number;
  exitX: number;
  /** ライフサイクル中、この段に乗っている区間（秒） */
  start: number;
  end: number;
}

/**
 * 段の諸元を組み立てる。
 *
 * 上の段の終点から放物線で落ちた着地点が、そのまま次の段の乗り始めになる。
 * x のずらし幅（TIER_DX）は落下距離から決めてあるので、段を互い違いに
 * 並べるだけで乗り継ぎが成立する。
 */
function buildTiers(): Tier[] {
  const list: Tier[] = [];
  let clock = 0;
  for (let k = 0; k < TIERS_N; k++) {
    const dir = k % 2 === 0 ? 1 : -1;
    const cx = (-dir * TIER_DX) / 2;
    const cy = BASE_Y + (TIERS_N - 1 - k) * TIER_GAP;
    const cz = (k - (TIERS_N - 1) / 2) * TIER_DZ;
    const prev = list[k - 1];
    // 初段だけは端から、以降は前の段から落ちてきた着地点から乗る
    const entryX = prev ? prev.exitX + prev.dir * FALL_DX : cx - dir * BELT_HALF;
    const exitX = cx + dir * BELT_HALF;
    const start = clock;
    clock += Math.abs(exitX - entryX) / BELT_SPEED;
    list.push({
      dir,
      cx,
      cy,
      cz,
      rideY: cy + ROLLER_R + CUSHION_H / 2,
      entryX,
      exitX,
      start,
      end: clock,
    });
    if (k < TIERS_N - 1) clock += FALL_T;
  }
  return list;
}

const TIERS = buildTiers();
const LAST = TIERS[TIERS_N - 1]!;

// ---- 受け箱 ----
/** 箱に届くまでの落下時間。底の少し上まで落ちたら沈めて消す */
const BOX_FALL_T = Math.sqrt((2 * (LAST.rideY - 1)) / GRAV);
const BOX_X = LAST.exitX + LAST.dir * BELT_SPEED * BOX_FALL_T;
const BOX_Z = LAST.cz;
const BOX_SIZE = 4.4;
const BOX_H = 2.2;

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
 * 逆向きの段はグループごと Y 180 度で裏返す（ベルトは前後対称）。
 * こうしておくと桟とローラーの計算が 3 段とも同じ式で済む。
 */
function buildTier(tier: Tier, cleatGeo: THREE.BufferGeometry, mats: BeltMats): THREE.Group {
  const g = new THREE.Group();
  g.position.set(tier.cx, tier.cy, tier.cz);
  if (tier.dir < 0) g.rotation.y = Math.PI;

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

  // 両脇のフレーム
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

/** 支柱を立てる奥行き。いちばん奥のフレームよりさらに奥 */
const BACK_Z = -(TIERS_N - 1) * 0.5 * TIER_DZ - BELT_W / 2 - 1;

/**
 * 段を支える柱。
 *
 * 段の真下に脚を下ろすと、下の段のベルトを突き抜けてしまう（3 段は x で
 * 大きく重なっている）。そこで柱はすべて奥の 1 面へ寄せ、そこから腕を
 * 伸ばして各段を吊る形にした。手前が空くのでクッションの輪郭も汚れない。
 */
function buildSupports(mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  for (let k = 0; k < TIERS_N; k++) {
    const tier = TIERS[k]!;
    // 上下の段は x が揃うので、柱が重ならないよう段ごとに少しずらす
    const nudge = (k - (TIERS_N - 1) / 2) * 0.5;
    const armEnd = tier.cz - BELT_W / 2 - 0.2;
    for (const sx of [-1, 1]) {
      const x = tier.cx + nudge + sx * (BELT_HALF - 1.1);
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.12, tier.cy, 8),
        mat,
      );
      post.position.set(x, tier.cy / 2, BACK_Z);
      g.add(post);

      const arm = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, 0.14, armEnd - BACK_Z),
        mat,
      );
      arm.position.set(x, tier.cy, (armEnd + BACK_Z) / 2);
      g.add(arm);
    }
  }
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
  desc: 'ふわふわのクッションが 3 段のベルトを折り返しながら下り、箱へ落ちていく。',
  camera: { pos: [10, 14, 23], target: [0.5, 6.4, 0] },

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
      // フレームと脚は暗く細く。本体の下を横切るので、目立たせるとシルエットを汚す
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
    root.add(buildSupports(mats.frame));

    cushions = new THREE.InstancedMesh(
      cushionGeometry(),
      new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0.04 }),
      COUNT,
    );
    cushions.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(cushions);

    root.add(buildBox());

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(28, 96),
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
      let visible = 1;
      let tumble = 0;
      // 着地してからの経過秒。負の値は「まだベルトに乗っていない」
      let since: number;

      if (age < tier.end) {
        // ベルトに乗って等速で流れている
        const run = age - tier.start;
        x = tier.entryX + tier.dir * BELT_SPEED * run;
        y = tier.rideY;
        z = tier.cz;
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
        const next = TIERS[k + 1];
        x = tier.exitX + tier.dir * BELT_SPEED * u;
        y = tier.rideY - 0.5 * GRAV * u * u;
        tumble = tier.dir * u * 0.3;
        since = -1;
        if (next) {
          // 次の段は手前にずれているので、落ちながら奥行きも移す
          const e = u / FALL_T;
          z = tier.cz + (next.cz - tier.cz) * e * e * (3 - 2 * e);
        } else {
          z = tier.cz;
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
      dummy.rotation.order = 'YXZ';
      dummy.rotation.set(0, yaws[i]!, sway + tumble);
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
        // 段ごとの着地。下の段ほど低く、定位も流れる向きに合わせる
        const at = (tier.start + (k === 0 ? DROP_IN_T : 0)) / CYCLE;
        for (let n = landTicks[k]![i]!(ph - at); n > 0; n--) {
          sfx.air({ gain: 0.1, freq: 720 - k * 130, decay: 0.55, pan: tier.dir * -0.35 });
        }
      }
      for (let n = dropTicks[i]!(ph - hit); n > 0; n--) {
        sfx.drop(tone(2 + ((i * 2) % 5)), { gain: 0.26, decay: 0.8, bend: 0.7, pan: 0.45 });
      }
    }
  },
};
