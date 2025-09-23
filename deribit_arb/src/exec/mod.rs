use crate::client::DeribitHttpClient;
use crate::config::AppConfig;
use crate::model::{ComboLeg, SettlementCurrency, StrategyOpportunity};
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use rust_decimal::Decimal;
use serde::Serialize;
use serde_json::json;
use tracing::{info, warn};

#[async_trait]
pub trait ComboApi: Send + Sync {
    async fn create_combo(&self, name: &str, legs: &[ComboLeg], is_usdc: bool) -> Result<String>;
    async fn get_leg_prices(&self, combo_id: &str, amount: Decimal) -> Result<serde_json::Value>;
}

#[async_trait]
impl ComboApi for DeribitHttpClient {
    async fn create_combo(&self, name: &str, legs: &[ComboLeg], is_usdc: bool) -> Result<String> {
        self.create_combo(name, legs, is_usdc).await
    }

    async fn get_leg_prices(&self, combo_id: &str, amount: Decimal) -> Result<serde_json::Value> {
        self.get_leg_prices(combo_id, amount).await
    }
}

#[derive(Debug, Serialize)]
pub struct ExecutionReport {
    pub combo_id: Option<String>,
    pub preview: Option<serde_json::Value>,
    pub submitted: bool,
}

pub struct ExecutionPlanner<'a, A: ComboApi + ?Sized> {
    client: &'a A,
    config: &'a AppConfig,
}

impl<'a, A: ComboApi + ?Sized> ExecutionPlanner<'a, A> {
    pub fn new(client: &'a A, config: &'a AppConfig) -> Self {
        Self { client, config }
    }

    pub async fn plan(&self, opportunity: &StrategyOpportunity) -> Result<ExecutionReport> {
        if opportunity.size_contracts < Decimal::from(self.config.min_depth_contracts) {
            bail!("insufficient depth for planned size");
        }
        let combo_id = self.ensure_combo(opportunity).await?;
        let preview = self
            .client
            .get_leg_prices(&combo_id, opportunity.size_contracts)
            .await
            .context("failed to preview leg prices")?;

        if self.config.dry_run {
            info!("combo" = combo_id, "dry run only, not submitting order");
            return Ok(ExecutionReport {
                combo_id: Some(combo_id),
                preview: Some(preview),
                submitted: false,
            });
        }

        warn!("execution" = ?opportunity.strategy, "Auto-submission not yet implemented; dry-run recommended");
        Ok(ExecutionReport {
            combo_id: Some(combo_id),
            preview: Some(preview),
            submitted: false,
        })
    }

    async fn ensure_combo(&self, opportunity: &StrategyOpportunity) -> Result<String> {
        if let Some(existing_id) = opportunity
            .execution_plan
            .create_payload
            .get("combo_id")
            .and_then(|v| v.as_str())
        {
            return Ok(existing_id.to_string());
        }
        let is_usdc = matches!(opportunity.settlement, SettlementCurrency::Usdc);
        let name = format!(
            "{}-{}-{}-{}",
            opportunity.strategy,
            opportunity.currency,
            opportunity
                .expiry
                .first()
                .map(|ts| ts.format("%Y%m%d").to_string())
                .unwrap_or_else(|| "NA".into()),
            opportunity.legs.len()
        );
        self.client
            .create_combo(&name, &opportunity.legs, is_usdc)
            .await
    }
}

pub struct MockComboApi {
    pub combos: parking_lot::Mutex<Vec<(String, Vec<ComboLeg>, bool)>>,
}

impl MockComboApi {
    pub fn new() -> Self {
        Self {
            combos: parking_lot::Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl ComboApi for MockComboApi {
    async fn create_combo(&self, name: &str, legs: &[ComboLeg], is_usdc: bool) -> Result<String> {
        self.combos
            .lock()
            .push((name.to_string(), legs.to_vec(), is_usdc));
        Ok(format!("combo-{}", self.combos.lock().len()))
    }

    async fn get_leg_prices(&self, combo_id: &str, amount: Decimal) -> Result<serde_json::Value> {
        Ok(json!({
            "combo_id": combo_id,
            "amount": amount,
            "fees": 0,
        }))
    }
}
