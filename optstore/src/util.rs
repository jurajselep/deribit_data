use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Context;

pub fn ensure_parent_dir(path: &Path) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("creating {parent:?}"))?;
    }
    Ok(())
}

pub fn day_to_path(base: &Path, day: &str) -> PathBuf {
    let parts: Vec<&str> = day.split('-').collect();
    match parts.as_slice() {
        [year, month, day] => base.join(year).join(month).join(format!("{day}.opt")),
        _ => base.join(format!("{day}.opt")),
    }
}
