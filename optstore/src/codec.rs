pub enum Compression {
    Lz4,
    Zstd,
}

impl Default for Compression {
    fn default() -> Self {
        Compression::Lz4
    }
}
