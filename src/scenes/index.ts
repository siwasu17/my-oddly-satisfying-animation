import type { SceneModule } from '../types.ts';
import { waveLattice } from './waveLattice.ts';
import { flipGarden } from './flipGarden.ts';
import { twistColumn } from './twistColumn.ts';
import { breathingRings } from './breathingRings.ts';
import { rainRings } from './rainRings.ts';
import { silkSheet } from './silkSheet.ts';
import { dominoRing } from './dominoRing.ts';
import { driftingBubbles } from './driftingBubbles.ts';
import { braidedHelix } from './braidedHelix.ts';
import { gimbalRings } from './gimbalRings.ts';
import { curtainWave } from './curtainWave.ts';
import { lightCorridor } from './lightCorridor.ts';
import { marbleMachine } from './marbleMachine.ts';

/**
 * タブと数字キーの並び順。
 *
 * 動きの質が続けて似ないよう、面で見せるものと線で見せるものを交互にしている。
 * 先頭 4 つは URL の #1〜#4 が変わらないよう、初版の順のまま置いている。
 */
export const SCENES: readonly SceneModule[] = [
  waveLattice,
  flipGarden,
  twistColumn,
  breathingRings,
  rainRings,
  silkSheet,
  dominoRing,
  driftingBubbles,
  braidedHelix,
  gimbalRings,
  curtainWave,
  lightCorridor,
  marbleMachine,
];
