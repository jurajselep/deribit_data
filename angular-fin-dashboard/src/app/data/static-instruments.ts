import { DeribitInstrument } from '../models/deribit';

const toTimestamp = (isoDate: string) => new Date(`${isoDate}T08:00:00Z`).getTime();

export const STATIC_INSTRUMENTS: Record<string, DeribitInstrument[]> = {
  BTC: [
    {
      instrument_name: 'BTC-31JAN25-30000-C',
      base_currency: 'BTC',
      quote_currency: 'USD',
      kind: 'option',
      option_type: 'call',
      settlement_period: 'month',
      strike: 30000,
      expiration_timestamp: toTimestamp('2025-01-31')
    },
    {
      instrument_name: 'BTC-31JAN25-30000-P',
      base_currency: 'BTC',
      quote_currency: 'USD',
      kind: 'option',
      option_type: 'put',
      settlement_period: 'month',
      strike: 30000,
      expiration_timestamp: toTimestamp('2025-01-31')
    },
    {
      instrument_name: 'BTC-28MAR25-35000-C',
      base_currency: 'BTC',
      quote_currency: 'USD',
      kind: 'option',
      option_type: 'call',
      settlement_period: 'month',
      strike: 35000,
      expiration_timestamp: toTimestamp('2025-03-28')
    },
    {
      instrument_name: 'BTC-27JUN25-40000-P',
      base_currency: 'BTC',
      quote_currency: 'USD',
      kind: 'option',
      option_type: 'put',
      settlement_period: 'month',
      strike: 40000,
      expiration_timestamp: toTimestamp('2025-06-27')
    }
  ],
  ETH: [
    {
      instrument_name: 'ETH-31JAN25-1800-C',
      base_currency: 'ETH',
      quote_currency: 'USD',
      kind: 'option',
      option_type: 'call',
      settlement_period: 'month',
      strike: 1800,
      expiration_timestamp: toTimestamp('2025-01-31')
    },
    {
      instrument_name: 'ETH-28MAR25-2000-P',
      base_currency: 'ETH',
      quote_currency: 'USD',
      kind: 'option',
      option_type: 'put',
      settlement_period: 'month',
      strike: 2000,
      expiration_timestamp: toTimestamp('2025-03-28')
    }
  ],
  SYNTH: [
    {
      instrument_name: 'SYNTH-31JAN25-35000-C',
      base_currency: 'SYNTH',
      quote_currency: 'USD',
      kind: 'option',
      option_type: 'call',
      settlement_period: 'month',
      strike: 35000,
      expiration_timestamp: toTimestamp('2025-01-31')
    },
    {
      instrument_name: 'SYNTH-28MAR25-36000-P',
      base_currency: 'SYNTH',
      quote_currency: 'USD',
      kind: 'option',
      option_type: 'put',
      settlement_period: 'month',
      strike: 36000,
      expiration_timestamp: toTimestamp('2025-03-28')
    },
    {
      instrument_name: 'SYNTH-27JUN25-36500-C',
      base_currency: 'SYNTH',
      quote_currency: 'USD',
      kind: 'option',
      option_type: 'call',
      settlement_period: 'month',
      strike: 36500,
      expiration_timestamp: toTimestamp('2025-06-27')
    }
  ]
};
