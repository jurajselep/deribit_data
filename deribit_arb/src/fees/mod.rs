use crate::model::{ComboSide, FeeBreakdown, FillRole, LegFee, SettlementCurrency};
use anyhow::{anyhow, Result};
use chrono::{DateTime, Utc};
use rust_decimal::prelude::*;
use rust_decimal_macros::dec;

#[derive(Debug, Clone)]
pub struct LegFeeInput {
    pub instrument_name: String,
    pub side: ComboSide,
    pub settlement: SettlementCurrency,
    pub role: FillRole,
    pub option_price: Decimal,
    pub index_price: Decimal,
    pub contracts: Decimal,
    pub contract_size: Decimal,
    pub expiry: DateTime<Utc>,
    pub is_daily: bool,
}

#[derive(Debug, Clone)]
pub struct FeeComputationContext {
    pub legs: Vec<LegFeeInput>,
    pub hold_to_expiry: bool,
}

pub struct FeeEngine;

impl FeeEngine {
    pub fn new() -> Self {
        Self
    }

    pub fn compute(&self, ctx: FeeComputationContext) -> Result<FeeBreakdown> {
        if ctx.legs.is_empty() {
            return Err(anyhow!("no legs provided"));
        }
        let settlement = ctx.legs[0].settlement;
        if !ctx.legs.iter().all(|leg| leg.settlement == settlement) {
            return Err(anyhow!("mixed settlement combos not supported"));
        }

        let mut leg_fees: Vec<LegFee> = ctx
            .legs
            .iter()
            .map(|leg| compute_trade_fee(leg))
            .collect::<Result<Vec<_>>>()?;

        let mut buy_total_native = Decimal::ZERO;
        let mut sell_total_native = Decimal::ZERO;
        let mut buy_total_usd = Decimal::ZERO;
        let mut sell_total_usd = Decimal::ZERO;
        for fee in &leg_fees {
            match fee.side {
                ComboSide::Buy => {
                    buy_total_native += fee.trade_fee_native;
                    buy_total_usd += fee.trade_fee_usd;
                }
                ComboSide::Sell => {
                    sell_total_native += fee.trade_fee_native;
                    sell_total_usd += fee.trade_fee_usd;
                }
            }
        }

        let (combo_discount_native, combo_discount_usd) = if buy_total_usd <= sell_total_usd {
            for fee in leg_fees
                .iter_mut()
                .filter(|f| matches!(f.side, ComboSide::Buy))
            {
                fee.trade_fee_native = Decimal::ZERO;
                fee.trade_fee_usd = Decimal::ZERO;
            }
            (buy_total_native, buy_total_usd)
        } else {
            for fee in leg_fees
                .iter_mut()
                .filter(|f| matches!(f.side, ComboSide::Sell))
            {
                fee.trade_fee_native = Decimal::ZERO;
                fee.trade_fee_usd = Decimal::ZERO;
            }
            (sell_total_native, sell_total_usd)
        };

        let mut delivery_native = Decimal::ZERO;
        let mut delivery_usd = Decimal::ZERO;
        if ctx.hold_to_expiry {
            for leg in &ctx.legs {
                if leg.is_daily {
                    continue;
                }
                let contracts = leg.contracts.abs() * leg.contract_size;
                let notional_usd = leg.index_price * contracts;
                let option_value_usd = leg.option_price
                    * contracts
                    * match leg.settlement {
                        SettlementCurrency::Usdc => Decimal::ONE,
                        SettlementCurrency::Coin => leg.index_price,
                    };
                let delivery_fee_usd =
                    (notional_usd * dec!(0.00015)).min(option_value_usd * dec!(0.125));
                let delivery_fee_native = match leg.settlement {
                    SettlementCurrency::Usdc => delivery_fee_usd,
                    SettlementCurrency::Coin => {
                        if leg.index_price.is_zero() {
                            Decimal::ZERO
                        } else {
                            delivery_fee_usd / leg.index_price
                        }
                    }
                };
                delivery_usd += delivery_fee_usd;
                delivery_native += delivery_fee_native;
            }
        }

        let total_native = leg_fees
            .iter()
            .fold(Decimal::ZERO, |acc, fee| acc + fee.trade_fee_native)
            + delivery_native;
        let total_usd = leg_fees
            .iter()
            .fold(Decimal::ZERO, |acc, fee| acc + fee.trade_fee_usd)
            + delivery_usd;

        Ok(FeeBreakdown {
            legs: leg_fees,
            combo_discount: combo_discount_native,
            combo_discount_usd,
            delivery_fee: delivery_native,
            delivery_fee_usd: delivery_usd,
            total_native,
            total_usd,
        })
    }
}

fn compute_trade_fee(input: &LegFeeInput) -> Result<LegFee> {
    let contracts = input.contracts.abs();
    if contracts.is_zero() {
        return Ok(LegFee {
            instrument_name: input.instrument_name.clone(),
            side: input.side,
            settlement: input.settlement,
            execution_role: input.role,
            trade_fee_native: Decimal::ZERO,
            trade_fee_usd: Decimal::ZERO,
        });
    }

    let (fee_native, fee_usd) = match input.settlement {
        SettlementCurrency::Coin => {
            let max_pct = input.option_price * dec!(0.125);
            let per_contract_fee = if dec!(0.0003) < max_pct {
                dec!(0.0003)
            } else {
                max_pct
            };
            let total_native = per_contract_fee * contracts * input.contract_size;
            let total_usd = total_native * input.index_price;
            (total_native, total_usd)
        }
        SettlementCurrency::Usdc => {
            let cap = input.option_price * dec!(0.125);
            let base = input.index_price * dec!(0.0003);
            let per_contract_fee = if base < cap { base } else { cap };
            let total_native = per_contract_fee * contracts * input.contract_size;
            (total_native, total_native)
        }
    };

    Ok(LegFee {
        instrument_name: input.instrument_name.clone(),
        side: input.side,
        settlement: input.settlement,
        execution_role: input.role,
        trade_fee_native: fee_native,
        trade_fee_usd: fee_usd,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rstest::rstest;

    #[rstest]
    #[case(SettlementCurrency::Coin, dec!(0.02), dec!(40000), dec!(5))]
    #[case(SettlementCurrency::Usdc, dec!(500), dec!(1), dec!(2))]
    fn test_compute_trade_fee_basic(
        #[case] settlement: SettlementCurrency,
        #[case] option_price: Decimal,
        #[case] index_price: Decimal,
        #[case] contracts: Decimal,
    ) {
        let input = LegFeeInput {
            instrument_name: "BTC-TEST".into(),
            side: ComboSide::Buy,
            settlement,
            role: FillRole::Taker,
            option_price,
            index_price,
            contracts,
            contract_size: Decimal::ONE,
            expiry: Utc::now(),
            is_daily: false,
        };
        let fee = compute_trade_fee(&input).expect("fee");
        assert!(fee.trade_fee_native >= Decimal::ZERO);
        assert!(fee.trade_fee_usd >= Decimal::ZERO);
    }
}
