import type * as THREE from 'three';
import type { Sfx } from './audio.ts';

/** 1つのアニメーションシーン。root 配下にだけオブジェクトを追加する。 */
export interface SceneModule {
  /** タブとタイトルに出す名前 */
  readonly name: string;
  /** タイトル下に出す1行説明 */
  readonly desc: string;
  /** このシーンでのカメラの定位置 */
  readonly camera: {
    readonly pos: readonly [number, number, number];
    readonly target: readonly [number, number, number];
  };
  /** シーン開始時に1度だけ呼ばれる。追加するものはすべて root の子にする。 */
  build(root: THREE.Group): void;
  /**
   * 毎フレーム呼ばれる。
   * @param t  このシーンが始まってからの経過秒（切替のたびに0へ戻る）
   * @param dt 前フレームからの経過秒
   */
  update(t: number, dt: number): void;
  /**
   * 音が ON のときだけ、update と同じ t で毎フレーム呼ばれる。
   *
   * 映像側で起きたことに合わせて鳴らしたいので、時刻から出来事を
   * 割り出す（ticker() が便利）。OFF の間は呼ばれないので、
   * ここに映像へ影響する処理は書かないこと。
   */
  sound?(t: number, dt: number, sfx: Sfx): void;
}
