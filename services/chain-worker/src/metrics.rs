//! Prometheus text metrics for the chain worker.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use crate::db::JobKind;

/// Submit→confirm latency histogram bucket bounds (milliseconds).
pub const LATENCY_BUCKETS_MS: [u64; 8] = [250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000];

#[derive(Clone, Default)]
pub struct WorkerMetrics {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    confirmed: [AtomicU64; 7],
    skipped: [AtomicU64; 7],
    retry_total: AtomicU64,
    dead_letter_total: AtomicU64,
    due_gauge: AtomicU64,
    signer_lamports: AtomicU64,
    latency_buckets: [AtomicU64; 9], // 8 bounds + +Inf
    latency_sum_ms: AtomicU64,
    latency_count: AtomicU64,
}

impl WorkerMetrics {
    pub fn inc_confirmed(&self, kind: JobKind) {
        self.inner.confirmed[kind.index()].fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_skipped(&self, kind: JobKind) {
        self.inner.skipped[kind.index()].fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_retry(&self) {
        self.inner.retry_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_dead_letter(&self) {
        self.inner.dead_letter_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn set_due(&self, value: u64) {
        self.inner.due_gauge.store(value, Ordering::Relaxed);
    }

    pub fn set_signer_lamports(&self, value: u64) {
        self.inner.signer_lamports.store(value, Ordering::Relaxed);
    }

    pub fn observe_submit_confirm_ms(&self, value_ms: u64) {
        let idx = LATENCY_BUCKETS_MS
            .iter()
            .position(|b| value_ms <= *b)
            .unwrap_or(LATENCY_BUCKETS_MS.len());
        self.inner.latency_buckets[idx].fetch_add(1, Ordering::Relaxed);
        self.inner
            .latency_sum_ms
            .fetch_add(value_ms, Ordering::Relaxed);
        self.inner.latency_count.fetch_add(1, Ordering::Relaxed);
    }

    pub fn render_prometheus(&self) -> String {
        let i = &self.inner;
        let mut out = String::with_capacity(2_048);
        out.push_str("# TYPE chain_worker_up gauge\nchain_worker_up 1\n");

        out.push_str("# TYPE chain_jobs_confirmed_total counter\n");
        for kind in JobKind::ALL {
            out.push_str(&format!(
                "chain_jobs_confirmed_total{{kind=\"{}\"}} {}\n",
                kind.as_str(),
                i.confirmed[kind.index()].load(Ordering::Relaxed)
            ));
        }
        out.push_str("# TYPE chain_jobs_skipped_total counter\n");
        for kind in JobKind::ALL {
            out.push_str(&format!(
                "chain_jobs_skipped_total{{kind=\"{}\"}} {}\n",
                kind.as_str(),
                i.skipped[kind.index()].load(Ordering::Relaxed)
            ));
        }
        out.push_str(&format!(
            "# TYPE chain_jobs_retry_total counter\nchain_jobs_retry_total {}\n",
            i.retry_total.load(Ordering::Relaxed)
        ));
        out.push_str(&format!(
            "# TYPE chain_jobs_dead_letter_total counter\nchain_jobs_dead_letter_total {}\n",
            i.dead_letter_total.load(Ordering::Relaxed)
        ));
        out.push_str(&format!(
            "# TYPE chain_jobs_due gauge\nchain_jobs_due {}\n",
            i.due_gauge.load(Ordering::Relaxed)
        ));
        out.push_str(&format!(
            "# TYPE signer_lamports gauge\nsigner_lamports {}\n",
            i.signer_lamports.load(Ordering::Relaxed)
        ));

        out.push_str("# TYPE chain_worker_submit_confirm_latency_ms histogram\n");
        let mut cumulative = 0u64;
        for (idx, bound) in LATENCY_BUCKETS_MS.iter().enumerate() {
            cumulative += i.latency_buckets[idx].load(Ordering::Relaxed);
            out.push_str(&format!(
                "chain_worker_submit_confirm_latency_ms_bucket{{le=\"{bound}\"}} {cumulative}\n"
            ));
        }
        cumulative += i.latency_buckets[LATENCY_BUCKETS_MS.len()].load(Ordering::Relaxed);
        out.push_str(&format!(
            "chain_worker_submit_confirm_latency_ms_bucket{{le=\"+Inf\"}} {cumulative}\n"
        ));
        out.push_str(&format!(
            "chain_worker_submit_confirm_latency_ms_sum {}\n",
            i.latency_sum_ms.load(Ordering::Relaxed)
        ));
        out.push_str(&format!(
            "chain_worker_submit_confirm_latency_ms_count {}\n",
            i.latency_count.load(Ordering::Relaxed)
        ));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_kind_labels_and_histogram() {
        let m = WorkerMetrics::default();
        m.inc_confirmed(JobKind::Lock);
        m.inc_confirmed(JobKind::SubmitSettlement);
        m.inc_retry();
        m.inc_dead_letter();
        m.set_due(3);
        m.set_signer_lamports(1_500_000_000);
        m.observe_submit_confirm_ms(300);
        m.observe_submit_confirm_ms(120_000);
        let text = m.render_prometheus();
        assert!(text.contains("chain_jobs_confirmed_total{kind=\"lock\"} 1"));
        assert!(text.contains("chain_jobs_confirmed_total{kind=\"submit_settlement\"} 1"));
        assert!(text.contains("chain_jobs_retry_total 1"));
        assert!(text.contains("chain_jobs_dead_letter_total 1"));
        assert!(text.contains("chain_jobs_due 3"));
        assert!(text.contains("signer_lamports 1500000000"));
        assert!(text.contains("latency_ms_bucket{le=\"500\"} 1"));
        assert!(text.contains("latency_ms_bucket{le=\"+Inf\"} 2"));
        assert!(text.contains("latency_ms_count 2"));
    }
}
