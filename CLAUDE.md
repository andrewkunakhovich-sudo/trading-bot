# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
node bot.js                # Run the trading bot (one execution cycle)
node bot.js --tax-summary  # Print trade totals and fees from trades.csv
npm start                  # Alias for node bot.js
```

No build step, no test suite, no linter configured.

**Cloud deployment (Railway):**
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

## Architecture

The entire bot is a single file: `bot.js`. It runs one complete cycle per invocation — fetch data, evaluate safety check, optionally place an order, write logs — then exits. Railway calls it on a cron schedule.

### Execution flow

```
checkOnboarding()       → validates .env exists and credentials are present
fetchCandles()          → Kraken public API (crypto) or Yahoo Finance (stocks)
calcEMA / calcRSI / calcVWAP  → all indicators computed in-process, no TA library
runSafetyCheck()        → evaluates bias (bullish/bearish/neutral), then checks each entry rule
checkTradeLimits()      → enforces MAX_TRADES_PER_DAY and MAX_TRADE_SIZE_USD
placeBitGetOrder()      → REST call to BitGet, signed with HMAC-SHA256
saveLog()               → appends to safety-check-log.json
writeTradeCsv()         → appends to trades.csv
```

### Configuration

- **`rules.json`** — strategy definition (indicators, entry rules, exit rules, risk rules). The safety check reads `entry_rules` from this file; changing `rules.json` changes what conditions must pass.
- **`.env`** — credentials and trading limits. Key variables: `BITGET_API_KEY`, `BITGET_SECRET_KEY`, `BITGET_PASSPHRASE`, `PAPER_TRADING`, `SYMBOL`, `SYMBOLS` (comma-separated for multi-symbol), `STOCKS` (comma-separated Yahoo tickers), `TIMEFRAME`, `PORTFOLIO_VALUE_USD`, `MAX_TRADE_SIZE_USD`, `MAX_TRADES_PER_DAY`, `TRADE_MODE` (spot or futures).

### Paper vs live trading

`PAPER_TRADING=true` (the default) logs every decision and writes CSV rows but never calls the BitGet order endpoint. Set to `false` to go live.

### Market data sources

- **Crypto:** Binance public klines API — no API key needed. Symbol already in `BTCUSDT` format, intervals lowercase (`1m`, `1h`, `4h`, etc).
- **Stocks:** Yahoo Finance `/v8/finance/chart/` — no API key needed, always run as paper trades regardless of `PAPER_TRADING`.

### Local TradingView integration

When run locally (not Railway), `switchTradingViewChart()` connects to TradingView Desktop via Chrome DevTools Protocol on `localhost:9222` using a WebSocket. If TradingView isn't open, it silently skips. This is cosmetic only — the bot navigates the chart to the traded symbol so you can watch live.

### Output files

| File | Written by | Purpose |
|------|-----------|---------|
| `safety-check-log.json` | `saveLog()` | Full decision log — every run, every condition result |
| `trades.csv` | `writeTradeCsv()` | Tax-ready record — every run including blocked decisions |
| `trades-data.json` | `writeFileSync` at end of `run()` | Snapshot of `log.trades` for the live dashboard |

### Utility scripts (`.mjs`)

Standalone one-shot scripts not part of the bot loop: `goto-btc.mjs`, `goto-sol.mjs`, `chart-control.mjs`, `open-trade-panel.mjs`, `plot-trades.mjs`, `inspect-tv.mjs`, `enable-paper-trading.mjs`, `dashboard-server.mjs`. Each uses CDP to control TradingView directly.

### Prompts

- `prompts/01-extract-strategy.md` — paste YouTube transcript(s) here; Claude Code generates a `rules.json` from them
- `prompts/02-one-shot-trade.md` — full onboarding prompt; paste into Claude Code to walk through setup end-to-end
