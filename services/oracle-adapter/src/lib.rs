//! # syndicate-oracle — modular pull-oracle core
//!
//! Provider-agnostic sampling + settlement-price finalization (`04_GAME_MECHANICS §11`).
//! `OracleProvider` is the swap point: the locked default (Switchboard On-Demand) is a
//! thin impl added behind a feature; here we keep the pure, testable core — window
//! sampling, confidence/staleness/min-sample **guards**, and `S = median` (computed by
//! `syndicate-shared`) — plus a `MockProvider` for tests. Guard failure ⇒ VOID.

use syndicate_shared::{median_price, Price};

/// Real Switchboard Crossbar client (pull feed values → fixed-point samples).
pub mod crossbar;
pub use crossbar::{CrossbarClient, CrossbarError, CrossbarResponse, CrossbarUpdate};

/// A signed price sample pulled from a provider.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sample {
    /// Logical sampling timestamp (match clock).
    pub ts: u64,
    pub price: Price,
    /// Provider confidence interval (smaller = tighter); guarded against a max.
    pub confidence: u64,
    /// When the provider published this price; guarded for staleness vs `ts`.
    pub publish_ts: u64,
}

/// Guard thresholds (configurable; `08 OQ1`).
#[derive(Clone, Copy, Debug)]
pub struct Guards {
    pub max_confidence: u64,
    pub max_staleness: u64,
    pub min_samples: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OracleError {
    /// Too few valid samples after guards ⇒ caller must VOID + refund (`04 §11`).
    Degraded,
}

/// Pull a signed sample for a feed at a logical timestamp. Real providers (Switchboard
/// On-Demand, Pyth) implement this; tests use [`MockProvider`].
pub trait OracleProvider {
    fn pull(&mut self, ts: u64) -> Option<Sample>;
}

/// Accumulates samples across the match and finalizes `S` over the settlement window.
#[derive(Clone, Debug)]
pub struct WindowSampler {
    guards: Guards,
    samples: Vec<Sample>,
}

impl WindowSampler {
    pub fn new(guards: Guards) -> Self {
        Self { guards, samples: Vec::new() }
    }

    /// Record a pulled sample (all samples are retained for replay/audit).
    pub fn record(&mut self, s: Sample) {
        self.samples.push(s);
    }

    /// Pull from a provider at `ts` and record it if present.
    pub fn pull_and_record<P: OracleProvider>(&mut self, provider: &mut P, ts: u64) {
        if let Some(s) = provider.pull(ts) {
            self.record(s);
        }
    }

    /// Public: the guard-passing sample prices in `[window_start, window_end]`. These
    /// are exactly what is handed to the settlement builder and re-submitted on-chain,
    /// where the program recomputes `S = median` over them.
    pub fn samples_in_window(&self, window_start: u64, window_end: u64) -> Vec<Price> {
        self.valid_in_window(window_start, window_end)
    }

    /// Samples that pass the guards within `[window_start, window_end]`.
    fn valid_in_window(&self, window_start: u64, window_end: u64) -> Vec<Price> {
        self.samples
            .iter()
            .filter(|s| {
                s.ts >= window_start
                    && s.ts <= window_end
                    && s.confidence <= self.guards.max_confidence
                    && s.publish_ts.abs_diff(s.ts) <= self.guards.max_staleness
            })
            .map(|s| s.price)
            .collect()
    }

    /// Finalize `S` = median of guard-passing samples in the settlement window, or
    /// `Degraded` (⇒ VOID) if fewer than `min_samples` survive. Mirrors `04 §11`.
    pub fn finalize_settlement_price(
        &self,
        window_start: u64,
        window_end: u64,
    ) -> Result<Price, OracleError> {
        let valid = self.valid_in_window(window_start, window_end);
        if valid.len() < self.guards.min_samples {
            return Err(OracleError::Degraded);
        }
        median_price(&valid).ok_or(OracleError::Degraded)
    }

    pub fn all_samples(&self) -> &[Sample] {
        &self.samples
    }
}

/// Deterministic in-memory provider for tests/sims.
pub struct MockProvider {
    pub scripted: Vec<Sample>,
    cursor: usize,
}

impl MockProvider {
    pub fn new(scripted: Vec<Sample>) -> Self {
        Self { scripted, cursor: 0 }
    }
}

impl OracleProvider for MockProvider {
    fn pull(&mut self, _ts: u64) -> Option<Sample> {
        let s = self.scripted.get(self.cursor).copied();
        if s.is_some() {
            self.cursor += 1;
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(ts: u64, price: i128, conf: u64, publish: u64) -> Sample {
        Sample { ts, price, confidence: conf, publish_ts: publish }
    }

    fn guards() -> Guards {
        Guards { max_confidence: 50, max_staleness: 2, min_samples: 3 }
    }

    #[test]
    fn good_window_yields_median() {
        let mut w = WindowSampler::new(guards());
        for (i, p) in [100, 102, 101, 99, 100].iter().enumerate() {
            w.record(s(i as u64, *p, 10, i as u64));
        }
        // window [0,4] → 5 valid samples, median of {99,100,100,101,102} = 100
        assert_eq!(w.finalize_settlement_price(0, 4), Ok(100));
    }

    #[test]
    fn stale_and_low_confidence_samples_are_filtered() {
        let mut w = WindowSampler::new(guards());
        w.record(s(0, 100, 10, 0)); // ok
        w.record(s(1, 9999, 999, 1)); // confidence too high → dropped
        w.record(s(2, 9999, 10, 10)); // stale (publish 10 vs ts 2) → dropped
        w.record(s(3, 102, 10, 3)); // ok
        w.record(s(4, 101, 10, 4)); // ok
        // 3 valid {100,101,102} → median 101
        assert_eq!(w.finalize_settlement_price(0, 4), Ok(101));
    }

    #[test]
    fn insufficient_samples_voids() {
        let mut w = WindowSampler::new(guards());
        w.record(s(0, 100, 10, 0));
        w.record(s(1, 101, 10, 1));
        // only 2 valid < min_samples(3) → Degraded (VOID)
        assert_eq!(w.finalize_settlement_price(0, 4), Err(OracleError::Degraded));
    }

    #[test]
    fn provider_pull_records_samples() {
        let mut provider = MockProvider::new(vec![s(0, 100, 10, 0), s(1, 100, 10, 1), s(2, 100, 10, 2)]);
        let mut w = WindowSampler::new(guards());
        for ts in 0..3 {
            w.pull_and_record(&mut provider, ts);
        }
        assert_eq!(w.all_samples().len(), 3);
        assert_eq!(w.finalize_settlement_price(0, 2), Ok(100));
    }
}
