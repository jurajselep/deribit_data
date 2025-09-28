import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { DecimalPipe, NgClass, NgFor, NgIf } from '@angular/common';
import { Store } from '@ngrx/store';
import { dashboardFrameUpdate, dashboardSelectMaturity } from './state/dashboard.actions';
import { DASHBOARD_FEATURE_KEY, DashboardState } from './state/dashboard.reducer';
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
import { DeribitInstrument, DeribitInstrumentSummary, DeribitTickerData } from './models/deribit';
import { DeribitService } from './services/deribit.service';
import { DeribitWebsocketService } from './services/deribit-websocket.service';

type FrameMeasurement = {
  frameSpacing: number;
  dataDuration: number;
};

type AppState = { [DASHBOARD_FEATURE_KEY]: DashboardState };

type SmilePoint = { x: number; y: number; strike: number; iv: number };
type SmileAxis = { minStrike: string; maxStrike: string };

const FRAME_TARGET_MS = 16.67;
const MIN_SAMPLES_FOR_ASSESSMENT = 90;

const SYNTHETIC_CURRENCY = 'SYNTH';

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
  imports: [NgClass, NgFor, NgIf, DecimalPipe],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AppComponent implements OnInit, OnDestroy {
  private optionBuffers: OptionDataBuffers = createOptionDataBuffers();
  private frameStatsRef: FrameStats = createInitialStats();
  private tickerUnsubscribe: (() => void) | null = null;
  private currentTickerInstrument: string | null = null;
  private readonly chainTickerSubscriptions = new Map<string, () => void>();

  readonly currencies: CurrencyOption[] = [
    { value: 'BTC', label: 'BTC' },
    { value: 'ETH', label: 'ETH' },
    { value: SYNTHETIC_CURRENCY, label: 'Synthetic Data' }
  ];
  readonly selectedCurrency = signal<string>('BTC');
  readonly instruments = signal<DeribitInstrument[]>([], { equal: () => false });
  readonly instrumentsLoading = signal(false);
  readonly instrumentsError = signal<string | null>(null);
  readonly selectedInstrument = signal<string | null>(null);
  readonly instrumentSummary = signal<DeribitInstrumentSummary | null>(null, { equal: () => false });
  readonly instrumentSummaryLoading = signal(false);
  readonly instrumentSummaryError = signal<string | null>(null);

  readonly maturities = signal(this.optionBuffers.maturities);
  readonly selectedMaturity = signal(this.optionBuffers.maturities[0]?.id ?? '', {
    equal: (a, b) => a === b
  });
  readonly chains = signal<Record<string, OptionChain>>(cloneChains(this.optionBuffers.chains), {
    equal: () => false
  });
  readonly selectedChain = computed<OptionChain | null>(() => {
    const maturity = this.selectedMaturity();
    const chains = this.chains();
    return maturity && chains[maturity] ? chains[maturity] : null;
  });
  readonly frameStats = signal<FrameStats>(this.frameStatsRef, { equal: () => false });
  readonly frameStatsView = computed(() => this.frameStats());
  readonly smilePoints = signal<SmilePoint[]>([], { equal: () => false });
  readonly smileAxis = signal<SmileAxis>({ minStrike: '', maxStrike: '' });
  readonly smilePath = computed(() => {
    const points = this.smilePoints();
    return points.length ? points.map((p) => `${p.x},${p.y}`).join(' ') : '';
  });
  readonly loopRunning = signal(false);

  private frameId?: number;
  private lastFrameTime = now();

  private readonly frameHistory = new Float32Array(HISTORY_CAPACITY);
  private historyWriteIndex = 0;
  private historyLength = 0;
  private readonly sortScratch: number[] = new Array(HISTORY_CAPACITY);

  constructor(
    private readonly store: Store<AppState>,
    private readonly deribit: DeribitService,
    private readonly deribitWebsocket: DeribitWebsocketService
  ) {}

  ngOnInit(): void {
    this.dispatchSnapshot();
    void this.loadInstruments(this.selectedCurrency());
    this.scheduleNextFrame();
  }

  ngOnDestroy(): void {
    this.stopLoop();
    this.unsubscribeFromTicker();
    this.clearChainTickerSubscriptions();
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
    this.selectedCurrency.set(currency);
    this.selectedInstrument.set(null);
    this.instruments.set([]);
    this.unsubscribeFromTicker();
    this.clearChainTickerSubscriptions();
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
    this.selectedMaturity.set(maturity);
    this.store.dispatch(dashboardSelectMaturity({ maturity }));

    const currentChain = this.chains()[maturity] ?? null;
    const smileData = this.buildSmileData(currentChain);
    this.smilePoints.set(smileData.points);
    this.smileAxis.set(smileData.axis);
    this.onMaturityChanged(maturity);
  }

  trackByStrike = (_: number, row: OptionRow) => row.strike;

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
    this.chains.set(nextChains);
    const signalDuration = performance.now() - signalStart;

    const smileStart = performance.now();
    const currentChain = nextChains[this.selectedMaturity()] ?? null;
    const smileData = this.buildSmileData(currentChain);
    const smileDuration = performance.now() - smileStart;

    this.smilePoints.set(smileData.points);
    this.smileAxis.set(smileData.axis);

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

    this.frameStats.set(this.frameStatsRef);

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

  private dispatchSnapshot(): void {
    const nextChains = cloneChains(this.optionBuffers.chains);
    const statsForStore: FrameStats = { ...this.frameStatsRef };
    this.chains.set(nextChains);
    const smileData = this.buildSmileData(nextChains[this.selectedMaturity()] ?? null);
    this.smilePoints.set(smileData.points);
    this.smileAxis.set(smileData.axis);
    this.store.dispatch(dashboardFrameUpdate({ chains: nextChains, stats: statsForStore }));
    const maturity = this.selectedMaturity();
    if (maturity) {
      this.store.dispatch(dashboardSelectMaturity({ maturity }));
    }
  }

  private async loadInstruments(currency: string): Promise<void> {
    this.instrumentsLoading.set(true);
    this.instrumentsError.set(null);
    this.instrumentSummary.set(null);
    this.instrumentSummaryError.set(null);
    this.instrumentSummaryLoading.set(false);
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
      this.instruments.set(sorted);
      this.initializeOptionData(sorted, bookSummaries);
      const current = this.selectedInstrument();
      const exists = current && sorted.some((instrument) => instrument.instrument_name === current);
      const targetInstrument = exists ? current : sorted[0]?.instrument_name ?? null;
      this.applyInstrument(targetInstrument ?? null);
    } catch (error) {
      const message = (error as Error).message ?? 'Unable to load instruments';
      this.instrumentsError.set(message);
      this.instrumentSummaryError.set(message);
      this.instruments.set([]);
      this.instrumentSummary.set(null);
    } finally {
      this.instrumentsLoading.set(false);
    }
  }

  private initializeOptionData(
    instruments: DeribitInstrument[],
    summaries?: Map<string, DeribitInstrumentSummary>
  ): void {
    this.clearChainTickerSubscriptions();
    this.optionBuffers = this.isSyntheticCurrency(this.selectedCurrency())
      ? createOptionDataBuffers()
      : createOptionDataBuffersFromInstruments(instruments, summaries);

    const maturities = this.optionBuffers.maturities;
    this.maturities.set(maturities);
    const initialMaturity = maturities[0]?.id ?? '';
    this.selectedMaturity.set(initialMaturity);
    this.dispatchSnapshot();
    this.onMaturityChanged(initialMaturity);
  }

  private applyInstrument(instrumentName: string | null): void {
    this.selectedInstrument.set(instrumentName);
    this.unsubscribeFromTicker();
    if (!instrumentName) {
      this.instrumentSummary.set(null);
      this.instrumentSummaryError.set(null);
      return;
    }

    const maturity = this.parseInstrumentMaturity(instrumentName);
    if (!maturity) {
      this.instrumentSummary.set(null);
      this.instrumentSummaryError.set(null);
      return;
    }

    if (maturity !== this.selectedMaturity()) {
      this.selectedMaturity.set(maturity);
      this.store.dispatch(dashboardSelectMaturity({ maturity }));
    }

    const chains = this.chains();
    const currentChain = chains[maturity] ?? null;
    const smileData = this.buildSmileData(currentChain);
    this.smilePoints.set(smileData.points);
    this.smileAxis.set(smileData.axis);
    this.onMaturityChanged(maturity);

    if (this.isSyntheticCurrency(this.selectedCurrency())) {
      this.instrumentSummary.set(null);
      this.instrumentSummaryError.set(null);
      return;
    }

    this.subscribeToTicker(instrumentName);
    void this.loadInstrumentSummary(instrumentName);
  }

  private async loadInstrumentSummary(instrumentName: string): Promise<void> {
    if (this.isSyntheticCurrency(this.selectedCurrency())) {
      this.instrumentSummary.set(null);
      this.instrumentSummaryError.set(null);
      return;
    }
    this.instrumentSummaryLoading.set(true);
    this.instrumentSummaryError.set(null);
    try {
      const summary = await this.deribit.fetchInstrumentSummary(instrumentName);
      this.instrumentSummary.set(summary);
    } catch (error) {
      this.instrumentSummary.set(null);
      this.instrumentSummaryError.set((error as Error).message ?? 'Unable to load instrument data');
    } finally {
      this.instrumentSummaryLoading.set(false);
    }
  }

  private buildSmileData(chain: OptionChain | null): { points: SmilePoint[]; axis: SmileAxis } {
    if (!chain || chain.rows.length === 0) {
      return { points: [], axis: { minStrike: '', maxStrike: '' } };
    }

    let minStrike = Number.POSITIVE_INFINITY;
    let maxStrike = Number.NEGATIVE_INFINITY;
    let minIv = Number.POSITIVE_INFINITY;
    let maxIv = Number.NEGATIVE_INFINITY;

    const ivs: number[] = new Array(chain.rows.length);

    for (let i = 0; i < chain.rows.length; i += 1) {
      const row = chain.rows[i];
      const iv = (row.call.iv + row.put.iv) / 2;
      ivs[i] = iv;
      if (row.strike < minStrike) minStrike = row.strike;
      if (row.strike > maxStrike) maxStrike = row.strike;
      if (iv < minIv) minIv = iv;
      if (iv > maxIv) maxIv = iv;
    }

    const strikeRange = maxStrike - minStrike || 1;
    const ivRange = maxIv - minIv || 1;
    const width = 600;
    const height = 140;
    const topPadding = 12;

    const points: SmilePoint[] = chain.rows.map((row, idx) => {
      const x = ((row.strike - minStrike) / strikeRange) * width;
      const y = height - ((ivs[idx] - minIv) / ivRange) * (height - topPadding) - topPadding;
      return {
        x: Number(x.toFixed(2)),
        y: Number(y.toFixed(2)),
        strike: row.strike,
        iv: ivs[idx]
      };
    });

    return {
      points,
      axis: {
        minStrike: chain.rows[0]?.strikeText ?? '',
        maxStrike: chain.rows[chain.rows.length - 1]?.strikeText ?? ''
      }
    };
  }

  private parseInstrumentMaturity(instrumentName: string): string | null {
    return maturityIdFromInstrumentName(instrumentName);
  }

  private isSyntheticCurrency(currency: string | null): boolean {
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

    this.instrumentSummary.set(summary);
    this.instrumentSummaryError.set(null);
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
    this.chains.set(chainsCopy);

    if (maturity === this.selectedMaturity()) {
      const currentChain = chainsCopy[maturity] ?? null;
      const smileData = this.buildSmileData(currentChain);
      this.smilePoints.set(smileData.points);
      this.smileAxis.set(smileData.axis);
    }
  }
}
