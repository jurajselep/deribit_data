use crate::config::AppConfig;
use crate::model::StrategyOpportunity;
use parking_lot::Mutex;
use rust_decimal::Decimal;
use std::sync::Arc;
use tracing::{info, warn};

#[derive(Default)]
struct RiskState {
    live_combos: u32,
    ewma_pnl: Decimal,
}

#[derive(Clone, Default)]
pub struct RiskManager {
    state: Arc<Mutex<RiskState>>,
}

impl RiskManager {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(RiskState::default())),
        }
    }

    pub fn approve(&self, config: &AppConfig, opp: &StrategyOpportunity) -> bool {
        let mut state = self.state.lock();
        if state.live_combos >= config.max_concurrent_combos {
            warn!(
                target: "risk.max_combos",
                current = state.live_combos,
                max = config.max_concurrent_combos,
                "concurrent combo limit reached"
            );
            return false;
        }
        if opp.notional_usd > config.max_ticket_usd {
            warn!(
                target: "risk.ticket",
                notional = opp.notional_usd.to_string(),
                max = config.max_ticket_usd.to_string(),
                "ticket exceeds cap"
            );
            return false;
        }
        if state.ewma_pnl < Decimal::ZERO {
            warn!(
                target: "risk.pnl",
                ewma = state.ewma_pnl.to_string(),
                "recent PnL negative, pausing deployment"
            );
            return false;
        }
        state.live_combos += 1;
        info!(
            target: "risk.approved",
            combos = state.live_combos,
            "combo approved"
        );
        true
    }

    pub fn release(&self) {
        let mut state = self.state.lock();
        if state.live_combos > 0 {
            state.live_combos -= 1;
        }
    }

    pub fn record_pnl(&self, pnl_usd: Decimal) {
        let mut state = self.state.lock();
        let alpha = Decimal::new(2, 1); // 0.2 smoothing
        state.ewma_pnl = (Decimal::ONE - alpha) * state.ewma_pnl + alpha * pnl_usd;
    }
}
