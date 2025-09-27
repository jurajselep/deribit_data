export interface FrameStats {
  sampleCount: number;
  totalDuration: number;
  totalSmileDuration: number;
  totalFrameSpacing: number;
  lastDuration: number;
  lastDurationText: string;
  lastSmileDuration: number;
  lastSmileDurationText: string;
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
}

const formatMs = (value: number): string => value.toFixed(2);
const formatFps = (value: number): string => (Number.isFinite(value) ? value.toFixed(0) : '0');

export const createInitialStats = (): FrameStats => ({
  sampleCount: 0,
  totalDuration: 0,
  totalSmileDuration: 0,
  totalFrameSpacing: 0,
  lastDuration: 0,
  lastDurationText: formatMs(0),
  lastSmileDuration: 0,
  lastSmileDurationText: formatMs(0),
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

export const formatDuration = formatMs;
export const formatFrequency = formatFps;
