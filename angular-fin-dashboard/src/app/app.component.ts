import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { NgClass, NgFor } from '@angular/common';
import {
  defaultFrameDuration,
  nextTickerSlice,
  type TickerRow,
  type TickerSummary
} from './data/generate-tickers';

const ROW_COUNT = 20;
const FRAME_TARGET_MS = defaultFrameDuration;
const MIN_SAMPLES_FOR_ASSESSMENT = 90;
const HISTORY_CAPACITY = 180;
const RECENT_HISTORY_SIZE = 12;

type FrameStats = {
  sampleCount: number;
  totalDuration: number;
  totalFrameSpacing: number;
  lastDuration: number;
  lastDurationText: string;
  averageDuration: number;
  averageDurationText: string;
  instantFps: number;
  instantFpsText: string;
  averageFps: number;
  averageFpsText: string;
  averageFrameSpacing: number;
  averageFrameSpacingText: string;
  meets60: boolean;
  statusText: string;
  windowSampleCount: number;
  windowMinDuration: number;
  windowMinDurationText: string;
  windowMaxDuration: number;
  windowMaxDurationText: string;
  windowP95Duration: number;
  windowP95DurationText: string;
  windowP99Duration: number;
  windowP99DurationText: string;
  recentDurationsText: string;
  lastFrameSpacing: number;
  lastFrameSpacingText: string;
  lastDataDuration: number;
  lastDataDurationText: string;
  lastSignalDuration: number;
  lastSignalDurationText: string;
  lastStatsDuration: number;
  lastStatsDurationText: string;
};

const formatMs = (value: number): string => value.toFixed(2);
const formatFps = (value: number): string => (Number.isFinite(value) ? value.toFixed(0) : '0');

const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

const createInitialStats = (): FrameStats => ({
  sampleCount: 0,
  totalDuration: 0,
  totalFrameSpacing: 0,
  lastDuration: 0,
  lastDurationText: formatMs(0),
  averageDuration: 0,
  averageDurationText: formatMs(0),
  instantFps: 0,
  instantFpsText: formatFps(0),
  averageFps: 0,
  averageFpsText: formatFps(0),
  averageFrameSpacing: 0,
  averageFrameSpacingText: formatMs(0),
  meets60: false,
  statusText: 'Measuring...',
  windowSampleCount: 0,
  windowMinDuration: 0,
  windowMinDurationText: formatMs(0),
  windowMaxDuration: 0,
  windowMaxDurationText: formatMs(0),
  windowP95Duration: 0,
  windowP95DurationText: formatMs(0),
  windowP99Duration: 0,
  windowP99DurationText: formatMs(0),
  recentDurationsText: '',
  lastFrameSpacing: 0,
  lastFrameSpacingText: formatMs(0),
  lastDataDuration: 0,
  lastDataDurationText: formatMs(0),
  lastSignalDuration: 0,
  lastSignalDurationText: formatMs(0),
  lastStatsDuration: 0,
  lastStatsDurationText: formatMs(0)
});

type FrameMeasurement = {
  frameSpacing: number;
  dataDuration: number;
  signalDuration: number;
};

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [NgClass, NgFor],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AppComponent implements OnInit, OnDestroy {
  private frameStatsRef = createInitialStats();

  private readonly initialSnapshot = nextTickerSlice(ROW_COUNT);
  readonly rows = signal<TickerRow[]>([...this.initialSnapshot.rows]);
  readonly summary = signal<TickerSummary>({ ...this.initialSnapshot.summary });
  readonly frameStats = signal<FrameStats>({ ...this.frameStatsRef });
  readonly frameStatsView = computed(() => this.frameStats());
  readonly loopRunning = signal(true);

  private frameId?: number;
  private lastFrameTime = now();

  private readonly frameHistory = new Float32Array(HISTORY_CAPACITY);
  private historyWriteIndex = 0;
  private historyLength = 0;
  private readonly sortScratch: number[] = new Array(HISTORY_CAPACITY);

  ngOnInit(): void {
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
    const rowsRef = this.rows();
    const summaryRef = this.summary();

    const dataStart = performance.now();
    nextTickerSlice(ROW_COUNT, rowsRef, summaryRef);
    const dataDuration = performance.now() - dataStart;

    const signalStart = performance.now();
    this.rows.set([...rowsRef]);
    this.summary.set({ ...summaryRef });
    const signalDuration = performance.now() - signalStart;

    this.updateFrameStats({ frameSpacing: 0, dataDuration, signalDuration });
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

    const rowsRef = this.rows();
    const summaryRef = this.summary();

    const dataStart = performance.now();
    nextTickerSlice(ROW_COUNT, rowsRef, summaryRef);
    const dataDuration = performance.now() - dataStart;

    const signalStart = performance.now();
    this.rows.set([...rowsRef]);
    this.summary.set({ ...summaryRef });
    const signalDuration = performance.now() - signalStart;

    this.updateFrameStats({
      frameSpacing: frameSpacing > 0 ? frameSpacing : 0,
      dataDuration,
      signalDuration
    });

    this.scheduleNextFrame();
  }

  private updateFrameStats(measurement: FrameMeasurement): void {
    const stats = this.frameStatsRef;
    const statsWorkStart = performance.now();

    stats.sampleCount += 1;
    stats.lastDataDuration = measurement.dataDuration;
    stats.lastDataDurationText = formatMs(measurement.dataDuration);
    stats.lastSignalDuration = measurement.signalDuration;
    stats.lastSignalDurationText = formatMs(measurement.signalDuration);

    stats.lastFrameSpacing = measurement.frameSpacing;
    stats.lastFrameSpacingText = formatMs(measurement.frameSpacing);
    stats.totalFrameSpacing += measurement.frameSpacing;

    const avgSpacing = stats.totalFrameSpacing / stats.sampleCount;
    stats.averageFrameSpacing = avgSpacing;
    stats.averageFrameSpacingText = formatMs(avgSpacing || 0);
    stats.instantFps = measurement.frameSpacing > 0 ? 1000 / measurement.frameSpacing : stats.instantFps;
    stats.instantFpsText = formatFps(stats.instantFps);
    stats.averageFps = avgSpacing > 0 ? 1000 / avgSpacing : stats.averageFps;
    stats.averageFpsText = formatFps(stats.averageFps);

    const statsDuration = performance.now() - statsWorkStart;
    stats.lastStatsDuration = statsDuration;
    stats.lastStatsDurationText = formatMs(statsDuration);

    const totalCost = measurement.dataDuration + measurement.signalDuration + statsDuration;

    stats.totalDuration += totalCost;
    stats.lastDuration = totalCost;
    stats.lastDurationText = formatMs(totalCost);
    stats.averageDuration = stats.totalDuration / stats.sampleCount;
    stats.averageDurationText = formatMs(stats.averageDuration || 0);

    const meetsBudget =
      stats.sampleCount >= MIN_SAMPLES_FOR_ASSESSMENT &&
      stats.averageDuration <= FRAME_TARGET_MS;
    stats.meets60 = meetsBudget;
    stats.statusText = stats.sampleCount < MIN_SAMPLES_FOR_ASSESSMENT ? 'Measuring...' : meetsBudget ? 'Yes' : 'No';

    this.updateHistory(totalCost, stats);
    this.frameStats.set({ ...stats });
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
      stats.windowMinDurationText = formatMs(0);
      stats.windowMaxDuration = 0;
      stats.windowMaxDurationText = formatMs(0);
      stats.windowP95Duration = 0;
      stats.windowP95DurationText = formatMs(0);
      stats.windowP99Duration = 0;
      stats.windowP99DurationText = formatMs(0);
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
      const formatted = formatMs(this.frameHistory[historyIndex]);
      historyText += i === 0 ? formatted : `, ${formatted}`;
    }

    stats.windowMinDuration = minValue;
    stats.windowMinDurationText = formatMs(minValue);
    stats.windowMaxDuration = maxValue;
    stats.windowMaxDurationText = formatMs(maxValue);
    stats.windowP95Duration = p95Value;
    stats.windowP95DurationText = formatMs(p95Value);
    stats.windowP99Duration = p99Value;
    stats.windowP99DurationText = formatMs(p99Value);
    stats.recentDurationsText = historyText;

    scratch.length = HISTORY_CAPACITY;
  }

  private resetFrameStats(): void {
    this.frameStatsRef = createInitialStats();
    this.frameStats.set({ ...this.frameStatsRef });
    this.frameHistory.fill(0);
    this.historyWriteIndex = 0;
    this.historyLength = 0;
  }
}
