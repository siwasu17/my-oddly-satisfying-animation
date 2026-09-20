import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * Liquid Orb。
 *
 * 何が動くか: 宙に浮いた液体の玉ひとつ。向きも細かさも違う 5 本の波を球面に重ねて
 * 表面を荒らす。最初の 4.7 秒は荒れたまま保ち、そこから 6.5 秒かけて振幅を 0 へ落とす。
 * 荒れが引いたあとには、継ぎ目もハイライトの途切れも無い完全な球だけが残る。
 * 気持ちよさの芯: うねりが「だんだん」収まっていく過程そのもの。最後のわずかな揺れが
 * ゆっくり消えていくので、整いきった一瞬に静けさが来る。
 * ループの周期: 18 秒。整った球が内側からふくらみ、そのふくらみが表面へ抜けると
 * 再びうねり出す。振幅も波の位相も 18 秒ちょうどで閉じるため、継ぎ目は見えない。
 * カメラ: 水平よりわずかに上から、玉を正面に据える。
 * 音: うねりの強さに連れて濃くなる低いドローン。整った瞬間に澄んだ一音、
 * 内側からふくらむ瞬間に低い滴。
 * スコープ外: 飛沫・水滴・屈折。面の起伏とハイライトの動きだけで見せる。
 */

// ---- 調整する数値 ----------------------------------------------------------

/** 1 周の秒数。うねりの位相もこの長さで閉じる。 */
const LOOP = 18;
/** 球の分割。振幅を上げると 4 では輪郭に稜線が出るので 5（10242 頂点）まで上げてある。 */
const DETAIL = 5;
/** 基準半径 */
const R = 5.2;
/** 玉の中心の高さ */
const CENTER_Y = 5.6;
/**
 * うねりの最大振幅（半径に対する比）。ここが上限で、これ以上大きくすると
 * 「球に戻る前提の液体」ではなく最初から歪んだ固形物に見え始める。
 */
const AMP = 0.31;
/**
 * 重ねた波を割る数。重みの総和（3.05）で割ると 5 本が同時に揃ったときしか
 * 振幅が出ず、ほとんどの時間はただの球に見えてしまう。総和より小さい値で割り、
 * ふだんの起伏を出して、まれに来る大きな山を許す。
 */
const NORM = 2.2;
/** 重ねる波の本数 */
const WAVES = 5;
/** 波の細かさ。6 を超えると表面が高周波になってちらつく。 */
const FREQ = [2.1, 3.0, 4.2, 5.1, 6.0];
/** 各波が LOOP の間に進む周回数。整数なので 1 周で必ず元の位相へ戻る。 */
const SPIN = [1, -3, 4, -5, 7];
/** 波の混ぜ具合。細かい波ほど弱くして、大きなうねりを主役にする。 */
const WEIGHT = [1, 0.85, 0.62, 0.48, 0.36];
/**
 * 波ごとに、凪ぐときの消え始めを遅らせる量。全部を一律に落とすと、
 * 途中でいちばん重い低次の波だけが残り、玉が角丸の四角のような
 * 対称な形に収束してしまう。大きなうねりから先に引かせて、細かい波を
 * 後に残すと、凪ぎの途中も形が読めないままでいられる。
 */
const FADE = [0.34, 0.26, 0.14, 0.06, 0];
/** ここ（位相）で振幅が 0 になり、完全な球になる */
const CALM_END = 0.62;
/**
 * 凪ぎに使う時間のうち、振幅をそのまま保つ区間の割合。ここが無いと
 * 減衰カーブの性質上、序盤の 3 秒ほどで振幅が 1/4 まで落ちてしまい、
 * 「うねっている」と見える時間が凪ぎ区間の見かけの長さより遥かに短くなる。
 */
const PLATEAU = 0.42;
/** ここまで球のまま静止する */
const HOLD_END = 0.73;
/** 内側から湧くときにふくらむ量（半径比） */
const SWELL = 0.05;
/** 整った瞬間に床へ抜ける波紋の本数 */
const RING_COUNT = 2;
/** 波紋が広がりきる半径 */
const RING_SPREAD = 11;
/** 床の広さ。広げすぎると、ステージの点光源が床に丸く映り込んで主役と張り合う。 */
const FLOOR_R = 13;

// ---- 波の配置 --------------------------------------------------------------

let seed = 0.4271;
const rnd = (): number => (seed = (seed * 9301 + 0.49297) % 1);

/** 波の進む向き。黄金角のらせんで球面に均等に散らし、偏りが絵に出ないようにする。 */
const DIRS = new Float32Array(WAVES * 3);
const PHASE = new Float32Array(WAVES);
for (let k = 0; k < WAVES; k++) {
  const y = 1 - ((k + 0.5) / WAVES) * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const a = k * 2.399963;
  DIRS[k * 3] = Math.cos(a) * r;
  DIRS[k * 3 + 1] = y;
  DIRS[k * 3 + 2] = Math.sin(a) * r;
  PHASE[k] = rnd() * Math.PI * 2;
}

// ---- 時刻から決まる量（映像と音で共有する。どちらも t の純関数） -----------

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number): number => {
  const u = clamp01(x);
  return u * u * (3 - 2 * u);
};

/** うねりの強さ 0..1。しばらく荒れたまま保ち、そこから凪いで、最後の揺れがゆっくり消える。 */
function ampAt(t: number): number {
  const u = (t / LOOP) % 1;
  if (u < CALM_END) {
    const x = u / CALM_END;
    if (x < PLATEAU) return 1;
    const s = 1 - smooth((x - PLATEAU) / (1 - PLATEAU));
    return s * s;
  }
  if (u < HOLD_END) return 0;
  return smooth((u - HOLD_END) / (1 - HOLD_END));
}

/** 内側からふくらむ量 0..1。静止の終わりにかかり、うねりの復帰と入れ替わる。 */
function swellAt(t: number): number {
  const u = (t / LOOP) % 1;
  const x = (u - HOLD_END + 0.05) / 0.28;
  if (x <= 0 || x >= 1) return 0;
  const s = Math.sin(Math.PI * x);
  return s * s;
}

// ---- 組み立て --------------------------------------------------------------

const tmp = new THREE.Color();
/** 毎フレーム書き換える作業用。update の中で配列を作らないための置き場。 */
const spin = new Float32Array(WAVES);
const kamp = new Float32Array(WAVES);

/**
 * 暖色の環境マップを 1 枚その場で作る。ステージには環境マップが無く、拡散光だけだと
 * 面がマットに見えて「粘土の玉」に読めてしまう。水平に伸びる光の帯を 2 本だけ持つ
 * 小さな equirectangular を自前で持たせると、うねりがその帯を折り曲げて、
 * 面を横切る細長いハイライトになる。これが液体に見えるかどうかの分かれ目になる。
 */
function makeEnv(): THREE.DataTexture {
  const W = 96;
  const H = 48;
  const data = new Uint8Array(W * H * 4);
  const c = new THREE.Color();
  for (let y = 0; y < H; y++) {
    const v = y / (H - 1);
    const band =
      0.78 * Math.exp(-((v - 0.3) ** 2) / 0.0016) + 0.36 * Math.exp(-((v - 0.52) ** 2) / 0.0009);
    for (let x = 0; x < W; x++) {
      // 帯に緩い濃淡を付けて、反射が一様な輪にならないようにする
      const sway = 0.76 + 0.24 * Math.sin((x / W) * Math.PI * 6 + 1.2);
      ember(c, clamp01(0.26 * (1 - v) ** 1.6 + band * sway), 0, 0);
      const i = (y * W + x) * 4;
      data[i] = Math.round(c.r * 255);
      data[i + 1] = Math.round(c.g * 255);
      data[i + 2] = Math.round(c.b * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

const ENV = makeEnv();

let geo: THREE.BufferGeometry;
let mat: THREE.MeshStandardMaterial;
/** 変位前の球面座標。毎フレームここから作り直す。 */
let base: Float32Array;
let rings: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[] = [];
let settleTick = ticker();
let burstTick = ticker();

/**
 * 多面体を作った直後の BufferGeometry は面ごとに頂点が独立しているので、
 * computeVertexNormals() がフラットシェーディングの法線しか作れない。
 * 同じ座標の頂点を 1 つに畳んでおくと、変位させたあとも面がつながって見える。
 */
function weld(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = src.getAttribute('position');
  const map = new Map<string, number>();
  const verts: number[] = [];
  const index: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const key = `${Math.round(x * 2048)}|${Math.round(y * 2048)}|${Math.round(z * 2048)}`;
    let j = map.get(key);
    if (j === undefined) {
      j = verts.length / 3;
      map.set(key, j);
      verts.push(x, y, z);
    }
    index.push(j);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  out.setIndex(index);
  out.computeVertexNormals();
  src.dispose();
  return out;
}

export const liquidOrb: SceneModule = {
  name: 'Liquid Orb',
  desc: 'うねる液体の玉が、ゆっくり凪いで継ぎ目のない球になる',
  camera: { pos: [0, 8.1, 28.5], target: [0, CENTER_Y + 0.5, 0] },

  build(root) {
    settleTick = ticker();
    burstTick = ticker();

    geo = weld(new THREE.IcosahedronGeometry(R, DETAIL));
    base = new Float32Array(geo.getAttribute('position').array as Float32Array);

    mat = new THREE.MeshStandardMaterial({
      color: emberColor(0.3),
      emissive: emberColor(0.5),
      emissiveIntensity: 0.06,
      roughness: 0.12,
      metalness: 0.62,
      envMap: ENV,
      envMapIntensity: 0.9,
    });
    const orb = new THREE.Mesh(geo, mat);
    orb.position.y = CENTER_Y;
    root.add(orb);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(FLOOR_R, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.62, metalness: 0.35 }),
    );
    floor.rotation.x = -Math.PI / 2;
    root.add(floor);

    rings = [];
    for (let i = 0; i < RING_COUNT; i++) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1, 1.035, 128),
        new THREE.MeshBasicMaterial({
          color: emberColor(0.5),
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      root.add(ring);
      rings.push(ring);
    }
  },

  update(t) {
    const amp = ampAt(t);
    const swell = swellAt(t);
    const calm = 1 - amp;
    const shift = drift(t);

    // 波の位相。LOOP で整数周するので、ループの継ぎ目で形が飛ばない。
    for (let k = 0; k < WAVES; k++) {
      spin[k] = (SPIN[k] * 2 * Math.PI * t) / LOOP + PHASE[k];
      kamp[k] = WEIGHT[k] * clamp01((amp - FADE[k]) / (1 - FADE[k]));
    }

    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const scale = R * (1 + swell * SWELL);
    const reach = AMP;
    for (let i = 0; i < pos.count; i++) {
      const nx = base[i * 3] / R;
      const ny = base[i * 3 + 1] / R;
      const nz = base[i * 3 + 2] / R;
      let w = 0;
      for (let k = 0; k < WAVES; k++) {
        const d = DIRS[k * 3] * nx + DIRS[k * 3 + 1] * ny + DIRS[k * 3 + 2] * nz;
        w += kamp[k] * Math.sin(FREQ[k] * d + spin[k]);
      }
      const r = scale * (1 + reach * (w / NORM));
      pos.setXYZ(i, nx * r, ny * r, nz * r);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();

    // 荒れているあいだは沈んだ赤銅、整うほど澄んだ琥珀へ寄せる。
    ember(tmp, 0.28 + 0.3 * calm, shift);
    mat.color.copy(tmp);
    ember(tmp, 0.55, shift, 0.06);
    mat.emissive.copy(tmp);
    mat.emissiveIntensity = 0.05 + 0.1 * calm + 0.2 * swell;

    // 整った瞬間に床へ抜ける波紋。位相は整った点を 0 とする。
    const ripple = ((t / LOOP) % 1) - CALM_END;
    for (let i = 0; i < RING_COUNT; i++) {
      const p = (ripple + 1 - i * 0.1) % 1;
      const ring = rings[i];
      if (p > 0.42) {
        ring.visible = false;
        continue;
      }
      const e = p / 0.42;
      ring.visible = true;
      const s = 0.6 + RING_SPREAD * smooth(e);
      ring.scale.set(s, s, 1);
      ring.material.opacity = 0.32 * (1 - e) * (1 - e);
    }
  },

  sound(t, _dt, sfx) {
    const amp = ampAt(t);
    // うねりが強いほど濃い。整うと引いて、静けさが音でも伝わる。
    sfx.drone(tone(0), 0.03 + 0.11 * amp);

    const phase = t / LOOP;
    for (let k = settleTick(phase + 1 - CALM_END); k > 0; k--) {
      sfx.pluck(tone(12), { gain: 0.3, decay: 3.2 });
    }
    for (let k = burstTick(phase + 1 - HOLD_END + 0.05); k > 0; k--) {
      sfx.drop(tone(3), { gain: 0.26, decay: 1.1, bend: 0.7 });
    }
  },
};
