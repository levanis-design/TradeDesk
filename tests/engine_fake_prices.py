"""Runs the real engine with deterministic prices, for tests only (no network)."""
import os
import sys
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "engine"))
import tradedesk_engine as E  # noqa: E402

DAILY = {"NVDA": 0.005, "SPY": 0.001, "GOOG": -0.003}
TODAY = date(2026, 10, 24)


def fake_closes(ticker, start, end=None):
    rate = DAILY.get(ticker, 0.0)
    d = datetime.strptime("2026-06-01", "%Y-%m-%d").date()
    px, rows = 100.0, []
    while d <= TODAY:
        if d.weekday() < 5:
            px *= 1 + rate
            rows.append((d.strftime("%Y-%m-%d"), round(px, 4)))
        d += timedelta(days=1)
    return [r for r in rows if r[0] >= start and (end is None or r[0] < end)]


E._closes = fake_closes
sys.exit(E.main())
