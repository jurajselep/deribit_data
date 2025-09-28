export type DeribitOptionType = 'call' | 'put';

export interface DeribitInstrument {
  instrument_name: string;
  base_currency: string;
  quote_currency: string;
  kind: 'option';
  option_type: DeribitOptionType;
  settlement_period: string;
  strike: number;
  expiration_timestamp: number;
  creation_timestamp?: number;
  is_active?: boolean;
}

export interface DeribitInstrumentSummary {
  instrument_name: string;
  open_interest: number;
  volume: number;
  mark_price: number;
  last_price?: number;
  bid_price?: number;
  ask_price?: number;
  delta?: number;
  gamma?: number;
  implied_volatility?: number;
  underlying_price?: number;
  creation_timestamp?: number;
}

export interface DeribitListResponse<T> {
  jsonrpc: string;
  result: T;
  usIn?: number;
  usOut?: number;
  usDiff?: number;
  testnet?: boolean;
}

export interface DeribitTickerGreeks {
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
}

export interface DeribitTickerStats {
  volume?: number;
  volume_usd?: number;
  price_change?: number;
  price_change_percent?: number;
}

export interface DeribitTickerData {
  instrument_name: string;
  best_ask_price?: number;
  best_bid_price?: number;
  last_price?: number;
  mark_price?: number;
  open_interest?: number;
  underlying_price?: number;
  iv?: number;
  greeks?: DeribitTickerGreeks;
  delta?: number;
  gamma?: number;
  stats?: DeribitTickerStats;
  timestamp?: number;
}
