const SYMBOLS = [
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'NFLX', 'JPM',
  'BAC', 'V', 'MA', 'UNH', 'HD', 'XOM', 'CVX', 'AMD', 'INTC', 'ORCL', 'BABA'
];

const FRAME_TIME_FALLBACK = 16.67;

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

type FormatterOptions = {
  fractionDigits?: number;
  signed?: boolean;
  currency?: boolean;
  suffix?: string;
};

const makeFormatter = ({
  fractionDigits = 2,
  signed = false,
  currency = false,
  suffix = ''
}: FormatterOptions = {}) => {
  const pow = 10 ** fractionDigits;

  return (value: number): string => {
    const isNegative = value < 0;
    const abs = Math.abs(value);
    const rounded = Math.round(abs * pow) / pow;
    const intPart = Math.trunc(rounded);
    const fracPart = fractionDigits > 0 ? Math.round((rounded - intPart) * pow) : 0;

    let intString = intPart.toString();
    let result = '';

    for (let i = 0; i < intString.length; i += 1) {
      const idx = intString.length - 1 - i;
      result = intString[idx] + result;
      if ((i + 1) % 3 === 0 && idx !== 0) {
        result = ',' + result;
      }
    }

    if (intString.length === 0) {
      result = '0';
    }

    if (fractionDigits > 0) {
      const fracString = fracPart.toString().padStart(fractionDigits, '0');
      result += '.' + fracString;
    }

    if (currency) {
      result = '$' + result;
    }

    if (signed) {
      const sign = isNegative ? '-' : value > 0 ? '+' : '';
      result = sign + result;
    } else if (isNegative) {
      result = '-' + result;
    }

    if (suffix) {
      result += suffix;
    }

    return result;
  };
};

const formatPrice = makeFormatter({ fractionDigits: 2, currency: true });
const formatSigned = makeFormatter({ fractionDigits: 2, signed: true });
const formatSignedPct = makeFormatter({ fractionDigits: 2, signed: true, suffix: '%' });
const formatLarge = (value: number): string => {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  if (abs >= 1_000_000_000) {
    return `${sign}${(abs / 1_000_000_000).toFixed(2)}B`;
  }
  if (abs >= 1_000_000) {
    return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  }
  if (abs >= 1_000) {
    return `${sign}${(abs / 1_000).toFixed(1)}K`;
  }

  return `${sign}${Math.round(abs)}`;
};

const randomFloat = (min: number, max: number): number => Math.random() * (max - min) + min;
const randomInt = (min: number, max: number): number =>
  Math.floor(Math.random() * (max - min + 1)) + min;

export interface TickerRow {
  symbol: string;
  price: number;
  change: number;
  changePct: number;
  volume: number;
  marketCap: number;
  updatedAt: number;
  priceText: string;
  changeText: string;
  changePctText: string;
  volumeText: string;
  marketCapText: string;
}

export interface TickerSummary {
  count: number;
  gainers: number;
  losers: number;
  averageMove: number;
  averageMoveText: string;
  updatedAt: number;
  lastUpdatedText: string;
}

export interface TickerSnapshot {
  rows: TickerRow[];
  summary: TickerSummary;
}

const createEmptyRow = (symbol: string): TickerRow => ({
  symbol,
  price: 0,
  change: 0,
  changePct: 0,
  volume: 0,
  marketCap: 0,
  updatedAt: 0,
  priceText: '$0.00',
  changeText: '0.00',
  changePctText: '0.00%',
  volumeText: '0',
  marketCapText: '0'
});

const ensureRows = (count: number, rows?: TickerRow[]): TickerRow[] => {
  if (rows && rows.length === count) {
    return rows;
  }

  const nextRows: TickerRow[] = rows ? rows.slice(0, count) : new Array<TickerRow>(count);

  for (let i = 0; i < count; i += 1) {
    nextRows[i] = createEmptyRow(SYMBOLS[i % SYMBOLS.length]);
  }

  return nextRows;
};

const ensureSummary = (summary?: TickerSummary, count = 0): TickerSummary => {
  if (summary) {
    summary.count = count;
    return summary;
  }

  return {
    count,
    gainers: 0,
    losers: 0,
    averageMove: 0,
    averageMoveText: '0.00%',
    updatedAt: 0,
    lastUpdatedText: '--:--:--'
  };
};

const updateRow = (row: TickerRow, now: number): void => {
  const priorPrice = row.price || randomFloat(20, 350);
  const drift = priorPrice * 0.0125;
  const price = Math.max(0.5, priorPrice + randomFloat(-drift, drift));
  const change = price - priorPrice;
  const changePct = priorPrice === 0 ? 0 : (change / priorPrice) * 100;
  const volumeBase = row.volume || randomInt(120_000, 3_500_000);
  const volume = Math.max(1, Math.round(volumeBase * randomFloat(0.96, 1.06)));
  const marketCap = Math.max(volume, Math.round(price * randomInt(1_000_000, 80_000_000)));

  row.price = price;
  row.change = change;
  row.changePct = changePct;
  row.volume = volume;
  row.marketCap = marketCap;
  row.updatedAt = now;
  row.priceText = formatPrice(price);
  row.changeText = formatSigned(change);
  row.changePctText = formatSignedPct(changePct);
  row.volumeText = formatLarge(volume);
  row.marketCapText = formatLarge(marketCap);
};

export function nextTickerSlice(
  count = SYMBOLS.length,
  previous?: TickerRow[],
  summaryInput?: TickerSummary
): TickerSnapshot {
  const rows = ensureRows(count, previous);
  const summary = ensureSummary(summaryInput, count);

  let gainers = 0;
  let losers = 0;
  let aggregateMove = 0;
  let latest = summary.updatedAt;

  const now = performance?.now?.() ?? Date.now();

  for (let i = 0; i < count; i += 1) {
    const row = rows[i];

    updateRow(row, now);

    if (row.change > 0) {
      gainers += 1;
    } else if (row.change < 0) {
      losers += 1;
    }

    aggregateMove += row.changePct;
    if (row.updatedAt > latest) {
      latest = row.updatedAt;
    }
  }

  summary.gainers = gainers;
  summary.losers = losers;
  summary.averageMove = count === 0 ? 0 : aggregateMove / count;
  summary.averageMoveText = summary.averageMove === 0 ? '0.00%' : formatSignedPct(summary.averageMove);
  summary.updatedAt = latest;
  summary.lastUpdatedText = Number.isFinite(latest)
    ? timeFormatter.format(summary.updatedAt)
    : timeFormatter.format(Date.now());

  return { rows, summary };
}

export function generateTickers(count = SYMBOLS.length, previous?: TickerRow[]): TickerRow[] {
  return nextTickerSlice(count, previous).rows;
}

export const defaultFrameDuration = FRAME_TIME_FALLBACK;
