import { createFeatureSelector, createSelector } from '@ngrx/store';
import { DASHBOARD_FEATURE_KEY, type DashboardState } from './dashboard.reducer';

export const selectDashboardState = createFeatureSelector<DashboardState>(DASHBOARD_FEATURE_KEY);

export const selectMaturities = createSelector(selectDashboardState, (state) => state.maturities);

export const selectSelectedMaturity = createSelector(selectDashboardState, (state) => state.selectedMaturity);

export const selectChains = createSelector(selectDashboardState, (state) => state.chains);

export const selectFrameStats = createSelector(selectDashboardState, (state) => state.stats);

export const selectSelectedChain = createSelector(
  selectChains,
  selectSelectedMaturity,
  (chains, maturity) => chains[maturity] ?? null
);

export const selectSelectedCurrency = createSelector(selectDashboardState, (state) => state.selectedCurrency);

export const selectInstruments = createSelector(selectDashboardState, (state) => state.instruments);

export const selectInstrumentsLoading = createSelector(selectDashboardState, (state) => state.instrumentsLoading);

export const selectInstrumentsError = createSelector(selectDashboardState, (state) => state.instrumentsError);

export const selectSelectedInstrument = createSelector(selectDashboardState, (state) => state.selectedInstrument);

export const selectInstrumentSummary = createSelector(selectDashboardState, (state) => state.instrumentSummary);

export const selectInstrumentSummaryLoading = createSelector(
  selectDashboardState,
  (state) => state.instrumentSummaryLoading
);

export const selectInstrumentSummaryError = createSelector(
  selectDashboardState,
  (state) => state.instrumentSummaryError
);
