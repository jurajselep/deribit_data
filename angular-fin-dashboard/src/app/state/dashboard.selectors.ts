import { createFeatureSelector, createSelector } from '@ngrx/store';
import { DASHBOARD_FEATURE_KEY, type DashboardState } from './dashboard.reducer';

export const selectDashboardState = createFeatureSelector<DashboardState>(DASHBOARD_FEATURE_KEY);

export const selectRows = createSelector(selectDashboardState, (state) => state.rows);
export const selectSummary = createSelector(selectDashboardState, (state) => state.summary);
export const selectFrameStats = createSelector(selectDashboardState, (state) => state.stats);
