"""Bars and calendar commands, run through the real engine with a fake Yahoo ticker and a fake BLS feed."""
import datetime as dt
import io
import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
FAKE = os.path.join(HERE, "engine_fake_quote.py")


def run(req):
    out = subprocess.run([sys.executable, FAKE], input=json.dumps(req) + "\n", capture_output=True, text=True, timeout=60).stdout
    return [json.loads(line) for line in out.splitlines() if line.strip()]


class Bars(unittest.TestCase):
    def test_intraday_bars_have_time_and_ohlc(self):
        ev = run({"cmd": "bars", "tickers": ["NVDA"], "interval": "5m", "range": "5d"})[-1]
        item = ev["items"][0]
        self.assertTrue(item["ok"])
        t, o, h, lo, c, v = item["bars"][0]
        self.assertRegex(t, r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$")
        self.assertGreaterEqual(h, max(o, c))
        self.assertLessEqual(lo, min(o, c))

    def test_daily_bars_use_plain_dates(self):
        item = run({"cmd": "bars", "tickers": ["MSFT"], "interval": "1d", "range": "3mo"})[-1]["items"][0]
        self.assertRegex(item["bars"][0][0], r"^\d{4}-\d{2}-\d{2}$")

    def test_a_range_yahoo_does_not_provide_is_refused(self):
        ev = run({"cmd": "bars", "tickers": ["NVDA"], "interval": "1m", "range": "1y"})[-1]
        self.assertEqual(ev["type"], "error")
        self.assertIn("1m", ev["message"])

    def test_unknown_symbol_is_reported_per_ticker(self):
        items = run({"cmd": "bars", "tickers": ["NOPE", "NVDA"], "interval": "1d", "range": "1mo"})[-1]["items"]
        self.assertFalse(items[0]["ok"])
        self.assertTrue(items[1]["ok"])


class Calendar(unittest.TestCase):
    def setUp(self):
        self.ev = run({"cmd": "calendar", "tickers": ["NVDA", "MSFT"], "days": 120})[-1]

    def kinds(self):
        return {e["kind"] for e in self.ev["events"]}

    def test_company_dividend_fed_macro_and_expiry_events_are_present(self):
        self.assertTrue({"earnings", "dividend", "fed", "macro", "expiry"} <= self.kinds(), self.kinds())

    def test_events_are_in_window_and_sorted(self):
        dates = [e["date"] for e in self.ev["events"]]
        self.assertEqual(dates, sorted(dates))
        self.assertTrue(all(self.ev["start"] <= d <= self.ev["end"] for d in dates))

    def test_only_listed_bls_releases_are_kept(self):
        titles = [e["title"] for e in self.ev["events"] if e["kind"] == "macro"]
        self.assertTrue(any("inflation" in t for t in titles))
        self.assertTrue(any("Jobs" in t for t in titles))
        self.assertFalse(any("Other" in t for t in titles))

    def test_fed_dates_match_the_published_schedule(self):
        sys.path.insert(0, os.path.join(HERE, "..", "engine"))
        import tradedesk_engine as E
        self.assertEqual(len(E.FOMC[2026]), 8)
        self.assertEqual(len(E.FOMC[2027]), 8)
        decisions = [f"2026-{b}" for _, b, _ in E.FOMC[2026]]
        self.assertIn("2026-10-28", decisions)
        self.assertIn("2026-12-09", decisions)

    def test_third_friday_is_a_friday_in_the_third_week(self):
        sys.path.insert(0, os.path.join(HERE, "..", "engine"))
        import tradedesk_engine as E
        for y, m in ((2026, 10), (2026, 12), (2027, 3)):
            d = E._third_friday(y, m)
            self.assertEqual(d.weekday(), 4)
            self.assertTrue(15 <= d.day <= 21)

    def test_ics_reader_handles_folded_lines_and_dates(self):
        sys.path.insert(0, os.path.join(HERE, "..", "engine"))
        import tradedesk_engine as E
        text = "BEGIN:VEVENT\r\nSUMMARY:Consumer Price Index for\r\n  September 2026\r\nDTSTART;TZID=America/New_York:20261014T083000\r\nEND:VEVENT\r\n"
        got = list(E._parse_ics(text))
        self.assertEqual(got, [("Consumer Price Index for September 2026", "2026-10-14", "08:30")])

    def test_a_failed_feed_is_reported_not_hidden(self):
        sys.path.insert(0, os.path.join(HERE, "..", "engine"))
        import tradedesk_engine as E
        def boom(url, timeout=12):
            raise OSError("offline")
        E._http_get = boom
        E._yf_ticker = lambda s: type("T", (), {"calendar": {}, "info": {}})()
        buf = io.StringIO()
        E._OUT = buf
        E.cmd_calendar({"tickers": [], "days": 365, "today": "2026-10-25"})
        res = json.loads(buf.getvalue().splitlines()[-1])
        self.assertTrue(any("could not be fetched" in n for n in res["notes"]), res["notes"])
        self.assertTrue(any(e["kind"] == "fed" for e in res["events"]))


if __name__ == "__main__":
    unittest.main()
