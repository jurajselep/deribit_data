use crate::model::{ChainSnapshot, Instrument, InstrumentSnapshot, OrderBook, Quote};
use chrono::{Duration, Utc};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Clone, Default)]
pub struct OptionChain {
    inner: Arc<RwLock<HashMap<String, InstrumentSnapshot>>>,
}

#[derive(Debug, Clone, Copy)]
pub struct ChainStats {
    pub instrument_count: usize,
    pub instruments_with_quotes: usize,
    pub instruments_fresh_10s: usize,
    pub bid_levels: usize,
    pub ask_levels: usize,
}

impl OptionChain {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn upsert_instrument(&self, instrument: Instrument) {
        let mut guard = self.inner.write();
        guard
            .entry(instrument.instrument_name.clone())
            .and_modify(|snapshot| snapshot.instrument = instrument.clone())
            .or_insert(InstrumentSnapshot {
                instrument: instrument.clone(),
                quote: Quote {
                    best_bid: None,
                    best_ask: None,
                    mark_iv: None,
                    bid_iv: None,
                    ask_iv: None,
                    interest_rate: None,
                    timestamp: Utc::now(),
                    index_price: Default::default(),
                },
                order_book: None,
            });
    }

    pub fn update_quote(&self, instrument_name: &str, quote: Quote) {
        let mut guard = self.inner.write();
        if let Some(snapshot) = guard.get_mut(instrument_name) {
            snapshot.quote = quote;
        }
    }

    pub fn update_order_book(&self, instrument_name: &str, order_book: OrderBook) {
        let mut guard = self.inner.write();
        if let Some(snapshot) = guard.get_mut(instrument_name) {
            snapshot.order_book = Some(order_book);
        }
    }

    pub fn snapshot(&self) -> ChainSnapshot {
        let guard = self.inner.read();
        let instruments = guard.values().cloned().collect();
        ChainSnapshot {
            timestamp: Utc::now(),
            instruments,
        }
    }

    pub fn stats(&self) -> ChainStats {
        let guard = self.inner.read();
        let now = Utc::now();
        let horizon = Duration::seconds(10);
        let (with_quote, fresh, bid_levels, ask_levels) =
            guard
                .values()
                .fold((0usize, 0usize, 0usize, 0usize), |acc, snapshot| {
                    let mut with_quote = acc.0;
                    let mut fresh = acc.1;
                    let mut bids = acc.2;
                    let mut asks = acc.3;
                    if snapshot.quote.best_bid.is_some() || snapshot.quote.best_ask.is_some() {
                        with_quote += 1;
                    }
                    if now - snapshot.quote.timestamp <= horizon {
                        fresh += 1;
                    }
                    bids += snapshot.quote.best_bid.is_some() as usize;
                    asks += snapshot.quote.best_ask.is_some() as usize;
                    (with_quote, fresh, bids, asks)
                });
        ChainStats {
            instrument_count: guard.len(),
            instruments_with_quotes: with_quote,
            instruments_fresh_10s: fresh,
            bid_levels,
            ask_levels,
        }
    }
}
