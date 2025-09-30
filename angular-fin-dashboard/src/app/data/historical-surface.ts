import { DeribitTrade } from '../models/deribit';
import { VolSurfaceSeries } from '../models/vol-surface';
import { normalizeDeribitIv, parseDeribitInstrumentName } from './options-chain';

const MATURITY_LABEL_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric'
});

const STRIKE_LABEL_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0
});

interface TradeSample {
  maturityId: string;
  maturityTicks: number;
  maturityLabel: string;
  strike: number;
  iv: number;
  timestamp: number;
}

const formatMaturityLabel = (maturityId: string): string => {
  const date = new Date(`${maturityId}T00:00:00Z`);
  return MATURITY_LABEL_FORMATTER.format(date);
};

const formatStrikeLabel = (strike: number): string => STRIKE_LABEL_FORMATTER.format(strike);

const selectRepresentativeTrades = (
  trades: DeribitTrade[],
  referenceTimestamp: number
): Map<string, TradeSample> => {
  const samples = new Map<string, TradeSample>();

  trades.forEach((trade) => {
    const parsed = parseDeribitInstrumentName(trade.instrument_name);
    if (!parsed) {
      return;
    }

    const normalizedIv = normalizeDeribitIv(trade.iv ?? null);
    if (normalizedIv === null || !Number.isFinite(normalizedIv) || normalizedIv <= 0) {
      return;
    }

    const maturityLabel = formatMaturityLabel(parsed.maturityId);
    const nextSample: TradeSample = {
      maturityId: parsed.maturityId,
      maturityTicks: Date.parse(`${parsed.maturityId}T00:00:00Z`),
      maturityLabel,
      strike: parsed.strike,
      iv: normalizedIv,
      timestamp: trade.timestamp
    };

    const existing = samples.get(trade.instrument_name);
    if (!existing) {
      samples.set(trade.instrument_name, nextSample);
      return;
    }

    const existingDelta = Math.abs(referenceTimestamp - existing.timestamp);
    const nextDelta = Math.abs(referenceTimestamp - nextSample.timestamp);
    const existingIsPast = existing.timestamp <= referenceTimestamp;
    const nextIsPast = nextSample.timestamp <= referenceTimestamp;

    if (nextIsPast && !existingIsPast) {
      samples.set(trade.instrument_name, nextSample);
      return;
    }

    if (nextIsPast === existingIsPast && nextDelta < existingDelta) {
      samples.set(trade.instrument_name, nextSample);
    }
  });

  return samples;
};

export const buildHistoricalSurface = (
  trades: DeribitTrade[],
  referenceTimestamp: number
): VolSurfaceSeries | null => {
  const samples = selectRepresentativeTrades(trades, referenceTimestamp);
  if (!samples.size) {
    return null;
  }

  const rawMaturities = new Map<
    string,
    {
      label: string;
      ticks: number;
      samples: Map<number, TradeSample>;
    }
  >();

  samples.forEach((sample) => {
    let entry = rawMaturities.get(sample.maturityId);
    if (!entry) {
      entry = {
        label: sample.maturityLabel,
        ticks: sample.maturityTicks,
        samples: new Map<number, TradeSample>()
      };
      rawMaturities.set(sample.maturityId, entry);
    }

    const existing = entry.samples.get(sample.strike);
    if (!existing || Math.abs(referenceTimestamp - sample.timestamp) < Math.abs(referenceTimestamp - existing.timestamp)) {
      entry.samples.set(sample.strike, sample);
    }
  });

  const filteredMaturities: Array<{
    id: string;
    label: string;
    ticks: number;
    samples: TradeSample[];
  }> = [];
  const strikeSet = new Set<number>();

  for (const [id, entry] of rawMaturities.entries()) {
    const sortedSamples = Array.from(entry.samples.values()).sort((a, b) => a.strike - b.strike);
    if (sortedSamples.length < 2) {
      continue;
    }
    filteredMaturities.push({ id, label: entry.label, ticks: entry.ticks, samples: sortedSamples });
    sortedSamples.forEach((sample) => strikeSet.add(sample.strike));
  }

  if (filteredMaturities.length < 2 || strikeSet.size < 2) {
    return null;
  }

  const MIN_STRIKE_POINTS = 10;
  let strikeValues = Array.from(strikeSet).sort((a, b) => a - b);
  if (strikeValues.length < MIN_STRIKE_POINTS) {
    const first = strikeValues[0];
    const last = strikeValues[strikeValues.length - 1];
    if (last > first) {
      const dense: number[] = [];
      const stepCount = MIN_STRIKE_POINTS - 1;
      const step = (last - first) / stepCount;
      for (let i = 0; i <= stepCount; i += 1) {
        dense.push(first + step * i);
      }
      strikeValues = dense;
    }
  }

  const sampleIv = (samples: TradeSample[], strike: number): number | null => {
    if (!samples.length) {
      return null;
    }
    if (samples.length === 1) {
      return samples[0].iv;
    }
    if (strike <= samples[0].strike) {
      return samples[0].iv;
    }
    const last = samples[samples.length - 1];
    if (strike >= last.strike) {
      return last.iv;
    }
    for (let i = 1; i < samples.length; i += 1) {
      const prev = samples[i - 1];
      const current = samples[i];
      if (strike <= current.strike) {
        if (current.strike === prev.strike) {
          return current.iv;
        }
        const ratio = (strike - prev.strike) / (current.strike - prev.strike);
        return prev.iv + ratio * (current.iv - prev.iv);
      }
    }
    return last.iv;
  };

  let minIv = Number.POSITIVE_INFINITY;
  let maxIv = Number.NEGATIVE_INFINITY;
  let pointCount = 0;

  const orderedMaturities = filteredMaturities.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
  const strikeLabels = strikeValues.map((strike) => formatStrikeLabel(strike));

  const orderedValues = orderedMaturities.map((entry) => {
    const row = strikeValues.map((strike) => {
      const value = sampleIv(entry.samples, strike);
      if (value === null || !Number.isFinite(value)) {
        return null;
      }
      if (value < minIv) minIv = value;
      if (value > maxIv) maxIv = value;
      pointCount += 1;
      return value;
    });
    return row;
  });

  if (!Number.isFinite(minIv) || !Number.isFinite(maxIv) || pointCount === 0) {
    return null;
  }

  if (minIv === maxIv) {
    maxIv = minIv + 0.0001;
  }

  return {
    strikes: strikeValues,
    strikeLabels,
    maturityIds: orderedMaturities.map((entry) => entry.id),
    maturityLabels: orderedMaturities.map((entry) => entry.label),
    maturityTicks: orderedMaturities.map((entry) => entry.ticks),
    values: orderedValues,
    minIv,
    maxIv,
    pointCount
  };
};
