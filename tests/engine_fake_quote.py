"""Runs the real engine with a fake Yahoo ticker, for tests only (no network)."""
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "engine"))
import tradedesk_engine as E  # noqa: E402

DAILY = {"NVDA": 0.004, "SPY": 0.001, "GOOG": -0.002, "AAPL": 0.002, "MSFT": 0.001}


class FakeTicker:
    def __init__(self, symbol):
        self.symbol = symbol
        self.rate = DAILY.get(symbol, 0.0005)

    def history(self, period="5y", interval="1d", auto_adjust=False):
        if self.symbol == "NOPE" or self.symbol.startswith("PAST"):
            return pd.DataFrame()
        if interval != "1d" or not period.endswith("y"):
            n = {"1m": 390, "5m": 78, "15m": 26, "1h": 7, "1wk": 1}.get(interval, 1) * {"1d": 1, "5d": 5, "1mo": 21, "3mo": 63, "6mo": 126, "1y": 252, "5y": 1260, "max": 1500}.get(period, 5)
            n = min(n, 400)
            freq = {"1m": "1min", "5m": "5min", "15m": "15min", "1h": "1h", "1wk": "7D", "1d": "B"}[interval]
            idx = pd.date_range(end="2026-10-23 15:59" if interval not in ("1d", "1wk") else "2026-10-23", periods=n, freq=freq)
            px, rows = 100.0, []
            for i, _ in enumerate(idx):
                o = px
                px *= 1 + self.rate + (0.002 if i % 3 == 0 else -0.0015)
                rows.append({"Open": o, "Close": px, "High": max(o, px) * 1.002, "Low": min(o, px) * 0.998, "Volume": 1000 + i})
            return pd.DataFrame(rows, index=idx)
        years = int(period.rstrip("y"))
        idx = pd.bdate_range(end="2026-10-23", periods=252 * years)
        px, rows = 100.0, []
        for i, _ in enumerate(idx):
            px *= 1 + self.rate + (0.004 if i % 7 == 0 else -0.003 if i % 5 == 0 else 0)
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
