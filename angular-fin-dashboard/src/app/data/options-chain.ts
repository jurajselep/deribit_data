import {
  DeribitInstrument,
  DeribitInstrumentSummary,
  DeribitOptionType,
  DeribitTickerData
} from '../models/deribit';

const MATURITY_LABEL = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric'
});

const TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

const makeFormatter = (fractionDigits = 2): ((value: number) => string) =>
  (value: number) => value.toFixed(fractionDigits);

const formatCurrency = (value: number): string =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2
  }).format(value);

const formatPercent = makeFormatter(2);
const formatNumber = (value: number): string =>
  new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0
  }).format(value);

const formatSignedCurrency = (value: number): string => `${value >= 0 ? '+' : ''}${formatCurrency(value)}`;

const formatIvDisplay = (iv: number): string =>
  Number.isFinite(iv) && iv > 0 ? `${formatPercent(iv * 100)}%` : '--';

const pad2 = (value: number): string => value.toString().padStart(2, '0');

const MONTH_TOKEN_MAP: Record<string, string> = {
  JAN: '01',
  FEB: '02',
  MAR: '03',
  APR: '04',
  MAY: '05',
  JUN: '06',
  JUL: '07',
  AUG: '08',
  SEP: '09',
  OCT: '10',
  NOV: '11',
  DEC: '12'
};

const toMaturityIdFromTimestamp = (timestamp: number): string => {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = pad2(date.getUTCMonth() + 1);
  const day = pad2(date.getUTCDate());
  return `${year}-${month}-${day}`;
};

export const normalizeDeribitIv = (iv?: number | null): number | null => {
  if (iv === null || iv === undefined || Number.isNaN(iv)) {
    return null;
  }

  const value = Math.abs(iv);
  if (!Number.isFinite(value)) {
    return null;
  }

  return value > 1 ? value / 100 : value;
};

export interface ParsedInstrumentName {
  maturityId: string;
  strike: number;
  optionType: DeribitOptionType;
}

export const parseDeribitInstrumentName = (instrumentName: string): ParsedInstrumentName | null => {
  const parts = instrumentName.split('-');
  if (parts.length < 4) {
    return null;
  }

  const datePart = parts[1];
  if (datePart.length !== 7) {
    return null;
  }

  const day = datePart.slice(0, 2);
  const monthToken = datePart.slice(2, 5).toUpperCase();
  const yearFragment = datePart.slice(5);
  const month = MONTH_TOKEN_MAP[monthToken];
  if (!month) {
    return null;
  }

  const strike = Number(parts[2]);
  if (!Number.isFinite(strike)) {
    return null;
  }

  const optionCode = parts[3]?.toUpperCase();
  let optionType: DeribitOptionType;
  if (optionCode === 'C') {
    optionType = 'call';
  } else if (optionCode === 'P') {
    optionType = 'put';
  } else {
    return null;
  }

  return {
    maturityId: `20${yearFragment}-${month}-${day}`,
    strike,
    optionType
  };
};

export const maturityIdFromInstrumentName = (instrumentName: string): string | null => {
  const parsed = parseDeribitInstrumentName(instrumentName);
  return parsed ? parsed.maturityId : null;
};

const MATURITIES = [
  '2025-01-31',
  '2025-03-28',
  '2025-06-27',
  '2025-09-26'
] as const;

const STRIKE_COUNT = 16;
const STRIKE_STEP = 500;
const BASE_UNDERLYING = 35000;

const randomFloat = (min: number, max: number): number => Math.random() * (max - min) + min;
const randomNormal = (scale: number): number => (Math.random() - 0.5) * scale * 2;

export interface MaturityInfo {
  id: string;
  label: string;
}

export interface OptionQuote {
  bid: number;
  ask: number;
  last: number;
  change: number;
  iv: number;
  volume: number;
  openInterest: number;
  delta: number;
  gamma: number;
  instrumentName: string | null;
  bidText: string;
  askText: string;
  lastText: string;
  changeText: string;
  ivText: string;
  volumeText: string;
  openInterestText: string;
  deltaText: string;
  gammaText: string;
}

export interface OptionRow {
  strike: number;
  strikeText: string;
  call: OptionQuote;
  put: OptionQuote;
  updatedAt: number;
}

export interface OptionChainSummary {
  maturity: string;
  maturityLabel: string;
  underlying: number;
  underlyingText: string;
  callVolume: number;
  callVolumeText: string;
  putVolume: number;
  putVolumeText: string;
  callOpenInterest: number;
  callOpenInterestText: string;
  putOpenInterest: number;
  putOpenInterestText: string;
  atmIV: number;
  atmIVText: string;
  skew: number;
  skewText: string;
  updatedAt: number;
  lastUpdatedText: string;
}

export interface OptionChain {
  maturity: string;
  label: string;
  rows: OptionRow[];
  summary: OptionChainSummary;
}

export interface OptionDataBuffers {
  maturities: MaturityInfo[];
  chains: Record<string, OptionChain>;
}

const toLabel = (id: string): string => {
  const date = new Date(id);
  return MATURITY_LABEL.format(date);
};

const createEmptyQuote = (instrumentName: string | null = null): OptionQuote => ({
  bid: 0,
  ask: 0,
  last: 0,
  change: 0,
  iv: 0,
  volume: 0,
  openInterest: 0,
  delta: 0,
  gamma: 0,
  instrumentName,
  bidText: formatCurrency(0),
  askText: formatCurrency(0),
  lastText: formatCurrency(0),
  changeText: formatSignedCurrency(0),
  ivText: formatIvDisplay(0),
  volumeText: formatNumber(0),
  openInterestText: formatNumber(0),
  deltaText: '0.000',
  gammaText: '0.000'
});

const createEmptyRow = (strike: number, underlying: number): OptionRow => {
  const row = createRow(strike, underlying);
  row.call.instrumentName = null;
  row.put.instrumentName = null;
  return row;
};

const createEmptySummary = (maturity: string, label: string): OptionChainSummary => {
  const now = Date.now();
  return {
    maturity,
    maturityLabel: label,
    underlying: 0,
    underlyingText: formatCurrency(0),
    callVolume: 0,
    callVolumeText: '0',
    putVolume: 0,
    putVolumeText: '0',
    callOpenInterest: 0,
    callOpenInterestText: '0',
    putOpenInterest: 0,
    putOpenInterestText: '0',
    atmIV: Number.NaN,
    atmIVText: '--',
    skew: 0,
    skewText: '0.00%',
    updatedAt: now,
    lastUpdatedText: TIME_FORMATTER.format(now)
  };
};

const createQuote = (strike: number, underlying: number, isCall: boolean): OptionQuote => {
  const intrinsic = Math.max(isCall ? underlying - strike : strike - underlying, 0);
  const timeValue = randomFloat(5, 25);
  const basePrice = intrinsic + timeValue;
  const bid = Math.max(basePrice - randomFloat(1, 3), 0.25);
  const ask = bid + randomFloat(0.5, 2.5);
  const last = (bid + ask) / 2;
  const iv = randomFloat(0.45, 0.95);
  const delta = isCall ? randomFloat(0.25, 0.75) : randomFloat(-0.75, -0.25);
  const gamma = randomFloat(0.01, 0.15);
  const volume = randomFloat(50, 1800);
  const openInterest = randomFloat(500, 8000);

  return {
    bid,
    ask,
    last,
    change: randomNormal(1.5),
    iv,
    volume,
    openInterest,
    delta,
    gamma,
    instrumentName: null,
    bidText: formatCurrency(bid),
    askText: formatCurrency(ask),
    lastText: formatCurrency(last),
    changeText: `${last >= 0 ? '+' : ''}${formatCurrency(last - basePrice)}`,
    ivText: formatIvDisplay(iv),
    volumeText: formatNumber(volume),
    openInterestText: formatNumber(openInterest),
    deltaText: delta.toFixed(3),
    gammaText: gamma.toFixed(3)
  };
};

const resetQuoteForPendingData = (quote: OptionQuote): void => {
  quote.bid = 0;
  quote.ask = 0;
  quote.last = 0;
  quote.change = 0;
  quote.iv = Number.NaN;
  quote.volume = 0;
  quote.openInterest = 0;
  quote.delta = 0;
  quote.gamma = 0;
  quote.bidText = formatCurrency(0);
  quote.askText = formatCurrency(0);
  quote.lastText = formatCurrency(0);
  quote.changeText = formatSignedCurrency(0);
  quote.ivText = formatIvDisplay(quote.iv);
  quote.volumeText = formatNumber(0);
  quote.openInterestText = formatNumber(0);
  quote.deltaText = '0.000';
  quote.gammaText = '0.000';
};

const createRow = (strike: number, underlying: number): OptionRow => {
  const call = createQuote(strike, underlying, true);
  const put = createQuote(strike, underlying, false);
  return {
    strike,
    strikeText: formatCurrency(strike),
    call,
    put,
    updatedAt: Date.now()
  };
};

const createChain = (maturity: string, label: string, index: number): OptionChain => {
  const rows: OptionRow[] = new Array(STRIKE_COUNT);
  const underlying = BASE_UNDERLYING + index * 250 - 400;
  const startStrike = underlying - (STRIKE_COUNT / 2) * STRIKE_STEP;

  for (let i = 0; i < STRIKE_COUNT; i += 1) {
    const strike = Math.round(startStrike + i * STRIKE_STEP);
    rows[i] = createRow(strike, underlying);
  }

  const summary = createEmptySummary(maturity, label);
  summary.underlying = underlying;
  summary.underlyingText = formatCurrency(underlying);

  return { maturity, label, rows, summary };
};

const ensurePositive = (value: number, floor = 0): number => (value < floor ? floor : value);

const updateQuote = (
  quote: OptionQuote,
  intrinsic: number,
  isCall: boolean
): void => {
  const drift = randomNormal(1.5);
  quote.bid = ensurePositive(quote.bid + randomNormal(0.9));
  quote.ask = ensurePositive(Math.max(quote.bid, quote.ask + randomNormal(0.7)));
  quote.last = ensurePositive((quote.bid + quote.ask) / 2 + drift * 0.1);
  quote.change = quote.last - intrinsic;
  quote.iv = Math.max(0.05, quote.iv + randomNormal(0.02));
  quote.volume = Math.max(1, quote.volume * randomFloat(0.92, 1.12));
  quote.openInterest = Math.max(1, quote.openInterest * randomFloat(0.95, 1.05));
  quote.delta = Math.max(-0.99, Math.min(0.99, quote.delta + randomNormal(0.03)));
  quote.delta = isCall ? Math.abs(quote.delta) : -Math.abs(quote.delta);
  quote.gamma = Math.max(0, quote.gamma + randomNormal(0.01));

  quote.bidText = formatCurrency(quote.bid);
  quote.askText = formatCurrency(quote.ask);
  quote.lastText = formatCurrency(quote.last);
  quote.changeText = `${quote.change >= 0 ? '+' : ''}${formatCurrency(quote.change)}`;
  quote.ivText = formatIvDisplay(quote.iv);
  quote.volumeText = formatNumber(quote.volume);
  quote.openInterestText = formatNumber(quote.openInterest);
  quote.deltaText = quote.delta.toFixed(3);
  quote.gammaText = quote.gamma.toFixed(3);
};

const applyTickerToQuote = (quote: OptionQuote, ticker: DeribitTickerData): void => {
  if (!ticker) {
    return;
  }

  quote.instrumentName = ticker.instrument_name ?? quote.instrumentName;

  if (ticker.best_bid_price !== undefined) {
    quote.bid = ticker.best_bid_price;
  }
  if (ticker.best_ask_price !== undefined) {
    quote.ask = ticker.best_ask_price;
  }

  const lastPrice = ticker.last_price ?? ticker.mark_price;
  if (lastPrice !== undefined) {
    quote.last = lastPrice;
  }

  if (ticker.stats?.price_change !== undefined) {
    quote.change = ticker.stats.price_change;
  }

  const normalizedIv = normalizeDeribitIv(ticker.mark_iv ?? ticker.iv);
  if (normalizedIv !== null) {
    quote.iv = normalizedIv;
  }

  if (ticker.stats?.volume !== undefined) {
    quote.volume = ticker.stats.volume;
  }

  if (ticker.open_interest !== undefined) {
    quote.openInterest = ticker.open_interest;
  }

  const delta = ticker.delta ?? ticker.greeks?.delta;
  if (delta !== undefined) {
    quote.delta = delta;
  }

  const gamma = ticker.gamma ?? ticker.greeks?.gamma;
  if (gamma !== undefined) {
    quote.gamma = gamma;
  }

  quote.bidText = formatCurrency(quote.bid);
  quote.askText = formatCurrency(quote.ask);
  quote.lastText = formatCurrency(quote.last);
  quote.changeText = formatSignedCurrency(quote.change);
  quote.ivText = formatIvDisplay(quote.iv);
  quote.volumeText = formatNumber(quote.volume);
  quote.openInterestText = formatNumber(quote.openInterest);
  quote.deltaText = quote.delta.toFixed(3);
  quote.gammaText = quote.gamma.toFixed(3);
};

const applySummaryToQuote = (quote: OptionQuote, summary: DeribitInstrumentSummary): void => {
  if (summary.bid_price !== undefined && summary.bid_price !== null) {
    quote.bid = summary.bid_price;
  }
  if (summary.ask_price !== undefined && summary.ask_price !== null) {
    quote.ask = summary.ask_price;
  }
  if (summary.mark_price !== undefined && summary.mark_price !== null) {
    quote.last = summary.mark_price;
  }
  if (summary.price_change !== undefined && summary.price_change !== null) {
    quote.change = summary.price_change;
  }
  if (summary.volume !== undefined && summary.volume !== null) {
    quote.volume = summary.volume;
  }
  if (summary.open_interest !== undefined && summary.open_interest !== null) {
    quote.openInterest = summary.open_interest;
  }

  const normalizedIv = normalizeDeribitIv(summary.implied_volatility ?? summary.mark_iv);
  if (normalizedIv !== null) {
    quote.iv = normalizedIv;
  }

  quote.delta = 0;
  quote.gamma = 0;

  quote.bidText = formatCurrency(quote.bid);
  quote.askText = formatCurrency(quote.ask);
  quote.lastText = formatCurrency(quote.last);
  quote.changeText = formatSignedCurrency(quote.change);
  quote.ivText = formatIvDisplay(quote.iv);
  quote.volumeText = formatNumber(quote.volume);
  quote.openInterestText = formatNumber(quote.openInterest);
  quote.deltaText = quote.delta.toFixed(3);
  quote.gammaText = quote.gamma.toFixed(3);
};

const recalcChainSummary = (chain: OptionChain, underlyingOverride?: number): void => {
  if (underlyingOverride !== undefined) {
    chain.summary.underlying = underlyingOverride;
  }

  const underlying = chain.summary.underlying;
  let callVolume = 0;
  let putVolume = 0;
  let callOI = 0;
  let putOI = 0;
  let closestIv: number | null = null;
  let closestDiff = Number.POSITIVE_INFINITY;

  chain.rows.forEach((row) => {
    callVolume += row.call.volume;
    putVolume += row.put.volume;
    callOI += row.call.openInterest;
    putOI += row.put.openInterest;

    if (underlying > 0) {
      const callIv = row.call.iv;
      const putIv = row.put.iv;
      if (Number.isFinite(callIv) && Number.isFinite(putIv) && callIv > 0 && putIv > 0) {
        const diff = Math.abs(row.strike - underlying);
        if (diff <= closestDiff) {
          closestDiff = diff;
          closestIv = (callIv + putIv) / 2;
        }
      }
    }
  });

  chain.summary.callVolume = callVolume;
  chain.summary.callVolumeText = formatNumber(callVolume);
  chain.summary.putVolume = putVolume;
  chain.summary.putVolumeText = formatNumber(putVolume);
  chain.summary.callOpenInterest = callOI;
  chain.summary.callOpenInterestText = formatNumber(callOI);
  chain.summary.putOpenInterest = putOI;
  chain.summary.putOpenInterestText = formatNumber(putOI);

  if (closestIv !== null) {
    chain.summary.atmIV = closestIv;
  }
  chain.summary.atmIVText = formatIvDisplay(chain.summary.atmIV);

  const totalVolume = callVolume + putVolume;
  const skew = totalVolume === 0 ? 0 : ((callVolume - putVolume) / totalVolume) * 100;
  chain.summary.skew = skew;
  chain.summary.skewText = `${skew >= 0 ? '+' : ''}${formatPercent(skew)}%`;

  chain.summary.underlyingText = formatCurrency(chain.summary.underlying);

  const now = Date.now();
  chain.summary.updatedAt = now;
  chain.summary.lastUpdatedText = TIME_FORMATTER.format(now);
};

const updateChain = (chain: OptionChain): void => {
  const now = Date.now();
  const underlyingMove = randomNormal(65);
  chain.summary.underlying = Math.max(1, chain.summary.underlying + underlyingMove);
  chain.summary.underlyingText = formatCurrency(chain.summary.underlying);

  let callVolume = 0;
  let putVolume = 0;
  let callOI = 0;
  let putOI = 0;
  let atmIV = 0;
  let atmCount = 0;

  for (const row of chain.rows) {
    const intrinsicCall = Math.max(chain.summary.underlying - row.strike, 0);
    const intrinsicPut = Math.max(row.strike - chain.summary.underlying, 0);

    updateQuote(row.call, intrinsicCall, true);
    updateQuote(row.put, intrinsicPut, false);

    row.strikeText = formatCurrency(row.strike);
    row.updatedAt = now;

    callVolume += row.call.volume;
    putVolume += row.put.volume;
    callOI += row.call.openInterest;
    putOI += row.put.openInterest;

    if (Math.abs(chain.summary.underlying - row.strike) < STRIKE_STEP) {
      atmIV += (row.call.iv + row.put.iv) / 2;
      atmCount += 1;
    }
  }

  chain.summary.callVolume = callVolume;
  chain.summary.callVolumeText = formatNumber(callVolume);
  chain.summary.putVolume = putVolume;
  chain.summary.putVolumeText = formatNumber(putVolume);
  chain.summary.callOpenInterest = callOI;
  chain.summary.callOpenInterestText = formatNumber(callOI);
  chain.summary.putOpenInterest = putOI;
  chain.summary.putOpenInterestText = formatNumber(putOI);
  chain.summary.atmIV = atmCount ? atmIV / atmCount : chain.summary.atmIV;
  chain.summary.atmIVText = formatIvDisplay(chain.summary.atmIV);
  const skew = callVolume === 0 ? 0 : ((callVolume - putVolume) / (callVolume + putVolume)) * 100;
  chain.summary.skew = skew;
  chain.summary.skewText = `${skew >= 0 ? '+' : ''}${formatPercent(skew)}%`;
  chain.summary.updatedAt = now;
  chain.summary.lastUpdatedText = TIME_FORMATTER.format(now);
};

export const createOptionDataBuffers = (): OptionDataBuffers => {
  const maturities: MaturityInfo[] = MATURITIES.map((id) => ({ id, label: toLabel(id) }));
  const chains: Record<string, OptionChain> = {};

  maturities.forEach((maturity, index) => {
    chains[maturity.id] = createChain(maturity.id, maturity.label, index);
  });

  return { maturities, chains };
};

export const createOptionDataBuffersFromInstruments = (
  instruments: DeribitInstrument[],
  summaries?: Map<string, DeribitInstrumentSummary>
): OptionDataBuffers => {
  const maturityMap = new Map<
    string,
    { chain: OptionChain; rowsByStrike: Map<number, OptionRow> }
  >();

  instruments.forEach((instrument) => {
    if (instrument.kind !== 'option') {
      return;
    }
    const maturityId = toMaturityIdFromTimestamp(instrument.expiration_timestamp);
    const label = toLabel(maturityId);
    let entry = maturityMap.get(maturityId);
    if (!entry) {
      const summary = createEmptySummary(maturityId, label);
      summary.underlying = instrument.strike;
      summary.underlyingText = formatCurrency(instrument.strike);
      entry = {
        chain: {
          maturity: maturityId,
          label,
          rows: [],
          summary
        },
        rowsByStrike: new Map<number, OptionRow>()
      };
      maturityMap.set(maturityId, entry);
    } else if (entry.chain.summary.underlying === 0) {
      entry.chain.summary.underlying = instrument.strike;
      entry.chain.summary.underlyingText = formatCurrency(instrument.strike);
    }

    const underlying = entry.chain.summary.underlying || instrument.strike;
    let row = entry.rowsByStrike.get(instrument.strike);
    if (!row) {
      row = createEmptyRow(instrument.strike, underlying);
      resetQuoteForPendingData(row.call);
      resetQuoteForPendingData(row.put);
      entry.rowsByStrike.set(instrument.strike, row);
      entry.chain.rows.push(row);
    }

    const targetQuote = instrument.option_type === 'call' ? row.call : row.put;
    targetQuote.instrumentName = instrument.instrument_name;

    const summary = summaries?.get(instrument.instrument_name);
    if (summary) {
      if (summary.underlying_price && summary.underlying_price > 0) {
        entry.chain.summary.underlying = summary.underlying_price;
        entry.chain.summary.underlyingText = formatCurrency(summary.underlying_price);
      }
      applySummaryToQuote(targetQuote, summary);
    }
  });

  const sortedMaturities = Array.from(maturityMap.keys()).sort();
  const maturities: MaturityInfo[] = sortedMaturities.map((id) => {
    const entry = maturityMap.get(id)!;
    return { id, label: entry.chain.label };
  });

  const chains: Record<string, OptionChain> = {};
  sortedMaturities.forEach((id) => {
    const entry = maturityMap.get(id)!;
    entry.chain.rows.sort((a, b) => a.strike - b.strike);
    recalcChainSummary(entry.chain);
    chains[id] = entry.chain;
  });

  return { maturities, chains };
};

const cloneQuote = (quote: OptionQuote): OptionQuote => ({ ...quote });

const cloneRow = (row: OptionRow): OptionRow => ({
  strike: row.strike,
  strikeText: row.strikeText,
  call: cloneQuote(row.call),
  put: cloneQuote(row.put),
  updatedAt: row.updatedAt
});

const cloneSummary = (summary: OptionChainSummary): OptionChainSummary => ({ ...summary });

export const cloneChains = (chains: Record<string, OptionChain>): Record<string, OptionChain> => {
  const copy: Record<string, OptionChain> = {};
  for (const [key, chain] of Object.entries(chains)) {
    copy[key] = {
      maturity: chain.maturity,
      label: chain.label,
      rows: chain.rows.map(cloneRow),
      summary: cloneSummary(chain.summary)
    };
  }
  return copy;
};

export const mutateOptionData = (buffers: OptionDataBuffers): void => {
  for (const chain of Object.values(buffers.chains)) {
    updateChain(chain);
  }
};

export const updateChainsWithTicker = (
  chains: Record<string, OptionChain>,
  ticker: DeribitTickerData
): string | null => {
  if (!ticker || !ticker.instrument_name) {
    return null;
  }

  const parsed = parseDeribitInstrumentName(ticker.instrument_name);
  if (!parsed) {
    return null;
  }

  const chain = chains[parsed.maturityId];
  if (!chain) {
    return null;
  }

  let row = chain.rows.find((item) => item.strike === parsed.strike);
  if (!row) {
    row = createEmptyRow(
      parsed.strike,
      ticker.underlying_price ?? chain.summary.underlying ?? parsed.strike
    );
    resetQuoteForPendingData(row.call);
    resetQuoteForPendingData(row.put);

    chain.rows.push(row);
    chain.rows.sort((a, b) => a.strike - b.strike);
  }

  const quote = parsed.optionType === 'call' ? row.call : row.put;
  applyTickerToQuote(quote, ticker);
  row.strikeText = formatCurrency(row.strike);
  row.updatedAt = Date.now();

  recalcChainSummary(chain, ticker.underlying_price);

  return chain.maturity;
};
