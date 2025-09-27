import { createAction, props } from '@ngrx/store';
import type { TickerRow, TickerSummary } from '../data/generate-tickers';
import type { FrameStats } from '../models/frame-stats';

export const dashboardFrameUpdate = createAction(
  '[Dashboard] Frame Update',
  props<{ rows: TickerRow[]; summary: TickerSummary; stats: FrameStats }>()
);
