/** scripts/scene-order.mjs の型（vite.config.ts から import するため。.mjs の隣に置くので拡張子は .d.mts）。 */

/** { camelCase 名: 追加された epoch 秒 }。git の履歴を読めなければ空。 */
export function sceneAddedAt(cwd?: string): Record<string, number>;

/** 追加が新しいものほど前に来る比較関数。履歴に無いものは先頭。 */
export function compareScenes(
  addedAt: Record<string, number>,
): (a: string, b: string) => number;
