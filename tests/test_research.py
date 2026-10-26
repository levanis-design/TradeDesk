"""Research commands against saved SEC and House samples. No network."""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "engine"))
import research  # noqa: E402
from dts import facts, news, ptr  # noqa: E402

FX = os.path.join(HERE, "fixtures", "dts")


def sample_reports(row):
    path = os.path.join(FX, "trader-pelosi", "ptr-%s.txt" % row["doc_id"])
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as fh:
        return ptr.parse_ptr_text(fh.read(), filed=row["filed"])


def sample_index(year):
    return ptr.load_index(year, offline=os.path.join(FX, "trader-pelosi", "2026FD.zip"))


class Filings(unittest.TestCase):
    def fetcher(self):
        return news.Fetcher(sec_ua="Test User test@example.org", offline=os.path.join(FX, "trader-news"))

    def test_lists_filings_with_plain_item_names(self):
        out = research.filings({"tickers": ["KO", "AAPL"], "days": 9999}, fetcher=self.fetcher())
        self.assertEqual(len(out["items"]), 6)
        first = out["items"][0]
        self.assertRegex(first["time"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        self.assertTrue(any(i["items"] and i["items"][0]["label"] for i in out["items"]))
        times = [i["time"] for i in out["items"]]
        self.assertEqual(times, sorted(times, reverse=True))

    def test_unknown_ticker_is_reported_not_fatal(self):
        out = research.filings({"tickers": ["KO", "ZZZZ"], "days": 9999}, fetcher=self.fetcher())
        self.assertTrue(any("ZZZZ" in e for e in out["errors"]))
        self.assertTrue(out["items"])

    def test_days_window_filters_old_filings(self):
        out = research.filings({"tickers": ["KO"], "days": 1}, fetcher=self.fetcher())
        self.assertEqual(out["items"], [])

    def test_requires_a_real_contact(self):
        for ua in (None, "", "nobody", "you@example.com"):
            with self.assertRaises(research.ResearchError):
                research.filings({"tickers": ["KO"], "secUserAgent": ua})

    def test_ticker_input_is_cleaned(self):
        self.assertEqual(research.clean_tickers(["ko", "KO", "bad ticker!", "BRK-B", ""]), ["KO", "BRK-B"])
        with self.assertRaises(research.ResearchError):
            research.filings({"tickers": ["!!"]}, fetcher=self.fetcher())


class CompanyFacts(unittest.TestCase):
    def test_reported_quarters_and_stale_note(self):
        f = facts.Fetcher(offline=os.path.join(FX, "trader-analyst"))
        out = research.company_facts({"ticker": "KO"}, fetcher=f)
        self.assertEqual(out["entity"], "COCA COLA CO")
        self.assertGreaterEqual(len(out["rows"]), 4)
        self.assertIn("revenue", out["ttm"])
        self.assertTrue(out["changes"])
        self.assertIn("filed", out["stale"])

    def test_unknown_ticker(self):
        f = facts.Fetcher(offline=os.path.join(FX, "trader-analyst"))
        with self.assertRaises(research.ResearchError):
            research.company_facts({"ticker": "ZZZZ"}, fetcher=f)

    def test_requires_contact(self):
        with self.assertRaises(research.ResearchError):
            research.company_facts({"ticker": "KO"})


class Congress(unittest.TestCase):
    def run_it(self, **req):
        base = {"since": "2000-01-01", "limit": 50, "year": 2026}
        base.update(req)
        return research.congress(base, index_loader=sample_index, report_loader=sample_reports)

    def test_reads_trades_and_keeps_ranges(self):
        out = self.run_it()
        read = [r for r in out["reports"] if r["read"]]
        self.assertTrue(read)
        trade = read[0]["trades"][0]
        self.assertIn("amount", trade)
        self.assertIsNotNone(trade["amount_low"])

    def test_unread_documents_are_listed_not_hidden(self):
        out = self.run_it()
        self.assertGreater(out["unread"], 0)
        self.assertTrue(any(not r["read"] and r["url"] for r in out["reports"]))

    def test_member_filter(self):
        out = self.run_it(members=["Pelosi"])
        self.assertTrue(out["reports"])
        self.assertTrue(all("Pelosi" in r["name"] for r in out["reports"]))

    def test_ticker_filter_drops_other_trades(self):
        out = self.run_it()
        some = next(t["ticker"] for r in out["reports"] for t in r["trades"] if t.get("ticker"))
        only = self.run_it(tickers=[some])
        for r in only["reports"]:
            self.assertTrue(all(t["ticker"] == some for t in r["trades"]))


if __name__ == "__main__":
    unittest.main()


class Dispatch(unittest.TestCase):
    def test_engine_reports_missing_contact_as_error_event(self):
        import json
        import subprocess
        eng = os.path.join(HERE, "..", "engine", "tradedesk_engine.py")
        out = subprocess.run([sys.executable, eng], input=json.dumps({"cmd": "filings", "tickers": ["KO"]}) + "\n",
                             capture_output=True, text=True, timeout=60).stdout
        ev = [json.loads(x) for x in out.splitlines() if x.strip()][-1]
        self.assertEqual(ev["type"], "error")
        self.assertIn("SEC contact", ev["message"])


class FilingDetail(unittest.TestCase):
    LINK = "https://www.sec.gov/Archives/edgar/data/21344/000114036126035325/0001140361-26-035325-index.htm"

    def fetcher(self):
        return news.Fetcher(sec_ua="Test User test@example.org", offline=os.path.join(FX, "trader-news"))

    def test_reads_items_in_plain_words_and_skips_exhibit_list(self):
        out = research.filing_detail({"link": self.LINK, "form": "8-K"}, fetcher=self.fetcher())
        codes = [s["code"] for s in out["sections"]]
        self.assertEqual(codes, ["2.02", "5.02"])
        self.assertTrue(all(s["meaning"] for s in out["sections"]))
        self.assertTrue(out["sections"][1]["important"])
        self.assertIn("resignation", out["sections"][1]["text"])
        self.assertNotIn("SIGNATURES", out["sections"][1]["text"])

    def test_press_release_lines_carry_figures(self):
        out = research.filing_detail({"link": self.LINK, "form": "8-K"}, fetcher=self.fetcher())
        lines = " ".join(out["exhibit"]["lines"])
        self.assertIn("$12.5 billion", lines)
        self.assertEqual(out["exhibit"]["name"], "ex99_1.htm")

    def test_only_sec_filing_links_are_read(self):
        for bad in ("https://evil.example/x", "file:///etc/passwd", "https://www.sec.gov.evil.example/Archives/edgar/data/1/000000000000000001/0000000000-00-000001-index.htm", ""):
            with self.assertRaises(research.ResearchError):
                research.filing_detail({"link": bad, "form": "8-K"}, fetcher=self.fetcher())

    def test_long_reports_point_to_the_original(self):
        out = research.filing_detail({"link": self.LINK, "form": "10-Q"}, fetcher=self.fetcher())
        self.assertEqual(out["sections"], [])
        self.assertTrue(out["notes"])
        self.assertIn("quarterly", out["meaning"])
