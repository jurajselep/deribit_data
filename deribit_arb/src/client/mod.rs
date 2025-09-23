use crate::config::Environment;
use crate::model::{
    ComboDefinition, ComboLeg, ComboSide, Instrument, ParsedInstrumentName, Quote, QuoteLevel,
    SettlementCurrency,
};
use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Duration, Utc};
use futures::{SinkExt, StreamExt};
use parking_lot::RwLock;
use reqwest::Client as HttpClient;
use rust_decimal::prelude::*;
use rust_decimal_macros::dec;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::protocol::Message;
use tracing::warn;

const JSON_RPC_VERSION: &str = "2.0";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest<T> {
    pub jsonrpc: String,
    pub id: u64,
    pub method: String,
    pub params: T,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcResponse<T> {
    pub jsonrpc: String,
    pub id: u64,
    pub result: Option<T>,
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(default)]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub struct DeribitCredentials {
    pub client_id: String,
    pub client_secret: String,
}

#[derive(Debug, Clone)]
struct AccessToken {
    token: String,
    expires_at: DateTime<Utc>,
}

#[derive(Debug)]
pub struct DeribitHttpClient {
    http: HttpClient,
    environment: Environment,
    credentials: Option<DeribitCredentials>,
    token: Arc<RwLock<Option<AccessToken>>>,
}

impl DeribitHttpClient {
    pub fn new(environment: Environment, credentials: Option<DeribitCredentials>) -> Self {
        let http = HttpClient::builder()
            .user_agent("deribit_arb/0.1")
            .build()
            .expect("failed to build http client");
        Self {
            http,
            environment,
            credentials,
            token: Arc::new(RwLock::new(None)),
        }
    }

    async fn call<T: Serialize + ?Sized, R: DeserializeOwned>(
        &self,
        method: &str,
        params: &T,
        private: bool,
    ) -> Result<R> {
        let call_id = rand::random::<u64>();
        let mut body = json!({
            "jsonrpc": JSON_RPC_VERSION,
            "id": call_id,
            "method": method,
            "params": serde_json::to_value(params)?,
        });

        if private {
            let token = self.ensure_token().await?;
            body.as_object_mut()
                .context("expected request object")?
                .entry("params")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .unwrap()
                .insert("access_token".to_string(), json!(token));
        }

        let url = self.environment.http_base();
        let res = self
            .http
            .post(url)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("failed to call {method}"))?;
        let status = res.status();
        let text = res.text().await?;
        if !status.is_success() {
            return Err(anyhow!("HTTP {status} for {method}: {text}"));
        }
        let rpc: JsonRpcResponse<R> = serde_json::from_str(&text)
            .with_context(|| format!("failed to parse response for {method}: {text}"))?;
        if let Some(err) = rpc.error {
            return Err(anyhow!(
                "RPC error {method}: {} ({})",
                err.message,
                err.code
            ));
        }
        rpc.result
            .ok_or_else(|| anyhow!("missing result for {method}"))
    }

    async fn ensure_token(&self) -> Result<String> {
        if self.credentials.is_none() {
            return Err(anyhow!("API key/secret required for private call"));
        }
        {
            let guard = self.token.read();
            if let Some(token) = &*guard {
                if token.expires_at - Duration::seconds(30) > Utc::now() {
                    return Ok(token.token.clone());
                }
            }
        }
        let creds = self.credentials.clone().unwrap();
        let call_id = rand::random::<u64>();
        let params = json!({
            "grant_type": "client_credentials",
            "client_id": creds.client_id,
            "client_secret": creds.client_secret,
        });
        let body = json!({
            "jsonrpc": JSON_RPC_VERSION,
            "id": call_id,
            "method": "public/auth",
            "params": params,
        });
        let res = self
            .http
            .post(self.environment.http_base())
            .json(&body)
            .send()
            .await
            .context("auth request failed")?;
        let status = res.status();
        let text = res.text().await?;
        if !status.is_success() {
            return Err(anyhow!("auth HTTP {status}: {text}"));
        }
        let rpc: JsonRpcResponse<serde_json::Value> =
            serde_json::from_str(&text).context("invalid auth response")?;
        if let Some(err) = rpc.error {
            return Err(anyhow!("auth error: {} ({})", err.message, err.code));
        }
        let result = rpc.result.ok_or_else(|| anyhow!("auth missing result"))?;
        if let Some(access_token) = result.get("access_token").and_then(|v| v.as_str()) {
            let expires_in = result
                .get("expires_in")
                .and_then(|v| v.as_i64())
                .unwrap_or(3000);
            let expiry = Utc::now() + Duration::seconds(expires_in.saturating_sub(30));
            let mut guard = self.token.write();
            *guard = Some(AccessToken {
                token: access_token.to_string(),
                expires_at: expiry,
            });
            return Ok(access_token.to_string());
        }
        Err(anyhow!("auth response missing access_token"))
    }

    pub async fn get_instruments(&self, currency: &str) -> Result<Vec<Instrument>> {
        #[derive(Deserialize)]
        struct InstrumentDto {
            instrument_name: String,
            #[serde(rename = "option_type")]
            #[allow(dead_code)]
            option_type: Option<String>,
            strike: f64,
            tick_size: f64,
            min_trade_amount: f64,
            contract_size: f64,
            is_combo: Option<bool>,
            settlement_currency: String,
            #[serde(rename = "option_kind")]
            #[allow(dead_code)]
            option_kind: Option<String>,
            expiration_timestamp: i64,
        }

        let params = json!({
            "currency": currency,
            "kind": "option",
            "expired": false,
        });
        let instruments: Vec<InstrumentDto> =
            self.call("public/get_instruments", &params, false).await?;
        instruments
            .into_iter()
            .map(|dto| {
                let parsed = ParsedInstrumentName::from_str(&dto.instrument_name)?;
                let expiry = DateTime::<Utc>::from_timestamp(dto.expiration_timestamp / 1000, 0)
                    .ok_or_else(|| anyhow!("invalid timestamp"))?;
                Ok(Instrument {
                    instrument_name: dto.instrument_name,
                    currency: parsed.currency,
                    is_usdc_settled: dto.settlement_currency.eq_ignore_ascii_case("usdc"),
                    is_combo: dto.is_combo.unwrap_or(false),
                    option_kind: parsed.option_kind,
                    strike: Decimal::from_f64(dto.strike).unwrap_or_default(),
                    expiry,
                    contract_size: Decimal::from_f64(dto.contract_size).unwrap_or(dec!(1)),
                    settlement_currency: if dto.settlement_currency.eq_ignore_ascii_case("usdc") {
                        SettlementCurrency::Usdc
                    } else {
                        SettlementCurrency::Coin
                    },
                    tick_size: Decimal::from_f64(dto.tick_size).unwrap_or(dec!(0.1)),
                    min_trade_amount: Decimal::from_f64(dto.min_trade_amount).unwrap_or(dec!(1)),
                })
            })
            .collect()
    }

    pub async fn get_ticker(&self, instrument_name: &str) -> Result<Quote> {
        #[derive(Deserialize)]
        struct TickerDto {
            best_bid_price: Option<f64>,
            best_bid_amount: Option<f64>,
            best_ask_price: Option<f64>,
            best_ask_amount: Option<f64>,
            mark_iv: Option<f64>,
            bid_iv: Option<f64>,
            ask_iv: Option<f64>,
            interest_rate: Option<f64>,
            #[serde(rename = "instrument_name")]
            #[allow(dead_code)]
            instrument_name: Option<String>,
            timestamp: i64,
            index_price: f64,
        }

        let params = json!({ "instrument_name": instrument_name });
        let dto: TickerDto = self.call("public/ticker", &params, false).await?;
        let timestamp = DateTime::<Utc>::from_timestamp(dto.timestamp / 1000, 0)
            .ok_or_else(|| anyhow!("invalid ticker timestamp"))?;
        let best_bid = dto
            .best_bid_price
            .zip(dto.best_bid_amount)
            .map(|(price, amount)| QuoteLevel {
                price: Decimal::from_f64(price).unwrap_or_default(),
                amount: Decimal::from_f64(amount).unwrap_or_default(),
            });
        let best_ask = dto
            .best_ask_price
            .zip(dto.best_ask_amount)
            .map(|(price, amount)| QuoteLevel {
                price: Decimal::from_f64(price).unwrap_or_default(),
                amount: Decimal::from_f64(amount).unwrap_or_default(),
            });
        Ok(Quote {
            best_bid,
            best_ask,
            mark_iv: dto.mark_iv,
            bid_iv: dto.bid_iv,
            ask_iv: dto.ask_iv,
            interest_rate: dto.interest_rate,
            timestamp,
            index_price: Decimal::from_f64(dto.index_price).unwrap_or(dec!(0)),
        })
    }

    pub async fn get_combo_ids(&self, currency: &str) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct ComboIdDto {
            combo_id: String,
        }
        let params = json!({ "currency": currency });
        let ids: Vec<ComboIdDto> = self.call("public/get_combo_ids", &params, false).await?;
        Ok(ids.into_iter().map(|id| id.combo_id).collect())
    }

    pub async fn get_combo_details(&self, combo_id: &str) -> Result<ComboDefinition> {
        #[derive(Deserialize)]
        struct ComboDto {
            currency: String,
            legs: Vec<ComboLegDto>,
            description: String,
            settlement_currency: String,
        }

        #[derive(Deserialize)]
        struct ComboLegDto {
            instrument_name: String,
            ratio: i32,
            direction: String,
        }

        let params = json!({ "combo_id": combo_id });
        let dto: ComboDto = self
            .call("public/get_combo_details", &params, false)
            .await?;
        let legs = dto
            .legs
            .into_iter()
            .map(|leg| ComboLeg {
                instrument_name: leg.instrument_name,
                ratio: leg.ratio,
                side: match leg.direction.as_str() {
                    "buy" => ComboSide::Buy,
                    "sell" => ComboSide::Sell,
                    other => {
                        warn!("unknown combo leg direction {other}");
                        ComboSide::Buy
                    }
                },
            })
            .collect();
        Ok(ComboDefinition {
            combo_id: Some(combo_id.to_string()),
            currency: match dto.currency.as_str() {
                "BTC" => crate::model::Currency::BTC,
                "ETH" => crate::model::Currency::ETH,
                other => return Err(anyhow!("unknown currency {other}")),
            },
            settlement: if dto.settlement_currency.eq_ignore_ascii_case("usdc") {
                SettlementCurrency::Usdc
            } else {
                SettlementCurrency::Coin
            },
            description: dto.description,
            legs,
        })
    }

    pub async fn create_combo(
        &self,
        name: &str,
        legs: &[ComboLeg],
        is_usdc: bool,
    ) -> Result<String> {
        #[derive(Serialize)]
        struct CreateComboLeg<'a> {
            instrument_name: &'a str,
            ratio: i32,
            direction: &'a str,
        }
        let params = json!({
            "name": name,
            "settlement": if is_usdc { "usdc" } else { "coin" },
            "legs": legs
                .iter()
                .map(|leg| CreateComboLeg {
                    instrument_name: &leg.instrument_name,
                    ratio: leg.ratio,
                    direction: match leg.side {
                        ComboSide::Buy => "buy",
                        ComboSide::Sell => "sell",
                    },
                })
                .collect::<Vec<_>>(),
        });
        #[derive(Deserialize)]
        struct CreateComboResponse {
            combo_id: String,
        }
        let resp: CreateComboResponse = self.call("private/create_combo", &params, true).await?;
        Ok(resp.combo_id)
    }

    pub async fn get_leg_prices(
        &self,
        combo_id: &str,
        amount: Decimal,
    ) -> Result<serde_json::Value> {
        let params = json!({
            "combo_id": combo_id,
            "amount": amount,
        });
        self.call("private/get_leg_prices", &params, true).await
    }
}

#[derive(Debug)]
pub struct DeribitWsClient {
    environment: Environment,
}

impl DeribitWsClient {
    pub fn new(environment: Environment) -> Self {
        Self { environment }
    }

    pub async fn subscribe(
        &self,
        subscriptions: &[String],
    ) -> Result<mpsc::UnboundedReceiver<serde_json::Value>> {
        let url = self.environment.websocket_url();
        let (ws_stream, _) = connect_async(url)
            .await
            .context("failed to connect websocket")?;
        let channels: Vec<String> = subscriptions.to_vec();
        let (out_tx, out_rx) = mpsc::unbounded_channel();

        tokio::spawn(async move {
            let (mut writer, mut reader) = ws_stream.split();
            let call_id = rand::random::<u64>();
            let request = JsonRpcRequest {
                jsonrpc: JSON_RPC_VERSION.to_string(),
                id: call_id,
                method: "public/subscribe".to_string(),
                params: json!({ "channels": channels }),
            };
            let payload = match serde_json::to_string(&request) {
                Ok(text) => text,
                Err(err) => {
                    warn!("ws_encode_error" = %err, "failed to encode subscribe request");
                    return;
                }
            };
            if let Err(err) = writer.send(Message::text(payload)).await {
                warn!("ws_write_error" = %err, "failed to send subscribe request");
                return;
            }

            while let Some(msg) = reader.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                            let _ = out_tx.send(value);
                        }
                    }
                    Ok(Message::Binary(bin)) => {
                        if let Ok(text) = String::from_utf8(bin) {
                            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                                let _ = out_tx.send(value);
                            }
                        }
                    }
                    Ok(Message::Ping(payload)) => {
                        let rendered = String::from_utf8_lossy(&payload).to_string();
                        let _ = out_tx.send(json!({ "type": "ping", "payload": rendered }));
                    }
                    Ok(Message::Pong(payload)) => {
                        let rendered = String::from_utf8_lossy(&payload).to_string();
                        let _ = out_tx.send(json!({ "type": "pong", "payload": rendered }));
                    }
                    Ok(Message::Close(frame)) => {
                        let payload = frame
                            .as_ref()
                            .map(|f| format!("{:?}", f))
                            .unwrap_or_else(|| "None".to_string());
                        let _ = out_tx.send(json!({ "type": "close", "payload": payload }));
                        break;
                    }
                    Ok(Message::Frame(_)) => {}
                    Err(err) => {
                        warn!("ws_read_error" = %err, "websocket read error");
                        break;
                    }
                }
            }
        });

        Ok(out_rx)
    }
}

pub fn parse_quote_from_ticker(payload: &serde_json::Value) -> Option<Quote> {
    let params = payload.get("params")?;
    let data = params.get("data")?;
    let best_bid = data
        .get("best_bid_price")
        .and_then(|b| b.as_f64())
        .zip(data.get("best_bid_amount").and_then(|a| a.as_f64()))
        .map(|(price, amount)| QuoteLevel {
            price: Decimal::from_f64(price).unwrap_or_default(),
            amount: Decimal::from_f64(amount).unwrap_or_default(),
        });
    let best_ask = data
        .get("best_ask_price")
        .and_then(|b| b.as_f64())
        .zip(data.get("best_ask_amount").and_then(|a| a.as_f64()))
        .map(|(price, amount)| QuoteLevel {
            price: Decimal::from_f64(price).unwrap_or_default(),
            amount: Decimal::from_f64(amount).unwrap_or_default(),
        });
    let index_price = data
        .get("index_price")
        .and_then(|p| p.as_f64())
        .map(|p| Decimal::from_f64(p).unwrap_or_default())
        .unwrap_or_else(|| Decimal::ZERO);
    let timestamp = data
        .get("timestamp")
        .and_then(|t| t.as_i64())
        .and_then(|ts| DateTime::<Utc>::from_timestamp(ts / 1000, 0))
        .unwrap_or_else(Utc::now);

    Some(Quote {
        best_bid,
        best_ask,
        mark_iv: data.get("mark_iv").and_then(|v| v.as_f64()),
        bid_iv: data.get("bid_iv").and_then(|v| v.as_f64()),
        ask_iv: data.get("ask_iv").and_then(|v| v.as_f64()),
        interest_rate: data.get("interest_rate").and_then(|v| v.as_f64()),
        timestamp,
        index_price,
    })
}
