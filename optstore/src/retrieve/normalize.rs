use anyhow::Result;
use bytes::Bytes;
use serde::Deserialize;

use super::RawChunk;
use crate::schema::Tick;

#[derive(Clone)]
pub struct DeribitNormalizer {
    pub instrument_id: u32,
}

#[derive(Debug, Deserialize)]
struct TradeRecord {
    price: Option<f64>,
    amount: Option<f64>,
    timestamp: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct TradeEnvelope {
    trades: Option<Vec<TradeRecord>>,
}

#[derive(Debug, Deserialize)]
struct TradeResponse {
    result: TradeEnvelope,
}

pub trait Normalizer {
    fn to_ticks(&self, raw: RawChunk) -> Result<Vec<Tick>>;
}

impl Normalizer for DeribitNormalizer {
    fn to_ticks(&self, raw: RawChunk) -> Result<Vec<Tick>> {
        let bytes: Bytes = raw.data;
        let response: TradeResponse = serde_json::from_slice(&bytes)?;
        let mut ticks = Vec::new();
        if let Some(trades) = response.result.trades {
            for trade in trades {
                if let (Some(price), Some(amount), Some(ts)) =
                    (trade.price, trade.amount, trade.timestamp)
                {
                    let tick = Tick {
                        ts_ns: ts * 1_000_000,
                        instrument_id: self.instrument_id,
                        event: 1,
                        price_fp: (price * 1_000_000.0).round() as i64,
                        size: (amount.abs() * 1_000.0) as u32,
                        bid_px_fp: [0; 4],
                        ask_px_fp: [0; 4],
                        bid_sz: [0; 4],
                        ask_sz: [0; 4],
                        flags: 0,
                    };
                    ticks.push(tick);
                }
            }
        }
        Ok(ticks)
    }
}
