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
sys.exit(E.main())
