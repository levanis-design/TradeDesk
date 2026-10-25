"""TradeDesk engine: a thin, one-job-per-process wrapper around TradingAgents.

Protocol
  stdin  : one JSON object, {"cmd": "...", ...}
  stdout : JSON lines only, each {"type": "...", ...}
  stderr : free text (library logging), never parsed

Commands: doctor, modelcheck, analyze, backtest, prices, quote, brief, bars, calendar

Nothing here places orders. TradingAgents' only execution step is a simulated
exchange and this wrapper does not call it.
"""
from __future__ import annotations

import contextlib
import json
import os
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import briefing  # noqa: E402

_OUT = sys.__stdout__
# Anything a library prints must not corrupt the protocol stream.
sys.stdout = sys.stderr


def emit(**event):
    _OUT.write(json.dumps(event, default=str) + "\n")
    _OUT.flush()


def _trunc(text, n=280):
    text = " ".join(str(text or "").split())
    return text if len(text) <= n else text[: n - 1] + "…"


# ---------------------------------------------------------------- config ----

def build_config(settings: dict) -> dict:
    from tradingagents.default_config import build_default_config

    cfg = build_default_config()
    data_dir = settings["data_dir"]
    cfg["results_dir"] = os.path.join(data_dir, "logs")
    cfg["data_cache_dir"] = os.path.join(data_dir, "cache")
    cfg["memory_log_path"] = os.path.join(data_dir, "memory", "trading_memory.md")
    for p in (cfg["results_dir"], cfg["data_cache_dir"], os.path.dirname(cfg["memory_log_path"])):
        os.makedirs(p, exist_ok=True)

    cfg["llm_provider"] = settings.get("provider", "ollama")
    cfg["quick_think_llm"] = settings["quick_model"]
    cfg["deep_think_llm"] = settings.get("deep_model") or settings["quick_model"]
    if settings.get("backend_url"):
        cfg["backend_url"] = settings["backend_url"]
    cfg["max_debate_rounds"] = int(settings.get("debate_rounds", 1))
    cfg["max_risk_discuss_rounds"] = int(settings.get("risk_rounds", 1))
    cfg["output_language"] = settings.get("language", "English")
    if settings.get("temperature") not in (None, ""):
        cfg["temperature"] = float(settings["temperature"])
    if settings.get("max_tool_rounds"):
        cfg["max_tool_rounds"] = int(settings["max_tool_rounds"])
    cfg["checkpoint_enabled"] = False
    return cfg


def build_portfolio(raw):
    """None means 'no context'. An empty book is a real, different state."""
    if raw is None:
        return None
    from tradingagents.portfolio import PortfolioContext, Position

    return PortfolioContext(
        cash=raw.get("cash"),
        currency=raw.get("currency") or "USD",
        positions=[
            Position(ticker=p["ticker"], quantity=float(p["quantity"]),
                     average_price=p.get("average_price"))
            for p in raw.get("positions", [])
        ],
    )


# ---------------------------------------------------------------- prices ----

def _closes(ticker, start, end=None):
    import yfinance as yf

    hist = yf.Ticker(ticker).history(start=start, end=end, auto_adjust=False)
    if hist is None or hist.empty:
        return []
    return [(idx.strftime("%Y-%m-%d"), float(row["Close"])) for idx, row in hist.iterrows()]


def last_close(ticker, around=None):
    """Latest close on or before `around` (today if None). Fail-open."""
    try:
        from datetime import datetime, timedelta

        end_dt = datetime.strptime(around, "%Y-%m-%d") + timedelta(days=1) if around else None
        start_dt = (end_dt or datetime.now()) - timedelta(days=14)
        rows = _closes(ticker, start_dt.strftime("%Y-%m-%d"),
                       end_dt.strftime("%Y-%m-%d") if end_dt else None)
        if rows:
            return {"date": rows[-1][0], "close": round(rows[-1][1], 4)}
    except Exception as exc:  # network or vendor problem must not fail a run
        sys.stderr.write(f"last_close({ticker}) failed: {exc}\n")
    return None


def cmd_prices(req):
    """Entry price (first close AFTER the analysis date, as TradingAgents does),
    latest price and the benchmark over the same window."""
    from datetime import datetime, timedelta

    bench = req.get("benchmark", "SPY")
    out = []
    cache = {}

    def series(sym, start):
        key = (sym, start)
        if key not in cache:
            cache[key] = _closes(sym, start)
        return cache[key]

    for item in req["items"]:
        res = {"id": item["id"], "ticker": item["ticker"], "date": item["date"]}
        try:
            start = (datetime.strptime(item["date"], "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
            for label, sym in (("asset", item["ticker"]), ("bench", bench)):
                rows = series(sym, start)
                after = [r for r in rows if r[0] > item["date"]]
                if not after:
                    res[label] = None
                    continue
                res[label] = {"entry_date": after[0][0], "entry": after[0][1],
                              "latest_date": rows[-1][0], "latest": rows[-1][1],
                              "closes_after": len(after)}
        except Exception as exc:
            res["error"] = str(exc)
        out.append(res)
    emit(type="result", cmd="prices", items=out, benchmark=bench)


# ----------------------------------------------------------------- quote ----

def _yf_ticker(symbol):
    import yfinance as yf

    return yf.Ticker(symbol)


def _num(v):
    try:
        f = float(v)
        return f if f == f and f not in (float("inf"), float("-inf")) else None
    except (TypeError, ValueError):
        return None


def _iso_date(v):
    """Accepts epoch seconds, ISO strings or datetimes. Returns YYYY-MM-DD or None."""
    from datetime import datetime, timezone

    try:
        if v is None or v == "":
            return None
        if isinstance(v, (int, float)):
            return datetime.fromtimestamp(float(v), tz=timezone.utc).strftime("%Y-%m-%d")
        if hasattr(v, "strftime"):
            return v.strftime("%Y-%m-%d")
        return str(v)[:10]
    except Exception:
        return None


def _news_items(raw, limit=15):
    """Yahoo's news format has changed between yfinance versions. Read both shapes."""
    out = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        c = item.get("content") if isinstance(item.get("content"), dict) else item
        title = c.get("title") or item.get("title")
        if not title:
            continue
        prov = c.get("provider") if isinstance(c.get("provider"), dict) else {}
        url = ""
        for key in ("canonicalUrl", "clickThroughUrl"):
            if isinstance(c.get(key), dict) and c[key].get("url"):
                url = c[key]["url"]
                break
        url = url or c.get("link") or item.get("link") or ""
        out.append({
            "title": str(title)[:300],
            "publisher": str(prov.get("displayName") or c.get("publisher") or item.get("publisher") or "")[:80],
            "date": _iso_date(c.get("pubDate") or c.get("displayTime") or item.get("providerPublishTime")),
            "url": str(url)[:600],
            "summary": _trunc(c.get("summary") or c.get("description") or "", 400),
        })
        if len(out) >= limit:
            break
    return out


def _quote_one(symbol, years, want_news):
    t = _yf_ticker(symbol)
    hist = t.history(period=f"{years}y", auto_adjust=False)
    if hist is None or hist.empty:
        return {"ticker": symbol, "ok": False, "error": "No price history was returned for this symbol."}
    closes = [(idx.strftime("%Y-%m-%d"), float(r["Close"])) for idx, r in hist.iterrows() if _num(r["Close"]) is not None]
    last = hist.iloc[-1]
    prev = hist.iloc[-2] if len(hist) > 1 else None
    year = hist.tail(252)
    price = _num(last["Close"])
    prev_close = _num(prev["Close"]) if prev is not None else None
    out = {
        "ticker": symbol, "ok": True, "asOf": hist.index[-1].strftime("%Y-%m-%d"),
        "price": price, "prevClose": prev_close,
        "change": (price - prev_close) if price is not None and prev_close else None,
        "changePct": ((price - prev_close) / prev_close) if price is not None and prev_close else None,
        "dayLow": _num(last.get("Low")), "dayHigh": _num(last.get("High")),
        "yearLow": _num(year["Low"].min()), "yearHigh": _num(year["High"].max()),
        "volume": _num(last.get("Volume")), "avgVolume": _num(hist.tail(63)["Volume"].mean()),
        "history": [[d, round(c, 4)] for d, c in closes],
    }
    info = {}
    try:
        info = t.info or {}
    except Exception as exc:
        sys.stderr.write(f"info({symbol}) failed: {exc}\n")
    out.update({
        "name": info.get("longName") or info.get("shortName") or None,
        "currency": info.get("currency") or None,
        "exchange": info.get("fullExchangeName") or info.get("exchange") or None,
        "sector": info.get("sector") or None, "industry": info.get("industry") or None,
        "marketCap": _num(info.get("marketCap")), "pe": _num(info.get("trailingPE")),
        "forwardPe": _num(info.get("forwardPE")), "beta": _num(info.get("beta")),
        "targetMean": _num(info.get("targetMeanPrice")),
    })
    # Dividend yield from the last twelve months of payments: Yahoo's own field changed units between versions.
    try:
        divs = t.dividends
        if divs is not None and len(divs) and price:
            cutoff = divs.index[-1] - __import__("pandas").Timedelta(days=365)
            ttm = float(divs[divs.index > cutoff].sum())
            out["dividendYield"] = ttm / price if ttm > 0 else 0.0
    except Exception as exc:
        sys.stderr.write(f"dividends({symbol}) failed: {exc}\n")
    try:
        nxt = None
        ts = info.get("earningsTimestamp") or info.get("earningsTimestampStart")
        if ts:
            nxt = _iso_date(ts)
        if not nxt:
            cal = t.calendar
            if isinstance(cal, dict) and cal.get("Earnings Date"):
                e = cal["Earnings Date"]
                nxt = _iso_date(e[0] if isinstance(e, (list, tuple)) and e else e)
        out["nextEarnings"] = nxt
    except Exception:
        out["nextEarnings"] = None
    if want_news:
        try:
            out["news"] = _news_items(t.news)
        except Exception as exc:
            sys.stderr.write(f"news({symbol}) failed: {exc}\n")
            out["news"] = []
    return out


def cmd_quote(req):
    """Price history, key statistics and recent headlines for a few tickers. Read only."""
    years = max(1, min(10, int(req.get("years", 5))))
    want_news = bool(req.get("news", False))
    results = []
    for sym in req.get("tickers", [])[:40]:
        sym = str(sym).strip().upper()
        try:
            results.append(_quote_one(sym, years, want_news))
        except Exception as exc:
            results.append({"ticker": sym, "ok": False, "error": f"{type(exc).__name__}: {_trunc(exc, 200)}"})
    emit(type="result", cmd="quote", items=results)



# ------------------------------------------------------------------ bars ----
# Interval and period pairs Yahoo accepts. One minute data only reaches back about a week,
# intraday intervals about sixty days, one hour about two years.
BAR_RANGES = {
    "1m": ("1d", "5d"),
    "5m": ("1d", "5d", "1mo"),
    "15m": ("5d", "1mo"),
    "1h": ("1mo", "3mo", "6mo", "1y"),
    "1d": ("1mo", "3mo", "6mo", "1y", "5y", "max"),
    "1wk": ("1y", "5y", "max"),
}


def _bar_time(idx, interval):
    return idx.strftime("%Y-%m-%d") if interval in ("1d", "1wk") else idx.strftime("%Y-%m-%d %H:%M")


def cmd_bars(req):
    """Open, high, low, close and volume bars at a chosen interval. Read only."""
    interval = str(req.get("interval", "1d"))
    period = str(req.get("range", "1y"))
    if interval not in BAR_RANGES or period not in BAR_RANGES[interval]:
        emit(type="error", message=f"Yahoo does not provide {interval} bars for {period}.")
        return
    results = []
    for sym in req.get("tickers", [])[:40]:
        sym = str(sym).strip().upper()
        try:
            hist = _yf_ticker(sym).history(period=period, interval=interval, auto_adjust=False)
            if hist is None or hist.empty:
                results.append({"ticker": sym, "ok": False, "error": "No bars were returned for this symbol and interval."})
                continue
            bars = []
            for idx, r in hist.iterrows():
                o, hi, lo, c = _num(r.get("Open")), _num(r.get("High")), _num(r.get("Low")), _num(r.get("Close"))
                if None in (o, hi, lo, c):
                    continue
                bars.append([_bar_time(idx, interval), round(o, 4), round(hi, 4), round(lo, 4), round(c, 4), _num(r.get("Volume")) or 0])
            results.append({"ticker": sym, "ok": True, "interval": interval, "range": period, "bars": bars[-3000:]})
        except Exception as exc:
            results.append({"ticker": sym, "ok": False, "error": f"{type(exc).__name__}: {_trunc(exc, 200)}"})
    emit(type="result", cmd="bars", items=results)


# -------------------------------------------------------------- calendar ----
# Federal Reserve meeting dates, copied from federalreserve.gov/monetarypolicy/fomccalendars.htm.
# The decision is announced on the second day. 2027 dates are tentative until the Fed confirms them.
FOMC = {
    2026: [("01-27", "01-28", False), ("03-17", "03-18", True), ("04-28", "04-29", False), ("06-16", "06-17", True),
           ("07-28", "07-29", False), ("09-15", "09-16", True), ("10-27", "10-28", False), ("12-08", "12-09", True)],
    2027: [("01-26", "01-27", False), ("03-16", "03-17", True), ("04-27", "04-28", False), ("06-08", "06-09", True),
           ("07-27", "07-28", False), ("09-14", "09-15", True), ("10-26", "10-27", False), ("12-07", "12-08", True)],
}
BLS_ICS = "https://www.bls.gov/schedule/news_release/bls.ics"
BLS_KEEP = (
    ("Consumer Price Index", "Consumer Price Index (inflation)", "high", "Inflation reading. Hotter than expected tends to hurt stocks and bonds because it raises rate expectations."),
    ("Employment Situation", "Jobs report", "high", "Payrolls and unemployment. Strong or weak surprises move rate expectations and the whole market."),
    ("Producer Price Index", "Producer Price Index", "medium", "Prices businesses pay. An early read on inflation pressure."),
    ("Job Openings and Labor Turnover", "Job openings (JOLTS)", "medium", "Labour demand. Read closely by the Fed."),
)


# Release dates read from the BLS schedule pages on 2026-10-25 (bls.gov/schedule/news_release). Used only when the live feed
# cannot be fetched, so the calendar still lists the next inflation and jobs releases. All at 8:30 am Eastern.
BLS_FALLBACK = {
    "Employment Situation": ["2026-11-06", "2026-12-04", "2027-01-08", "2027-02-05", "2027-03-05", "2027-04-02", "2027-05-07", "2027-06-04",
                             "2027-07-02", "2027-08-06", "2027-09-03", "2027-10-08", "2027-11-05", "2027-12-03"],
    "Consumer Price Index": ["2026-11-10", "2026-12-10", "2027-01-13", "2027-02-11", "2027-03-10", "2027-04-13", "2027-05-12", "2027-06-10",
                             "2027-07-14", "2027-08-11", "2027-09-14", "2027-10-14", "2027-11-10", "2027-12-10"],
    "Producer Price Index": ["2026-11-13", "2026-12-15", "2027-01-14", "2027-02-12", "2027-03-12", "2027-04-14", "2027-05-13", "2027-06-11",
                             "2027-07-15", "2027-08-10", "2027-09-10", "2027-10-15", "2027-11-12", "2027-12-15"],
    "Job Openings and Labor Turnover": ["2026-12-01"],
}
BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"


def _http_get(url, timeout=12):
    """Some government sites refuse unfamiliar clients, so try a browser-style request first, then a plain one."""
    import urllib.error
    import urllib.request

    last = None
    for ua in (BROWSER_UA, "TradeDesk/2 (personal market research; calendar feed)"):
        headers = {"User-Agent": ua, "Accept": "text/calendar,text/plain,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9"}
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout) as r:  # nosec - fixed https url
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            last = exc
        except Exception as exc:
            last = exc
    raise last


def _why(exc):
    code = getattr(exc, "code", None)
    return f"HTTP {code}" if code else type(exc).__name__


def _parse_ics(text):
    """Very small iCalendar reader: yields (summary, date YYYY-MM-DD, time HH:MM or '')."""
    text = text.replace("\r\n ", "").replace("\n ", "")
    for block in text.split("BEGIN:VEVENT")[1:]:
        summary = start = None
        for line in block.splitlines():
            if line.startswith("SUMMARY"):
                summary = line.split(":", 1)[1].strip()
            elif line.startswith("DTSTART"):
                start = line.split(":", 1)[1].strip()
        if summary and start and len(start) >= 8 and start[:8].isdigit():
            hhmm = f"{start[9:11]}:{start[11:13]}" if len(start) >= 13 and start[8] == "T" else ""
            yield summary, f"{start[0:4]}-{start[4:6]}-{start[6:8]}", hhmm


def _third_friday(year, month):
    import datetime as dt

    d = dt.date(year, month, 1)
    first_fri = d + dt.timedelta(days=(4 - d.weekday()) % 7)
    return first_fri + dt.timedelta(days=14)


def _hhmm_et(ts):
    """Clock time in New York for a Yahoo timestamp, or '' when Yahoo gave only a date."""
    try:
        t = ts.tz_convert("America/New_York") if getattr(ts, "tzinfo", None) is not None else ts
        return "" if (t.hour == 0 and t.minute == 0) else t.strftime("%H:%M")
    except Exception:
        return ""


def _earnings_detail(row, past):
    est, rep, sur = _num(row.get("EPS Estimate")), _num(row.get("Reported EPS")), _num(row.get("Surprise(%)"))
    if past and rep is not None and est is not None:
        tail = f" ({sur:+.1f}% versus expectations)" if sur is not None else ""
        return f"Reported earnings per share of {rep:.2f} against {est:.2f} expected{tail}."
    if past:
        return "Quarterly results were published on this date."
    return "Quarterly earnings. Results and guidance often move the stock several percent either way." + (f" Analysts expect earnings per share of {est:.2f}." if est is not None else "")


def _calendar_for_ticker(sym, lo, hi, today=None):
    import datetime as dt

    today = today or dt.date.today()
    t = _yf_ticker(sym)
    events = []

    def add(date, kind, title, detail, impact, time=""):
        if date and lo <= date <= hi:
            events.append({"date": date, "time": time, "kind": kind, "ticker": sym, "title": title, "detail": detail, "impact": impact, "source": "Yahoo Finance"})

    cal = None
    try:
        cal = t.calendar
    except Exception as exc:
        sys.stderr.write(f"calendar({sym}) failed: {exc}\n")
    seen = set()
    seen_div = set()
    # Dates with a clock time and, for past quarters, the result against expectations.
    try:
        ed = t.get_earnings_dates(limit=16)
        if ed is not None and not ed.empty:
            for ts, row in ed.iterrows():
                d = _iso_date(ts)
                if not d or d in seen:
                    continue
                seen.add(d)
                past = d <= today.isoformat() and _num(row.get("Reported EPS")) is not None
                add(d, "earnings", f"{sym} quarterly results", _earnings_detail(row, past or d < today.isoformat()), "high", _hhmm_et(ts))
    except Exception as exc:
        sys.stderr.write(f"earnings_dates({sym}) failed: {exc}\n")
    if isinstance(cal, dict):
        ed = cal.get("Earnings Date")
        for e in (ed if isinstance(ed, (list, tuple)) else [ed]):
            d = _iso_date(e)
            if d and d not in seen:
                seen.add(d)
                add(d, "earnings", f"{sym} quarterly results", "Quarterly earnings. Results and guidance often move the stock several percent either way.", "high")
        xd = _iso_date(cal.get("Ex-Dividend Date"))
        if xd:
            seen_div.add(xd)
        add(xd, "dividend", f"{sym} ex-dividend date", "Buy on or after this date and you do not get the next dividend. The price usually drops by about the dividend.", "low")
        add(_iso_date(cal.get("Dividend Date")), "dividend", f"{sym} dividend paid", "Dividend payment date.", "low")
    try:
        info = t.info or {}
        ts = info.get("earningsTimestamp") or info.get("earningsTimestampStart")
        d = _iso_date(ts) if ts else None
        if d and d not in seen:
            seen.add(d)
            add(d, "earnings", f"{sym} quarterly results", "Quarterly earnings. Results and guidance often move the stock several percent either way.", "high")
    except Exception as exc:
        sys.stderr.write(f"info({sym}) failed: {exc}\n")
    # Past ex-dividend dates.
    try:
        divs = t.dividends
        if divs is not None and len(divs):
            for ts, amount in divs.items():
                d = _iso_date(ts)
                if d and d not in seen_div and d < today.isoformat():
                    seen_div.add(d)
                    amt = _num(amount)
                    add(d, "dividend", f"{sym} ex-dividend date", f"The stock went ex-dividend{f', {amt:.2f} per share' if amt else ''}. The price usually drops by about the dividend.", "low")
    except Exception as exc:
        sys.stderr.write(f"dividends({sym}) failed: {exc}\n")
    return events


def cmd_calendar(req):
    """Upcoming events that can move prices: company results, dividends, Fed meetings, inflation and jobs data, option expiry."""
    import datetime as dt

    today = dt.date.today()
    if req.get("today"):
        today = dt.date.fromisoformat(str(req["today"]))
    days = max(7, min(365, int(req.get("days", 90))))
    back = max(1, min(400, int(req.get("back", 1))))
    lo = (today - dt.timedelta(days=back)).isoformat()
    hi = (today + dt.timedelta(days=days)).isoformat()
    events, notes = [], []

    for sym in [str(x).strip().upper() for x in req.get("tickers", [])[:40]]:
        try:
            events.extend(_calendar_for_ticker(sym, lo, hi, today))
        except Exception as exc:
            notes.append(f"{sym}: company dates could not be read ({type(exc).__name__}).")

    for year, meetings in FOMC.items():
        for a, b, sep in meetings:
            end = f"{year}-{b}"
            if lo <= end <= hi:
                events.append({"date": end, "time": "14:00", "kind": "fed", "ticker": "", "impact": "high", "source": "federalreserve.gov",
                               "title": "Federal Reserve rate decision" + (" and projections" if sep else ""),
                               "detail": f"Two day meeting {year}-{a} to {end}. Rate decision at 2:00 pm Eastern, press conference after." + (" Includes new rate and economic projections." if sep else "") + (" 2027 dates are tentative." if year == 2027 else "")})

    def add_macro(date, summary):
        for key, title, impact, detail in BLS_KEEP:
            if key.lower() in summary.lower():
                return {"date": date, "time": "08:30", "kind": "macro", "ticker": "", "title": title, "detail": detail, "impact": impact, "source": "bls.gov"}
        return None

    try:
        got = 0
        for summary, date, hhmm in _parse_ics(_http_get(BLS_ICS)):
            if not (lo <= date <= hi):
                continue
            for key, title, impact, detail in BLS_KEEP:
                if key.lower() in summary.lower():
                    events.append({"date": date, "time": hhmm, "kind": "macro", "ticker": "", "title": title, "detail": detail, "impact": impact, "source": "bls.gov"})
                    got += 1
                    break
        if not got:
            notes.append("The BLS schedule returned no inflation or jobs releases in this window. Check bls.gov/schedule.")
    except Exception as exc:
        found = 0
        for key, dates in BLS_FALLBACK.items():
            for d in dates:
                if lo <= d <= hi:
                    ev = add_macro(d, key)
                    if ev:
                        ev["source"] = "bls.gov (dates saved with the app)"
                        events.append(ev)
                        found += 1
        notes.append(f"Inflation and jobs release dates could not be fetched live ({_why(exc)}). "
                     + (f"Showing the dates saved with the app, checked on October 25, 2026, which cover upcoming releases only. Check bls.gov/schedule for changes." if found else "Check bls.gov/schedule."))

    first = dt.date.fromisoformat(lo)
    y, m = first.year, first.month
    for i in range(0, (days + back) // 28 + 2):
        yy, mm = y + (m - 1 + i) // 12, (m - 1 + i) % 12 + 1
        d = _third_friday(yy, mm).isoformat()
        if lo <= d <= hi:
            quad = mm in (3, 6, 9, 12)
            events.append({"date": d, "time": "", "kind": "expiry", "ticker": "", "impact": "medium" if quad else "low", "source": "calculated",
                           "title": "Quarterly options and futures expiry" if quad else "Monthly options expiry",
                           "detail": "Contracts expire on the third Friday. Volume and price swings are often larger than normal." if quad else "Monthly options expire on the third Friday. Prices can pin near popular strikes."})

    events.sort(key=lambda e: (e["date"], e.get("time") or "", e["title"]))
    emit(type="result", cmd="calendar", events=events, notes=notes, start=lo, end=hi)


# ------------------------------------------------------------ event move ----
# How a symbol moved around an event, from daily bars (and five minute bars when the event has a clock time
# in the trading session and happened within Yahoo's roughly sixty day intraday window). Read only.

def _event_timing(hhmm):
    if not hhmm:
        return "unknown"
    if hhmm < "09:30":
        return "before_open"
    if hhmm >= "16:00":
        return "after_close"
    return "during"


def _add_minutes(hhmm, n):
    h, m = int(hhmm[:2]), int(hhmm[3:5])
    t = h * 60 + m + n
    return f"{t // 60:02d}:{t % 60:02d}"


def _local_index(idx):
    """Exchange-local timestamps, whatever timezone Yahoo returned them in."""
    try:
        return idx.tz_convert("America/New_York") if getattr(idx, "tz", None) is not None else idx
    except Exception:
        return idx


def _pct(a, b):
    return None if a in (None, 0) or b is None else round(b / a - 1, 5)


def _intraday_path(sym, date, hhmm):
    """Five minute closes for the event day and the move from the event time. None when Yahoo has no such bars."""
    import datetime as dt

    d0 = dt.date.fromisoformat(date)
    hist = _yf_ticker(sym).history(start=d0.isoformat(), end=(d0 + dt.timedelta(days=2)).isoformat(), interval="5m", auto_adjust=False)
    if hist is None or hist.empty:
        return None
    idx = _local_index(hist.index)
    rows = []
    for ts, (_, r) in zip(idx, hist.iterrows()):
        if ts.strftime("%Y-%m-%d") != date:
            continue
        o, c = _num(r.get("Open")), _num(r.get("Close"))
        if o is not None and c is not None:
            rows.append((ts.strftime("%H:%M"), o, c))
    if len(rows) < 10:
        return None
    path = [[t, round(c, 4)] for t, _, c in rows]
    out = {"path": path}
    if hhmm and "09:30" <= hhmm < "16:00":
        start = next((r for r in rows if r[0] >= hhmm), None)
        if start:
            p0 = start[1]
            out["at"] = start[0]
            out["price"] = round(p0, 4)

            def close_at(t):
                after = [r for r in rows if r[0] <= t]
                return after[-1][2] if after else None
            out["m30"] = _pct(p0, close_at(_add_minutes(start[0], 30)))
            out["m120"] = _pct(p0, close_at(_add_minutes(start[0], 120)))
            out["close"] = _pct(p0, rows[-1][2])
    return out


def _move_one(sym, date, hhmm, today):
    import datetime as dt

    d0 = dt.date.fromisoformat(date)
    if d0 > today:
        return {"ticker": sym, "ok": True, "pending": True, "note": "This event has not happened yet."}
    hist = _yf_ticker(sym).history(start=(d0 - dt.timedelta(days=24)).isoformat(), end=(d0 + dt.timedelta(days=24)).isoformat(), interval="1d", auto_adjust=False)
    if hist is None or hist.empty:
        return {"ticker": sym, "ok": False, "error": "No daily prices were returned for this symbol and date."}
    bars = []
    for ts, r in hist.iterrows():
        o, hi, lo, c = _num(r.get("Open")), _num(r.get("High")), _num(r.get("Low")), _num(r.get("Close"))
        if None not in (o, hi, lo, c):
            bars.append((ts.strftime("%Y-%m-%d"), o, hi, lo, c))
    i0 = next((i for i, b in enumerate(bars) if b[0] >= date), None)
    if i0 is None:
        return {"ticker": sym, "ok": True, "pending": True, "note": "No trading day on or after this date yet."}
    if i0 == 0:
        return {"ticker": sym, "ok": False, "error": "Not enough earlier prices to measure a move."}
    prior, day0 = bars[i0 - 1][4], bars[i0]
    out = {"ticker": sym, "ok": True, "tradingDay": day0[0], "shiftedFromWeekend": day0[0] != date, "priorClose": round(prior, 4), "close": round(day0[4], 4),
           "gap": _pct(prior, day0[1]), "day0": _pct(prior, day0[4]), "range": _pct(day0[3], day0[2])}
    out["day1"] = _pct(day0[4], bars[i0 + 1][4]) if i0 + 1 < len(bars) else None
    out["day1Date"] = bars[i0 + 1][0] if i0 + 1 < len(bars) else None
    out["day5"] = _pct(prior, bars[i0 + 5][4]) if i0 + 5 < len(bars) else None
    out["series"] = [[b[0], round(b[4], 4)] for b in bars[max(0, i0 - 6): i0 + 9]]
    out["base"] = round(prior, 4)
    out["priorDate"] = bars[i0 - 1][0]
    if hhmm and day0[0] == date and (today - d0).days <= 55:
        try:
            intra = _intraday_path(sym, date, hhmm)
            if intra:
                out["intraday"] = intra
        except Exception as exc:
            sys.stderr.write(f"intraday({sym}) failed: {exc}\n")
    return out


def cmd_eventmove(req):
    """Price move around one event for up to four symbols. Dates are YYYY-MM-DD, time is HH:MM Eastern or empty."""
    import datetime as dt

    date = str(req.get("date", ""))
    try:
        dt.date.fromisoformat(date)
    except ValueError:
        emit(type="error", message="That is not a valid event date.")
        return
    hhmm = str(req.get("time", "") or "")
    if hhmm and not (len(hhmm) == 5 and hhmm[2] == ":" and hhmm[:2].isdigit() and hhmm[3:].isdigit()):
        hhmm = ""
    today = dt.date.today()
    if req.get("today"):
        today = dt.date.fromisoformat(str(req["today"]))
    items = []
    for sym in [str(x).strip().upper() for x in req.get("symbols", [])[:4]]:
        try:
            items.append(_move_one(sym, date, hhmm, today))
        except Exception as exc:
            items.append({"ticker": sym, "ok": False, "error": f"{type(exc).__name__}: {_trunc(exc, 200)}"})
    emit(type="result", cmd="eventmove", date=date, time=hhmm, timing=_event_timing(hhmm), items=items)


# ----------------------------------------------------------------- brief ----

def _deep_llm(cfg):
    from tradingagents.llm_clients import create_tier_client

    return create_tier_client(cfg, "deep").get_llm()


def cmd_brief(req):
    cfg = build_config(req["settings"])
    try:
        llm = _deep_llm(cfg)
    except Exception as exc:
        sys.stderr.write(f"brief: no model client: {exc}\n")
        llm = None
    res = briefing.make(req["ticker"], str(req.get("rating", "")), req.get("sections") or {}, llm,
                        log=lambda m: sys.stderr.write(m + "\n"))
    emit(type="result", cmd="brief", brief=res)


# ---------------------------------------------------------------- doctor ----

def cmd_doctor(_req):
    info = {"python": sys.version.split()[0]}
    try:
        import tradingagents

        info["tradingagents"] = getattr(tradingagents, "__version__", "unknown")
        from tradingagents.graph.trading_graph import TradingAgentsGraph  # noqa: F401
        from tradingagents.portfolio import PortfolioContext  # noqa: F401

        info["ok"] = True
    except Exception as exc:
        info["ok"] = False
        info["error"] = f"{type(exc).__name__}: {exc}"
    emit(type="result", cmd="doctor", **info)


# ------------------------------------------------------------ model check ---

def cmd_modelcheck(req):
    """Three questions a local model must pass before a long run is worth starting:
    does it answer, does it call tools (the analysts need that), does it return
    structured output (the managers need that)."""
    from tradingagents.llm_clients import create_tier_client

    cfg = build_config(req["settings"])
    checks = []

    def record(name, ok, detail):
        checks.append({"name": name, "ok": bool(ok), "detail": detail})
        emit(type="check", name=name, ok=bool(ok), detail=detail)

    try:
        llm = create_tier_client(cfg, "quick").get_llm()
    except Exception as exc:
        record("connect", False, f"{type(exc).__name__}: {exc}")
        emit(type="result", cmd="modelcheck", ok=False, checks=checks)
        return

    t0 = time.time()
    try:
        r = llm.invoke("Reply with the single word: ready")
        text = str(getattr(r, "content", r))
        record("answers", bool(text.strip()), f"{time.time() - t0:.1f}s, reply: {_trunc(text, 60)}")
    except Exception as exc:
        record("answers", False, f"{type(exc).__name__}: {_trunc(exc, 200)}")
        emit(type="result", cmd="modelcheck", ok=False, checks=checks)
        return

    try:
        from langchain_core.tools import tool

        @tool
        def get_price(symbol: str) -> str:
            """Return the latest price for a ticker symbol."""
            return "100"

        r = llm.bind_tools([get_price]).invoke(
            "What is the latest price of ABC? You must call the get_price tool.")
        calls = getattr(r, "tool_calls", None) or []
        record("tool calls", len(calls) > 0,
               "calls tools" if calls else "answered in text and did not call the tool")
    except Exception as exc:
        record("tool calls", False, f"{type(exc).__name__}: {_trunc(exc, 200)}")

    try:
        from pydantic import BaseModel, Field

        class Verdict(BaseModel):
            rating: str = Field(description="One of Buy, Hold, Sell")
            reason: str = Field(description="One short sentence")

        r = llm.with_structured_output(Verdict).invoke(
            "A company beat earnings and raised guidance. Give a rating and a reason.")
        ok = bool(getattr(r, "rating", None))
        record("structured output", ok, f"rating: {getattr(r, 'rating', None)}")
    except Exception as exc:
        record("structured output", False, f"{type(exc).__name__}: {_trunc(exc, 200)}")

    emit(type="result", cmd="modelcheck", ok=all(c["ok"] for c in checks), checks=checks)


# --------------------------------------------------------------- analyze ----

STAGES = [
    ("market_report", "Market analyst"),
    ("sentiment_report", "Sentiment analyst"),
    ("news_report", "News analyst"),
    ("fundamentals_report", "Fundamentals analyst"),
    ("debate", "Bull and bear debate"),
    ("investment_plan", "Research manager"),
    ("trader_investment_plan", "Trader"),
    ("risk", "Risk team debate"),
    ("final_trade_decision", "Portfolio manager"),
]


def _state_to_sections(state: dict) -> dict:
    inv = state.get("investment_debate_state") or {}
    risk = state.get("risk_debate_state") or {}
    return {
        "market": state.get("market_report", ""),
        "sentiment": state.get("sentiment_report", ""),
        "news": state.get("news_report", ""),
        "fundamentals": state.get("fundamentals_report", ""),
        "bull": inv.get("bull_history", ""),
        "bear": inv.get("bear_history", ""),
        "debate": inv.get("history", ""),
        "research_plan": state.get("investment_plan", ""),
        "trader_plan": state.get("trader_investment_plan", ""),
        "risk_aggressive": risk.get("aggressive_history", ""),
        "risk_conservative": risk.get("conservative_history", ""),
        "risk_neutral": risk.get("neutral_history", ""),
        "risk_history": risk.get("history", ""),
        "decision": state.get("final_trade_decision", ""),
        "memory_note": state.get("memory_note", ""),
        "portfolio_context": state.get("portfolio_context", ""),
    }


def _stream_one(graph, ticker, date, asset_type, portfolio, on_stage):
    """Run one analysis, reporting stages. Falls back to propagate() if the
    streaming internals are not what this wrapper was written against."""
    from tradingagents.dataflows.config import run_config

    if not all(hasattr(graph, a) for a in ("create_run_state", "stream_run", "record_decision", "propagator")):
        state, signal = graph.propagate(ticker, date, asset_type, portfolio=portfolio)
        return state, signal

    from tradingagents.agents.rating import run_rating
    from tradingagents.graph.trading_graph import _validate_trade_date

    date = _validate_trade_date(date)
    final_state = {}
    seen = {}
    with run_config(graph.config):
        init = graph.create_run_state(ticker, date, asset_type, portfolio)
        args = graph.propagator.get_graph_args()
        for messages, state in graph.stream_run(init, **args):
            for msg in messages or []:
                calls = getattr(msg, "tool_calls", None) or []
                if calls:
                    on_stage("activity", f"calling {', '.join(c.get('name', '?') for c in calls)}")
                elif getattr(msg, "type", "") == "ai" and getattr(msg, "content", ""):
                    on_stage("activity", _trunc(msg.content, 200))
            if not state:
                continue
            final_state.update(state)
            for key, title in STAGES:
                if key == "debate":
                    d = final_state.get("investment_debate_state") or {}
                    marker = d.get("count", 0)
                    text = d.get("current_response", "")
                elif key == "risk":
                    d = final_state.get("risk_debate_state") or {}
                    marker = d.get("count", 0)
                    text = d.get("latest_speaker", "")
                else:
                    text = final_state.get(key, "")
                    marker = len(text) if text else 0
                if marker and seen.get(key) != marker:
                    seen[key] = marker
                    on_stage("stage", key, title, _trunc(text, 400))
        graph.record_decision(ticker, date, final_state)
    return final_state, run_rating(final_state)


def cmd_analyze(req):
    from tradingagents.graph.trading_graph import TradingAgentsGraph

    cfg = build_config(req["settings"])
    ticker = req["ticker"].strip().upper()
    date = req["date"]
    analysts = req.get("analysts") or ["market", "social", "news", "fundamentals"]
    portfolio = build_portfolio(req.get("portfolio"))
    t0 = time.time()
    emit(type="start", ticker=ticker, date=date, analysts=analysts)

    def on_stage(kind, *a):
        if kind == "activity":
            emit(type="activity", text=a[0])
        else:
            emit(type="stage", key=a[0], title=a[1], text=a[2])

    graph = TradingAgentsGraph(selected_analysts=analysts, debug=False, config=cfg)
    state, signal = _stream_one(graph, ticker, date, req.get("asset_type", "stock"), portfolio, on_stage)

    rating = state.get("final_rating") or signal
    sections = _state_to_sections(state)
    brief = None
    try:
        emit(type="stage", key="briefing", title="Briefing", text="Condensing the reports into reasons for and against")
        try:
            llm = _deep_llm(cfg)
        except Exception as exc:
            sys.stderr.write(f"briefing: no model client: {exc}\n")
            llm = None
        brief = briefing.make(ticker, str(rating), sections, llm, log=lambda m: sys.stderr.write(m + "\n"))
    except Exception as exc:  # the briefing is an extra; the analysis stands without it
        sys.stderr.write(f"briefing failed: {exc}\n")
    report_dir = None
    try:
        report_dir = str(graph.save_reports(state, ticker, html=True))
    except Exception as exc:
        sys.stderr.write(f"save_reports failed: {exc}\n")

    emit(type="result", cmd="analyze", ticker=ticker, date=date, rating=str(rating),
         seconds=round(time.time() - t0, 1), sections=sections, brief=brief,
         price=last_close(ticker, date), report_dir=report_dir,
         model={"provider": cfg["llm_provider"], "quick": cfg["quick_think_llm"],
                "deep": cfg["deep_think_llm"], "debate_rounds": cfg["max_debate_rounds"]})


# -------------------------------------------------------------- backtest ----

def cmd_backtest(req):
    from tradingagents.backtest import iter_grid, run_backtest, summarize

    cfg = build_config(req["settings"])
    dates = iter_grid(req["start"], req["end"], int(req.get("every", 7)))
    tickers = [t.strip().upper() for t in req["tickers"] if t.strip()]
    analysts = tuple(req.get("analysts") or ("market", "social", "news", "fundamentals"))
    emit(type="start", cells=len(dates) * len(tickers), dates=dates, tickers=tickers)

    def progress(done, total, ticker, date):
        emit(type="progress", done=done, total=total, ticker=ticker, date=date)

    result = run_backtest(tickers, dates, cfg, portfolio=build_portfolio(req.get("portfolio")),
                          selected_analysts=analysts, run_id=req.get("run_id"), progress=progress)
    summary = summarize(result)
    emit(type="result", cmd="backtest", run_id=result.run_id, cells_run=result.cells_run,
         skipped=result.skipped, failures=[list(f) for f in result.failures],
         settlement_failures=[list(f) for f in result.settlement_failures],
         resolved=summary.resolved, pending=summary.pending, unscored=summary.unscored,
         holding=summary.holding,
         by_rating={k: {"count": v.count, "hit_rate": v.hit_rate, "mean_alpha": v.mean_alpha}
                    for k, v in summary.by_rating.items()},
         text=summary.render())


COMMANDS = {"doctor": cmd_doctor, "modelcheck": cmd_modelcheck, "analyze": cmd_analyze,
            "backtest": cmd_backtest, "prices": cmd_prices, "quote": cmd_quote, "brief": cmd_brief, "bars": cmd_bars, "calendar": cmd_calendar, "eventmove": cmd_eventmove}


def main():
    try:
        req = json.loads(sys.stdin.readline())
        fn = COMMANDS[req["cmd"]]
    except Exception as exc:
        emit(type="error", message=f"bad request: {exc}")
        return 2
    try:
        fn(req)
        return 0
    except SystemExit:
        raise
    except BaseException as exc:  # report, never hide
        emit(type="error", message=f"{type(exc).__name__}: {exc}", trace=traceback.format_exc()[-1800:])
        return 1


if __name__ == "__main__":
    with contextlib.suppress(BrokenPipeError):
        sys.exit(main())
