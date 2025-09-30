import { createAction, props } from '@ngrx/store';
import type { OptionChain, MaturityInfo } from '../data/options-chain';
import type { FrameStats } from '../models/frame-stats';
import type { DeribitInstrument, DeribitInstrumentSummary } from '../models/deribit';

export const dashboardFrameUpdate = createAction(
  '[Dashboard] Frame Update',
  props<{ chains: Record<string, OptionChain>; stats: FrameStats }>()
);

export const dashboardSelectMaturity = createAction(
  '[Dashboard] Select Maturity',
  props<{ maturity: string }>()
);

export const dashboardSetMaturities = createAction(
  '[Dashboard] Set Maturities',
  props<{ maturities: MaturityInfo[] }>()
);

export const dashboardLoadInstruments = createAction(
  '[Dashboard] Load Instruments',
  props<{ currency: string }>()
);

export const dashboardLoadInstrumentsSuccess = createAction(
  '[Dashboard] Load Instruments Success',
  props<{ instruments: DeribitInstrument[] }>()
);

export const dashboardLoadInstrumentsFailure = createAction(
  '[Dashboard] Load Instruments Failure',
  props<{ error: string }>()
);

export const dashboardSelectInstrument = createAction(
  '[Dashboard] Select Instrument',
  props<{ instrument: string | null }>()
);

export const dashboardInstrumentSummaryLoad = createAction(
  '[Dashboard] Instrument Summary Load',
  props<{ instrument: string }>()
);

export const dashboardInstrumentSummarySuccess = createAction(
  '[Dashboard] Instrument Summary Success',
  props<{ summary: DeribitInstrumentSummary | null }>()
);

export const dashboardInstrumentSummaryFailure = createAction(
  '[Dashboard] Instrument Summary Failure',
  props<{ error: string }>()
);

export const dashboardInstrumentSummaryUpdate = createAction(
  '[Dashboard] Instrument Summary Update',
  props<{ summary: DeribitInstrumentSummary | null }>()
);

export const dashboardChainsUpdate = createAction(
  '[Dashboard] Chains Update',
  props<{ chains: Record<string, OptionChain> }>()
);

export const dashboardSelectCurrency = createAction(
  '[Dashboard] Select Currency',
  props<{ currency: string }>()
);
