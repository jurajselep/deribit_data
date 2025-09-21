#[derive(Debug, Clone)]
pub struct BlockMeta {
    pub rows: u32,
    pub raw_bytes: u64,
    pub compressed_bytes: u64,
}
