"""One-shot analyzer: consecutive `timestamp` (event-time) deltas for trade-channel 5-minute captures.

Parses trade_*_5min.md, computes Δ(timestamp_i, timestamp_{i-1}) in milliseconds for every
consecutive pair, then renders a single consolidated Markdown report.

Usage:
    python3 scripts/trade_timestamp_delta.py
"""

from __future__ import annotations

import math
import os
import re
import statistics
import sys
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

SOURCES = [
    ("BTCUSD", REPO / "trade_btc_5min.md"),
    ("ETHUSD", REPO / "trade_eth_5min.md"),
    ("USDCUSD", REPO / "trade_usdc_5min.md"),
]

OUTPUT = REPO / "trade_timestamp_delta_5min.md"

ROW_RE = re.compile(
    r"^\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*([\d\.eE+\-]+)\s*\|\s*(\d+)\s*\|"
)
META_RE = re.compile(r"\*\*Capture (start|end) \(UTC\):\*\*\s*(\S+)")
COUNT_RE = re.compile(r"\*\*Message count:\*\*\s*(\d+)")
SERVER_RE = re.compile(r"\*\*Server:\*\*\s*(\S+)")


@dataclass
class Row:
    signed_at_ms: int
    timestamp_ms: int
    price: float
    trade_id: int


@dataclass
class Capture:
    symbol: str
    path: Path
    server: str
    start_utc: str
    end_utc: str
    declared_count: int
    rows: list[Row]


def parse(path: Path, symbol: str) -> Capture:
    text = path.read_text()
    rows: list[Row] = []
    for line in text.splitlines():
        m = ROW_RE.match(line)
        if not m:
            continue
        rows.append(
            Row(
                signed_at_ms=int(m.group(1)),
                timestamp_ms=int(m.group(2)),
                price=float(m.group(3)),
                trade_id=int(m.group(4)),
            )
        )
    starts = dict(META_RE.findall(text))
    return Capture(
        symbol=symbol,
        path=path,
        server=SERVER_RE.search(text).group(1) if SERVER_RE.search(text) else "?",
        start_utc=starts.get("start", "?"),
        end_utc=starts.get("end", "?"),
        declared_count=int(COUNT_RE.search(text).group(1)) if COUNT_RE.search(text) else len(rows),
        rows=rows,
    )


def pct(values: list[int], p: float) -> float:
    """Linear-interpolated percentile (matches numpy default)."""
    if not values:
        return float("nan")
    s = sorted(values)
    k = (len(s) - 1) * (p / 100.0)
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return float(s[int(k)])
    return s[f] + (s[c] - s[f]) * (k - f)


def histogram(deltas: list[int]) -> list[tuple[str, int]]:
    """Bucket Δ-timestamp_ms into human-readable bands."""
    bands = [
        ("0",          lambda d: d == 0),
        ("1-10 ms",    lambda d: 1 <= d <= 10),
        ("11-50 ms",   lambda d: 11 <= d <= 50),
        ("51-100 ms",  lambda d: 51 <= d <= 100),
        ("101-250 ms", lambda d: 101 <= d <= 250),
        ("251-500 ms", lambda d: 251 <= d <= 500),
        ("501-1000 ms",lambda d: 501 <= d <= 1000),
        ("1-2 s",      lambda d: 1001 <= d <= 2000),
        ("2-5 s",      lambda d: 2001 <= d <= 5000),
        (">5 s",       lambda d: d > 5000),
    ]
    return [(label, sum(1 for d in deltas if pred(d))) for label, pred in bands]


def render_capture(cap: Capture) -> tuple[str, dict]:
    deltas: list[int] = []
    out_lines: list[str] = []
    for i in range(1, len(cap.rows)):
        d = cap.rows[i].timestamp_ms - cap.rows[i - 1].timestamp_ms
        deltas.append(d)
    stats = {
        "count": len(deltas),
        "min": min(deltas) if deltas else None,
        "p50": pct(deltas, 50),
        "p90": pct(deltas, 90),
        "p95": pct(deltas, 95),
        "p99": pct(deltas, 99),
        "max": max(deltas) if deltas else None,
        "mean": statistics.fmean(deltas) if deltas else None,
        "stdev": statistics.pstdev(deltas) if len(deltas) > 1 else 0.0,
        "neg": sum(1 for d in deltas if d < 0),
        "zero": sum(1 for d in deltas if d == 0),
        "total_span_ms": cap.rows[-1].timestamp_ms - cap.rows[0].timestamp_ms if cap.rows else 0,
    }

    out_lines.append(f"## {cap.symbol}")
    out_lines.append("")
    out_lines.append(f"- **Source:** `{cap.path.name}`")
    out_lines.append(f"- **Server:** {cap.server}")
    out_lines.append(f"- **Capture start (UTC):** {cap.start_utc}")
    out_lines.append(f"- **Capture end (UTC):** {cap.end_utc}")
    out_lines.append(f"- **Messages:** {len(cap.rows)} (file declared {cap.declared_count})")
    out_lines.append(
        f"- **Event-timestamp span:** {stats['total_span_ms']} ms "
        f"({stats['total_span_ms']/1000:.3f} s)"
    )
    out_lines.append("")
    out_lines.append("### Δ(timestamp) statistics — ms")
    out_lines.append("")
    out_lines.append("| metric | value |")
    out_lines.append("|--------|------:|")
    out_lines.append(f"| pairs (count) | {stats['count']} |")
    out_lines.append(f"| min | {stats['min']} |")
    out_lines.append(f"| p50 | {stats['p50']:.1f} |")
    out_lines.append(f"| p90 | {stats['p90']:.1f} |")
    out_lines.append(f"| p95 | {stats['p95']:.1f} |")
    out_lines.append(f"| p99 | {stats['p99']:.1f} |")
    out_lines.append(f"| max | {stats['max']} |")
    out_lines.append(f"| mean | {stats['mean']:.2f} |")
    out_lines.append(f"| stdev (pop.) | {stats['stdev']:.2f} |")
    out_lines.append(f"| zero-delta pairs | {stats['zero']} |")
    out_lines.append(f"| negative-delta pairs (out-of-order) | {stats['neg']} |")
    out_lines.append("")
    out_lines.append("### Δ(timestamp) histogram")
    out_lines.append("")
    out_lines.append("| band | count | share |")
    out_lines.append("|------|------:|------:|")
    total = max(stats["count"], 1)
    for label, c in histogram(deltas):
        out_lines.append(f"| {label} | {c} | {100.0*c/total:.2f}% |")
    out_lines.append("")

    top = sorted(
        ((i + 1, d) for i, d in enumerate(deltas)),
        key=lambda x: x[1],
        reverse=True,
    )[:10]
    out_lines.append("### Top 10 longest Δ(timestamp) gaps")
    out_lines.append("")
    out_lines.append(
        "| # | pair_idx | prev_ts_ms | next_ts_ms | Δ_ms | prev_trade_id | next_trade_id | prev_signed_at_ms | next_signed_at_ms |"
    )
    out_lines.append(
        "|---|---------:|-----------:|-----------:|-----:|---------------|---------------|------------------:|------------------:|"
    )
    for rank, (idx, d) in enumerate(top, start=1):
        prev = cap.rows[idx - 1]
        nxt = cap.rows[idx]
        out_lines.append(
            f"| {rank} | {idx} | {prev.timestamp_ms} | {nxt.timestamp_ms} | {d} | "
            f"{prev.trade_id} | {nxt.trade_id} | {prev.signed_at_ms} | {nxt.signed_at_ms} |"
        )
    out_lines.append("")

    out_lines.append("### Full per-pair Δ(timestamp) table")
    out_lines.append("")
    out_lines.append("| # | timestamp_ms | trade_id | price | Δ_ms_from_prev |")
    out_lines.append("|---|--------------|----------|-------|----------------|")
    for i, r in enumerate(cap.rows):
        d = "" if i == 0 else str(r.timestamp_ms - cap.rows[i - 1].timestamp_ms)
        out_lines.append(f"| {i+1} | {r.timestamp_ms} | {r.trade_id} | {r.price} | {d} |")
    out_lines.append("")

    return "\n".join(out_lines), stats


def main() -> int:
    captures = [parse(p, sym) for sym, p in SOURCES if p.exists()]
    missing = [str(p) for sym, p in SOURCES if not p.exists()]

    header = [
        "# Trade-channel event-timestamp Δ — 5-minute captures",
        "",
        "Δ here is the difference between the **`timestamp`** field (the event time written on each",
        "trade message by the exchange/feed), computed on consecutive messages within a single",
        "symbol's trade channel. This is **not** the server-side `signed_at_ms` delta (which the",
        "source files already publish in their own `delta_ms` column).",
        "",
        "Source files (top of repo): `trade_btc_5min.md`, `trade_eth_5min.md`, `trade_usdc_5min.md`.",
        "All three captures share the same wall-clock window:",
        "**2026-05-25T10:17:43.528706Z → 2026-05-25T10:22:43.52943Z** (≈ 300 s).",
        "",
    ]
    if missing:
        header.append("> Missing files (skipped): " + ", ".join(missing))
        header.append("")

    summary = ["## Cross-symbol summary", "",
        "| symbol | msgs | pairs | min | p50 | p90 | p95 | p99 | max | mean | stdev | zero | negative |",
        "|--------|-----:|------:|----:|----:|----:|----:|----:|----:|-----:|------:|-----:|---------:|",
    ]

    body_parts: list[str] = []
    for cap in captures:
        body, stats = render_capture(cap)
        body_parts.append(body)
        summary.append(
            f"| {cap.symbol} | {len(cap.rows)} | {stats['count']} | {stats['min']} | "
            f"{stats['p50']:.0f} | {stats['p90']:.0f} | {stats['p95']:.0f} | {stats['p99']:.0f} | "
            f"{stats['max']} | {stats['mean']:.1f} | {stats['stdev']:.1f} | "
            f"{stats['zero']} | {stats['neg']} |"
        )
    summary.append("")

    OUTPUT.write_text(
        "\n".join(header + summary) + "\n" + "\n\n".join(body_parts) + "\n"
    )
    print(f"wrote {OUTPUT.relative_to(REPO)}  ({OUTPUT.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
