use anyhow::{Context, Result, anyhow};
use chrono::{TimeZone, Utc};
use owo_colors::OwoColorize;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, de::DeserializeOwned};
use std::collections::HashMap;
use std::time::{Duration, Instant};

const API_HOSTS: [&str; 2] = [
    "https://history.deribit.com/api/v2",
    "https://www.deribit.com/api/v2",
];
const INSTRUMENTS_PATH: &str = "/public/get_instruments";
const TRADES_PATH: &str = "/public/get_last_trades_by_instrument_and_time";

#[derive(Debug, Clone)]
struct Instrument {
    name: String,
    creation: u64,
    expiration: Option<u64>,
    strike: Option<f64>,
    option_type: Option<String>,
    settlement_period: Option<String>,
    base_currency: Option<String>,
    quote_currency: Option<String>,
    underlying_index: Option<String>,
}

#[derive(Deserialize)]
struct InstrumentsResponse {
    result: Vec<InstrumentRecord>,
}

#[derive(Deserialize)]
struct InstrumentRecord {
    instrument_name: String,
    creation_timestamp: u64,
    #[serde(default)]
    expiration_timestamp: Option<u64>,
    #[serde(default)]
    strike: Option<f64>,
    #[serde(default)]
    option_type: Option<String>,
    #[serde(default)]
    settlement_period: Option<String>,
    #[serde(default)]
    base_currency: Option<String>,
    #[serde(default)]
    quote_currency: Option<String>,
    #[serde(default)]
    underlying_index: Option<String>,
}

#[derive(Deserialize)]
struct TradesResponse {
    result: TradesResult,
}

#[derive(Deserialize)]
struct TradesResult {
    trades: Vec<Trade>,
}

#[derive(Debug, Clone, Deserialize)]
struct Trade {
    #[serde(default)]
    trade_id: Option<String>,
    #[serde(default)]
    direction: Option<String>,
    #[serde(default)]
    price: Option<f64>,
    #[serde(default)]
    amount: Option<f64>,
    #[serde(default)]
    timestamp: Option<u64>,
}

/// Find the oldest ETH option instrument with recorded trades and print a summary.
#[tokio::main]
async fn main() -> Result<()> {
    let client = Client::new();

    let instruments = fetch_all_instruments(&client).await?;
    let mut instruments: Vec<_> = instruments.into_values().collect();
    instruments.sort_by_key(|inst| inst.creation);

    if instruments.is_empty() {
        return Err(anyhow!(
            "no ETH option instruments found from either Deribit host"
        ));
    }

    println!(
        "{} {}",
        "Total unique expired ETH options discovered:"
            .bold()
            .bright_white(),
        instruments.len().to_string().bold().cyan()
    );

    let mut attempts_logged = 0usize;

    for instrument in instruments {
        // Avoid spamming output by only logging the first few probes.
        if attempts_logged < 3 {
            println!(
                "{} {} {} {}",
                "Probing instrument".bold().blue(),
                instrument.name.as_str().cyan(),
                "created".dimmed(),
                format_timestamp(instrument.creation).dimmed()
            );
            attempts_logged += 1;
            if attempts_logged == 3 {
                println!(
                    "{}",
                    "Further instrument probes suppressed until trades are found..."
                        .italic()
                        .dimmed()
                );
            }
        }

        match fetch_oldest_trades(&client, &instrument.name).await? {
            Some(trades) if !trades.is_empty() => {
                let creation_iso = format_timestamp(instrument.creation);
                let expiration_iso = instrument
                    .expiration
                    .map(|ts| format_timestamp(ts).bright_white().to_string())
                    .unwrap_or_else(|| "unknown".dimmed().to_string());
                let strike_value = instrument
                    .strike
                    .map(|s| format!("{s:.2}").yellow().bold().to_string())
                    .unwrap_or_else(|| "N/A".dimmed().to_string());
                let option_type = instrument
                    .option_type
                    .as_deref()
                    .map(|t| match t {
                        "call" | "C" => "CALL".green().bold().to_string(),
                        "put" | "P" => "PUT".red().bold().to_string(),
                        other => other.cyan().to_string(),
                    })
                    .unwrap_or_else(|| "unknown".dimmed().to_string());
                let settlement = instrument
                    .settlement_period
                    .as_deref()
                    .map(|p| p.cyan().to_string())
                    .unwrap_or_else(|| "unknown".dimmed().to_string());
                let underlying = instrument
                    .underlying_index
                    .as_deref()
                    .map(|u| u.bright_white().to_string())
                    .unwrap_or_else(|| "unknown".dimmed().to_string());
                let base_currency = instrument.base_currency.as_deref().unwrap_or("?");
                let quote_currency = instrument.quote_currency.as_deref().unwrap_or("?");

                println!();
                println!(
                    "{}",
                    "Earliest ETH option with recorded trades:"
                        .bold()
                        .bright_green()
                );
                println!(
                    "{} {}",
                    "Instrument:".bold(),
                    instrument.name.as_str().bright_cyan().bold()
                );
                println!(
                    "{} {} ({} {})",
                    "Creation:".bold(),
                    creation_iso.bright_white(),
                    instrument.creation,
                    "ms since epoch".dimmed()
                );
                println!("{} {}", "Expiration:".bold(), expiration_iso);
                println!("{} {}", "Strike:".bold(), strike_value);
                println!("{} {}", "Option Type:".bold(), option_type);
                println!("{} {}", "Settlement:".bold(), settlement);
                println!(
                    "{} {}/{}",
                    "Quote/Base:".bold(),
                    quote_currency.yellow(),
                    base_currency.yellow()
                );
                println!("{} {}", "Underlying:".bold(), underlying);

                println!();
                println!("{}", "Oldest trades:".underline().bold());
                for trade in trades.iter().take(10) {
                    print_trade(trade, &instrument);
                }
                return Ok(());
            }
            _ => {}
        }
    }

    println!(
        "{}",
        "Unable to locate any ETH option with recorded trades via the public API."
            .red()
            .bold()
    );
    Ok(())
}

/// Retrieve instruments from both Deribit hosts and deduplicate by name while preserving the earliest creation timestamp.
async fn fetch_all_instruments(client: &Client) -> Result<HashMap<String, Instrument>> {
    let mut instruments: HashMap<String, Instrument> = HashMap::new();

    for host in API_HOSTS {
        match fetch_instruments_from_host(client, host).await {
            Ok(host_instruments) => {
                println!(
                    "{} {} {} {}",
                    "Fetched".bold().blue(),
                    host_instruments.len().to_string().bold().cyan(),
                    "expired ETH options metadata from".dimmed(),
                    host.cyan()
                );
                for inst in host_instruments {
                    instruments
                        .entry(inst.name.clone())
                        .and_modify(|existing| {
                            existing.creation = existing.creation.min(inst.creation)
                        })
                        .or_insert(inst);
                }
            }
            Err(err) => eprintln!(
                "{}",
                format!("Warning: failed to fetch instruments from {host}: {err}")
                    .bold()
                    .red()
            ),
        }
    }

    Ok(instruments)
}

/// Fetch all expired ETH option instruments from a specific host.
async fn fetch_instruments_from_host(client: &Client, host: &str) -> Result<Vec<Instrument>> {
    let query = [("currency", "ETH"), ("kind", "option"), ("expired", "true")];
    let context = format!("instrument request to {host}");
    let response: InstrumentsResponse =
        get_json(client, host, INSTRUMENTS_PATH, &query, context.as_str()).await?;

    Ok(response
        .result
        .into_iter()
        .map(|record| Instrument {
            name: record.instrument_name,
            creation: record.creation_timestamp,
            expiration: record.expiration_timestamp,
            strike: record.strike,
            option_type: record.option_type,
            settlement_period: record.settlement_period,
            base_currency: record.base_currency,
            quote_currency: record.quote_currency,
            underlying_index: record.underlying_index,
        })
        .collect())
}

/// Attempt to obtain the oldest recorded trades for an instrument across available hosts.
async fn fetch_oldest_trades(client: &Client, instrument_name: &str) -> Result<Option<Vec<Trade>>> {
    for host in API_HOSTS {
        match fetch_trades_from_host(client, host, instrument_name).await {
            Ok(trades) if !trades.is_empty() => return Ok(Some(trades)),
            Ok(_) => continue,
            Err(err) => eprintln!(
                "{}",
                format!("Warning: failed to fetch trades for {instrument_name} from {host}: {err}")
                    .bold()
                    .red()
            ),
        }
    }

    Ok(None)
}

/// Fetch trades for a specific instrument from a single host.
async fn fetch_trades_from_host(
    client: &Client,
    host: &str,
    instrument_name: &str,
) -> Result<Vec<Trade>> {
    let query = [
        ("instrument_name", instrument_name),
        ("start_timestamp", "0"),
        ("count", "100"),
        ("include_oldest", "true"),
    ];
    let context = format!("trades request for {instrument_name} via {host}");
    let response: TradesResponse =
        get_json(client, host, TRADES_PATH, &query, context.as_str()).await?;

    Ok(response.result.trades)
}

/// Issue a GET request, log timing details, and deserialize the JSON payload into the requested type.
async fn get_json<T>(
    client: &Client,
    host: &str,
    path: &str,
    query: &[(&str, &str)],
    context: &str,
) -> Result<T>
where
    T: DeserializeOwned,
{
    let url = format!("{host}{path}");

    let start = Instant::now();
    let request = client.get(&url).query(&query);
    let response_result = request.send().await;
    let elapsed = start.elapsed();
    let query_repr = format!("{:?}", query);

    match &response_result {
        Ok(resp) => {
            let status = resp.status();
            let line = format!(
                "{} {} params {} -> {} {}",
                "HTTP GET".bold().blue(),
                url.cyan(),
                format!("{}", query_repr.dimmed()),
                color_status(status),
                color_duration(elapsed)
            );
            println!("{}", line);
        }
        Err(err) => {
            let line = format!(
                "{} {} params {} -> {} {}",
                "HTTP GET".bold().red(),
                url.cyan(),
                format!("{}", query_repr.dimmed()),
                format!("{}", format!("transport error ({err})").bold().red()),
                color_duration(elapsed)
            );
            println!("{}", line);
        }
    }

    let response = response_result.with_context(|| format!("{context}: sending request failed"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(anyhow!("{context}: non-success status {status}"));
    }

    let parse_start = Instant::now();
    let payload = response
        .json::<T>()
        .await
        .with_context(|| format!("{context}: parsing response body"))?;
    println!(
        "{} {} {}",
        "Decoded JSON".dimmed(),
        url.cyan(),
        color_duration(parse_start.elapsed())
    );

    Ok(payload)
}

fn color_status(status: StatusCode) -> String {
    let code = status.as_str();
    if status.is_success() {
        format!("{}", code.green().bold())
    } else if status.is_redirection() {
        format!("{}", code.blue())
    } else if status.is_client_error() {
        format!("{}", code.yellow().bold())
    } else if status.is_server_error() {
        format!("{}", code.red().bold())
    } else {
        format!("{}", code.cyan())
    }
}

fn color_duration(duration: Duration) -> String {
    let base = format!("in {:.2?}", duration);
    let millis = duration.as_millis();
    if millis >= 1_000 {
        format!("{}", base.red().bold())
    } else if millis >= 200 {
        format!("{}", base.yellow().bold())
    } else {
        format!("{}", base.green())
    }
}

/// Print a compact human-readable view of a trade entry, enriched with instrument metadata.
fn print_trade(trade: &Trade, instrument: &Instrument) {
    let trade_id = trade.trade_id.as_deref().unwrap_or("<unknown>");
    let price = trade.price.unwrap_or(f64::NAN);
    let amount = trade.amount.unwrap_or(f64::NAN);
    let timestamp = trade.timestamp.unwrap_or(0);

    let price_text = if price.is_nan() {
        "NaN".to_string()
    } else {
        format!("{price:.8}")
    };
    let amount_text = if amount.is_nan() {
        "NaN".to_string()
    } else {
        format!("{amount:.4}")
    };

    let price_display = if price.is_nan() {
        format!("{}", price_text.as_str().yellow().italic())
    } else {
        format!("{}", price_text.as_str().green())
    };

    let amount_display = if amount.is_nan() {
        format!("{}", amount_text.as_str().yellow().italic())
    } else {
        format!("{}", amount_text.as_str().blue())
    };

    let direction_display = match trade.direction.as_deref() {
        Some("buy") => format!("{}", "buy".green().bold()),
        Some("sell") => format!("{}", "sell".red().bold()),
        Some(other) => format!("{}", other.cyan()),
        None => format!("{}", "<unknown>".dimmed()),
    };

    let strike_display = instrument
        .strike
        .map(|s| format!("{}", format!("{s:.2}").yellow()))
        .unwrap_or_else(|| format!("{}", "N/A".dimmed()));
    let expiration_display = instrument
        .expiration
        .map(|ts| format!("{}", format_timestamp(ts).bright_white()))
        .unwrap_or_else(|| format!("{}", "unknown".dimmed()));
    let option_type_display = instrument
        .option_type
        .as_deref()
        .map(|t| match t {
            "call" | "C" => format!("{}", "CALL".green().bold()),
            "put" | "P" => format!("{}", "PUT".red().bold()),
            other => format!("{}", other.cyan()),
        })
        .unwrap_or_else(|| format!("{}", "?".dimmed()));

    let trade_id_display = format!("{}", format!("- {}", trade_id).bright_magenta());
    let timestamp_display = format!("{}", format_timestamp(timestamp).dimmed());
    let price_label = format!("{}", "price".dimmed());
    let amount_label = format!("{}", "amount".dimmed());
    let strike_label = format!("{}", "strike".dimmed());
    let maturity_label = format!("{}", "maturity".dimmed());
    let type_label = format!("{}", "type".dimmed());

    let line = format!(
        "{trade_id_display} | {timestamp_display} | {price_label} {price_display} | {amount_label} {amount_display} | {direction_display} | {strike_label} {strike_display} | {maturity_label} {expiration_display} | {type_label} {option_type_display}",
    );

    println!("{}", line);
}

/// Convert a Deribit millisecond timestamp into an ISO-8601 string for readability.
fn format_timestamp(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let nanos = ((ms % 1000) * 1_000_000) as u32;

    Utc.timestamp_opt(secs, nanos)
        .single()
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| ms.to_string())
}
