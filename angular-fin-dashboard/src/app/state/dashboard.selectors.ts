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
  (chains, maturity) => chains[maturity]
);
