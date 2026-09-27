import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * Orchestra。
 *
 * 半円の雛壇に、弦（チェロ）・ホルン・ティンパニが扇形に並び、手前の指揮者が
 * 4 拍子の図形（下・左・右・上）を指揮棒で描く。打点と同時に各パートが鳴り、
 * 弦は弓を一往復ずつ返し、ホルンは朝顔を膨らませ、ティンパニはマレットを落とす。
 * 反応は指揮者に近い中央から両端へ、さざ波のように広がる。
 *
 * 8 小節（BPM 72、約 27 秒）で一巡する。弦だけで始まり、ホルン、ティンパニの順に
 * 加わって 7 小節目で全員が鳴り、8 小節目で静かに収まって頭へ戻る。
 * 形は毎拍 t から逆算しているので、いつ開いても同じ小節の同じ瞬間になる。
 */

// ---- 調整する数値 ----------------------------------------------------------

/** 1 拍の秒数（BPM 72） */
const BEAT = 60 / 72;
/** 一巡する拍数（8 小節） */
const CYCLE = 32;

/** 指揮者の立ち位置。楽団はこの点を中心にした扇に並ぶ */
const CX = 0;
const CZ = 4.2;

/** 弦: 最前列 */
const STR_N = 12;
const STR_R = 4.8;
const STR_SPAN = 1.2; // 扇の半角（ラジアン）
/** ホルン: 2 列目 */
const HRN_N = 9;
const HRN_R = 7.1;
const HRN_SPAN = 1.05;
const HRN_Y = 0.45;
/** ティンパニ: 最後列 */
const TMP_N = 4;
const TMP_R = 9.5;
const TMP_SPAN = 0.62;
const TMP_Y = 1.35;

/** チェロの胴の下端・高さ、棹の長さ */
const BODY_Y0 = 0.12;
const BODY_H = 1.05;
const NECK = 1.0;

/** 中央から端まで反応が伝わる遅れ（秒 / ラジアン） */
const RIPPLE = 0.13;
/** 鳴ったあとの光と膨らみが引く速さ */
const DECAY = 3.2;

/** 指揮棒の図形の大きさ（小節ごと。強弱の代わり） */
const DYN = [0.7, 0.75, 0.85, 0.9, 1.0, 1.05, 1.2, 0.6];

// ---- 総譜 -------------------------------------------------------------------

/** 小節ごとに、各パートが鳴らす拍（1 始まり） */
const SCORE = {
  str: [[1, 2, 3, 4], [1, 2, 3, 4], [1, 2, 3, 4], [1, 2, 3, 4], [1, 2, 3, 4], [1, 2, 3, 4], [1, 2, 3, 4], [1, 3]],
  hrn: [[], [], [1, 3], [1, 3], [1, 3], [1, 3], [1, 2, 3, 4], [1]],
  tmp: [[], [], [], [], [1], [1], [1, 2, 3, 4], [1]],
};
/** 弦の旋律（拍ごとの tone 番号） */
const MELODY = [
  12, 13, 14, 13, 12, 13, 14, 16,
  15, 14, 13, 12, 13, 14, 15, 14,
  14, 15, 16, 15, 16, 17, 18, 17,
  16, 17, 18, 19, 17, 16, 15, 14,
];

type Part = 'str' | 'hrn' | 'tmp';

/** パートごとに、一巡 32 拍のどこで鳴るか */
const plays: Record<Part, boolean[]> = { str: [], hrn: [], tmp: [] };
for (const p of ['str', 'hrn', 'tmp'] as Part[]) {
  for (let b = 0; b < CYCLE; b++) plays[p].push(SCORE[p][b >> 2].includes((b & 3) + 1));
}
/** 弦が一巡の中で何回目の弓か（弓の向きを交互に返すため） */
const bowIndex: number[] = [];
{
  let k = 0;
  for (let b = 0; b < CYCLE; b++) {
    bowIndex.push(k);
    if (plays.str[b]) k++;
  }
}

const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** t 以前で最後に鳴った拍の番号（無ければ -Infinity） */
function lastBeat(p: Part, t: number): number {
  const b0 = Math.floor(t / BEAT);
  for (let b = b0; b > b0 - CYCLE; b--) if (plays[p][mod(b, CYCLE)]) return b;
  return -Infinity;
}
/** t より後で次に鳴る拍の番号 */
function nextBeat(p: Part, t: number): number {
  const b0 = Math.floor(t / BEAT) + 1;
  for (let b = b0; b < b0 + CYCLE; b++) if (plays[p][mod(b, CYCLE)]) return b;
  return Infinity;
}

const smooth = (x: number): number => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};

// ---- 指揮棒の軌道 -----------------------------------------------------------

/** 4 拍の打点（指揮者から見て 1 下 / 2 左 / 3 右 / 4 上） */
const ICTUS: [number, number][] = [
  [0, -0.42],
  [-0.62, -0.22],
  [0.66, -0.22],
  [0.12, 0.3],
];
/** 打点から次の打点へ移るあいだの跳ね上がり */
const BOUNCE = [0.32, 0.3, 0.26, 0.62];

const SHOULDER = new THREE.Vector3(CX + 0.3, 1.82, CZ - 0.05);
const ARM = 0.52;
const STICK = 0.9;

/** 時刻 s の指揮棒の向き（肩から先の単位ベクトル）を out に書く */
function batonDir(s: number, out: THREE.Vector3): THREE.Vector3 {
  const u = s / BEAT;
  const b = Math.floor(u);
  const f = u - b;
  const k = mod(b, 4);
  const [x0, y0] = ICTUS[k];
  const [x1, y1] = ICTUS[(k + 1) & 3];
  const e = smooth(f);
  // 打点で止まって見えるよう、跳ねは打点の直後に立ち上がって次の打点へ落ちる
  const lift = BOUNCE[k] * Math.sin(Math.PI * Math.pow(f, 0.8));
  const m = mod(Math.floor(b / 4), 8);
  const amp = DYN[m] + (DYN[(m + 1) & 7] - DYN[m]) * smooth((mod(b, 4) + f - 3) / 1);
  const x = (x0 + (x1 - x0) * e) * amp;
  const y = (y0 + (y1 - y0) * e + lift) * amp;
  return out.set(x, y, -1.0).normalize();
}

// ---- 描画の部品 -------------------------------------------------------------

const TRAIL = 36;
const TRAIL_DT = 0.018;

const dummy = new THREE.Object3D();
const part = new THREE.Object3D();
const m4 = new THREE.Matrix4();
const color = new THREE.Color();
const v = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

let celloBody: THREE.InstancedMesh;
let celloNeck: THREE.InstancedMesh;
let bow: THREE.InstancedMesh;
let bell: THREE.InstancedMesh;
let coil: THREE.InstancedMesh;
let drumHead: THREE.InstancedMesh;
let mallet: THREE.InstancedMesh;
let stick: THREE.InstancedMesh;
let arm: THREE.Group;
let tipMat: THREE.MeshStandardMaterial;
let trailGeo: THREE.BufferGeometry;

let tick = ticker();

/** 扇に並ぶ i 番目の角度（-span..span） */
const fan = (i: number, n: number, span: number): number => (n === 1 ? 0 : -span + (2 * span * i) / (n - 1));

/** 楽器の足元の姿勢を dummy に入れる。指揮者の方を向く */
function seat(a: number, r: number, y: number, tilt = 0): void {
  dummy.position.set(CX + r * Math.sin(a), y, CZ - r * Math.cos(a));
  dummy.rotation.order = 'YXZ';
  dummy.rotation.set(tilt, -a, 0);
  dummy.scale.set(1, 1, 1);
  dummy.updateMatrix();
}

/** dummy の上に part を重ねた行列を mesh の i 番に入れる */
function put(mesh: THREE.InstancedMesh, i: number): void {
  part.updateMatrix();
  m4.multiplyMatrices(dummy.matrix, part.matrix);
  mesh.setMatrixAt(i, m4);
}

function instanced(root: THREE.Group, geo: THREE.BufferGeometry, n: number, mat: THREE.Material): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  root.add(mesh);
  return mesh;
}

/** 扇形の雛壇 1 段 */
function riser(root: THREE.Group, r0: number, r1: number, span: number, h: number): void {
  const shape = new THREE.Shape();
  const seg = 48;
  for (let i = 0; i <= seg; i++) {
    const a = -span + (2 * span * i) / seg;
    const p: [number, number] = [r1 * Math.sin(a), r1 * Math.cos(a)];
    if (i === 0) shape.moveTo(...p);
    else shape.lineTo(...p);
  }
  for (let i = seg; i >= 0; i--) {
    const a = -span + (2 * span * i) / seg;
    shape.lineTo(r0 * Math.sin(a), r0 * Math.cos(a));
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 1 });
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: emberColor(0.08), roughness: 0.55, metalness: 0.4 }),
  );
  mesh.position.set(CX, 0, CZ);
  root.add(mesh);
}

/** くびれのあるチェロの胴。輪郭を押し出して作る */
function celloGeo(): THREE.BufferGeometry {
  const seg = 40;
  const w = (u: number): number =>
    Math.sqrt(Math.sin(Math.PI * u)) *
    (0.2 + 0.2 * Math.exp(-(((u - 0.3) / 0.2) ** 2)) + 0.12 * Math.exp(-(((u - 0.78) / 0.14) ** 2)));
  const shape = new THREE.Shape();
  for (let i = 0; i <= seg; i++) {
    const u = i / seg;
    if (i === 0) shape.moveTo(0, 0);
    else shape.lineTo(w(u), u * BODY_H);
  }
  for (let i = seg - 1; i >= 1; i--) {
    const u = i / seg;
    shape.lineTo(-w(u), u * BODY_H);
  }
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.12,
    bevelEnabled: true,
    bevelThickness: 0.04,
    bevelSize: 0.03,
    bevelSegments: 3,
    curveSegments: 1,
  });
  geo.translate(0, BODY_Y0, -0.06);
  return geo;
}

/** 同じ属性を持つジオメトリを 1 つにまとめる（位置・法線・UV だけ） */
function mergeGeo(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const size = parts[0].getAttribute(name).itemSize;
    const total = parts.reduce((n, g) => n + g.getAttribute(name).array.length, 0);
    const arr = new Float32Array(total);
    let o = 0;
    for (const g of parts) {
      arr.set(g.getAttribute(name).array as Float32Array, o);
      o += g.getAttribute(name).array.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  return out;
}

/** 鳴ってからの減衰（0..1）。遅れ d を足した時刻で見る */
function env(p: Part, t: number, d: number): number {
  const tb = lastBeat(p, t - d) * BEAT + d;
  return Math.exp(-(t - tb) * DECAY);
}

export const orchestra: SceneModule = {
  name: 'Orchestra',
  desc: '指揮棒が 4 拍子を描くたび、弦・ホルン・ティンパニが中央から順に応える。',
  camera: { pos: [0, 7.6, 14.4], target: [0, 1.2, -1.6] },

  build(root) {
    tick = ticker();

    // 床
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(15, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.7, metalness: 0.3 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    root.add(floor);

    riser(root, (STR_R + HRN_R) / 2 + 0.2, (HRN_R + TMP_R) / 2, HRN_SPAN + 0.12, HRN_Y);
    riser(root, (HRN_R + TMP_R) / 2, TMP_R + 1.3, HRN_SPAN + 0.12, TMP_Y);

    const wood = new THREE.MeshStandardMaterial({ roughness: 0.38, metalness: 0.25 });
    const brass = new THREE.MeshStandardMaterial({ roughness: 0.22, metalness: 0.8, side: THREE.DoubleSide });
    const dark = new THREE.MeshStandardMaterial({ color: emberColor(0.12), roughness: 0.5, metalness: 0.3 });

    // 弦: 胴（潰した球）・棹・弓
    celloBody = instanced(root, celloGeo(), STR_N, wood);
    const neckGeo = new THREE.BoxGeometry(0.08, NECK, 0.07);
    neckGeo.translate(0, BODY_Y0 + BODY_H + NECK / 2 - 0.08, 0);
    const scrollGeo = new THREE.TorusGeometry(0.075, 0.035, 8, 16);
    scrollGeo.rotateY(Math.PI / 2);
    scrollGeo.translate(0, BODY_Y0 + BODY_H + NECK - 0.02, 0);
    const stringsGeo = new THREE.BoxGeometry(0.05, BODY_H * 0.72 + NECK * 0.9, 0.012);
    stringsGeo.translate(0, BODY_Y0 + BODY_H * 0.2 + (BODY_H * 0.72 + NECK * 0.9) / 2, 0.1);
    const fGeoL = new THREE.BoxGeometry(0.025, 0.26, 0.012);
    fGeoL.translate(-0.13, BODY_Y0 + BODY_H * 0.42, 0.095);
    const fGeoR = fGeoL.clone();
    fGeoR.translate(0.26, 0, 0);
    celloNeck = instanced(root, mergeGeo([neckGeo, scrollGeo, stringsGeo, fGeoL, fGeoR]), STR_N, dark);
    const bowGeo = new THREE.CylinderGeometry(0.018, 0.018, 1.2, 6);
    bowGeo.rotateZ(Math.PI / 2 - 0.12);
    bow = instanced(root, bowGeo, STR_N, wood);

    // ホルン: 巻き管と朝顔
    const coilGeo = new THREE.TorusGeometry(0.34, 0.07, 10, 36);
    coilGeo.translate(0, 0.95, 0);
    coil = instanced(root, coilGeo, HRN_N, brass);
    const bellGeo = new THREE.ConeGeometry(0.38, 0.66, 32, 1, true);
    bell = instanced(root, bellGeo, HRN_N, brass);

    // ティンパニ: 釜・皮・マレット
    const kettle = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.78, 32, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
      brass,
      TMP_N,
    );
    root.add(kettle);
    const headGeo = new THREE.CircleGeometry(0.76, 40);
    headGeo.rotateX(-Math.PI / 2);
    drumHead = instanced(root, headGeo, TMP_N, wood);
    mallet = instanced(root, new THREE.SphereGeometry(0.1, 12, 8), TMP_N, wood);
    const stickGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.7, 6);
    stickGeo.translate(0, 0.35, 0);
    stick = instanced(root, stickGeo, TMP_N, dark);
    for (let i = 0; i < TMP_N; i++) {
      seat(fan(i, TMP_N, TMP_SPAN), TMP_R, TMP_Y + 0.78);
      kettle.setMatrixAt(i, dummy.matrix);
      kettle.setColorAt(i, emberColor(0.55));
    }

    // 指揮者: 指揮台・胴・頭・右腕と指揮棒
    const podium = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.66, 0.28, 32), dark);
    podium.position.set(CX, 0.14, CZ);
    root.add(podium);
    const figure = new THREE.MeshStandardMaterial({ color: emberColor(0.62), roughness: 0.5, metalness: 0.2 });
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.95, 6, 16), figure);
    torso.position.set(CX, 1.22, CZ);
    root.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 20, 14), figure);
    head.position.set(CX, 2.22, CZ);
    root.add(head);

    // 左腕は横へ開いて構えたまま
    const left = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.62, 4, 8), figure);
    left.position.set(CX - 0.55, 1.78, CZ - 0.12);
    left.rotation.set(0.35, 0, -1.05);
    root.add(left);

    arm = new THREE.Group();
    arm.position.copy(SHOULDER);
    root.add(arm);
    const armMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, ARM - 0.14, 4, 8), figure);
    armMesh.position.y = ARM / 2;
    arm.add(armMesh);
    tipMat = new THREE.MeshStandardMaterial({ color: emberColor(1, 0, 0.25), roughness: 0.4 });
    const baton = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.045, STICK, 8), tipMat);
    baton.position.y = ARM + STICK / 2;
    arm.add(baton);

    // 指揮棒の先の残像
    trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL * 3), 3));
    trailGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRAIL * 3), 3));
    const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ vertexColors: true }));
    trail.frustumCulled = false;
    root.add(trail);
  },

  update(t) {
    const hue = drift(t);

    // 指揮棒
    batonDir(t, v);
    arm.quaternion.setFromUnitVectors(UP, v);
    const pos = trailGeo.getAttribute('position') as THREE.BufferAttribute;
    const col = trailGeo.getAttribute('color') as THREE.BufferAttribute;
    for (let k = 0; k < TRAIL; k++) {
      batonDir(t - k * TRAIL_DT, v);
      pos.setXYZ(k, SHOULDER.x + v.x * (ARM + STICK), SHOULDER.y + v.y * (ARM + STICK), SHOULDER.z + v.z * (ARM + STICK));
      const fade = Math.pow(1 - k / TRAIL, 2);
      ember(color, 1, hue, 0.25).multiplyScalar(fade);
      col.setXYZ(k, color.r, color.g, color.b);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    // 打点の瞬間だけ指揮棒の先が少し明るむ
    const onBeat = Math.exp(-mod(t, BEAT) * 6);
    ember(tipMat.color, 1, hue, 0.45 + 0.3 * onBeat);

    // 弦
    for (let i = 0; i < STR_N; i++) {
      const a = fan(i, STR_N, STR_SPAN);
      const d = Math.abs(a) * RIPPLE;
      const lb = lastBeat('str', t - d);
      const e = Math.exp(-(t - (lb * BEAT + d)) * DECAY);
      // 1 拍かけて弓を端から端へ。向きは鳴るたびに返す
      const k = bowIndex[mod(lb, CYCLE)];
      const dir = k % 2 === 0 ? 1 : -1;
      const p = smooth((t - (lb * BEAT + d)) / (BEAT * 0.92));
      const slide = dir * (-0.36 + 0.72 * p);

      seat(a, STR_R, 0, -0.18);
      part.position.set(0, 0, 0);
      part.rotation.set(0, 0, 0);
      part.scale.set(1, 1, 1);
      put(celloBody, i);
      put(celloNeck, i);
      part.position.set(slide, BODY_Y0 + BODY_H * 0.34, 0.2);
      put(bow, i);

      ember(color, 0.28 + 0.6 * e, hue, 0.5 * e);
      celloBody.setColorAt(i, color);
      ember(color, 0.45 + 0.5 * e, hue, 0.45 * e);
      bow.setColorAt(i, color);
    }

    // ホルン
    for (let i = 0; i < HRN_N; i++) {
      const a = fan(i, HRN_N, HRN_SPAN);
      const e = env('hrn', t, Math.abs(a) * RIPPLE);
      seat(a, HRN_R, HRN_Y);
      part.position.set(0, 0, 0);
      part.rotation.set(0, 0, 0);
      part.scale.set(1, 1, 1);
      put(coil, i);
      // 朝顔は巻き管の右上から、斜め上の横へ開く
      const s = 1 + 0.22 * e;
      part.position.set(0.42, 1.38, -0.02);
      part.rotation.set(0, 0, 2.6);
      part.scale.set(s, s, s);
      put(bell, i);

      ember(color, 0.42 + 0.5 * e, hue, 0.32 * e);
      coil.setColorAt(i, color);
      bell.setColorAt(i, color);
    }

    // ティンパニ
    for (let i = 0; i < TMP_N; i++) {
      const a = fan(i, TMP_N, TMP_SPAN);
      const d = Math.abs(a) * RIPPLE;
      const lb = lastBeat('tmp', t - d) * BEAT + d;
      const nb = nextBeat('tmp', t - d) * BEAT + d;
      const e = Math.exp(-(t - lb) * DECAY);
      // 打ったあと 0.3 秒で振り上げ、次の打点の 0.22 秒前から落とす
      const lift = Math.min(smooth((t - lb) / 0.3), smooth((nb - t) / 0.22));

      seat(a, TMP_R, TMP_Y + 0.78);
      part.rotation.set(0, 0, 0);
      part.scale.set(1, 1, 1);
      part.position.set(0, 0.02, 0);
      put(drumHead, i);
      part.position.set(0.12, 0.1 + 0.62 * lift, -0.12);
      put(mallet, i);
      part.rotation.set(-0.7 - 0.5 * lift, 0, 0);
      put(stick, i);

      ember(color, 0.35 + 0.6 * e, hue, 0.5 * e);
      drumHead.setColorAt(i, color);
      ember(color, 0.6, hue);
      mallet.setColorAt(i, color);
    }

    for (const m of [celloBody, celloNeck, bow, coil, bell, drumHead, mallet, stick]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  },

  sound(t, _dt, sfx) {
    const n = tick(t / BEAT);
    const b0 = Math.floor(t / BEAT);
    for (let j = n - 1; j >= 0; j--) {
      const b = mod(b0 - j, CYCLE);
      const loud = DYN[b >> 2];
      if (plays.str[b]) {
        sfx.pluck(tone(MELODY[b]), { gain: 0.16 * loud, decay: 1.8, pan: -0.15 });
      }
      if (plays.hrn[b]) {
        sfx.pluck(tone(7 + (b % 8 < 4 ? 0 : 2)), { gain: 0.14 * loud, decay: 2.6, pan: 0.25 });
      }
      if (plays.tmp[b]) {
        sfx.drop(tone(b % 2 === 0 ? 0 : 3), { gain: 0.3 * loud, decay: 0.8, bend: 0.8 });
      }
    }
    // 7 小節目の全奏のあいだだけ、低い持続音を下に敷く
    const u = mod(t / BEAT, CYCLE);
    sfx.drone(u > 24 && u < 29 ? tone(0) : null, 0.05);
  },
};
