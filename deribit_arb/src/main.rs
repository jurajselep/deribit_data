use anyhow::Result;
use clap::Parser;
use deribit_arb::chain::OptionChain;
use deribit_arb::client::{DeribitCredentials, DeribitHttpClient};
use deribit_arb::config::{AppConfig, Cli};
use deribit_arb::detect::DetectorSuite;
use deribit_arb::exec::ExecutionPlanner;
use deribit_arb::model::SettlementCurrency;
use deribit_arb::render;
use deribit_arb::risk::RiskManager;
use tokio::time::{sleep, Duration};
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    let subscriber = tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse()?))
        .finish();
    tracing::subscriber::set_global_default(subscriber)?;

    let cli = Cli::parse();
    let config = AppConfig::from_cli(cli)?;

    let credentials = match (config.api_key.clone(), config.api_secret.clone()) {
        (Some(id), Some(secret)) => Some(DeribitCredentials {
            client_id: id,
            client_secret: secret,
        }),
        _ => None,
    };

    let http_client = DeribitHttpClient::new(config.environment, credentials);
    let chain = OptionChain::new();

    {
        let chain_for_status = chain.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(5));
            loop {
                ticker.tick().await;
                let stats = chain_for_status.stats();
                info!(
                    target: "scan.stats",
                    tot = stats.instrument_count,
                    quotes = stats.instruments_with_quotes,
                    fresh = stats.instruments_fresh_10s,
                    bid = stats.bid_levels,
                    ask = stats.ask_levels
                );
            }
        });
    }

    for currency in &config.currencies {
        info!(target: "discover", currency = %currency, "loading instruments");
        let instruments = http_client.get_instruments(&currency.to_string()).await?;
        for instrument in instruments {
            chain.upsert_instrument(instrument.clone());
            if instrument.settlement_currency == SettlementCurrency::Usdc
                && !config.settlements.contains(&SettlementCurrency::Usdc)
            {
                continue;
            }
            if instrument.settlement_currency == SettlementCurrency::Coin
                && !config.settlements.contains(&SettlementCurrency::Coin)
            {
                continue;
            }
            let quote = http_client
                .get_ticker(&instrument.instrument_name)
                .await
                .map_err(|e| {
                    error!(target: "ticker", instrument = %instrument.instrument_name, error = %e, "failed to load ticker");
                    e
                })?;
            chain.update_quote(&instrument.instrument_name, quote);
            // Light pacing to respect API rate limits on discovery burst
            sleep(Duration::from_millis(25)).await;
        }
    }

    let snapshot = chain.snapshot();
    let detector = DetectorSuite::new(&config);
    let opportunities = detector.scan(&snapshot.instruments);

    if opportunities.is_empty() {
        info!(target: "scan", "no actionable opportunities at this snapshot");
        return Ok(());
    }

    render::print_table(&opportunities, 10)?;

    let risk = RiskManager::new();
    let planner = ExecutionPlanner::new(&http_client, &config);

    for opportunity in opportunities.iter().take(3) {
        if !risk.approve(&config, opportunity) {
            continue;
        }
        match planner.plan(opportunity).await {
            Ok(report) => {
                info!(
                    target: "execution.preview",
                    combo = ?report.combo_id,
                    submitted = report.submitted,
                    "generated execution plan"
                );
            }
            Err(err) => {
                error!(target: "execution", error = %err, "failed to prepare execution plan");
            }
        }
        risk.release();
    }

    Ok(())
}
