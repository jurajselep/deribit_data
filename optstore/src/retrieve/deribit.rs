use std::sync::Arc;

use anyhow::{Context, Result};
use async_trait::async_trait;
use bytes::Bytes;
use reqwest::blocking::Client;
use tracing::info;

use super::{RawChunk, RetrieveKind, RetrieveSpec, Source};

#[derive(Clone, Debug)]
pub enum DeribitKind {
    Trades,
    Quotes,
    Both,
}

#[derive(Clone)]
pub struct DeribitSource {
    client: Arc<Client>,
    rate: u32,
}

impl DeribitSource {
    pub fn new(rate: u32) -> Self {
        let client = Client::builder()
            .user_agent("optstore/0.1")
            .build()
            .expect("reqwest client");
        Self {
            client: Arc::new(client),
            rate: rate.max(1),
        }
    }
}

#[async_trait]
impl Source for DeribitSource {
    async fn fetch(
        &self,
        spec: &RetrieveSpec,
        _resume_from: Option<String>,
    ) -> Result<Vec<RawChunk>> {
        let client = self.client.clone();
        let symbol = spec.symbol.clone();
        let kind = spec.kind.clone();
        let rate = self.rate;

        let body = tokio::task::spawn_blocking(move || {
            std::thread::sleep(std::time::Duration::from_millis(1000 / rate.max(1) as u64));
            let endpoint = match kind {
                RetrieveKind::Trades | RetrieveKind::Both => "get_trades",
                RetrieveKind::Quotes => "get_book_summary_by_instrument",
            };
            let url = format!(
                "https://www.deribit.com/api/v2/public/{endpoint}?instrument_name={symbol}&count=1000"
            );
            let response = client
                .get(url)
                .send()
                .context("deribit request")?
                .error_for_status()
                .context("deribit status")?
                .text()
                .context("reading body")?;
            Ok::<String, anyhow::Error>(response)
        })
        .await??;

        info!(target: "optstore::retrieve", symbol = %spec.symbol, len = body.len(), "fetched deribit page");

        let bytes = Bytes::from(body.into_bytes());
        Ok(vec![RawChunk {
            start_ns: 0,
            end_ns: 0,
            data: bytes,
            resume: None,
        }])
    }

    fn name(&self) -> &'static str {
        "deribit"
    }
}
