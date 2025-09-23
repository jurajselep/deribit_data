use deribit_arb::config::{AppConfig, Environment};
use deribit_arb::detect::DetectorSuite;
use deribit_arb::model::{
    Currency, Instrument, InstrumentSnapshot, OptionKind, ParsedInstrumentName, Quote, QuoteLevel,
    SettlementCurrency, StrategyFilter, StrategyKind,
};
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use std::str::FromStr;

fn base_config(strategies: Vec<StrategyKind>) -> AppConfig {
    AppConfig {
        environment: Environment::Testnet,
        api_key: None,
        api_secret: None,
        currencies: vec![Currency::BTC],
        settlements: vec![SettlementCurrency::Usdc],
        dry_run: true,
        max_ticket_usd: dec!(20000),
        min_edge_usd: dec!(50),
        min_edge_ratio: 1.5,
        hold_to_expiry: false,
        strategy_filter: StrategyFilter {
            include: strategies,
        },
        max_concurrent_combos: 3,
        min_depth_contracts: 1,
    }
}

fn build_snapshot(
    name: &str,
    strike: Decimal,
    option_kind: OptionKind,
    best_bid: (Decimal, Decimal),
    best_ask: (Decimal, Decimal),
) -> InstrumentSnapshot {
    let expiry = ParsedInstrumentName::from_str(name)
        .ok()
        .and_then(|parsed| parsed.expiry_date().ok())
        .unwrap_or_else(|| chrono::Utc::now() + chrono::Duration::days(30));
    InstrumentSnapshot {
        instrument: Instrument {
            instrument_name: name.to_string(),
            currency: Currency::BTC,
            is_usdc_settled: true,
            is_combo: false,
            option_kind,
            strike,
            expiry,
            contract_size: Decimal::ONE,
            settlement_currency: SettlementCurrency::Usdc,
            tick_size: dec!(0.1),
            min_trade_amount: Decimal::ONE,
        },
        quote: Quote {
            best_bid: Some(QuoteLevel {
                price: best_bid.0,
                amount: best_bid.1,
            }),
            best_ask: Some(QuoteLevel {
                price: best_ask.0,
                amount: best_ask.1,
            }),
            mark_iv: None,
            bid_iv: None,
            ask_iv: None,
            interest_rate: None,
            timestamp: chrono::Utc::now(),
            index_price: dec!(40000),
        },
        order_book: None,
    }
}

#[test]
fn detects_profitable_vertical() {
    let config = base_config(vec![StrategyKind::Vertical]);
    let suite = DetectorSuite::new(&config);
    let low = build_snapshot(
        "BTC-25DEC24-40000-C",
        dec!(40000),
        OptionKind::Call,
        (dec!(5800), dec!(10)),
        (dec!(6000), dec!(10)),
    );
    let high = build_snapshot(
        "BTC-25DEC24-45000-C",
        dec!(45000),
        OptionKind::Call,
        (dec!(5400), dec!(10)),
        (dec!(5600), dec!(10)),
    );
    let snapshot = vec![low, high];
    let opportunities = suite.scan(&snapshot);
    assert!(opportunities
        .iter()
        .any(|opp| opp.strategy == StrategyKind::Vertical));
}

#[test]
fn detects_calendar_credit() {
    let config = base_config(vec![StrategyKind::Calendar]);
    let suite = DetectorSuite::new(&config);
    let near = build_snapshot(
        "BTC-25DEC24-40000-C",
        dec!(40000),
        OptionKind::Call,
        (dec!(1600), dec!(10)),
        (dec!(1700), dec!(10)),
    );
    let far = build_snapshot(
        "BTC-25JAN25-40000-C",
        dec!(40000),
        OptionKind::Call,
        (dec!(1100), dec!(10)),
        (dec!(1300), dec!(10)),
    );
    let snapshot = vec![near, far];
    let opportunities = suite.scan(&snapshot);
    assert!(opportunities
        .iter()
        .any(|opp| opp.strategy == StrategyKind::Calendar));
}

#[test]
fn calendar_same_expiry_mixed_types_rejected() {
    let config = base_config(vec![StrategyKind::Calendar]);
    let suite = DetectorSuite::new(&config);
    let call_leg = build_snapshot(
        "ETH-27MAR26-12000-C",
        dec!(12000),
        OptionKind::Call,
        (dec!(1.5), dec!(10)),
        (dec!(1.6), dec!(10)),
    );
    let put_leg = build_snapshot(
        "ETH-27MAR26-12000-P",
        dec!(12000),
        OptionKind::Put,
        (dec!(1.5), dec!(10)),
        (dec!(1.6), dec!(10)),
    );
    let opportunities = suite.scan(&[call_leg, put_leg]);
    assert!(opportunities
        .iter()
        .all(|opp| opp.strategy != StrategyKind::Calendar));
}

#[test]
fn detects_free_butterfly() {
    let config = base_config(vec![StrategyKind::Butterfly]);
    let suite = DetectorSuite::new(&config);
    let low = build_snapshot(
        "BTC-25DEC24-38000-C",
        dec!(38000),
        OptionKind::Call,
        (dec!(700), dec!(10)),
        (dec!(900), dec!(10)),
    );
    let mid = build_snapshot(
        "BTC-25DEC24-40000-C",
        dec!(40000),
        OptionKind::Call,
        (dec!(2200), dec!(10)),
        (dec!(2300), dec!(10)),
    );
    let high = build_snapshot(
        "BTC-25DEC24-42000-C",
        dec!(42000),
        OptionKind::Call,
        (dec!(800), dec!(10)),
        (dec!(1000), dec!(10)),
    );
    let snapshot = vec![low, mid, high];
    let opportunities = suite.scan(&snapshot);
    assert!(opportunities
        .iter()
        .any(|opp| opp.strategy == StrategyKind::Butterfly));
}

#[test]
fn detects_box_parity_gap() {
    let config = base_config(vec![StrategyKind::Box]);
    let suite = DetectorSuite::new(&config);
    let call_low = build_snapshot(
        "BTC-25DEC24-40000-C",
        dec!(40000),
        OptionKind::Call,
        (dec!(1800), dec!(10)),
        (dec!(2000), dec!(10)),
    );
    let call_high = build_snapshot(
        "BTC-25DEC24-45000-C",
        dec!(45000),
        OptionKind::Call,
        (dec!(1500), dec!(10)),
        (dec!(1700), dec!(10)),
    );
    let put_low = build_snapshot(
        "BTC-25DEC24-40000-P",
        dec!(40000),
        OptionKind::Put,
        (dec!(1500), dec!(10)),
        (dec!(1700), dec!(10)),
    );
    let put_high = build_snapshot(
        "BTC-25DEC24-45000-P",
        dec!(45000),
        OptionKind::Put,
        (dec!(1800), dec!(10)),
        (dec!(2000), dec!(10)),
    );
    let snapshot = vec![call_low, call_high, put_low, put_high];
    let opportunities = suite.scan(&snapshot);
    assert!(opportunities
        .iter()
        .any(|opp| opp.strategy == StrategyKind::Box));
}

#[test]
fn detects_jelly_roll_credit() {
    let config = base_config(vec![StrategyKind::JellyRoll]);
    let suite = DetectorSuite::new(&config);
    let near_call = build_snapshot(
        "BTC-25DEC24-40000-C",
        dec!(40000),
        OptionKind::Call,
        (dec!(4.0), dec!(5)),
        (dec!(5.0), dec!(5)),
    );
    let near_put = build_snapshot(
        "BTC-25DEC24-40000-P",
        dec!(40000),
        OptionKind::Put,
        (dec!(150.0), dec!(5)),
        (dec!(151.0), dec!(5)),
    );
    let far_call = build_snapshot(
        "BTC-25MAR25-40000-C",
        dec!(40000),
        OptionKind::Call,
        (dec!(10.0), dec!(5)),
        (dec!(11.0), dec!(5)),
    );
    let far_put = build_snapshot(
        "BTC-25MAR25-40000-P",
        dec!(40000),
        OptionKind::Put,
        (dec!(4.0), dec!(5)),
        (dec!(5.0), dec!(5)),
    );
    let snapshot = vec![near_call, near_put, far_call, far_put];
    let opportunities = suite.scan(&snapshot);
    assert!(opportunities
        .iter()
        .any(|opp| opp.strategy == StrategyKind::JellyRoll));
}
