use anyhow::{Context, Result, anyhow};
use chrono::{TimeZone, Utc};
use owo_colors::OwoColorize;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::from_slice;
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
    #[serde(default)]
    has_more: Option<bool>,
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

#[derive(Clone, Debug)]
struct RequestStats {
    total_elapsed: Duration,
    bytes: usize,
}

struct FetchResult<T> {
    data: T,
    stats: RequestStats,
}

struct TradeFetch {
    trades: Vec<Trade>,
    has_more: Option<bool>,
    stats: RequestStats,
    host: String,
}

#[derive(Clone)]
struct TradeSample {
    instrument: String,
    host: String,
    trades: usize,
    has_more: Option<bool>,
    stats: RequestStats,
}

/// Find the oldest ETH option instrument with recorded trades and print a summary.
#[tokio::main]
async fn main() -> Result<()> {
    let client = Client::new();

    let instruments_map = fetch_all_instruments(&client).await?;
    let mut instrument_list: Vec<_> = instruments_map.into_values().collect();
    instrument_list.sort_by_key(|inst| inst.creation);

    if instrument_list.is_empty() {
        return Err(anyhow!(
            "no ETH option instruments found from either Deribit host"
        ));
    }

    let total_instruments = instrument_list.len();

    println!(
        "{} {}",
        "Total unique expired ETH options discovered:"
            .bold()
            .bright_white(),
        total_instruments.to_string().bold().cyan()
    );

    let mut attempts_logged = 0usize;
    let mut trade_samples: Vec<TradeSample> = Vec::new();

    for instrument in &instrument_list {
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

        match fetch_oldest_trades(&client, &instrument.name, &mut trade_samples).await? {
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
                print_estimation(total_instruments, &trade_samples);
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
    print_estimation(total_instruments, &trade_samples);
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
    let FetchResult { data: response, .. }: FetchResult<InstrumentsResponse> =
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
async fn fetch_oldest_trades(
    client: &Client,
    instrument_name: &str,
    samples: &mut Vec<TradeSample>,
) -> Result<Option<Vec<Trade>>> {
    for host in API_HOSTS {
        match fetch_trades_from_host(client, host, instrument_name).await {
            Ok(fetch) => {
                samples.push(TradeSample {
                    instrument: instrument_name.to_string(),
                    host: fetch.host.clone(),
                    trades: fetch.trades.len(),
                    has_more: fetch.has_more,
                    stats: fetch.stats.clone(),
                });

                if !fetch.trades.is_empty() {
                    return Ok(Some(fetch.trades));
                }
            }
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
) -> Result<TradeFetch> {
    let query = [
        ("instrument_name", instrument_name),
        ("start_timestamp", "0"),
        ("count", "100"),
        ("include_oldest", "true"),
    ];
    let context = format!("trades request for {instrument_name} via {host}");
    let FetchResult {
        data: response,
        stats,
    }: FetchResult<TradesResponse> =
        get_json(client, host, TRADES_PATH, &query, context.as_str()).await?;

    let TradesResponse { result } = response;

    Ok(TradeFetch {
        trades: result.trades,
        has_more: result.has_more,
        stats,
        host: host.to_string(),
    })
}

/// Issue a GET request, log timing details, and deserialize the JSON payload into the requested type.
async fn get_json<T>(
    client: &Client,
    host: &str,
    path: &str,
    query: &[(&str, &str)],
    context: &str,
) -> Result<FetchResult<T>>
where
    T: DeserializeOwned,
{
    let url = format!("{host}{path}");

    let start = Instant::now();
    let request = client.get(&url).query(&query);
    let response_result = request.send().await;
    let query_repr = format!("{:?}", query);

    if let Err(err) = &response_result {
        let elapsed = start.elapsed();
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

    let response = response_result.with_context(|| format!("{context}: sending request failed"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(anyhow!("{context}: non-success status {status}"));
    }

    let body_start = Instant::now();
    let raw_body = response
        .bytes()
        .await
        .with_context(|| format!("{context}: reading response body"))?;
    let body_elapsed = body_start.elapsed();

    let parse_start = Instant::now();
    let payload =
        from_slice::<T>(&raw_body).with_context(|| format!("{context}: parsing response body"))?;
    let parse_elapsed = parse_start.elapsed();

    let total_elapsed = start.elapsed();
    let bytes = raw_body.len();
    let stats = RequestStats {
        total_elapsed,
        bytes,
    };

    let line = format!(
        "{} {} params {} -> {} {} {}",
        "HTTP GET".bold().blue(),
        url.cyan(),
        format!("{}", query_repr.dimmed()),
        color_status(status),
        color_duration(total_elapsed),
        format!("{}", format!("{} bytes", bytes).dimmed())
    );
    println!("{}", line);

    println!(
        "{} {} {} {}",
        "Decoded JSON".dimmed(),
        url.cyan(),
        color_duration(body_elapsed + parse_elapsed),
        format!("{}", format!("parse {:.2?}", parse_elapsed).dimmed())
    );

    Ok(FetchResult {
        data: payload,
        stats,
    })
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

fn print_estimation(total_instruments: usize, samples: &[TradeSample]) {
    if total_instruments == 0 {
        return;
    }

    match estimate_download_requirements(total_instruments, samples) {
        Some(summary) => {
            println!();
            println!(
                "{} {}",
                "Estimated requests:".bold().bright_white(),
                format!("{:.0}", summary.total_requests).bold().cyan()
            );
            println!(
                "{} {} (~{:.1} min)",
                "Estimated download time:".bold().bright_white(),
                format_duration(summary.total_time_secs).bold().green(),
                summary.total_time_secs / 60.0
            );
            println!(
                "{} {} ({:.2} MB)",
                "Estimated data volume:".bold().bright_white(),
                human_bytes(summary.total_bytes).bold().yellow(),
                summary.total_bytes / (1024.0 * 1024.0)
            );
            if let Some(host) = &summary.dominant_host {
                println!(
                    "{} {}",
                    "Likely primary host:".bold().bright_white(),
                    host.cyan()
                );
            }
            println!(
                "{} {}",
                "Assumptions:".bold().dimmed(),
                format!(
                    "{} samples; {:.1}% instruments returned trades; {:.1}% required pagination (count=100)",
                    summary.sample_size,
                    summary.positive_ratio * 100.0,
                    summary.has_more_ratio * 100.0
                )
                .dimmed()
            );
        }
        None => {
            if !samples.is_empty() {
                println!(
                    "{}",
                    "Insufficient trade-bearing samples to estimate download duration.".dimmed()
                );
            } else {
                println!(
                    "{}",
                    "No trade samples collected; cannot estimate download requirements.".dimmed()
                );
            }
        }
    }
}

fn estimate_download_requirements(
    total_instruments: usize,
    samples: &[TradeSample],
) -> Option<EstimationSummary> {
    if total_instruments == 0 || samples.is_empty() {
        return None;
    }

    let mut per_instrument: HashMap<String, Vec<&TradeSample>> = HashMap::new();
    for sample in samples {
        per_instrument
            .entry(sample.instrument.clone())
            .or_default()
            .push(sample);
    }

    let mut aggregates = Vec::new();
    for (_instrument, entries) in per_instrument {
        let chosen = entries
            .iter()
            .copied()
            .find(|s| s.trades > 0)
            .unwrap_or(entries[0]);
        aggregates.push((
            chosen.trades,
            chosen.has_more.unwrap_or(false),
            chosen.stats.clone(),
            chosen.host.clone(),
        ));
    }

    if aggregates.is_empty() {
        return None;
    }

    let sample_size = aggregates.len();
    let positive_count = aggregates
        .iter()
        .filter(|(trades, _, _, _)| *trades > 0)
        .count();
    if positive_count == 0 {
        return None;
    }

    let zero_count = sample_size - positive_count;
    let positive_duration_sum: f64 = aggregates
        .iter()
        .filter(|(trades, _, _, _)| *trades > 0)
        .map(|(_, _, stats, _)| stats.total_elapsed.as_secs_f64())
        .sum();
    let positive_bytes_sum: f64 = aggregates
        .iter()
        .filter(|(trades, _, _, _)| *trades > 0)
        .map(|(_, _, stats, _)| stats.bytes as f64)
        .sum();
    let avg_duration_positive = positive_duration_sum / positive_count as f64;
    let avg_bytes_positive = positive_bytes_sum / positive_count as f64;

    let (avg_duration_zero, avg_bytes_zero) = if zero_count > 0 {
        let zero_duration_sum: f64 = aggregates
            .iter()
            .filter(|(trades, _, _, _)| *trades == 0)
            .map(|(_, _, stats, _)| stats.total_elapsed.as_secs_f64())
            .sum();
        let zero_bytes_sum: f64 = aggregates
            .iter()
            .filter(|(trades, _, _, _)| *trades == 0)
            .map(|(_, _, stats, _)| stats.bytes as f64)
            .sum();
        (
            zero_duration_sum / zero_count as f64,
            zero_bytes_sum / zero_count as f64,
        )
    } else {
        (avg_duration_positive, avg_bytes_positive)
    };

    let has_more_ratio = if positive_count > 0 {
        aggregates
            .iter()
            .filter(|(trades, _, _, _)| *trades > 0)
            .filter(|(_, has_more, _, _)| *has_more)
            .count() as f64
            / positive_count as f64
    } else {
        0.0
    };

    let mut host_counts: HashMap<String, usize> = HashMap::new();
    for (_, _, _, host) in &aggregates {
        *host_counts.entry(host.clone()).or_default() += 1;
    }
    let dominant_host = host_counts
        .into_iter()
        .max_by_key(|(_, count)| *count)
        .map(|(host, _)| host);

    let total_instruments_f = total_instruments as f64;
    let positive_ratio = positive_count as f64 / sample_size as f64;
    let base_positive_requests = positive_ratio * total_instruments_f;
    let additional_requests = base_positive_requests * has_more_ratio;
    let total_requests = total_instruments_f + additional_requests;

    let estimated_positive_time = base_positive_requests * avg_duration_positive;
    let estimated_zero_time = (total_instruments_f - base_positive_requests) * avg_duration_zero;
    let estimated_additional_time = additional_requests * avg_duration_positive;
    let total_time_secs = estimated_positive_time + estimated_zero_time + estimated_additional_time;

    let estimated_positive_bytes = base_positive_requests * avg_bytes_positive;
    let estimated_zero_bytes = (total_instruments_f - base_positive_requests) * avg_bytes_zero;
    let estimated_additional_bytes = additional_requests * avg_bytes_positive;
    let total_bytes = estimated_positive_bytes + estimated_zero_bytes + estimated_additional_bytes;

    Some(EstimationSummary {
        total_requests,
        total_time_secs,
        total_bytes,
        positive_ratio,
        has_more_ratio,
        sample_size,
        dominant_host,
    })
}

struct EstimationSummary {
    total_requests: f64,
    total_time_secs: f64,
    total_bytes: f64,
    positive_ratio: f64,
    has_more_ratio: f64,
    sample_size: usize,
    dominant_host: Option<String>,
}

fn human_bytes(bytes: f64) -> String {
    if bytes.is_nan() || !bytes.is_finite() {
        return "unknown".to_string();
    }

    let units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut value = bytes;
    let mut unit_index = 0;
    while value >= 1024.0 && unit_index < units.len() - 1 {
        value /= 1024.0;
        unit_index += 1;
    }
    format!("{value:.2} {}", units[unit_index])
}

fn format_duration(seconds: f64) -> String {
    if seconds.is_nan() || !seconds.is_finite() {
        return "unknown".to_string();
    }

    let seconds = seconds.max(0.0);
    if seconds < 60.0 {
        return format!("{seconds:.1}s");
    }

    let total_secs = seconds.round() as u64;
    let hours = total_secs / 3600;
    let minutes = (total_secs % 3600) / 60;
    let secs = total_secs % 60;

    if hours > 0 {
        format!("{}h {}m {}s", hours, minutes, secs)
    } else {
        format!("{}m {}s", minutes, secs)
    }
}
