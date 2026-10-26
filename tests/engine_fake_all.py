"""Real engine with both fakes applied (deterministic prices and a fake Yahoo ticker). For the UI harness only."""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
for name in ("engine_fake_prices.py", "engine_fake_quote.py"):
    src = open(os.path.join(HERE, name), encoding="utf-8").read().replace("sys.exit(E.main())", "pass")
    fake_globals = {"__name__": "fake", "__file__": os.path.join(HERE, name)}
    exec(compile(src, name, "exec"), fake_globals)
import tradedesk_engine as E  # noqa: E402  (already patched by the exec'd files: same module object)
# TradingAgents also accesses yfinance directly for symbol context and memory
# settlement. Keep those paths offline rather than depending on live prices.
import pandas as pd
import yfinance as yf
yf.Ticker = fake_globals["FakeTicker"]
yf.download = lambda *args, **kwargs: pd.DataFrame()
# Settlement has its own price adapter, separate from the UI's quote adapter.
# This harness deliberately has no realized returns to score.
from tradingagents.memory import settlement
settlement.fetch_returns = lambda *args, **kwargs: (None, None, None, None)
from tradingagents.agents import context
context.get_company_profile = lambda symbol: {"longName": f"{symbol} Test Company"}
# Sentiment prefetches feeds directly, without model tool calls.
from types import SimpleNamespace
from tradingagents.agents.analysts import sentiment_analyst
sentiment_analyst.get_news = SimpleNamespace(func=lambda *args, **kwargs: "Deterministic test headlines.")
sentiment_analyst.fetch_stocktwits_messages = lambda *args, **kwargs: "No test messages."
sentiment_analyst.fetch_reddit_posts = lambda *args, **kwargs: "No test posts."
sentiment_analyst.jev_screen = lambda *args, **kwargs: None
# Research commands read saved SEC and House samples instead of the network.
sys.path.insert(0, os.path.join(HERE, "..", "engine"))
import research as _R  # noqa: E402
_FX = os.path.join(HERE, "fixtures", "dts")
_news_cls, _facts_cls = _R.dnews.Fetcher, _R.dfacts.Fetcher


class _SampleNews(_news_cls):
    """Serves the one saved filing folder for any filing link, so every row in the feed can be opened."""

    def get(self, url, name, *a, **k):
        if name.startswith("filing-"):
            name = "filing-0001140361-26-035325/" + name.split("/", 1)[1]
        return super().get(url, name, *a, **k)


_R.dnews.Fetcher = lambda sec_ua=None, **k: _SampleNews(sec_ua=sec_ua, offline=os.path.join(_FX, "trader-news"), pause=0)
_R.dfacts.Fetcher = lambda ua=None, **k: _facts_cls(ua=ua, offline=os.path.join(_FX, "trader-analyst"), pause=0)
_R.dptr.load_index = lambda year, offline=None: _R.dptr.parse_index(
    _R.dptr.read_index_bytes(open(os.path.join(_FX, "trader-pelosi", "2026FD.zip"), "rb").read()), year)


def _sample_report(row, cache):
    path = os.path.join(_FX, "trader-pelosi", "ptr-%s.txt" % row["doc_id"])
    if not os.path.isfile(path):
        return None
    return _R.dptr.parse_ptr_text(open(path, encoding="utf-8").read(), filed=row["filed"])


_R._read_report = _sample_report
sys.exit(E.main())
