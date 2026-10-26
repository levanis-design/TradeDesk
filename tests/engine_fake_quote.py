"""Runs the real engine with a fake Yahoo ticker, for tests only (no network)."""
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "engine"))
import tradedesk_engine as E  # noqa: E402

DAILY = {"NVDA": 0.004, "SPY": 0.001, "GOOG": -0.002, "AAPL": 0.002, "MSFT": 0.001}
# TD_FAKE_SCALE shrinks the invented price drift so documentation screenshots show believable numbers. Tests leave it at 1.
SCALE = float(os.environ.get("TD_FAKE_SCALE", "1"))
# TD_FAKE_NOISE adds seeded day-to-day swings to the five-year history, for screenshots of the risk page. Tests leave it off.
NOISE = os.environ.get("TD_FAKE_NOISE") == "1"


class FakeTicker:
    def __init__(self, symbol):
        self.symbol = symbol
        self.rate = DAILY.get(symbol, 0.0005) * SCALE

    def _window(self, start, end, interval):
        """Deterministic bars between two dates. NVDA jumps 5 percent on 2026-10-14 and fades 2 percent the next day."""
        if self.symbol == "NOPE" or self.symbol.startswith("PAST"):
            return pd.DataFrame()
        days = pd.bdate_range(start=start, end=pd.Timestamp(end) - pd.Timedelta(days=1))
        days = days[days <= pd.Timestamp("2026-10-23")]
        if interval == "5m":
            rows, idx = [], []
            for d in days:
                px = 100.0
                for k in range(78):
                    ts = (d + pd.Timedelta(hours=9, minutes=30 + 5 * k)).tz_localize("America/New_York")
                    o = px
                    px *= 1.0004 if (self.symbol == "NVDA" and ts.hour >= 14) else 1.0
                    rows.append({"Open": o, "Close": px, "High": max(o, px), "Low": min(o, px), "Volume": 100})
                    idx.append(ts)
            return pd.DataFrame(rows, index=pd.DatetimeIndex(idx))
        px, rows = 100.0, []
        for d in days:
            o = px
            if self.symbol == "NVDA" and d == pd.Timestamp("2026-10-14"):
                px *= 1.05
            elif self.symbol == "NVDA" and d == pd.Timestamp("2026-10-15"):
                px *= 0.98
            else:
                px *= 1.001
            rows.append({"Open": o * 1.01 if d == pd.Timestamp("2026-10-14") else o, "Close": px, "High": max(o, px) * 1.01, "Low": min(o, px) * 0.99, "Volume": 1000})
        return pd.DataFrame(rows, index=days)

    def get_earnings_dates(self, limit=12):
        if self.symbol != "NVDA":
            return pd.DataFrame()
        idx = pd.DatetimeIndex([pd.Timestamp("2026-08-27 16:30", tz="America/New_York"), pd.Timestamp("2026-05-28 16:30", tz="America/New_York"), pd.Timestamp("2026-11-18 00:00", tz="America/New_York")])
        return pd.DataFrame({"EPS Estimate": [1.0, 0.9, 1.1], "Reported EPS": [1.1, 0.8, float("nan")], "Surprise(%)": [10.0, -11.1, float("nan")]}, index=idx)

    def history(self, period="5y", interval="1d", auto_adjust=False, start=None, end=None):
        if start is not None:
            return self._window(start, end, interval)
        if self.symbol == "NOPE" or self.symbol.startswith("PAST"):
            return pd.DataFrame()
        if interval != "1d" or not period.endswith("y"):
            n = {"1m": 390, "5m": 78, "15m": 26, "1h": 7, "1wk": 1}.get(interval, 1) * {"1d": 1, "5d": 5, "1mo": 21, "3mo": 63, "6mo": 126, "1y": 252, "5y": 1260, "max": 1500}.get(period, 5)
            n = min(n, 400)
            freq = {"1m": "1min", "5m": "5min", "15m": "15min", "1h": "1h", "1wk": "7D", "1d": "B"}[interval]
            idx = pd.date_range(end="2026-10-23 15:59" if interval not in ("1d", "1wk") else "2026-10-23", periods=n, freq=freq)
            px, rows = 100.0, []
            import random
            rng = random.Random(self.symbol + interval + period)
            for i, _ in enumerate(idx):
                o = px
                if NOISE and interval == "1d":
                    px *= 1 + self.rate + rng.gauss(0, 0.014)
                else:
                    px *= 1 + self.rate + (0.002 if i % 3 == 0 else -0.0015) * SCALE
                rows.append({"Open": o, "Close": px, "High": max(o, px) * 1.002, "Low": min(o, px) * 0.998, "Volume": 1000 + i})
            return pd.DataFrame(rows, index=idx)
        years = int(period.rstrip("y"))
        idx = pd.bdate_range(end="2026-10-23", periods=252 * years)
        px, rows = 100.0, []
        import random
        rng = random.Random(self.symbol)
        for i, _ in enumerate(idx):
            if NOISE:
                vol = 0.019 if self.symbol not in ("SPY", "VOO") else 0.009
                px *= 1 + self.rate + rng.gauss(0, vol) - (0.06 if rng.random() < 0.002 else 0)
            else:
                px *= 1 + self.rate + (0.004 if i % 7 == 0 else -0.003 if i % 5 == 0 else 0) * (SCALE if SCALE != 1 else 1)
            rows.append({"Open": px * 0.998, "Close": px, "High": px * 1.01, "Low": px * 0.99, "Volume": 1_000_000 + i})
        return pd.DataFrame(rows, index=idx)

    @property
    def info(self):
        if self.symbol == "AAPL":
            raise RuntimeError("rate limited")
        return {"longName": f"{self.symbol} Corporation", "currency": "USD", "marketCap": 2.5e12, "trailingPE": 31.2,
                "forwardPE": 27.0, "beta": 1.2, "sector": "Technology", "exchange": "NMS", "earningsTimestamp": 1793000000}

    @property
    def dividends(self):
        idx = pd.to_datetime(["2026-01-15", "2026-04-15", "2026-07-15", "2026-10-15"])
        return pd.Series([0.25, 0.25, 0.25, 0.25], index=idx)

    @property
    def calendar(self):
        import datetime as dt
        if self.symbol == "NVDA":
            t = dt.date.today()
            return {"Earnings Date": [t + dt.timedelta(days=10)], "Ex-Dividend Date": t + dt.timedelta(days=20)}
        return {}

    @property
    def news(self):
        if self.symbol == "MSFT":
            return [{"id": "1", "content": {"title": "MSFT launches new cloud region", "pubDate": "2026-10-20T14:00:00Z",
                                            "provider": {"displayName": "Example Wire"}, "canonicalUrl": {"url": "https://example.com/a"},
                                            "summary": "A short summary."}},
                    {"content": {"title": ""}}, "junk"]
        return [{"title": f"{self.symbol} old-format headline", "publisher": "Old Pub", "link": "https://example.com/b",
                 "providerPublishTime": 1792800000}]


def fake_http(url, timeout=12):
    import datetime as dt
    t = dt.date.today()
    ev = ""
    for n, name in ((5, "Consumer Price Index"), (7, "Employment Situation"), (9, "Some Other Release")):
        d = (t + dt.timedelta(days=n)).strftime("%Y%m%d")
        ev += f"BEGIN:VEVENT\r\nSUMMARY:{name} for September 2026\r\nDTSTART;TZID=America/New_York:{d}T083000\r\nEND:VEVENT\r\n"
    return "BEGIN:VCALENDAR\r\n" + ev + "END:VCALENDAR\r\n"


E._yf_ticker = FakeTicker
E._http_get = fake_http
sys.exit(E.main())
