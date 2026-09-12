import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * Jelly Globe。
 *
 * 何が動くか: ガラスの球体水槽の中を、ミズクラゲが 7 匹漂う。傘がすぼまると
 * その拍のぶんだけ前へ押し出され、傘が開くあいだは惰性でゆっくり滑って減速する。
 * 気持ちよさの芯: 平たい皿のような傘が「ふっ」とすぼまって押し出され、
 * 開きながら滑って止まる、一拍ぶんの推進。個体ごとに拍の周期と位相をずらしてあるので、
 * 画面のどこかでは常に誰かが脈打っている。
 * 造形: ミズクラゲ（Aurelia）の見え方をなぞってある。傘は半球ではなく
 * 高さが半径の 1/7 しかない皿で、縁は 8 つの葉に割れる。中には四つ葉の生殖腺、
 * その外から縁へ放射管、縁には細い触手が密に並び、真ん中から 4 本の口腕が垂れる。
 * 陰影で立体を語らせると水中の透明さが濁るので、光源に反応しない材質だけで組み、
 * 面は薄い膜、輪郭と管は線として描いている。立体感は重なりと動きだけが出す。
 * ループの周期: 傘の脈が 2.6〜4.2 秒。軌道はひと回り 40〜110 秒で、軸ごとに周期が
 * 違うので同じ配置には戻らない。
 * カメラ: 球のやや上から、水槽全体が入る距離で見る。
 * 音: 傘がいちばんすぼまった瞬間に水滴をひとつ。水の静けさとして低い持続音を薄く敷く。
 * スコープ外: 流体の計算。水の流れは無く、軌道は時刻の関数として直接与えている。
 */

/** ガラス球の半径 */
const TANK_R = 9;
/** クラゲの軌道が収まる範囲。ここに傘の大きさと口腕の長さぶんの余裕を見てある。 */
const INNER = 6.2;

/** クラゲの数 */
const JELLIES = 7;

/** 傘: 中心から縁までの輪の数と、円周の分割数 */
const RINGS = 10;
const SEGS = 56;
/** 傘の縁の切れ込み。ミズクラゲの縁は 8 つの葉に分かれて見える。 */
const LOBES = 8;
/** 天辺の高さ。傘の半径を 1 としているので、これだけ平たい皿になる。 */
const DOME = 0.15;

/** 放射管の本数と、1 本を何点の折れ線で描くか */
const CANALS = 16;
const CANAL_PTS = 7;
/** 生殖腺（四つ葉）の枚数と、1 枚あたりの弧の分割 */
const GONADS = 4;
const GONAD_PTS = 18;
/** 口腕の本数と、縦の分割 */
const ARMS = 4;
const ARM_PTS = 18;
/** 縁からぶら下がる細い触手の本数 */
const FRINGE = 144;

/** 水中に漂う微粒子の数 */
const MOTES = 190;

const dummy = new THREE.Object3D();
const up = new THREE.Vector3(0, 1, 0);
const dir = new THREE.Vector3();
const ahead = new THREE.Vector3();
const behind = new THREE.Vector3();
const here = new THREE.Vector3();
const pt = new THREE.Vector3();
const quat = new THREE.Quaternion();

/** クラゲごとの [大きさ, 傘の周期, 拍の位相, 軌道の速さ, 明るさ] */
const jelly = new Float32Array(JELLIES * 5);
/** クラゲごとの軌道 [中心x, 振幅x, 角速度x, 位相x, ...y, ...z] */
const orbit = new Float32Array(JELLIES * 12);
/** 音の定位に使う、いまの x 座標 */
const panX = new Float32Array(JELLIES);

/** 傘の円周方向は全個体・全リングで同じ角度を使うので、三角関数を焼いておく */
const segCos = new Float32Array(SEGS);
const segSin = new Float32Array(SEGS);
const segLobe = new Float32Array(SEGS);
/** 方位角ごとのうねり。リングを跨いで使い回すので毎フレーム 1 度だけ作る。 */
const segWob = new Float32Array(SEGS);

/** クラゲ 1 匹ぶんの部品。位置はすべて Group のローカル座標で書く。 */
interface Jelly {
  group: THREE.Group;
  bell: THREE.BufferAttribute;
  bellMat: THREE.MeshBasicMaterial;
  rim: THREE.BufferAttribute;
  rimMat: THREE.LineBasicMaterial;
  canal: THREE.BufferAttribute;
  canalMat: THREE.LineBasicMaterial;
  gonad: THREE.BufferAttribute;
  gonadMat: THREE.MeshBasicMaterial;
  arm: THREE.BufferAttribute;
  armMat: THREE.MeshBasicMaterial;
  fringe: THREE.BufferAttribute;
  fringeMat: THREE.LineBasicMaterial;
}

let jellies: Jelly[] = [];
let motes: THREE.InstancedMesh;

/** 傘がいちばんすぼまった回数を、個体ごとに数える */
let ticks = tickers(JELLIES);

/** 固定シード。開き直すたびに絵が変わらないようにする。 */
let seed = 0.417;
const rnd = (): number => (seed = (seed * 9301 + 0.49297) % 1);

/**
 * 傘の面の 1 点をローカル座標で出す。
 *
 * ミズクラゲの傘は半球ではなく、ほとんど平らな皿。すぼまるときは全体が縮むのではなく、
 * 縁だけが下へ折れて袋になる。u の 2.5 乗を掛けているのがその「縁だけ」の部分で、
 * 開くときには縁がわずかに反り返って皿へ戻る。
 *
 * @param u   0 = 天辺の中心、1 = 縁
 * @param ca  cos(方位角)
 * @param sa  sin(方位角)
 * @param lo  cos(方位角 * LOBES)。縁の 8 葉をつくる。
 * @param wob 生き物らしいうねり（-1..1）
 * @param sq  すぼまり具合 0..1
 */
function bellPoint(
  u: number,
  ca: number,
  sa: number,
  lo: number,
  wob: number,
  sq: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const edge = u * u * Math.sqrt(u); // u^2.5。縁の近くでだけ効く。
  const r = u * (1 - 0.2 * sq) * (1 + 0.018 * lo) * (1 + 0.07 * (1 - sq) * edge);
  const y =
    DOME * (1 - u * u) - 0.62 * sq * edge + 0.032 * lo * edge + 0.035 * wob * u * u;
  return out.set(ca * r, y, sa * r);
}

/** 傘・生殖腺・口腕で使い回す、帯（ストリップ）のジオメトリ。 */
function ribbonGeometry(strips: number, pts: number, cols: number): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(new Float32Array(strips * pts * cols * 3), 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', attr);
  const idx: number[] = [];
  for (let n = 0; n < strips; n++) {
    for (let p = 0; p < pts - 1; p++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = (n * pts + p) * cols + c;
        idx.push(a, a + cols, a + cols + 1, a, a + cols + 1, a + 1);
      }
    }
  }
  geo.setIndex(idx);
  return geo;
}

/** 傘の面。中心 1 点に RINGS 枚の輪を重ねた円盤。明度は頂点色で中心へ寄せる。 */
function bellGeometry(): THREE.BufferGeometry {
  const count = 1 + RINGS * SEGS;
  const pos = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
  pos.setUsage(THREE.DynamicDrawUsage);
  const col = new Float32Array(count * 3).fill(1);
  for (let k = 1; k <= RINGS; k++) {
    const u = k / RINGS;
    // 中心（胃腔のあたり）が濃く、外へ行くほど水に溶ける
    const shade = 0.3 + 0.52 * (1 - u * u);
    for (let s = 0; s < SEGS; s++) {
      const v = (1 + (k - 1) * SEGS + s) * 3;
      col[v] = col[v + 1] = col[v + 2] = shade;
    }
  }
  const idx: number[] = [];
  for (let s = 0; s < SEGS; s++) {
    const s2 = (s + 1) % SEGS;
    idx.push(0, 1 + s, 1 + s2);
    for (let k = 1; k < RINGS; k++) {
      const a = 1 + (k - 1) * SEGS + s;
      const b = 1 + (k - 1) * SEGS + s2;
      idx.push(a, a + SEGS, b + SEGS, a, b + SEGS, b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', pos);
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

/** 線で描く部品のジオメトリ。 */
function lineGeometry(count: number): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', attr);
  return geo;
}

/** 軌道上の点。半径の違う 3 本の正弦を組んだだけなので、球の中で閉じずに回り続ける。 */
function orbitAt(i: number, tau: number, out: THREE.Vector3): THREE.Vector3 {
  const o = i * 12;
  out.set(
    orbit[o] + orbit[o + 1] * Math.sin(orbit[o + 2] * tau + orbit[o + 3]),
    orbit[o + 4] + orbit[o + 5] * Math.sin(orbit[o + 6] * tau + orbit[o + 7]),
    orbit[o + 8] + orbit[o + 9] * Math.sin(orbit[o + 10] * tau + orbit[o + 11]),
  );
  return out;
}

/**
 * 経過秒から軌道上の位置（の媒介変数）を出す。
 *
 * 速さを `base + push * (0.5 - 0.5cos)` に取り、その原始関数をそのまま書いてある。
 * 差分を積み上げないので、タブを離れて戻っても同じ絵に戻る。
 */
function swimAt(i: number, t: number, phase: number, period: number): number {
  const push = jelly[i * 5 + 3];
  return (1 + push * 0.5) * t - ((push * period) / (4 * Math.PI)) * Math.sin(phase * Math.PI * 2);
}

export const jellyGlobe: SceneModule = {
  name: 'Jelly Globe',
  desc: 'ガラス球の水槽を漂う 7 匹のミズクラゲ。傘をすぼめた拍のぶんだけ前へ滑る。',
  camera: { pos: [0, 6, 26], target: [0, -0.6, 0] },

  build(root) {
    seed = 0.417;
    ticks = tickers(JELLIES);
    jellies = [];

    for (let s = 0; s < SEGS; s++) {
      const az = (s / SEGS) * Math.PI * 2;
      segCos[s] = Math.cos(az);
      segSin[s] = Math.sin(az);
      segLobe[s] = Math.cos(az * LOBES);
    }

    // --- クラゲごとの素性を決める ---
    for (let i = 0; i < JELLIES; i++) {
      const j = i * 5;
      jelly[j] = 1.3 + rnd() * 0.75; // 大きさ
      jelly[j + 1] = 2.6 + rnd() * 1.6; // 傘の周期（秒）
      jelly[j + 2] = rnd(); // 拍の位相
      jelly[j + 3] = 1.1 + rnd() * 0.9; // 一拍で前へ出る量
      jelly[j + 4] = 0.45 + rnd() * 0.45; // 明るさ

      // 縄張りの中心。黄金角で振ると、球の中で偏らずに散る。
      const az = i * 2.399;
      const cy = ((i + 0.5) / JELLIES) * 1.5 - 0.75;
      const cr = Math.sqrt(1 - cy * cy) * INNER * 0.64;

      // 軸ごとに角速度をずらすと、軌道が同じ場所へ戻ってこない
      const o = i * 12;
      orbit[o] = Math.cos(az) * cr;
      orbit[o + 1] = INNER * 0.32;
      orbit[o + 2] = 0.052 + rnd() * 0.022;
      orbit[o + 3] = rnd() * Math.PI * 2;
      orbit[o + 4] = cy * INNER * 0.64;
      orbit[o + 5] = INNER * 0.28;
      orbit[o + 6] = 0.037 + rnd() * 0.019;
      orbit[o + 7] = rnd() * Math.PI * 2;
      orbit[o + 8] = Math.sin(az) * cr;
      orbit[o + 9] = INNER * 0.32;
      orbit[o + 10] = 0.048 + rnd() * 0.024;
      orbit[o + 11] = rnd() * Math.PI * 2;
    }

    // --- 1 匹ぶんの部品を組む ---
    // 材質はすべて光源に反応しないものにしてある。陰影が乗らないぶん、
    // 面は「濃さ」だけ、輪郭と管は線だけで形が読める。
    for (let i = 0; i < JELLIES; i++) {
      const n = jelly[i * 5 + 4];
      const group = new THREE.Group();

      // 傘の膜。重なったところだけ濃くなるよう加算で置き、奥行きは書かない。
      const bellMat = new THREE.MeshBasicMaterial({
        color: emberColor(n),
        vertexColors: true,
        transparent: true,
        opacity: 0.34,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const bellGeo = bellGeometry();
      const bell = new THREE.Mesh(bellGeo, bellMat);
      bell.frustumCulled = false; // 頂点を毎フレーム書き換えるので境界球が当てにならない
      bell.renderOrder = 0;
      group.add(bell);

      // 傘の縁（環状管）。この 1 本が形の輪郭をぜんぶ引き受ける。
      const rimMat = new THREE.LineBasicMaterial({
        color: emberColor(Math.min(1, n + 0.25)),
        transparent: true,
        opacity: 0.68,
        depthWrite: false,
      });
      const rimGeo = lineGeometry(SEGS);
      const rim = new THREE.LineLoop(rimGeo, rimMat);
      rim.frustumCulled = false;
      rim.renderOrder = 3;
      group.add(rim);

      // 放射管。中心から縁へ伸びる線が、平らな傘に向きと奥行きを与える。
      const canalMat = new THREE.LineBasicMaterial({
        color: emberColor(n * 0.7),
        transparent: true,
        opacity: 0.2,
        depthWrite: false,
      });
      const canalGeo = lineGeometry(CANALS * (CANAL_PTS - 1) * 2);
      const canal = new THREE.LineSegments(canalGeo, canalMat);
      canal.frustumCulled = false;
      canal.renderOrder = 3;
      group.add(canal);

      // 生殖腺の四つ葉。ミズクラゲと言えばこれ。
      const gonadMat = new THREE.MeshBasicMaterial({
        color: emberColor(Math.min(1, n + 0.3)),
        transparent: true,
        opacity: 0.62,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const gonadGeo = ribbonGeometry(GONADS, GONAD_PTS, 2);
      const gonad = new THREE.Mesh(gonadGeo, gonadMat);
      gonad.frustumCulled = false;
      gonad.renderOrder = 1;
      group.add(gonad);

      // 口腕。中心から 4 本、ひだを寄せながら垂れる。
      const armMat = new THREE.MeshBasicMaterial({
        color: emberColor(n * 0.9),
        transparent: true,
        opacity: 0.48,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const armGeo = ribbonGeometry(ARMS, ARM_PTS, 3);
      const arm = new THREE.Mesh(armGeo, armMat);
      arm.frustumCulled = false;
      arm.renderOrder = 2;
      group.add(arm);

      // 縁の触手。1 本 1 本は短いが、密に並ぶと縁が毛羽立って見える。
      const fringeMat = new THREE.LineBasicMaterial({
        color: emberColor(n * 0.7),
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      });
      const fringeGeo = lineGeometry(FRINGE * 2);
      const fringe = new THREE.LineSegments(fringeGeo, fringeMat);
      fringe.frustumCulled = false;
      fringe.renderOrder = 3;
      group.add(fringe);

      root.add(group);
      jellies.push({
        group,
        bell: bellGeo.attributes.position as THREE.BufferAttribute,
        bellMat,
        rim: rimGeo.attributes.position as THREE.BufferAttribute,
        rimMat,
        canal: canalGeo.attributes.position as THREE.BufferAttribute,
        canalMat,
        gonad: gonadGeo.attributes.position as THREE.BufferAttribute,
        gonadMat,
        arm: armGeo.attributes.position as THREE.BufferAttribute,
        armMat,
        fringe: fringeGeo.attributes.position as THREE.BufferAttribute,
        fringeMat,
      });
    }

    // --- 水中の微粒子。水が「詰まっている」ことがこれでわかる ---
    motes = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 6, 4),
      new THREE.MeshStandardMaterial({
        color: emberColor(0.3),
        emissive: emberColor(0.45),
        emissiveIntensity: 0.25,
        roughness: 0.6,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      }),
      MOTES,
    );
    motes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < MOTES; i++) {
      // 球の内側へ一様に散らす。立方体で捨てるより偏らない。
      const u = rnd() * 2 - 1;
      const a = rnd() * Math.PI * 2;
      const r = Math.cbrt(rnd()) * (TANK_R - 0.6);
      const s = Math.sqrt(1 - u * u);
      dummy.position.set(Math.cos(a) * s * r, u * r, Math.sin(a) * s * r);
      dummy.scale.setScalar(0.035 + rnd() * 0.05);
      dummy.updateMatrix();
      motes.setMatrixAt(i, dummy.matrix);
    }
    motes.instanceMatrix.needsUpdate = true;
    root.add(motes);

    // --- ガラスの水槽 ---
    // transmission は使わない。three は透過パスに「不透明なものだけ」を描くので、
    // 中身が半透明なこのシーンでは、ガラス越しに何も映らなくなってしまう。
    // 代わりに、灯りを拾って弧を返すだけの薄い殻にしてある。
    const glass = new THREE.Mesh(
      new THREE.SphereGeometry(TANK_R, 72, 48),
      new THREE.MeshPhysicalMaterial({
        color: 0x1a1210,
        roughness: 0.06,
        metalness: 0,
        clearcoat: 1,
        clearcoatRoughness: 0.03,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    root.add(glass);

    // --- 台と床 ---
    // SURFACE のままだと霧に沈んで台が見えないので、この scene の中でだけ持ち上げる
    const standMat = new THREE.MeshStandardMaterial({
      color: 0x2a1a16,
      roughness: 0.34,
      metalness: 0.7,
    });
    // 上下の口輪。ガラスそのものはほとんど見えないので、この 2 本が
    // 球の軸と大きさを示して、水槽の輪郭を読ませる役をしている。
    const collar = new THREE.Mesh(new THREE.TorusGeometry(3.5, 0.42, 12, 64), standMat);
    collar.rotation.x = Math.PI / 2;
    collar.position.y = -TANK_R * 0.86;
    root.add(collar);

    const neck = new THREE.Mesh(new THREE.TorusGeometry(2.3, 0.26, 12, 64), standMat);
    neck.rotation.x = Math.PI / 2;
    neck.position.y = TANK_R * 0.94;
    root.add(neck);

    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(3.9, 5.2, 2.2, 48), standMat);
    pedestal.position.y = -TANK_R - 0.5;
    root.add(pedestal);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(TANK_R * 2.4, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.18, metalness: 0.95 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -TANK_R - 1.6;
    root.add(floor);
  },

  update(t) {
    const hue = drift(t);
    const TAU = Math.PI * 2;

    for (let i = 0; i < JELLIES; i++) {
      const j = i * 5;
      const size = jelly[j];
      const period = jelly[j + 1];
      const n = jelly[j + 4];
      const g = jellies[i];

      // 拍。0 で開ききり、0.5 でいちばんすぼまる。
      const phase = t / period + jelly[j + 2];
      const beat = phase * TAU;
      const wave = 0.5 - 0.5 * Math.cos(beat);
      const squeeze = Math.pow(wave, 1.5); // 締まる瞬間を鋭く、開く側をゆるく

      // 位置と、進んでいく向き
      const tau = swimAt(i, t, phase, period);
      orbitAt(i, tau, here);
      orbitAt(i, tau + 0.7, ahead);
      orbitAt(i, tau - 0.7, behind);
      dir.subVectors(ahead, behind).normalize();
      // ミズクラゲは傘を水平に保ったまま漂う。進む向きへは軽く傾ける程度に留める。
      dir.addScaledVector(up, 0.9).normalize();
      quat.setFromUnitVectors(up, dir);

      panX[i] = here.x / INNER;
      g.group.position.copy(here);
      g.group.quaternion.copy(quat);
      g.group.scale.setScalar(size);

      // 方位角ごとのうねりは、リングを跨いで同じ値を使う
      const swirl = t * 1.1 + i;
      for (let s = 0; s < SEGS; s++) {
        segWob[s] = Math.sin((s / SEGS) * TAU * 3 + swirl);
      }

      // --- 傘の面 ---
      const bell = g.bell;
      bellPoint(0, 1, 0, 1, 0, squeeze, pt);
      bell.setXYZ(0, pt.x, pt.y, pt.z);
      for (let k = 1; k <= RINGS; k++) {
        const u = k / RINGS;
        for (let s = 0; s < SEGS; s++) {
          bellPoint(u, segCos[s], segSin[s], segLobe[s], segWob[s], squeeze, pt);
          bell.setXYZ(1 + (k - 1) * SEGS + s, pt.x, pt.y, pt.z);
        }
      }
      bell.needsUpdate = true;

      // --- 縁。線はほんのわずかに外へ出して、面の端と重ならないようにする ---
      const rim = g.rim;
      for (let s = 0; s < SEGS; s++) {
        bellPoint(1.008, segCos[s], segSin[s], segLobe[s], segWob[s], squeeze, pt);
        rim.setXYZ(s, pt.x, pt.y, pt.z);
      }
      rim.needsUpdate = true;

      // --- 放射管 ---
      const canal = g.canal;
      let c = 0;
      for (let k = 0; k < CANALS; k++) {
        const s = Math.round((k / CANALS) * SEGS) % SEGS;
        for (let p = 0; p < CANAL_PTS - 1; p++) {
          // 中心から引くと雨傘の骨に見えるので、生殖腺の外側から始める
          const u0 = 0.46 + (0.54 * p) / (CANAL_PTS - 1);
          const u1 = 0.46 + (0.54 * (p + 1)) / (CANAL_PTS - 1);
          bellPoint(u0, segCos[s], segSin[s], segLobe[s], segWob[s], squeeze, pt);
          canal.setXYZ(c++, pt.x, pt.y, pt.z);
          bellPoint(u1, segCos[s], segSin[s], segLobe[s], segWob[s], squeeze, pt);
          canal.setXYZ(c++, pt.x, pt.y, pt.z);
        }
      }
      canal.needsUpdate = true;

      // --- 生殖腺。傘の面に貼りつく三日月を 4 枚、少しだけ下へ浮かせる ---
      const gonad = g.gonad;
      let v = 0;
      for (let k = 0; k < GONADS; k++) {
        const az0 = (k / GONADS) * TAU + Math.PI / 4;
        for (let p = 0; p < GONAD_PTS; p++) {
          const q = p / (GONAD_PTS - 1);
          const az = az0 + (q - 0.5) * 1.15;
          const ca = Math.cos(az);
          const sa = Math.sin(az);
          const lo = Math.cos(az * LOBES);
          // 弧の両端を細く、中ほどを太く。馬蹄形はこの太さの変化で出す。
          const w = 0.09 * Math.pow(Math.sin(Math.PI * q), 0.5);
          const mid = 0.37 - 0.06 * Math.sin(Math.PI * q);
          for (let side = 0; side < 2; side++) {
            const u = mid + (side === 0 ? -w : w);
            bellPoint(u, ca, sa, lo, 0, squeeze, pt);
            gonad.setXYZ(v++, pt.x, pt.y - 0.012, pt.z);
          }
        }
      }
      gonad.needsUpdate = true;

      // --- 口腕。傘の裏から 4 本、ねじれながら垂れてひだを打つ ---
      const arm = g.arm;
      const rootY = bellPoint(0.16, 1, 0, 1, 0, squeeze, pt).y;
      const spin = tau * 0.02;
      let a = 0;
      for (let k = 0; k < ARMS; k++) {
        const az0 = (k / ARMS) * TAU + spin + i;
        for (let p = 0; p < ARM_PTS; p++) {
          const d = p / (ARM_PTS - 1); // 0 = 付け根、1 = 先
          // 拍は根元から先へ遅れて伝わる。締まった直後に腕がしなる。
          const lag = beat - d * 2.4;
          const az = az0 + 0.5 * d + 0.1 * Math.sin(lag);
          const ca = Math.cos(az);
          const sa = Math.sin(az);
          const rad = 0.06 + 0.22 * d + Math.sin(lag) * 0.1 * d * d;
          const y = rootY - (0.18 + 1.15 * d) * (0.9 + 0.2 * squeeze) + 0.05 * Math.sin(d * 5 + swirl);
          // ひだ。幅が縦に波打つので、まっすぐな帯に見えない。
          const w = 0.5 * Math.pow(1 - d, 0.45) * (0.55 + 0.45 * Math.sin(d * 6.5 + beat));
          // 幅は接線方向（-sa, 0, ca）へ取る。左右の高さをずらすとひだが立つ。
          for (let side = -1; side <= 1; side++) {
            arm.setXYZ(
              a++,
              ca * rad - sa * w * side,
              y + 0.07 * side * Math.sin(d * 8 + beat + k),
              sa * rad + ca * w * side,
            );
          }
        }
      }
      arm.needsUpdate = true;

      // --- 縁の触手 ---
      const fringe = g.fringe;
      let f = 0;
      for (let k = 0; k < FRINGE; k++) {
        const az = (k / FRINGE) * TAU;
        const ca = Math.cos(az);
        const sa = Math.sin(az);
        const lo = Math.cos(az * LOBES);
        const wob = Math.sin(az * 3 + swirl);
        bellPoint(1, ca, sa, lo, wob, squeeze, pt);
        fringe.setXYZ(f++, pt.x, pt.y, pt.z);
        // 傘が締まると触手は遅れて外へ残り、開くと真下へ戻る
        const len = 0.085 + 0.035 * Math.sin(k * 1.7);
        const out = 0.06 * (1 - squeeze) + 0.05 * Math.sin(beat - 1.2 + k * 0.3);
        fringe.setXYZ(f++, pt.x + ca * out, pt.y - len * (0.8 + 0.4 * squeeze), pt.z + sa * out);
      }
      fringe.needsUpdate = true;

      // --- 色。締まる瞬間だけ全体がわずかに灯る ---
      const glow = 0.06 * squeeze;
      ember(g.bellMat.color, n, hue, glow);
      ember(g.rimMat.color, Math.min(1, n + 0.25), hue, glow);
      ember(g.canalMat.color, n * 0.85, hue, glow);
      ember(g.gonadMat.color, Math.min(1, n + 0.3), hue, glow * 1.5);
      ember(g.armMat.color, n * 0.9, hue, glow);
      ember(g.fringeMat.color, n * 0.7, hue, glow);
    }

    // 微粒子はごくゆっくり回して、水が止まっていないことだけ伝える
    motes.rotation.y = t * 0.012;
    motes.rotation.x = Math.sin(t * 0.03) * 0.06;
  },

  sound(t, _dt, sfx) {
    // 水の静けさ。ほとんど聞こえない高さで敷いておく。
    sfx.drone(tone(-6), 0.11);

    for (let i = 0; i < JELLIES; i++) {
      const period = jelly[i * 5 + 1];
      const phase = t / period + jelly[i * 5 + 2];
      // 位相が 0.5 を越えた瞬間 = 傘がいちばんすぼまったところ
      for (let k = ticks[i](phase + 0.5); k > 0; k--) {
        sfx.drop(tone(6 + (i % 4)), {
          gain: 0.17,
          decay: 1.5,
          bend: 0.72,
          pan: panX[i] * 0.7,
        });
      }
    }
  },
};
