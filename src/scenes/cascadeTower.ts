import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * 塔型のピタゴラ装置。螺旋ポンプで珠を塔のてっぺんまで汲み上げ、樋から
 * 「ししおどし」の桶へ落とす。桶は珠の重みで傾いて珠をこぼし、空になると
 * 受け石へ戻って鳴く。それが 6 段続いたあと、珠はすり鉢へ落ちて渦を巻き、
 * ポンプの口へ吸い込まれてまた登っていく。
 *
 * Marble Machine と同じく物理演算は使わず、1 周を 0..1 の位相 u に割り当て、
 * 区間ごとの式で珠の位置を決める。桶の傾きも螺旋の回転も同じ位相から作るので、
 * 珠と装置は永久にずれない。
 *
 * ただし見え方は正反対にしてある。あちらが横に広い側面図で、玉が 3 個
 * 決まった面の上を通るのに対し、こちらは縦に長く、どの向きから見ても
 * 成立する塔で、小さい珠が 5 個。常にどこかで桶が傾き、どこかで珠が登っている。
 */

const CYCLE = 24; // 珠が 1 周する秒数
const BEADS = 5; // 同時に走らせる珠の数
const BR = 0.3; // 珠の半径

/** 区間の切れ目（珠の位相）。樋 / 段々 / すり鉢へ落下 / 渦 / 螺旋ポンプ。 */
const P_CASCADE = 0.08;
const P_BOWL = 0.42;
const P_SCREW = 0.62;

// 段々。1 段ぶんの位相と、桶の中での進み具合 k（1 = 1 段）。
const STEPS = 6;
const STEP = 0.057;
const K_HOLD = 0.3; // 珠が乗ってから傾き出すまでの間
const K_OUT = 0.54; // 珠が縁を越えて離れる
const K_TIP = 0.78; // 桶が傾ききる
const K_DWELL = 1.12; // 珠が次の桶へ着くまでは、傾けたまま待つ
const K_BACK = 0.34; // 空の桶が受け石まで戻るのにかかる
const A_MAX = 0.75; // 傾ききったときの角度
const A_KNOCK = 0.05; // 受け石に当たった直後の跳ね返り

/** いちばん下の桶を離れ、すり鉢へ落ち始める位相。 */
const P_PLUNGE = P_CASCADE + (STEPS - 1 + K_OUT) * STEP;

// 桶。支点を筒の真ん中に置いた、ししおどしと同じ形。
const TROUGH_R = 0.45;
const TROUGH_L = 2;
const LIP = TROUGH_L / 2; // 珠が転がり出ていく先。支点からの距離
/** 描く筒の長さ。縁を LIP より少し手前で切って、出ていく珠が縁をかすめないようにする。 */
const TROUGH_DRAW = TROUGH_L - 0.24;
const REST_X = 0.35; // 珠が落ち着く位置。支点より前なので、やがて傾く
const LAND_X = 0.17; // 落ちてきた珠が着く位置。ここから前へ転がって REST_X に落ち着く
const REST_Y = -(TROUGH_R - BR); // 筒の底から珠の中心まで

// 段々の並び。塔をゆるく回りながら降りる。
const R_OUT = 3.4;
const R_POST = 4.5; // 柱を立てる半径
const PHI0 = 1.75; // 段々が画面の左右いっぱいに散るよう、カメラの向きに合わせてある
const DPHI = -0.2334;
const Y_TOP = 8.7;
const DY = -1.15;

// すり鉢。上の縁から絞り口まで、まっすぐな斜面。
const BOWL_TOP_R = 4.2;
const BOWL_TOP_Y = 1.9;
const BOWL_R = 1.3;
const BOWL_Y = 1;
const SLOPE = (BOWL_TOP_Y - BOWL_Y) / (BOWL_TOP_R - BOWL_R);
/** 斜面から珠の中心までの高さ。法線方向に BR ぶん浮かせた値。 */
const CONE_LIFT = BR * Math.sqrt(1 + SLOPE * SLOPE);
const BOWL_SWEEP = -Math.PI * 2 * 0.85; // 渦が巻く量

// 螺旋ポンプ。塔の芯を通り、珠を絞り口から頂上まで運ぶ。
const BLADE_R = 1.15;
const SHAFT_R = 0.3;
const RIDE_R = 1; // 珠が乗る半径。羽根の外寄り
const BEAD_SIT = BR; // 羽根の面から珠の中心まで
const SCREW_Y1 = 10.2;
/**
 * 羽根が回る回数。珠は世界に対して決まった角度のまま登るので、
 * BEADS 個の珠が全部それぞれの溝に収まるには、珠 1 個ぶんの間隔
 * CYCLE/BEADS が羽根の整数回転でなければならない。N_GROOVE が
 * 「珠と珠の間に挟まる溝の数」で、これを増やすとポンプがゆっくり回る。
 */
const N_GROOVE = 2;
const TURNS = N_GROOVE * BEADS * (1 - P_SCREW);

// 落下の初速。1 = 等速、0 = 静止から。位相を秒に直した実測から決めている。
const FALL_C0 = 0.82;
const PLUNGE_C0 = 0.78;
const PLUNGE_RUN = 0.478; // すり鉢へ落ちる間に進む水平距離

const UP = new THREE.Vector3(0, 1, 0);
const ZAXIS = new THREE.Vector3(0, 0, 1);
const v = new THREE.Vector3();
const va = new THREE.Vector3();
const vb = new THREE.Vector3();
const color = new THREE.Color();

const smooth = (x: number): number => x * x * (3 - 2 * x);
const mix = (a: number, b: number, k: number): number => a + (b - a) * k;

/**
 * 両端の速さを指定できる 0..1 の補間。
 * 区間をまたぐところで珠の速さが跳ねないよう、c0（入りの速さ）と
 * c1（出の速さ）を隣の区間に合わせて渡す。
 */
function hermite(s: number, c0: number, c1: number): number {
  return c0 * s + (3 - 2 * c0 - c1) * s * s + (c0 + c1 - 2) * s * s * s;
}

/** 落下用。c0 に初速を渡すと、あとは一定の加速で落ちる。 */
const fallEase = (s: number, c0: number): number => c0 * s + (1 - c0) * s * s;

/** すり鉢の斜面に載せたときの、半径 r での珠の中心の高さ。 */
const coneY = (r: number): number => BOWL_Y + (r - BOWL_R) * SLOPE + CONE_LIFT;

// 桶ごとの支点と、傾く向き（＝次の落とし先へ向かう水平方向）。
const PIVOT: THREE.Vector3[] = [];
const FWD: THREE.Vector3[] = [];
const BASE: THREE.Quaternion[] = [];
for (let i = 0; i < STEPS; i++) {
  const a = PHI0 + i * DPHI;
  PIVOT.push(new THREE.Vector3(Math.cos(a) * R_OUT, Y_TOP + i * DY, Math.sin(a) * R_OUT));
}
for (let i = 0; i < STEPS; i++) {
  const f = new THREE.Vector3();
  if (i < STEPS - 1) {
    f.copy(PIVOT[i + 1]!).sub(PIVOT[i]!).setY(0).normalize();
  } else {
    // 最後の 1 段だけは、外へではなく塔の中心（すり鉢）へ向けて傾ける
    f.set(-PIVOT[i]!.x, 0, -PIVOT[i]!.z).normalize();
  }
  FWD.push(f);
  const m = new THREE.Matrix4().makeBasis(f, UP, new THREE.Vector3().crossVectors(f, UP));
  BASE.push(new THREE.Quaternion().setFromRotationMatrix(m));
}

/** 桶の内側の点。lx は支点からの距離、ly は筒の軸からの高さ、a は傾き。 */
function bucketPoint(i: number, a: number, lx: number, ly: number, out: THREE.Vector3): THREE.Vector3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return out
    .copy(PIVOT[i]!)
    .addScaledVector(FWD[i]!, lx * c + ly * s)
    .addScaledVector(UP, ly * c - lx * s);
}

const REST: THREE.Vector3[] = [];
const LAND: THREE.Vector3[] = [];
const RELEASE: THREE.Vector3[] = [];
for (let i = 0; i < STEPS; i++) {
  REST.push(bucketPoint(i, 0, REST_X, REST_Y, new THREE.Vector3()));
  LAND.push(bucketPoint(i, 0, LAND_X, REST_Y, new THREE.Vector3()));
  const e = smooth((K_OUT - K_HOLD) / (K_TIP - K_HOLD));
  RELEASE.push(bucketPoint(i, A_MAX * e, mix(REST_X, LIP, e * e), REST_Y, new THREE.Vector3()));
}

/** すり鉢に落ちる位置。最後の桶から内側へ放り出された先を斜面へ載せ直す。 */
const BOWL_IN = RELEASE[STEPS - 1]!.clone().addScaledVector(FWD[STEPS - 1]!, PLUNGE_RUN);
const R_ENTRY = Math.hypot(BOWL_IN.x, BOWL_IN.z);
BOWL_IN.y = coneY(R_ENTRY);

const TH_ENTRY = Math.atan2(BOWL_IN.z, BOWL_IN.x);
/** 渦を巻き終えた先。珠はここから、世界に対して同じ角度のまま登っていく。 */
const TH_IN = TH_ENTRY + BOWL_SWEEP;
const SCREW_Y0 = coneY(RIDE_R);
const PITCH = (SCREW_Y1 - SCREW_Y0) / TURNS;

/** すり鉢の渦。落ちてきた速さのまま巻き込み、螺旋が汲み上げる速さで出す。 */
function vortexPoint(s: number, out: THREE.Vector3): THREE.Vector3 {
  const e = hermite(s, 0.66, 0.85);
  const r = mix(R_ENTRY, RIDE_R, e);
  const th = TH_ENTRY + BOWL_SWEEP * e;
  return out.set(Math.cos(th) * r, coneY(r), Math.sin(th) * r);
}

function screwPoint(s: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(Math.cos(TH_IN) * RIDE_R, mix(SCREW_Y0, SCREW_Y1, s), Math.sin(TH_IN) * RIDE_R);
}

/**
 * 螺旋の出口から、いちばん上の桶までを渡す樋。
 * 中ほどの 2 点は両端から作るので、螺旋や段々の位置を変えても付いてくる。
 */
const CH_A = screwPoint(1, new THREE.Vector3());
const CH_B = REST[0]!.clone();
const chuteCurve = new THREE.CatmullRomCurve3([
  CH_A,
  CH_A.clone().lerp(CH_B, 0.38).setY(mix(CH_A.y, CH_B.y, 0.22)),
  CH_A.clone().lerp(CH_B, 0.75).setY(mix(CH_A.y, CH_B.y, 0.66)),
  CH_B,
]);

/** i 段目に珠が乗る位相。 */
const stepPhase = (i: number): number => P_CASCADE + i * STEP;

/**
 * 位相 u の珠の位置。
 *
 * 区間の継ぎ目では位置だけでなく速さも合わせてある。桶を離れる瞬間の
 * 速度（前へ 0.8、下へ 1.3 ほど）に合わせて段の間隔と落下時間を決めたので、
 * 珠は放り出された勢いのまま次の桶へ落ちる。
 */
function beadPos(u: number, out: THREE.Vector3): THREE.Vector3 {
  if (u < P_CASCADE) {
    // 螺旋が押し上げる速さで樋へ移り、桶の上ではちょうど止まっている
    return chuteCurve.getPointAt(hermite(u / P_CASCADE, 0.62, 0), out);
  }
  if (u < P_PLUNGE) {
    const i = Math.min(Math.floor((u - P_CASCADE) / STEP), STEPS - 1);
    const k = (u - stepPhase(i)) / STEP;
    if (k < K_HOLD) {
      // 落ちてきた勢いのまま少し前へ転がって止まる。
      // いちばん上の桶だけは樋からそっと入るので、転がりは要らない。
      if (i === 0) return out.copy(REST[0]!);
      const s = k / K_HOLD;
      return out.lerpVectors(LAND[i]!, REST[i]!, s * (2 - s));
    }
    if (k < K_OUT) {
      const e = smooth((k - K_HOLD) / (K_TIP - K_HOLD));
      return bucketPoint(i, A_MAX * e, mix(REST_X, LIP, e * e), REST_Y, out);
    }
    const s = (k - K_OUT) / (1 - K_OUT);
    const to = LAND[i + 1]!;
    const from = RELEASE[i]!;
    return out.set(
      mix(from.x, to.x, s),
      mix(from.y, to.y, fallEase(s, FALL_C0)),
      mix(from.z, to.z, s),
    );
  }
  if (u < P_BOWL) {
    const s = (u - P_PLUNGE) / (P_BOWL - P_PLUNGE);
    const from = RELEASE[STEPS - 1]!;
    return out.set(
      mix(from.x, BOWL_IN.x, s),
      mix(from.y, BOWL_IN.y, fallEase(s, PLUNGE_C0)),
      mix(from.z, BOWL_IN.z, s),
    );
  }
  if (u < P_SCREW) {
    return vortexPoint((u - P_BOWL) / (P_SCREW - P_BOWL), out);
  }
  return screwPoint((u - P_SCREW) / (1 - P_SCREW), out);
}

/**
 * 位相 u0 を珠が通り過ぎてからの進み具合（0..1）。
 * 珠は 1/BEADS ずつずれているので、どの珠かを気にせずこの 1 本で書ける。
 */
function since(t: number, u0: number): number {
  const p = BEADS * (t / CYCLE - u0);
  return p - Math.floor(p);
}

/** since() の 0..1 を「段いくつぶん」に直す係数。 */
const K_SPAN = BEADS * STEP;

/** 桶の傾き。k は段いくつぶん進んだか。 */
function tipAngle(k: number): number {
  if (k < K_HOLD) return 0;
  if (k < K_TIP) return A_MAX * smooth((k - K_HOLD) / (K_TIP - K_HOLD));
  // 落ちていく珠を追い越さないよう、次の桶へ着くまでは傾けたまま待つ
  if (k < K_DWELL) return A_MAX;
  const b = (k - K_DWELL) / K_BACK;
  if (b < 1) return A_MAX * (1 - smooth(b));
  // 受け石に当たって、跳ね返りながら鳴く
  const tau = (k - K_DWELL - K_BACK) * STEP * CYCLE;
  return -A_KNOCK * Math.exp(-4 * tau) * Math.sin(16 * tau);
}

/** 桶が受け石を打つ位相。 */
const knockPhase = (i: number): number => stepPhase(i) + (K_DWELL + K_BACK) * STEP;

const dir = new THREE.Vector3();
const axis = new THREE.Vector3();

/** 2 点をつなぐ支柱。 */
function strut(a: THREE.Vector3, b: THREE.Vector3, mat: THREE.Material, r = 0.09): THREE.Mesh {
  const d = dir.subVectors(b, a);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.length(), 8), mat);
  mesh.position.copy(a).addScaledVector(d, 0.5);
  mesh.quaternion.setFromUnitVectors(UP, axis.copy(d).normalize());
  return mesh;
}

/**
 * 通り道に沿った樋。底板と左右の縁を張った 1 枚の帯にする。
 * Marble Machine は 2 本のレールだったので、こちらは面で見せて質を変えている。
 */
function gutter(
  path: (s: number, out: THREE.Vector3) => THREE.Vector3,
  segs: number,
  mat: THREE.Material,
): THREE.Mesh {
  const W = 0.42;
  const LIPH = 0.34;
  const pos: number[] = [];
  const idx: number[] = [];
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();

  for (let i = 0; i <= segs; i++) {
    const a = Math.max(i - 1, 0) / segs;
    const b = Math.min(i + 1, segs) / segs;
    path(a, p);
    path(b, q);
    const side = va.subVectors(q, p).normalize().cross(UP).normalize().multiplyScalar(W);
    path(i / segs, p).addScaledVector(UP, -BR);
    for (const [w, h] of [
      [1, LIPH],
      [1, 0],
      [-1, 0],
      [-1, LIPH],
    ] as const) {
      vb.copy(p).addScaledVector(side, w).addScaledVector(UP, h);
      pos.push(vb.x, vb.y, vb.z);
    }
    if (i > 0) {
      const o = (i - 1) * 4;
      for (let c = 0; c < 3; c++) {
        idx.push(o + c, o + c + 1, o + c + 4, o + c + 1, o + c + 5, o + c + 4);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, mat);
}

/** 螺旋ポンプの羽根。芯から外へ張った、ねじれた帯。 */
function blade(mat: THREE.Material): THREE.Mesh {
  const segs = 360;
  // 上端は珠が出ていく高さちょうどで切る。伸ばすと、樋へ移った珠を
  // 回ってきた羽根が下から突き上げてしまう。
  const th0 = -0.18 * Math.PI * 2;
  const th1 = TURNS * Math.PI * 2;
  const pos: number[] = [];
  const idx: number[] = [];

  for (let i = 0; i <= segs; i++) {
    const th = mix(th0, th1, i / segs);
    const y = SCREW_Y0 - BEAD_SIT + (PITCH * th) / (Math.PI * 2);
    const c = Math.cos(th);
    const s = Math.sin(th);
    pos.push(c * SHAFT_R, y, s * SHAFT_R);
    // 外縁だけわずかに下げると、珠を抱え込んでいるように見える
    pos.push(c * BLADE_R, y - 0.07, s * BLADE_R);
    if (i > 0) {
      const o = (i - 1) * 2;
      idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, mat);
}

/** 羽根の向き。珠の高さの式から逆に求めているので、両者は決してずれない。 */
const spinOf = (t: number): number =>
  TH_IN - (Math.PI * 2 * TURNS * (t / CYCLE - P_SCREW)) / (1 - P_SCREW);

let buckets: THREE.Group[] = [];
let bucketMats: THREE.MeshStandardMaterial[] = [];
let screw: THREE.Group;
let beads: THREE.Mesh[] = [];
let beadMat: THREE.MeshPhysicalMaterial;
const spin = new THREE.Quaternion();
const qtip = new THREE.Quaternion();

let tk = {
  knock: tickers(STEPS),
  chute: ticker(),
  splash: ticker(),
  swirl: ticker(),
};

/** 汲み上げられた珠が、桶から桶へこぼれ落ちて渦へ帰っていく塔。 */
export const cascadeTower: SceneModule = {
  name: 'Cascade Tower',
  desc: '螺旋ポンプが汲み上げた珠が、ししおどしの桶を伝って渦へ落ちていく。',
  camera: { pos: [7.8, 7.85, 17.8], target: [0, 5.2, 0] },

  build(root) {
    tk = {
      knock: tickers(STEPS),
      chute: ticker(),
      splash: ticker(),
      swirl: ticker(),
    };

    const metalMat = new THREE.MeshStandardMaterial({
      color: emberColor(0.32),
      emissive: emberColor(0.08),
      roughness: 0.34,
      metalness: 0.78,
      side: THREE.DoubleSide,
    });
    const partMat = new THREE.MeshStandardMaterial({
      color: SURFACE,
      roughness: 0.5,
      metalness: 0.7,
    });
    const bowlMat = new THREE.MeshStandardMaterial({
      color: emberColor(0.22),
      emissive: emberColor(0.06),
      roughness: 0.28,
      metalness: 0.85,
      side: THREE.DoubleSide,
    });
    // 珠は「光る球」ではなく「灯りをうっすら含んだガラス珠」にする。
    // 発光をブルームの閾値より下に抑え、明るさではなく透過と艶で見せる。
    beadMat = new THREE.MeshPhysicalMaterial({
      color: emberColor(0.5),
      emissive: emberColor(0.62),
      roughness: 0.06,
      metalness: 0,
      transmission: 0.72,
      thickness: BR * 1.5,
      ior: 1.46,
      attenuationColor: emberColor(0.55),
      attenuationDistance: BR * 3,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
    });

    // すり鉢。上の縁から絞り口まで、内側を珠が滑り降りる。
    const cone = new THREE.Mesh(
      new THREE.CylinderGeometry(BOWL_TOP_R, BOWL_R, BOWL_TOP_Y - BOWL_Y, 72, 1, true),
      bowlMat,
    );
    cone.position.y = (BOWL_TOP_Y + BOWL_Y) / 2;
    root.add(cone);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(BOWL_TOP_R, 0.07, 6, 96), metalMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = BOWL_TOP_Y;
    root.add(rim);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      root.add(
        strut(
          va.set(Math.cos(a) * (BOWL_TOP_R - 0.2), 0, Math.sin(a) * (BOWL_TOP_R - 0.2)),
          vb.set(Math.cos(a) * (BOWL_TOP_R - 0.2), BOWL_TOP_Y, Math.sin(a) * (BOWL_TOP_R - 0.2)),
          partMat,
          0.11,
        ),
      );
    }

    // 螺旋ポンプ。羽根だけをまとめて回し、芯と籠は止めておく。
    screw = new THREE.Group();
    screw.add(blade(metalMat));
    root.add(screw);
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(SHAFT_R, SHAFT_R, SCREW_Y1 + 0.9, 16),
      partMat,
    );
    shaft.position.y = (SCREW_Y1 + 0.9) / 2 - 0.3;
    root.add(shaft);
    // 籠。羽根を隠さないよう、縦棒と輪だけで囲う。
    const CAGE_R = 1.45;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.8;
      root.add(
        strut(
          va.set(Math.cos(a) * CAGE_R, 2.1, Math.sin(a) * CAGE_R),
          vb.set(Math.cos(a) * CAGE_R, SCREW_Y1 + 0.5, Math.sin(a) * CAGE_R),
          partMat,
          0.07,
        ),
      );
    }
    for (const y of [2.1, 6.2, SCREW_Y1 + 0.5]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(CAGE_R, 0.05, 6, 64), partMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y;
      root.add(ring);
    }

    // 樋。螺旋の出口からいちばん上の桶へ。
    root.add(gutter((s, out) => chuteCurve.getPointAt(s, out), 70, metalMat));
    // 樋の根元は籠から短い筋交いで吊る。先は上段の桶の柱が受け持つ。
    chuteCurve.getPointAt(0.34, v);
    const az = Math.atan2(v.z, v.x);
    root.add(
      strut(
        va.copy(v).addScaledVector(UP, -BR),
        vb.set(Math.cos(az) * CAGE_R, SCREW_Y1 + 0.5, Math.sin(az) * CAGE_R),
        partMat,
        0.06,
      ),
    );

    // 段々。桶ごとに柱を立て、支点まで腕を伸ばす。
    buckets = [];
    bucketMats = [];
    const trough = new THREE.CylinderGeometry(
      TROUGH_R,
      TROUGH_R,
      TROUGH_DRAW,
      20,
      1,
      true,
      Math.PI * 0.1,
      Math.PI * 0.8,
    );
    trough.rotateZ(-Math.PI / 2);
    const cap = new THREE.CylinderGeometry(TROUGH_R, TROUGH_R, 0.07, 20);
    cap.rotateZ(-Math.PI / 2);

    for (let i = 0; i < STEPS; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: emberColor(0.38),
        emissive: emberColor(0.16),
        roughness: 0.3,
        metalness: 0.8,
        side: THREE.DoubleSide,
      });
      const g = new THREE.Group();
      g.position.copy(PIVOT[i]!);
      g.add(new THREE.Mesh(trough, mat));
      const back = new THREE.Mesh(cap, mat);
      back.position.x = -TROUGH_DRAW / 2 + 0.04;
      g.add(back);
      root.add(g);
      buckets.push(g);
      bucketMats.push(mat);

      // 柱と、支点を受ける腕。腕は桶の下をくぐらせる。
      const a = PHI0 + i * DPHI;
      const foot = new THREE.Vector3(Math.cos(a) * R_POST, 0, Math.sin(a) * R_POST);
      root.add(
        strut(foot, va.copy(foot).setY(PIVOT[i]!.y - TROUGH_R - 0.1), partMat, 0.1),
      );
      root.add(
        strut(
          va.copy(foot).setY(PIVOT[i]!.y - TROUGH_R - 0.1),
          vb.copy(PIVOT[i]!).addScaledVector(UP, -TROUGH_R - 0.1),
          partMat,
          0.07,
        ),
      );
      // 受け石。空になった桶が戻ってきて打つところ。
      const stone = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.7), partMat);
      stone.position.copy(PIVOT[i]!).addScaledVector(FWD[i]!, LIP * 0.62).addScaledVector(UP, -TROUGH_R - 0.08);
      stone.quaternion.copy(BASE[i]!);
      root.add(stone);
    }

    beads = [];
    for (let i = 0; i < BEADS; i++) {
      const bead = new THREE.Mesh(new THREE.SphereGeometry(BR, 20, 14), beadMat);
      root.add(bead);
      beads.push(bead);
    }

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(20, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.25, metalness: 0.9 }),
    );
    floor.rotation.x = -Math.PI / 2;
    root.add(floor);
  },

  update(t) {
    const d = drift(t);

    for (let i = 0; i < BEADS; i++) {
      const u = (t / CYCLE + i / BEADS) % 1;
      const bead = beads[i]!;
      beadPos(u, v);
      va.subVectors(v, bead.position);
      const step = va.length();
      if (step > 1e-5 && step < 1) {
        vb.copy(UP).cross(va.divideScalar(step));
        const len = vb.length();
        // 螺旋の中は真上へ動くので、転がる軸が決まらない。そこは回さない。
        if (len > 1e-4) {
          spin.setFromAxisAngle(vb.divideScalar(len), step / BR);
          bead.quaternion.premultiply(spin);
        }
      }
      bead.position.copy(v);
    }
    ember(color, 0.62, d);
    beadMat.emissive.copy(color);
    ember(color, 0.5, d);
    beadMat.color.copy(color);
    beadMat.attenuationColor.copy(color);

    for (let i = 0; i < STEPS; i++) {
      const k = since(t, stepPhase(i)) / K_SPAN;
      qtip.setFromAxisAngle(ZAXIS, -tipAngle(k));
      buckets[i]!.quaternion.copy(BASE[i]!).multiply(qtip);
      // 受け石を打った瞬間だけ明るくなり、すぐ落ち着く
      const tau = Math.max(k - (K_DWELL + K_BACK), 0) * STEP * CYCLE;
      const hit = k > K_DWELL ? Math.exp(-2.5 * tau) : 0;
      ember(color, 0.38 + hit * 0.4, d, hit * 0.1);
      bucketMats[i]!.color.copy(color);
      bucketMats[i]!.emissive.copy(color);
    }

    screw.rotation.y = spinOf(t);
  },

  sound(t, _dt, sfx) {
    const at = (u: number): number => BEADS * (t / CYCLE - u);

    // 桶は 6 つあるが、全部鳴らすと拍が詰まるので 1 つおきにする
    for (let i = 0; i < STEPS; i += 2) {
      if (tk.knock[i]!(at(knockPhase(i)))) {
        sfx.pluck(tone(11 - i), {
          gain: 0.3,
          decay: 2.4,
          pan: PIVOT[i]!.x / R_OUT,
        });
      }
    }
    if (tk.chute(at(0))) {
      sfx.air({ gain: 0.22, decay: 2.4, freq: 480, sweep: 1.6, q: 1.3, pan: -0.45 });
    }
    if (tk.splash(at(P_BOWL))) sfx.drop(tone(3), { gain: 0.3, decay: 0.9, pan: 0.2 });
    if (tk.swirl(at(P_BOWL + 0.04))) {
      sfx.air({ gain: 0.26, decay: 3.8, freq: 620, sweep: 0.35, q: 1.9, pan: 0.35 });
    }
    // 螺旋がずっと回っているので、低いうなりを薄く敷いておく
    sfx.drone(tone(-3), 0.12);
  },
};
