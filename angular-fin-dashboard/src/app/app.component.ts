import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  signal
} from '@angular/core';
import { NgClass, NgFor, NgIf } from '@angular/common';
import * as THREE from 'three';
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
type SmileSeries = {
  maturity: string;
  label: string;
  color: string;
  points: SmilePoint[];
  path: string;
  isSelected: boolean;
};
type SmileAxis = { minStrike: string; maxStrike: string; minIv: string; maxIv: string };
type VolSurfaceSeries = {
  strikes: number[];
  strikeLabels: string[];
  maturityLabels: string[];
  maturityTicks: number[];
  values: (number | null)[][];
  minIv: number;
  maxIv: number;
  pointCount: number;
};

const FRAME_TARGET_MS = 16.67;
const MIN_SAMPLES_FOR_ASSESSMENT = 90;

const SYNTHETIC_CURRENCY = 'SYNTH';
const SMILE_COLORS = ['#76dcb2', '#82a3f2', '#fcbf49', '#f472b6', '#38bdf8', '#f97316'];

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
  readonly smileSeries = signal<SmileSeries[]>([], { equal: () => false });
  readonly smileAxis = signal<SmileAxis>({ minStrike: '', maxStrike: '', minIv: '', maxIv: '' });
  readonly smileFilter = signal<string | null>(null);
  readonly volSurface = signal<VolSurfaceSeries | null>(null, { equal: () => false });
  readonly loopRunning = signal(false);

  private volSurfaceCanvasRef?: ElementRef<HTMLCanvasElement>;

  @ViewChild('volSurfaceCanvas')
  set volSurfaceCanvas(element: ElementRef<HTMLCanvasElement> | undefined) {
    if (element) {
      this.volSurfaceCanvasRef = element;
      queueMicrotask(() => this.initVolSurface());
    }
  }

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

    this.recomputeSmile(this.chains());
    this.onMaturityChanged(maturity);
  }

  toggleSmileFilter(maturity: string): void {
    const current = this.smileFilter();
    this.smileFilter.set(current === maturity ? null : maturity);
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
    this.recomputeSmile(nextChains);
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
    this.recomputeSmile(nextChains);
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
    this.recomputeSmile(chains);
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

  private buildSmileData(
    chains: Record<string, OptionChain>
  ): { series: SmileSeries[]; axis: SmileAxis; surface: VolSurfaceSeries | null } {
    const maturities = this.maturities();
    if (!maturities.length) {
      return {
        series: [],
        axis: { minStrike: '', maxStrike: '', minIv: '', maxIv: '' },
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
        axis: { minStrike: '', maxStrike: '', minIv: '', maxIv: '' },
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

    const strikeRange = maxStrike - minStrike;
    const ivRange = maxIv - minIv;
    const width = 600;
    const height = 140;
    const topPadding = 12;

    const selectedMaturity = this.selectedMaturity();

    const series: SmileSeries[] = rawSeries.map((entry, index) => {
      const validRows = entry.rows;
      const color = SMILE_COLORS[index % SMILE_COLORS.length];
      const points: SmilePoint[] = validRows.map((row) => {
        const x = ((row.strike - minStrike) / strikeRange) * width;
        const y = height - ((row.iv - minIv) / ivRange) * (height - topPadding) - topPadding;
        return {
          x: Number(x.toFixed(2)),
          y: Number(y.toFixed(2)),
          strike: row.strike,
          iv: row.iv
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

    const axis: SmileAxis = {
      minStrike: minStrikeText || firstRow?.strikeText || '',
      maxStrike: maxStrikeText || lastRow?.strikeText || '',
      minIv: this.formatIv(minIv),
      maxIv: this.formatIv(maxIv)
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
    this.volSurface.set(surface);
    this.volSurfaceData = surface;
    this.updateSurfaceGeometry();
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
    this.recomputeSmile(chainsCopy);
  }
}
