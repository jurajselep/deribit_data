import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  NgZone,
  OnDestroy,
  OnInit
} from '@angular/core';
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
  lastDuration: number;
  lastDurationText: string;
  averageDuration: number;
  averageDurationText: string;
  instantFps: number;
  instantFpsText: string;
  averageFps: number;
  averageFpsText: string;
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
};

const formatMs = (value: number): string => value.toFixed(2);
const formatFps = (value: number): string => (Number.isFinite(value) ? value.toFixed(0) : '0');

const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

const initialFrameStats: FrameStats = {
  sampleCount: 0,
  totalDuration: 0,
  lastDuration: 0,
  lastDurationText: formatMs(0),
  averageDuration: 0,
  averageDurationText: formatMs(0),
  instantFps: 0,
  instantFpsText: formatFps(0),
  averageFps: 0,
  averageFpsText: formatFps(0),
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
  recentDurationsText: ''
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
  rows: TickerRow[];
  summary: TickerSummary;
  frameDiagnostics: FrameStats = { ...initialFrameStats };

  private readonly frameStats: FrameStats = { ...initialFrameStats };

  private frameId?: number;
  private lastFrameTime = now();

  private readonly frameHistory = new Float32Array(HISTORY_CAPACITY);
  private historyWriteIndex = 0;
  private historyLength = 0;
  private readonly sortScratch: number[] = new Array(HISTORY_CAPACITY);

  constructor(private readonly zone: NgZone, private readonly cdr: ChangeDetectorRef) {
    const snapshot = nextTickerSlice(ROW_COUNT);
    this.rows = snapshot.rows;
    this.summary = snapshot.summary;
    this.frameDiagnostics = this.frameStats;
  }

  ngOnInit(): void {
    this.zone.runOutsideAngular(() => {
      this.lastFrameTime = now();
      this.scheduleNextFrame();
    });
  }

  ngOnDestroy(): void {
    if (this.frameId !== undefined) {
      window.cancelAnimationFrame(this.frameId);
    }
  }

  refreshOnce(): void {
    const fresh = nextTickerSlice(ROW_COUNT);
    this.rows = fresh.rows;
    this.summary = fresh.summary;
    this.resetFrameStats();
    this.lastFrameTime = now();

    this.zone.run(() => {
      this.cdr.detectChanges();
    });
  }

  trackBySymbol = (_: number, row: TickerRow) => row.symbol;

  private scheduleNextFrame(): void {
    this.frameId = window.requestAnimationFrame((timestamp) => this.onAnimationFrame(timestamp));
  }

  private onAnimationFrame(timestamp: number): void {
    const delta = timestamp - this.lastFrameTime;
    this.lastFrameTime = timestamp;

    nextTickerSlice(ROW_COUNT, this.rows, this.summary);

    const safeDelta = delta > 0 ? delta : 0;
    this.updateFrameStats(safeDelta);

    this.zone.run(() => {
      this.cdr.detectChanges();
    });

    this.scheduleNextFrame();
  }

  private updateFrameStats(delta: number): void {
    const stats = this.frameStats;

    stats.sampleCount += 1;
    stats.totalDuration += delta;
    stats.lastDuration = delta;
    stats.lastDurationText = formatMs(delta);
    stats.instantFps = delta > 0 ? 1000 / delta : stats.instantFps;
    stats.instantFpsText = formatFps(stats.instantFps);

    stats.averageDuration = stats.totalDuration / stats.sampleCount;
    stats.averageDurationText = formatMs(stats.averageDuration || 0);
    stats.averageFps = stats.averageDuration > 0 ? 1000 / stats.averageDuration : stats.averageFps;
    stats.averageFpsText = formatFps(stats.averageFps);

    const meetsBudget =
      stats.sampleCount >= MIN_SAMPLES_FOR_ASSESSMENT &&
      stats.averageDuration <= FRAME_TARGET_MS;

    stats.meets60 = meetsBudget;
    stats.statusText =
      stats.sampleCount < MIN_SAMPLES_FOR_ASSESSMENT ? 'Measuring...' : meetsBudget ? 'Yes' : 'No';

    this.updateHistory(delta, stats);

    this.frameDiagnostics = stats;
  }

  private updateHistory(delta: number, stats: FrameStats): void {
    this.frameHistory[this.historyWriteIndex] = delta;
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

    stats.windowMinDuration = minValue;
    stats.windowMinDurationText = formatMs(minValue);
    stats.windowMaxDuration = maxValue;
    stats.windowMaxDurationText = formatMs(maxValue);
    stats.windowP95Duration = p95Value;
    stats.windowP95DurationText = formatMs(p95Value);
    stats.windowP99Duration = p99Value;
    stats.windowP99DurationText = formatMs(p99Value);

    const recentCount = Math.min(RECENT_HISTORY_SIZE, windowSize);
    let historyText = '';
    for (let i = 0; i < recentCount; i += 1) {
      const historyIndex = (this.historyWriteIndex - recentCount + i + HISTORY_CAPACITY) % HISTORY_CAPACITY;
      const formatted = formatMs(this.frameHistory[historyIndex]);
      historyText += i === 0 ? formatted : `, ${formatted}`;
    }
    stats.recentDurationsText = historyText;

    scratch.length = HISTORY_CAPACITY;
  }

  private resetFrameStats(): void {
    const stats = this.frameStats;
    stats.sampleCount = 0;
    stats.totalDuration = 0;
    stats.lastDuration = 0;
    stats.lastDurationText = formatMs(0);
    stats.averageDuration = 0;
    stats.averageDurationText = formatMs(0);
    stats.instantFps = 0;
    stats.instantFpsText = formatFps(0);
    stats.averageFps = 0;
    stats.averageFpsText = formatFps(0);
    stats.meets60 = false;
    stats.statusText = 'Measuring...';
    stats.windowSampleCount = 0;
    stats.windowMinDuration = 0;
    stats.windowMinDurationText = formatMs(0);
    stats.windowMaxDuration = 0;
    stats.windowMaxDurationText = formatMs(0);
    stats.windowP95Duration = 0;
    stats.windowP95DurationText = formatMs(0);
    stats.windowP99Duration = 0;
    stats.windowP99DurationText = formatMs(0);
    stats.recentDurationsText = '';

    this.historyWriteIndex = 0;
    this.historyLength = 0;

    this.frameDiagnostics = stats;
  }
}
