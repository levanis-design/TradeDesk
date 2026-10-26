# Changelog

## 2.5.0
- Keep the Watchlist's current price and chart aligned with its buy-zone comparison after loading an older uploaded list.
- Exclude Python bytecode caches from packaged engine resources and local data files from Git.
- Validate calendar dates in local time zones; use the local date for uploaded-list checks and screenshot analyses. Screenshot generation stops if a sample analysis fails.
- **Upload a watchlist** from the Watchlist and from Analyze: an Excel or CSV file, or a pasted table, with Ticker, Today's price, Strong Buy, Good Buy, Acceptable, Avoid and Why it's priority. Only Ticker is required. Preview before saving, add or replace, and holdings are never changed.
- **Older lists.** Enter the date the list was made. The Watchlist compares the file's price, or the close on that date, with today's price.
- **Buy zones on the Watchlist.** A badge on each row and a panel in the detail show which zone today's price is in, when the zone is a number or a range. Zones written in words are shown and never compared.
- Tests: 6 new tests for the table reader and zone logic, 16 more interface checks.

## 2.4.0
- **Filings explained.** Click a filing and a window opens with what the form is, each item in plain words, the opening of the text actually filed, and the figure lines from the attached press release. New engine command `filing`; only sec.gov filing links are read, results cached 24 hours.
- **House reports summarized.** Click a member's name for what the report filed: transaction count, purchases against sales, companies, combined size as a range, late reports, options, and each line. Reports TradeDesk cannot read link to the original PDF.
- **PDF reader** is now a component in Setup, Components (optional, about 1 MB) that installs and checks `pypdf` by itself; layout-mode extraction is tried first.
- **Ticker drop-downs.** Company results has a drop-down of holdings and watchlist plus a box for any other ticker. Filings has Holdings, Watchlist and Both fill buttons.
- **Holdings and watchlist kept apart.** A Holdings, Watchlist, Both selector sits beside the sort on the Watchlist and on My tickers in Analyze (remembered per screen). Analyze can run the list shown. "Add all my holdings" is removed from the Watchlist; stocks you hold are marked and cannot be removed from there.
- **Hourly view on Holdings.** Quick buttons 1D, 1W, 1M, 3M, 1Y, 5Y with a percent change for the range; 1W and 1M use hourly bars. Hourly bars now allow a 5-day range.
- **Calendar panes.** The month and the agenda sit side by side and "What the market did" below; drag the dividers to resize, each pane scrolls on its own and refits the window. Agenda rows are compact and open on click.
- **Heat map** page after Calendar: about 100 large US companies by sector or your own tickers, four periods, colour plus printed percent, click to analyze. New engine command `heatmap`; Alt+number shortcuts shift by one after Calendar.
- Tests: 17 research tests, 14 component tests, 294 interface checks.

## 2.3.0
- New **Research** screen with four tabs: Filings (SEC 8-K, 10-Q and 10-K, items named in plain words), Company results (quarterly revenue, profit, EPS and margins from SEC data), Congress trades (House periodic transaction reports, amounts as ranges, reporting delay) and Price alerts (checked every five minutes while the app is open, one desktop notice each).
- New **What if** screen: a scenario calculator limited to cash you already hold. It shows the amount against cash and portfolio, the loss at set falls, five years of the stock's own history, your own loss limit and exit price in terms of how often and how far, and five options with the risk each one carries. It does not recommend an amount or rank the options, and an amount above your cash is refused.
- Setup has an SEC contact field (name and email), required by the SEC for filings and results. Engine install also adds the optional `pypdf` reader.
- Engine commands `filings`, `facts` and `congress` (`engine/research.py`). The parsing code is three files from day-trader-skill (MIT, commit 3d0f4ef), vendored unmodified in `engine/dts` with its licence; see THIRD_PARTY_NOTICES.md.
- Menu order is now Analyze, Watchlist, Holdings, Calendar, Research, What if, Track record; Alt+1 to Alt+9.
- Links to sec.gov and the House Clerk's site are added to the allow-list.
- Tests: 13 research tests on saved SEC and House samples, 11 risk-arithmetic tests, and 30 more interface checks.

## 2.2.0
- Calendar days now show labels, not only dots: up to three events per day, with a shape and colour for the type (circle company results, ring dividend, square Fed, diamond economic data, triangle options expiry, bar your events) and short text for who or what (ticker, Fed, CPI, Jobs, Expiry). A legend sits under the month.
- Calendar keeps a year of past events: company results with the reported figure against expectations and the announcement time, ex-dividend dates, Fed decisions, inflation and jobs releases, options expiry. Past days are shaded.
- New section under the calendar, "What the market did": pick a past day or press "See market move" on a past event. It shows the opening gap, the day itself, the next day and five trading days after, for the stock and the S&P 500 (or the S&P 500 and Nasdaq 100 for market-wide events), the difference from the market, a chart of the change from the close before the event, and, for events announced while the market was open within the last two months, the move after 30 minutes, 2 hours and to the close.
- Calendar: when the BLS feed refuses the request, the app now sends browser-style headers, reports the HTTP status, and falls back to saved release dates for the next jobs, inflation, producer price and job openings releases.
- README rewritten with screenshots (docs/images, regenerated by docs/make-screenshots.js from invented sample data) and a fuller description of every screen and of how an analysis works.
- `start.bat`: one double-click start for anyone who downloads the source. Checks for Node.js 22 or newer, offers to install it, installs the packages on first run, then starts the app. `.gitattributes` keeps the batch files in Windows line endings.
- Installer: `build-installer.bat` and a GitHub workflow build a Windows setup file with Electron bundled; folder choice, desktop and Start menu shortcuts.
- Includes the security review changes made in VS Code (see Unreleased notes below and SECURITY.md).

## Unreleased — security review (2026-10-25)
- Validate every IPC caller against the current window, main frame, and exact app document.
- Isolate the Python engine from ambient credentials, provider overrides, tracing settings, and import hooks.
- Require an exact trusted Ollama installer publisher, use unique temporary directories, and handle download stream failures.
- Treat spreadsheet account names as dictionary keys without inherited object properties.
- Reject external links containing embedded credentials or alternate ports and handle browser launch errors.
- Update the private Python package installer before installing engine dependencies.
- Run component and security regression tests in the default test suite; exclude credentials, dependencies, and generated artifacts from Git.

## 2.1.0
- Calendar is its own menu item (it was a tab under Track record).
- Menu has icons, folds to icons only (arrow or Ctrl+B, remembered), and Alt+1 to Alt+7 jump to a screen.
- Setup is compact and split into tabs: Components, Model and run settings, API keys, This computer.
- Setup installs what is missing: Python (winget), the engine, Ollama (download, signature check, install, start) and models (download with progress), one at a time or all at once. Each item says what it is for, its size and its source.
- Model downloads in This computer replace the copy-and-paste `ollama pull` command.
- README lists every app and tool used.

## 2.0.0
- Calendar tab under Track record: company results and dividend dates, Federal Reserve decisions, inflation and jobs releases, options expiry, plus events you add yourself.
- Draggable dividers on Analyze and the Watchlist; sizes are remembered.
- Holdings: sortable columns; current price and cost basis can be typed over; Refresh prices; candles with 1, 5, 15 minute, hour, day and week bars, for the portfolio or one holding.
- Fixed: the profit or loss chart overlapped a long negative label; Holdings no longer overflows sideways in a narrow window.
- New navigation: Analyze, Watchlist, Holdings, Track record; Setup and How it works in the footer. Setup shows a badge until the engine is installed and the model check has passed.
- Analyze redesigned as four panes with the Queue as a tab. Ticker statistics and a chart appear when a ticker is selected.
- Results open on a Briefing: the decision that is yours, reasons for and against with checked quotes, what would change the call, and how this model's rating did in your backtests. News tab added.
- Run depth: Fast, Standard, Thorough.
- Watchlist is a list with a detail pane. The blocking "run all" was replaced by queueing.
- Holdings: summary, allocation, profit or loss and holdings-over-time charts, live prices; import, paste and add-row moved below the table.
- Journal and Backtest merged into Track record, cross-linked.
- Launch notice on every start; How it works page.
- Engine: `quote` (prices, statistics, headlines) and `brief` commands; the briefing is a new stage of each run.

## 1.1.2
- Both the quick and the deep model are checked before a run; the message names the missing one.

## 1.1.1
- Time-left estimates per stage; waiting items show when they will finish.

## 1.1.0
- Queue, Cancel all, paste-from-spreadsheet import, columns Stock / QTY / Current Price / Purchase Price / Current total / Bought At / Profit/Loss.

## 1.0.x
- First releases and engine-install fixes.
