/// <reference types="vite/client" />

/**
 * vite.config.ts のプラグインが配る「シーンの追加日」。
 * 中身は git の履歴（scripts/scene-order.mjs）から作られる。
 */
declare module 'virtual:scene-added-at' {
  /** { camelCase 名: 追加された epoch 秒 }。まだコミットしていないシーンは入っていない。 */
  export const ADDED_AT: Record<string, number>;
}
