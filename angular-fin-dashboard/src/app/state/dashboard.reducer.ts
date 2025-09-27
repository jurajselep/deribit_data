import { createReducer, on } from '@ngrx/store';
import { dashboardFrameUpdate, dashboardSelectMaturity } from './dashboard.actions';
import { createInitialStats, FrameStats } from '../models/frame-stats';
import { cloneChains, createOptionDataBuffers, type MaturityInfo, type OptionChain } from '../data/options-chain';

export interface DashboardState {
  maturities: MaturityInfo[];
  selectedMaturity: string;
  chains: Record<string, OptionChain>;
  stats: FrameStats;
}

export const DASHBOARD_FEATURE_KEY = 'dashboard' as const;

const optionBuffers = createOptionDataBuffers();

export const initialDashboardState: DashboardState = {
  maturities: optionBuffers.maturities,
  selectedMaturity: optionBuffers.maturities[0]?.id ?? '',
  chains: cloneChains(optionBuffers.chains),
  stats: createInitialStats()
};

export const dashboardReducer = createReducer(
  initialDashboardState,
  on(dashboardFrameUpdate, (state, { chains, stats }) => ({
    ...state,
    chains,
    stats
  })),
  on(dashboardSelectMaturity, (state, { maturity }) => (
    state.maturities.some((item) => item.id === maturity)
      ? { ...state, selectedMaturity: maturity }
      : state
  ))
);
