"""Research commands for TradeDesk: SEC filings, reported results, House disclosures.

Reads public records only. Nothing here says whether to buy or sell.
The parsing code in ./dts is vendored from day-trader-skill (MIT).
"""
from __future__ import annotations

import datetime as dt
import html.parser
import json
import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dts import facts as dfacts  # noqa: E402
from dts import news as dnews  # noqa: E402
from dts import ptr as dptr  # noqa: E402

TICKER_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")
NEED_UA = ("The SEC asks every program to identify itself. Open Setup, enter your name and "
           "email under SEC contact, and try again.")


class ResearchError(Exception):
    pass


def clean_tickers(raw, limit=25):
    out = []
    for t in raw or []:
        t = str(t).strip().upper()
        if TICKER_RE.match(t) and t not in out:
            out.append(t)
    return out[:limit]


def valid_ua(ua):
    ua = (ua or "").strip()
    return ua if ua and "@" in ua and dnews.PLACEHOLDER not in ua and len(ua) <= 200 else None


def _item_labels(items):
    return [{"code": c, "label": dnews.ITEMS_8K.get(c, "item " + c),
             "important": c in dnews.IMPORTANT_ITEMS} for c in items or []]


# ---------------------------------------------------------------- filings

def filings(req, fetcher=None):
    tickers = clean_tickers(req.get("tickers"))
    if not tickers:
        raise ResearchError("Add at least one ticker.")
    ua = valid_ua(req.get("secUserAgent"))
    if fetcher is None:
        if not ua:
            raise ResearchError(NEED_UA)
        fetcher = dnews.Fetcher(sec_ua=ua)
    forms = [f for f in (req.get("forms") or ["8-K"]) if f in ("8-K", "10-Q", "10-K")] or ["8-K"]
    count = max(1, min(int(req.get("count") or 10), 20))
    days = max(1, min(int(req.get("days") or 90), 365))
    state, errors = {}, []
    items = _sec_only(fetcher, tickers, state, forms, count, errors)
    cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)).timestamp()
    out = []
    for it in items:
        ts = _ts(it.get("time"))
        if ts is not None and ts < cutoff:
            continue
        out.append({"ticker": it["ticker"], "form": it.get("form"), "title": it.get("title"),
                    "summary": it.get("summary"), "link": it.get("link"), "time": _iso(it.get("time")),
                    "important": bool(it.get("important")), "items": _item_labels(it.get("items"))})
    out.sort(key=lambda r: r["time"] or "", reverse=True)
    return {"items": out, "errors": errors, "tickers": tickers, "days": days}


def _sec_only(fetcher, tickers, state, forms, count, errors):
    items = []
    try:
        ciks = dnews.cik_map(fetcher, state)
    except dnews.NewsError as exc:
        errors.append("SEC ticker list: %s" % exc)
        return items
    for t in tickers:
        cik = ciks.get(t)
        if not cik:
            errors.append("%s is not in the SEC list (funds and some foreign listings have no filings here)" % t)
            continue
        for form in forms:
            try:
                data = fetcher.get(dnews.SEC_FEED % (cik, form, count), "sec-%s-%s.xml" % (form, cik), sec=True)
                items += dnews.parse_sec_atom(data, t)
            except dnews.NewsError as exc:
                errors.append("%s %s: %s" % (t, form, exc))
    return items


def _iso(value):
    if isinstance(value, dt.datetime):
        return value.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return value


def _ts(value):
    if value is None:
        return None
    if isinstance(value, dt.datetime):
        return value.timestamp()
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return dt.datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


# ---------------------------------------------------------------- facts

def company_facts(req, fetcher=None):
    ticker = clean_tickers([req.get("ticker")])
    if not ticker:
        raise ResearchError("Enter a ticker.")
    ticker = ticker[0]
    if fetcher is None:
        ua = valid_ua(req.get("secUserAgent"))
        if not ua:
            raise ResearchError(NEED_UA)
        fetcher = dfacts.Fetcher(ua=ua)
    try:
        cik_name = dfacts.ticker_ciks(fetcher).get(ticker)
        if not cik_name:
            raise ResearchError("%s is not in the SEC list. Funds and some foreign listings file no results here." % ticker)
        cik, name = cik_name
        cf = fetcher.json(dfacts.FACTS_URL % cik, "companyfacts-CIK%s.json" % cik)
        res = dfacts.analyse(cf, quarters=int(req.get("quarters") or 6), name=name)
        try:
            sub = fetcher.json(dfacts.SUBMISSIONS_URL % cik, "submissions-CIK%s.json" % cik)
            fil = dfacts.latest_filings(sub, cik, fetcher)
        except dfacts.FactsError:
            fil = {"report": None, "earnings_8k": None}
    except dfacts.FactsError as exc:
        raise ResearchError(str(exc))
    return {"ticker": ticker, "entity": res["entity"], "cik": res["cik"], "rows": res["rows"],
            "ttm": res["ttm"], "changes": dfacts.changes(res), "filings": fil,
            "stale": dfacts.stale_note(res, fil)}


# ---------------------------------------------------------------- congress

def pdf_text(path):
    text = dptr.pdf_to_text(path)
    if text:
        return text
    try:
        from pypdf import PdfReader  # optional
    except ImportError:
        return None
    try:
        pages = PdfReader(path).pages
        try:
            return "\n".join((p.extract_text(extraction_mode="layout") or "") for p in pages)
        except TypeError:  # an older pypdf has no layout mode
            return "\n".join((p.extract_text() or "") for p in pages)
    except Exception:  # noqa: BLE001 - a damaged PDF must not stop the list
        return None


def congress(req, index_loader=None, report_loader=None):
    year = int(req.get("year") or dt.date.today().year)
    members = [m for m in (req.get("members") or []) if str(m).strip()][:10]
    tickers = set(clean_tickers(req.get("tickers")))
    since = req.get("since") or (dt.date.today() - dt.timedelta(days=int(req.get("days") or 60))).isoformat()
    limit = max(1, min(int(req.get("limit") or 12), 25))
    cache = req.get("cacheDir") or os.path.join(tempfile.gettempdir(), "tradedesk-ptr")
    index_loader = index_loader or (lambda y: dptr.load_index(y))
    report_loader = report_loader or (lambda row: _read_report(row, cache))
    try:
        rows = index_loader(year)
    except dptr.PtrError as exc:
        raise ResearchError("House disclosure index: %s" % exc)
    picked = dptr.select(rows, members or None, kind="P", since=since)
    total = len(picked)
    reports, errors, unread = [], [], 0
    for row in picked[:limit]:
        try:
            rep = report_loader(row)
        except dptr.PtrError as exc:
            errors.append("%s: %s" % (row["name"], exc))
            continue
        if rep is None:
            unread += 1
            reports.append(_stub(row))
            continue
        trades = [t for t in rep["rows"] if not tickers or (t.get("ticker") or "") in tickers]
        if tickers and not trades:
            continue
        reports.append({"doc_id": row["doc_id"], "name": row["name"], "district": row["district"],
                        "filed": row["filed"], "url": row["url"], "trades": trades, "read": True})
    return {"reports": reports, "errors": errors, "unread": unread, "total": total,
            "shown": len(reports), "year": year, "since": since}


def _stub(row):
    return {"doc_id": row["doc_id"], "name": row["name"], "district": row["district"],
            "filed": row["filed"], "url": row["url"], "trades": [], "read": False}


def _read_report(row, cache):
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, re.sub(r"[^0-9A-Za-z]", "", row["doc_id"]) + ".pdf")
    if not os.path.isfile(path):
        data = dptr.download(row["url"])
        if not data.startswith(b"%PDF"):
            raise dptr.PtrError("document %s was not a PDF" % row["doc_id"])
        with open(path, "wb") as fh:
            fh.write(data)
    text = pdf_text(path)
    if not text:
        return None
    return dptr.parse_ptr_text(text, filed=row["filed"])


# ---------------------------------------------------------------- one filing, read

ITEM_MEANING = {
    "1.01": "The company signed an important agreement outside its normal business, such as a large contract, partnership or financing.",
    "1.02": "An important agreement ended or was cancelled.",
    "1.03": "The company, or a main subsidiary, filed for bankruptcy or had a receiver appointed.",
    "1.05": "A cybersecurity incident was judged material and is being disclosed.",
    "2.01": "The company completed buying or selling a significant business or set of assets.",
    "2.02": "The company reported its financial results for a period. The press release usually carries the figures.",
    "2.03": "The company took on a significant new debt or other financial obligation.",
    "2.04": "A trigger event made a debt payable early, or raised an obligation.",
    "2.05": "The company committed to a restructuring, such as closing sites or cutting jobs, and expects costs.",
    "2.06": "The company concluded that an asset is worth materially less than recorded (an impairment).",
    "3.01": "The exchange told the company it no longer meets listing rules, or the company is moving its listing.",
    "3.02": "The company sold shares or other securities without a public registration.",
    "3.03": "The rights of shareholders changed, for example through a charter or bylaw change.",
    "4.01": "The company changed its outside auditor.",
    "4.02": "The company said past financial statements should no longer be relied on, usually because of errors.",
    "5.01": "Control of the company changed hands.",
    "5.02": "A director or senior officer joined, left or changed pay arrangements.",
    "5.03": "The company changed its bylaws or its fiscal year.",
    "5.07": "Shareholders voted, and these are the results.",
    "7.01": "The company released information to everyone at once under the fair disclosure rule, often a presentation.",
    "8.01": "Other events the company chose to report.",
    "9.01": "Lists the attached documents and financial statements. It carries no news by itself.",
}
FORM_MEANING = {
    "8-K": "A current report: the company tells the SEC about an event soon after it happens.",
    "8-K/A": "An amendment to an earlier current report, correcting or adding to it.",
    "10-Q": "The quarterly report, with unaudited financial statements and management's discussion.",
    "10-K": "The annual report, with audited financial statements, risks and business description.",
}
FILING_LINK = re.compile(r"^https://www\.sec\.gov/Archives/edgar/data/(\d{1,10})/(\d{18})/(\d{10}-\d{2}-\d{6})-index\.html?$")
EXHIBIT_FILE = re.compile(r"(^|[-_/])ex[-_]?\d|exhibit|^R\d+\.htm$|-index", re.I)


class _Text(html.parser.HTMLParser):
    BLOCK = {"p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "table", "title"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "head"):
            self.skip += 1
        if tag in self.BLOCK:
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "head"):
            self.skip = max(0, self.skip - 1)
        if tag in self.BLOCK:
            self.out.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.out.append(data)


def html_text(raw):
    p = _Text()
    p.feed(raw if isinstance(raw, str) else raw.decode("utf-8", "replace"))
    text = "".join(p.out).replace("\xa0", " ")
    lines = [" ".join(x.split()) for x in text.split("\n")]
    return "\n".join(x for x in lines if x)


ITEM_HEAD = re.compile(r"^Item\s+(\d\.\d{2})\.?\s*(.*)$", re.I | re.M)
NUMBERY = re.compile(r"\$\s?[\d.,]+|\b\d[\d,.]*\s?(?:%|percent|million|billion)", re.I)
KEY_WORDS = re.compile(r"revenue|net sales|net income|earnings per|per diluted share|operating income|gross margin|guidance|outlook|dividend|repurchase|record", re.I)


def split_items(text):
    """Item sections of an 8-K as {code: text}, ignoring the table of contents and signatures."""
    marks = [(m.start(), m.end(), m.group(1), m.group(2)) for m in ITEM_HEAD.finditer(text)]
    out = {}
    for i, (st, en, code, rest) in enumerate(marks):
        stop = marks[i + 1][0] if i + 1 < len(marks) else len(text)
        body = (rest + "\n" + text[en:stop]).strip()
        body = re.split(r"\n\s*SIGNATURES?\s*\n", body, flags=re.I)[0]
        if len(body) > len(out.get(code, "")):
            out[code] = body
    return out


def key_lines(text, limit=6):
    """Sentences from a press release that carry a figure and a result word, in plain order."""
    seen, out = set(), []
    for sent in re.split(r"(?<=[.!?])\s+|\n", text):
        sent = " ".join(sent.split())
        if 40 <= len(sent) <= 320 and NUMBERY.search(sent) and KEY_WORDS.search(sent) and sent not in seen:
            seen.add(sent)
            out.append(sent)
        if len(out) >= limit:
            break
    return out


def _clip(text, n):
    text = text.strip()
    return text if len(text) <= n else text[: n - 1].rsplit(" ", 1)[0] + "…"


def filing_detail(req, fetcher=None):
    link = str(req.get("link") or "")
    m = FILING_LINK.match(link)
    if not m:
        raise ResearchError("That is not a filing link on sec.gov.")
    cik, folder_id, acc = int(m.group(1)), m.group(2), m.group(3)
    form = str(req.get("form") or "")[:8]
    if fetcher is None:
        ua = valid_ua(req.get("secUserAgent"))
        if not ua:
            raise ResearchError(NEED_UA)
        fetcher = dnews.Fetcher(sec_ua=ua)
    base = "https://www.sec.gov/Archives/edgar/data/%d/%s/" % (cik, folder_id)
    out = {"form": form, "link": link, "meaning": FORM_MEANING.get(form, ""), "sections": [], "exhibit": None, "notes": []}
    if not form.startswith("8-K"):
        out["notes"].append("The text of a %s is long. Use Open on sec.gov to read it, and the Company results tab for the reported numbers." % (form or "report"))
        return out
    try:
        idx = json.loads(fetcher.get(base + "index.json", "filing-%s/index.json" % acc, sec=True).decode("utf-8"))
        names = [it["name"] for it in idx.get("directory", {}).get("item", [])]
    except (dnews.NewsError, ValueError, KeyError) as exc:
        raise ResearchError("Could not read the filing's file list: %s" % exc)
    docs = [n for n in names if n.lower().endswith((".htm", ".html")) and not EXHIBIT_FILE.search(n)]
    primary = sorted(docs)[0] if docs else None
    if not primary:
        raise ResearchError("The filing has no readable main document.")
    try:
        text = html_text(fetcher.get(base + primary, "filing-%s/%s" % (acc, primary), sec=True)[:2_000_000])
    except dnews.NewsError as exc:
        raise ResearchError("Could not read the filing: %s" % exc)
    for code, body in split_items(text).items():
        if code == "9.01":
            continue
        out["sections"].append({"code": code, "label": dnews.ITEMS_8K.get(code, "item " + code),
                                "important": code in dnews.IMPORTANT_ITEMS,
                                "meaning": ITEM_MEANING.get(code, ""), "text": _clip(body, 1500)})
    ex = dfacts.exhibit_name(names, primary)
    if ex:
        try:
            etext = html_text(fetcher.get(base + ex, "filing-%s/%s" % (acc, ex), sec=True)[:2_000_000])
            out["exhibit"] = {"name": ex, "url": base + ex, "lines": key_lines(etext), "start": _clip(etext, 700)}
        except dnews.NewsError as exc:
            out["notes"].append("The attached press release could not be read: %s" % exc)
    if not out["sections"]:
        out["notes"].append("No item sections were found in the main document. Open it on sec.gov.")
    return out
