import * as THREE from 'three';

/**
 * 入眠前に眺めることを前提にした暖色パレット。
 *
 * 青い光は覚醒を促すので、色相を「くすんだ薔薇 → 赤 → 琥珀」の帯に閉じ込め、
 * 彩度と明度も低めに抑えている。シーン側で HSL を直に組み立てず、
 * ここの関数を通すことで 16 シーン全体の色味が揃う。
 */

/** 背景。ほぼ黒だが、青みを消すためにわずかに暖色へ寄せている。 */
export const BG = 0x080607;

/** 床や支柱など、光らない構造物の色。 */
export const SURFACE = 0x0e0a0a;

/** 色相の帯。負の値は 0.925（淡い薔薇）を意味し、そこから 0.11（琥珀）まで。 */
const HUE_LOW = -0.075;
const HUE_HIGH = 0.11;

/** 暗いところは色を濃く、明るいところは白熱寄りに脱色する。 */
const SAT_LOW = 0.55;
const SAT_HIGH = 0.34;

/** 明度の下限・上限。上限を 0.6 未満にしておくと画面が眩しくならない。 */
const LIGHT_LOW = 0.11;
const LIGHT_HIGH = 0.55;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * 0..1 の値を暖色帯の 1 色へ写して out に書き込む。
 *
 * @param n     0 = 暗い薔薇色、1 = 明るい琥珀色
 * @param shift 色相のずらし幅。帯からはみ出さないよう ±0.04 程度までに留める。
 * @param glow  明度への加算。強調したいところだけ少し持ち上げる。
 */
export function ember(out: THREE.Color, n: number, shift = 0, glow = 0): THREE.Color {
  const k = clamp01(n);
  const h = (((HUE_LOW + (HUE_HIGH - HUE_LOW) * k + shift) % 1) + 1) % 1;
  const s = SAT_LOW + (SAT_HIGH - SAT_LOW) * k;
  const l = clamp01(LIGHT_LOW + (LIGHT_HIGH - LIGHT_LOW) * k + glow);
  return out.setHSL(h, s, l);
}

/** ember() に渡す色相のゆらぎ。数十秒かけて往復するだけで、一周はしない。 */
export function drift(t: number, speed = 0.05, amount = 0.03): number {
  return Math.sin(t * speed * Math.PI * 2) * amount;
}

/** 新しい Color を返す版。build() の中で 1 度だけ色を決めるとき用。 */
export function emberColor(n: number, shift = 0, glow = 0): THREE.Color {
  return ember(new THREE.Color(), n, shift, glow);
}
