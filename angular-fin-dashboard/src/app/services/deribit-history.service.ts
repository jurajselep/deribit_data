import { Injectable } from '@angular/core';
import { DeribitListResponse, DeribitTrade, DeribitTradeList } from '../models/deribit';
import { parseDeribitInstrumentName } from '../data/options-chain';

const HISTORY_BASE_URL = 'https://history.deribit.com/api/v2/public';
const DEFAULT_COUNT = 1000;
const MAX_PAGINATION_STEPS = 6;

@Injectable({ providedIn: 'root' })
export class DeribitHistoryService {
  async fetchOptionTrades(
    currency: string,
    startTimestamp: number,
    endTimestamp: number,
    count: number = DEFAULT_COUNT
  ): Promise<DeribitTrade[]> {
    const normalizedCurrency = currency.toUpperCase();
    const dedupe = new Map<string, DeribitTrade>();
    let nextEnd = Math.max(startTimestamp, endTimestamp);
    const lowerBound = Math.min(startTimestamp, endTimestamp);
    let paginationSteps = 0;

    while (nextEnd > lowerBound && paginationSteps < MAX_PAGINATION_STEPS) {
      paginationSteps += 1;
      const params = new URLSearchParams({
        currency: normalizedCurrency,
        start_timestamp: Math.floor(lowerBound).toString(),
        end_timestamp: Math.floor(nextEnd).toString(),
        count: Math.max(1, Math.min(1000, Math.floor(count))).toString(),
        include_oldest: 'true'
      });

      const response = await fetch(`${HISTORY_BASE_URL}/get_last_trades_by_currency_and_time?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`Deribit history response ${response.status}`);
      }

      const payload = (await response.json()) as DeribitListResponse<DeribitTradeList>;
      const trades = payload.result?.trades ?? [];
      const filtered = trades.filter((trade) => parseDeribitInstrumentName(trade.instrument_name));
      for (const trade of filtered) {
        dedupe.set(trade.trade_id, trade);
      }

      if (!payload.result?.has_more || trades.length === 0) {
        break;
      }

      const last = trades[trades.length - 1];
      const lastTimestamp = last?.timestamp;
      if (!Number.isFinite(lastTimestamp)) {
        break;
      }

      const candidate = Math.floor(lastTimestamp) - 1;
      if (candidate <= lowerBound || candidate >= nextEnd) {
        break;
      }
      nextEnd = candidate;
    }

    const results = Array.from(dedupe.values());
    results.sort((a, b) => a.timestamp - b.timestamp);
    return results;
  }
}
