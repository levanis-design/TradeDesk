# TradeDesk 2.1.0

A Windows desktop app for market research with AI agents running on your own computer. It wraps the open-source [TradingAgents](https://github.com/TauricResearch/TradingAgents) framework, runs it with a local model through Ollama, feeds it your real holdings, and keeps a journal that scores the calls against what the market did.

See [SECURITY.md](SECURITY.md) for the October 25, 2026 security review, fixes, dependency audit results, and remaining limitations.

It is a research aid. It places no orders, has no broker connection, and its output is not financial advice.

## What it does

| Screen | Purpose |
|---|---|
| Analyze | A four-pane workspace. Left: a compact new-analysis form (ticker, date, depth), with the summary of the analysis underneath. Right top: the selected ticker's price, day and 52-week range, volume, market cap, P/E, beta, dividend yield, analyst target, next earnings and a chart with range buttons. Right bottom: My tickers (holdings, watchlist and recent analyses with sparklines and their latest rating) and Key information (your position and today's headlines). The **Queue** is the second tab on this page: line up several analyses, remove one, stop the running one, or press Cancel all. |
| Summary and Briefing | Every result starts with a plain-language briefing: a "decision for you" card that states the choice (for example "Add to your NVDA position, or leave it as it is?"), your position and cash, and cautions such as concentration or tax; then the reasons for the rating and the reasons against, and what would change the call. Each reason carries a quote from the agents' own reports, and TradeDesk checks the quote is really in those reports and drops any that is not. If the model's summary cannot be verified, simple rules write it instead and say so. Behind it: the full report with the portfolio manager's decision, bull and bear, risk team, analyst reports and a **News** tab (today's headlines plus what the News analyst made of the news). |
| Depth | Fast (market and news analysts, one debate round), Standard (your Setup choices) or Thorough (all four analysts, two rounds). Time-left estimates are kept separately for each. |
| Watchlist | List on the left; the selected ticker's chart and latest briefing on the right. Queue the whole list, or one ticker, from here. |
| Holdings | Summary tiles, an allocation chart, profit or loss by position, and a "holdings over time" chart. The chart can show a line or **candles**, for the whole portfolio or one holding, with each bar a minute (1, 5 or 15), an hour, a day or a week. It values the positions you hold **today** at past prices; it is not your account history, and whole-portfolio candle highs and lows are outer limits. Yahoo keeps minute bars for about a week, 5 and 15 minute bars for about 60 days and hourly bars for about two years. The positions table **sorts** on any column (click a header; click again to reverse, a third time to restore the original order). **Current price** and **Cost basis** can be typed over: a typed price is marked, kept when you save, used everywhere in the app, and the arrow beside it goes back to the live price. **Refresh prices** fetches new quotes, skipping the five minute cache. Below the table: import (Excel, CSV), paste from a spreadsheet, add a row and cash. The importer understands Stock, QTY, Current Price, Purchase Price, Current total, Bought At and Profit/Loss, merges accounts into one line per ticker and can add to your current holdings instead of replacing them. |
| Track record | **Journal** (every analysis; "Score outcomes" compares each call with the benchmark and compares following the rating with going against it) and **Backtest** (runs the agents over past dates). Each result also shows how that rating fared in your backtests on the same model, with the sample size. |
| Calendar | Its own item in the menu. Upcoming dates that can move prices, in a month grid and an agenda: quarterly results and dividend dates for your holdings and watchlist (Yahoo Finance), Federal Reserve rate decisions (federalreserve.gov, 2027 dates tentative), inflation, jobs, producer price and job-openings releases (Bureau of Labor Statistics), and options expiry (calculated). Each event says how much you hold of the ticker. Filter by type, or only your own tickers. Events with no fixed public date, such as product launches or conferences, are not in any free feed: add them with **Add an event**. It lists dates; it does not predict what the price will do. |
| Setup | Four tabs. **Components** lists everything TradeDesk needs (Python, the engine, Ollama, your models), marks what is missing, says in a line what each is for and how big it is, and installs it from the app: one button per item, or **Install everything missing**. **Model and run settings**, **API keys** and **This computer** (hardware, installed models, one-click model downloads). A badge shows on the menu until the engine is installed and the model check has passed. |
| How it works | What the app does, how to read a result, where the numbers come from, limits, and the terms of use. |

**Menu.** The left menu has an icon for every screen. The arrow beside the app name (or Ctrl+B) folds it to icons only; the choice is remembered. Alt+1 to Alt+7 jump to a screen in menu order (Analyze, Watchlist, Holdings, Calendar, Track record, Setup, How it works). Hovering an icon shows its name and shortcut.

Panes can be resized: drag any divider on Analyze (between the two sides, between the stats and the lists, between My tickers and Key information, between the form and the summary) or on the Watchlist. Arrow keys move a focused divider, double click resets it. Sizes are remembered on this computer.

On every launch a notice says the app is not a trading recommendation and gives no advice; you have to tick a box to continue.

**Time left.** Every running analysis shows the time left, in the Queue and the Analyze summary. Waiting items show when they should finish. The estimate follows the stages (each analyst, research manager, trader, portfolio manager, briefing) and uses your earlier runs on the same model and depth; with no history it is labelled a rough guess.

## Install and run

You need Windows 10 or 11 and Node.js 22 or newer to run from source (the packaged installer needs neither). Everything else can be installed from inside the app.

```
cd TradeDesk-v2.1.0
npm install
npm start
```

1. Open **Setup, Components**. It shows what is installed and what is missing. Press **Install everything missing**, or install items one at a time. In order: Python 3.12 (through Windows Package Manager), the TradingAgents engine (a private environment inside the app's data folder), Ollama (downloaded from ollama.com, its digital signature checked, then installed), and the model chosen in Model and run settings (downloaded through Ollama, with a progress bar).
2. Windows may ask for permission during the Python and Ollama installs; press Yes. Big downloads (a model is several GB) take a while.
3. Open **Model and run settings** and press "Save and check this model". Both the quick and the deep model must be installed in Ollama. All three checks (answers, tool calls, structured output) must pass.
4. Import your holdings on the Holdings page.
5. Run one analysis on a ticker you know well and read it critically.
6. Run a Backtest before trusting the model with anything that matters.

Where a component cannot be installed automatically (no Windows Package Manager, or a non-Windows computer), the row offers a link to the official download page instead. Git is optional and only used as a fallback for fetching the engine.

To build an installer: `npm run dist`.

## Apps and tools it uses

| Part | What it is | What TradeDesk uses it for | Where it comes from |
|---|---|---|---|
| Electron | Desktop app shell (Chromium and Node.js) | The window, menus, secure key storage | electronjs.org, MIT |
| Node.js | JavaScript runtime | Runs the build and tests; ships inside Electron | nodejs.org, MIT |
| Python 3.11 to 3.13 | Programming language | Runs the analysis engine | python.org (installed with winget) |
| [TradingAgents](https://github.com/TauricResearch/TradingAgents) 0.7.0, commit `e8f5503` | Open-source multi-agent research framework | The analysts, bull and bear researchers, trader and risk team | Apache-2.0, installed from GitHub |
| Ollama | Local model runner | Serves the language model on your computer | ollama.com, MIT; installer signature checked |
| A language model (for example qwen3, gpt-oss) | Open-weight model | Writes the analysis. Each model has its own licence; check it before commercial use | Ollama library |
| yfinance | Python library | Prices, history, company data, dividends and earnings dates from Yahoo Finance | Apache-2.0. Yahoo data is for personal use |
| LangChain, LangGraph | Python agent libraries | Pulled in by TradingAgents to run the agents | MIT |
| pandas, NumPy, stockstats | Python data libraries | Price maths and indicators | BSD, MIT |
| ExcelJS | JavaScript library | Reads Excel holdings files | MIT |
| electron-builder | Packaging tool | Builds the Windows installer | MIT |
| Windows Package Manager (winget) | Microsoft's installer | Installs Python (and Git, optionally) | Built into current Windows |
| Playwright with Chromium | Browser automation | Development only: the screenshot and interface tests | Apache-2.0 |
| Data sources | Yahoo Finance, SEC EDGAR, federalreserve.gov, bls.gov, optionally FRED and Alpha Vantage | Prices, filings, news, the Fed and economic calendars | Subject to each provider's terms |

Licences are summarised from each project's own statement and should be confirmed before you redistribute anything. TradeDesk does not bundle Python, Ollama or a model; it downloads them from their publishers when you ask.

## Your data

Everything is stored locally in the app's data folder (Setup shows the exact path, normally inside `%APPDATA%`): settings, holdings, watchlist, journal, saved runs and the engine environment. Optional API keys are encrypted with Windows (Electron safeStorage). If Windows secure storage is unavailable, a key is refused rather than written in plain text.

What leaves the computer: the engine fetches market data, filings and news from the sources TradingAgents uses (Yahoo Finance, SEC EDGAR, and optionally FRED and Alpha Vantage), and your ticker symbols are visible to those services. With a local model, no prompt or holding is sent to a model provider. With a cloud provider selected, prompts, which can include your holdings, go to that provider and are billed per use.

The app window has no network access of its own (Content Security Policy `connect-src 'none'`), renders model output as plain text only, and opens only an allow-listed set of links.

## Limits you should know about

- Language models can be confidently wrong. A rating is an argument, not a measurement. Read the bull and bear cases before acting.
- A small local model gives weaker analysis than a large hosted one, and a full run can take many minutes. The app records your run times and uses them for estimates.
- Scoring is only meaningful with many decisions. With fewer than 20 the app says so. Hold ratings claim no direction and are not counted as right or wrong.
- A backtest cannot rule out that the model has seen the period in its training data, and news and filings are not archived for past dates. Treat backtest numbers as indicative.
- The default holding window for TradingAgents' own outcome tracking is 5 trading days. The Journal needs at least that many trading days before it scores a call.
- Crypto: use Yahoo-style symbols such as `XRP-USD`. Small tokens may have no data.

## Tests

```
npm test            # logic, process, component and security tests, no Electron needed
npm run test:py     # briefing, market bars and calendar tests (requires pandas)
TD_PY=/path/to/venv/python NODE_PATH=$(npm root -g) npm run test:ui
```

`test:ui` loads the real interface in Chromium, drives the real IPC handlers and the real Python engine, and replaces the model with a fake local server and external market/social feeds with deterministic fixtures. It covers the launch notice, boot, setup, model check, holdings import and charts, the four-pane Analyze page, the briefing and its quote checks, news, queue, cancel, failure, watchlist, track record, backtest, link and path safety, and layout at three window sizes.

The UI harness requires Playwright and its Chromium browser. Set `TD_CHROMIUM` to use an existing compatible Chromium executable. The test fixtures replace instrument profiles, past-decision settlement prices, and prefetched sentiment feeds as well as UI quotes, so the fake-model run does not depend on live market or social data.

## Not verified

The automated suites cover the engine against TradingAgents at the pinned commit with a fake model, the interface in Chromium, and app logic and handlers. See [SECURITY.md](SECURITY.md) for the security review's exact verification scope.

The deterministic tests do not validate the following release and live-service behavior:

- Electron on Windows (window, installer, `npm run dist`)
- Engine installation on your computer. The installer logic (Python discovery, virtual environment, pinned source with a git fallback) is tested with fakes only. In the build environment TradingAgents was installed from a local clone of the same commit, because GitHub zip downloads were blocked there
- Real model behaviour: speed, tool calling and structured output on your model. The model check exists for this.
- Live market data through Yahoo Finance (prices, statistics, headlines, candles at each interval, company dates and the analyst target are Yahoo's, not TradeDesk's; their terms limit the data to personal use), including what a weekend or holiday as-of date returns
- The Bureau of Labor Statistics calendar feed (`bls.ics`). It is fetched at run time; its address and format are from memory of the public site and could not be checked here. If it fails, the Calendar says so and still shows the Fed, company and expiry dates
- Whether a real local model writes a briefing whose quotes survive the check. The check is tested with a fake model that invents one quote; real models will differ
- The `nvidia-smi` GPU reading and the memory-fit estimates
- Your real spreadsheet. The importer matches common column names and shows a preview, but your layout is data to be confirmed

## Layout

```
engine/tradedesk_engine.py   wraps TradingAgents; one job per process, JSON lines on stdout
src/main.js, ipc.js          Electron shell and handlers
src/holdings.js              CSV and Excel import, merge, average cost
src/scoring.js               journal scoring
src/profiles.js              Fast, Standard and Thorough depths
engine/briefing.py           the reasons-for-and-against briefing with checked quotes
src/store.js                 local files, encrypted keys
src/setup.js                 Python discovery and engine install
renderer/                    interface (no inner HTML, no remote content)
renderer/advice.js           the "decision for you" wording (fixed rules, no model)
renderer/portfolio.js        allocation, profit or loss, holdings-over-time maths
renderer/charts.js           small SVG charts (line, candles, donut, bars)
renderer/calendar.js         the Calendar tab
renderer/split.js            draggable dividers
tests/                       logic tests, process tests, UI harness, fake model server
```
