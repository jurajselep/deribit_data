use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Tick {
    pub ts_ns: u64,
    pub instrument_id: u32,
    pub event: u8,
    pub price_fp: i64,
    pub size: u32,
    pub bid_px_fp: [i64; 4],
    pub ask_px_fp: [i64; 4],
    pub bid_sz: [u32; 4],
    pub ask_sz: [u32; 4],
    pub flags: u16,
}

impl Tick {
    pub fn key(&self) -> (u32, u64, i64, u32, u8) {
        (
            self.instrument_id,
            self.ts_ns,
            self.price_fp,
            self.size,
            self.event,
        )
    }
}
