use crate::model::{StrategyKind, StrategyOpportunity};
use anyhow::Result;
use comfy_table::{presets::UTF8_BORDERS_ONLY, Cell, Table};
use csv::Writer;
use rust_decimal::Decimal;
use std::fs::File;
use std::path::Path;
use tracing::info;

pub fn print_table(opportunities: &[StrategyOpportunity], limit: usize) -> Result<()> {
    let mut table = Table::new();
    table.load_preset(UTF8_BORDERS_ONLY);
    table.set_header(vec![
        "Strategy",
        "Ccy",
        "Settlement",
        "Expiry",
        "Strikes",
        "Leg Count",
        "Legs",
        "Touch Prices",
        "Notional ($)",
        "Net Edge ($)",
        "Fees ($)",
        "Edge bps",
    ]);

    for opp in opportunities.iter().take(limit) {
        let legs_desc = opp
            .legs
            .iter()
            .map(|leg| format!("{}:{}@{}", leg.side, leg.instrument_name, leg.ratio))
            .collect::<Vec<_>>()
            .join(" ");
        let price_desc = if opp.touches.is_empty() {
            "-".to_string()
        } else {
            opp.touches
                .iter()
                .map(|touch| {
                    format!(
                        "{}:{}@{} ({}c)",
                        touch.side,
                        touch.instrument_name,
                        format_decimal(touch.price),
                        format_decimal(touch.size_contracts)
                    )
                })
                .collect::<Vec<_>>()
                .join(" ")
        };
        let expiries = opp
            .expiry
            .iter()
            .map(|dt| dt.format("%Y-%m-%d").to_string())
            .collect::<Vec<_>>()
            .join("/");
        let strikes = opp
            .strikes
            .iter()
            .map(|s| s.normalize().to_string())
            .collect::<Vec<_>>()
            .join("/");
        table.add_row(vec![
            Cell::new(format_strategy(opp.strategy)),
            Cell::new(opp.currency.to_string()),
            Cell::new(opp.settlement.to_string()),
            Cell::new(expiries),
            Cell::new(strikes),
            Cell::new(opp.legs.len().to_string()),
            Cell::new(legs_desc),
            Cell::new(price_desc),
            Cell::new(format_decimal(opp.notional_usd)),
            Cell::new(format_decimal(opp.net_edge_usd)),
            Cell::new(format_decimal(opp.fee_breakdown.total_usd)),
            Cell::new(format!("{:.2}", opp.edge_bps)),
        ]);
    }

    println!("{}", table);
    Ok(())
}

pub fn export_csv<P: AsRef<Path>>(opportunities: &[StrategyOpportunity], path: P) -> Result<()> {
    let mut writer = Writer::from_writer(File::create(path)?);
    writer.write_record([
        "strategy",
        "currency",
        "settlement",
        "expiry",
        "strikes",
        "leg_count",
        "touch_prices",
        "net_edge_usd",
        "notional_usd",
        "fees_usd",
        "size_contracts",
    ])?;
    for opp in opportunities {
        let expiry = opp
            .expiry
            .iter()
            .map(|dt| dt.to_rfc3339())
            .collect::<Vec<_>>()
            .join("/");
        let strikes = opp
            .strikes
            .iter()
            .map(|s| s.normalize().to_string())
            .collect::<Vec<_>>()
            .join("/");
        let record = vec![
            format_strategy(opp.strategy).to_string(),
            opp.currency.to_string(),
            opp.settlement.to_string(),
            expiry,
            strikes,
            opp.legs.len().to_string(),
            if opp.touches.is_empty() {
                "-".to_string()
            } else {
                opp.touches
                    .iter()
                    .map(|touch| {
                        format!(
                            "{}:{}@{}",
                            touch.side,
                            touch.instrument_name,
                            touch.price.normalize()
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(" ")
            },
            opp.net_edge_usd.normalize().to_string(),
            opp.notional_usd.normalize().to_string(),
            opp.fee_breakdown.total_usd.normalize().to_string(),
            opp.size_contracts.normalize().to_string(),
        ];
        writer.write_record(record)?;
    }
    writer.flush()?;
    info!(target: "export.csv", "wrote opportunities to disk");
    Ok(())
}

fn format_strategy(strategy: StrategyKind) -> &'static str {
    match strategy {
        StrategyKind::Vertical => "Vertical",
        StrategyKind::Butterfly => "Butterfly",
        StrategyKind::Calendar => "Calendar",
        StrategyKind::Box => "Box",
        StrategyKind::StaleQuote => "Stale",
        StrategyKind::JellyRoll => "Jelly Roll",
    }
}

fn format_decimal(value: Decimal) -> String {
    if value.abs() < Decimal::new(1, 2) {
        format!("{:.4}", value)
    } else {
        format!("{:.2}", value)
    }
}
