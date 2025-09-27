import { createReducer, on } from '@ngrx/store';
import { dashboardFrameUpdate } from './dashboard.actions';
import { createInitialStats, FrameStats } from '../models/frame-stats';
import { nextTickerSlice, type TickerRow, type TickerSummary } from '../data/generate-tickers';
import { ROW_COUNT } from '../constants';

export interface DashboardState {
  rows: TickerRow[];
  summary: TickerSummary;
  stats: FrameStats;
}

export const DASHBOARD_FEATURE_KEY = 'dashboard' as const;

const initialSnapshot = nextTickerSlice(ROW_COUNT);

const cloneRows = (rows: TickerRow[]): TickerRow[] =>
  rows.map((row) => ({ ...row }));

const cloneSummary = (summary: TickerSummary): TickerSummary => ({ ...summary });

const initialStats = createInitialStats();

export const initialDashboardState: DashboardState = {
  rows: cloneRows(initialSnapshot.rows),
  summary: cloneSummary(initialSnapshot.summary),
  stats: { ...initialStats }
};

export const dashboardReducer = createReducer(
  initialDashboardState,
  on(dashboardFrameUpdate, (_, { rows, summary, stats }) => ({ rows, summary, stats }))
);
