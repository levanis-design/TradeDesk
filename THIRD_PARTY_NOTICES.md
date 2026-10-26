# Third-party notices

TradeDesk includes or depends on the following. Each keeps its own licence. This list is a summary and should be confirmed before you redistribute TradeDesk.

## Included in this repository

### day-trader-skill (MIT)

`engine/dts/news.py`, `engine/dts/facts.py` and `engine/dts/ptr.py` are unmodified copies from
https://github.com/Jakeschincariol/day-trader-skill at commit `3d0f4ef6986f4984b7c6bd46f7ff4f87744c3abd`.
TradeDesk uses their parsing and analysis functions for SEC filings, SEC company facts and House periodic transaction reports. It does not use their command-line entry points, skill files, broker or order tools, or trading logic.

The test fixtures in `tests/fixtures/dts` are copied from the same repository's `tests/fixtures`.

The licence text is in `engine/dts/LICENSE`:

```
MIT License

Copyright (c) 2026 Jake Schincariol

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Installed or downloaded separately

| Project | Licence | Used for |
|---|---|---|
| TradingAgents (Tauric Research), commit e8f5503 | Apache-2.0 | The analysis agents |
| Electron | MIT | The desktop shell |
| ExcelJS | MIT | Reading Excel holdings files |
| yfinance | Apache-2.0 | Yahoo Finance prices and company data |
| pandas, NumPy | BSD | Price maths |
| pypdf (optional) | BSD-3-Clause | Reading House disclosure PDFs |
| Ollama | MIT | Running local models |

Each language model has its own licence; check it before commercial use. Data from Yahoo Finance, SEC EDGAR, the House Clerk, the Federal Reserve and the Bureau of Labor Statistics is subject to each provider's terms.
