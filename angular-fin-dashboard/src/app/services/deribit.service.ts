import { Injectable } from '@angular/core';
import { DeribitInstrument, DeribitInstrumentSummary, DeribitListResponse } from '../models/deribit';
import { normalizeDeribitIv } from '../data/options-chain';
import { STATIC_INSTRUMENTS } from '../data/static-instruments';

const BASE_URL = 'https://www.deribit.com/api/v2/public';
const TTL_MS = 5 * 60 * 1000;
const SYNTHETIC_CURRENCY = 'SYNTH';

interface InstrumentsCacheEntry {
  timestamp: number;
  instruments: DeribitInstrument[];
}

interface SummaryCacheEntry {
  timestamp: number;
  summary: DeribitInstrumentSummary | null;
}

interface CurrencySummaryCacheEntry {
  timestamp: number;
  summaries: Map<string, DeribitInstrumentSummary>;
}

@Injectable({ providedIn: 'root' })
export class DeribitService {
  private readonly instrumentCache = new Map<string, InstrumentsCacheEntry>();
  private readonly summaryCache = new Map<string, SummaryCacheEntry>();
  private readonly currencySummaryCache = new Map<string, CurrencySummaryCacheEntry>();

  async fetchInstruments(currency: string): Promise<DeribitInstrument[]> {
    const key = currency.toUpperCase();
    const cached = this.instrumentCache.get(key);
    const now = Date.now();
    if (cached && now - cached.timestamp < TTL_MS) {
      return cached.instruments;
    }

    if (key === SYNTHETIC_CURRENCY) {
      const fallback = STATIC_INSTRUMENTS[key] ?? [];
      this.instrumentCache.set(key, { timestamp: now, instruments: fallback });
      return fallback;
    }

    try {
      const params = new URLSearchParams({
        currency: key,
        kind: 'option',
        expired: 'false'
      });
      const response = await fetch(`${BASE_URL}/get_instruments?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`Deribit response ${response.status}`);
      }
      const payload = (await response.json()) as DeribitListResponse<DeribitInstrument[]>;
      const instruments = payload.result ?? [];
      this.instrumentCache.set(key, { timestamp: now, instruments });
      return instruments;
    } catch (error) {
      const fallback = STATIC_INSTRUMENTS[key];
      if (fallback && fallback.length) {
        this.instrumentCache.set(key, { timestamp: now, instruments: fallback });
        return fallback;
      }
      throw error;
    }
  }

  async fetchInstrumentSummary(instrumentName: string): Promise<DeribitInstrumentSummary | null> {
    const key = instrumentName.toUpperCase();
    const cached = this.summaryCache.get(key);
    const now = Date.now();
    if (cached && now - cached.timestamp < TTL_MS) {
      return cached.summary;
    }

    try {
      const params = new URLSearchParams({ instrument_name: key });
      const response = await fetch(`${BASE_URL}/get_book_summary_by_instrument?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`Deribit summary response ${response.status}`);
      }
      const payload = (await response.json()) as DeribitListResponse<DeribitInstrumentSummary[]>;
      const summary = payload.result?.[0] ?? null;
      const normalizedSummary = summary
        ? {
            ...summary,
            implied_volatility:
              normalizeDeribitIv(summary.implied_volatility ?? summary.mark_iv) ?? undefined
          }
        : null;
      this.summaryCache.set(key, { timestamp: now, summary: normalizedSummary });
      return normalizedSummary;
    } catch (error) {
      this.summaryCache.set(key, { timestamp: now, summary: null });
      return null;
    }
  }

  async fetchBookSummaries(currency: string): Promise<Map<string, DeribitInstrumentSummary>> {
    const key = currency.toUpperCase();
    const cached = this.currencySummaryCache.get(key);
    const now = Date.now();
    if (cached && now - cached.timestamp < TTL_MS) {
      return cached.summaries;
    }

    const params = new URLSearchParams({ currency: key, kind: 'option' });
    const response = await fetch(`${BASE_URL}/get_book_summary_by_currency?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Deribit summary response ${response.status}`);
    }

    const payload = (await response.json()) as DeribitListResponse<DeribitInstrumentSummary[]>;
    const summaries = payload.result ?? [];
    const map = new Map<string, DeribitInstrumentSummary>();
    for (const summary of summaries) {
      const normalizedIv = normalizeDeribitIv(summary.implied_volatility ?? summary.mark_iv);
      if (normalizedIv !== null) {
        summary.implied_volatility = normalizedIv;
        summary.mark_iv = normalizedIv;
      } else {
        summary.implied_volatility = undefined;
        summary.mark_iv = undefined;
      }
      map.set(summary.instrument_name, summary);
    }

    this.currencySummaryCache.set(key, { timestamp: now, summaries: map });
    return map;
  }
}
