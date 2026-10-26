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


class Heatmap(unittest.TestCase):
    def test_changes_come_back_for_each_period_and_bad_symbols_are_flagged(self):
        ev = run({"cmd": "heatmap", "tickers": ["NVDA", "msft", "NOPE", "NVDA", ""]})[-1]
        self.assertEqual(ev["type"], "result")
        self.assertEqual([i["ticker"] for i in ev["items"]], ["NVDA", "MSFT", "NOPE"])
        good, bad = ev["items"][0], ev["items"][2]
        self.assertTrue(good["ok"])
        for key in ("1d", "1w", "1m", "3m"):
            self.assertIsInstance(good[key], float)
        self.assertFalse(bad["ok"])

    def test_one_period_matches_the_closing_prices(self):
        item = run({"cmd": "heatmap", "tickers": ["MSFT"]})[-1]["items"][0]
        bars = run({"cmd": "bars", "tickers": ["MSFT"], "interval": "1d", "range": "6mo"})[-1]["items"][0]["bars"]
        closes = [b[4] for b in bars]
        self.assertAlmostEqual(item["1d"], (closes[-1] / closes[-2] - 1) * 100, places=2)


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
        saved = [e for e in res["events"] if e["kind"] == "macro"]
        self.assertTrue(any("Jobs report" == e["title"] and e["date"] == "2026-11-06" for e in saved), saved[:3])
        self.assertTrue(all("saved with the app" in e["source"] for e in saved))
        self.assertTrue(any("saved with the app" in n for n in res["notes"]))

    def test_an_http_error_names_its_status_code(self):
        sys.path.insert(0, os.path.join(HERE, "..", "engine"))
        import tradedesk_engine as E
        import urllib.error
        self.assertEqual(E._why(urllib.error.HTTPError("u", 403, "Forbidden", {}, None)), "HTTP 403")
        self.assertEqual(E._why(OSError("x")), "OSError")


class PastAndMoves(unittest.TestCase):
    def test_past_events_come_with_results_against_expectations(self):
        ev = run({"cmd": "calendar", "tickers": ["NVDA"], "days": 30, "back": 400, "today": "2026-10-25"})[-1]
        rows = [e for e in ev["events"] if e["kind"] == "earnings"]
        aug = next(e for e in rows if e["date"] == "2026-08-27")
        self.assertEqual(aug["time"], "16:30")
        self.assertIn("1.10 against 1.00 expected", aug["detail"])
        self.assertIn("+10.0%", aug["detail"])
        may = next(e for e in rows if e["date"] == "2026-05-28")
        self.assertIn("-11.1%", may["detail"])
        future = next(e for e in rows if e["date"] == "2026-11-18")
        self.assertNotIn("Reported", future["detail"])

    def test_past_dividends_and_fed_and_expiry_fall_in_the_window(self):
        ev = run({"cmd": "calendar", "tickers": ["NVDA"], "days": 30, "back": 400, "today": "2026-10-25"})[-1]
        kinds = {(e["kind"], e["date"]) for e in ev["events"]}
        self.assertIn(("dividend", "2026-07-15"), kinds)
        self.assertIn(("fed", "2026-09-16"), kinds)
        self.assertTrue(any(k == "expiry" and d < "2026-10-01" for k, d in kinds))
        self.assertEqual(ev["start"], "2025-09-20")

    def test_default_window_still_starts_yesterday(self):
        ev = run({"cmd": "calendar", "tickers": [], "days": 30, "today": "2026-10-25"})[-1]
        self.assertEqual(ev["start"], "2026-10-24")

    def test_move_around_a_big_day_with_a_benchmark(self):
        ev = run({"cmd": "eventmove", "symbols": ["NVDA", "SPY"], "date": "2026-10-14", "time": "", "today": "2026-10-25"})[-1]
        nv, spy = ev["items"]
        self.assertEqual(ev["timing"], "unknown")
        self.assertAlmostEqual(nv["day0"], 0.05, places=3)
        self.assertAlmostEqual(nv["day1"], -0.02, places=3)
        self.assertAlmostEqual(spy["day0"], 0.001, places=3)
        self.assertEqual(nv["tradingDay"], "2026-10-14")
        self.assertFalse(nv["shiftedFromWeekend"])
        self.assertAlmostEqual(nv["gap"], 0.01, places=3)
        self.assertIsNotNone(nv["day5"])
        self.assertEqual(nv["base"], nv["priorClose"])
        self.assertTrue(any(d == "2026-10-14" for d, _ in nv["series"]))

    def test_a_weekend_event_is_measured_on_the_next_trading_day(self):
        nv = run({"cmd": "eventmove", "symbols": ["NVDA"], "date": "2026-10-17", "today": "2026-10-25"})[-1]["items"][0]
        self.assertTrue(nv["shiftedFromWeekend"])
        self.assertEqual(nv["tradingDay"], "2026-10-19")

    def test_an_event_in_the_future_is_pending_not_an_error(self):
        nv = run({"cmd": "eventmove", "symbols": ["NVDA"], "date": "2026-12-01", "today": "2026-10-25"})[-1]["items"][0]
        self.assertTrue(nv["ok"])
        self.assertTrue(nv["pending"])

    def test_intraday_reaction_from_the_event_time(self):
        nv = run({"cmd": "eventmove", "symbols": ["NVDA"], "date": "2026-10-22", "time": "14:00", "today": "2026-10-25"})[-1]
        it = nv["items"][0]["intraday"]
        self.assertEqual(nv["timing"], "during")
        self.assertEqual(it["at"], "14:00")
        self.assertGreater(it["m30"], 0)
        self.assertGreater(it["close"], it["m30"])

    def test_no_intraday_for_after_hours_or_old_events(self):
        a = run({"cmd": "eventmove", "symbols": ["NVDA"], "date": "2026-10-22", "time": "16:30", "today": "2026-10-25"})[-1]
        self.assertEqual(a["timing"], "after_close")
        self.assertNotIn("m30", a["items"][0].get("intraday", {}))
        old = run({"cmd": "eventmove", "symbols": ["NVDA"], "date": "2026-08-27", "time": "14:00", "today": "2026-10-25"})[-1]["items"][0]
        self.assertNotIn("intraday", old)

    def test_bad_input_is_refused_or_reported_per_symbol(self):
        self.assertEqual(run({"cmd": "eventmove", "symbols": ["NVDA"], "date": "tomorrow"})[-1]["type"], "error")
        items = run({"cmd": "eventmove", "symbols": ["NOPE", "NVDA"], "date": "2026-10-14", "today": "2026-10-25"})[-1]["items"]
        self.assertFalse(items[0]["ok"])
        self.assertTrue(items[1]["ok"])


if __name__ == "__main__":
    unittest.main()
