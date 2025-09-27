import { createAction, props } from '@ngrx/store';
import type { OptionChain } from '../data/options-chain';
import type { FrameStats } from '../models/frame-stats';

export const dashboardFrameUpdate = createAction(
  '[Dashboard] Frame Update',
  props<{ chains: Record<string, OptionChain>; stats: FrameStats }>()
);

export const dashboardSelectMaturity = createAction(
  '[Dashboard] Select Maturity',
  props<{ maturity: string }>()
);
