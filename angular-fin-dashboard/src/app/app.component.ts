import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { NgClass, NgFor } from '@angular/common';
import { Store } from '@ngrx/store';
import { dashboardFrameUpdate } from './state/dashboard.actions';
import { DASHBOARD_FEATURE_KEY, DashboardState, initialDashboardState } from './state/dashboard.reducer';
import { createInitialStats, FrameStats, formatDuration, formatFrequency } from './models/frame-stats';
import { HISTORY_CAPACITY, RECENT_HISTORY_SIZE, ROW_COUNT } from './constants';
import {
  defaultFrameDuration,
  nextTickerSlice,
  type TickerRow,
  type TickerSummary
} from './data/generate-tickers';

const FRAME_TARGET_MS = defaultFrameDuration;
const MIN_SAMPLES_FOR_ASSESSMENT = 90;

type FrameMeasurement = {
  frameSpacing: number;
  dataDuration: number;
};

type AppState = { [DASHBOARD_FEATURE_KEY]: DashboardState };

const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [NgClass, NgFor],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AppComponent implements OnInit, OnDestroy {
  private frameStatsRef: FrameStats = { ...initialDashboardState.stats };
  private rowsBuffer: TickerRow[] = initialDashboardState.rows.map((row) => ({ ...row }));
  private summaryBuffer: TickerSummary = { ...initialDashboardState.summary };

  readonly rows = signal<TickerRow[]>(this.rowsBuffer, { equal: () => false });
  readonly summary = signal<TickerSummary>(this.summaryBuffer, { equal: () => false });
  readonly frameStats = signal<FrameStats>(this.frameStatsRef, { equal: () => false });
  readonly frameStatsView = computed(() => this.frameStats());
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
    nextTickerSlice(ROW_COUNT, this.rowsBuffer, this.summaryBuffer);
    const dataDuration = performance.now() - dataStart;

    this.updateFrameStats({ frameSpacing: 0, dataDuration });
  }

  trackBySymbol = (_: number, row: TickerRow) => row.symbol;

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
    nextTickerSlice(ROW_COUNT, this.rowsBuffer, this.summaryBuffer);
    const dataDuration = performance.now() - dataStart;

    this.updateFrameStats({
      frameSpacing: frameSpacing > 0 ? frameSpacing : 0,
      dataDuration
    });

    this.scheduleNextFrame();
  }

  private updateFrameStats(measurement: FrameMeasurement): void {
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
    this.rows.set(this.rowsBuffer);
    this.summary.set(this.summaryBuffer);
    const rowsForStore = this.cloneRowsForStore();
    const summaryForStore = this.cloneSummaryForStore();
    const signalDuration = performance.now() - signalStart;

    stats.lastSignalDuration = signalDuration;
    stats.lastSignalDurationText = formatDuration(signalDuration);

    const totalCost = measurement.dataDuration + signalDuration + statsDuration;

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

    const statsForStore = this.cloneStatsForStore();
    this.store.dispatch(dashboardFrameUpdate({ rows: rowsForStore, summary: summaryForStore, stats: statsForStore }));
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

  private resetFrameStats(): void {
    this.frameStatsRef = createInitialStats();
    this.frameHistory.fill(0);
    this.historyWriteIndex = 0;
    this.historyLength = 0;
    this.frameStats.set(this.frameStatsRef);
    this.dispatchSnapshot();
  }

  private cloneRowsForStore(): TickerRow[] {
    const source = this.rowsBuffer;
    const clone: TickerRow[] = new Array(source.length);
    for (let i = 0; i < source.length; i += 1) {
      const row = source[i];
      clone[i] = { ...row };
    }
    return clone;
  }

  private cloneSummaryForStore(): TickerSummary {
    return { ...this.summaryBuffer };
  }

  private cloneStatsForStore(): FrameStats {
    return { ...this.frameStatsRef };
  }

  private dispatchSnapshot(): void {
    this.store.dispatch(
      dashboardFrameUpdate({
        rows: this.cloneRowsForStore(),
        summary: this.cloneSummaryForStore(),
        stats: this.cloneStatsForStore()
      })
    );
  }
}
