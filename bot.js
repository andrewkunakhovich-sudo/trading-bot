/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs safety check,
 * executes via BitGet if everything lines up.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { join } from "path";
import crypto from "crypto";
import { execSync } from "child_process";
import WebSocket from "ws";

// All persistent data files live here — on Railway this is a mounted volume so
// they survive redeployments. Locally defaults to current directory.
const DATA_DIR = process.env.DATA_DIR || ".";

// ─── Alerts (Telegram / Discord) ─────────────────────────────────────────────

async function sendAlert(msg) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (token && chatId) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: msg }),
      });
    } catch {}
  }
  if (webhook) {
    try {
      await fetch(webhook, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: msg }),
      });
    } catch {}
  }
}

// ─── News Sentiment ──────────────────────────────────────────────────────────

const NEWS_FEEDS = {
  crypto: [
    "https://cointelegraph.com/rss",
    "https://coindesk.com/arc/outboundfeeds/rss/",
  ],
  stocks: [
    "https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC&region=US&lang=en-US",
    "https://feeds.reuters.com/reuters/businessNews",
  ],
};

async function fetchNewsHeadlines(isCrypto) {
  const feeds = isCrypto ? NEWS_FEEDS.crypto : NEWS_FEEDS.stocks;
  const headlines = [];
  const cutoff = Date.now() - 30 * 60 * 1000; // last 30 minutes

  for (const url of feeds) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const text = await res.text();
      const items = [...text.matchAll(/<item>([\s\S]*?)<\/item>/g)];
      for (const [, item] of items) {
        const title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]
          || item.match(/<title>(.*?)<\/title>/)?.[1] || "";
        const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || "";
        const date = pubDate ? new Date(pubDate).getTime() : Date.now();
        if (date >= cutoff && title) headlines.push(title.trim());
      }
    } catch {
      // feed unavailable — skip
    }
  }
  return headlines;
}

async function analyzeNewsSentiment(symbol, headlines) {
  if (!process.env.GROQ_API_KEY || headlines.length === 0) return { sentiment: "neutral", confidence: "low", reason: "no headlines" };

  const coin = symbol.replace("USDT", "").replace("USD", "");
  const relevant = headlines.filter(h => h.toLowerCase().includes(coin.toLowerCase()) || h.toLowerCase().includes("crypto") || h.toLowerCase().includes("bitcoin"));
  if (relevant.length === 0) return { sentiment: "neutral", confidence: "low", reason: "no relevant headlines" };

  const prompt = `You are a trading news analyst. Analyze these recent headlines for ${coin} and return ONLY a JSON object with keys: sentiment ("positive", "negative", or "neutral"), confidence ("high", "medium", or "low"), reason (one short sentence).

Headlines:
${relevant.slice(0, 5).map((h, i) => `${i + 1}. ${h}`).join("\n")}

Return only valid JSON, nothing else.`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama3-8b-8192",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 150,
      }),
    });
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || "{}";
    const json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
    return { sentiment: json.sentiment || "neutral", confidence: json.confidence || "low", reason: json.reason || "" };
  } catch {
    return { sentiment: "neutral", confidence: "low", reason: "sentiment analysis failed" };
  }
}

// ─── Fear & Greed Index ──────────────────────────────────────────────────────

async function fetchFearGreed() {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1");
    const data = await res.json();
    const item = data.data?.[0];
    return { value: parseInt(item?.value || 50), label: item?.value_classification || "Neutral" };
  } catch { return { value: 50, label: "Neutral" }; }
}

// ─── Economic Calendar ────────────────────────────────────────────────────────

async function fetchEconomicEvents() {
  try {
    const res = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", { headers: { "User-Agent": "Mozilla/5.0" } });
    const events = await res.json();
    const now = Date.now();
    const window = 30 * 60 * 1000;
    return events.filter(e => e.impact === "High" && Math.abs(new Date(e.date).getTime() - now) < window);
  } catch { return []; }
}

// ─── Social Sentiment (Stocktwits) ───────────────────────────────────────────

async function fetchSocialSentiment(symbol) {
  const stwSymbol = symbol.replace("USDT", "").replace("USD", "") + ".X";
  try {
    const res = await fetch(`https://api.stocktwits.com/api/2/streams/symbol/${stwSymbol}.json`);
    const data = await res.json();
    const messages = data.messages || [];
    const bullish = messages.filter(m => m.entities?.sentiment?.basic === "Bullish").length;
    const bearish = messages.filter(m => m.entities?.sentiment?.basic === "Bearish").length;
    const total = bullish + bearish;
    if (total === 0) return { sentiment: "neutral", bullishPct: 50 };
    const bullishPct = Math.round(bullish / total * 100);
    return { sentiment: bullishPct > 60 ? "bullish" : bullishPct < 40 ? "bearish" : "neutral", bullishPct };
  } catch { return { sentiment: "neutral", bullishPct: 50 }; }
}

// ─── On-Chain / Global Market Data (CoinGecko) ───────────────────────────────

async function fetchOnChainData() {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/global");
    const data = await res.json();
    const g = data.data;
    return {
      btcDominance: g.market_cap_percentage?.btc || 50,
      marketChange24h: g.market_cap_change_percentage_24h_usd || 0,
    };
  } catch { return null; }
}

// ─── Self-Learning ────────────────────────────────────────────────────────────

const LEARNED_FILE = join(DATA_DIR, "learned-adjustments.json");

function loadLearned() {
  if (!existsSync(LEARNED_FILE)) return { excludedSymbols: [], positionMultipliers: {} };
  try { return JSON.parse(readFileSync(LEARNED_FILE, "utf8")); } catch { return { excludedSymbols: [], positionMultipliers: {} }; }
}

// ─── Weekly Loss Limit ────────────────────────────────────────────────────────

function getWeeklyPnl() {
  const data = loadDailyPnl();
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  return Object.entries(data)
    .filter(([date]) => new Date(date) >= weekAgo)
    .reduce((sum, [, d]) => sum + (d.total || 0), 0);
}

// ─── Per-Symbol Cooldowns ─────────────────────────────────────────────────────

const COOLDOWNS_FILE = join(DATA_DIR, "cooldowns.json");

function loadCooldowns() {
  if (!existsSync(COOLDOWNS_FILE)) return {};
  try { return JSON.parse(readFileSync(COOLDOWNS_FILE, "utf8")); } catch { return {}; }
}

function saveCooldowns(c) { writeFileSync(COOLDOWNS_FILE, JSON.stringify(c, null, 2)); }

function isOnCooldown(symbol) {
  const c = loadCooldowns()[symbol];
  if (!c) return false;
  return new Date(c.pauseUntil) > new Date();
}

function recordLoss(symbol) {
  const cooldowns = loadCooldowns();
  if (!cooldowns[symbol]) cooldowns[symbol] = { consecutiveLosses: 0, pauseUntil: null };
  cooldowns[symbol].consecutiveLosses++;
  if (cooldowns[symbol].consecutiveLosses >= 3) {
    const until = new Date(Date.now() + 24 * 60 * 60 * 1000);
    cooldowns[symbol].pauseUntil = until.toISOString();
    console.log(`  🔴 ${symbol} on 24h cooldown after 3 consecutive losses.`);
  }
  saveCooldowns(cooldowns);
}

function recordWin(symbol) {
  const cooldowns = loadCooldowns();
  if (cooldowns[symbol]) { cooldowns[symbol].consecutiveLosses = 0; saveCooldowns(cooldowns); }
}

// ─── Order Book Imbalance (OKX) ───────────────────────────────────────────────

async function fetchOrderBookImbalance(symbol) {
  try {
    const okxSymbol = OKX_SYMBOL_MAP[symbol] || symbol;
    const instId = okxSymbol.replace("USDT", "-USDT");
    const res = await fetch(`https://www.okx.com/api/v5/market/books?instId=${instId}&sz=20`);
    const data = await res.json();
    if (data.code !== "0") return null;
    const book = data.data?.[0];
    if (!book) return null;
    const bidVol = book.bids.reduce((s, b) => s + parseFloat(b[1]), 0);
    const askVol = book.asks.reduce((s, a) => s + parseFloat(a[1]), 0);
    const total = bidVol + askVol;
    return total > 0 ? bidVol / total : 0.5;
  } catch { return null; }
}

// ─── Alpaca Stock Execution ───────────────────────────────────────────────────

async function placeAlpacaOrder(symbol, side, qty) {
  if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) return null;
  const res = await fetch("https://paper-api.alpaca.markets/v2/orders", {
    method: "POST",
    headers: {
      "APCA-API-KEY-ID": process.env.ALPACA_API_KEY,
      "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ symbol, qty: qty.toFixed(4), side, type: "market", time_in_force: "day" }),
  });
  const data = await res.json();
  if (data.code) throw new Error(`Alpaca error: ${data.message}`);
  return data;
}

// ─── TradingView Chart Switcher ───────────────────────────────────────────────

async function switchTradingViewChart(symbol) {
  try {
    const res = await fetch("http://localhost:9222/json");
    if (!res.ok) return;
    const pages = await res.json();
    const chart = pages.find(p => p.url && p.url.includes("tradingview.com/chart"));
    if (!chart) return;

    // Map symbol to TradingView format (BTCUSDT → BITSTAMP:BTCUSD)
    const tvSymbol = symbol
      .replace("USDT", "USD")
      .replace("BTC", "BTC");
    const tvUrl = `https://www.tradingview.com/chart/?symbol=KRAKEN:${tvSymbol}&interval=1`;

    const ws = new WebSocket(chart.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression: `window.location.href = '${tvUrl}';` }
        }));
        setTimeout(() => { ws.close(); resolve(); }, 1000);
      });
      ws.on("error", reject);
    });
    console.log(`  📺 TradingView switched to ${tvSymbol}`);
  } catch {
    // TradingView not open — silently skip
  }
}

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE"];
  const missing = required.filter((k) => !process.env[k]);

  // On Railway, credentials come from env vars — no .env file exists and that's fine
  if (!process.env.RAILWAY_ENVIRONMENT && !existsSync(".env")) {
    console.log(
      "\n⚠️  No .env file found — opening it for you to fill in...\n",
    );
    writeFileSync(
      ".env",
      [
        "# BitGet credentials",
        "BITGET_API_KEY=",
        "BITGET_SECRET_KEY=",
        "BITGET_PASSPHRASE=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=4H",
      ].join("\n") + "\n",
    );
    try {
      execSync("open .env");
    } catch {}
    console.log(
      "Fill in your BitGet credentials in .env then re-run: node bot.js\n",
    );
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    try {
      execSync("open .env");
    } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  // Always print the CSV location so users know where to find their trade log
  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "BTCUSDT",
  symbols: (process.env.SYMBOLS || process.env.SYMBOL || "BTCUSDT").split(",").map(s => s.trim()),
  stocks: process.env.STOCKS ? process.env.STOCKS.split(",").map(s => s.trim()) : [],
  stockIndicators: { emaPeriod: 20, rsiPeriod: 14, rsiOversold: 40, rsiOverbought: 60, vwapDistPct: 2.0 },
  timeframe: process.env.TIMEFRAME || "1m",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  bitget: {
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};

const LOG_FILE = join(DATA_DIR, "safety-check-log.json");
const POSITIONS_FILE = join(DATA_DIR, "positions.json");
const DAILY_PNL_FILE = join(DATA_DIR, "daily-pnl.json");
const CLOSED_TRADES_FILE = join(DATA_DIR, "closed-trades.json");

function loadClosedTrades() {
  if (!existsSync(CLOSED_TRADES_FILE)) return [];
  try { return JSON.parse(readFileSync(CLOSED_TRADES_FILE, "utf8")); } catch { return []; }
}

function appendClosedTrade(trade) {
  const trades = loadClosedTrades();
  trades.push(trade);
  writeFileSync(CLOSED_TRADES_FILE, JSON.stringify(trades.slice(-200), null, 2));
}

function loadDailyPnl() {
  if (!existsSync(DAILY_PNL_FILE)) return {};
  return JSON.parse(readFileSync(DAILY_PNL_FILE, "utf8"));
}

function recordDailyPnl(symbol, pnlUSD) {
  const today = new Date().toISOString().slice(0, 10);
  const hour = new Date().toISOString().slice(11, 13);
  const data = loadDailyPnl();
  if (!data[today]) data[today] = { total: 0, bySymbol: {}, byHour: {} };
  data[today].total = (data[today].total || 0) + pnlUSD;
  if (!data[today].bySymbol[symbol]) data[today].bySymbol[symbol] = { pnl: 0, trades: 0, wins: 0 };
  data[today].bySymbol[symbol].pnl += pnlUSD;
  data[today].bySymbol[symbol].trades++;
  if (pnlUSD > 0) data[today].bySymbol[symbol].wins++;
  if (!data[today].byHour[hour]) data[today].byHour[hour] = { pnl: 0, trades: 0 };
  data[today].byHour[hour].pnl += pnlUSD;
  data[today].byHour[hour].trades++;
  writeFileSync(DAILY_PNL_FILE, JSON.stringify(data, null, 2));
  return data[today].total;
}

function getTodayPnl() {
  const today = new Date().toISOString().slice(0, 10);
  const d = loadDailyPnl()[today];
  return d ? (d.total || 0) : 0;
}

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  // Strip UTF-8 BOM if present (written by some editors on Windows)
  const text = readFileSync(LOG_FILE, "utf8").replace(/^﻿/, "");
  try { return JSON.parse(text); } catch { return { trades: [] }; }
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function loadPositions() {
  if (!existsSync(POSITIONS_FILE)) return [];
  return JSON.parse(readFileSync(POSITIONS_FILE, "utf8"));
}

function savePositions(positions) {
  writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

// Active trading sessions (UTC hours) — avoid dead/thin markets
function isActiveSession() {
  const hour = new Date().getUTCHours();
  // London session: 07–16 UTC | US morning: 13–17 UTC | Asia open: 00–03 UTC
  // Dead zone to avoid: 21–23 UTC (late US evening, markets winding down)
  const dead = hour >= 21 && hour <= 23;
  return !dead;
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// OKX uses different tickers for some rebranded tokens
const OKX_SYMBOL_MAP = {
  "MATICUSDT": "POLUSDT", // Polygon renamed to POL
};

// ─── Market Data (OKX public API — free, no auth, accessible globally) ───────

async function fetchCandles(symbol, interval, limit = 100) {
  const okxSymbol = OKX_SYMBOL_MAP[symbol] || symbol;
  // OKX instId format: BTC-USDT, ETH-USDT, etc.
  const instId = okxSymbol.replace("USDT", "-USDT");
  // OKX bar format matches our config format exactly: 1m, 3m, 15m, 1H, 4H, 1D, 1W
  const bar = interval;
  // OKX max is 300 candles per request; returns newest-first so we reverse
  const url = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${Math.min(limit, 300)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OKX API error: ${res.status}`);
  const data = await res.json();
  if (data.code !== "0") throw new Error(`OKX API error: ${data.msg}`);

  return data.data.reverse().map((k) => ({
    time: parseInt(k[0]),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Stock Market Data (Yahoo Finance — no API key needed) ───────────────────

async function fetchStockCandles(ticker, limit = 100) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo Finance error: ${res.status}`);
  const data = await res.json();
  const result = data.chart?.result?.[0];
  if (!result) throw new Error(`No data returned for ${ticker}`);
  const timestamps = result.timestamp || [];
  const quotes = result.indicators?.quote?.[0] || {};
  const candles = timestamps.map((t, i) => ({
    time: t * 1000,
    open: quotes.open?.[i] || 0,
    high: quotes.high?.[i] || 0,
    low: quotes.low?.[i] || 0,
    close: quotes.close?.[i] || 0,
    volume: quotes.volume?.[i] || 0,
  })).filter(c => c.close > 0);
  return candles.slice(-limit);
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMAArray(closes, period) {
  if (closes.length < period) return [];
  const multiplier = 2 / (period + 1);
  const result = [];
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(ema);
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
    result.push(ema);
  }
  return result;
}

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    ));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const emaFast = calcEMAArray(closes, fast);
  const emaSlow = calcEMAArray(closes, slow);
  const offset = slow - fast;
  const macdLine = emaSlow.map((v, i) => emaFast[i + offset] - v);
  const signalLine = calcEMAArray(macdLine, signal);
  return {
    macd: macdLine[macdLine.length - 1],
    signal: signalLine[signalLine.length - 1],
    histogram: macdLine[macdLine.length - 1] - signalLine[signalLine.length - 1],
  };
}

function calcBollingerBands(closes, period = 20, multiplier = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const stdDev = Math.sqrt(slice.reduce((sum, v) => sum + Math.pow(v - middle, 2), 0) / period);
  return { upper: middle + multiplier * stdDev, middle, lower: middle - multiplier * stdDev };
}

function calcADX(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null;
  const slice = candles.slice(-(period * 2 + 1));
  const trs = [], plusDMs = [], minusDMs = [];
  for (let i = 1; i < slice.length; i++) {
    const { high, low } = slice[i];
    const { high: pH, low: pL, close: pC } = slice[i - 1];
    trs.push(Math.max(high - low, Math.abs(high - pC), Math.abs(low - pC)));
    const up = high - pH, down = pL - low;
    plusDMs.push(up > down && up > 0 ? up : 0);
    minusDMs.push(down > up && down > 0 ? down : 0);
  }
  let sTR = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let sPlus = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let sMinus = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  for (let i = period; i < trs.length; i++) {
    sTR = sTR - sTR / period + trs[i];
    sPlus = sPlus - sPlus / period + plusDMs[i];
    sMinus = sMinus - sMinus / period + minusDMs[i];
  }
  const plusDI = (sPlus / sTR) * 100;
  const minusDI = (sMinus / sTR) * 100;
  return Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
}

// VWAP — session-based, resets at midnight UTC
function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume,
    0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(price, ema21, ema50, rsi14, macd) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    console.log(`  ${pass ? "✅" : "🚫"} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check (Swing) ─────────────────────────────────\n");

  // Both EMAs must agree on direction — strong trend filter
  const bullishBias = price > ema21 && price > ema50;
  const bearishBias = price < ema21 && price < ema50;

  if (bullishBias) {
    console.log("  Bias: BULLISH — checking swing long conditions\n");
    check("Price above EMA(21)", `> ${ema21.toFixed(2)}`, price.toFixed(2), price > ema21);
    check("Price above EMA(50)", `> ${ema50.toFixed(2)}`, price.toFixed(2), price > ema50);
    const distFromEma = Math.abs((price - ema21) / ema21) * 100;
    check("Price within 4% of EMA(21) — not overextended", "< 4%", `${distFromEma.toFixed(2)}%`, distFromEma < 4);
    check("RSI(14) in pullback zone (38–58)", "38–58", rsi14.toFixed(2), rsi14 >= 38 && rsi14 <= 58);
    if (macd) check("MACD histogram positive (momentum up)", "> 0", macd.histogram.toFixed(6), macd.histogram > 0);
  } else if (bearishBias) {
    console.log("  Bias: BEARISH — checking swing short conditions\n");
    check("Price below EMA(21)", `< ${ema21.toFixed(2)}`, price.toFixed(2), price < ema21);
    check("Price below EMA(50)", `< ${ema50.toFixed(2)}`, price.toFixed(2), price < ema50);
    const distFromEma = Math.abs((price - ema21) / ema21) * 100;
    check("Price within 4% of EMA(21) — not overextended", "< 4%", `${distFromEma.toFixed(2)}%`, distFromEma < 4);
    check("RSI(14) in bounce zone (42–62)", "42–62", rsi14.toFixed(2), rsi14 >= 42 && rsi14 <= 62);
    if (macd) check("MACD histogram negative (momentum down)", "< 0", macd.histogram.toFixed(6), macd.histogram < 0);
  } else {
    console.log("  Bias: NEUTRAL — EMA(21) and EMA(50) not aligned. No trade.\n");
    results.push({ label: "Market bias", required: "EMA(21) & EMA(50) aligned", actual: "Neutral", pass: false });
  }

  return { results, allPass: results.every(r => r.pass) };
}

// ─── Momentum Safety Check (15m — EMA9, EMA21, RSI14, volume surge) ──────────

function runMomentumCheck(price, ema9, ema21, rsi14, macd, currentVolume, avgVolume) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    console.log(`  ${pass ? "✅" : "🚫"} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Momentum Check (15m) ─────────────────────────────────\n");

  const bullishBias = price > ema9 && ema9 > ema21;
  const bearishBias = price < ema9 && ema9 < ema21;
  const volumeSurge = currentVolume >= avgVolume * 1.5;

  if (bullishBias) {
    console.log("  Bias: BULLISH MOMENTUM — EMA(9) > EMA(21), price leading\n");
    check("Price > EMA(9) — momentum uptrend", `> ${ema9.toFixed(2)}`, price.toFixed(2), price > ema9);
    check("EMA(9) > EMA(21) — short trend above medium", `> ${ema21.toFixed(2)}`, ema9.toFixed(2), ema9 > ema21);
    check("RSI(14) in momentum zone (45–70)", "45–70", rsi14 ? rsi14.toFixed(2) : "N/A", rsi14 >= 45 && rsi14 <= 70);
    if (macd) check("MACD histogram positive — momentum up", "> 0", macd.histogram.toFixed(6), macd.histogram > 0);
    check("Volume surge — momentum confirmed (≥1.5× avg)", `≥ ${(avgVolume * 1.5).toFixed(0)}`, currentVolume.toFixed(0), volumeSurge);
  } else if (bearishBias) {
    console.log("  Bias: BEARISH MOMENTUM — EMA(9) < EMA(21), price leading down\n");
    check("Price < EMA(9) — momentum downtrend", `< ${ema9.toFixed(2)}`, price.toFixed(2), price < ema9);
    check("EMA(9) < EMA(21) — short trend below medium", `< ${ema21.toFixed(2)}`, ema9.toFixed(2), ema9 < ema21);
    check("RSI(14) in momentum zone (30–55)", "30–55", rsi14 ? rsi14.toFixed(2) : "N/A", rsi14 >= 30 && rsi14 <= 55);
    if (macd) check("MACD histogram negative — momentum down", "< 0", macd.histogram.toFixed(6), macd.histogram < 0);
    check("Volume surge — momentum confirmed (≥1.5× avg)", `≥ ${(avgVolume * 1.5).toFixed(0)}`, currentVolume.toFixed(0), volumeSurge);
  } else {
    console.log("  Bias: NO MOMENTUM — EMAs not stacked. No trade.\n");
    results.push({ label: "Momentum bias", required: "price > EMA(9) > EMA(21) or inverse", actual: "Neutral", pass: false });
  }

  return {
    results,
    allPass: results.every(r => r.pass),
    bias: bullishBias ? "bullish" : bearishBias ? "bearish" : null,
  };
}

// ─── Stock Safety Check (EMA20 + VWAP + RSI14) ──────────────────────────────

function runStockSafetyCheck(price, ema20, vwap, rsi14) {
  const { rsiOversold, rsiOverbought, vwapDistPct } = CONFIG.stockIndicators;
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    console.log(`  ${pass ? "✅" : "🚫"} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Stock Safety Check ───────────────────────────────────\n");

  const bullishBias = price > vwap && price > ema20;
  const bearishBias = price < vwap && price < ema20;

  if (bullishBias) {
    console.log("  Bias: BULLISH — checking long entry\n");
    check("Price above VWAP", `> ${vwap.toFixed(2)}`, price.toFixed(2), price > vwap);
    check("Price above EMA(20)", `> ${ema20.toFixed(2)}`, price.toFixed(2), price > ema20);
    check(`RSI(14) pullback below ${rsiOversold}`, `< ${rsiOversold}`, rsi14.toFixed(2), rsi14 < rsiOversold);
    const dist = Math.abs((price - vwap) / vwap) * 100;
    check(`Price within ${vwapDistPct}% of VWAP`, `< ${vwapDistPct}%`, `${dist.toFixed(2)}%`, dist < vwapDistPct);
  } else if (bearishBias) {
    console.log("  Bias: BEARISH — checking short entry\n");
    check("Price below VWAP", `< ${vwap.toFixed(2)}`, price.toFixed(2), price < vwap);
    check("Price below EMA(20)", `< ${ema20.toFixed(2)}`, price.toFixed(2), price < ema20);
    check(`RSI(14) above ${rsiOverbought}`, `> ${rsiOverbought}`, rsi14.toFixed(2), rsi14 > rsiOverbought);
    const dist = Math.abs((price - vwap) / vwap) * 100;
    check(`Price within ${vwapDistPct}% of VWAP`, `< ${vwapDistPct}%`, `${dist.toFixed(2)}%`, dist < vwapDistPct);
  } else {
    console.log("  Bias: NEUTRAL — no clear direction. No trade.\n");
    results.push({ label: "Market bias", required: "Bullish or bearish", actual: "Neutral", pass: false });
  }

  return { results, allPass: results.every(r => r.pass) };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(
      `🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`,
    );
    return false;
  }

  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`,
  );

  return true;
}

// ─── Exit Check ─────────────────────────────────────────────────────────────

async function checkExits(symbol, positions, price, ema, vwap, rsi) {
  const open = positions.filter((p) => p.symbol === symbol);
  const keep = [];
  const closed = [];

  for (const pos of open) {
    const isLong = pos.side !== "sell";
    pos.candlesHeld = (pos.candlesHeld || 0) + 1;

    if (isLong) pos.highestPrice = Math.max(pos.highestPrice || pos.entryPrice, price);
    else pos.lowestPrice = Math.min(pos.lowestPrice || pos.entryPrice, price);

    const gainPct = isLong
      ? (price - pos.entryPrice) / pos.entryPrice * 100
      : (pos.entryPrice - price) / pos.entryPrice * 100;

    const isMomentum    = pos.strategy === "momentum";
    const hardStopPct   = isMomentum ? 1.0  : 2.0;
    const breakevenPct  = isMomentum ? 1.0  : 2.0;
    const takeProfitPct = isMomentum ? 2.0  : 5.0;
    const maxHoldMin    = isMomentum ? 90   : 2880;

    const trailLevel = isLong ? pos.highestPrice : pos.lowestPrice;
    let trailingStop;
    if (isMomentum) {
      trailingStop = isLong ? trailLevel * 0.995 : trailLevel * 1.005;
    } else {
      trailingStop = isLong
        ? (pos.halfTaken ? trailLevel * 0.990 : trailLevel * 0.980)
        : (pos.halfTaken ? trailLevel * 1.010 : trailLevel * 1.020);
    }

    // Breakeven stop — once breakevenPct% in profit, stop moves to entry
    if (!pos.breakevenSet && gainPct >= breakevenPct) {
      pos.breakevenSet = true;
      pos.stopPrice = pos.entryPrice;
      console.log(`  🔒 Breakeven stop set at $${pos.entryPrice.toFixed(2)}`);
    }

    // Partial profit at +2.5% — swing trades only (momentum target too small for split)
    if (!isMomentum && !pos.halfTaken && gainPct >= 2.5) {
      const halfQty = pos.quantity / 2;
      const halfPnlUSD = isLong
        ? (price - pos.entryPrice) * halfQty
        : (pos.entryPrice - price) * halfQty;
      console.log(`\n  💰 PARTIAL EXIT (50%) — ${symbol} (${isLong ? "LONG" : "SHORT"}) +${gainPct.toFixed(3)}% | +$${halfPnlUSD.toFixed(2)}`);
      const coverSide = isLong ? "sell" : "buy";
      if (!CONFIG.paperTrading) {
        try { await placeBitGetOrder(symbol, coverSide, pos.sizeUSD / 2, price); }
        catch (err) { console.log(`  ❌ Partial exit failed: ${err.message}`); }
      } else {
        console.log(`  📋 PAPER partial exit — would ${coverSide} ${halfQty.toFixed(6)} ${symbol}`);
      }
      recordDailyPnl(symbol, halfPnlUSD);
      pos.quantity = halfQty;
      pos.sizeUSD /= 2;
      pos.halfTaken = true;
    }

    let exitReason = null;

    const holdMinutes = Math.round((Date.now() - new Date(pos.entryTime).getTime()) / 60000);
    if (gainPct <= -hardStopPct) {
      exitReason = `Hard stop-loss — ${Math.abs(gainPct).toFixed(3)}% exceeded ${hardStopPct}% limit`;
    } else if (pos.breakevenSet && (isLong ? price < pos.stopPrice : price > pos.stopPrice)) {
      exitReason = `Breakeven stop — price $${price.toFixed(2)} returned to entry $${pos.entryPrice.toFixed(2)}`;
    } else if (gainPct >= takeProfitPct) {
      exitReason = `Take-profit — +${gainPct.toFixed(3)}% reached ${takeProfitPct}% target`;
    } else if (isLong ? price <= trailingStop : price >= trailingStop) {
      exitReason = `Trailing stop — price $${price.toFixed(2)} hit stop $${trailingStop.toFixed(2)} (${isLong ? "peak" : "low"} $${trailLevel.toFixed(2)})`;
    } else if (holdMinutes >= maxHoldMin) {
      exitReason = `Max hold time — ${holdMinutes}min (${isMomentum ? "90min momentum limit" : "48h swing limit"})`;
    }

    if (!exitReason) {
      keep.push(pos);
      continue;
    }

    const pnlUSD = isLong
      ? (price - pos.entryPrice) * pos.quantity
      : (pos.entryPrice - price) * pos.quantity;
    const pnlPct = isLong
      ? ((price - pos.entryPrice) / pos.entryPrice) * 100
      : ((pos.entryPrice - price) / pos.entryPrice) * 100;

    console.log(`\n── EXIT: ${symbol} (${isLong ? "LONG" : "SHORT"}) ────────────────────────────────\n`);
    console.log(`  Entry:  $${pos.entryPrice.toFixed(2)} @ ${pos.entryTime}`);
    console.log(`  ${isLong ? "Peak" : "Low"}:   $${trailLevel.toFixed(2)}`);
    console.log(`  Exit:   $${price.toFixed(2)}`);
    console.log(`  P&L:    ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(3)}% (${pnlUSD >= 0 ? "+" : ""}$${pnlUSD.toFixed(2)})`);
    console.log(`  Reason: ${exitReason}`);

    const exitSide = isLong ? "sell" : "buy";
    if (!CONFIG.paperTrading) {
      try {
        await placeBitGetOrder(symbol, exitSide, pos.sizeUSD, price);
        console.log(`  ✅ EXIT ORDER PLACED`);
      } catch (err) {
        console.log(`  ❌ EXIT ORDER FAILED: ${err.message}`);
        keep.push(pos);
        continue;
      }
    } else {
      console.log(`  📋 PAPER EXIT — would ${exitSide} ${pos.quantity.toFixed(6)} ${symbol}`);
    }

    recordDailyPnl(symbol, pnlUSD);
    if (pnlUSD > 0) recordWin(symbol); else recordLoss(symbol);

    const durationMs = Date.now() - new Date(pos.entryTime).getTime();
    const durationMin = Math.round(durationMs / 60000);
    const closedTrade = {
      symbol, side: isLong ? "long" : "short",
      entryPrice: pos.entryPrice, exitPrice: price,
      pnlUSD, pnlPct, durationMin, reason: exitReason,
      time: new Date().toISOString(),
    };
    closed.push(closedTrade);
    appendClosedTrade(closedTrade);

    sendAlert(
      `${pnlUSD >= 0 ? "✅" : "❌"} EXIT ${symbol} (${isLong ? "LONG" : "SHORT"})\n` +
      `Entry $${pos.entryPrice.toFixed(2)} → Exit $${price.toFixed(2)}\n` +
      `P&L: ${pnlUSD >= 0 ? "+" : ""}$${pnlUSD.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)\n` +
      exitReason
    ).catch(() => {});

    const now = new Date();
    appendFileSync(CSV_FILE, [
      now.toISOString().slice(0, 10),
      now.toISOString().slice(11, 19),
      "BitGet",
      symbol,
      exitSide.toUpperCase(),
      pos.quantity.toFixed(6),
      price.toFixed(2),
      (price * pos.quantity).toFixed(2),
      (price * pos.quantity * 0.001).toFixed(4),
      (price * pos.quantity * 0.999).toFixed(2),
      `EXIT-${Date.now()}`,
      CONFIG.paperTrading ? "PAPER" : "LIVE",
      `"${exitReason}"`,
    ].join(",") + "\n");
  }

  return { positions: [...keep, ...positions.filter((p) => p.symbol !== symbol)], closed };
}

// ─── BitGet Execution ────────────────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto
    .createHmac("sha256", CONFIG.bitget.secretKey)
    .update(message)
    .digest("base64");
}

async function placeBitGetOrder(symbol, side, sizeUSD, price) {
  const quantity = (sizeUSD / price).toFixed(6);
  const timestamp = Date.now().toString();
  const path =
    CONFIG.tradeMode === "spot"
      ? "/api/v2/spot/trade/placeOrder"
      : "/api/v2/mix/order/placeOrder";

  const body = JSON.stringify({
    symbol,
    side,
    orderType: "market",
    quantity,
    ...(CONFIG.tradeMode === "futures" && {
      productType: "USDT-FUTURES",
      marginMode: "isolated",
      marginCoin: "USDT",
    }),
  });

  const signature = signBitGet(timestamp, "POST", path, body);

  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body,
  });

  const data = await res.json();
  if (data.code !== "00000") {
    throw new Error(`BitGet order failed: ${data.msg}`);
  }

  return data.data;
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = join(DATA_DIR, "trades.csv");

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = (logEntry.side || "buy").toUpperCase();
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    notes = "All conditions met";
  } else {
    side = (logEntry.side || "buy").toUpperCase();
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
  }

  const row = [
    date,
    time,
    "BitGet",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`,
  );
  console.log("═══════════════════════════════════════════════════════════");

  // Load strategy
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbols: ${CONFIG.symbols.join(", ")} | Timeframe: ${CONFIG.timeframe}`);

  // Load log and check daily limits
  const log = loadLog();
  let positions = loadPositions();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  // Fetch all global context in parallel
  console.log("\n── Market Context ───────────────────────────────────────\n");
  const [cryptoHeadlines, fearGreed, economicEvents, onChain] = await Promise.all([
    fetchNewsHeadlines(true),
    fetchFearGreed(),
    fetchEconomicEvents(),
    fetchOnChainData(),
  ]);
  const learned = loadLearned();

  console.log(`  Fear & Greed:  ${fearGreed.value}/100 — ${fearGreed.label}`);
  console.log(`  Economic events (next 30min): ${economicEvents.length > 0 ? economicEvents.map(e => e.title).join(", ") : "none"}`);
  if (onChain) console.log(`  BTC Dominance: ${onChain.btcDominance.toFixed(1)}% | Market 24h: ${onChain.marketChange24h >= 0 ? "+" : ""}${onChain.marketChange24h.toFixed(2)}%`);
  console.log(`  News headlines: ${cryptoHeadlines.length} in last 30min`);

  // Block all trading during high-impact economic events
  if (economicEvents.length > 0) {
    console.log(`\n🚫 High-impact economic event imminent — skipping all trades this cycle.`);
    return;
  }

  // Weekly loss limit
  const weeklyPnl = getWeeklyPnl();
  const weeklyLossLimit = CONFIG.portfolioValue * (parseFloat(process.env.WEEKLY_LOSS_LIMIT_PCT || "5") / 100);
  if (weeklyPnl < -weeklyLossLimit) {
    console.log(`\n🚫 Weekly loss limit reached: $${weeklyPnl.toFixed(2)} / -$${weeklyLossLimit.toFixed(2)} — no trading until Monday.`);
    return;
  }
  console.log(`  Weekly P&L: ${weeklyPnl >= 0 ? "+" : ""}$${weeklyPnl.toFixed(2)} (limit: -$${weeklyLossLimit.toFixed(2)})`);

  const CORRELATED_GROUPS = [
    ["BTCUSDT", "ETHUSDT", "SOLUSDT", "AVAXUSDT"],
    ["XRPUSDT", "ADAUSDT", "DOTUSDT", "LINKUSDT"],
    ["DOGEUSDT", "GALAUSDT", "SANDUSDT", "MANAUSDT", "AXSUSDT"],
  ];
  const tradedThisCycle = new Set();
  const lastKnownPrices = {};

  // Loop through all symbols
  for (const symbol of CONFIG.symbols) {
    console.log(`\n${"─".repeat(57)}`);
    console.log(`  Checking ${symbol}...`);

  let candles;
  try {
    console.log("\n── Fetching market data from OKX ──────────────────────\n");
    candles = await fetchCandles(symbol, CONFIG.timeframe, 500);
  } catch (err) {
    console.log(`  ⚠️  OKX unavailable for ${symbol}: ${err.message} — skipping.`);
    continue;
  }
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  lastKnownPrices[symbol] = price;
  console.log(`  Current price: $${price.toFixed(2)}`);

  // Calculate indicators — swing strategy uses EMA(21), EMA(50), RSI(14)
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  const vwap = calcVWAP(candles);
  const rsi14 = calcRSI(closes, 14);

  console.log(`  EMA(21): $${ema21.toFixed(2)}`);
  console.log(`  EMA(50): $${ema50.toFixed(2)}`);
  console.log(`  VWAP:    $${vwap ? vwap.toFixed(2) : "N/A"}`);
  console.log(`  RSI(14): ${rsi14 ? rsi14.toFixed(2) : "N/A"}`);

  if (!rsi14) {
    console.log(`\n⚠️  Not enough data for ${symbol}. Skipping.`);
    continue;
  }

  // ── Always check exits first — regardless of any entry filters ─────────────
  {
    const { positions: updatedPositions } = await checkExits(symbol, positions, price, ema21, vwap, rsi14);
    positions = updatedPositions;
    savePositions(positions);
    const alreadyOpen = positions.some((p) => p.symbol === symbol);
    if (alreadyOpen) {
      console.log(`  ⏳ Position already open for ${symbol} — holding.`);
      continue;
    }
  }

  // ATR-based position sizing (multiplier applied later after social/on-chain checks)
  const atr = calcATR(candles, 14);
  const riskAmount = CONFIG.portfolioValue * 0.01;
  let tradeSize = atr
    ? Math.min(riskAmount / (atr / price * 1.5), CONFIG.maxTradeSizeUSD)
    : Math.min(riskAmount, CONFIG.maxTradeSizeUSD);

  // Extra indicators
  const macd = calcMACD(closes, 12, 26, 9);
  const bb = calcBollingerBands(closes, 20, 2);
  const adx = calcADX(candles, 14);

  console.log(`  MACD:  ${macd ? `${macd.macd.toFixed(4)} / signal ${macd.signal.toFixed(4)} (hist ${macd.histogram.toFixed(4)})` : "N/A"}`);
  console.log(`  BB:    lower $${bb ? bb.lower.toFixed(2) : "N/A"} | upper $${bb ? bb.upper.toFixed(2) : "N/A"}`);
  console.log(`  ADX:   ${adx ? adx.toFixed(1) : "N/A"}`);

  // Volatility blackout — skip if last 4h candle spiked > 6%
  const lastMove = Math.abs((closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2] * 100);
  if (lastMove > 6) {
    console.log(`  ⚠️  Volatility spike: ${lastMove.toFixed(2)}% last candle — skipping.`);
    continue;
  }

  // ADX filter — skip if market is ranging
  if (adx !== null && adx < 10) {
    console.log(`  ⚠️  ADX ${adx.toFixed(1)} < 10 — market ranging — skipping.`);
    continue;
  }

  // Correlation filter — skip if correlated symbol already traded this cycle
  const correlatedGroup = CORRELATED_GROUPS.find(g => g.includes(symbol));
  if (correlatedGroup && correlatedGroup.some(s => tradedThisCycle.has(s))) {
    console.log(`  ⚠️  Correlated position already taken this cycle — skipping.`);
    continue;
  }

  // Volume info (display only — low volume no longer blocks entry)
  const avgVolume = candles.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20;
  const currentVolume = candles[candles.length - 2].volume;
  console.log(`  Volume: ${currentVolume.toFixed(0)} (avg: ${avgVolume.toFixed(0)}) ${currentVolume >= avgVolume * 0.5 ? "✅" : "⚠️ very low"}`);

  // Self-learning: skip excluded symbols
  if (learned.excludedSymbols.includes(symbol)) {
    console.log(`  ⚠️  ${symbol} excluded by self-learning — skipping.`);
    continue;
  }

  // Per-symbol cooldown
  if (isOnCooldown(symbol)) {
    console.log(`  ⏸️  ${symbol} on cooldown (3 consecutive losses) — skipping.`);
    continue;
  }

  // Social sentiment + order book in parallel
  const [social, orderBookRatio] = await Promise.all([
    fetchSocialSentiment(symbol),
    fetchOrderBookImbalance(symbol),
  ]);
  console.log(`  Social: ${social.sentiment.toUpperCase()} (${social.bullishPct}% bullish on Stocktwits)`);
  if (orderBookRatio !== null) console.log(`  Order book: ${(orderBookRatio * 100).toFixed(1)}% bid pressure ${orderBookRatio > 0.55 ? "📈" : orderBookRatio < 0.45 ? "📉" : "➖"}`);


  // ── Entry-only filters (exits above already ran) ────────────────────────────

  // Time-of-day filter — skip new entries during dead market hours (21–23 UTC)
  if (!isActiveSession()) {
    console.log(`  ⚠️  Dead market hours (UTC ${new Date().getUTCHours()}:xx) — no new entries.`);
    continue;
  }

  // Max concurrent positions — keep focus on the best 3 setups
  if (positions.length >= 3) {
    console.log(`  ⚠️  3 positions already open — not adding more.`);
    continue;
  }

  // Swing bias — neutral 4H is okay, momentum check will run later as fallback
  const bias1m = price > ema21 && price > ema50 ? "bullish"
    : price < ema21 && price < ema50 ? "bearish" : null;
  if (!bias1m) {
    console.log(`  ⚠️  4H EMAs neutral — swing skip, will try momentum fallback.`);
  }
  // tradeSide is placeholder for swing; finalTradeSide is set after strategy selection
  const tradeSide = bias1m === "bullish" ? "buy" : bias1m === "bearish" ? "sell" : "buy";

  // Daily loss limit
  const todayPnl = getTodayPnl();
  const dailyLossLimit = CONFIG.portfolioValue * (parseFloat(process.env.DAILY_LOSS_LIMIT_PCT || "2") / 100);
  if (todayPnl < -dailyLossLimit) {
    console.log(`🚫 Daily loss limit reached: $${todayPnl.toFixed(2)} / -$${dailyLossLimit.toFixed(2)} — stopping for today.`);
    break;
  }

  // Fear & Greed filter
  if (fearGreed.value < 20 && bias1m === "bullish") {
    console.log(`  🚫 Extreme Fear (${fearGreed.value}) — skipping long entry.`);
    continue;
  }
  if (fearGreed.value > 80 && bias1m === "bearish") {
    console.log(`  🚫 Extreme Greed (${fearGreed.value}) — skipping short entry.`);
    continue;
  }

  // On-chain: if market dropped >5% in 24h, halve position size on longs
  let positionMultiplier = learned.positionMultipliers[symbol] || 1;
  if (onChain && onChain.marketChange24h < -5 && bias1m === "bullish") {
    console.log(`  ⚠️  Market down ${Math.abs(onChain.marketChange24h).toFixed(1)}% in 24h — reducing position size.`);
    positionMultiplier *= 0.5;
  }

  // BTC dominance shift: rising dominance = altcoins bleed
  if (onChain && onChain.btcDominance > 55 && !symbol.startsWith("BTC")) {
    console.log(`  ⚠️  BTC dominance ${onChain.btcDominance.toFixed(1)}% — altcoin headwind. Reducing size.`);
    positionMultiplier *= 0.8;
  }

  // Fetch news early — needed for swing override logic
  const news = await analyzeNewsSentiment(symbol, cryptoHeadlines);
  const newsIcon = news.sentiment === "positive" ? "📈" : news.sentiment === "negative" ? "📉" : "➖";
  console.log(`\n── News Sentiment ───────────────────────────────────────\n`);
  console.log(`  ${newsIcon} ${news.sentiment.toUpperCase()} (${news.confidence} confidence)`);
  if (news.reason) console.log(`  ${news.reason}`);

  // Run swing safety check (4H) — only if EMAs are aligned
  const { results: safetyResults, allPass: safetyPass } = bias1m
    ? runSafetyCheck(price, ema21, ema50, rsi14, macd)
    : { results: [{ label: "4H EMA bias", required: "aligned", actual: "neutral", pass: false }], allPass: false };

  // Bollinger Band info (display only)
  if (bb) {
    console.log(`  BB:    lower $${bb.lower.toFixed(2)} | mid $${bb.middle.toFixed(2)} | upper $${bb.upper.toFixed(2)}`);
  }

  let results = [...safetyResults];
  let allPass = safetyPass;
  let strategyUsed = "swing";
  let finalTradeSide = tradeSide;

  // If swing conditions not met, try momentum strategy on 15m candles
  if (!allPass) {
    console.log("\n── Swing not triggered — checking momentum (15m) ───────\n");
    try {
      const c15 = await fetchCandles(symbol, "15m", 100);
      const cl15 = c15.map(c => c.close);
      const ema9m  = calcEMA(cl15, 9);
      const ema21m = calcEMA(cl15, 21);
      const rsi14m = calcRSI(cl15, 14);
      const macd15 = calcMACD(cl15, 12, 26, 9);
      const avgV15 = c15.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20;
      const curV15 = c15[c15.length - 2].volume;
      const { results: momR, allPass: momP, bias: momBias } = runMomentumCheck(
        price, ema9m, ema21m, rsi14m, macd15, curV15, avgV15
      );
      results = [...results, ...momR];
      if (momP && momBias) {
        allPass = true;
        strategyUsed = "momentum";
        finalTradeSide = momBias === "bullish" ? "buy" : "sell";
        console.log(`  ✅ Momentum setup found — ${momBias.toUpperCase()} on 15m`);
      }
    } catch (err) {
      console.log(`  ⚠️  15m data unavailable: ${err.message}`);
    }
  }

  // Now we know finalTradeSide — apply direction-aware filters correctly
  if (allPass) {
    // News override: strong aligned news can confirm entry; strong opposing news blocks it
    const newsAligned = finalTradeSide === "buy"
      ? (news.sentiment === "positive" && news.confidence === "high")
      : (news.sentiment === "negative" && news.confidence === "high");
    const newsOpposed = finalTradeSide === "buy"
      ? (news.sentiment === "negative" && news.confidence === "high")
      : (news.sentiment === "positive" && news.confidence === "high");

    if (newsOpposed) {
      console.log(`  🚫 High-confidence news opposes ${finalTradeSide === "buy" ? "long" : "short"} — skipping.`);
      allPass = false;
    } else if (newsAligned) {
      console.log(`  📈 News confirms direction — proceeding.`);
    }

    // Social sentiment — opposing signal reduces size
    if (social.sentiment === "bearish" && finalTradeSide === "buy") {
      console.log(`  ⚠️  Social bearish vs long setup — reducing position size.`);
      positionMultiplier *= 0.7;
    } else if (social.sentiment === "bullish" && finalTradeSide === "sell") {
      console.log(`  ⚠️  Social bullish vs short setup — reducing position size.`);
      positionMultiplier *= 0.7;
    }

    // Order book: pressure against direction = reduce, with direction = boost
    if (orderBookRatio !== null) {
      if (finalTradeSide === "buy" && orderBookRatio < 0.4) {
        console.log(`  ⚠️  Heavy ask pressure (${(orderBookRatio * 100).toFixed(1)}% bids) — reducing long size.`);
        positionMultiplier *= 0.7;
      } else if (finalTradeSide === "buy" && orderBookRatio > 0.6) {
        console.log(`  ✅ Strong bid pressure — boosting long size.`);
        positionMultiplier *= 1.2;
      } else if (finalTradeSide === "sell" && orderBookRatio > 0.6) {
        console.log(`  ⚠️  Heavy bid pressure (${(orderBookRatio * 100).toFixed(1)}% bids) — reducing short size.`);
        positionMultiplier *= 0.7;
      } else if (finalTradeSide === "sell" && orderBookRatio < 0.4) {
        console.log(`  ✅ Strong ask pressure — boosting short size.`);
        positionMultiplier *= 1.2;
      }
    }
  }

  // Position sizing — max 33% of portfolio per swing, 25% per momentum
  const maxPerTrade = strategyUsed === "momentum"
    ? Math.min(CONFIG.portfolioValue * 0.25, CONFIG.maxTradeSizeUSD)
    : Math.min(CONFIG.portfolioValue * 0.33, CONFIG.maxTradeSizeUSD);
  const minPerTrade = Math.max(CONFIG.portfolioValue * 0.05, 50);
  tradeSize = Math.max(minPerTrade, Math.min(tradeSize * positionMultiplier, maxPerTrade));

  // Decision
  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol: symbol,
    side: finalTradeSide,
    strategy: strategyUsed,
    timeframe: strategyUsed === "momentum" ? "15m" : CONFIG.timeframe,
    price,
    indicators: { ema21, ema50, vwap, rsi14 },
    conditions: results,
    allPass,
    tradeSize,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED`);
    console.log(`   Failed conditions:`);
    failed.forEach((f) => console.log(`   - ${f}`));
  } else {
    console.log(`✅ ALL CONDITIONS MET`);

    // Switch TradingView to this symbol so you can watch the trade live
    await switchTradingViewChart(symbol);

    const dirLabel = finalTradeSide === "buy" ? "LONG" : "SHORT";
    const stratLabel = strategyUsed === "momentum" ? "15m MOMENTUM" : "4H SWING";
    const newPos = {
      symbol, side: finalTradeSide, strategy: strategyUsed,
      entryPrice: price, entryTime: new Date().toISOString(),
      sizeUSD: tradeSize, quantity: tradeSize / price,
      ...(finalTradeSide === "buy" ? { highestPrice: price } : { lowestPrice: price }),
    };

    if (CONFIG.paperTrading) {
      console.log(`\n📋 PAPER TRADE — [${stratLabel}] ${dirLabel} ${symbol} ~$${tradeSize.toFixed(2)} at market`);
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
      logEntry.strategy = strategyUsed;
      positions.push(newPos);
      savePositions(positions);
      tradedThisCycle.add(symbol);
      sendAlert(
        `${finalTradeSide === "buy" ? "🟢 LONG" : "🔴 SHORT"} ${symbol} @ $${price.toFixed(2)}\n` +
        `Size: $${tradeSize.toFixed(2)} | ${stratLabel} | PAPER\n` +
        `F&G: ${fearGreed.value}/100 | Bias: ${bias1m ? bias1m.toUpperCase() : "MOMENTUM"}`
      ).catch(() => {});
    } else {
      console.log(`\n🔴 PLACING LIVE ORDER — [${stratLabel}] $${tradeSize.toFixed(2)} ${dirLabel} ${symbol}`);
      try {
        const order = await placeBitGetOrder(symbol, finalTradeSide, tradeSize, price);
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        logEntry.strategy = strategyUsed;
        console.log(`✅ ORDER PLACED — ${order.orderId}`);
        positions.push(newPos);
        savePositions(positions);
        tradedThisCycle.add(symbol);
        sendAlert(
          `${finalTradeSide === "buy" ? "🟢 LONG" : "🔴 SHORT"} ${symbol} @ $${price.toFixed(2)}\n` +
          `Size: $${tradeSize.toFixed(2)} | ${stratLabel} | LIVE | ID: ${order.orderId}\n` +
          `F&G: ${fearGreed.value}/100 | Bias: ${bias1m ? bias1m.toUpperCase() : "MOMENTUM"}`
        ).catch(() => {});
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }
  }

  // Save decision log
  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);

  // Write tax CSV row for every run (executed, paper, or blocked)
  writeTradeCsv(logEntry);

  } // end crypto symbol loop

  // ── Stocks loop ────────────────────────────────────────────────────────────
  if (CONFIG.stocks.length > 0) {
    console.log(`\n${"═".repeat(57)}`);
    console.log(`  STOCKS — ${CONFIG.stocks.join(", ")}`);
    console.log(`${"═".repeat(57)}`);

    for (const ticker of CONFIG.stocks) {
      const withinLimitsNow = checkTradeLimits(log);
      if (!withinLimitsNow) { console.log("\nTrade limit reached — stopping stocks loop."); break; }

      console.log(`\n${"─".repeat(57)}`);
      console.log(`  Checking ${ticker}...`);

      // Stock market hours: 9:30am–4pm EST = 13:30–20:00 UTC
      const nowUtc = new Date();
      const utcMinutes = nowUtc.getUTCHours() * 60 + nowUtc.getUTCMinutes();
      if (utcMinutes < 13 * 60 + 30 || utcMinutes >= 20 * 60) {
        console.log(`  ⏰ Market closed — skipping ${ticker} (trades 13:30–20:00 UTC)`);
        continue;
      }

      let candles;
      try {
        candles = await fetchStockCandles(ticker, 500);
      } catch (err) {
        console.log(`  ⚠️  Skipping ${ticker}: ${err.message}`);
        continue;
      }
      if (candles.length < 20) { console.log(`  ⚠️  Not enough data for ${ticker}. Skipping.`); continue; }

      const closes = candles.map(c => c.close);
      const price = closes[closes.length - 1];
      lastKnownPrices[ticker] = price;
      const ema20 = calcEMA(closes, CONFIG.stockIndicators.emaPeriod);
      const vwap = calcVWAP(candles);
      const rsi14 = calcRSI(closes, CONFIG.stockIndicators.rsiPeriod);

      console.log(`  Current price: $${price.toFixed(2)}`);
      console.log(`  EMA(20): $${ema20.toFixed(2)}`);
      console.log(`  VWAP:    $${vwap ? vwap.toFixed(2) : "N/A"}`);
      console.log(`  RSI(14): ${rsi14 ? rsi14.toFixed(2) : "N/A"}`);

      if (!vwap || !rsi14) { console.log(`  ⚠️  Skipping ${ticker} — insufficient indicator data.`); continue; }

      // Check exits for open stock positions
      const { positions: updatedStockPositions } = await checkExits(ticker, positions, price, ema20, vwap, rsi14);
      positions = updatedStockPositions;
      savePositions(positions);

      // Skip entry if already in a position on this ticker
      const stockAlreadyOpen = positions.some((p) => p.symbol === ticker);
      if (stockAlreadyOpen) {
        console.log(`  ⏳ Position already open for ${ticker} — holding.`);
        continue;
      }

      const { results, allPass } = runStockSafetyCheck(price, ema20, vwap, rsi14);
      const tradeSize = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD);

      const logEntry = {
        timestamp: new Date().toISOString(),
        symbol: ticker,
        assetType: "stock",
        timeframe: "1m",
        price,
        indicators: { ema20, vwap, rsi14 },
        conditions: results,
        allPass,
        tradeSize,
        orderPlaced: false,
        orderId: null,
        paperTrading: true,
        limits: { maxTradeSizeUSD: CONFIG.maxTradeSizeUSD, maxTradesPerDay: CONFIG.maxTradesPerDay, tradesToday: countTodaysTrades(log) },
      };

      console.log("\n── Decision ─────────────────────────────────────────────\n");
      if (!allPass) {
        const failed = results.filter(r => !r.pass).map(r => r.label);
        console.log(`🚫 TRADE BLOCKED`);
        failed.forEach(f => console.log(`   - ${f}`));
      } else {
        console.log(`✅ ALL CONDITIONS MET`);
        await switchTradingViewChart(`${ticker}USD`);
        logEntry.orderPlaced = true;
        if (process.env.ALPACA_API_KEY) {
          try {
            const alpacaQty = tradeSize / price;
            const order = await placeAlpacaOrder(ticker, "buy", alpacaQty);
            logEntry.orderId = order.id;
            logEntry.paperTrading = false;
            console.log(`\n📈 ALPACA ORDER PLACED — ${ticker} qty ${alpacaQty.toFixed(4)} | id ${order.id}`);
          } catch (err) {
            console.log(`  ❌ Alpaca order failed: ${err.message}`);
            logEntry.orderId = `PAPER-STOCK-${Date.now()}`;
            console.log(`\n📋 PAPER TRADE — would buy ${ticker} ~$${tradeSize.toFixed(2)} at market`);
          }
        } else {
          logEntry.orderId = `PAPER-STOCK-${Date.now()}`;
          console.log(`\n📋 PAPER TRADE — would buy ${ticker} ~$${tradeSize.toFixed(2)} at market`);
        }
        positions.push({ symbol: ticker, side: "buy", entryPrice: price, highestPrice: price, entryTime: new Date().toISOString(), sizeUSD: tradeSize, quantity: tradeSize / price });
        savePositions(positions);
      }

      log.trades.push(logEntry);
      saveLog(log);
    }
  }

  // Export trades + full analytics for the live dashboard
  const dailyPnlData = loadDailyPnl();
  const dailyTotals = Object.values(dailyPnlData).map(d => d.total || 0);

  // Max drawdown
  let peak = 0, running = 0, maxDrawdown = 0;
  for (const r of dailyTotals) {
    running += r;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Sharpe ratio (annualised, 0 risk-free rate)
  let sharpe = null;
  if (dailyTotals.length >= 2) {
    const mean = dailyTotals.reduce((a, b) => a + b, 0) / dailyTotals.length;
    const stdDev = Math.sqrt(dailyTotals.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / dailyTotals.length);
    if (stdDev > 0) sharpe = ((mean / stdDev) * Math.sqrt(252)).toFixed(2);
  }

  // Per-symbol aggregated stats
  const bySymbol = {};
  Object.values(dailyPnlData).forEach(day => {
    Object.entries(day.bySymbol || {}).forEach(([sym, s]) => {
      if (!bySymbol[sym]) bySymbol[sym] = { pnl: 0, trades: 0, wins: 0 };
      bySymbol[sym].pnl += s.pnl;
      bySymbol[sym].trades += s.trades;
      bySymbol[sym].wins += s.wins;
    });
  });

  // Per-hour aggregated stats
  const byHour = {};
  Object.values(dailyPnlData).forEach(day => {
    Object.entries(day.byHour || {}).forEach(([hr, h]) => {
      if (!byHour[hr]) byHour[hr] = { pnl: 0, trades: 0 };
      byHour[hr].pnl += h.pnl;
      byHour[hr].trades += h.trades;
    });
  });

  writeFileSync(join(DATA_DIR, "trades-data.json"), JSON.stringify({
    trades: log.trades,
    openPositions: positions,
    closedTrades: loadClosedTrades().slice(-50),
    lastKnownPrices,
    stats: {
      todayPnl: getTodayPnl(),
      maxDrawdown,
      sharpe,
      bySymbol,
      byHour,
      dailyPnl: dailyPnlData,
    },
  }, null, 2));

  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
