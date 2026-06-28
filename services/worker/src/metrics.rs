//! Prometheus-style counters for the settlement worker.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use syndicate_settlement::ops::AttemptStatus;

#[derive(Clone, Default)]
pub struct WorkerMetrics {
    inner: Arc<MetricsInner>,
}

#[derive(Default)]
struct MetricsInner {
    messages_received: AtomicU64,
    messages_acked: AtomicU64,
    relay_published: AtomicU64,
    relay_retry: AtomicU64,
    relay_dead_letter: AtomicU64,
    attempt_confirmed: AtomicU64,
    attempt_voided: AtomicU64,
    attempt_retry: AtomicU64,
    attempt_dead_letter: AtomicU64,
    outbox_backlog: AtomicU64,
    due_attempts: AtomicU64,
    reconstruct_latency_ms_total: AtomicU64,
    reconstruct_latency_samples: AtomicU64,
    submit_confirm_latency_ms_total: AtomicU64,
    submit_confirm_latency_samples: AtomicU64,
}

impl WorkerMetrics {
    pub fn inc_messages_received(&self) {
        self.inner.messages_received.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_messages_acked(&self) {
        self.inner.messages_acked.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_relay_published(&self) {
        self.inner.relay_published.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_relay_retry(&self) {
        self.inner.relay_retry.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_relay_dead_letter(&self) {
        self.inner.relay_dead_letter.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_attempt_final(&self, status: AttemptStatus) {
        match status {
            AttemptStatus::Confirmed => {
                self.inner.attempt_confirmed.fetch_add(1, Ordering::Relaxed);
            }
            AttemptStatus::Voided => {
                self.inner.attempt_voided.fetch_add(1, Ordering::Relaxed);
            }
            _ => {}
        }
    }

    pub fn inc_attempt_retry(&self) {
        self.inner.attempt_retry.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_attempt_dead_letter(&self) {
        self.inner
            .attempt_dead_letter
            .fetch_add(1, Ordering::Relaxed);
    }

    pub fn set_outbox_backlog(&self, value: u64) {
        self.inner.outbox_backlog.store(value, Ordering::Relaxed);
    }

    pub fn set_due_attempts(&self, value: u64) {
        self.inner.due_attempts.store(value, Ordering::Relaxed);
    }

    pub fn observe_reconstruct_latency_ms(&self, value: u64) {
        self.inner
            .reconstruct_latency_ms_total
            .fetch_add(value, Ordering::Relaxed);
        self.inner
            .reconstruct_latency_samples
            .fetch_add(1, Ordering::Relaxed);
    }

    pub fn observe_submit_confirm_latency_ms(&self, value: u64) {
        self.inner
            .submit_confirm_latency_ms_total
            .fetch_add(value, Ordering::Relaxed);
        self.inner
            .submit_confirm_latency_samples
            .fetch_add(1, Ordering::Relaxed);
    }

    pub fn render_prometheus(&self) -> String {
        let inner = &self.inner;
        format!(
            concat!(
                "syndicate_settlement_worker_up 1\n",
                "syndicate_settlement_messages_received_total {}\n",
                "syndicate_settlement_messages_acked_total {}\n",
                "syndicate_settlement_relay_published_total {}\n",
                "syndicate_settlement_relay_retry_total {}\n",
                "syndicate_settlement_relay_dead_letter_total {}\n",
                "syndicate_settlement_attempt_confirmed_total {}\n",
                "syndicate_settlement_attempt_voided_total {}\n",
                "syndicate_settlement_attempt_retry_total {}\n",
                "syndicate_settlement_attempt_dead_letter_total {}\n",
                "syndicate_settlement_outbox_backlog {}\n",
                "syndicate_settlement_due_attempts {}\n",
                "syndicate_settlement_reconstruct_latency_ms_total {}\n",
                "syndicate_settlement_reconstruct_latency_samples_total {}\n",
                "syndicate_settlement_submit_confirm_latency_ms_total {}\n",
                "syndicate_settlement_submit_confirm_latency_samples_total {}\n",
            ),
            inner.messages_received.load(Ordering::Relaxed),
            inner.messages_acked.load(Ordering::Relaxed),
            inner.relay_published.load(Ordering::Relaxed),
            inner.relay_retry.load(Ordering::Relaxed),
            inner.relay_dead_letter.load(Ordering::Relaxed),
            inner.attempt_confirmed.load(Ordering::Relaxed),
            inner.attempt_voided.load(Ordering::Relaxed),
            inner.attempt_retry.load(Ordering::Relaxed),
            inner.attempt_dead_letter.load(Ordering::Relaxed),
            inner.outbox_backlog.load(Ordering::Relaxed),
            inner.due_attempts.load(Ordering::Relaxed),
            inner.reconstruct_latency_ms_total.load(Ordering::Relaxed),
            inner.reconstruct_latency_samples.load(Ordering::Relaxed),
            inner
                .submit_confirm_latency_ms_total
                .load(Ordering::Relaxed),
            inner.submit_confirm_latency_samples.load(Ordering::Relaxed),
        )
    }
}
