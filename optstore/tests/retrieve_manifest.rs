use std::path::PathBuf;

use optstore::retrieve::cache::{CacheManager, CacheManifest, CacheManifestPart};
use tempfile::TempDir;

fn temp_cache() -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("temp");
    let path = dir.path().to_path_buf();
    (dir, path)
}

#[test]
fn manifest_roundtrip_eth() {
    let (_guard, root) = temp_cache();
    let manager = CacheManager::new(root.clone());
    let spec = optstore::retrieve::RetrieveSpec {
        symbol: "ETH-TEST".to_string(),
        day_ymd: 20250328,
        kind: optstore::retrieve::RetrieveKind::Trades,
    };
    let mut manifest = CacheManifest::new("deribit", &spec);
    manifest.append_part(CacheManifestPart {
        part: 0,
        start_ns: 1,
        end_ns: 2,
        bytes: 128,
        rows: 64,
        resume_token: Some("42".to_string()),
    });
    manager.store_manifest(&spec, &manifest).unwrap();
    let loaded = manager.load_manifest(&spec).unwrap().unwrap();
    assert_eq!(loaded.parts.len(), 1);
    assert_eq!(loaded.resume_token.as_deref(), Some("42"));
}

#[test]
fn manifest_roundtrip_btc() {
    let (_guard, root) = temp_cache();
    let manager = CacheManager::new(root.clone());
    let spec = optstore::retrieve::RetrieveSpec {
        symbol: "BTC-TEST".to_string(),
        day_ymd: 20250401,
        kind: optstore::retrieve::RetrieveKind::Trades,
    };
    let mut manifest = CacheManifest::new("deribit", &spec);
    manifest.append_part(CacheManifestPart {
        part: 0,
        start_ns: 10,
        end_ns: 20,
        bytes: 256,
        rows: 90,
        resume_token: Some("88".to_string()),
    });
    manager.store_manifest(&spec, &manifest).unwrap();
    let loaded = manager.load_manifest(&spec).unwrap().unwrap();
    assert_eq!(loaded.parts[0].bytes, 256);
    assert_eq!(loaded.parts[0].rows, 90);
}
