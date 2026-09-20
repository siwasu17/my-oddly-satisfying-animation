import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone } from '../audio.ts';
import { SURFACE, ember, drift } from '../palette.ts';

/**
 * 何が動くか: 面にルーンを刻んだ 10 個の 10 面ダイスが、画面の左手前から卓へ一斉に投げ入れられ、
 *   低い弧を描いて跳ねながら歩幅を縮めて転がり、ばらばらの向きで止まる。止まると上を向いた面が灯り、
 *   そこに彫られたルーンが影として浮かぶ。しばらく結果を見せてから床へ沈み、次の一投が始まる。
 * 気持ちよさの芯: 10 個が一斉に散って、跳ねる幅が縮みながら止まっていく「ばらけ方」。
 *   どこに何個固まるか、どの面が上に来るかが毎回読めない。
 * ループの周期: 1 投 8 秒（投げ入れ 0.7 秒 → 跳ねて転がる 2.7 秒 → 灯って見せる 3.7 秒 → 沈む 0.9 秒）。
 *   沈みきる時刻と次の投げの始まりを突き合わせてあるので、何も居ないフレームが挟まらない。
 * カメラ: やや高い斜め上から。転がる軌跡と上を向いた面の両方が見える角度。
 * 音: 最初の着地と二跳ね目に pluck（半分のダイスだけ）、止まる瞬間に drop。音程は出目で変わる。
 * スコープ外: 数字による目の表記（面ごとのルーンと上面の明るさで代わりにする）、ダイス同士の衝突。
 *
 * 落ち場所と出目は一投ごとに変わる。乱数の種は「何投目か」から作るので、タブを離れて
 * 戻っても同じ投げが再現される。種を振り直すのはシーンを開いたときだけ
 * （毎回ちがう結果にしてほしい、という指定のため build で 1 度だけ散らす）。
 */

// ---- 調整する数値 ----
const DICE = 10; // ダイスの個数
const R = 1.0; // 赤道の半径
const H = 1.18; // 上下の頂点までの高さ
const M = H / 9.4721; // 赤道のジグザグの振れ幅。この比のときだけ 10 枚の凧形が平面になる
const SPREAD = 6.0; // 止まる位置の散らばり半径
const MIN_GAP = 2.35; // ダイス同士の最短距離。これ未満なら押し離す
const FLOOR_R = 9.6; // 床の半径。ダイスの散らばりより一回り広いだけにして「台」として読ませる
const PERIOD = 8.0; // 一投の秒数
const THROW_SPAN = 0.42; // 手を離れる時刻のばらつき。先行が着く頃に後続が離れ、軌道上に伸びる
const THROW_X = -6.0; // 投げ入れ口。床の外、カメラから見て左手前の低いところ
const THROW_Z = 4.0;
const THROW_Y = 3.4; // 手を離れる高さ。振りかぶった手の高さくらい
const THROW_V0 = 1.3; // 手を離れた瞬間の上向きの速さ。少し放り上げてから落ちる
const THROW_ALONG = 1.9; // 手を離れた瞬間の散らばり（投げ込む向きに沿った長さ）
const THROW_ACROSS = 1.0; // 同、それに直交する向きの幅。狭いと団子に見えるので沿う向きを長く取る
const THROW_RISE = 1.0; // 同、高さのばらつき。横へ広げると画面の端に掛かるので、縦で散らす
const ROLL_MIN = 3.0; // 手を離れてから止まるまで
const ROLL_VAR = 0.7;
const FALL_FRAC = 0.2; // そのうち最初の着地までの割合。低く速く飛ばすほど横投げに見える
const BOUNCES = 5; // 着地後に跳ねる回数
const BOUNCE_RATIO = 0.66; // 一跳ねごとに滞空時間と歩幅にかかる比
const SPIN_A = 19; // 転がり全体の回転量（主軸）
const SPIN_B = 9; // 同（副軸。減衰が速いので跳ねている間だけ効く）
const GLOW_RISE = 0.34; // 止まってから上面が灯りきるまで
const SINK_AT = 7.0; // 沈み始める時刻
const SINK_SPAN = 0.9; // 沈みきるまで
const SINK_DEPTH = 3.4; // 沈む深さ
const SINK_DELAY = 0.1; // 沈み始めのばらつき。SINK_AT + SINK_SPAN と足して周期を超えないこと
const TINT_MIN = 0.20; // ダイス本体の色（0 = 暗い薔薇 / 1 = 明るい琥珀）
const TINT_VAR = 0.12;
const FACET_RANGE = 0.16; // 上を向いた面ほど明るくする幅。面の境目を読ませる
const GLOW_TINT = 0.50; // 止まったとき、上面の色をどこまで持ち上げるか
const GLOW_ADD = 0.21; // 同、明度への上乗せ（ブルームが拾う）
const RUNE_FIT = 0.55; // 凧形の中でルーンが占める割合。先細りの角へはみ出さない上限
const RUNE_W = 0.1; // 刻線の太さ。細いと、灯った面のブルームの滲みに覆われて消える
const RUNE_LIFT = 0.016; // 面から浮かせる量。これで線が面と z 争いを起こさない
const RUNE_DARK = 0.34; // 刻線を面よりどれだけ暗くするか（彫り跡の影）
const RUNE_LIT = 0.03; // 灯った面の上で刻線を持ち上げる量。ほぼ上げないことで字が影として残る

// 投げ入れ口から卓の中心へ向かう単位ベクトル。塊をこの向きに伸ばす。
const THROW_LEN = Math.hypot(THROW_X, THROW_Z);
const THROW_DX = -THROW_X / THROW_LEN;
const THROW_DZ = -THROW_Z / THROW_LEN;

const UP = new THREE.Vector3(0, 1, 0);
const nWorld = new THREE.Vector3();
const color = new THREE.Color();
const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();

/** 10 面ダイス（五角台形十二面体）を作る。面 f の頂点は色属性の f*6..f*6+5 に並ぶ。 */
function buildDieGeometry(): {
  geo: THREE.BufferGeometry;
  normals: THREE.Vector3[];
  quads: THREE.Vector3[][];
  rest: number;
} {
  const apexUp = new THREE.Vector3(0, H, 0);
  const apexDown = new THREE.Vector3(0, -H, 0);
  const ring: THREE.Vector3[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    ring.push(new THREE.Vector3(Math.cos(a) * R, i % 2 === 0 ? M : -M, Math.sin(a) * R));
  }

  const pos: number[] = [];
  const normals: THREE.Vector3[] = [];
  const quads: THREE.Vector3[][] = [];
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const n = new THREE.Vector3();

  // 凧形 1 枚を三角形 2 枚に割る。法線が外を向くように巻き方向をそろえる。
  // quad[0] と quad[2] は凧形の対称軸の両端（尖った側と赤道側）で、並べ替えても入れ替わらない。
  const kite = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): void => {
    n.copy(e1.subVectors(b, a).cross(e2.subVectors(c, a))).normalize();
    const outward = n.dot(b) > 0;
    const quad = outward ? [a, b, c, d] : [a, d, c, b];
    if (!outward) n.negate();
    normals.push(n.clone());
    quads.push(quad);
    const tri = [quad[0], quad[1], quad[2], quad[0], quad[2], quad[3]];
    for (const v of tri) pos.push(v.x, v.y, v.z);
  };

  for (let j = 0; j < 5; j++) {
    kite(apexUp, ring[(j * 2) % 10], ring[(j * 2 + 1) % 10], ring[(j * 2 + 2) % 10]);
  }
  for (let j = 0; j < 5; j++) {
    kite(apexDown, ring[(j * 2 + 1) % 10], ring[(j * 2 + 2) % 10], ring[(j * 2 + 3) % 10]);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();

  // 面が水平になったとき、反対側の面が床に触れる。そのときの重心の高さ。
  const rest = Math.abs(normals[0].dot(ring[0]));
  return { geo, normals, quads, rest };
}

const { geo: BASE_GEO, normals: FACE_N, quads: FACE_Q, rest: REST_Y } = buildDieGeometry();

/**
 * 面に刻むルーン。エルダー・フサルクから直線だけで書けるものを 10 字選んだ。
 * 座標は凧形の中心を原点とする正規化座標で、x が ±0.45、y が ±0.7 に収まるように書く。
 * 上から順に Fehu / Kenaz / Gebo / Naudiz / Sowilo / Tiwaz / Algiz / Ingwaz / Isa / Hagalaz。
 * 似た形が並ぶと 10 種を見分けられないので、X 字は Gebo 1 つに絞ってある。
 */
const RUNES: number[][][] = [
  [[0, -0.7, 0, 0.7], [0, 0.62, 0.44, 0.26], [0, 0.22, 0.44, -0.14]],
  [[0.34, 0.68, -0.26, 0], [-0.26, 0, 0.34, -0.68]],
  [[-0.38, 0.62, 0.38, -0.62], [0.38, 0.62, -0.38, -0.62]],
  [[0, -0.7, 0, 0.7], [-0.38, -0.26, 0.38, 0.26]],
  [[0.32, 0.7, -0.2, 0.24], [-0.2, 0.24, 0.3, -0.2], [0.3, -0.2, -0.3, -0.68]],
  [[0, -0.7, 0, 0.7], [0, 0.7, -0.34, 0.3], [0, 0.7, 0.34, 0.3]],
  [[0, -0.7, 0, 0.7], [0, 0.12, -0.38, 0.62], [0, 0.12, 0.38, 0.62]],
  [[0, 0.5, 0.36, 0], [0.36, 0, 0, -0.5], [0, -0.5, -0.36, 0], [-0.36, 0, 0, 0.5]],
  [[0, -0.7, 0, 0.7]],
  [[-0.32, -0.7, -0.32, 0.7], [0.32, -0.7, 0.32, 0.7], [-0.32, 0.16, 0.32, -0.16]],
];

/**
 * 10 面ぶんのルーンを、面の上にわずかに浮かせた細い板として 1 つのジオメトリにまとめる。
 * 面 f の刻線が占める頂点の範囲を ranges[f] に控えておき、面と同じ要領で塗り分ける。
 */
function buildRuneGeometry(): { geo: THREE.BufferGeometry; ranges: number[][] } {
  const pos: number[] = [];
  const ranges: number[][] = [];
  const o = new THREE.Vector3();
  const v = new THREE.Vector3();
  const u = new THREE.Vector3();
  const t = new THREE.Vector3();
  const p = new THREE.Vector3();

  for (let f = 0; f < 10; f++) {
    const q = FACE_Q[f];
    const w = FACE_N[f];
    o.copy(q[0]).add(q[1]).add(q[2]).add(q[3]).multiplyScalar(0.25);
    // 対称軸を縦（尖った側が +）、その直交を横に取る。u × v = w になる向きに揃える。
    v.subVectors(q[0], q[2]);
    v.addScaledVector(w, -v.dot(w)).normalize();
    u.copy(v).cross(w);

    const hw = Math.abs(t.subVectors(q[1], o).dot(u));
    const hh = Math.min(
      Math.abs(t.subVectors(q[0], o).dot(v)),
      Math.abs(t.subVectors(q[2], o).dot(v)),
    );
    const sx = (hw * RUNE_FIT) / 0.45;
    const sy = (hh * RUNE_FIT) / 0.7;

    const start = pos.length / 3;
    for (const seg of RUNES[f]) {
      const x1 = seg[0] * sx;
      const y1 = seg[1] * sy;
      const x2 = seg[2] * sx;
      const y2 = seg[3] * sy;
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      const hx = ((y1 - y2) / len) * RUNE_W * 0.5; // 線に直交する向き
      const hy = ((x2 - x1) / len) * RUNE_W * 0.5;
      const ex = ((x2 - x1) / len) * RUNE_W * 0.5; // 端を半幅だけ伸ばして角を繋ぐ
      const ey = ((y2 - y1) / len) * RUNE_W * 0.5;
      const corner = [
        [x1 - hx - ex, y1 - hy - ey],
        [x2 - hx + ex, y2 - hy + ey],
        [x2 + hx + ex, y2 + hy + ey],
        [x1 + hx - ex, y1 + hy - ey],
      ];
      for (const k of [0, 1, 2, 0, 2, 3]) {
        p.copy(o)
          .addScaledVector(u, corner[k][0])
          .addScaledVector(v, corner[k][1])
          .addScaledVector(w, RUNE_LIFT);
        pos.push(p.x, p.y, p.z);
      }
    }
    ranges.push([start, pos.length / 3]);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return { geo, ranges };
}

const { geo: RUNE_GEO, ranges: RUNE_RANGE } = buildRuneGeometry();
const RUNE_VERTS = RUNE_RANGE[9][1];

interface Die {
  mesh: THREE.Mesh;
  colors: THREE.BufferAttribute;
  runes: THREE.BufferAttribute;
  sx: number;
  sy: number;
  sz: number;
  fx: number;
  fz: number;
  t0: number; // 手を離れる時刻
  tA: number; // 最初の着地までの時間
  dur: number; // 止まるまでの時間
  total: number; // 水平距離の正規化に使う合計
  g: number; // 落下の加速度
  segs: number[]; // 跳ねるたびの滞空時間
  face: number; // 上を向く面 = 出目
  tint: number;
  sinkDelay: number;
  axA: THREE.Vector3;
  axB: THREE.Vector3;
  qFinal: THREE.Quaternion;
}

let dice: Die[] = [];
let seedOffset = 0;
let cycle = -1;

const makeRng = (seed: number): (() => number) => {
  let s = seed <= 0 || seed >= 1 ? 0.731 : seed;
  return () => (s = (s * 9301 + 0.49297) % 1);
};

/** c 投目の落ち場所・出目・タイミングを決め直す。c が同じなら何度呼んでも同じ結果になる。 */
function roll(c: number): void {
  const rng = makeRng((c * 0.6180339887 + seedOffset) % 1);
  for (let k = 0; k < 6; k++) rng();

  for (let i = 0; i < DICE; i++) {
    const d = dice[i];
    // 角度を 10 等分した持ち場にジッタを足す。少ない乱数でも片側に寄らない。
    const a = ((i + 0.5 + (rng() - 0.5) * 0.8) / DICE) * Math.PI * 2;
    const rad = SPREAD * Math.sqrt(0.08 + 0.92 * rng());
    d.fx = Math.cos(a) * rad;
    d.fz = Math.sin(a) * rad;

    const along = (rng() - 0.5) * 2 * THROW_ALONG;
    const across = (rng() - 0.5) * 2 * THROW_ACROSS;
    d.sx = THROW_X + THROW_DX * along + THROW_DZ * across;
    d.sz = THROW_Z + THROW_DZ * along - THROW_DX * across;
    d.sy = THROW_Y + (rng() - 0.5) * 2 * THROW_RISE;

    d.t0 = rng() * THROW_SPAN;
    const span = ROLL_MIN + rng() * ROLL_VAR;
    d.tA = span * FALL_FRAC;
    // 放り上げた分も含めて、ちょうど tA で床に降りてくる重力を逆算する。
    d.g = (2 * (d.sy + THROW_V0 * d.tA)) / (d.tA * d.tA);

    // 残り時間を等比で刻む。滞空も歩幅も一跳ねごとに BOUNCE_RATIO 倍に縮む。
    const rest = span - d.tA;
    const denom = (1 - Math.pow(BOUNCE_RATIO, BOUNCES)) / (1 - BOUNCE_RATIO);
    let dur = d.tA;
    let total = d.tA;
    let v = 1;
    for (let k = 0; k < BOUNCES; k++) {
      const seg = (rest / denom) * Math.pow(BOUNCE_RATIO, k);
      d.segs[k] = seg;
      v *= BOUNCE_RATIO;
      dur += seg;
      total += v * seg;
    }
    d.dur = dur;
    d.total = total;

    d.face = Math.floor(rng() * 10) % 10;
    d.tint = TINT_MIN + rng() * TINT_VAR;
    d.sinkDelay = rng() * SINK_DELAY;

    d.axA.set(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1).normalize();
    d.axB.set(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1).normalize();

    qa.setFromUnitVectors(FACE_N[d.face], UP);
    qb.setFromAxisAngle(UP, rng() * Math.PI * 2);
    d.qFinal.copy(qb).multiply(qa);
  }

  // 重なって止まらないように押し離す。転がってぶつかった結果のように見せたいので弱めに。
  for (let pass = 0; pass < 5; pass++) {
    for (let i = 0; i < DICE; i++) {
      for (let j = i + 1; j < DICE; j++) {
        const a = dice[i];
        const b = dice[j];
        const dx = b.fx - a.fx;
        const dz = b.fz - a.fz;
        const dist = Math.hypot(dx, dz);
        if (dist >= MIN_GAP || dist < 1e-4) continue;
        const push = (MIN_GAP - dist) * 0.5;
        a.fx -= (dx / dist) * push;
        a.fz -= (dz / dist) * push;
        b.fx += (dx / dist) * push;
        b.fz += (dz / dist) * push;
      }
    }
  }
  for (let i = 0; i < DICE; i++) {
    const d = dice[i];
    const dist = Math.hypot(d.fx, d.fz);
    if (dist > SPREAD) {
      d.fx = (d.fx / dist) * SPREAD;
      d.fz = (d.fz / dist) * SPREAD;
    }
  }
}

/** 手を離れてから s 秒後の、床からの高さ。 */
function heightAt(d: Die, s: number): number {
  if (s <= 0) return d.sy;
  if (s < d.tA) return d.sy + THROW_V0 * s - 0.5 * d.g * s * s;
  let u = s - d.tA;
  for (let k = 0; k < BOUNCES; k++) {
    const seg = d.segs[k];
    if (u < seg) return 0.5 * d.g * u * (seg - u);
    u -= seg;
  }
  return 0;
}

/** 同じく、撒かれた地点から止まる地点までの進み具合 0..1。 */
function progressAt(d: Die, s: number): number {
  if (s <= 0) return 0;
  if (s < d.tA) return s / d.total;
  let acc = d.tA;
  let u = s - d.tA;
  let v = 1;
  for (let k = 0; k < BOUNCES; k++) {
    const seg = d.segs[k];
    v *= BOUNCE_RATIO;
    if (u < seg) return (acc + v * u) / d.total;
    acc += v * seg;
    u -= seg;
  }
  return 1;
}

export const d10Toss: SceneModule = {
  name: 'D10 Toss',
  desc: 'ルーンを刻んだ 10 面ダイスを一斉に撒く。跳ねて転がって止まり、上を向いた面が灯る。',
  camera: { pos: [3.4, 9.2, 13.2], target: [0, 0.5, 0] },

  build(root) {
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(FLOOR_R, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.78, metalness: 0.14 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    root.add(floor);

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.34,
      metalness: 0.42,
    });

    dice = [];
    for (let i = 0; i < DICE; i++) {
      const geo = BASE_GEO.clone();
      const colors = new THREE.Float32BufferAttribute(new Float32Array(60 * 3), 3);
      geo.setAttribute('color', colors);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = -SINK_DEPTH;
      root.add(mesh);

      // 刻印はダイスの子にする。親の姿勢にそのまま従うので、面の上から離れない。
      const rgeo = RUNE_GEO.clone();
      const runes = new THREE.Float32BufferAttribute(new Float32Array(RUNE_VERTS * 3), 3);
      rgeo.setAttribute('color', runes);
      mesh.add(new THREE.Mesh(rgeo, mat));

      dice.push({
        mesh,
        colors,
        runes,
        sx: 0,
        sy: THROW_Y,
        sz: 0,
        fx: 0,
        fz: 0,
        t0: 0,
        tA: 1,
        dur: 3,
        total: 1,
        g: 20,
        segs: new Array<number>(BOUNCES).fill(0.5),
        face: 0,
        tint: TINT_MIN,
        sinkDelay: 0,
        axA: new THREE.Vector3(1, 0, 0),
        axB: new THREE.Vector3(0, 0, 1),
        qFinal: new THREE.Quaternion(),
      });
    }

    // 開き直すたびに出目を振り直す（毎回ちがう結果にするための、ここだけの乱数）。
    seedOffset = Math.random();
    cycle = -1;
  },

  update(t) {
    const c = Math.floor(t / PERIOD);
    if (c !== cycle) {
      cycle = c;
      roll(c);
    }
    const local = t - c * PERIOD;
    const shift = drift(t);

    for (let i = 0; i < DICE; i++) {
      const d = dice[i];
      const s = local - d.t0;
      const sink = Math.min(1, Math.max(0, (local - SINK_AT - d.sinkDelay) / SINK_SPAN));

      if (s <= 0) {
        // 前の一投の続き。床下に隠したまま次の出番を待つ。
        d.mesh.position.set(d.fx, -SINK_DEPTH, d.fz);
      } else {
        const p = progressAt(d, s);
        const y = REST_Y + heightAt(d, s) - SINK_DEPTH * Math.pow(sink, 1.8);
        d.mesh.position.set(d.sx + (d.fx - d.sx) * p, y, d.sz + (d.fz - d.sz) * p);

        const left = Math.max(0, 1 - s / d.dur);
        qa.setFromAxisAngle(d.axA, SPIN_A * Math.pow(left, 1.7));
        qb.setFromAxisAngle(d.axB, SPIN_B * Math.pow(left, 2.8));
        d.mesh.quaternion.copy(qa).multiply(qb).multiply(d.qFinal);
      }

      // 止まってから上面だけが灯る。明るさは出目で変わる（大きい目ほど強く光る）。
      const lit =
        Math.min(1, Math.max(0, (s - d.dur) / GLOW_RISE)) *
        (1 - sink) *
        (0.72 + 0.28 * (d.face / 9));

      // 面ごとに、いま空を向いている度合いで明るさを変える。転がっている間も
      // 明暗が入れ替わり続けるので、一様な塊ではなく「面のある立体」に見える。
      const arr = d.colors.array as Float32Array;
      const rarr = d.runes.array as Float32Array;
      for (let f = 0; f < 10; f++) {
        nWorld.copy(FACE_N[f]).applyQuaternion(d.mesh.quaternion);
        let n = d.tint + FACET_RANGE * (0.5 + 0.5 * nWorld.y);
        let rn = n - RUNE_DARK;
        let glow = 0;
        if (f === d.face && lit > 0.001) {
          n += GLOW_TINT * lit;
          glow = GLOW_ADD * lit;
          // 刻線は面ほど持ち上げない。灯った面の中で影として残るから字が読める。
          rn += RUNE_LIT * lit;
        }

        ember(color, Math.min(1, n), shift, glow);
        for (let v = f * 6; v < f * 6 + 6; v++) {
          arr[v * 3] = color.r;
          arr[v * 3 + 1] = color.g;
          arr[v * 3 + 2] = color.b;
        }

        ember(color, Math.max(0, rn), shift);
        for (let v = RUNE_RANGE[f][0]; v < RUNE_RANGE[f][1]; v++) {
          rarr[v * 3] = color.r;
          rarr[v * 3 + 1] = color.g;
          rarr[v * 3 + 2] = color.b;
        }
      }
      d.colors.needsUpdate = true;
      d.runes.needsUpdate = true;
    }
  },

  sound(t, dt, sfx) {
    const c = Math.floor(t / PERIOD);
    const local = t - c * PERIOD;
    const prev = local - dt;
    if (prev < 0) return; // 一投の切れ目。次のフレームから拾う

    for (let i = 0; i < DICE; i++) {
      const d = dice[i];
      const pan = Math.max(-1, Math.min(1, d.fx / SPREAD));
      const hit = d.t0 + d.tA;
      if (i % 2 === 0 && prev < hit && local >= hit) {
        sfx.pluck(tone(6 + (d.face % 5)), { gain: 0.34, decay: 1.3, pan });
      }
      const hit2 = hit + d.segs[0];
      if (i % 4 === 0 && prev < hit2 && local >= hit2) {
        sfx.pluck(tone(11 + (d.face % 4)), { gain: 0.16, decay: 0.9, pan });
      }
      const stop = d.t0 + d.dur;
      if (i % 3 === 0 && prev < stop && local >= stop) {
        sfx.drop(tone(2 + (d.face % 3)), { gain: 0.2, decay: 0.7, pan });
      }
    }
  },
};
