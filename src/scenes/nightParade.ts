import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, ticker, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * 百鬼夜行。
 *
 * 何が動くか: 闇に浮かぶ環状の夜道を、妖怪の行列がひたすら練り歩く。
 * 道は円ではなく、半径と高さに整数倍の波を重ねた閉曲線なので、行列は膨らんだり
 * 窄まったり、丘を越えて上下しながら、必ず元の場所へ帰ってくる。
 * 行列に人魂が寄り添っていて、道の上をふわふわと行き来しながら尾を引いている。
 * 気持ちよさの芯: 行列そのものは律儀に同じ速さで進んでいるのに、人魂だけが
 * その上を勝手気ままに漂っているところ。堅い反復とやわらかい揺らぎが同居する。
 * ループの周期: 行列は およそ 54 秒で一周。人魂の揺れはそれと整数比になっていないので、
 * 同じ絵は戻ってこない（灯りの居場所だけは毎フレーム t から作り直している）。
 * カメラ: 環の全周を必ず画面へ収める。
 *
 * 一体の姿は「薄暗いボロボロのゴミ袋が、ゆらゆらしながら歩いている」。
 * 顔も手足も頭も無い。袋がひとつ、くしゃくしゃに歪んだまま道を進むだけ。
 * 袋の形はすべて頂点シェーダが毎フレーム組み立てる（CPU 側には戻ってこない）。
 * 裾と胴の破れはフラグメントの discard で開けているので、輪郭そのものが
 * ぎざぎざに欠ける。両面を描いて、破れ目から袋の内側が覗くようにしてある。
 *
 * 「環の全周を見せる」と「一体のかたちを読ませる」は画角の上で両立しない。
 * この fov（48°）と環の半径（12±4.4）では、全周を入れると一体は 20〜40px にしかならず、
 * 破れも皺も輪郭としては潰れる。ここでは全周のほうを取った。
 * だから造形の作り分けは「一目で分かる違い」を狙っていない。近づいて見た人にだけ
 * 見える差として置いてあり、遠目には帯の質感のゆらぎとしてだけ効けばよい。
 * 一体を読ませたくなったら、それは画角を変える判断になる（このシーンの芯が変わる）。
 * 音: 手前の鳥居をくぐるたびに遠くで鈴が鳴り、底に地鳴りを敷く。
 * スコープ外: 顔、手足、名前の付く個別の妖怪。そして「一体が何者か分かること」自体。
 * 袋は 3 つの型（口を縛った袋・ずんぐりした大袋・ねじれた袋）と、体型・破れ方・
 * 明度の振れで、帯が均質に見えないところまでを担う。
 * 人魂も物理で飛ばさない（軌道は時刻の関数で、粒どうしも干渉しない）。
 * 群れの相互作用も扱わない
 * （並びは道のパラメータの関数なので、追い越しも詰まりも生まれない）。
 *
 * 一体が持っているのは「道のどこにいるか」だけで、位置も向きも毎フレーム
 * その 1 つの式から作り直す。前後の間隔をわずかにばらしてあるので、
 * 列は詰まったり途切れたりしながらも、ひと連なりとしては崩れない。
 * 人魂の尾も同じ考え方で、「その人魂が少し前にいた場所」を時刻を遡って
 * 引き直しているだけ。前フレームの位置を溜め込んでいないので、
 * タブを離れて戻っても尾が絡まらない。
 */

/**
 * 頭数。百鬼と言いつつ 60 体しかいない。
 * 環の全周を画面へ収めたまま一体のかたちを読ませるには、数を減らして
 * 間隔を空けるしかなかった。100 体だと粒が 10〜20px にしかならず、
 * 型を作り分けても階調のばらつきにしか見えない。
 */
const COUNT = 60;
/** 行列が道を一周するのにかかる秒数。 */
const LAP = 54;
/**
 * 道の基準半径。
 * 15 だと環の左右が画面の端に触れて輪が閉じて見えなかった。カメラを引くと
 * 一体がさらに小さくなるので、環のほうを縮めて余白を作っている。
 */
const R = 12;
/** 道幅の半分。 */
const ROAD_W = 1.7;
/** 道を刻む分割数。 */
const SEG = 240;
/**
 * 人魂の数。
 * 増やすほど「どれが主役か」が割れて、ただの光点の散布になる。
 * 明るさを個体ごとに落としてあるので、強く光るのは実際にはこの半分ほど。
 */
const SOULS = 10;
/**
 * 1 つの人魂が引く尾の粒の数。
 * 粒 j は「その人魂が j·TAIL_DT 秒前にいた場所」に置く。位置は時刻の関数なので、
 * 遡るだけで尾が引ける。前フレームの位置を溜め込まずに済む。
 */
const TAIL = 16;
/**
 * 尾の粒 1 つぶんの遡り幅（秒）。
 * 粒の間隔は SOUL_SPEED × これ。粒の「見えている芯」より広げると尾が破線になるので、
 * 数を増やしてでも間隔のほうを詰める。
 */
const TAIL_DT = 0.04;
/**
 * 頭の玉の大きさと、尾の粒の大きさ。
 * PointsMaterial は粒ごとに大きさを変えられないので、頭と尾を別の Points に分けている。
 * 1 つにまとめると全部が同じ太さの線になり、光の玉ではなく画面の傷に見えてしまう。
 */
const CORE_SIZE = 1.5;
const TAIL_SIZE = 1.15;
/** 人魂 1 つが持つ値の数。[道の位置, 周回の半径, 周回の角速度, 位相, 浮く高さ, 明るさ] */
const SOUL_STRIDE = 6;
/**
 * 人魂が漂う速さ（単位/秒）。半径ではなくこちらを固定し、角速度は半径から割り出す。
 * こうすると、大きく回る人魂も小さく回る人魂も同じ速さで動くので、尾の長さが揃う。
 * 角速度のほうを固定すると、半径の違いがそのまま尾の長短になってしまう。
 */
const SOUL_SPEED = 2.4;
/** 人魂に付ける実光源の数。全部に付けると重いので、数個だけ。 */
const LAMPS = 3;
/**
 * 鳥居を置く位置（道のパラメータ 0..1）。
 * ここは道が丘の上でカメラの方へ向き直る地点なので、鳥居が正面から見える。
 */
const GATE = 0.0375;
/** 何体おきに音を鳴らすか。全部鳴らすと団子になる。 */
const SOUND_EVERY = 4;

/**
 * 妖怪ごとに持つ値の数。
 * [道の位置, 道幅方向のずれ, 背丈, 歩調, 位相, 横幅の倍率, 揺れる向き, 型, 袋の明度]
 */
const STRIDE = 9;

const TAU = Math.PI * 2;
/** 進行方向を数値微分で拾うときの刻み。 */
const DU = 0.0015;

const dummy = new THREE.Object3D();
const color = new THREE.Color();
const here = new THREE.Vector3();
const ahead = new THREE.Vector3();
/** 人魂の粒 1 つぶんの居場所を受け取る作業用。 */
const wisp = new THREE.Vector3();

const oni = new Float32Array(COUNT * STRIDE);
const soul = new Float32Array(SOULS * SOUL_STRIDE);

let bodies: THREE.InstancedMesh;
let cores: THREE.Points;
let souls: THREE.Points;
let lamps: THREE.PointLight[] = [];

/**
 * 人魂の粒に貼る、中心が白く縁へ向かって消えていく丸。
 * PointsMaterial は map を与えないと四角い点になるので、丸さはここで作る。
 * disposeGroup() はテクスチャまでは破棄しないため、build のたびに作らず
 * モジュールに 1 枚だけ持たせて使い回す。
 */
let sprite: THREE.CanvasTexture | null = null;

function wispSprite(): THREE.CanvasTexture {
  if (sprite) return sprite;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  // 中心の減衰を急にすると、粒の「見えている芯」が点の大きさより遥かに小さくなり、
  // 粒を並べても連続した筋にならず破線に見える。手前をなだらかに保つ
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  sprite = new THREE.CanvasTexture(canvas);
  return sprite;
}

/** 一体ごとに、鳥居をくぐった回数を数える */
let ticks = tickers(COUNT);
/** 風がひと吹きする間隔を数える */
let tickWind = ticker();

/** 道の上の点を out に書き込む。u は 0..1 で、1 増えるとちょうど一周する。 */
function roadAt(u: number, out: THREE.Vector3): THREE.Vector3 {
  const a = u * TAU;
  // 半径と高さに整数倍の波だけを重ねてあるので、一周すれば必ず元へ戻る
  const r = R + 3.0 * Math.sin(a * 3) + 1.4 * Math.sin(a * 5 + 0.7);
  const y = 2.1 + 1.15 * Math.sin(a * 2 + 0.4) + 0.62 * Math.sin(a * 5 + 1.9);
  return out.set(Math.cos(a) * r, y, Math.sin(a) * r);
}

/**
 * 人魂 s が時刻 tt にいる場所を out に書き込む。
 *
 * 行列と同じ速さで道を進みながら、道の上を水平に周回し、ゆっくり浮き沈みする。
 * tt を遡って呼べば「少し前にいた場所」が返る。尾はこれで引く。
 *
 * 尾の長さを揃えるのに、2 つのことが要る。
 * 1. 揺れを正弦波で作らない。正弦波は折り返しで速度がゼロになるので、そこに
 *    居合わせた人魂だけ尾が縮んで、玉が 1 つ浮いているようにしか見えなくなる。
 * 2. 周回の面を水平に取る。「道の法線 × 鉛直」の面で回すと、環の手前と奥では
 *    その面が視線の方を向き、軌道が真横から見た線に潰れて画面上から尾が消える。
 *    水平な輪なら、俯瞰しているかぎりどこでも楕円として見える。
 *
 * 周回の速さを行列の一周（LAP 秒）と整数比にしていないので、同じ並びには戻らない。
 */
function soulAt(s: number, tt: number, out: THREE.Vector3): THREE.Vector3 {
  const o = s * SOUL_STRIDE;
  const u = tt / LAP + soul[o]!;
  roadAt(u, here);
  roadAt(u + DU, ahead);
  const dx = ahead.x - here.x;
  const dz = ahead.z - here.z;
  const len = Math.hypot(dx, dz) || 1;
  const tx = dx / len;
  const tz = dz / len;

  const rad = soul[o + 1]!;
  const ang = tt * soul[o + 2]! + soul[o + 3]!;
  // 道幅の外まではみ出す水平な輪。行列の上を横切って戻ってくるように見える
  const across = Math.cos(ang) * rad;
  const along = Math.sin(ang) * rad;
  // 浮き沈みは周回よりずっと遅く。尾の長さには効かせない
  const lift = soul[o + 4]! + Math.sin(tt * 0.37 + soul[o + 3]!) * 0.7;

  return out.set(
    here.x + tz * across + tx * along,
    here.y + lift,
    here.z - tx * across + tz * along,
  );
}

/**
 * 袋の丈。
 *
 * 頭も笠も無くなったぶん、袋ひとつで縦横比を稼がなければならない。
 * 袋の直径は太いところで 1.2 前後あるので、丈をここまで取ってようやく
 * 縦横比が 2 に届く。これより縮めると、歩く団子にしか見えない。
 */
const BAG_H = 2.3;
/**
 * 袋を刻む数。縦（裾から口まで）と横（周回り）。
 * 皺は周回り 15 波まで入れてあるので、横はその 2 倍以上ないと皺が消える。
 */
const BAG_RINGS = 22;
const BAG_SEGS = 36;
/** 袋の底が閉じる位置。ここから下は底として塞がる（実際には破れて開くことが多い）。 */
const BAG_FLOOR = -0.12;
/** 袋の基準の太さ。裾のあたりの半径。 */
const BAG_R = 0.46;

/**
 * 袋のねじれ・口のすぼまり・結び目を、型ごとに変えるための値。
 * [口のすぼまり, 結び目の張り出し, ねじれ]
 *
 * 0 = 口を縛った袋、1 = ずんぐりした大袋（口が緩い）、2 = ねじれた細袋。
 * 遠景で効くのは面の明暗ではなく輪郭なので、3 つとも輪郭の出方が別方向になるよう振ってある。
 */
const BAG_KIND: [number, number, number][] = [
  [0.80, 0.085, 0.45],
  [0.42, 0.02, 0.15],
  [0.88, 0.05, 1.55],
];

/**
 * 袋の太さ。h は 0 が裾、1 が口。
 *
 * **下の GLSL 版と骨格だけ揃えてある。** こちらは外接球を出すためだけに使い、
 * 実際に描かれる形（皺・ねじれ・ゆらぎ・破れ）はシェーダ側が作る。
 */
function bagRadius(h: number): number {
  const k = h < 0 ? 0 : h > 1 ? 1 : h;
  let r = BAG_R * (1 - 0.42 * smoothstep(0.1, 1, k));
  // 口をすぼめる。型のうちいちばん固く縛るものに合わせておけば外接球は足りる
  r *= 1 - smoothstep(0.7, 0.93, k) * 0.42;
  // 底を丸く閉じる
  return r * smoothstep(BAG_FLOOR, 0.1, h);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = (x - a) / (b - a);
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return k * k * (3 - 2 * k);
}

/**
 * ゴミ袋の骨格。回転体の格子だけを置き、実際の形は頂点シェーダが作る。
 *
 * 頂点は位置ではなく「周方向の角度 aAng」と「裾からの高さ aH」を持つ。
 * シェーダはその 2 つから毎フレーム形を組み立て直すので、皺もねじれも
 * 歩くたびのたわみも、CPU 側には一切戻ってこない。
 */
function buildBag(): THREE.BufferGeometry {
  const vCount = (BAG_RINGS + 1) * (BAG_SEGS + 1);
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const ang = new Float32Array(vCount);
  const hgt = new Float32Array(vCount);
  const idx = new Uint16Array(BAG_RINGS * BAG_SEGS * 6);

  for (let i = 0; i <= BAG_RINGS; i++) {
    const h = BAG_FLOOR + (1 - BAG_FLOOR) * (i / BAG_RINGS);
    const r = bagRadius(h);
    for (let j = 0; j <= BAG_SEGS; j++) {
      const a = (j / BAG_SEGS) * TAU;
      const v = i * (BAG_SEGS + 1) + j;
      // シェーダが上書きするので、ここは素の回転体のままでよい
      pos[v * 3] = Math.cos(a) * r;
      pos[v * 3 + 1] = h * BAG_H;
      pos[v * 3 + 2] = Math.sin(a) * r;
      nor[v * 3] = Math.cos(a);
      nor[v * 3 + 2] = Math.sin(a);
      ang[v] = a;
      hgt[v] = h;
    }
  }

  let k = 0;
  for (let i = 0; i < BAG_RINGS; i++) {
    for (let j = 0; j < BAG_SEGS; j++) {
      const a0 = i * (BAG_SEGS + 1) + j;
      const a1 = a0 + 1;
      const b0 = a0 + BAG_SEGS + 1;
      const b1 = b0 + 1;
      idx[k++] = a0;
      idx[k++] = b0;
      idx[k++] = a1;
      idx[k++] = a1;
      idx[k++] = b0;
      idx[k++] = b1;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('aAng', new THREE.BufferAttribute(ang, 1));
  geo.setAttribute('aH', new THREE.BufferAttribute(hgt, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}

/** 袋のシェーダが読む時刻。update() から毎フレーム入れ直す。 */
const bagTime = { value: 0 };

/**
 * 袋の材。`MeshStandardMaterial` に頂点シェーダとフラグメントシェーダを差し込む。
 *
 * 素の three の照明とブルームをそのまま使いたいので、`ShaderMaterial` で
 * 書き下ろさずに `onBeforeCompile` で組み込みのチャンクを置き換えている。
 *
 * 位置を動かすと法線が合わなくなるので、形を返す関数 bagPoint() を 3 回呼び、
 * 角度方向と高さ方向へずらした点との外積から法線を作り直している。
 * こうしないと、皺やねじれのところで陰影が裏返る。
 *
 * 破れはフラグメントで discard する。頂点を消しても格子の目より細かい穴は開かないし、
 * 裾のぎざぎざが格子の段に揃ってしまって、破れではなく歯車の縁に見える。
 */
function bagMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    // つるつるに寄せると、通り過ぎる人魂の灯りが皺の上を滑る。
    // ゴミ袋らしさはこの「安っぽい照り」でほぼ決まる
    roughness: 0.58,
    metalness: 0.06,
    // 破れ目から袋の内側が見えるので、裏面も描く
    side: THREE.DoubleSide,
  });

  /**
   * これが無いと差し込んだコードが効かないことがある。
   * three はコンパイル済みプログラムをマテリアルの「パラメータ」で引いたキャッシュから
   * 引き当てるが、そのキーに onBeforeCompile の中身は入らない。パラメータが同じ
   * マテリアルが他にあると、そちらのプログラムが使い回されて、袋が素の回転体のまま描かれる。
   */
  mat.customProgramCacheKey = () => 'nightParade-bag';

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = bagTime;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        uniform float uTime;
        attribute float aAng;
        attribute float aH;
        attribute float aPhase;
        attribute float aGait;
        attribute float aNeck;
        attribute float aKnot;
        attribute float aTwist;
        attribute float aSeed;
        // 破れの判定に使う。x = 周方向の角度, y = 裾からの高さ, z = 個体の種
        varying vec3 vBag;
        vec3 bagPos;

        vec3 bagPoint(float a, float h) {
          float k = clamp(h, 0.0, 1.0);

          // 胴。中身が下へ溜まった袋なので、裾のほうが太い
          float r = ${BAG_R.toFixed(2)} * (1.0 - 0.42 * smoothstep(0.1, 1.0, k));
          // 口をすぼめる。縛りの固さは個体ごと
          r *= 1.0 - smoothstep(0.70, 0.93, k) * aNeck;
          // 縛った先の余り。結び目として少しだけ開く
          r += smoothstep(0.90, 1.0, k) * aKnot;
          // 底を丸く閉じる
          r *= smoothstep(${BAG_FLOOR.toFixed(2)}, 0.1, h);

          // くしゃくしゃ。大きなたわみ 2 つで輪郭をいびつにし、
          // 細かい皺で法線だけを荒らす。皺は輪郭には出ないが照りには出る。
          // 縦に通る折り目（高さに依らない項）を 1 本混ぜると、
          // ぐしゃぐしゃの粒々ではなく「畳まれて皺になった薄い膜」に見える
          r *= 1.0
            + 0.17 * sin(a * 2.0 + k * 3.1 + aSeed)
            + 0.11 * sin(a * 3.0 - k * 5.0 + aSeed * 2.3)
            + 0.045 * sin(a * 7.0 + aSeed * 1.9)
            + 0.030 * sin(a * 15.0 + k * 9.0 + aSeed * 4.1);

          // 歩くたびに中身が揺れて、裾のほうが膨れたり凹んだりする
          float low = 1.0 - k;
          low *= low;
          r *= 1.0 + low * 0.12 * sin(uTime * aGait * 0.5 + a * 2.0 + aSeed);

          // ねじれ。上へ行くほど絞られて回る
          float a2 = a + aTwist * k * k;

          vec3 p = vec3(cos(a2) * r, h * ${BAG_H.toFixed(2)}, sin(a2) * r);

          // ゆらゆら。裾を軸にして上ほど大きく振れる。
          // 2 つの周期を直交する向きに当てているので、まっすぐ前後には揺れない
          float s = k * k;
          p.x += s * 0.22 * sin(uTime * aGait * 0.33 + aPhase);
          p.z += s * 0.17 * sin(uTime * aGait * 0.27 + aPhase * 1.7 + 1.1);
          return p;
        }
      `,
      )
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `
        bagPos = bagPoint(aAng, aH);
        vec3 bgA = bagPoint(aAng + 0.03, aH);
        vec3 bgH = bagPoint(aAng, aH + 0.03);
        vec3 objectNormal = normalize(cross(bgH - bagPos, bgA - bagPos));
        vBag = vec3(aAng, aH, aSeed);
      `,
      )
      .replace('#include <begin_vertex>', 'vec3 transformed = bagPos;');

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec3 vBag;
      `,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        /* glsl */ `
        #include <clipping_planes_fragment>
        {
          float a = vBag.x;
          float h = vBag.y;
          float sd = vBag.z;

          // 裾の破れ。周方向にうねる高さでばっさり切り落とすので、
          // 輪郭の下端が個体ごとに違うぎざぎざになる
          float n = 0.50 * sin(a * 4.0 + sd * 3.1)
                  + 0.32 * sin(a * 7.0 - sd * 1.7)
                  + 0.18 * sin(a * 13.0 + sd * 5.3);
          float hem = 0.05 + 0.09 * (0.5 + 0.5 * n);
          // 裂け。尖らせた波（7 乗）を足して、数か所だけ深くえぐる。
          // ぎざぎざを一様に大きくすると波形の縁にしか見えないが、
          // 深い裂け目が数本あると「破れて垂れ下がった袋」に読める
          hem += pow(0.5 + 0.5 * sin(a * 3.0 + sd * 2.0), 7.0) * 0.34;
          if (h < hem) discard;

          // 胴の穴。角度と高さの積を閾値で切ると、まばらな染みのように開く
          float hole = sin(a * 2.0 + sd * 4.7) * sin(h * 5.5 - sd * 2.9)
                     + 0.35 * sin(a * 5.0 - h * 9.0 + sd);
          if (hole > 1.04) discard;
        }
      `,
      );
  };

  return mat;
}

/** 道を帯として起こす。ほぼ水平なので、法線は上向きで足りる。 */
function buildRoad(): THREE.Mesh {
  const pos = new Float32Array(SEG * 2 * 3);
  const nor = new Float32Array(SEG * 2 * 3);
  const idx = new Uint16Array(SEG * 6);

  for (let i = 0; i < SEG; i++) {
    roadAt(i / SEG, here);
    roadAt((i + 1) / SEG, ahead);
    const dx = ahead.x - here.x;
    const dz = ahead.z - here.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = dz / len;
    const nz = -dx / len;

    const o = i * 6;
    pos[o] = here.x + nx * ROAD_W;
    pos[o + 1] = here.y - 0.06;
    pos[o + 2] = here.z + nz * ROAD_W;
    pos[o + 3] = here.x - nx * ROAD_W;
    pos[o + 4] = here.y - 0.06;
    pos[o + 5] = here.z - nz * ROAD_W;
    nor[o + 1] = 1;
    nor[o + 4] = 1;

    const a0 = i * 2;
    const a1 = i * 2 + 1;
    const b0 = ((i + 1) % SEG) * 2;
    const b1 = ((i + 1) % SEG) * 2 + 1;
    const j = i * 6;
    idx[j] = a0;
    idx[j + 1] = b0;
    idx[j + 2] = a1;
    idx[j + 3] = a1;
    idx[j + 4] = b0;
    idx[j + 5] = b1;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));

  return new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      color: SURFACE,
      roughness: 0.42,
      metalness: 0.75,
      side: THREE.DoubleSide,
    }),
  );
}

/** 行列がくぐる鳥居。道の GATE の地点に、進行方向へ向けて立てる。 */
function buildGate(): THREE.Group {
  roadAt(GATE, here);
  roadAt(GATE + DU, ahead);
  /**
   * 道の面からの高さ。
   *
   * 柱を地面（y=0）から立ててはいけない。鳥居を置いているのは丘の上で、
   * 道はそこで 3 ほど持ち上がっている。地面から立てると柱の下半分が道より下に伸び、
   * 行列が鳥居の中ほどをくぐっているように見えてしまう。
   *
   * 高さは、いちばん背の高い妖怪が貫に当たらないところから決める。
   * 袋の丈は 2.3、背丈の倍率の上限は 1.10 なので、道面から約 2.5。
   * 歩調の弾みと上端のゆらぎを足しても 2.8 には届かない。貫をその上（2.95）へ置くと、
   * 桁まで 3.8 要る。これ以上高くすると、並みの背丈の妖怪に対して門が過大に見える。
   */
  const top = 3.8;
  /**
   * 柱の間隔（半分）。道幅（1.7）に近づけないと、柱の足元に道が無くなって
   * 宙に立って見える。とはいえ狭くしすぎると、道幅いっぱいに広がった妖怪が
   * 柱をすり抜ける。妖怪の横方向の広がりは最大でも 1.6 なので、その外側へ置く。
   */
  const half = ROAD_W + 0.3;
  /** 柱を道の面より少しだけ下へ伸ばして、足元が浮いて見えないようにする。 */
  const foot = 0.4;

  const gate = new THREE.Group();
  gate.position.set(here.x, here.y - 0.06, here.z);
  // Y 回転をこう取ると、局所 +Z が進行方向、局所 +X が道幅方向になる
  gate.rotation.y = Math.atan2(ahead.x - here.x, ahead.z - here.z);

  const mat = new THREE.MeshStandardMaterial({
    color: emberColor(0.3),
    roughness: 0.62,
    metalness: 0.25,
  });

  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, top + foot, 0.3), mat);
    post.position.set(half * side, top / 2 - foot / 2, 0);
    gate.add(post);
  }
  const kasagi = new THREE.Mesh(new THREE.BoxGeometry(half * 2 + 1.1, 0.24, 0.36), mat);
  kasagi.position.y = top;
  gate.add(kasagi);
  const nuki = new THREE.Mesh(new THREE.BoxGeometry(half * 2 + 0.3, 0.16, 0.24), mat);
  nuki.position.y = top - 0.85;
  gate.add(nuki);

  return gate;
}

/** 破れたゴミ袋のような妖怪の行列が、うねる夜道をどこまでも巡っていく。 */
export const nightParade: SceneModule = {
  name: 'Night Parade',
  desc: '闇の環を練り歩くボロ袋の行列に、人魂が尾を引いて寄り添い漂う。',
  // 俯瞰しすぎると鳥居が潰れるので、環が見える高さぎりぎりまで下げている
  camera: { pos: [0, 15, 30], target: [0, 1.2, 0] },

  build(root) {
    ticks = tickers(COUNT);
    tickWind = ticker();
    dummy.rotation.order = 'YXZ';

    // 固定シード。開き直しても同じ顔ぶれの行列になる
    let s = 0.4137;
    const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);

    // 袋の形を決める値は、個体ごとに 1 度だけ決めてシェーダへ渡す。
    // 毎フレーム CPU から送り直す必要がないので、インスタンス属性として持たせる
    const phase = new Float32Array(COUNT);
    const gait = new Float32Array(COUNT);
    const neck = new Float32Array(COUNT);
    const knot = new Float32Array(COUNT);
    const twist = new Float32Array(COUNT);
    const seed = new Float32Array(COUNT);

    for (let i = 0; i < COUNT; i++) {
      const o = i * STRIDE;
      // 等間隔を基本にしつつ前後へ散らすと、詰まりと隙間ができて行列らしくなる
      oni[o] = (i + rnd() * 0.6 - 0.3) / COUNT;
      // 道幅いっぱいまで散らすと、鳥居の柱に触れる個体が出る
      oni[o + 1] = (rnd() * 2 - 1) * (ROAD_W - 0.8);
      const size = 0.55 + rnd() * 0.55;
      oni[o + 3] = 5.0 + rnd() * 2.8;
      oni[o + 4] = rnd() * TAU;
      // 背丈と横幅を逆に振る。背の高いものは痩せ、低いものは横に広がる。
      // 広げすぎると、背の低い個体の幅が丈に並んで歩く団子に見える
      const wide = 1.1 - 0.26 * ((size - 0.55) / 0.55) + (rnd() * 0.14 - 0.07);
      // 体を揺らす向き。左右に割れると、列全体が一方向へ揃って揺れない
      oni[o + 6] = rnd() < 0.5 ? -1 : 1;
      const k = rnd();
      const kind = k < 0.3 ? 1 : k < 0.52 ? 2 : 0;
      oni[o + 7] = kind;
      // 型 1（ずんぐり）だけは丈と幅も振り直す。輪郭の差は形の式より先に効く
      oni[o + 2] = kind === 1 ? size * 0.88 : size;
      oni[o + 5] = kind === 1 ? wide * 1.14 : wide;
      // 袋の明度のオフセット。狭いと帯が一色に貼り付くので、広めに振る
      oni[o + 8] = rnd() * 0.22 - 0.05;

      const preset = BAG_KIND[kind]!;
      phase[i] = oni[o + 4]!;
      gait[i] = oni[o + 3]!;
      neck[i] = preset[0] + (rnd() * 0.16 - 0.08);
      knot[i] = preset[1] + rnd() * 0.03;
      twist[i] = preset[2] * (0.7 + rnd() * 0.6) * (rnd() < 0.5 ? -1 : 1);
      // 皺と破れの種。ここが個体ごとに違うから、同じ袋が二つと無い
      seed[i] = rnd() * TAU;
    }

    for (let s = 0; s < SOULS; s++) {
      const o = s * SOUL_STRIDE;
      // 行列の全長へばらまく。等間隔から少し外すと、寄り集まる場所ができる
      soul[o] = (s + rnd() * 0.7 - 0.35) / SOULS;
      const rad = 1.3 + rnd() * 1.4;
      soul[o + 1] = rad;
      // 角速度は半径から割り出す。どの人魂も SOUL_SPEED で動くので尾が揃う
      soul[o + 2] = SOUL_SPEED / rad;
      soul[o + 3] = rnd() * TAU;
      soul[o + 4] = 1.5 + rnd() * 2.1;
      // 明るさに段を付ける。全部が同じ強さだと、どれが主役か割れてしまう
      soul[o + 5] = 0.5 + rnd() * 0.5;
    }

    // 袋。形は頂点シェーダが作るので、ここでは骨格と個体ごとの値だけ渡す
    const bag = buildBag();
    bag.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    bag.setAttribute('aGait', new THREE.InstancedBufferAttribute(gait, 1));
    bag.setAttribute('aNeck', new THREE.InstancedBufferAttribute(neck, 1));
    bag.setAttribute('aKnot', new THREE.InstancedBufferAttribute(knot, 1));
    bag.setAttribute('aTwist', new THREE.InstancedBufferAttribute(twist, 1));
    bag.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));

    bodies = new THREE.InstancedMesh(bag, bagMaterial(), COUNT);
    bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // 皺とゆらぎでシェーダが外へ膨らむので、CPU 側の外接球では足りない
    bodies.frustumCulled = false;
    root.add(bodies);

    // 人魂。粒は光そのものなので加算合成で重ね、深度も書かない。
    // 尾が重なったところが自然に明るくなり、ブルームがそこを芯として拾う
    const wispPoints = (count: number, size: number): THREE.Points => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
      const points = new THREE.Points(
        geo,
        new THREE.PointsMaterial({
          size,
          map: wispSprite(),
          vertexColors: true,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          sizeAttenuation: true,
        }),
      );
      // 粒は道の外まで漂うので、視錐台の判定を切って端で消えないようにする
      points.frustumCulled = false;
      return points;
    };

    // 尾を先に足して、頭の玉をその上へ重ねる
    souls = wispPoints(SOULS * TAIL, TAIL_SIZE);
    root.add(souls);
    cores = wispPoints(SOULS, CORE_SIZE);
    root.add(cores);

    // 人魂のいくつかに実光源を持たせる。通り過ぎたところだけ道と袋が明るむ
    lamps = [];
    for (let k = 0; k < LAMPS; k++) {
      const lamp = new THREE.PointLight(0xffa055, 26, 20, 2);
      lamps.push(lamp);
      root.add(lamp);
    }

    root.add(buildRoad());
    root.add(buildGate());

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(R * 2.4, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.3, metalness: 0.92 }),
    );
    floor.rotation.x = -Math.PI / 2;
    root.add(floor);
  },

  update(t) {
    const hue = drift(t);
    // 袋の形はシェーダが t から作り直す。CPU 側は時刻を渡すだけ
    bagTime.value = t;
    // 行列の先頭が道のどこにいるか。各自の位置に足すだけで、全員が同じ速さで進む
    const head = t / LAP;

    for (let i = 0; i < COUNT; i++) {
      const o = i * STRIDE;
      const size = oni[o + 2]!;
      const wide = oni[o + 5]!;
      const hand = oni[o + 6]!;
      const gait = t * oni[o + 3]! + oni[o + 4]!;

      const u = head + oni[o]!;
      roadAt(u, here);
      roadAt(u + DU, ahead);
      const dx = ahead.x - here.x;
      const dz = ahead.z - here.z;
      const len = Math.hypot(dx, dz) || 1;
      const tx = dx / len;
      const tz = dz / len;
      const nx = tz;
      const nz = -tx;

      const side = oni[o + 1]!;
      const bob = Math.abs(Math.sin(gait)) * 0.17 * size;
      const x = here.x + nx * side;
      // 裾は破れて途中から無くなっているので、そのぶん袋を道へ埋める。
      // 埋めないと、ぎざぎざの下端と道のあいだに隙間が空いて宙に浮く
      const y = here.y + bob - 0.14 * size;
      const z = here.z + nz * side;
      const yaw = Math.atan2(tx, tz);

      // 袋。丈と太さを別々に掛けるので、痩せた背高と低い横広が混ざる
      dummy.position.set(x, y, z);
      dummy.rotation.set(
        -0.05 - Math.sin(gait * 2) * 0.045, // 前のめりに、一歩ごとに頷く
        yaw,
        Math.sin(gait) * 0.12 * hand, // 左右の揺れ。踏み出す足が個体ごとに逆になる
      );
      dummy.scale.set(size * wide, size, size * wide);
      dummy.updateMatrix();
      bodies.setMatrixAt(i, dummy.matrix);

      // 袋は沈んだ色。個体ごとのオフセットに、歩調ぶんの明暗を足す。
      // ここを上げると袋が「赤い服」に見え始める。薄暗い塩化ビニルに見せるには、
      // 面の色は闇に沈めておいて、明るみは人魂の灯りだけに作らせるほうがよい
      ember(color, 0.09 + oni[o + 8]! + 0.06 * (0.5 + 0.5 * Math.sin(gait)), hue);
      bodies.setColorAt(i, color);
    }

    // 人魂。尾の粒 j は「その人魂が j·TAIL_DT 秒前にいた場所」
    const pos = souls.geometry.attributes.position as THREE.BufferAttribute;
    const col = souls.geometry.attributes.color as THREE.BufferAttribute;
    const cpos = cores.geometry.attributes.position as THREE.BufferAttribute;
    const ccol = cores.geometry.attributes.color as THREE.BufferAttribute;

    for (let s = 0; s < SOULS; s++) {
      const o = s * SOUL_STRIDE;
      // 息をするように強弱がつく。人魂ごとに位相をずらす
      const breath = (0.86 + 0.14 * Math.sin(t * 1.9 + soul[o + 3]! * 1.7)) * soul[o + 5]!;

      // 頭の玉。玉のまわりには尾の先頭数粒が必ず重なり、加算されて明るくなる。
      // 玉ひとつぶんで閾値を越えるところまで上げると、合計で赤が振り切れて
      // 芯が白へ張り付き、暖色帯から外れる。重なるぶんの余白を残しておく
      soulAt(s, t, wisp);
      cpos.setXYZ(s, wisp.x, wisp.y, wisp.z);
      ember(color, 0.54, hue);
      color.multiplyScalar(breath * 0.8);
      ccol.setXYZ(s, color.r, color.g, color.b);

      // 尾は j=1 から。j=0 を置くと頭の玉と同じ場所で加算されて白く飛ぶ
      for (let j = 1; j <= TAIL; j++) {
        soulAt(s, t - j * TAIL_DT, wisp);
        const g = s * TAIL + j - 1;
        pos.setXYZ(g, wisp.x, wisp.y, wisp.z);

        // 頭のすぐ後ろを明るく、尾の先へ向かって琥珀へ沈めながら消す。
        // 粒は隣どうし重なる大きさにしてあるので、1 粒あたりは十分暗くする。
        // 明るいまま重ねると尾が一様な白い帯になり、光の筋に見えなくなる
        const fade = 1 - j / (TAIL + 1);
        ember(color, 0.3 + 0.16 * fade, hue);
        color.multiplyScalar(fade * fade * breath * 0.26);
        col.setXYZ(g, color.r, color.g, color.b);
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    cpos.needsUpdate = true;
    ccol.needsUpdate = true;

    bodies.instanceMatrix.needsUpdate = true;
    if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;

    // 実光源は人魂そのものに持たせる。灯りと明るむ場所がずれない
    for (let k = 0; k < lamps.length; k++) {
      const lamp = lamps[k];
      if (!lamp) continue;
      soulAt(Math.floor((k * SOULS) / LAMPS), t, wisp);
      lamp.position.copy(wisp);
      lamp.intensity = 24 + Math.sin(t * 1.7 + k * 2.1) * 3;
    }
  },

  sound(t, _dt, sfx) {
    // 遠くの地鳴り。行列が続くあいだ途切れない
    sfx.drone(tone(-7), 0.05);

    const head = t / LAP;
    for (let i = 0; i < COUNT; i += SOUND_EVERY) {
      const tick = ticks[i];
      if (!tick) continue;
      // 位相が整数をまたぐ瞬間が、そのまま鳥居をくぐる瞬間になる
      for (let k = tick(head + oni[i * STRIDE]! - GATE); k > 0; k--) {
        sfx.pluck(tone(9 + ((i / SOUND_EVERY) % 5)), {
          gain: 0.22,
          decay: 2.8,
          pan: (oni[i * STRIDE + 1]! / ROAD_W) * 0.6,
        });
      }
    }

    for (let k = tickWind(t * 0.16); k > 0; k--) {
      sfx.air({ gain: 0.15, decay: 3.6, freq: 520, q: 0.9, sweep: -0.4 });
    }
  },
};
