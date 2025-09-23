use deribit_arb::config::{AppConfig, Environment};
use deribit_arb::exec::{ExecutionPlanner, MockComboApi};
use deribit_arb::model::{
    ComboExecutionPlan, ComboLeg, ComboSide, Currency, FeeBreakdown, FillRole, LegFee,
    OrderTimeInForce, SettlementCurrency, StrategyKind, StrategyOpportunity,
};
use rust_decimal::Decimal;
use rust_decimal_macros::dec;

fn base_config() -> AppConfig {
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
        strategy_filter: deribit_arb::model::StrategyFilter {
            include: vec![StrategyKind::Vertical],
        },
        max_concurrent_combos: 3,
        min_depth_contracts: 1,
    }
}

fn sample_opportunity(size: Decimal) -> StrategyOpportunity {
    StrategyOpportunity {
        strategy: StrategyKind::Vertical,
        currency: Currency::BTC,
        settlement: SettlementCurrency::Usdc,
        expiry: vec![chrono::Utc::now()],
        strikes: vec![dec!(40000), dec!(45000)],
        legs: vec![
            ComboLeg {
                instrument_name: "BTC-25DEC24-40000-C".into(),
                ratio: 1,
                side: ComboSide::Buy,
            },
            ComboLeg {
                instrument_name: "BTC-25DEC24-45000-C".into(),
                ratio: 1,
                side: ComboSide::Sell,
            },
        ],
        touches: vec![],
        total_cost: dec!(100),
        max_payout: dec!(5000),
        fee_breakdown: FeeBreakdown {
            legs: vec![
                LegFee {
                    instrument_name: "BTC-25DEC24-40000-C".into(),
                    side: ComboSide::Buy,
                    settlement: SettlementCurrency::Usdc,
                    execution_role: FillRole::Taker,
                    trade_fee_native: Decimal::ONE,
                    trade_fee_usd: Decimal::ONE,
                },
                LegFee {
                    instrument_name: "BTC-25DEC24-45000-C".into(),
                    side: ComboSide::Sell,
                    settlement: SettlementCurrency::Usdc,
                    execution_role: FillRole::Taker,
                    trade_fee_native: Decimal::ONE,
                    trade_fee_usd: Decimal::ONE,
                },
            ],
            combo_discount: Decimal::ZERO,
            combo_discount_usd: Decimal::ZERO,
            delivery_fee: Decimal::ZERO,
            delivery_fee_usd: Decimal::ZERO,
            total_native: dec!(2),
            total_usd: dec!(2),
        },
        net_edge_native: dec!(100),
        net_edge_usd: dec!(100),
        notional_usd: dec!(10000),
        reference_index: dec!(40000),
        edge_bps: 10.0,
        size_contracts: size,
        execution_plan: ComboExecutionPlan {
            create_payload: serde_json::json!({ "legs": [] }),
            tif: OrderTimeInForce::IOC,
            price_limit: dec!(100),
            dry_run: true,
        },
    }
}

#[tokio::test]
async fn planner_generates_preview() {
    let config = base_config();
    let mock = MockComboApi::new();
    let planner = ExecutionPlanner::new(&mock, &config);
    let report = planner
        .plan(&sample_opportunity(Decimal::from(2)))
        .await
        .expect("plan success");
    assert!(report.preview.is_some());
    assert!(!report.submitted);
}

#[tokio::test]
async fn planner_rejects_insufficient_depth() {
    let config = base_config();
    let mock = MockComboApi::new();
    let planner = ExecutionPlanner::new(&mock, &config);
    let result = planner.plan(&sample_opportunity(Decimal::new(5, 1))).await;
    assert!(result.is_err());
}
