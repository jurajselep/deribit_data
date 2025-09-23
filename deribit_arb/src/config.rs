use crate::model::{Currency, SettlementCurrency, StrategyFilter, StrategyKind};
use anyhow::{anyhow, Result};
use clap::Parser;
use rust_decimal::Decimal;
use serde::Serialize;
use std::env;
use std::str::FromStr;
use tracing::info;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Environment {
    Testnet,
    Production,
}

impl Environment {
    pub fn websocket_url(&self) -> &'static str {
        match self {
            Environment::Testnet => "wss://test.deribit.com/ws/api/v2",
            Environment::Production => "wss://www.deribit.com/ws/api/v2",
        }
    }

    pub fn http_base(&self) -> &'static str {
        match self {
            Environment::Testnet => "https://test.deribit.com/api/v2",
            Environment::Production => "https://www.deribit.com/api/v2",
        }
    }
}

#[derive(Debug, Parser, Clone)]
#[command(name = "deribit_arb", author, version, about = "Deribit options micro-arbitrage scanner", long_about = None)]
pub struct Cli {
    #[arg(long, env = "DERIBIT_ENV", default_value = "test")]
    pub env: String,

    #[arg(
        long,
        env = "CURRENCIES",
        default_value = "BTC,ETH",
        value_delimiter = ','
    )]
    pub currencies: Vec<String>,

    #[arg(
        long,
        env = "LINEARS",
        default_value = "usdc,coin",
        value_delimiter = ','
    )]
    pub linears: Vec<String>,

    #[arg(long, env = "DRY_RUN", default_value_t = true)]
    pub dry_run: bool,

    #[arg(long, env = "MAX_TICKET_USD", default_value_t = 20_000u64)]
    pub max_ticket: u64,

    #[arg(long, env = "MIN_EDGE_USD", default_value_t = 50u64)]
    pub min_edge_usd: u64,

    #[arg(long, env = "MIN_EDGE_RATIO", default_value_t = 2.0)]
    pub min_edge_ratio: f64,

    #[arg(long, env = "HOLD_TO_EXPIRY", default_value_t = false)]
    pub hold_to_expiry: bool,

    #[arg(
        long,
        env = "ONLY",
        default_value = "vertical,butterfly,calendar,box,jelly",
        value_delimiter = ','
    )]
    pub only: Vec<String>,

    #[arg(long, env = "MAX_CONCURRENT_COMBOS", default_value_t = 3u32)]
    pub max_concurrent_combos: u32,

    #[arg(long, env = "MIN_DEPTH_CONTRACTS", default_value_t = 1u32)]
    pub min_depth_contracts: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppConfig {
    pub environment: Environment,
    pub api_key: Option<String>,
    pub api_secret: Option<String>,
    pub currencies: Vec<Currency>,
    pub settlements: Vec<SettlementCurrency>,
    pub dry_run: bool,
    pub max_ticket_usd: Decimal,
    pub min_edge_usd: Decimal,
    pub min_edge_ratio: f64,
    pub hold_to_expiry: bool,
    pub strategy_filter: StrategyFilter,
    pub max_concurrent_combos: u32,
    pub min_depth_contracts: u32,
}

impl AppConfig {
    pub fn from_cli(cli: Cli) -> Result<Self> {
        let environment = match cli.env.to_ascii_lowercase().as_str() {
            "test" | "testnet" => Environment::Testnet,
            "prod" | "production" | "main" => Environment::Production,
            other => return Err(anyhow!("unknown env: {other}")),
        };

        let api_key = env::var("API_KEY").ok();
        let api_secret = env::var("API_SECRET").ok();

        let currencies = cli
            .currencies
            .iter()
            .map(|c| Currency::from_str(c))
            .collect::<Result<Vec<_>, _>>()?;

        let settlements = cli
            .linears
            .iter()
            .map(|s| match s.as_str() {
                "usdc" => Ok(SettlementCurrency::Usdc),
                "coin" => Ok(SettlementCurrency::Coin),
                other => Err(anyhow!("unknown settlement: {other}")),
            })
            .collect::<Result<Vec<_>, _>>()?;

        let max_ticket_usd = Decimal::from(cli.max_ticket);
        let min_edge_usd = Decimal::from(cli.min_edge_usd);

        if cli.min_edge_ratio < 1.0 {
            return Err(anyhow!("min edge ratio must be >= 1.0"));
        }

        let strategy_filter = StrategyFilter {
            include: cli
                .only
                .iter()
                .map(|s| match s.trim().to_ascii_lowercase().as_str() {
                    "vertical" => Ok(StrategyKind::Vertical),
                    "butterfly" => Ok(StrategyKind::Butterfly),
                    "calendar" => Ok(StrategyKind::Calendar),
                    "box" => Ok(StrategyKind::Box),
                    "stale" | "stalequote" | "stale-quote" => Ok(StrategyKind::StaleQuote),
                    "jelly" | "jellyroll" | "jelly-roll" => Ok(StrategyKind::JellyRoll),
                    other => Err(anyhow!(format!("unknown strategy filter: {other}"))),
                })
                .collect::<Result<Vec<_>, _>>()?,
        };

        if strategy_filter.include.is_empty() {
            return Err(anyhow!("must enable at least one detector"));
        }

        let config = AppConfig {
            environment,
            api_key,
            api_secret,
            currencies,
            settlements,
            dry_run: cli.dry_run,
            max_ticket_usd,
            min_edge_usd,
            min_edge_ratio: cli.min_edge_ratio,
            hold_to_expiry: cli.hold_to_expiry,
            strategy_filter,
            max_concurrent_combos: cli.max_concurrent_combos,
            min_depth_contracts: cli.min_depth_contracts,
        };

        info!(
            "config" = serde_json::to_string(&config).unwrap_or_default(),
            "configuration loaded"
        );
        Ok(config)
    }
}
