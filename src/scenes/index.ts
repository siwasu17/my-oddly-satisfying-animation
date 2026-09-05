import type { SceneModule } from '../types.ts';
import { waveLattice } from './waveLattice.ts';
import { flipGarden } from './flipGarden.ts';
import { pendulumWave } from './pendulumWave.ts';
import { breathingRings } from './breathingRings.ts';

/** タブと数字キーの並び順 */
export const SCENES: readonly SceneModule[] = [
  waveLattice,
  flipGarden,
  pendulumWave,
  breathingRings,
];
