use chrono::{DateTime, Utc};
use rust_decimal::prelude::*;
use serde::{Deserialize, Serialize};
use std::fmt::{Display, Formatter};
use std::str::FromStr;
use thiserror::Error;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum Currency {
    BTC,
    ETH,
}

impl Display for Currency {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Currency::BTC => write!(f, "BTC"),
            Currency::ETH => write!(f, "ETH"),
        }
    }
}

impl FromStr for Currency {
    type Err = ParseInstrumentError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_uppercase().as_str() {
            "BTC" => Ok(Currency::BTC),
            "ETH" => Ok(Currency::ETH),
            _ => Err(ParseInstrumentError::UnknownCurrency(s.to_string())),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum OptionKind {
    Call,
    Put,
}

impl Display for OptionKind {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            OptionKind::Call => write!(f, "C"),
            OptionKind::Put => write!(f, "P"),
        }
    }
}

impl FromStr for OptionKind {
    type Err = ParseInstrumentError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_uppercase().as_str() {
            "C" | "CALL" => Ok(OptionKind::Call),
            "P" | "PUT" => Ok(OptionKind::Put),
            other => Err(ParseInstrumentError::UnknownOptionKind(other.to_string())),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum SettlementCurrency {
    Usdc,
    Coin,
}

impl Display for SettlementCurrency {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            SettlementCurrency::Usdc => write!(f, "USDC"),
            SettlementCurrency::Coin => write!(f, "COIN"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Instrument {
    pub instrument_name: String,
    pub currency: Currency,
    pub is_usdc_settled: bool,
    pub is_combo: bool,
    pub option_kind: OptionKind,
    pub strike: Decimal,
    pub expiry: DateTime<Utc>,
    pub contract_size: Decimal,
    pub settlement_currency: SettlementCurrency,
    pub tick_size: Decimal,
    pub min_trade_amount: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QuoteLevel {
    pub price: Decimal,
    pub amount: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Quote {
    pub best_bid: Option<QuoteLevel>,
    pub best_ask: Option<QuoteLevel>,
    pub mark_iv: Option<f64>,
    pub bid_iv: Option<f64>,
    pub ask_iv: Option<f64>,
    pub interest_rate: Option<f64>,
    pub timestamp: DateTime<Utc>,
    pub index_price: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OrderBook {
    pub bids: Vec<QuoteLevel>,
    pub asks: Vec<QuoteLevel>,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InstrumentSnapshot {
    pub instrument: Instrument,
    pub quote: Quote,
    pub order_book: Option<OrderBook>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ComboLeg {
    pub instrument_name: String,
    pub ratio: i32,
    pub side: ComboSide,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ComboSide {
    Buy,
    Sell,
}

impl Display for ComboSide {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            ComboSide::Buy => write!(f, "BUY"),
            ComboSide::Sell => write!(f, "SELL"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ComboDefinition {
    pub combo_id: Option<String>,
    pub currency: Currency,
    pub settlement: SettlementCurrency,
    pub description: String,
    pub legs: Vec<ComboLeg>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FeeBreakdown {
    pub legs: Vec<LegFee>,
    pub combo_discount: Decimal,
    pub combo_discount_usd: Decimal,
    pub delivery_fee: Decimal,
    pub delivery_fee_usd: Decimal,
    pub total_native: Decimal,
    pub total_usd: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LegFee {
    pub instrument_name: String,
    pub side: ComboSide,
    pub settlement: SettlementCurrency,
    pub execution_role: FillRole,
    pub trade_fee_native: Decimal,
    pub trade_fee_usd: Decimal,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum FillRole {
    Maker,
    Taker,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyOpportunity {
    pub strategy: StrategyKind,
    pub currency: Currency,
    pub settlement: SettlementCurrency,
    pub expiry: Vec<DateTime<Utc>>,
    pub strikes: Vec<Decimal>,
    pub legs: Vec<ComboLeg>,
    pub touches: Vec<LegTouch>,
    pub total_cost: Decimal,
    pub max_payout: Decimal,
    pub fee_breakdown: FeeBreakdown,
    pub net_edge_native: Decimal,
    pub net_edge_usd: Decimal,
    pub notional_usd: Decimal,
    pub reference_index: Decimal,
    pub edge_bps: f64,
    pub size_contracts: Decimal,
    pub execution_plan: ComboExecutionPlan,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LegTouch {
    pub instrument_name: String,
    pub side: ComboSide,
    pub price: Decimal,
    pub size_contracts: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ComboExecutionPlan {
    pub create_payload: serde_json::Value,
    pub tif: OrderTimeInForce,
    pub price_limit: Decimal,
    pub dry_run: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum OrderTimeInForce {
    IOC,
    FOK,
    GTC,
}

impl Display for OrderTimeInForce {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            OrderTimeInForce::IOC => write!(f, "IOC"),
            OrderTimeInForce::FOK => write!(f, "FOK"),
            OrderTimeInForce::GTC => write!(f, "GTC"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChainSnapshot {
    pub timestamp: DateTime<Utc>,
    pub instruments: Vec<InstrumentSnapshot>,
}

#[derive(Debug, Error)]
pub enum ParseInstrumentError {
    #[error("invalid instrument format: {0}")]
    InvalidFormat(String),
    #[error("unknown currency: {0}")]
    UnknownCurrency(String),
    #[error("unknown option kind: {0}")]
    UnknownOptionKind(String),
    #[error("invalid expiry: {0}")]
    InvalidExpiry(String),
    #[error("invalid strike: {0}")]
    InvalidStrike(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedInstrumentName {
    pub currency: Currency,
    pub day: u32,
    pub month: String,
    pub year: u32,
    pub strike: Decimal,
    pub option_kind: OptionKind,
}

impl ParsedInstrumentName {
    pub fn expiry_date(&self) -> Result<DateTime<Utc>, ParseInstrumentError> {
        let month = match self.month.as_str() {
            "JAN" => 1,
            "FEB" => 2,
            "MAR" => 3,
            "APR" => 4,
            "MAY" => 5,
            "JUN" => 6,
            "JUL" => 7,
            "AUG" => 8,
            "SEP" => 9,
            "OCT" => 10,
            "NOV" => 11,
            "DEC" => 12,
            _ => return Err(ParseInstrumentError::InvalidExpiry(self.month.clone())),
        };

        let naive = chrono::NaiveDate::from_ymd_opt(self.year as i32, month, self.day).ok_or_else(
            || ParseInstrumentError::InvalidExpiry(format!("{}-{}-{}", self.year, month, self.day)),
        )?;
        let naive_dt = naive.and_hms_opt(8, 0, 0).ok_or_else(|| {
            ParseInstrumentError::InvalidExpiry(format!(
                "{}-{}-{} 08:00:00",
                self.year, month, self.day
            ))
        })?;
        Ok(DateTime::<Utc>::from_naive_utc_and_offset(naive_dt, Utc))
    }
}

impl FromStr for ParsedInstrumentName {
    type Err = ParseInstrumentError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        // Format e.g. BTC-25MAR23-42000-C
        let parts: Vec<&str> = s.split('-').collect();
        if parts.len() != 4 {
            return Err(ParseInstrumentError::InvalidFormat(s.to_string()));
        }
        let currency = parts[0].parse()?;
        let date_part = parts[1];
        if date_part.len() < 6 {
            return Err(ParseInstrumentError::InvalidExpiry(date_part.to_string()));
        }
        let year_suffix = &date_part[date_part.len() - 2..];
        let month = date_part[date_part.len() - 5..date_part.len() - 2].to_ascii_uppercase();
        let day_str = &date_part[..date_part.len() - 5];
        let day = day_str
            .parse()
            .map_err(|_| ParseInstrumentError::InvalidExpiry(date_part.to_string()))?;
        let year = format!("20{}", year_suffix)
            .parse()
            .map_err(|_| ParseInstrumentError::InvalidExpiry(date_part.to_string()))?;
        let strike = Decimal::from_str(parts[2])
            .map_err(|_| ParseInstrumentError::InvalidStrike(parts[2].to_string()))?;
        let option_kind = parts[3].parse()?;

        Ok(Self {
            currency,
            day,
            month,
            year,
            strike,
            option_kind,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MinEdgeRequirements {
    pub min_edge_usd: Decimal,
    pub min_edge_ratio: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum StrategyKind {
    Vertical,
    Butterfly,
    Calendar,
    Box,
    StaleQuote,
    JellyRoll,
}

impl Display for StrategyKind {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            StrategyKind::Vertical => write!(f, "vertical"),
            StrategyKind::Butterfly => write!(f, "butterfly"),
            StrategyKind::Calendar => write!(f, "calendar"),
            StrategyKind::Box => write!(f, "box"),
            StrategyKind::StaleQuote => write!(f, "stale"),
            StrategyKind::JellyRoll => write!(f, "jelly"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyFilter {
    pub include: Vec<StrategyKind>,
}

impl StrategyFilter {
    pub fn allows(&self, strategy: StrategyKind) -> bool {
        self.include.contains(&strategy)
    }
}
