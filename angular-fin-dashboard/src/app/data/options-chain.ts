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
    bidText: formatCurrency(bid),
    askText: formatCurrency(ask),
    lastText: formatCurrency(last),
    changeText: `${last >= 0 ? '+' : ''}${formatCurrency(last - basePrice)}`,
    ivText: `${formatPercent(iv * 100)}%`,
    volumeText: formatNumber(volume),
    openInterestText: formatNumber(openInterest),
    deltaText: delta.toFixed(3),
    gammaText: gamma.toFixed(3)
  };
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

  const summary: OptionChainSummary = {
    maturity,
    maturityLabel: label,
    underlying,
    underlyingText: formatCurrency(underlying),
    callVolume: 0,
    callVolumeText: '0',
    putVolume: 0,
    putVolumeText: '0',
    callOpenInterest: 0,
    callOpenInterestText: '0',
    putOpenInterest: 0,
    putOpenInterestText: '0',
    atmIV: 0,
    atmIVText: '0.00%',
    skew: 0,
    skewText: '0.00%',
    updatedAt: Date.now(),
    lastUpdatedText: TIME_FORMATTER.format(Date.now())
  };

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
  quote.ivText = `${formatPercent(quote.iv * 100)}%`;
  quote.volumeText = formatNumber(quote.volume);
  quote.openInterestText = formatNumber(quote.openInterest);
  quote.deltaText = quote.delta.toFixed(3);
  quote.gammaText = quote.gamma.toFixed(3);
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
  chain.summary.atmIVText = `${formatPercent(chain.summary.atmIV * 100)}%`;
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
