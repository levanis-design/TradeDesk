"""Turns the agents' reports into a short briefing: reasons for the rating, reasons against it,
and what would change the call.

The model only condenses. Every reason must carry a word-for-word quote from one of the reports,
and a reason whose quote cannot be found in the reports is dropped. If too few reasons survive,
plain rules pull sentences straight from the reports instead.
"""
from __future__ import annotations

import json
import re

SOURCES = ["decision", "trader", "research", "bull", "bear", "market", "sentiment", "news",
           "fundamentals", "risk"]

# section key in the analyze result -> briefing source name
SECTION_FOR = {
    "decision": "decision", "trader_plan": "trader", "research_plan": "research",
    "bull": "bull", "bear": "bear", "market": "market", "sentiment": "sentiment",
    "news": "news", "fundamentals": "fundamentals",
}

# how much of each report the model sees (characters). Local models have short context windows.
BUDGET = {"decision": 3200, "bull": 2200, "bear": 2200, "trader": 1400, "research": 1400,
          "market": 1200, "sentiment": 1000, "news": 1400, "fundamentals": 1400, "risk": 1600}

MIN_QUOTE = 12


def collect(sections: dict) -> dict:
    """source name -> full report text."""
    out = {}
    for key, src in SECTION_FOR.items():
        t = (sections.get(key) or "").strip()
        if t:
            out[src] = t
    risk = "\n".join((sections.get(k) or "").strip() for k in ("risk_aggressive", "risk_conservative", "risk_neutral")).strip()
    if risk:
        out["risk"] = risk
    return out


def norm(text: str) -> str:
    """Comparable form: no markdown, one kind of quote, single spaces, lower case."""
    t = str(text or "")
    t = re.sub(r"<think>.*?</think>", " ", t, flags=re.S | re.I)
    t = t.replace("‘", "'").replace("’", "'").replace("“", '"').replace("”", '"')
    t = t.replace("–", "-").replace("—", "-").replace("…", "...")
    t = re.sub(r"[*_`#>|]", " ", t)
    t = re.sub(r"\s+", " ", t)
    t = re.sub(r"\s+([:;,.)!?%])", r"\1", t)
    t = re.sub(r"([(\[$])\s+", r"\1", t)
    return t.strip().lower()


def clip(text: str, n: int) -> str:
    text = str(text or "").strip()
    return text if len(text) <= n else text[:n].rstrip() + " ..."


def build_prompt(ticker: str, rating: str, reports: dict) -> list:
    parts = []
    for src in SOURCES:
        if src in reports:
            parts.append(f"=== {src.upper()} ===\n{clip(reports[src], BUDGET.get(src, 1200))}")
    system = ("You condense trading research reports into a briefing for a busy reader. "
              "Use ONLY the text in the reports. Do not add facts, numbers or opinions of your own. "
              "Answer with one JSON object and nothing else.")
    user = (
        f"TRADEDESK_BRIEF\nTicker: {ticker}. The portfolio manager's rating is: {rating}.\n\n"
        + "\n\n".join(parts)
        + "\n\nWrite the briefing as JSON with exactly these keys:\n"
        '{"for": [{"reason": "...", "source": "...", "quote": "..."}],\n'
        ' "against": [{"reason": "...", "source": "...", "quote": "..."}],\n'
        ' "would_change": [{"reason": "...", "source": "...", "quote": "..."}]}\n'
        f"- \"for\": 3 to 5 reasons that support the rating {rating}.\n"
        "- \"against\": 2 to 4 reasons that argue against it, or risks.\n"
        "- \"would_change\": 1 to 3 events or readings that would change the call.\n"
        "- \"reason\": one plain sentence of at most 30 words.\n"
        f"- \"source\": one of {', '.join(s for s in SOURCES if s in reports)}.\n"
        "- \"quote\": 8 to 25 words copied EXACTLY, word for word, from that report. Never paraphrase the quote.\n"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def parse_json(text: str):
    t = re.sub(r"<think>.*?</think>", " ", str(text or ""), flags=re.S | re.I)
    t = re.sub(r"```(?:json)?", " ", t)
    a, b = t.find("{"), t.rfind("}")
    if a < 0 or b <= a:
        return None
    try:
        v = json.loads(t[a:b + 1])
    except Exception:
        return None
    return v if isinstance(v, dict) else None


def _verified(item, reports_norm):
    """Returns a clean reason dict if its quote really appears in a report, else None."""
    if not isinstance(item, dict):
        return None
    reason = " ".join(str(item.get("reason") or "").split())
    quote = " ".join(str(item.get("quote") or "").split())
    if len(reason) < 8 or len(quote) < MIN_QUOTE:
        return None
    q = norm(quote).strip(" .\"'")
    if len(q) < MIN_QUOTE:
        return None
    src = str(item.get("source") or "").strip().lower()
    order = ([src] if src in reports_norm else []) + [s for s in reports_norm if s != src]
    for s in order:
        if q in reports_norm[s]:
            return {"text": clip(reason, 240), "source": s, "quote": clip(quote, 300)}
    return None


def validate(parsed: dict, reports: dict) -> dict:
    reports_norm = {k: norm(v) for k, v in reports.items()}
    out = {"for": [], "against": [], "would_change": []}
    dropped = 0
    for side, cap in (("for", 5), ("against", 4), ("would_change", 3)):
        seen = set()
        for item in (parsed or {}).get(side) or []:
            v = _verified(item, reports_norm)
            if v is None:
                dropped += 1
                continue
            key = norm(v["text"])
            if key in seen:
                continue
            seen.add(key)
            out[side].append(v)
            if len(out[side]) >= cap:
                break
    out["dropped"] = dropped
    return out


# ------------------------------------------------------------- rule based ---

_SENT = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9(])")


def sentences(text: str, min_len=40, max_len=260, limit=8):
    t = re.sub(r"```.*?```", " ", str(text or ""), flags=re.S)
    t = re.sub(r"<think>.*?</think>", " ", t, flags=re.S | re.I)
    lines = []
    for line in t.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or set(line) <= set("-=_* |"):
            continue
        line = re.sub(r"^[-*•]\s+|^\d+[.)]\s+", "", line)
        line = re.sub(r"\*\*|__|`", "", line).strip()
        lines.append(line)
    out = []
    for line in lines:
        for s in _SENT.split(line):
            s = s.strip()
            if min_len <= len(s) <= max_len and not s.endswith(":"):
                out.append(s)
            if len(out) >= limit:
                return out
    return out


def fallback(reports: dict, rating: str) -> dict:
    """No model needed. Sentences are copied from the reports, so each one is its own quote."""
    def take(sources, n):
        got, seen = [], set()
        for src in sources:
            for s in sentences(reports.get(src, "")):
                k = norm(s)
                if k in seen:
                    continue
                seen.add(k)
                got.append({"text": clip(s, 240), "source": src, "quote": clip(s, 300)})
                if len(got) >= n:
                    return got
        return got

    return {
        "for": take(["decision", "research", "trader", "bull"], 4),
        "against": take(["bear", "risk"], 3),
        "would_change": [],
    }


def make(ticker: str, rating: str, sections: dict, llm=None, log=None) -> dict:
    """Returns {for, against, would_change, mode, dropped, note}. Never raises."""
    reports = collect(sections)
    result = {"for": [], "against": [], "would_change": [], "mode": "rules", "dropped": 0, "note": ""}
    if not reports:
        result["note"] = "No report text to summarise."
        return result
    if llm is not None:
        try:
            msg = llm.invoke(build_prompt(ticker, rating, reports))
            parsed = parse_json(getattr(msg, "content", msg))
            if parsed is None:
                result["note"] = "The model did not return usable JSON, so plain rules were used."
            else:
                v = validate(parsed, reports)
                result["dropped"] = v["dropped"]
                if len(v["for"]) >= 2 and len(v["against"]) >= 1:
                    result.update({"for": v["for"], "against": v["against"], "would_change": v["would_change"], "mode": "model"})
                    if v["dropped"]:
                        result["note"] = (f"{v['dropped']} point from the model could not be matched to the reports and was left out." if v['dropped'] == 1 else f"{v['dropped']} points from the model could not be matched to the reports and were left out.")
                    return result
                result["note"] = "Too few of the model's points could be matched to the reports, so plain rules were used."
        except Exception as exc:  # a failed briefing must never fail the analysis
            if log:
                log(f"briefing model call failed: {type(exc).__name__}: {exc}")
            result["note"] = "The model could not write the briefing, so plain rules were used."
    fb = fallback(reports, rating)
    result["for"], result["against"], result["would_change"] = fb["for"], fb["against"], fb["would_change"]
    return result
