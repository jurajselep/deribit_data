import { createReducer, on } from '@ngrx/store';
import {
  dashboardChainsUpdate,
  dashboardFrameUpdate,
  dashboardInstrumentSummaryFailure,
  dashboardInstrumentSummaryLoad,
  dashboardInstrumentSummarySuccess,
  dashboardInstrumentSummaryUpdate,
  dashboardLoadInstruments,
  dashboardLoadInstrumentsFailure,
  dashboardLoadInstrumentsSuccess,
  dashboardSelectCurrency,
  dashboardSelectInstrument,
  dashboardSelectMaturity,
  dashboardSetMaturities
} from './dashboard.actions';
import { createInitialStats, FrameStats } from '../models/frame-stats';
import {
  cloneChains,
  createOptionDataBuffers,
  type MaturityInfo,
  type OptionChain
} from '../data/options-chain';
import type { DeribitInstrument, DeribitInstrumentSummary } from '../models/deribit';

export interface DashboardState {
  maturities: MaturityInfo[];
  selectedMaturity: string;
  chains: Record<string, OptionChain>;
  stats: FrameStats;
  selectedCurrency: string;
  instruments: DeribitInstrument[];
  instrumentsLoading: boolean;
  instrumentsError: string | null;
  selectedInstrument: string | null;
  instrumentSummary: DeribitInstrumentSummary | null;
  instrumentSummaryLoading: boolean;
  instrumentSummaryError: string | null;
}

export const DASHBOARD_FEATURE_KEY = 'dashboard' as const;

const optionBuffers = createOptionDataBuffers();

export const initialDashboardState: DashboardState = {
  maturities: optionBuffers.maturities,
  selectedMaturity: optionBuffers.maturities[0]?.id ?? '',
  chains: cloneChains(optionBuffers.chains),
  stats: createInitialStats(),
  selectedCurrency: 'BTC',
  instruments: [],
  instrumentsLoading: false,
  instrumentsError: null,
  selectedInstrument: null,
  instrumentSummary: null,
  instrumentSummaryLoading: false,
  instrumentSummaryError: null
};

export const dashboardReducer = createReducer(
  initialDashboardState,
  on(dashboardSetMaturities, (state, { maturities }) => {
    const nextSelected =
      maturities.find((item) => item.id === state.selectedMaturity)?.id ?? maturities[0]?.id ?? '';
    return {
      ...state,
      maturities,
      selectedMaturity: nextSelected
    };
  }),
  on(dashboardFrameUpdate, (state, { chains, stats }) => ({
    ...state,
    chains,
    stats
  })),
  on(dashboardChainsUpdate, (state, { chains }) => ({
    ...state,
    chains
  })),
  on(dashboardSelectMaturity, (state, { maturity }) => (
    state.maturities.some((item) => item.id === maturity)
      ? { ...state, selectedMaturity: maturity }
      : state
  )),
  on(dashboardSelectCurrency, (state, { currency }) => ({
    ...state,
    selectedCurrency: currency
  })),
  on(dashboardLoadInstruments, (state, { currency }) => ({
    ...state,
    selectedCurrency: currency,
    instrumentsLoading: true,
    instrumentsError: null,
    instruments: [],
    selectedInstrument: null,
    instrumentSummary: null,
    instrumentSummaryLoading: false,
    instrumentSummaryError: null
  })),
  on(dashboardLoadInstrumentsSuccess, (state, { instruments }) => ({
    ...state,
    instruments,
    instrumentsLoading: false,
    instrumentsError: null
  })),
  on(dashboardLoadInstrumentsFailure, (state, { error }) => ({
    ...state,
    instruments: [],
    instrumentsLoading: false,
    instrumentsError: error,
    selectedInstrument: null,
    instrumentSummary: null,
    instrumentSummaryLoading: false,
    instrumentSummaryError: error
  })),
  on(dashboardSelectInstrument, (state, { instrument }) => ({
    ...state,
    selectedInstrument: instrument,
    instrumentSummary: state.selectedInstrument === instrument ? state.instrumentSummary : null,
    instrumentSummaryError: null,
    instrumentSummaryLoading: false
  })),
  on(dashboardInstrumentSummaryLoad, (state) => ({
    ...state,
    instrumentSummaryLoading: true,
    instrumentSummaryError: null
  })),
  on(dashboardInstrumentSummarySuccess, (state, { summary }) => ({
    ...state,
    instrumentSummary: summary,
    instrumentSummaryLoading: false,
    instrumentSummaryError: null
  })),
  on(dashboardInstrumentSummaryFailure, (state, { error }) => ({
    ...state,
    instrumentSummaryLoading: false,
    instrumentSummaryError: error
  })),
  on(dashboardInstrumentSummaryUpdate, (state, { summary }) => ({
    ...state,
    instrumentSummary: summary,
    instrumentSummaryLoading: false,
    instrumentSummaryError: null
  }))
);
