import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { NgClass, NgFor, NgIf } from '@angular/common';
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
  mutateOptionData
} from './data/options-chain';

const FRAME_TARGET_MS = 16.67;
const MIN_SAMPLES_FOR_ASSESSMENT = 90;

type FrameMeasurement = {
  frameSpacing: number;
  dataDuration: number;
};

type AppState = { [DASHBOARD_FEATURE_KEY]: DashboardState };

type SmilePoint = { x: number; y: number; strike: number; iv: number };
type SmileAxis = { minStrike: string; maxStrike: string };

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
export class AppComponent implements OnInit, OnDestroy {
  private readonly optionBuffers: OptionDataBuffers = createOptionDataBuffers();
  private frameStatsRef: FrameStats = createInitialStats();

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
  readonly loopRunning = signal(true);

  private frameId?: number;
  private lastFrameTime = now();

  private readonly frameHistory = new Float32Array(HISTORY_CAPACITY);
  private historyWriteIndex = 0;
  private historyLength = 0;
  private readonly sortScratch: number[] = new Array(HISTORY_CAPACITY);

  constructor(private readonly store: Store<AppState>) {}

  ngOnInit(): void {
    this.dispatchSnapshot();
    this.scheduleNextFrame();
  }

  ngOnDestroy(): void {
    this.stopLoop();
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
    const dataStart = performance.now();
    mutateOptionData(this.optionBuffers);
    const dataDuration = performance.now() - dataStart;

    this.afterFrame({ frameSpacing: 0, dataDuration });
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
  }

  trackByStrike = (_: number, row: OptionRow) => row.strike;

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

    const dataStart = performance.now();
    mutateOptionData(this.optionBuffers);
    const dataDuration = performance.now() - dataStart;

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
}
