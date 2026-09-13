import * as THREE from 'three';
import type { SceneModule } from '../types.ts';
import { tone, tickers } from '../audio.ts';
import { SURFACE, ember, emberColor, drift } from '../palette.ts';

/**
 * Lava Lamp。
 *
 * 何が動くか: ガラス筒の底に溜まった蝋が盛り上がり、細い首を引きながら
 * ちぎれて塊になり、天井近くまで昇って冷え、平たくなって沈み、また溜まりへ融け戻る。
 * 気持ちよさの芯: 塊が母体から離れる瞬間の「首が細くなってふっと切れる」ところ。
 * ループの周期: 塊 1 つが一巡するのに約 30 秒。塊ごとに周期と位相をずらしてあるので、
 * 画面のどこかでは常に何かが起きていて、全体としては同じ絵が戻ってこない。
 * カメラ: ランプの高さの中ほどから、少し斜めに見る。
 * 音: ちぎれた瞬間と融け戻った瞬間に水滴を 1 つ。底のヒーターに見立てた低い持続音。
 *
 * 蝋だけはメッシュを持たない。ガラス筒の内側を包む円筒を 1 つ置き、その画素から
 * レイを飛ばして距離関数（SDF）を追いかけている。塊・首・底の溜まりを
 * 滑らかな合成（smooth union）で 1 つの面にまとめているので、つなぎ目という概念が無い。
 * 首は本当に地続きで、細らせればひとりでにちぎれ、近づいた塊は勝手に融け合う。
 * 面が見つかった画素は gl_FragDepth に本当の深さを書くので、台座や笠との前後も狂わない。
 *
 * スコープ外: 流体の計算。塊の軌跡は時刻の関数で、蝋の粘りは距離関数の丸め幅で代用している。
 */

/** 上下する塊の数 */
const BLOBS = 6;

/** 1 つの塊が一巡する秒数 */
const CYCLE = 30;
/** 首がちぎれる位相 */
const BREAK = 0.2;
/** 上昇を終える位相 */
const RISE = 0.5;
/** 天井での滞留を終える位相 */
const HANG = 0.66;
/** 母体へ首をつなぎ直し始める位相 */
const MERGE = 0.9;

/** ガラス筒の下端・上端の高さと、そこでの半径 */
const GLASS_BOTTOM = 2;
const GLASS_TOP = 17;
const GLASS_R_LOW = 3.6;
const GLASS_R_HIGH = 2.4;

/** 底の溜まりの上面・厚み（半分）・半径 */
const POOL_SURF = 3.2;
const POOL_H = 1.05;
const POOL_R = 3.1;
/** 溜まりの縁の丸み。円盤の角をこの半径で落とす。 */
const POOL_RB = 0.85;

/** 首の付け根の高さ。溜まりの上面より少しだけ内側に潜らせてある。 */
const FOOT_Y = POOL_SURF - 0.3;

/** 塊の中心が生まれる高さ（溜まりに半ば埋もれた位置）と、昇りきる高さ */
const Y_LOW = POOL_SURF - 0.45;
const Y_HIGH = GLASS_TOP - 1.9;

/** レイを走らせる範囲。ガラス筒の内側をちょうど包む円筒。 */
const VOL_R = GLASS_R_LOW;
const VOL_BOTTOM = GLASS_BOTTOM - 0.6;
const VOL_TOP = GLASS_TOP;

/** レイマーチの最大ステップ数。塊は疎らなので、この程度で輪郭が出る。 */
const STEPS = 72;
/** 1 歩の安全率。距離関数を smooth union で丸めた分だけ、素直に進むと行き過ぎる。 */
const STRIDE = 0.82;
/** 面に当たったとみなす距離。カメラからの距離に比例させ、遠景でざらつかせない。 */
const HIT_EPS = '0.0016';

/** 距離関数を合成するときの丸め幅。大きいほど蝋が粘る。 */
const K_BLOB = 0.34;
const K_NECK = 0.52;

/**
 * 蝋の色。ember() に渡す値の下限（天井で冷えきった塊）と上限（底で熱せられた蝋）。
 * update() が作る heat の値域とぴったり同じにしてある。ずれると帯の端で色が張り付く。
 */
const HEAT_LOW = 0.32;
const HEAT_HIGH = 0.76;
/** 底の溜まりの熱。ヒーターの真上なので、帯のいちばん熱い側に置く。 */
const POOL_HEAT = HEAT_HIGH;

/**
 * 灯りの色味。半球光・キーライト側（uWarm）と、台座の電球側（uGlow）。
 *
 * ここで作る色は THREE.Color.setHSL() が書くのでリニア作業空間の値になる
 * （setHex() と違って sRGB からの変換が挟まらない）。シェーダはその値をそのまま
 * 受け取るので、明るさは色ではなく下の照明式の係数だけで決めている。
 */
const LIGHT_WARM = 0.62;
const LIGHT_GLOW = 0.72;

/** 台座の中の電球の高さ。GLSL 側の照明もここを光源とする。 */
const BULB_Y = POOL_SURF - 1.4;

/** 塊ごとの [位相, 半径, 周期の倍率, 横揺れの位相, 横揺れの幅] */
const blobs = new Float32Array(BLOBS * 5);

/** ちぎれた瞬間・融け戻った瞬間を数える。build のたびに作り直す。 */
let breakTicks = tickers(BLOBS);
let mergeTicks = tickers(BLOBS);

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number): number => x * x * (3 - 2 * x);
const lerp = (a: number, b: number, x: number): number => a + (b - a) * x;
/** 区間 [a,b) の中での進み具合を 0..1 で返す */
const seg = (u: number, a: number, b: number): number => clamp01((u - a) / (b - a));

/** その高さでのガラス内壁の半径 */
const wallR = (y: number): number =>
  lerp(GLASS_R_LOW, GLASS_R_HIGH, clamp01((y - GLASS_BOTTOM) / (GLASS_TOP - GLASS_BOTTOM)));

/** ember() に渡す熱の値を、シェーダが使う 0..1 へ写す */
const shadeOf = (heat: number): number => clamp01((heat - HEAT_LOW) / (HEAT_HIGH - HEAT_LOW));

// ---------------------------------------------------------------------------
// 蝋を描くシェーダ
// ---------------------------------------------------------------------------

const VERT = /* glsl */ `
varying vec3 vWorld;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
#define BLOBS ${BLOBS}

// 画素シェーダには自動で入ってこない（viewMatrix と cameraPosition は three が入れる）
uniform mat4 projectionMatrix;

uniform vec4 uBlob[BLOBS];   // xyz = 中心, w = 半径
uniform vec4 uShape[BLOBS];  // x = 縦の伸び, y = 首の太さ(0..1), z = 熱(0..1)
uniform vec4 uPool;          // x = 芯の中心の高さ, y = 芯の半径, z = 芯の半分の厚み, w = 揺らぎの位相
uniform vec3 uCool;          // 冷えた蝋の色
uniform vec3 uHot;           // 熱せられた蝋の色
uniform vec3 uWarm;          // 半球光とキーライトの色味
uniform vec3 uGlow;          // 台座の電球の色味
uniform vec3 uSpec;          // ハイライトの色
uniform vec3 uBulb;          // 台座の電球の位置
uniform vec3 fogColor;
uniform float fogDensity;

varying vec3 vWorld;

/** 楕円体。半径で割って正規化した距離なので厳密ではないが、丸い形なら十分近い。 */
float sdEllipsoid(vec3 p, vec3 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-6);
}

/** 角を rb で丸めた円盤。底の溜まりに使う。 */
float sdRoundedCylinder(vec3 p, float ra, float rb, float h) {
  vec2 d = vec2(length(p.xz) - ra, abs(p.y) - h);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - rb;
}

/** 先細りのカプセル。溜まりから塊へ伸びる首に使う。 */
float sdRoundCone(vec3 p, vec3 a, vec3 b, float r1, float r2) {
  vec3 ba = b - a;
  float l2 = max(dot(ba, ba), 1e-4);
  float rr = r1 - r2;
  float a2 = l2 - rr * rr;
  float il2 = 1.0 / l2;

  vec3 pa = p - a;
  float y = dot(pa, ba);
  float z = y - l2;
  vec3 xp = pa * l2 - ba * y;
  float x2 = dot(xp, xp);
  float y2 = y * y * l2;
  float z2 = z * z * l2;

  float k = sign(rr) * rr * rr * x2;
  if (sign(z) * a2 * z2 > k) return sqrt(x2 + z2) * il2 - r2;
  if (sign(y) * a2 * y2 < k) return sqrt(x2 + y2) * il2 - r1;
  return (sqrt(max(x2 * a2 * il2, 0.0)) + y * rr) * il2 - r1;
}

/**
 * 距離と熱をまとめて滑らかに混ぜる。
 * 距離の丸めに使った重みをそのまま色にも使うので、融けた境目では色も溶け合う。
 */
vec2 smin2(vec2 a, vec2 b, float k) {
  float h = clamp(0.5 + 0.5 * (b.x - a.x) / k, 0.0, 1.0);
  return vec2(mix(b.x, a.x, h) - k * h * (1.0 - h), mix(b.y, a.y, h));
}

/** 蝋の全体。x = 距離、y = 熱（0 = 冷えている、1 = 熱い）。 */
vec2 map(vec3 p) {
  // 底の溜まり。上面を長い波でうねらせる（振幅は丸め幅よりずっと小さく取る）
  vec3 q = p - vec3(0.0, uPool.x, 0.0);
  float ripple = 0.09 * sin(p.x * 0.9 + uPool.w) * sin(p.z * 1.1 - uPool.w * 0.8);
  vec2 res = vec2(
    sdRoundedCylinder(q, uPool.y, ${POOL_RB.toFixed(2)}, uPool.z) - ripple,
    ${shadeOf(POOL_HEAT).toFixed(2)}
  );

  for (int i = 0; i < BLOBS; i++) {
    vec4 b = uBlob[i];
    vec4 s = uShape[i];

    // 昇るときは縦に伸び、冷えて沈むときは平たくなる
    float e = s.x;
    vec3 rad = vec3(b.w / sqrt(e), b.w * e, b.w / sqrt(e));
    res = smin2(res, vec2(sdEllipsoid(p - b.xyz, rad), s.z), ${K_BLOB.toFixed(2)});

    // 首。太さが 0 に近づいたら畳んでしまう（細い糸を残さない）
    if (s.y > 0.02) {
      vec3 foot = vec3(b.x * 0.12, ${FOOT_Y.toFixed(2)}, b.z * 0.12);
      float nr = b.w * s.y;
      float dn = sdRoundCone(p, foot, b.xyz, nr * 0.82, nr * 0.42);
      res = smin2(res, vec2(dn, mix(${shadeOf(POOL_HEAT).toFixed(2)}, s.z, 0.45)), ${K_NECK.toFixed(2)});
    }
  }

  return res;
}

vec3 calcNormal(vec3 p) {
  vec2 e = vec2(1.0, -1.0) * 0.0022;
  return normalize(
    e.xyy * map(p + e.xyy).x +
    e.yyx * map(p + e.yyx).x +
    e.yxy * map(p + e.yxy).x +
    e.xxx * map(p + e.xxx).x
  );
}

/** レイがガラス筒の内側にいる区間 [入口, 出口]。空なら y < x で返る。 */
vec2 volumeSpan(vec3 ro, vec3 rd) {
  float a = max(dot(rd.xz, rd.xz), 1e-6);
  float b = dot(ro.xz, rd.xz);
  float c = dot(ro.xz, ro.xz) - ${VOL_R.toFixed(2)} * ${VOL_R.toFixed(2)};
  float disc = b * b - a * c;
  if (disc < 0.0) return vec2(1.0, -1.0);

  float s = sqrt(disc);
  float t0 = (-b - s) / a;
  float t1 = (-b + s) / a;

  // 真横へ飛ぶレイで 0 除算しないよう、符号を保ったまま床を張る
  float ry = rd.y >= 0.0 ? max(rd.y, 1e-5) : min(rd.y, -1e-5);
  float ta = (${VOL_BOTTOM.toFixed(2)} - ro.y) / ry;
  float tb = (${VOL_TOP.toFixed(2)} - ro.y) / ry;

  return vec2(max(t0, min(ta, tb)), min(t1, max(ta, tb)));
}

void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - ro);

  vec2 span = volumeSpan(ro, rd);
  float t = max(span.x, 0.0);
  if (span.y <= t) discard;

  // 距離が縮まらなくなるまで歩く。当たり判定は距離に比例させ、遠景でざらつかせない
  float hit = -1.0;
  float heat = 0.0;
  float edge = 1.0;
  // かすっただけの画素を拾うための、道中いちばん面に近づいた地点
  float near = 1e9;
  float nearT = 0.0;
  float nearHeat = 0.0;
  for (int i = 0; i < ${STEPS}; i++) {
    vec2 m = map(ro + rd * t);
    float rel = m.x / t; // 見かけの太さ。遠くの細い部分ほど小さくなる
    if (rel < near) {
      near = rel;
      nearT = t;
      nearHeat = m.y;
    }
    if (rel < ${HIT_EPS}) {
      hit = t;
      heat = m.y;
      break;
    }
    t += m.x * ${STRIDE.toFixed(2)};
    if (t > span.y) break;
  }

  // 当たらなかった画素も、面をかすめていれば薄く描く。
  // レイマーチの輪郭には MSAA が効かないので、こうしないと縁が階段状になる
  if (hit < 0.0) {
    if (near > ${HIT_EPS} * 3.0) discard;
    hit = nearT;
    heat = nearHeat;
    edge = 1.0 - smoothstep(${HIT_EPS}, ${HIT_EPS} * 3.0, near);
  }

  vec3 pos = ro + rd * hit;
  vec3 n = calcNormal(pos);
  vec3 v = -rd;
  vec3 base = mix(uCool, uHot, heat);

  // 台座の電球。蝋のほとんどはこの 1 灯で見えている
  vec3 ld = uBulb - pos;
  float dd = max(length(ld), 0.8);
  vec3 l = ld / dd;
  // 逆 2 乗のままだと底だけが白く飛ぶので、分母に下駄を履かせ、上にも蓋をする
  float att = min(3.0 / (1.0 + 0.5 * dd * dd), 1.0);
  float dif = max(dot(n, l), 0.0);

  // 上からのキーライトと半球光。stage.ts の 2 灯と向きを揃えてある
  vec3 kd = normalize(vec3(0.35, 0.88, 0.42));
  float key = max(dot(n, kd), 0.0);
  float sky = 0.5 * n.y + 0.5;

  // 透け。電球の側へ潜ってまだ蝋の中なら、それだけ厚い
  float thick = clamp(-map(pos + l * 0.5).x, 0.0, 1.0)
              + clamp(-map(pos + l * 1.2).x, 0.0, 1.0) * 0.6;
  float sss = exp(-thick * 1.7);

  // ぬめり。蝋は濡れた面なので、ハイライトは 2 灯ぶん拾う
  // ぬめり。蝋は濡れた面なので、ハイライトは電球とキーライトの 2 灯ぶん拾う。
  // 溜まりの上面は広く平らなので、キー側の山を鋭くしないと面ごと白く飛ぶ
  float spec = pow(max(dot(n, normalize(l + v)), 0.0), 46.0) * att
             + pow(max(dot(n, normalize(kd + v)), 0.0), 60.0) * 0.5;
  float fre = pow(1.0 - max(dot(n, v), 0.0), 3.2);

  // 光の色をすべて蝋の色に掛けてから足す。白い項を足すと暖色帯から外れて灰色に濁る
  vec3 col = base * uWarm * (0.18 + 0.36 * sky);  // 半球光
  col += base * uWarm * key * 0.52;               // キーライト
  col += base * uGlow * dif * att * 0.55;         // 電球の直射
  col += base * uGlow * sss * att * 0.28;         // 内側から灯る
  col += uSpec * spec * 0.18;                     // ぬめりのハイライト
  col += base * uGlow * fre * 0.35;               // 縁の照り返し

  // 霧。ステージの FogExp2 と同じ式を、当たった点までの距離で解く
  float fogF = 1.0 - exp(-fogDensity * fogDensity * hit * hit);
  gl_FragColor = vec4(mix(col, fogColor, fogF), edge);

  // 台座や笠との前後が狂わないよう、包みの深さではなく当たった点の深さを書く
  vec4 clip = projectionMatrix * viewMatrix * vec4(pos, 1.0);
  gl_FragDepth = clip.z / clip.w * 0.5 + 0.5;
}
`;

/** シェーダへ渡す入れ物。update では中身だけ書き換える。 */
let uBlob: THREE.Vector4[] = [];
let uShape: THREE.Vector4[] = [];
let uPool = new THREE.Vector4();
let uCool = new THREE.Color();
let uHot = new THREE.Color();
let uWarm = new THREE.Color();
let uGlow = new THREE.Color();
let uSpec = new THREE.Color();

export const lavaLamp: SceneModule = {
  name: 'Lava Lamp',
  desc: '底の蝋が盛り上がってちぎれ、ゆっくり昇り、冷えて平たくなって沈む。',
  camera: { pos: [6.5, 9.5, 30], target: [0, 8.2, 0] },

  build(root) {
    breakTicks = tickers(BLOBS);
    mergeTicks = tickers(BLOBS);

    let s = 0.417;
    const rnd = (): number => (s = (s * 9301 + 0.49297) % 1);

    for (let i = 0; i < BLOBS; i++) {
      // 位相は均等割りを基準に少しだけ散らす（塊が団子にならない程度に）
      blobs[i * 5] = i / BLOBS + (rnd() - 0.5) * 0.06;
      blobs[i * 5 + 1] = 0.66 + rnd() * 0.5; // 半径
      blobs[i * 5 + 2] = 0.82 + rnd() * 0.46; // 周期の倍率。大きいほどゆっくり
      blobs[i * 5 + 3] = rnd() * Math.PI * 2; // 横揺れの位相
      blobs[i * 5 + 4] = 0.5 + rnd() * 0.7; // 横揺れの幅
    }

    // --- 蝋（レイマーチ） ---------------------------------------------------
    uBlob = Array.from({ length: BLOBS }, () => new THREE.Vector4());
    uShape = Array.from({ length: BLOBS }, () => new THREE.Vector4(1, 0, 0.5, 0));
    uPool = new THREE.Vector4(POOL_SURF - POOL_H, POOL_R - POOL_RB, POOL_H - POOL_RB, 0);
    uCool = emberColor(HEAT_LOW);
    uHot = emberColor(HEAT_HIGH);
    // 灯りの色は動かさない。蝋の側だけを drift させないと、色のふらつきが二重になる
    uWarm = emberColor(LIGHT_WARM);
    uGlow = emberColor(LIGHT_GLOW);
    uSpec = emberColor(1, 0, 0.3);

    const wax = new THREE.Mesh(
      // レイの入口と出口は式で解くので、この筒は「どの画素を走らせるか」を決めるだけ
      new THREE.CylinderGeometry(VOL_R, VOL_R, VOL_TOP - VOL_BOTTOM, 32, 1),
      new THREE.ShaderMaterial({
        // fogColor / fogDensity にはステージの霧の値が毎フレーム入る
        uniforms: THREE.UniformsUtils.merge([
          THREE.UniformsLib.fog,
          {
            uBlob: { value: null },
            uShape: { value: null },
            uPool: { value: null },
            uCool: { value: null },
            uHot: { value: null },
            uWarm: { value: null },
            uGlow: { value: null },
            uSpec: { value: null },
            uBulb: { value: null },
          },
        ]),
        vertexShader: VERT,
        fragmentShader: FRAG,
        // three は ShaderMaterial を GLSL 3.0 へ変換して渡すので、gl_FragDepth はそのまま書ける
        // カメラが筒の中へ入っても描けるよう、内側の面で走らせる
        side: THREE.BackSide,
        fog: true,
        // 輪郭の 1 画素だけを薄くする。深さは書くので、ガラスとの前後は保たれる
        transparent: true,
        depthWrite: true,
      }),
    );
    const mat = wax.material as THREE.ShaderMaterial;
    mat.uniforms.uBlob!.value = uBlob;
    mat.uniforms.uShape!.value = uShape;
    mat.uniforms.uPool!.value = uPool;
    mat.uniforms.uCool!.value = uCool;
    mat.uniforms.uHot!.value = uHot;
    mat.uniforms.uWarm!.value = uWarm;
    mat.uniforms.uGlow!.value = uGlow;
    mat.uniforms.uSpec!.value = uSpec;
    mat.uniforms.uBulb!.value = new THREE.Vector3(0, BULB_Y, 0);
    wax.position.y = (VOL_BOTTOM + VOL_TOP) / 2;
    wax.renderOrder = 1; // ガラス（2）より先に描く
    root.add(wax);

    // --- ガラスと金具 -------------------------------------------------------
    // ガラス筒。中身が透けるよう depthWrite を切り、最後に描く
    const glass = new THREE.Mesh(
      new THREE.CylinderGeometry(GLASS_R_HIGH, GLASS_R_LOW, GLASS_TOP - GLASS_BOTTOM, 56, 1, true),
      new THREE.MeshStandardMaterial({
        color: 0xffd8bb,
        roughness: 0.08,
        metalness: 0.85,
        transparent: true,
        opacity: 0.11,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    glass.position.y = (GLASS_BOTTOM + GLASS_TOP) / 2;
    glass.renderOrder = 2;
    root.add(glass);

    // 台座と笠。真っ黒だと闇に溶けるので、いちばん暗い暖色を薄く乗せてある
    const metal = new THREE.MeshStandardMaterial({
      color: emberColor(0.2),
      roughness: 0.34,
      metalness: 0.86,
    });

    // ガラスの端を隠して形を締める
    const base = new THREE.Mesh(new THREE.CylinderGeometry(3.7, 4.7, 2.1, 56), metal);
    base.position.y = 1.02;
    root.add(base);

    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 3.3, 1.7, 56), metal);
    cap.position.y = GLASS_TOP + 0.8;
    root.add(cap);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(15, 96),
      new THREE.MeshStandardMaterial({ color: SURFACE, roughness: 0.26, metalness: 0.9 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    root.add(floor);

    // 台座の中の電球。ガラスと金具を照らす（蝋の陰影はシェーダ側で同じ位置から作る）
    const bulb = new THREE.PointLight(0xff9a5a, 26, 18, 2);
    bulb.position.set(0, BULB_Y, 0);
    root.add(bulb);
  },

  update(t) {
    const hue = drift(t);
    ember(uCool, HEAT_LOW, hue);
    ember(uHot, HEAT_HIGH, hue);
    let bulge = 0; // 誕生・合流の分だけ溜まりが盛り上がる

    for (let i = 0; i < BLOBS; i++) {
      const r = blobs[i * 5 + 1]!;
      const raw = t / (CYCLE * blobs[i * 5 + 2]!) + blobs[i * 5]!;
      const u = raw - Math.floor(raw);

      // 高さ。生まれる → 昇る → 天井で漂う → 沈む、を区間ごとに補間する
      let y: number;
      if (u < BREAK) y = lerp(Y_LOW, Y_LOW + 2.9, smooth(seg(u, 0, BREAK)));
      else if (u < RISE) y = lerp(Y_LOW + 2.9, Y_HIGH, smooth(seg(u, BREAK, RISE)));
      else if (u < HANG) y = Y_HIGH - 0.22 * Math.sin(seg(u, RISE, HANG) * Math.PI);
      // 沈むときは底へ近づくほど速い。ここを減速させると塊が底に溜まって団子になる
      else y = lerp(Y_HIGH, Y_LOW, Math.pow(seg(u, HANG, 1), 1.7));

      // 横揺れ。ガラスの内壁にめり込まない範囲へ押し戻す
      const ph = blobs[i * 5 + 3]!;
      const sway = blobs[i * 5 + 4]!;
      const room = Math.max(0, wallR(y) - r - 0.35);
      // 塊ごとに軸から少しずらした定位置を持たせ、縦一列に重ならないようにする
      const sx = Math.cos(ph) * 0.85 + Math.sin(t * 0.21 + ph) * sway;
      const sz = Math.sin(ph) * 0.85 + Math.cos(t * 0.17 + ph * 1.7) * sway;
      const d = Math.hypot(sx, sz);
      const k = d > room ? room / d : 1;
      const bx = sx * k;
      const bz = sz * k;

      // 母体とのつながり。1 = 一続き、0 = 完全に離れている
      const link = u < BREAK ? 1 - smooth(seg(u, 0, BREAK)) : smooth(seg(u, MERGE, 1));
      bulge += link * r * 0.42;

      // 昇るときは縦に伸び、冷えて沈むときは平たくなる。
      // 首を引いている間はさらに伸ばして、ちぎれる手前の張りを見せる
      const e = 1 + 0.26 * Math.sin(u * Math.PI * 2) + 0.14 * link * link;
      // 高いところほど冷えている
      const heat = 0.76 - 0.44 * clamp01((y - Y_LOW) / (Y_HIGH - Y_LOW));

      uBlob[i]!.set(bx, y, bz, r);
      // 首は link より速く細らせる。最後のひと息で「ふっ」と切れて見える
      uShape[i]!.set(e, link * link * link, shadeOf(heat), 0);
    }

    // 溜まりの厚み。塊が生まれる前と融け戻るときに持ち上がる
    const half = POOL_H * (1 + Math.min(0.55, bulge));
    uPool.set(POOL_SURF - half, POOL_R - POOL_RB, Math.max(half - POOL_RB, 0.02), t * 0.55);
  },

  sound(t, _dt, sfx) {
    // 台座の中で灯りっぱなしのヒーター
    sfx.drone(tone(-3), 0.05);

    for (let i = 0; i < BLOBS; i++) {
      const raw = t / (CYCLE * blobs[i * 5 + 2]!) + blobs[i * 5]!;
      const pan = Math.sin(i * 1.9) * 0.5;

      // ちぎれた瞬間（位相が BREAK をまたぐ）
      for (let n = breakTicks[i]!(raw - BREAK); n > 0; n--) {
        sfx.drop(tone(4 + (i % 3)), { gain: 0.24, decay: 2.6, pan, bend: -0.35 });
      }
      // 溜まりへ融け戻った瞬間（位相が 0 をまたぐ）
      for (let n = mergeTicks[i]!(raw); n > 0; n--) {
        sfx.drop(tone(-1 + (i % 2)), { gain: 0.2, decay: 3.4, pan: -pan });
      }
    }
  },
};
