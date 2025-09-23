use crate::config::AppConfig;
use crate::fees::{FeeComputationContext, FeeEngine, LegFeeInput};
use crate::model::{
    ComboExecutionPlan, ComboLeg, ComboSide, FillRole, InstrumentSnapshot, LegTouch, OptionKind,
    OrderTimeInForce, SettlementCurrency, StrategyKind, StrategyOpportunity,
};
use anyhow::Result;
use chrono::{Duration, Utc};
use rust_decimal::prelude::*;
use rust_decimal_macros::dec;
use serde_json::json;
use std::collections::HashMap;

pub struct DetectorSuite<'a> {
    config: &'a AppConfig,
    fee_engine: FeeEngine,
}

impl<'a> DetectorSuite<'a> {
    pub fn new(config: &'a AppConfig) -> Self {
        Self {
            config,
            fee_engine: FeeEngine::new(),
        }
    }

    pub fn scan(&self, snapshot: &[InstrumentSnapshot]) -> Vec<StrategyOpportunity> {
        let mut opportunities = Vec::new();
        let groups = group_by_expiry(snapshot);
        for ((currency, expiry, settlement, kind), instruments) in groups.iter() {
            match kind {
                StrategyKindKey::Call | StrategyKindKey::Put => {
                    if self.config.strategy_filter.allows(StrategyKind::Vertical) {
                        if let Ok(mut verts) =
                            self.detect_verticals(instruments, *currency, *settlement, *expiry)
                        {
                            opportunities.append(&mut verts);
                        }
                    }
                    if self.config.strategy_filter.allows(StrategyKind::Butterfly) {
                        if let Ok(mut flies) =
                            self.detect_butterflies(instruments, *currency, *settlement, *expiry)
                        {
                            opportunities.append(&mut flies);
                        }
                    }
                }
            }
        }

        if self.config.strategy_filter.allows(StrategyKind::Calendar) {
            if let Ok(mut calendars) = self.detect_calendars(snapshot) {
                opportunities.append(&mut calendars);
            }
        }

        if self.config.strategy_filter.allows(StrategyKind::Box) {
            if let Ok(mut boxes) = self.detect_boxes(snapshot) {
                opportunities.append(&mut boxes);
            }
        }

        if self.config.strategy_filter.allows(StrategyKind::JellyRoll) {
            if let Ok(mut rolls) = self.detect_jelly_rolls(snapshot) {
                opportunities.append(&mut rolls);
            }
        }

        opportunities.sort_by(|a, b| b.net_edge_usd.cmp(&a.net_edge_usd));
        opportunities
    }

    fn detect_verticals(
        &self,
        instruments: &[InstrumentSnapshot],
        currency: crate::model::Currency,
        settlement: SettlementCurrency,
        expiry: chrono::DateTime<Utc>,
    ) -> Result<Vec<StrategyOpportunity>> {
        let mut by_strike: Vec<_> = instruments.iter().collect();
        by_strike.sort_by(|a, b| a.instrument.strike.cmp(&b.instrument.strike));
        let mut results = Vec::new();
        let min_depth = Decimal::from(self.config.min_depth_contracts);

        for window in by_strike.windows(2) {
            let low = window[0];
            let high = window[1];

            if low.instrument.option_kind != high.instrument.option_kind {
                continue;
            }

            let ask_low = low
                .quote
                .best_ask
                .as_ref()
                .filter(|lvl| lvl.amount >= min_depth);
            let bid_low = low
                .quote
                .best_bid
                .as_ref()
                .filter(|lvl| lvl.amount >= min_depth);
            let ask_high = high
                .quote
                .best_ask
                .as_ref()
                .filter(|lvl| lvl.amount >= min_depth);
            let bid_high = high
                .quote
                .best_bid
                .as_ref()
                .filter(|lvl| lvl.amount >= min_depth);

            let (buy_inst, buy_quote, sell_inst, sell_quote) = match low.instrument.option_kind {
                OptionKind::Call => {
                    let ask_low = match ask_low {
                        Some(level) => level,
                        None => continue,
                    };
                    let bid_high = match bid_high {
                        Some(level) => level,
                        None => continue,
                    };
                    (low, ask_low, high, bid_high)
                }
                OptionKind::Put => {
                    let ask_high = match ask_high {
                        Some(level) => level,
                        None => continue,
                    };
                    let bid_low = match bid_low {
                        Some(level) => level,
                        None => continue,
                    };
                    (high, ask_high, low, bid_low)
                }
            };

            let size_contracts = buy_quote
                .amount
                .min(sell_quote.amount)
                .min(self.max_contracts_from_ticket(buy_inst));
            if size_contracts <= Decimal::ZERO {
                continue;
            }

            let debit_native = buy_quote.price * size_contracts * buy_inst.instrument.contract_size
                - sell_quote.price * size_contracts * sell_inst.instrument.contract_size;
            if debit_native < Decimal::ZERO {
                continue;
            }

            let reference_index = buy_inst.quote.index_price;
            let debit_usd = match settlement {
                SettlementCurrency::Usdc => debit_native,
                SettlementCurrency::Coin => debit_native * reference_index,
            };

            let strikes_diff = high.instrument.strike - low.instrument.strike;
            if strikes_diff <= Decimal::ZERO {
                continue;
            }
            let max_payout_usd = strikes_diff * size_contracts * low.instrument.contract_size;
            let tolerance_usd = Decimal::new(1, 6);
            if debit_usd > max_payout_usd + tolerance_usd {
                continue;
            }

            let max_payout_native = match settlement {
                SettlementCurrency::Usdc => max_payout_usd,
                SettlementCurrency::Coin => {
                    if reference_index.is_zero() {
                        Decimal::ZERO
                    } else {
                        max_payout_usd / reference_index
                    }
                }
            };

            let legs = vec![
                ComboLeg {
                    instrument_name: buy_inst.instrument.instrument_name.clone(),
                    ratio: 1,
                    side: ComboSide::Buy,
                },
                ComboLeg {
                    instrument_name: sell_inst.instrument.instrument_name.clone(),
                    ratio: 1,
                    side: ComboSide::Sell,
                },
            ];

            let touches = vec![
                LegTouch {
                    instrument_name: buy_inst.instrument.instrument_name.clone(),
                    side: ComboSide::Buy,
                    price: buy_quote.price,
                    size_contracts,
                },
                LegTouch {
                    instrument_name: sell_inst.instrument.instrument_name.clone(),
                    side: ComboSide::Sell,
                    price: sell_quote.price,
                    size_contracts,
                },
            ];

            let fee_ctx = FeeComputationContext {
                legs: vec![
                    LegFeeInput {
                        instrument_name: buy_inst.instrument.instrument_name.clone(),
                        side: ComboSide::Buy,
                        settlement,
                        role: FillRole::Taker,
                        option_price: buy_quote.price,
                        index_price: buy_inst.quote.index_price,
                        contracts: size_contracts,
                        contract_size: buy_inst.instrument.contract_size,
                        expiry: buy_inst.instrument.expiry,
                        is_daily: is_daily_option(
                            &buy_inst.instrument.instrument_name,
                            buy_inst.instrument.expiry,
                        ),
                    },
                    LegFeeInput {
                        instrument_name: sell_inst.instrument.instrument_name.clone(),
                        side: ComboSide::Sell,
                        settlement,
                        role: FillRole::Taker,
                        option_price: sell_quote.price,
                        index_price: sell_inst.quote.index_price,
                        contracts: size_contracts,
                        contract_size: sell_inst.instrument.contract_size,
                        expiry: sell_inst.instrument.expiry,
                        is_daily: is_daily_option(
                            &sell_inst.instrument.instrument_name,
                            sell_inst.instrument.expiry,
                        ),
                    },
                ],
                hold_to_expiry: self.config.hold_to_expiry,
            };

            let fee_breakdown = self.fee_engine.compute(fee_ctx)?;
            let net_edge_usd = max_payout_usd - debit_usd - fee_breakdown.total_usd;
            if net_edge_usd <= Decimal::ZERO {
                continue;
            }
            if net_edge_usd < self.config.min_edge_usd {
                continue;
            }
            let fee_guard = fee_breakdown.total_usd.max(dec!(0.01));
            let edge_ratio = (net_edge_usd / fee_guard).to_f64().unwrap_or(0.0);
            if edge_ratio < self.config.min_edge_ratio {
                continue;
            }

            let execution_plan = ComboExecutionPlan {
                create_payload: json!({
                    "legs": legs.iter().map(|leg| {
                        json!({
                            "instrument_name": leg.instrument_name,
                            "ratio": leg.ratio,
                            "direction": match leg.side {
                                ComboSide::Buy => "buy",
                                ComboSide::Sell => "sell",
                            },
                        })
                    }).collect::<Vec<_>>(),
                    "amount": size_contracts,
                }),
                tif: OrderTimeInForce::IOC,
                price_limit: debit_native,
                dry_run: self.config.dry_run,
            };

            let opportunity = StrategyOpportunity {
                strategy: StrategyKind::Vertical,
                currency,
                settlement,
                expiry: vec![expiry],
                strikes: vec![low.instrument.strike, high.instrument.strike],
                legs,
                touches,
                total_cost: debit_native,
                max_payout: max_payout_native,
                fee_breakdown,
                net_edge_native: match settlement {
                    SettlementCurrency::Usdc => net_edge_usd,
                    SettlementCurrency::Coin => {
                        if reference_index.is_zero() {
                            Decimal::ZERO
                        } else {
                            net_edge_usd / reference_index
                        }
                    }
                },
                net_edge_usd,
                notional_usd: reference_index * size_contracts * buy_inst.instrument.contract_size,
                reference_index,
                edge_bps: compute_edge_bps(
                    net_edge_usd,
                    size_contracts,
                    reference_index,
                    settlement,
                ),
                size_contracts,
                execution_plan,
            };
            results.push(opportunity);
        }
        Ok(results)
    }
    fn detect_butterflies(
        &self,
        instruments: &[InstrumentSnapshot],
        currency: crate::model::Currency,
        settlement: SettlementCurrency,
        expiry: chrono::DateTime<Utc>,
    ) -> Result<Vec<StrategyOpportunity>> {
        let mut by_strike: Vec<_> = instruments.iter().collect();
        by_strike.sort_by(|a, b| a.instrument.strike.cmp(&b.instrument.strike));
        let mut results = Vec::new();
        for window in by_strike.windows(3) {
            let low = window[0];
            let mid = window[1];
            let high = window[2];
            let ask_low = match &low.quote.best_ask {
                Some(level) if level.amount >= Decimal::from(self.config.min_depth_contracts) => {
                    level
                }
                _ => continue,
            };
            let bid_mid = match &mid.quote.best_bid {
                Some(level) if level.amount >= Decimal::from(self.config.min_depth_contracts) => {
                    level
                }
                _ => continue,
            };
            let ask_high = match &high.quote.best_ask {
                Some(level) if level.amount >= Decimal::from(self.config.min_depth_contracts) => {
                    level
                }
                _ => continue,
            };
            let size_contracts = ask_low
                .amount
                .min(ask_high.amount)
                .min(bid_mid.amount / dec!(2))
                .min(self.max_contracts_from_ticket(low));
            if size_contracts <= Decimal::ZERO {
                continue;
            }
            let fly_cost = ask_low.price + ask_high.price - (bid_mid.price * dec!(2));
            let debit_native = fly_cost * size_contracts * low.instrument.contract_size;
            let debit_usd = match settlement {
                SettlementCurrency::Usdc => debit_native,
                SettlementCurrency::Coin => debit_native * low.quote.index_price,
            };

            let legs = vec![
                ComboLeg {
                    instrument_name: low.instrument.instrument_name.clone(),
                    ratio: 1,
                    side: ComboSide::Buy,
                },
                ComboLeg {
                    instrument_name: mid.instrument.instrument_name.clone(),
                    ratio: 2,
                    side: ComboSide::Sell,
                },
                ComboLeg {
                    instrument_name: high.instrument.instrument_name.clone(),
                    ratio: 1,
                    side: ComboSide::Buy,
                },
            ];

            let touches = vec![
                LegTouch {
                    instrument_name: low.instrument.instrument_name.clone(),
                    side: ComboSide::Buy,
                    price: ask_low.price,
                    size_contracts,
                },
                LegTouch {
                    instrument_name: mid.instrument.instrument_name.clone(),
                    side: ComboSide::Sell,
                    price: bid_mid.price,
                    size_contracts: size_contracts * dec!(2),
                },
                LegTouch {
                    instrument_name: high.instrument.instrument_name.clone(),
                    side: ComboSide::Buy,
                    price: ask_high.price,
                    size_contracts,
                },
            ];

            let fee_ctx = FeeComputationContext {
                legs: vec![
                    LegFeeInput {
                        instrument_name: low.instrument.instrument_name.clone(),
                        side: ComboSide::Buy,
                        settlement,
                        role: FillRole::Taker,
                        option_price: ask_low.price,
                        index_price: low.quote.index_price,
                        contracts: size_contracts,
                        contract_size: low.instrument.contract_size,
                        expiry: low.instrument.expiry,
                        is_daily: is_daily_option(
                            &low.instrument.instrument_name,
                            low.instrument.expiry,
                        ),
                    },
                    LegFeeInput {
                        instrument_name: mid.instrument.instrument_name.clone(),
                        side: ComboSide::Sell,
                        settlement,
                        role: FillRole::Taker,
                        option_price: bid_mid.price,
                        index_price: mid.quote.index_price,
                        contracts: size_contracts * dec!(2),
                        contract_size: mid.instrument.contract_size,
                        expiry: mid.instrument.expiry,
                        is_daily: is_daily_option(
                            &mid.instrument.instrument_name,
                            mid.instrument.expiry,
                        ),
                    },
                    LegFeeInput {
                        instrument_name: high.instrument.instrument_name.clone(),
                        side: ComboSide::Buy,
                        settlement,
                        role: FillRole::Taker,
                        option_price: ask_high.price,
                        index_price: high.quote.index_price,
                        contracts: size_contracts,
                        contract_size: high.instrument.contract_size,
                        expiry: high.instrument.expiry,
                        is_daily: is_daily_option(
                            &high.instrument.instrument_name,
                            high.instrument.expiry,
                        ),
                    },
                ],
                hold_to_expiry: self.config.hold_to_expiry,
            };
            let fee_breakdown = self.fee_engine.compute(fee_ctx)?;
            let net_edge_usd = -(debit_usd + fee_breakdown.total_usd);
            if net_edge_usd <= Decimal::ZERO {
                continue;
            }
            if net_edge_usd < self.config.min_edge_usd {
                continue;
            }
            let edge_ratio = (net_edge_usd / fee_breakdown.total_usd.max(dec!(0.01)))
                .to_f64()
                .unwrap_or(0.0);
            if edge_ratio < self.config.min_edge_ratio {
                continue;
            }

            let execution_plan = ComboExecutionPlan {
                create_payload: json!({
                    "legs": legs.iter().map(|leg| {
                        json!({
                            "instrument_name": leg.instrument_name,
                            "ratio": leg.ratio,
                            "direction": match leg.side {
                                ComboSide::Buy => "buy",
                                ComboSide::Sell => "sell",
                            },
                        })
                    }).collect::<Vec<_>>(),
                    "amount": size_contracts,
                }),
                tif: OrderTimeInForce::IOC,
                price_limit: debit_native,
                dry_run: self.config.dry_run,
            };
            let opportunity = StrategyOpportunity {
                strategy: StrategyKind::Butterfly,
                currency,
                settlement,
                expiry: vec![expiry],
                strikes: vec![
                    low.instrument.strike,
                    mid.instrument.strike,
                    high.instrument.strike,
                ],
                legs,
                touches,
                total_cost: debit_native,
                max_payout: (high.instrument.strike - low.instrument.strike)
                    * size_contracts
                    * low.instrument.contract_size,
                fee_breakdown,
                net_edge_native: match settlement {
                    SettlementCurrency::Usdc => net_edge_usd,
                    SettlementCurrency::Coin => {
                        if low.quote.index_price.is_zero() {
                            Decimal::ZERO
                        } else {
                            net_edge_usd / low.quote.index_price
                        }
                    }
                },
                net_edge_usd,
                notional_usd: low.quote.index_price * size_contracts * low.instrument.contract_size,
                reference_index: low.quote.index_price,
                edge_bps: compute_edge_bps(
                    net_edge_usd,
                    size_contracts,
                    low.quote.index_price,
                    settlement,
                ),
                size_contracts,
                execution_plan,
            };
            results.push(opportunity);
        }
        Ok(results)
    }

    fn detect_calendars(
        &self,
        snapshot: &[InstrumentSnapshot],
    ) -> Result<Vec<StrategyOpportunity>> {
        let mut grouped: HashMap<
            (
                crate::model::Currency,
                Decimal,
                SettlementCurrency,
                OptionKind,
            ),
            Vec<&InstrumentSnapshot>,
        > = HashMap::new();
        for inst in snapshot {
            grouped
                .entry((
                    inst.instrument.currency,
                    inst.instrument.strike,
                    inst.instrument.settlement_currency,
                    inst.instrument.option_kind,
                ))
                .or_default()
                .push(inst);
        }
        let mut results = Vec::new();
        for ((currency, _strike, settlement, _option_kind), instruments) in grouped {
            if instruments.len() < 2 {
                continue;
            }
            if self.config.strategy_filter.allows(StrategyKind::Calendar) {
                let mut by_expiry: Vec<_> = instruments.iter().collect();
                by_expiry.sort_by(|a, b| a.instrument.expiry.cmp(&b.instrument.expiry));
                for window in by_expiry.windows(2) {
                    let near = window[0];
                    let far = window[1];
                    if near.instrument.expiry == far.instrument.expiry {
                        continue;
                    }
                    let near_bid = match &near.quote.best_bid {
                        Some(level)
                            if level.amount >= Decimal::from(self.config.min_depth_contracts) =>
                        {
                            level
                        }
                        _ => continue,
                    };
                    let far_ask = match &far.quote.best_ask {
                        Some(level)
                            if level.amount >= Decimal::from(self.config.min_depth_contracts) =>
                        {
                            level
                        }
                        _ => continue,
                    };
                    let size_contracts = near_bid
                        .amount
                        .min(far_ask.amount)
                        .min(self.max_contracts_from_ticket(near));
                    if size_contracts <= Decimal::ZERO {
                        continue;
                    }
                    let credit_native =
                        near_bid.price * size_contracts * near.instrument.contract_size
                            - far_ask.price * size_contracts * far.instrument.contract_size;
                    let credit_usd = match settlement {
                        SettlementCurrency::Usdc => credit_native,
                        SettlementCurrency::Coin => credit_native * near.quote.index_price,
                    };

                    if credit_usd <= Decimal::ZERO {
                        continue;
                    }

                    let legs = vec![
                        ComboLeg {
                            instrument_name: near.instrument.instrument_name.clone(),
                            ratio: 1,
                            side: ComboSide::Sell,
                        },
                        ComboLeg {
                            instrument_name: far.instrument.instrument_name.clone(),
                            ratio: 1,
                            side: ComboSide::Buy,
                        },
                    ];
                    let touches = vec![
                        LegTouch {
                            instrument_name: near.instrument.instrument_name.clone(),
                            side: ComboSide::Sell,
                            price: near_bid.price,
                            size_contracts,
                        },
                        LegTouch {
                            instrument_name: far.instrument.instrument_name.clone(),
                            side: ComboSide::Buy,
                            price: far_ask.price,
                            size_contracts,
                        },
                    ];
                    let fee_ctx = FeeComputationContext {
                        legs: vec![
                            LegFeeInput {
                                instrument_name: near.instrument.instrument_name.clone(),
                                side: ComboSide::Sell,
                                settlement,
                                role: FillRole::Taker,
                                option_price: near_bid.price,
                                index_price: near.quote.index_price,
                                contracts: size_contracts,
                                contract_size: near.instrument.contract_size,
                                expiry: near.instrument.expiry,
                                is_daily: is_daily_option(
                                    &near.instrument.instrument_name,
                                    near.instrument.expiry,
                                ),
                            },
                            LegFeeInput {
                                instrument_name: far.instrument.instrument_name.clone(),
                                side: ComboSide::Buy,
                                settlement,
                                role: FillRole::Taker,
                                option_price: far_ask.price,
                                index_price: far.quote.index_price,
                                contracts: size_contracts,
                                contract_size: far.instrument.contract_size,
                                expiry: far.instrument.expiry,
                                is_daily: is_daily_option(
                                    &far.instrument.instrument_name,
                                    far.instrument.expiry,
                                ),
                            },
                        ],
                        hold_to_expiry: self.config.hold_to_expiry,
                    };
                    let fee_breakdown = self.fee_engine.compute(fee_ctx)?;
                    let net_edge_usd = credit_usd - fee_breakdown.total_usd;
                    if net_edge_usd <= Decimal::ZERO {
                        continue;
                    }
                    if net_edge_usd < self.config.min_edge_usd {
                        continue;
                    }
                    let edge_ratio = (net_edge_usd / fee_breakdown.total_usd.max(dec!(0.01)))
                        .to_f64()
                        .unwrap_or(0.0);
                    if edge_ratio < self.config.min_edge_ratio {
                        continue;
                    }
                    let execution_plan = ComboExecutionPlan {
                        create_payload: json!({
                            "legs": legs.iter().map(|leg| {
                                json!({
                                    "instrument_name": leg.instrument_name,
                                    "ratio": leg.ratio,
                                    "direction": match leg.side {
                                        ComboSide::Buy => "buy",
                                        ComboSide::Sell => "sell",
                                    },
                                })
                            }).collect::<Vec<_>>(),
                            "amount": size_contracts,
                        }),
                        tif: OrderTimeInForce::IOC,
                        price_limit: credit_native,
                        dry_run: self.config.dry_run,
                    };
                    let opportunity = StrategyOpportunity {
                        strategy: StrategyKind::Calendar,
                        currency,
                        settlement,
                        expiry: vec![near.instrument.expiry, far.instrument.expiry],
                        strikes: vec![near.instrument.strike],
                        legs,
                        touches,
                        total_cost: credit_native,
                        max_payout: Decimal::ZERO,
                        fee_breakdown,
                        net_edge_native: match settlement {
                            SettlementCurrency::Usdc => net_edge_usd,
                            SettlementCurrency::Coin => {
                                if near.quote.index_price.is_zero() {
                                    Decimal::ZERO
                                } else {
                                    net_edge_usd / near.quote.index_price
                                }
                            }
                        },
                        net_edge_usd,
                        notional_usd: near.quote.index_price
                            * size_contracts
                            * near.instrument.contract_size,
                        reference_index: near.quote.index_price,
                        edge_bps: compute_edge_bps(
                            net_edge_usd,
                            size_contracts,
                            near.quote.index_price,
                            settlement,
                        ),
                        size_contracts,
                        execution_plan,
                    };
                    results.push(opportunity);
                }
            }
        }
        Ok(results)
    }

    fn detect_boxes(&self, snapshot: &[InstrumentSnapshot]) -> Result<Vec<StrategyOpportunity>> {
        let mut by_expiry: HashMap<
            (
                chrono::DateTime<Utc>,
                SettlementCurrency,
                crate::model::Currency,
            ),
            Vec<&InstrumentSnapshot>,
        > = HashMap::new();
        for inst in snapshot {
            if inst.instrument.settlement_currency != SettlementCurrency::Usdc {
                continue;
            }
            by_expiry
                .entry((
                    inst.instrument.expiry,
                    inst.instrument.settlement_currency,
                    inst.instrument.currency,
                ))
                .or_default()
                .push(inst);
        }
        let mut results = Vec::new();
        for ((_expiry, settlement, currency), instruments) in by_expiry {
            let mut calls: Vec<_> = instruments
                .iter()
                .filter(|inst| {
                    matches!(inst.instrument.option_kind, crate::model::OptionKind::Call)
                })
                .collect();
            let mut puts: Vec<_> = instruments
                .iter()
                .filter(|inst| matches!(inst.instrument.option_kind, crate::model::OptionKind::Put))
                .collect();
            calls.sort_by(|a, b| a.instrument.strike.cmp(&b.instrument.strike));
            puts.sort_by(|a, b| a.instrument.strike.cmp(&b.instrument.strike));
            for call_window in calls.windows(2) {
                let c_low = call_window[0];
                let c_high = call_window[1];
                let p_low = puts
                    .iter()
                    .find(|p| p.instrument.strike == c_low.instrument.strike);
                let p_high = puts
                    .iter()
                    .find(|p| p.instrument.strike == c_high.instrument.strike);
                if p_low.is_none() || p_high.is_none() {
                    continue;
                }
                let p_low = *p_low.unwrap();
                let p_high = *p_high.unwrap();

                let ask_call_low = match &c_low.quote.best_ask {
                    Some(level)
                        if level.amount >= Decimal::from(self.config.min_depth_contracts) =>
                    {
                        level
                    }
                    _ => continue,
                };
                let bid_call_high = match &c_high.quote.best_bid {
                    Some(level)
                        if level.amount >= Decimal::from(self.config.min_depth_contracts) =>
                    {
                        level
                    }
                    _ => continue,
                };
                let ask_put_high = match &p_high.quote.best_ask {
                    Some(level)
                        if level.amount >= Decimal::from(self.config.min_depth_contracts) =>
                    {
                        level
                    }
                    _ => continue,
                };
                let bid_put_low = match &p_low.quote.best_bid {
                    Some(level)
                        if level.amount >= Decimal::from(self.config.min_depth_contracts) =>
                    {
                        level
                    }
                    _ => continue,
                };

                let size_contracts = ask_call_low
                    .amount
                    .min(bid_call_high.amount)
                    .min(ask_put_high.amount)
                    .min(bid_put_low.amount)
                    .min(self.max_contracts_from_ticket(c_low));
                if size_contracts <= Decimal::ZERO {
                    continue;
                }

                let legs = vec![
                    ComboLeg {
                        instrument_name: c_low.instrument.instrument_name.clone(),
                        ratio: 1,
                        side: ComboSide::Buy,
                    },
                    ComboLeg {
                        instrument_name: c_high.instrument.instrument_name.clone(),
                        ratio: 1,
                        side: ComboSide::Sell,
                    },
                    ComboLeg {
                        instrument_name: p_low.instrument.instrument_name.clone(),
                        ratio: 1,
                        side: ComboSide::Sell,
                    },
                    ComboLeg {
                        instrument_name: p_high.instrument.instrument_name.clone(),
                        ratio: 1,
                        side: ComboSide::Buy,
                    },
                ];

                let touches = vec![
                    LegTouch {
                        instrument_name: c_low.instrument.instrument_name.clone(),
                        side: ComboSide::Buy,
                        price: ask_call_low.price,
                        size_contracts,
                    },
                    LegTouch {
                        instrument_name: c_high.instrument.instrument_name.clone(),
                        side: ComboSide::Sell,
                        price: bid_call_high.price,
                        size_contracts,
                    },
                    LegTouch {
                        instrument_name: p_low.instrument.instrument_name.clone(),
                        side: ComboSide::Sell,
                        price: bid_put_low.price,
                        size_contracts,
                    },
                    LegTouch {
                        instrument_name: p_high.instrument.instrument_name.clone(),
                        side: ComboSide::Buy,
                        price: ask_put_high.price,
                        size_contracts,
                    },
                ];

                let fee_ctx = FeeComputationContext {
                    legs: vec![
                        LegFeeInput {
                            instrument_name: c_low.instrument.instrument_name.clone(),
                            side: ComboSide::Buy,
                            settlement,
                            role: FillRole::Taker,
                            option_price: ask_call_low.price,
                            index_price: c_low.quote.index_price,
                            contracts: size_contracts,
                            contract_size: c_low.instrument.contract_size,
                            expiry: c_low.instrument.expiry,
                            is_daily: is_daily_option(
                                &c_low.instrument.instrument_name,
                                c_low.instrument.expiry,
                            ),
                        },
                        LegFeeInput {
                            instrument_name: c_high.instrument.instrument_name.clone(),
                            side: ComboSide::Sell,
                            settlement,
                            role: FillRole::Taker,
                            option_price: bid_call_high.price,
                            index_price: c_high.quote.index_price,
                            contracts: size_contracts,
                            contract_size: c_high.instrument.contract_size,
                            expiry: c_high.instrument.expiry,
                            is_daily: is_daily_option(
                                &c_high.instrument.instrument_name,
                                c_high.instrument.expiry,
                            ),
                        },
                        LegFeeInput {
                            instrument_name: p_low.instrument.instrument_name.clone(),
                            side: ComboSide::Sell,
                            settlement,
                            role: FillRole::Taker,
                            option_price: bid_put_low.price,
                            index_price: p_low.quote.index_price,
                            contracts: size_contracts,
                            contract_size: p_low.instrument.contract_size,
                            expiry: p_low.instrument.expiry,
                            is_daily: is_daily_option(
                                &p_low.instrument.instrument_name,
                                p_low.instrument.expiry,
                            ),
                        },
                        LegFeeInput {
                            instrument_name: p_high.instrument.instrument_name.clone(),
                            side: ComboSide::Buy,
                            settlement,
                            role: FillRole::Taker,
                            option_price: ask_put_high.price,
                            index_price: p_high.quote.index_price,
                            contracts: size_contracts,
                            contract_size: p_high.instrument.contract_size,
                            expiry: p_high.instrument.expiry,
                            is_daily: is_daily_option(
                                &p_high.instrument.instrument_name,
                                p_high.instrument.expiry,
                            ),
                        },
                    ],
                    hold_to_expiry: self.config.hold_to_expiry,
                };
                let fee_breakdown = self.fee_engine.compute(fee_ctx)?;

                let fair_value = (c_high.instrument.strike - c_low.instrument.strike)
                    * size_contracts
                    * c_low.instrument.contract_size;

                let combo_price = ask_call_low.price - bid_call_high.price - bid_put_low.price
                    + ask_put_high.price;
                let combo_price_usd = combo_price * size_contracts * c_low.instrument.contract_size;
                let net_edge_usd = fair_value - combo_price_usd - fee_breakdown.total_usd;
                if net_edge_usd <= Decimal::ZERO {
                    continue;
                }
                if net_edge_usd < self.config.min_edge_usd {
                    continue;
                }

                let execution_plan = ComboExecutionPlan {
                    create_payload: json!({
                        "legs": legs.iter().map(|leg| {
                            json!({
                                "instrument_name": leg.instrument_name,
                                "ratio": leg.ratio,
                                "direction": match leg.side {
                                    ComboSide::Buy => "buy",
                                    ComboSide::Sell => "sell",
                                },
                            })
                        }).collect::<Vec<_>>(),
                        "amount": size_contracts,
                    }),
                    tif: OrderTimeInForce::IOC,
                    price_limit: combo_price * size_contracts,
                    dry_run: self.config.dry_run,
                };

                let opportunity = StrategyOpportunity {
                    strategy: StrategyKind::Box,
                    currency,
                    settlement,
                    expiry: vec![c_low.instrument.expiry],
                    strikes: vec![c_low.instrument.strike, c_high.instrument.strike],
                    legs,
                    touches,
                    total_cost: combo_price * size_contracts,
                    max_payout: fair_value,
                    fee_breakdown,
                    net_edge_native: net_edge_usd,
                    net_edge_usd,
                    notional_usd: c_low.quote.index_price
                        * size_contracts
                        * c_low.instrument.contract_size,
                    reference_index: c_low.quote.index_price,
                    edge_bps: compute_edge_bps(
                        net_edge_usd,
                        size_contracts,
                        c_low.quote.index_price,
                        settlement,
                    ),
                    size_contracts,
                    execution_plan,
                };
                results.push(opportunity);
            }
        }
        Ok(results)
    }

    fn detect_jelly_rolls(
        &self,
        snapshot: &[InstrumentSnapshot],
    ) -> Result<Vec<StrategyOpportunity>> {
        #[derive(Default)]
        struct ExpiryBucket<'a> {
            call: Option<&'a InstrumentSnapshot>,
            put: Option<&'a InstrumentSnapshot>,
        }

        let mut buckets: HashMap<
            (crate::model::Currency, Decimal, SettlementCurrency),
            HashMap<chrono::DateTime<Utc>, ExpiryBucket>,
        > = HashMap::new();

        for inst in snapshot {
            let key = (
                inst.instrument.currency,
                inst.instrument.strike,
                inst.instrument.settlement_currency,
            );
            let expiry_map = buckets.entry(key).or_default();
            let bucket = expiry_map.entry(inst.instrument.expiry).or_default();
            match inst.instrument.option_kind {
                OptionKind::Call => bucket.call = Some(inst),
                OptionKind::Put => bucket.put = Some(inst),
            }
        }

        let mut results = Vec::new();

        for ((currency, strike, settlement), expiry_map) in buckets {
            let mut expiries: Vec<_> = expiry_map
                .into_iter()
                .filter_map(|(expiry, bucket)| Some((expiry, bucket.call?, bucket.put?)))
                .collect();

            if expiries.len() < 2 {
                continue;
            }

            expiries.sort_by(|a, b| a.0.cmp(&b.0));

            for window in expiries.windows(2) {
                let (near_expiry, near_call, near_put) = window[0];
                let (far_expiry, far_call, far_put) = window[1];

                let ask_call_near = match &near_call.quote.best_ask {
                    Some(level)
                        if level.amount >= Decimal::from(self.config.min_depth_contracts) =>
                    {
                        level
                    }
                    _ => continue,
                };
                let bid_put_near = match &near_put.quote.best_bid {
                    Some(level)
                        if level.amount >= Decimal::from(self.config.min_depth_contracts) =>
                    {
                        level
                    }
                    _ => continue,
                };
                let bid_call_far = match &far_call.quote.best_bid {
                    Some(level)
                        if level.amount >= Decimal::from(self.config.min_depth_contracts) =>
                    {
                        level
                    }
                    _ => continue,
                };
                let ask_put_far = match &far_put.quote.best_ask {
                    Some(level)
                        if level.amount >= Decimal::from(self.config.min_depth_contracts) =>
                    {
                        level
                    }
                    _ => continue,
                };

                let size_contracts = ask_call_near
                    .amount
                    .min(bid_put_near.amount)
                    .min(bid_call_far.amount)
                    .min(ask_put_far.amount)
                    .min(self.max_contracts_from_ticket(near_call));

                if size_contracts <= Decimal::ZERO {
                    continue;
                }

                let debit_native =
                    ask_call_near.price * size_contracts * near_call.instrument.contract_size
                        - bid_put_near.price * size_contracts * near_put.instrument.contract_size
                        - bid_call_far.price * size_contracts * far_call.instrument.contract_size
                        + ask_put_far.price * size_contracts * far_put.instrument.contract_size;

                let reference_index = near_call.quote.index_price;
                let debit_usd = match settlement {
                    SettlementCurrency::Usdc => debit_native,
                    SettlementCurrency::Coin => debit_native * reference_index,
                };

                if debit_usd >= Decimal::ZERO {
                    continue;
                }

                let fee_ctx = FeeComputationContext {
                    legs: vec![
                        LegFeeInput {
                            instrument_name: near_call.instrument.instrument_name.clone(),
                            side: ComboSide::Buy,
                            settlement,
                            role: FillRole::Taker,
                            option_price: ask_call_near.price,
                            index_price: near_call.quote.index_price,
                            contracts: size_contracts,
                            contract_size: near_call.instrument.contract_size,
                            expiry: near_call.instrument.expiry,
                            is_daily: is_daily_option(
                                &near_call.instrument.instrument_name,
                                near_call.instrument.expiry,
                            ),
                        },
                        LegFeeInput {
                            instrument_name: near_put.instrument.instrument_name.clone(),
                            side: ComboSide::Sell,
                            settlement,
                            role: FillRole::Taker,
                            option_price: bid_put_near.price,
                            index_price: near_put.quote.index_price,
                            contracts: size_contracts,
                            contract_size: near_put.instrument.contract_size,
                            expiry: near_put.instrument.expiry,
                            is_daily: is_daily_option(
                                &near_put.instrument.instrument_name,
                                near_put.instrument.expiry,
                            ),
                        },
                        LegFeeInput {
                            instrument_name: far_call.instrument.instrument_name.clone(),
                            side: ComboSide::Sell,
                            settlement,
                            role: FillRole::Taker,
                            option_price: bid_call_far.price,
                            index_price: far_call.quote.index_price,
                            contracts: size_contracts,
                            contract_size: far_call.instrument.contract_size,
                            expiry: far_call.instrument.expiry,
                            is_daily: is_daily_option(
                                &far_call.instrument.instrument_name,
                                far_call.instrument.expiry,
                            ),
                        },
                        LegFeeInput {
                            instrument_name: far_put.instrument.instrument_name.clone(),
                            side: ComboSide::Buy,
                            settlement,
                            role: FillRole::Taker,
                            option_price: ask_put_far.price,
                            index_price: far_put.quote.index_price,
                            contracts: size_contracts,
                            contract_size: far_put.instrument.contract_size,
                            expiry: far_put.instrument.expiry,
                            is_daily: is_daily_option(
                                &far_put.instrument.instrument_name,
                                far_put.instrument.expiry,
                            ),
                        },
                    ],
                    hold_to_expiry: self.config.hold_to_expiry,
                };

                let fee_breakdown = self.fee_engine.compute(fee_ctx)?;
                let net_edge_usd = (-debit_usd) - fee_breakdown.total_usd;

                if net_edge_usd <= Decimal::ZERO {
                    continue;
                }
                if net_edge_usd < self.config.min_edge_usd {
                    continue;
                }
                let edge_ratio = (net_edge_usd / fee_breakdown.total_usd.max(dec!(0.01)))
                    .to_f64()
                    .unwrap_or(0.0);
                if edge_ratio < self.config.min_edge_ratio {
                    continue;
                }

                let legs = vec![
                    ComboLeg {
                        instrument_name: near_call.instrument.instrument_name.clone(),
                        ratio: 1,
                        side: ComboSide::Buy,
                    },
                    ComboLeg {
                        instrument_name: near_put.instrument.instrument_name.clone(),
                        ratio: 1,
                        side: ComboSide::Sell,
                    },
                    ComboLeg {
                        instrument_name: far_call.instrument.instrument_name.clone(),
                        ratio: 1,
                        side: ComboSide::Sell,
                    },
                    ComboLeg {
                        instrument_name: far_put.instrument.instrument_name.clone(),
                        ratio: 1,
                        side: ComboSide::Buy,
                    },
                ];

                let touches = vec![
                    LegTouch {
                        instrument_name: near_call.instrument.instrument_name.clone(),
                        side: ComboSide::Buy,
                        price: ask_call_near.price,
                        size_contracts,
                    },
                    LegTouch {
                        instrument_name: near_put.instrument.instrument_name.clone(),
                        side: ComboSide::Sell,
                        price: bid_put_near.price,
                        size_contracts,
                    },
                    LegTouch {
                        instrument_name: far_call.instrument.instrument_name.clone(),
                        side: ComboSide::Sell,
                        price: bid_call_far.price,
                        size_contracts,
                    },
                    LegTouch {
                        instrument_name: far_put.instrument.instrument_name.clone(),
                        side: ComboSide::Buy,
                        price: ask_put_far.price,
                        size_contracts,
                    },
                ];

                let execution_plan = ComboExecutionPlan {
                    create_payload: json!({
                        "legs": legs.iter().map(|leg| {
                            json!({
                                "instrument_name": leg.instrument_name,
                                "ratio": leg.ratio,
                                "direction": match leg.side {
                                    ComboSide::Buy => "buy",
                                    ComboSide::Sell => "sell",
                                },
                            })
                        }).collect::<Vec<_>>(),
                        "amount": size_contracts,
                    }),
                    tif: OrderTimeInForce::IOC,
                    price_limit: debit_native,
                    dry_run: self.config.dry_run,
                };

                let notional_usd = near_call.quote.index_price
                    * size_contracts
                    * near_call.instrument.contract_size;

                let opportunity = StrategyOpportunity {
                    strategy: StrategyKind::JellyRoll,
                    currency,
                    settlement,
                    expiry: vec![near_expiry, far_expiry],
                    strikes: vec![strike],
                    legs,
                    touches,
                    total_cost: debit_native,
                    max_payout: Decimal::ZERO,
                    fee_breakdown,
                    net_edge_native: match settlement {
                        SettlementCurrency::Usdc => net_edge_usd,
                        SettlementCurrency::Coin => {
                            if reference_index.is_zero() {
                                Decimal::ZERO
                            } else {
                                net_edge_usd / reference_index
                            }
                        }
                    },
                    net_edge_usd,
                    notional_usd,
                    reference_index,
                    edge_bps: compute_edge_bps(
                        net_edge_usd,
                        size_contracts,
                        reference_index,
                        settlement,
                    ),
                    size_contracts,
                    execution_plan,
                };
                results.push(opportunity);
            }
        }

        Ok(results)
    }

    fn max_contracts_from_ticket(&self, inst: &InstrumentSnapshot) -> Decimal {
        let index_price = inst.quote.index_price;
        if index_price.is_zero() {
            return Decimal::from(self.config.min_depth_contracts);
        }
        let ticket_cap = self.config.max_ticket_usd;
        let notional_per_contract = index_price * inst.instrument.contract_size;
        if notional_per_contract.is_zero() {
            return Decimal::from(self.config.min_depth_contracts);
        }
        let available = inst
            .quote
            .best_ask
            .as_ref()
            .map(|ask| ask.amount)
            .max(inst.quote.best_bid.as_ref().map(|bid| bid.amount))
            .unwrap_or_else(|| Decimal::from(self.config.min_depth_contracts));
        let cap = ticket_cap / notional_per_contract;
        cap.min(available).max(dec!(0))
    }
}

#[derive(Hash, Eq, PartialEq, Clone, Copy)]
enum StrategyKindKey {
    Call,
    Put,
}

fn group_by_expiry(
    snapshot: &[InstrumentSnapshot],
) -> HashMap<
    (
        crate::model::Currency,
        chrono::DateTime<Utc>,
        SettlementCurrency,
        StrategyKindKey,
    ),
    Vec<InstrumentSnapshot>,
> {
    let mut map: HashMap<_, Vec<InstrumentSnapshot>> = HashMap::new();
    for inst in snapshot.iter() {
        let kind_key = match inst.instrument.option_kind {
            crate::model::OptionKind::Call => StrategyKindKey::Call,
            crate::model::OptionKind::Put => StrategyKindKey::Put,
        };
        map.entry((
            inst.instrument.currency,
            inst.instrument.expiry,
            inst.instrument.settlement_currency,
            kind_key,
        ))
        .or_default()
        .push(inst.clone());
    }
    map
}

fn compute_edge_bps(
    net_edge_usd: Decimal,
    contracts: Decimal,
    index_price: Decimal,
    settlement: SettlementCurrency,
) -> f64 {
    if contracts.is_zero() || index_price.is_zero() {
        return 0.0;
    }
    let base = match settlement {
        SettlementCurrency::Usdc => index_price * contracts,
        SettlementCurrency::Coin => index_price * contracts,
    };
    (net_edge_usd / base).to_f64().unwrap_or(0.0) * 10_000.0
}

fn is_daily_option(name: &str, expiry: chrono::DateTime<Utc>) -> bool {
    if name.contains("-D") {
        return true;
    }
    expiry - Utc::now() <= Duration::days(1)
}
