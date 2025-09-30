import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  effect,
  computed,
  signal
} from '@angular/core';
import { NgClass, NgFor, NgIf } from '@angular/common';
import * as THREE from 'three';
import { Store } from '@ngrx/store';
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
} from './state/dashboard.actions';
import { DASHBOARD_FEATURE_KEY, DashboardState } from './state/dashboard.reducer';
import {
  selectChains,
  selectFrameStats,
  selectInstrumentSummary,
  selectInstrumentSummaryError,
  selectInstrumentSummaryLoading,
  selectInstruments,
  selectInstrumentsError,
  selectInstrumentsLoading,
  selectMaturities,
  selectSelectedChain,
  selectSelectedCurrency,
  selectSelectedInstrument,
  selectSelectedMaturity
} from './state/dashboard.selectors';
import { createInitialStats, FrameStats, formatDuration, formatFrequency } from './models/frame-stats';
import { HISTORY_CAPACITY, RECENT_HISTORY_SIZE } from './constants';
import {
  OptionChain,
  OptionDataBuffers,
  OptionRow,
  cloneChains,
  createOptionDataBuffers,
  createOptionDataBuffersFromInstruments,
  maturityIdFromInstrumentName,
  normalizeDeribitIv,
  mutateOptionData,
  updateChainsWithTicker
} from './data/options-chain';
import { VolSurfaceSeries } from './models/vol-surface';
import { DeribitInstrument, DeribitInstrumentSummary, DeribitTickerData } from './models/deribit';
import { DeribitService } from './services/deribit.service';
import { DeribitHistoryService } from './services/deribit-history.service';
import { DeribitWebsocketService } from './services/deribit-websocket.service';
import { toSignal } from '@angular/core/rxjs-interop';
import { buildHistoricalSurface } from './data/historical-surface';

type FrameMeasurement = {
  frameSpacing: number;
  dataDuration: number;
};

type AppState = { [DASHBOARD_FEATURE_KEY]: DashboardState };

type SmilePoint = {
  x: number;
  y: number;
  strike: number;
  strikeText: string;
  iv: number;
  ivText: string;
};
type SmileSeries = {
  maturity: string;
  label: string;
  color: string;
  points: SmilePoint[];
  path: string;
  isSelected: boolean;
};
type SmileAxis = {
  minStrike: string;
  maxStrike: string;
  minIv: string;
  maxIv: string;
  ticks: Array<{ label: string; position: number }>;
};
type SmileTooltip = {
  x: number;
  y: number;
  strike: string;
  iv: string;
  maturity: string;
};
type VerticalSpreadSuggestion = {
  spreadType: 'call' | 'put';
  longStrike: string;
  shortStrike: string;
  longPremiumText: string;
  shortPremiumText: string;
  netCost: number;
  netCostText: string;
  expectedProfit: number;
  expectedProfitText: string;
  maxProfit: number | null;
  maxProfitText: string | null;
  returnPct: number | null;
  returnPctText: string | null;
  maxLossText: string;
  widthText: string;
};
type SpreadSuggestions = {
  call: VerticalSpreadSuggestion[];
  put: VerticalSpreadSuggestion[];
};
type HistoricalSurfaceSnapshot = {
  timestamp: number;
  label: string;
  fullLabel: string;
  surface: VolSurfaceSeries | null;
  tradeCount: number;
};

const FRAME_TARGET_MS = 16.67;
const MIN_SAMPLES_FOR_ASSESSMENT = 90;

const SYNTHETIC_CURRENCY = 'SYNTH';
const SMILE_COLORS = ['#76dcb2', '#82a3f2', '#fcbf49', '#f472b6', '#38bdf8', '#f97316'];
const SMILE_VIEWBOX_WIDTH = 600;
const SMILE_VIEWBOX_HEIGHT = 160;
const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2
});
const percentFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
  minimumFractionDigits: 0
});

type HistoricalIntervalOption = {
  value: number;
  label: string;
  summary: string;
};

const HISTORICAL_INTERVAL_OPTIONS: readonly HistoricalIntervalOption[] = [
  { value: 60, label: '1 hour', summary: '1h' },
  { value: 240, label: '4 hours', summary: '4h' },
  { value: 480, label: '8 hours', summary: '8h' },
  { value: 1440, label: '24 hours', summary: '24h' }
] as const;
const HISTORICAL_FRAME_COUNT = 12;
const HISTORICAL_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});
const HISTORICAL_FULL_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

const isFiniteNumber = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const formatCurrency = (value: number): string => currencyFormatter.format(value);
const formatPercentText = (value: number): string => `${percentFormatter.format(value)}%`;

type CurrencyOption = {
  value: string;
  label: string;
};

const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [NgClass, NgFor, NgIf],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AppComponent implements OnInit, OnDestroy, AfterViewInit {
  private optionBuffers: OptionDataBuffers = createOptionDataBuffers();
  private frameStatsRef: FrameStats = createInitialStats();
  private tickerUnsubscribe: (() => void) | null = null;
  private currentTickerInstrument: string | null = null;
  private readonly chainTickerSubscriptions = new Map<string, () => void>();
  private volSurfaceData: VolSurfaceSeries | null = null;
  private surfaceScene: THREE.Scene | null = null;
  private surfaceCamera: THREE.PerspectiveCamera | null = null;
  private surfaceRenderer: THREE.WebGLRenderer | null = null;
  private surfaceMesh: THREE.Mesh | null = null;
  private surfaceAnimationFrame?: number;

  readonly currencies: CurrencyOption[] = [
    { value: 'BTC', label: 'BTC' },
    { value: 'ETH', label: 'ETH' },
    { value: SYNTHETIC_CURRENCY, label: 'Synthetic Data' }
  ];
  readonly selectedCurrency = toSignal(this.store.select(selectSelectedCurrency), {
    initialValue: 'BTC'
  });
  readonly instruments = toSignal(this.store.select(selectInstruments), {
    initialValue: [] as DeribitInstrument[]
  });
  readonly instrumentsLoading = toSignal(this.store.select(selectInstrumentsLoading), {
    initialValue: false
  });
  readonly instrumentsError = toSignal(this.store.select(selectInstrumentsError), {
    initialValue: null as string | null
  });
  readonly selectedInstrument = toSignal(this.store.select(selectSelectedInstrument), {
    initialValue: null as string | null
  });
  readonly instrumentSummary = toSignal(this.store.select(selectInstrumentSummary), {
    initialValue: null as DeribitInstrumentSummary | null
  });
  readonly instrumentSummaryLoading = toSignal(this.store.select(selectInstrumentSummaryLoading), {
    initialValue: false
  });
  readonly instrumentSummaryError = toSignal(this.store.select(selectInstrumentSummaryError), {
    initialValue: null as string | null
  });

  readonly maturities = toSignal(this.store.select(selectMaturities), {
    initialValue: this.optionBuffers.maturities
  });
  readonly selectedMaturity = toSignal(this.store.select(selectSelectedMaturity), {
    initialValue: this.optionBuffers.maturities[0]?.id ?? ''
  });
  readonly chains = toSignal(this.store.select(selectChains), {
    initialValue: cloneChains(this.optionBuffers.chains)
  });
  readonly selectedChain = toSignal(this.store.select(selectSelectedChain), {
    initialValue: null
  });
  readonly frameStats = toSignal(this.store.select(selectFrameStats), {
    initialValue: this.frameStatsRef
  });
  readonly frameStatsView = computed(() => this.frameStats());
  readonly smileSeries = signal<SmileSeries[]>([], { equal: () => false });
  readonly smileAxis = signal<SmileAxis>({
    minStrike: '',
    maxStrike: '',
    minIv: '',
    maxIv: '',
    ticks: []
  });
  readonly smileFilter = signal<string | null>(null);
  readonly smileTooltip = signal<SmileTooltip | null>(null);
  readonly liveVolSurface = signal<VolSurfaceSeries | null>(null, { equal: () => false });
  readonly historicalMode = signal(false);
  readonly historicalIntervals = HISTORICAL_INTERVAL_OPTIONS;
  readonly historicalInterval = signal<number>(HISTORICAL_INTERVAL_OPTIONS[0].value);
  readonly historicalSnapshots = signal<HistoricalSurfaceSnapshot[]>([]);
  readonly historicalSelectedIndex = signal(0);
  readonly historicalLoading = signal(false);
  readonly historicalError = signal<string | null>(null);
  private readonly historicalSurfaceOverride = computed<VolSurfaceSeries | null>(() => {
    const snapshots = this.historicalSnapshots();
    const index = this.historicalSelectedIndex();
    return snapshots[index]?.surface ?? null;
  });
  readonly activeHistoricalSnapshot = computed<HistoricalSurfaceSnapshot | null>(() => {
    const snapshots = this.historicalSnapshots();
    const index = this.historicalSelectedIndex();
    return snapshots[index] ?? null;
  });
  readonly volSurface = computed<VolSurfaceSeries | null>(() =>
    this.historicalMode() ? this.historicalSurfaceOverride() : this.liveVolSurface()
  );
  readonly volSurfaceSummary = computed(() => {
    if (this.historicalMode()) {
      const intervalOption = HISTORICAL_INTERVAL_OPTIONS.find(
        (option) => option.value === this.historicalInterval()
      );
      if (this.historicalLoading()) {
        return 'Loading historical surface…';
      }
      const error = this.historicalError();
      if (error) {
        return error;
      }
      const snapshot = this.activeHistoricalSnapshot();
      if (snapshot) {
        const intervalText = intervalOption?.summary ?? `${this.historicalInterval()}m`;
        return `${snapshot.fullLabel} · ${intervalText} steps · ${snapshot.tradeCount} trades`;
      }
      return 'No historical snapshots loaded yet.';
    }

    const surface = this.volSurface();
    if (surface) {
      return `${surface.maturityLabels.length} maturities · ${surface.strikeLabels.length} strikes · ${surface.pointCount} pts`;
    }
    return 'Awaiting live surface data…';
  });
  readonly loopRunning = signal(false);
  readonly expectedExpiryPriceInput = signal('');
  readonly expectedExpiryPrice = computed<number | null>(() => {
    const raw = this.expectedExpiryPriceInput().trim();
    if (!raw) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  });
  readonly selectedStrike = signal<number | null>(null);
  readonly selectedStrikeRow = computed<OptionRow | null>(() => {
    const chain = this.selectedChain();
    const strike = this.selectedStrike();
    if (!chain || strike === null) {
      return null;
    }
    return chain.rows.find((row) => Math.abs(row.strike - strike) < 1e-6) ?? null;
  });
  readonly spreadSuggestions = computed<SpreadSuggestions>(() => {
    const chain = this.selectedChain();
    const price = this.expectedExpiryPrice();
    const strike = this.selectedStrike();
    if (!chain || price === null || strike === null) {
      return { call: [], put: [] };
    }
    return this.computeSpreadSuggestions(chain.rows, strike, price);
  });

  private volSurfaceCanvasRef?: ElementRef<HTMLCanvasElement>;
  private smileContainerRef?: ElementRef<HTMLDivElement>;

  @ViewChild('volSurfaceCanvas')
  set volSurfaceCanvas(element: ElementRef<HTMLCanvasElement> | undefined) {
    if (element) {
      this.volSurfaceCanvasRef = element;
      queueMicrotask(() => this.initVolSurface());
    }
  }

  @ViewChild('smileContainer')
  set smileContainer(element: ElementRef<HTMLDivElement> | undefined) {
    this.smileContainerRef = element;
  }

  private frameId?: number;
  private lastFrameTime = now();

  private readonly frameHistory = new Float32Array(HISTORY_CAPACITY);
  private historyWriteIndex = 0;
  private historyLength = 0;
  private readonly sortScratch: number[] = new Array(HISTORY_CAPACITY);
  private historicalRequestId = 0;
  private historicalSnapshotsKey: string | null = null;

  constructor(
    private readonly store: Store<AppState>,
    private readonly deribit: DeribitService,
    private readonly deribitWebsocket: DeribitWebsocketService,
    private readonly deribitHistory: DeribitHistoryService
  ) {
    effect(() => {
      if (this.historicalMode()) {
        return;
      }
      const chains = this.chains();
      this.recomputeSmile(chains);
    });

    effect(() => {
      const surface = this.volSurface();
      this.volSurfaceData = surface;
      this.updateSurfaceGeometry();
    });

    effect(() => {
      if (!this.historicalMode()) {
        return;
      }
      const snapshot = this.activeHistoricalSnapshot();
      this.applyHistoricalSmile(snapshot?.surface ?? null);
    });

    effect(() => {
      const currency = this.selectedCurrency();
      if (this.isSyntheticCurrency(currency) && this.historicalMode()) {
        this.historicalMode.set(false);
      }
    });

    effect(() => {
      if (!this.historicalMode()) {
        return;
      }
      if (this.historicalLoading()) {
        return;
      }
      const currency = this.selectedCurrency();
      const interval = this.historicalInterval();
      if (this.isSyntheticCurrency(currency)) {
        this.historicalSnapshotsKey = null;
        this.historicalSnapshots.set([]);
        this.historicalError.set('Historical data is unavailable for synthetic instruments.');
        return;
      }
      const key = `${currency}|${interval}`;
      if (this.historicalSnapshotsKey === key && this.historicalSnapshots().length) {
        return;
      }
      void this.loadHistoricalSnapshots(currency, interval);
    });
  }

  ngOnInit(): void {
    this.dispatchSnapshot();
    void this.loadInstruments(this.selectedCurrency());
    this.scheduleNextFrame();
  }

  ngAfterViewInit(): void {
    this.initVolSurface();
  }

  ngOnDestroy(): void {
    this.stopLoop();
    this.unsubscribeFromTicker();
    this.clearChainTickerSubscriptions();
    this.disposeVolSurface();
  }

  startLoop(): void {
    if (this.loopRunning()) {
      return;
    }
    this.loopRunning.set(true);
    this.lastFrameTime = now();
    this.scheduleNextFrame();
  }

  stopLoop(): void {
    if (!this.loopRunning()) {
      return;
    }
    this.loopRunning.set(false);
    if (this.frameId !== undefined) {
      cancelAnimationFrame(this.frameId);
      this.frameId = undefined;
    }
  }

  refreshOnce(): void {
    const dataDuration = this.mutateSyntheticData();
    this.afterFrame({ frameSpacing: 0, dataDuration });
  }

  changeCurrency(currency: string): void {
    if (currency === this.selectedCurrency()) {
      return;
    }
    this.selectedStrike.set(null);
    this.unsubscribeFromTicker();
    this.clearChainTickerSubscriptions();
    this.store.dispatch(dashboardSelectCurrency({ currency }));
    void this.loadInstruments(currency);
  }

  changeInstrument(instrumentName: string): void {
    if (!instrumentName) return;
    this.applyInstrument(instrumentName);
  }

  selectMaturity(maturity: string): void {
    if (maturity === this.selectedMaturity()) {
      return;
    }
    this.selectedStrike.set(null);
    this.store.dispatch(dashboardSelectMaturity({ maturity }));
    this.onMaturityChanged(maturity);
  }

  toggleSmileFilter(maturity: string): void {
    const current = this.smileFilter();
    this.smileFilter.set(current === maturity ? null : maturity);
  }

  setExpectedExpiryPrice(value: string): void {
    const normalized = value.replace(/[^0-9.]/g, '');
    this.expectedExpiryPriceInput.set(normalized);
  }

  setHistoricalMode(mode: boolean): void {
    const normalized = Boolean(mode);
    if (normalized === this.historicalMode()) {
      return;
    }
    if (normalized && this.isSyntheticCurrency(this.selectedCurrency())) {
      this.historicalError.set('Historical data is unavailable for synthetic instruments.');
      return;
    }
    this.historicalMode.set(normalized);
    if (!normalized) {
      this.historicalRequestId += 1;
      this.historicalLoading.set(false);
      this.historicalError.set(null);
    }
  }

  setHistoricalInterval(value: number | string): void {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      return;
    }
    if (!HISTORICAL_INTERVAL_OPTIONS.some((option) => option.value === numeric)) {
      return;
    }
    if (numeric === this.historicalInterval()) {
      return;
    }
    this.historicalInterval.set(numeric);
    this.historicalRequestId += 1;
    this.historicalLoading.set(false);
    this.historicalError.set(null);
    this.historicalSnapshotsKey = null;
    this.historicalSelectedIndex.set(0);
    this.historicalSnapshots.set([]);
  }

  refreshHistoricalSnapshots(): void {
    if (!this.historicalMode() || this.historicalLoading()) {
      return;
    }
    const currency = this.selectedCurrency();
    if (this.isSyntheticCurrency(currency)) {
      this.historicalError.set('Historical data is unavailable for synthetic instruments.');
      return;
    }
    this.historicalRequestId += 1;
    this.historicalLoading.set(false);
    this.historicalSnapshotsKey = null;
    this.historicalSnapshots.set([]);
    this.historicalSelectedIndex.set(0);
    this.historicalError.set(null);
    void this.loadHistoricalSnapshots(currency, this.historicalInterval());
  }

  selectHistoricalSnapshot(index: number): void {
    const snapshots = this.historicalSnapshots();
    if (!snapshots.length) {
      return;
    }
    const clamped = Math.max(0, Math.min(index, snapshots.length - 1));
    if (clamped === this.historicalSelectedIndex()) {
      return;
    }
    this.historicalSelectedIndex.set(clamped);
  }

  stepHistoricalSnapshot(delta: number): void {
    if (!Number.isFinite(delta)) {
      return;
    }
    const snapshots = this.historicalSnapshots();
    if (!snapshots.length) {
      return;
    }
    const nextIndex = this.historicalSelectedIndex() + Math.trunc(delta);
    this.selectHistoricalSnapshot(nextIndex);
  }

  selectStrike(row: OptionRow): void {
    const current = this.selectedStrike();
    this.selectedStrike.set(current === row.strike ? null : row.strike);
  }

  showSmileTooltip(event: MouseEvent, point: SmilePoint, series: SmileSeries): void {
    if (!this.smileContainerRef) {
      return;
    }

    const target = event.target as SVGCircleElement | null;
    const svg = target?.ownerSVGElement;
    if (!svg) {
      return;
    }

    const containerRect = this.smileContainerRef.nativeElement.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();

    const relativeX = (point.x / SMILE_VIEWBOX_WIDTH) * svgRect.width + (svgRect.left - containerRect.left);
    const relativeY = (point.y / SMILE_VIEWBOX_HEIGHT) * svgRect.height + (svgRect.top - containerRect.top);
    const safeX = Math.min(containerRect.width - 12, Math.max(12, relativeX));
    const safeY = Math.min(containerRect.height - 12, Math.max(12, relativeY));

    this.smileTooltip.set({
      x: safeX,
      y: safeY,
      strike: point.strikeText,
      iv: point.ivText,
      maturity: series.label
    });
  }

  hideSmileTooltip(): void {
    if (this.smileTooltip()) {
      this.smileTooltip.set(null);
    }
  }

  trackByStrike = (_: number, row: OptionRow) => row.strike;

  private async loadHistoricalSnapshots(currency: string, intervalMinutes: number): Promise<void> {
    const requestId = ++this.historicalRequestId;
    this.historicalLoading.set(true);
    this.historicalError.set(null);
    this.historicalSnapshotsKey = null;
    this.historicalSnapshots.set([]);
    this.historicalSelectedIndex.set(0);

    const intervalMs = Math.max(1, Math.round(intervalMinutes * 60_000));
    const nowTs = Date.now();
    const snapshots: HistoricalSurfaceSnapshot[] = [];

    try {
      for (let offset = HISTORICAL_FRAME_COUNT - 1; offset >= 0; offset -= 1) {
        if (requestId !== this.historicalRequestId) {
          return;
        }

        const targetTimestamp = nowTs - offset * intervalMs;
        const startTimestamp = Math.max(0, targetTimestamp - intervalMs);
        const trades = await this.deribitHistory.fetchOptionTrades(
          currency,
          startTimestamp,
          targetTimestamp
        );

        if (requestId !== this.historicalRequestId) {
          return;
        }

        const surface = buildHistoricalSurface(trades, targetTimestamp);
        const timestampDate = new Date(targetTimestamp);
        snapshots.push({
          timestamp: targetTimestamp,
          label: HISTORICAL_TIME_FORMATTER.format(timestampDate),
          fullLabel: HISTORICAL_FULL_FORMATTER.format(timestampDate),
          surface,
          tradeCount: trades.length
        });
      }

      if (requestId !== this.historicalRequestId) {
        return;
      }

      snapshots.sort((a, b) => a.timestamp - b.timestamp);
      this.historicalSnapshots.set(snapshots);
      if (snapshots.length) {
        this.historicalSelectedIndex.set(snapshots.length - 1);
        this.historicalError.set(null);
      } else {
        this.historicalError.set('No option trades found for the selected interval.');
      }
      this.historicalSnapshotsKey = `${currency}|${intervalMinutes}`;
    } catch (error) {
      if (requestId !== this.historicalRequestId) {
        return;
      }
      const message = (error as Error).message ?? 'Unable to load historical data';
      this.historicalError.set(message);
      this.historicalSnapshotsKey = null;
    } finally {
      if (requestId === this.historicalRequestId) {
        this.historicalLoading.set(false);
      }
    }
  }

  private mutateSyntheticData(): number {
    if (!this.isSyntheticCurrency(this.selectedCurrency())) {
      return 0;
    }
    const start = performance.now();
    mutateOptionData(this.optionBuffers);
    return performance.now() - start;
  }

  private scheduleNextFrame(): void {
    if (!this.loopRunning()) {
      this.frameId = undefined;
      return;
    }

    this.frameId = requestAnimationFrame((timestamp) => this.onAnimationFrame(timestamp));
  }

  private onAnimationFrame(timestamp: number): void {
    this.frameId = undefined;
    const frameSpacing = timestamp - this.lastFrameTime;
    this.lastFrameTime = timestamp;

    const dataDuration = this.mutateSyntheticData();

    this.afterFrame({
      frameSpacing: frameSpacing > 0 ? frameSpacing : 0,
      dataDuration
    });

    this.scheduleNextFrame();
  }

  private afterFrame(measurement: FrameMeasurement): void {
    const stats = this.frameStatsRef;
    const statsWorkStart = performance.now();

    stats.sampleCount += 1;
    stats.lastDataDuration = measurement.dataDuration;
    stats.lastDataDurationText = formatDuration(measurement.dataDuration);

    stats.lastFrameSpacing = measurement.frameSpacing;
    stats.lastFrameSpacingText = formatDuration(measurement.frameSpacing);
    stats.totalFrameSpacing += measurement.frameSpacing;

    const avgSpacing = stats.totalFrameSpacing / stats.sampleCount;
    stats.averageFrameSpacing = avgSpacing;
    stats.averageFrameSpacingText = formatDuration(avgSpacing || 0);
    stats.instantFps = measurement.frameSpacing > 0 ? 1000 / measurement.frameSpacing : stats.instantFps;
    stats.instantFpsText = formatFrequency(stats.instantFps);
    stats.averageFps = avgSpacing > 0 ? 1000 / avgSpacing : stats.averageFps;
    stats.averageFpsText = formatFrequency(stats.averageFps);

    const statsDuration = performance.now() - statsWorkStart;
    stats.lastStatsDuration = statsDuration;
    stats.lastStatsDurationText = formatDuration(statsDuration);

    const signalStart = performance.now();
    const nextChains = cloneChains(this.optionBuffers.chains);
    const signalDuration = performance.now() - signalStart;

    const smileStart = performance.now();
    this.buildSmileData(nextChains);
    const smileDuration = performance.now() - smileStart;

    stats.lastSignalDuration = signalDuration;
    stats.lastSignalDurationText = formatDuration(signalDuration);
    stats.lastSmileDuration = smileDuration;
    stats.lastSmileDurationText = formatDuration(smileDuration);

    stats.totalSmileDuration += smileDuration;

    const totalCost = measurement.dataDuration + signalDuration + statsDuration + smileDuration;

    stats.totalDuration += totalCost;
    stats.lastDuration = totalCost;
    stats.lastDurationText = formatDuration(totalCost);
    stats.averageDuration = stats.totalDuration / stats.sampleCount;
    stats.averageDurationText = formatDuration(stats.averageDuration || 0);

    const meetsBudget =
      stats.sampleCount >= MIN_SAMPLES_FOR_ASSESSMENT &&
      stats.averageDuration <= FRAME_TARGET_MS;
    stats.meets60 = meetsBudget;
    stats.statusText = stats.sampleCount < MIN_SAMPLES_FOR_ASSESSMENT ? 'Measuring...' : meetsBudget ? 'Yes' : 'No';

    this.updateHistory(totalCost, stats);

    const statsForStore: FrameStats = { ...this.frameStatsRef };
    this.store.dispatch(dashboardFrameUpdate({ chains: nextChains, stats: statsForStore }));
  }

  private updateHistory(cost: number, stats: FrameStats): void {
    this.frameHistory[this.historyWriteIndex] = cost;
    this.historyWriteIndex = (this.historyWriteIndex + 1) % HISTORY_CAPACITY;
    if (this.historyLength < HISTORY_CAPACITY) {
      this.historyLength += 1;
    }

    const windowSize = this.historyLength;
    stats.windowSampleCount = windowSize;

    if (windowSize === 0) {
      stats.windowMinDuration = 0;
      stats.windowMinDurationText = formatDuration(0);
      stats.windowMaxDuration = 0;
      stats.windowMaxDurationText = formatDuration(0);
      stats.windowP95Duration = 0;
      stats.windowP95DurationText = formatDuration(0);
      stats.windowP99Duration = 0;
      stats.windowP99DurationText = formatDuration(0);
      stats.recentDurationsText = '';
      return;
    }

    const scratch = this.sortScratch;
    scratch.length = windowSize;

    for (let i = 0; i < windowSize; i += 1) {
      const historyIndex = (this.historyWriteIndex - windowSize + i + HISTORY_CAPACITY) % HISTORY_CAPACITY;
      scratch[i] = this.frameHistory[historyIndex];
    }

    scratch.sort((a, b) => a - b);

    const minValue = scratch[0];
    const maxValue = scratch[windowSize - 1];
    const p95Index = Math.max(0, Math.ceil(windowSize * 0.95) - 1);
    const p99Index = Math.max(0, Math.ceil(windowSize * 0.99) - 1);
    const p95Value = scratch[p95Index];
    const p99Value = scratch[p99Index];

    const recentCount = Math.min(RECENT_HISTORY_SIZE, windowSize);
    let historyText = '';
    for (let i = 0; i < recentCount; i += 1) {
      const historyIndex = (this.historyWriteIndex - recentCount + i + HISTORY_CAPACITY) % HISTORY_CAPACITY;
      const formatted = formatDuration(this.frameHistory[historyIndex]);
      historyText += i === 0 ? formatted : `, ${formatted}`;
    }

    stats.windowMinDuration = minValue;
    stats.windowMinDurationText = formatDuration(minValue);
    stats.windowMaxDuration = maxValue;
    stats.windowMaxDurationText = formatDuration(maxValue);
    stats.windowP95Duration = p95Value;
    stats.windowP95DurationText = formatDuration(p95Value);
    stats.windowP99Duration = p99Value;
    stats.windowP99DurationText = formatDuration(p99Value);
    stats.recentDurationsText = historyText;

    scratch.length = HISTORY_CAPACITY;
  }

  private dispatchSnapshot(preferredMaturity?: string): void {
    const nextChains = cloneChains(this.optionBuffers.chains);
    const statsForStore: FrameStats = { ...this.frameStatsRef };
    this.store.dispatch(dashboardFrameUpdate({ chains: nextChains, stats: statsForStore }));
    const maturity = preferredMaturity ?? this.selectedMaturity();
    if (maturity) {
      this.store.dispatch(dashboardSelectMaturity({ maturity }));
    }
  }

  private async loadInstruments(currency: string): Promise<void> {
    this.store.dispatch(dashboardLoadInstruments({ currency }));
    try {
      const instruments = await this.deribit.fetchInstruments(currency);
      const sorted = [...instruments].filter((instrument) => instrument.kind === 'option');
      sorted.sort((a, b) => {
        const exp = a.expiration_timestamp - b.expiration_timestamp;
        return exp !== 0 ? exp : a.strike - b.strike;
      });

      let bookSummaries: Map<string, DeribitInstrumentSummary> | undefined;
      if (!this.isSyntheticCurrency(currency)) {
        try {
          bookSummaries = await this.deribit.fetchBookSummaries(currency);
        } catch (error) {
          console.warn('Unable to load book summaries', error);
        }
      }

      this.store.dispatch(dashboardLoadInstrumentsSuccess({ instruments: sorted }));
      this.initializeOptionData(currency, sorted, bookSummaries);

      const current = this.selectedInstrument();
      const exists = current && sorted.some((instrument) => instrument.instrument_name === current);
      const targetInstrument = exists ? current : sorted[0]?.instrument_name ?? null;
      this.applyInstrument(targetInstrument ?? null);
    } catch (error) {
      const message = (error as Error).message ?? 'Unable to load instruments';
      this.store.dispatch(dashboardLoadInstrumentsFailure({ error: message }));
    }
  }

  private initializeOptionData(
    currency: string,
    instruments: DeribitInstrument[],
    summaries?: Map<string, DeribitInstrumentSummary>
  ): void {
    this.clearChainTickerSubscriptions();
    this.selectedStrike.set(null);
    this.optionBuffers = this.isSyntheticCurrency(currency)
      ? createOptionDataBuffers()
      : createOptionDataBuffersFromInstruments(instruments, summaries);

    const maturities = this.optionBuffers.maturities;
    const initialMaturity = maturities[0]?.id ?? '';
    this.store.dispatch(dashboardSetMaturities({ maturities }));
    this.dispatchSnapshot(initialMaturity);
    if (initialMaturity) {
      this.onMaturityChanged(initialMaturity);
    } else {
      this.clearChainTickerSubscriptions();
    }
  }

  private applyInstrument(instrumentName: string | null): void {
    this.selectedStrike.set(null);
    this.store.dispatch(dashboardSelectInstrument({ instrument: instrumentName }));
    this.unsubscribeFromTicker();
    if (!instrumentName) {
      this.store.dispatch(dashboardInstrumentSummarySuccess({ summary: null }));
      return;
    }

    const maturity = this.parseInstrumentMaturity(instrumentName);
    if (!maturity) {
      this.store.dispatch(dashboardInstrumentSummarySuccess({ summary: null }));
      return;
    }

    if (maturity !== this.selectedMaturity()) {
      this.store.dispatch(dashboardSelectMaturity({ maturity }));
    }

    this.onMaturityChanged(maturity);

    if (this.isSyntheticCurrency(this.selectedCurrency())) {
      this.store.dispatch(dashboardInstrumentSummarySuccess({ summary: null }));
      return;
    }

    this.subscribeToTicker(instrumentName);
    void this.loadInstrumentSummary(instrumentName);
  }

  private async loadInstrumentSummary(instrumentName: string): Promise<void> {
    if (this.isSyntheticCurrency(this.selectedCurrency())) {
      this.store.dispatch(dashboardInstrumentSummarySuccess({ summary: null }));
      return;
    }
    this.store.dispatch(dashboardInstrumentSummaryLoad({ instrument: instrumentName }));
    try {
      const summary = await this.deribit.fetchInstrumentSummary(instrumentName);
      this.store.dispatch(dashboardInstrumentSummarySuccess({ summary }));
    } catch (error) {
      const message = (error as Error).message ?? 'Unable to load instrument data';
      this.store.dispatch(dashboardInstrumentSummaryFailure({ error: message }));
    }
  }

  private buildSmileData(
    chains: Record<string, OptionChain>
  ): { series: SmileSeries[]; axis: SmileAxis; surface: VolSurfaceSeries | null } {
    const maturities = this.maturities();
    if (!maturities.length) {
      return {
        series: [],
        axis: { minStrike: '', maxStrike: '', minIv: '', maxIv: '', ticks: [] },
        surface: null
      };
    }

    let minStrike = Number.POSITIVE_INFINITY;
    let maxStrike = Number.NEGATIVE_INFINITY;
    let minIv = Number.POSITIVE_INFINITY;
    let maxIv = Number.NEGATIVE_INFINITY;
    let minStrikeText = '';
    let maxStrikeText = '';

    const strikeMap = new Map<number, string>();
    const rawSeries: Array<{
      maturity: { id: string; label: string };
      rows: Array<{ strike: number; strikeText: string; iv: number }>;
    }> = [];
    const ivValues: number[] = [];

    maturities.forEach((maturity) => {
      const chain = chains[maturity.id];
      if (!chain || chain.rows.length === 0) {
        return;
      }

      const finiteRows: Array<{ strike: number; strikeText: string; iv: number }> = [];

      chain.rows.forEach((row) => {
        const callIv = row.call.iv;
        const putIv = row.put.iv;
        const iv = Number.isFinite(callIv) && Number.isFinite(putIv) ? (callIv + putIv) / 2 : Number.NaN;
        if (!Number.isFinite(iv) || iv <= 0 || iv > 5) {
          return;
        }

        const value = iv as number;
        finiteRows.push({ strike: row.strike, strikeText: row.strikeText, iv: value });
        ivValues.push(value);

        if (row.strike < minStrike) {
          minStrike = row.strike;
          minStrikeText = row.strikeText;
        }
        if (row.strike > maxStrike) {
          maxStrike = row.strike;
          maxStrikeText = row.strikeText;
        }
        if (value < minIv) {
          minIv = value;
        }
        if (value > maxIv) {
          maxIv = value;
        }
        if (!strikeMap.has(row.strike)) {
          strikeMap.set(row.strike, row.strikeText);
        }
      });

      if (finiteRows.length >= 2) {
        finiteRows.sort((a, b) => a.strike - b.strike);
        rawSeries.push({ maturity, rows: finiteRows });
      }
    });

    if (rawSeries.length === 0) {
      return {
        series: [],
        axis: { minStrike: '', maxStrike: '', minIv: '', maxIv: '', ticks: [] },
        surface: null
      };
    }

    if (!Number.isFinite(minStrike) || !Number.isFinite(maxStrike)) {
      minStrike = 0;
      maxStrike = 1;
    }
    if (!Number.isFinite(minIv) || !Number.isFinite(maxIv)) {
      minIv = 0;
      maxIv = 1;
    }
    if (minStrike === maxStrike) {
      maxStrike = minStrike + 1;
    }
    if (minIv === maxIv) {
      maxIv = minIv + 0.01;
    }

    let axisMinIv = minIv;
    let axisMaxIv = maxIv;

    if (ivValues.length >= 3) {
      const sorted = ivValues.slice().sort((a, b) => a - b);
      const quantile = (fraction: number): number => {
        if (!sorted.length) {
          return Number.NaN;
        }
        if (sorted.length === 1) {
          return sorted[0];
        }
        const pos = (sorted.length - 1) * fraction;
        const baseIndex = Math.floor(pos);
        const nextIndex = Math.min(baseIndex + 1, sorted.length - 1);
        const remainder = pos - baseIndex;
        const lower = sorted[baseIndex];
        const upper = sorted[nextIndex];
        return lower + (upper - lower) * remainder;
      };
      const lower = quantile(0.05);
      const upper = quantile(0.95);
      if (Number.isFinite(lower) && Number.isFinite(upper) && upper > lower) {
        axisMinIv = lower;
        axisMaxIv = upper;
      }
    }

    if (!Number.isFinite(axisMinIv) || !Number.isFinite(axisMaxIv)) {
      axisMinIv = minIv;
      axisMaxIv = maxIv;
    }

    if (!Number.isFinite(axisMinIv) || !Number.isFinite(axisMaxIv)) {
      axisMinIv = 0.05;
      axisMaxIv = 1;
    }

    if (axisMinIv === axisMaxIv) {
      axisMaxIv = axisMinIv + 0.01;
    }

    const baseRange = axisMaxIv - axisMinIv;
    const padding = baseRange > 0 ? baseRange * 0.08 : axisMinIv * 0.08 || 0.01;
    axisMinIv = Math.max(0.01, axisMinIv - padding);
    axisMaxIv = axisMaxIv + padding;

    if (axisMinIv >= axisMaxIv) {
      axisMaxIv = axisMinIv + 0.01;
    }

    const strikeRange = maxStrike - minStrike;
    const ivRange = axisMaxIv - axisMinIv;
    const width = 600;
    const height = 140;
    const topPadding = 12;

    const selectedMaturity = this.selectedMaturity();

    const series: SmileSeries[] = rawSeries.map((entry, index) => {
      const validRows = entry.rows;
      const color = SMILE_COLORS[index % SMILE_COLORS.length];
      const points: SmilePoint[] = validRows.map((row) => {
        const x = ((row.strike - minStrike) / strikeRange) * width;
        const clampedIv = Math.min(axisMaxIv, Math.max(axisMinIv, row.iv));
        const y = height - ((clampedIv - axisMinIv) / ivRange) * (height - topPadding) - topPadding;
        return {
          x: Number(x.toFixed(2)),
          y: Number(y.toFixed(2)),
          strike: row.strike,
          strikeText: row.strikeText,
          iv: row.iv,
          ivText: this.formatIv(row.iv)
        };
      });

      return {
        maturity: entry.maturity.id,
        label: entry.maturity.label,
        color,
        points,
        path: points.map((point) => `${point.x},${point.y}`).join(' '),
        isSelected: entry.maturity.id === selectedMaturity
      };
    });

    const firstSeries = rawSeries[0];
    const firstRow = firstSeries?.rows[0];
    const lastSeries = rawSeries[rawSeries.length - 1];
    const lastRow = lastSeries?.rows[lastSeries.rows.length - 1];

    const tickDivisions = 4;
    const ticks: Array<{ label: string; position: number }> = [];
    for (let i = 0; i <= tickDivisions; i += 1) {
      const ratio = i / tickDivisions;
      const value = axisMaxIv - ratio * ivRange;
      const y = height - ((value - axisMinIv) / ivRange) * (height - topPadding) - topPadding;
      ticks.push({ label: this.formatIv(value), position: Number(y.toFixed(2)) });
    }

    const axis: SmileAxis = {
      minStrike: minStrikeText || firstRow?.strikeText || '',
      maxStrike: maxStrikeText || lastRow?.strikeText || '',
      minIv: this.formatIv(axisMinIv),
      maxIv: this.formatIv(axisMaxIv),
      ticks
    };

    const strikeEntries = Array.from(strikeMap.entries()).sort((a, b) => a[0] - b[0]);

    const sampleIv = (
      rows: Array<{ strike: number; iv: number }>,
      strike: number
    ): number | null => {
      if (!rows.length) {
        return null;
      }
      const first = rows[0];
      const last = rows[rows.length - 1];
      if (strike < first.strike || strike > last.strike) {
        return null;
      }
      for (let i = 0; i < rows.length; i += 1) {
        const current = rows[i];
        if (Math.abs(current.strike - strike) < 1e-6) {
          return current.iv;
        }
        if (current.strike > strike) {
          const prev = rows[i - 1];
          if (!prev || prev.strike === current.strike) {
            return current.iv;
          }
          const ratio = (strike - prev.strike) / (current.strike - prev.strike);
          return prev.iv + ratio * (current.iv - prev.iv);
        }
      }
      return last.iv;
    };

    let surface: VolSurfaceSeries | null = null;
    if (strikeEntries.length >= 2 && rawSeries.length >= 2) {
      const strikeValues = strikeEntries.map(([strike]) => strike);
      const strikeLabels = strikeEntries.map(([, label]) => label);
      const maturityIds = rawSeries.map((entry) => entry.maturity.id);
      const maturityLabels = rawSeries.map((entry) => entry.maturity.label);
      const maturityTicks = rawSeries.map((entry) => Date.parse(`${entry.maturity.id}T00:00:00Z`));
      const values = rawSeries.map((entry) =>
        strikeEntries.map(([strike]) => sampleIv(entry.rows, strike) ?? null)
      );

      let localMin = Number.POSITIVE_INFINITY;
      let localMax = Number.NEGATIVE_INFINITY;
      let pointCount = 0;
      values.forEach((row) => {
        row.forEach((value) => {
          if (value === null || !Number.isFinite(value)) {
            return;
          }
          pointCount += 1;
          if (value < localMin) localMin = value;
          if (value > localMax) localMax = value;
        });
      });

      if (pointCount > 0) {
        surface = {
          strikes: strikeValues,
          strikeLabels,
          maturityIds,
          maturityLabels,
          maturityTicks,
          values,
          minIv: localMin,
          maxIv: localMin === localMax ? localMin + 0.0001 : localMax,
          pointCount
        };
      }
    }

    return { series, axis, surface };
  }

  private buildHistoricalSmile(surface: VolSurfaceSeries): { series: SmileSeries[]; axis: SmileAxis } {
    const strikes = surface.strikes;
    const strikeLabels = surface.strikeLabels;
    const maturityLabels = surface.maturityLabels;
    const maturityIds = surface.maturityIds;
    const values = surface.values;

    if (!strikes.length || values.length === 0) {
      return {
        series: [],
        axis: { minStrike: '', maxStrike: '', minIv: '', maxIv: '', ticks: [] }
      };
    }

    let minStrike = Math.min(...strikes);
    let maxStrike = Math.max(...strikes);
    if (!Number.isFinite(minStrike) || !Number.isFinite(maxStrike) || minStrike === maxStrike) {
      minStrike = strikes[0] ?? 0;
      maxStrike = strikes[strikes.length - 1] ?? minStrike + 1;
      if (minStrike === maxStrike) {
        maxStrike = minStrike + 1;
      }
    }

    const minStrikeText = strikeLabels[0] ?? '';
    const maxStrikeText = strikeLabels[strikeLabels.length - 1] ?? '';

    const ivValues: number[] = [];
    let minIv = Number.POSITIVE_INFINITY;
    let maxIv = Number.NEGATIVE_INFINITY;
    values.forEach((row) => {
      row.forEach((value) => {
        if (value === null || !Number.isFinite(value)) {
          return;
        }
        ivValues.push(value);
        if (value < minIv) minIv = value;
        if (value > maxIv) maxIv = value;
      });
    });

    if (!Number.isFinite(minIv) || !Number.isFinite(maxIv)) {
      minIv = 0.05;
      maxIv = 1;
    }
    if (minIv === maxIv) {
      maxIv = minIv + 0.01;
    }

    let axisMinIv = minIv;
    let axisMaxIv = maxIv;
    if (ivValues.length >= 3) {
      const sorted = ivValues.slice().sort((a, b) => a - b);
      const quantile = (fraction: number): number => {
        if (!sorted.length) {
          return Number.NaN;
        }
        if (sorted.length === 1) {
          return sorted[0];
        }
        const pos = (sorted.length - 1) * fraction;
        const baseIndex = Math.floor(pos);
        const nextIndex = Math.min(baseIndex + 1, sorted.length - 1);
        const remainder = pos - baseIndex;
        const lower = sorted[baseIndex];
        const upper = sorted[nextIndex];
        return lower + (upper - lower) * remainder;
      };

      const lower = quantile(0.05);
      const upper = quantile(0.95);
      if (Number.isFinite(lower) && Number.isFinite(upper) && upper > lower) {
        axisMinIv = lower;
        axisMaxIv = upper;
      }
    }

    if (!Number.isFinite(axisMinIv) || !Number.isFinite(axisMaxIv)) {
      axisMinIv = minIv;
      axisMaxIv = maxIv;
    }

    if (axisMinIv === axisMaxIv) {
      axisMaxIv = axisMinIv + 0.01;
    }

    const baseRange = axisMaxIv - axisMinIv;
    const padding = baseRange > 0 ? baseRange * 0.08 : axisMinIv * 0.08 || 0.01;
    axisMinIv = Math.max(0.01, axisMinIv - padding);
    axisMaxIv = axisMaxIv + padding;
    if (axisMinIv >= axisMaxIv) {
      axisMaxIv = axisMinIv + 0.01;
    }

    const strikeRange = maxStrike - minStrike;
    const ivRange = axisMaxIv - axisMinIv;
    const width = SMILE_VIEWBOX_WIDTH;
    const height = SMILE_VIEWBOX_HEIGHT;
    const topPadding = 12;
    const selectedMaturity = this.selectedMaturity();

    const series: SmileSeries[] = values.map((row, rowIndex) => {
      const maturityLabel = maturityLabels[rowIndex] ?? `Maturity ${rowIndex + 1}`;
      const maturityId = maturityIds[rowIndex] ?? `hist-${rowIndex}`;
      const points: SmilePoint[] = [];

      row.forEach((iv, colIndex) => {
        if (iv === null || !Number.isFinite(iv)) {
          return;
        }
        const strike = strikes[colIndex] ?? 0;
        const strikeLabel = strikeLabels[colIndex] ?? strike.toString();
        const x = strikeRange > 0 ? ((strike - minStrike) / strikeRange) * width : width / 2;
        const clampedIv = Math.min(axisMaxIv, Math.max(axisMinIv, iv));
        const y = height - ((clampedIv - axisMinIv) / ivRange) * (height - topPadding) - topPadding;
        points.push({
          x: Number(x.toFixed(2)),
          y: Number(y.toFixed(2)),
          strike,
          strikeText: strikeLabel,
          iv,
          ivText: this.formatIv(iv)
        });
      });

      const path = points.map((point) => `${point.x},${point.y}`).join(' ');
      const isSelected = maturityId === selectedMaturity;

      return {
        maturity: maturityId,
        label: maturityLabel,
        color: SMILE_COLORS[rowIndex % SMILE_COLORS.length],
        points,
        path,
        isSelected
      };
    });

    let hasSelected = series.some((entry) => entry.isSelected && entry.points.length);
    if (!hasSelected) {
      for (let i = series.length - 1; i >= 0; i -= 1) {
        if (series[i].points.length) {
          series[i].isSelected = true;
          hasSelected = true;
          break;
        }
      }
    }

    const axisTicks: Array<{ label: string; position: number }> = [];
    const tickDivisions = 4;
    for (let i = 0; i <= tickDivisions; i += 1) {
      const ratio = i / tickDivisions;
      const value = axisMaxIv - ratio * ivRange;
      const y = height - ((value - axisMinIv) / ivRange) * (height - topPadding) - topPadding;
      axisTicks.push({ label: this.formatIv(value), position: Number(y.toFixed(2)) });
    }

    return {
      series,
      axis: {
        minStrike: minStrikeText,
        maxStrike: maxStrikeText,
        minIv: this.formatIv(axisMinIv),
        maxIv: this.formatIv(axisMaxIv),
        ticks: axisTicks
      }
    };
  }

  private applyHistoricalSmile(surface: VolSurfaceSeries | null): void {
    if (!surface) {
      this.smileSeries.set([]);
      this.smileAxis.set({ minStrike: '', maxStrike: '', minIv: '', maxIv: '', ticks: [] });
      return;
    }

    const { series, axis } = this.buildHistoricalSmile(surface);
    this.smileSeries.set(series);
    this.smileAxis.set(axis);

    const filter = this.smileFilter();
    if (filter && !series.some((entry) => entry.maturity === filter && entry.points.length)) {
      this.smileFilter.set(null);
    }
  }

  private computeSpreadSuggestions(
    rows: OptionRow[],
    baseStrike: number,
    expectedPrice: number
  ): SpreadSuggestions {
    if (!rows.length) {
      return { call: [], put: [] };
    }

    const sorted = [...rows].sort((a, b) => a.strike - b.strike);
    const baseRow = sorted.find((row) => Math.abs(row.strike - baseStrike) < 1e-6);
    if (!baseRow) {
      return { call: [], put: [] };
    }

    const callSpreads = this.computeCallSpreadSuggestions(sorted, baseRow, expectedPrice);
    const putSpreads = this.computePutSpreadSuggestions(sorted, baseRow, expectedPrice);
    return { call: callSpreads, put: putSpreads };
  }

  private computeCallSpreadSuggestions(
    rows: OptionRow[],
    baseRow: OptionRow,
    expectedPrice: number
  ): VerticalSpreadSuggestion[] {
    const longPremium = baseRow.call.ask;
    if (!isFiniteNumber(longPremium) || longPremium <= 0) {
      return [];
    }

    const results: VerticalSpreadSuggestion[] = [];
    rows.forEach((candidate) => {
      if (candidate.strike <= baseRow.strike) {
        return;
      }

      const shortPremium = candidate.call.bid;
      if (!isFiniteNumber(shortPremium) || shortPremium < 0) {
        return;
      }

      const width = candidate.strike - baseRow.strike;
      if (!Number.isFinite(width) || width <= 0) {
        return;
      }

      const netCost = longPremium - shortPremium;
      if (!Number.isFinite(netCost) || netCost <= 0 || netCost >= width) {
        return;
      }

      const payoffAtTarget =
        Math.max(expectedPrice - baseRow.strike, 0) - Math.max(expectedPrice - candidate.strike, 0);
      const expectedProfit = payoffAtTarget - netCost;
      if (!Number.isFinite(expectedProfit) || expectedProfit <= 0) {
        return;
      }

      const maxProfit = width - netCost;
      const returnPct = expectedProfit / netCost;

      results.push({
        spreadType: 'call',
        longStrike: baseRow.strikeText,
        shortStrike: candidate.strikeText,
        longPremiumText: formatCurrency(longPremium),
        shortPremiumText: formatCurrency(shortPremium),
        netCost,
        netCostText: formatCurrency(netCost),
        expectedProfit,
        expectedProfitText: formatCurrency(expectedProfit),
        maxProfit,
        maxProfitText: formatCurrency(maxProfit),
        maxLossText: formatCurrency(netCost),
        widthText: formatCurrency(width),
        returnPct,
        returnPctText: formatPercentText(returnPct * 100)
      });
    });

    return this.rankSpreadSuggestions(results);
  }

  private computePutSpreadSuggestions(
    rows: OptionRow[],
    baseRow: OptionRow,
    expectedPrice: number
  ): VerticalSpreadSuggestion[] {
    const longPremium = baseRow.put.ask;
    if (!isFiniteNumber(longPremium) || longPremium <= 0) {
      return [];
    }

    const results: VerticalSpreadSuggestion[] = [];
    rows.forEach((candidate) => {
      if (candidate.strike >= baseRow.strike) {
        return;
      }

      const shortPremium = candidate.put.bid;
      if (!isFiniteNumber(shortPremium) || shortPremium < 0) {
        return;
      }

      const width = baseRow.strike - candidate.strike;
      if (!Number.isFinite(width) || width <= 0) {
        return;
      }

      const netCost = longPremium - shortPremium;
      if (!Number.isFinite(netCost) || netCost <= 0 || netCost >= width) {
        return;
      }

      const payoffAtTarget =
        Math.max(baseRow.strike - expectedPrice, 0) - Math.max(candidate.strike - expectedPrice, 0);
      const expectedProfit = payoffAtTarget - netCost;
      if (!Number.isFinite(expectedProfit) || expectedProfit <= 0) {
        return;
      }

      const maxProfit = width - netCost;
      const returnPct = expectedProfit / netCost;

      results.push({
        spreadType: 'put',
        longStrike: baseRow.strikeText,
        shortStrike: candidate.strikeText,
        longPremiumText: formatCurrency(longPremium),
        shortPremiumText: formatCurrency(shortPremium),
        netCost,
        netCostText: formatCurrency(netCost),
        expectedProfit,
        expectedProfitText: formatCurrency(expectedProfit),
        maxProfit,
        maxProfitText: formatCurrency(maxProfit),
        maxLossText: formatCurrency(netCost),
        widthText: formatCurrency(width),
        returnPct,
        returnPctText: formatPercentText(returnPct * 100)
      });
    });

    return this.rankSpreadSuggestions(results);
  }

  private rankSpreadSuggestions(spreads: VerticalSpreadSuggestion[]): VerticalSpreadSuggestion[] {
    if (!spreads.length) {
      return [];
    }

    const scored = [...spreads].sort((a, b) => {
      const returnDiff = (b.returnPct ?? Number.NEGATIVE_INFINITY) - (a.returnPct ?? Number.NEGATIVE_INFINITY);
      if (Number.isFinite(returnDiff) && returnDiff !== 0) {
        return returnDiff;
      }
      return b.expectedProfit - a.expectedProfit;
    });

    return scored.slice(0, 3);
  }

  private recomputeSmile(chains: Record<string, OptionChain>): void {
    const data = this.buildSmileData(chains);
    this.smileSeries.set(data.series);
    this.smileAxis.set(data.axis);
    this.updateVolSurface(data.surface);
    const filter = this.smileFilter();
    if (filter && !data.series.some((series) => series.maturity === filter && series.points.length)) {
      this.smileFilter.set(null);
    }
  }

  private formatIv(value: number): string {
    const pct = value * 100;
    const digits = Math.abs(pct) >= 10 ? 1 : 2;
    return `${pct.toFixed(digits)}%`;
  }

  private gradientColorComponents(
    iv: number,
    minIv: number,
    maxIv: number
  ): { r: number; g: number; b: number; normalized: number } {
    if (!Number.isFinite(iv)) {
      return { r: 40, g: 40, b: 40, normalized: 0 };
    }
    const range = maxIv - minIv || 1;
    const normalized = Math.max(0, Math.min(1, (iv - minIv) / range));
    const start = { r: 118, g: 220, b: 178 }; // teal
    const end = { r: 244, g: 114, b: 182 }; // pink
    return {
      r: Math.round(start.r + (end.r - start.r) * normalized),
      g: Math.round(start.g + (end.g - start.g) * normalized),
      b: Math.round(start.b + (end.b - start.b) * normalized),
      normalized
    };
  }

  private updateVolSurface(surface: VolSurfaceSeries | null): void {
    this.liveVolSurface.set(surface);
  }

  private initVolSurface(): void {
    const canvas = this.volSurfaceCanvasRef?.nativeElement;
    if (!canvas) {
      return;
    }

    const width = canvas.clientWidth || 640;
    const height = canvas.clientHeight || 320;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    renderer.setClearColor(0x000000, 0);
    this.surfaceRenderer = renderer;

    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(6, 10, 6);
    scene.add(directional);
    scene.add(new THREE.HemisphereLight(0x6b8fde, 0x0c111b, 0.35));

    const grid = new THREE.GridHelper(14, 7, 0x233044, 0x1a2330);
    grid.position.y = 0;
    scene.add(grid);
    this.surfaceScene = scene;

    const camera = new THREE.PerspectiveCamera(36, width / height, 0.1, 100);
    camera.position.set(9, 7, 11);
    camera.lookAt(0, 2, 0);
    this.surfaceCamera = camera;

    this.updateSurfaceGeometry();
    this.animateSurface();
    window.addEventListener('resize', this.handleSurfaceResize, { passive: true });
  }

  private animateSurface(): void {
    if (!this.surfaceRenderer || !this.surfaceScene || !this.surfaceCamera) {
      return;
    }
    this.surfaceAnimationFrame = requestAnimationFrame(() => this.animateSurface());
    if (this.surfaceMesh) {
      this.surfaceMesh.rotation.y += 0.0035;
    }
    this.surfaceRenderer.render(this.surfaceScene, this.surfaceCamera);
  }

  private updateSurfaceGeometry(): void {
    if (!this.surfaceScene) {
      return;
    }

    if (!this.volSurfaceData) {
      if (this.surfaceMesh) {
        this.surfaceScene.remove(this.surfaceMesh);
        (this.surfaceMesh.geometry as THREE.BufferGeometry).dispose();
        (this.surfaceMesh.material as THREE.Material).dispose();
        this.surfaceMesh = null;
        this.renderSurface();
      }
      return;
    }

    const mesh = this.buildSurfaceMesh(this.volSurfaceData);
    if (!mesh) {
      return;
    }

    if (this.surfaceMesh) {
      this.surfaceScene.remove(this.surfaceMesh);
      (this.surfaceMesh.geometry as THREE.BufferGeometry).dispose();
      (this.surfaceMesh.material as THREE.Material).dispose();
    }

    this.surfaceMesh = mesh;
    this.surfaceScene.add(mesh);
    this.renderSurface();
  }

  private buildSurfaceMesh(surface: VolSurfaceSeries): THREE.Mesh | null {
    const rows = surface.values.length;
    const cols = surface.strikes.length;
    if (rows < 2 || cols < 2) {
      return null;
    }

    const positions: number[] = [];
    const colors: number[] = [];
    const color = new THREE.Color();

    const strikes = surface.strikes;
    const logStrikes = strikes.map((strike) => Math.log(strike));
    const logMin = Math.min(...logStrikes);
    const logMax = Math.max(...logStrikes);
    const logRange = logMax - logMin || 1;

    const ticks = surface.maturityTicks;
    const hasValidTicks = ticks.every((value) => Number.isFinite(value));
    const tickValues = hasValidTicks ? ticks : ticks.map((_, index) => index);
    const tickMin = Math.min(...tickValues);
    const tickMax = Math.max(...tickValues);
    const tickRange = tickMax - tickMin || 1;

    const xScale = 14;
    const zScale = 10;
    const yScale = 7;
    const ivRange = surface.maxIv - surface.minIv || 1;

    const coordX = (col: number) => ((logStrikes[col] - logMin) / logRange - 0.5) * xScale;
    const coordZ = (row: number) => ((tickValues[row] - tickMin) / tickRange - 0.5) * zScale;
    const coordY = (iv: number) => ((iv - surface.minIv) / ivRange) * yScale;

    const addVertex = (col: number, row: number, iv: number) => {
      positions.push(coordX(col), coordY(iv), coordZ(row));
      const components = this.gradientColorComponents(iv, surface.minIv, surface.maxIv);
      color.setRGB(components.r / 255, components.g / 255, components.b / 255);
      colors.push(color.r, color.g, color.b);
    };

    for (let row = 0; row < rows - 1; row += 1) {
      for (let col = 0; col < cols - 1; col += 1) {
        const v00 = surface.values[row]?.[col];
        const v10 = surface.values[row + 1]?.[col];
        const v01 = surface.values[row]?.[col + 1];
        const v11 = surface.values[row + 1]?.[col + 1];
        if (
          v00 === null ||
          v10 === null ||
          v01 === null ||
          v11 === null ||
          !Number.isFinite(v00) ||
          !Number.isFinite(v10) ||
          !Number.isFinite(v01) ||
          !Number.isFinite(v11)
        ) {
          continue;
        }

        addVertex(col, row, v00);
        addVertex(col, row + 1, v10);
        addVertex(col + 1, row + 1, v11);

        addVertex(col, row, v00);
        addVertex(col + 1, row + 1, v11);
        addVertex(col + 1, row, v01);
      }
    }

    if (positions.length === 0) {
      return null;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();

    const material = new THREE.MeshPhongMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      shininess: 80,
      transparent: true,
      opacity: 0.9
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = 0.5;
    return mesh;
  }

  private renderSurface(): void {
    if (this.surfaceRenderer && this.surfaceScene && this.surfaceCamera) {
      this.surfaceRenderer.render(this.surfaceScene, this.surfaceCamera);
    }
  }

  private handleSurfaceResize = (): void => {
    const canvas = this.volSurfaceCanvasRef?.nativeElement;
    if (!canvas || !this.surfaceRenderer || !this.surfaceCamera) {
      return;
    }
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) {
      return;
    }
    this.surfaceRenderer.setSize(width, height, false);
    this.surfaceCamera.aspect = width / height;
    this.surfaceCamera.updateProjectionMatrix();
    this.renderSurface();
  };

  private disposeVolSurface(): void {
    if (this.surfaceAnimationFrame !== undefined) {
      cancelAnimationFrame(this.surfaceAnimationFrame);
      this.surfaceAnimationFrame = undefined;
    }
    window.removeEventListener('resize', this.handleSurfaceResize);
    if (this.surfaceMesh) {
      this.surfaceScene?.remove(this.surfaceMesh);
      (this.surfaceMesh.geometry as THREE.BufferGeometry).dispose();
      (this.surfaceMesh.material as THREE.Material).dispose();
      this.surfaceMesh = null;
    }
    this.surfaceRenderer?.dispose();
    this.surfaceRenderer = null;
    this.surfaceCamera = null;
    this.surfaceScene = null;
  }

  private parseInstrumentMaturity(instrumentName: string): string | null {
    return maturityIdFromInstrumentName(instrumentName);
  }

  isSyntheticCurrency(currency: string | null): boolean {
    return (currency ?? '').toUpperCase() === SYNTHETIC_CURRENCY;
  }

  private subscribeToTicker(instrumentName: string): void {
    if (!instrumentName || this.isSyntheticCurrency(this.selectedCurrency())) {
      return;
    }
    this.unsubscribeFromTicker();
    this.currentTickerInstrument = instrumentName;
    this.tickerUnsubscribe = this.deribitWebsocket.subscribeTicker(instrumentName, (data) =>
      this.onTickerUpdate(instrumentName, data)
    );
  }

  private unsubscribeFromTicker(): void {
    if (this.tickerUnsubscribe) {
      this.tickerUnsubscribe();
      this.tickerUnsubscribe = null;
    }
    this.currentTickerInstrument = null;
  }

  private clearChainTickerSubscriptions(): void {
    this.chainTickerSubscriptions.forEach((unsubscribe) => unsubscribe());
    this.chainTickerSubscriptions.clear();
  }

  private updateChainTickerSubscriptions(maturity: string): void {
    if (!maturity || this.isSyntheticCurrency(this.selectedCurrency())) {
      this.clearChainTickerSubscriptions();
      return;
    }

    const chain = this.optionBuffers.chains[maturity];
    if (!chain) {
      this.clearChainTickerSubscriptions();
      return;
    }

    const nextInstruments = new Set<string>();
    chain.rows.forEach((row) => {
      if (row.call.instrumentName) {
        nextInstruments.add(row.call.instrumentName);
      }
      if (row.put.instrumentName) {
        nextInstruments.add(row.put.instrumentName);
      }
    });

    for (const [instrument, unsubscribe] of this.chainTickerSubscriptions.entries()) {
      if (!nextInstruments.has(instrument)) {
        unsubscribe();
        this.chainTickerSubscriptions.delete(instrument);
      }
    }

    nextInstruments.forEach((instrument) => {
      if (this.chainTickerSubscriptions.has(instrument)) {
        return;
      }
      const unsubscribe = this.deribitWebsocket.subscribeTicker(instrument, (data) =>
        this.onChainTickerUpdate(data)
      );
      this.chainTickerSubscriptions.set(instrument, unsubscribe);
    });
  }

  private onMaturityChanged(maturity: string): void {
    this.updateChainTickerSubscriptions(maturity);
  }

  private onTickerUpdate(instrumentName: string, ticker: DeribitTickerData): void {
    if (this.currentTickerInstrument !== instrumentName) {
      return;
    }
    if (this.selectedInstrument() !== instrumentName) {
      return;
    }

    const previous = this.instrumentSummary();
    const normalizedIv = normalizeDeribitIv(ticker.mark_iv ?? ticker.iv);
    const greeks = ticker.greeks ?? {};
    const summary: DeribitInstrumentSummary = {
      instrument_name: instrumentName,
      mark_price: ticker.mark_price ?? previous?.mark_price ?? 0,
      open_interest: ticker.open_interest ?? previous?.open_interest ?? 0,
      volume:
        ticker.stats?.volume !== undefined
          ? ticker.stats.volume
          : previous?.volume ?? 0,
      last_price: ticker.last_price ?? previous?.last_price,
      bid_price: ticker.best_bid_price ?? previous?.bid_price,
      ask_price: ticker.best_ask_price ?? previous?.ask_price,
      delta: ticker.delta ?? greeks.delta ?? previous?.delta,
      gamma: ticker.gamma ?? greeks.gamma ?? previous?.gamma,
      implied_volatility: normalizedIv ?? previous?.implied_volatility,
      underlying_price: ticker.underlying_price ?? previous?.underlying_price,
      creation_timestamp: ticker.timestamp ?? previous?.creation_timestamp
    };

    this.store.dispatch(dashboardInstrumentSummaryUpdate({ summary }));
  }

  private onChainTickerUpdate(ticker: DeribitTickerData): void {
    if (this.isSyntheticCurrency(this.selectedCurrency())) {
      return;
    }

    const maturity = updateChainsWithTicker(this.optionBuffers.chains, ticker);
    if (!maturity) {
      return;
    }

    const chainsCopy = cloneChains(this.optionBuffers.chains);
    this.store.dispatch(dashboardChainsUpdate({ chains: chainsCopy }));
  }
}
