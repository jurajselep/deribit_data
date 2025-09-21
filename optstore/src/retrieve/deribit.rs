use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use governor::{clock::DefaultClock, state::InMemoryState, state::NotKeyed, Quota, RateLimiter};
use reqwest::Client;
use reqwest::StatusCode;
use serde_json::Value;
use std::num::NonZeroU32;
use std::sync::Arc;
use tracing::info;

use super::{RawChunk, RetrieveKind, RetrieveOptions, RetrieveSpec, Source};

#[derive(Clone, Debug)]
pub enum DeribitKind {
    Trades,
    Quotes,
    Both,
}

#[derive(Clone)]
pub struct DeribitSource {
    client: Client,
    limiter: Arc<RateLimiter<NotKeyed, InMemoryState, DefaultClock>>,
}

impl DeribitSource {
    pub fn new(rate: u32) -> Self {
        let client = Client::builder()
            .user_agent("optstore/0.1")
            .build()
            .expect("reqwest client");
        let per_sec = NonZeroU32::new(rate.max(1)).unwrap();
        let limiter = RateLimiter::direct(Quota::per_second(per_sec));
        Self {
            client,
            limiter: Arc::new(limiter),
        }
    }

    async fn ensure_instrument(&self, symbol: &str) -> Result<()> {
        self.limiter.until_ready().await;
        let response = self
            .client
            .get("https://www.deribit.com/api/v2/public/get_instrument")
            .query(&[("instrument_name", symbol)])
            .send()
            .await
            .context("verify instrument")?;

        let status = response.status();
        let body = response.bytes().await?;

        if !status.is_success() {
            if let Ok(err) = serde_json::from_slice::<Value>(&body) {
                if let Some(message) = err
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                {
                    bail!("Deribit unknown instrument '{}': {}", symbol, message);
                }
            }
            bail!("Deribit unknown instrument '{}': status {}", symbol, status);
        }

        Ok(())
    }
}

#[async_trait]
impl Source for DeribitSource {
    async fn fetch(&self, spec: &RetrieveSpec, options: &RetrieveOptions) -> Result<Vec<RawChunk>> {
        if !matches!(spec.kind, RetrieveKind::Trades | RetrieveKind::Both) {
            bail!("Deribit quotes retrieval is not implemented yet");
        }

        self.ensure_instrument(&spec.symbol).await?;

        let mut resume_token = options.resume_from.clone();
        let mut chunks = Vec::new();
        let mut page: u32 = 0;

        loop {
            if let Some(max_pages) = options.max_pages {
                if page >= max_pages {
                    break;
                }
            }

            self.limiter.until_ready().await;

            let mut request = self
                .client
                .get("https://www.deribit.com/api/v2/public/get_last_trades_by_instrument_and_time")
                .query(&[
                    ("instrument_name", spec.symbol.as_str()),
                    ("count", "1000"),
                    ("include_oldest", "true"),
                ]);

            if let Some(token) = &resume_token {
                request = request.query(&[("start_timestamp", token.as_str())]);
            } else {
                request = request.query(&[("start_timestamp", "0")]);
            }

            let response = request.send().await.context("deribit request")?;

            let status = response.status();
            let body_bytes = response.bytes().await?;
            if !status.is_success() {
                if status == StatusCode::BAD_REQUEST {
                    if let Ok(err) = serde_json::from_slice::<Value>(&body_bytes) {
                        if let Some(message) = err
                            .get("error")
                            .and_then(|e| e.get("message"))
                            .and_then(|m| m.as_str())
                        {
                            bail!("Deribit rejected '{}': {}", spec.symbol, message);
                        }
                    }
                    bail!(
                        "Deribit rejected instrument_name={}; ensure the instrument exists and is not delisted",
                        spec.symbol
                    );
                }
                bail!("deribit status {}", status);
            }

            let json: Value = serde_json::from_slice(&body_bytes)?;

            let trades = json
                .get("result")
                .and_then(|r| r.get("trades"))
                .and_then(|t| t.as_array())
                .cloned()
                .unwrap_or_default();

            let mut first_ts: Option<u64> = None;
            let mut last_ts: Option<u64> = None;
            for trade in &trades {
                if let Some(ts) = trade.get("timestamp").and_then(|v| v.as_u64()) {
                    if first_ts.is_none() {
                        first_ts = Some(ts);
                    }
                    last_ts = Some(ts);
                }
            }

            let start_ns = first_ts.map(|ts| ts * 1_000_000).unwrap_or(0);
            let end_ns = last_ts.map(|ts| ts * 1_000_000).unwrap_or(start_ns);
            let next_resume = json
                .get("result")
                .and_then(|r| r.get("continuation"))
                .and_then(|c| c.as_str())
                .map(|s| s.to_string())
                .or_else(|| last_ts.map(|ts| (ts + 1).to_string()));

            info!(
                target: "optstore::retrieve",
                symbol = %spec.symbol,
                page,
                trades = trades.len(),
                resume = ?next_resume,
                "fetched deribit page"
            );

            let chunk = RawChunk {
                data: body_bytes.clone(),
                start_ns,
                end_ns,
                resume: next_resume.clone(),
            };
            chunks.push(chunk);

            let has_more = json
                .get("result")
                .and_then(|r| r.get("has_more"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            if !has_more || trades.len() < 1000 {
                break;
            }

            if let Some(next) = next_resume {
                resume_token = Some(next);
            } else {
                break;
            }

            page += 1;
        }

        Ok(chunks)
    }

    fn name(&self) -> &'static str {
        "deribit"
    }
}
