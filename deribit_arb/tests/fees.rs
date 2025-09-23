use deribit_arb::fees::{FeeComputationContext, FeeEngine, LegFeeInput};
use deribit_arb::model::{ComboSide, FillRole, SettlementCurrency};
use rust_decimal::Decimal;
use rust_decimal_macros::dec;

#[test]
fn coin_fee_matches_spec() {
    let engine = FeeEngine::new();
    let ctx = FeeComputationContext {
        legs: vec![LegFeeInput {
            instrument_name: "BTC-TEST".into(),
            side: ComboSide::Buy,
            settlement: SettlementCurrency::Coin,
            role: FillRole::Taker,
            option_price: dec!(0.015),
            index_price: dec!(40000),
            contracts: Decimal::from(10),
            contract_size: Decimal::ONE,
            expiry: chrono::Utc::now(),
            is_daily: false,
        }],
        hold_to_expiry: false,
    };
    let breakdown = engine.compute(ctx).expect("fees");
    let leg = &breakdown.legs[0];
    assert_eq!(leg.trade_fee_native, dec!(0.003));
    assert_eq!(leg.trade_fee_usd, dec!(120));
}

#[test]
fn usdc_linear_fee_matches_spec() {
    let engine = FeeEngine::new();
    let ctx = FeeComputationContext {
        legs: vec![LegFeeInput {
            instrument_name: "BTC-TEST".into(),
            side: ComboSide::Buy,
            settlement: SettlementCurrency::Usdc,
            role: FillRole::Taker,
            option_price: dec!(500),
            index_price: dec!(40000),
            contracts: Decimal::from(2),
            contract_size: Decimal::ONE,
            expiry: chrono::Utc::now(),
            is_daily: false,
        }],
        hold_to_expiry: false,
    };
    let breakdown = engine.compute(ctx).expect("fees");
    assert_eq!(breakdown.legs[0].trade_fee_native, dec!(24));
    assert_eq!(breakdown.legs[0].trade_fee_usd, dec!(24));
}

#[test]
fn combo_discount_waives_cheaper_side() {
    let engine = FeeEngine::new();
    let ctx = FeeComputationContext {
        legs: vec![
            LegFeeInput {
                instrument_name: "BTC-LOW".into(),
                side: ComboSide::Buy,
                settlement: SettlementCurrency::Usdc,
                role: FillRole::Taker,
                option_price: dec!(100),
                index_price: dec!(40000),
                contracts: Decimal::ONE,
                contract_size: Decimal::ONE,
                expiry: chrono::Utc::now(),
                is_daily: false,
            },
            LegFeeInput {
                instrument_name: "BTC-HIGH".into(),
                side: ComboSide::Sell,
                settlement: SettlementCurrency::Usdc,
                role: FillRole::Taker,
                option_price: dec!(200),
                index_price: dec!(40000),
                contracts: Decimal::ONE,
                contract_size: Decimal::ONE,
                expiry: chrono::Utc::now(),
                is_daily: false,
            },
        ],
        hold_to_expiry: false,
    };
    let breakdown = engine.compute(ctx).expect("fees");
    assert_eq!(breakdown.combo_discount_usd, dec!(12));
    assert_eq!(breakdown.legs[0].trade_fee_native, Decimal::ZERO);
}

#[test]
fn delivery_fee_cap_applies() {
    let engine = FeeEngine::new();
    let ctx = FeeComputationContext {
        legs: vec![LegFeeInput {
            instrument_name: "BTC-DEL".into(),
            side: ComboSide::Buy,
            settlement: SettlementCurrency::Usdc,
            role: FillRole::Taker,
            option_price: dec!(2000),
            index_price: dec!(50000),
            contracts: Decimal::from(3),
            contract_size: Decimal::ONE,
            expiry: chrono::Utc::now(),
            is_daily: false,
        }],
        hold_to_expiry: true,
    };
    let breakdown = engine.compute(ctx).expect("fees");
    assert!(breakdown.delivery_fee_usd > Decimal::ZERO);
    assert!(breakdown.delivery_fee_usd <= dec!(750));
}
