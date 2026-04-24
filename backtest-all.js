/**
 * Bulk backtest — runs the strategy against all crypto symbols and ranks results.
 * Usage: node backtest-all.js [DAYS]
 *   node backtest-all.js 90
 */

import { writeFileSync } from "fs";

const days = parseInt(process.argv[2] || "90");

const SYMBOLS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","ADAUSDT",
  "DOGEUSDT","LINKUSDT","AVAXUSDT","DOTUSDT","LTCUSDT",
  "UNIUSDT","ATOMUSDT","NEARUSDT","MATICUSDT","AAVEUSDT",
  "COMPUSDT","ICPUSDT","ALGOUSDT","FILUSDT",
];

const OKX_SYMBOL_MAP = { "MATICUSDT": "POLUSDT" };

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const m = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * m + ema * (1 - m);
  return ema;
}

function calcEMAArray(closes, period) {
  if (closes.length < period) return [];
  const m = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result = [ema];
  for (let i = period; i < closes.length; i++) { ema = closes[i] * m + ema * (1 - m); result.push(ema); }
  return result;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rs = (gains / period) / (losses / period || 0.0001);
  return 100 - 100 / (1 + rs);
}

function calcVWAP(candles) {
  const midnight = new Date(candles[0].time);
  midnight.setUTCHours(0, 0, 0, 0);
  const session = candles.filter(c => c.time >= midnight.getTime());
  if (!session.length) return null;
  const tpv = session.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0);
  const vol = session.reduce((s, c) => s + c.volume, 0);
  return vol === 0 ? null : tpv / vol;
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

function calcMACD(closes) {
  if (closes.length < 35) return null;
  const fast = calcEMAArray(closes, 12);
  const slow = calcEMAArray(closes, 26);
  const offset = 14;
  const macdLine = slow.map((v, i) => fast[i + offset] - v);
  const signal = calcEMAArray(macdLine, 9);
  return { histogram: macdLine[macdLine.length - 1] - signal[signal.length - 1] };
}

function calcADX(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null;
  const slice = candles.slice(-(period * 2 + 1));
  const trs = [], plusDMs = [], minusDMs = [];
  for (let i = 1; i < slice.length; i++) {
    const { high, low } = slice[i], { high: pH, low: pL, close: pC } = slice[i - 1];
    trs.push(Math.max(high - low, Math.abs(high - pC), Math.abs(low - pC)));
    const up = high - pH, down = pL - low;
    plusDMs.push(up > down && up > 0 ? up : 0);
    minusDMs.push(down > up && down > 0 ? down : 0);
  }
  let sTR = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let sP = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let sM = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  for (let i = period; i < trs.length; i++) {
    sTR = sTR - sTR / period + trs[i];
    sP = sP - sP / period + plusDMs[i];
    sM = sM - sM / period + minusDMs[i];
  }
  const pDI = sP / sTR * 100, mDI = sM / sTR * 100;
  return Math.abs(pDI - mDI) / (pDI + mDI) * 100;
}

async function fetchCandles(symbol, days) {
  const mapped = OKX_SYMBOL_MAP[symbol] || symbol;
  const instId = mapped.replace("USDT", "-USDT");
  const totalNeeded = days * 24;
  const all = [];
  let after = "";

  while (all.length < totalNeeded) {
    const param = after ? `&after=${after}` : "";
    const url = `https://www.okx.com/api/v5/market/history-candles?instId=${instId}&bar=1H&limit=300${param}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.code !== "0" || !data.data?.length) break;
    const batch = data.data.map(k => ({
      time: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    }));
    all.push(...batch);
    after = batch[batch.length - 1].time;
    if (batch.length < 300) break;
  }

  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  return all.reverse().filter(c => c.time >= cutoff);
}

function backtest(candles, portfolioValue = 25000, maxTradeSizeUSD = 1000) {
  const trades = [];
  let position = null;

  for (let i = 50; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const closes = window.map(c => c.close);
    const price = closes[closes.length - 1];
    const ema8 = calcEMA(closes, 8);
    const vwap = calcVWAP(window);
    const rsi3 = calcRSI(closes, 3);
    const adx = calcADX(window, 14);
    const macd = calcMACD(closes);
    const atr = calcATR(window, 14);
    if (!vwap || !rsi3 || !ema8) continue;

    if (position) {
      position.highestPrice = Math.max(position.highestPrice, price);
      const trailingStop = position.highestPrice * 0.997;
      const gainPct = (price - position.entryPrice) / position.entryPrice * 100;
      let exitReason = null;
      if (gainPct <= -1.0) exitReason = "hard_stop";
      else if (gainPct >= 3.0) exitReason = "take_profit";
      else if (price <= trailingStop) exitReason = "trailing_stop";
      else if (rsi3 > 65) exitReason = "rsi_exit";
      else if (price <= vwap) exitReason = "vwap_touch";
      else if (price < ema8) exitReason = "ema_cross";

      if (exitReason) {
        const pnlUSD = (price - position.entryPrice) * position.quantity;
        trades.push({
          entryTime: new Date(position.entryTime).toISOString().slice(0, 16),
          exitTime: new Date(candles[i].time).toISOString().slice(0, 16),
          entryPrice: position.entryPrice, exitPrice: price,
          pnlUSD, pnlPct: (price - position.entryPrice) / position.entryPrice * 100,
          won: pnlUSD > 0, reason: exitReason,
        });
        position = null;
      }
    }

    if (!position) {
      const bullish = price > vwap && price > ema8;
      const dist = Math.abs((price - vwap) / vwap) * 100;
      const lastMove = Math.abs((closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2] * 100);
      if (lastMove > 2 || (adx !== null && adx < 10)) continue;
      const avgVol = window.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20;
      if (window[window.length - 1].volume < avgVol) continue;
      if (bullish && rsi3 < 28 && dist < 0.8 && (macd ? macd.histogram > 0 : true)) {
        const size = atr
          ? Math.min((portfolioValue * 0.01) / (atr / price * 1.5), maxTradeSizeUSD)
          : Math.min(portfolioValue * 0.01, maxTradeSizeUSD);
        position = { entryPrice: price, highestPrice: price, entryTime: candles[i].time, quantity: size / price, sizeUSD: size };
      }
    }
  }

  if (position) {
    const price = candles[candles.length - 1].close;
    const pnlUSD = (price - position.entryPrice) * position.quantity;
    trades.push({ entryTime: new Date(position.entryTime).toISOString().slice(0, 16), exitTime: "open", entryPrice: position.entryPrice, exitPrice: price, pnlUSD, pnlPct: pnlUSD / position.sizeUSD * 100, won: pnlUSD > 0, reason: "end_of_data" });
  }

  return trades;
}

function summarize(symbol, trades, days) {
  const wins = trades.filter(t => t.won).length;
  const totalPnl = trades.reduce((s, t) => s + t.pnlUSD, 0);
  const winRate = trades.length ? wins / trades.length * 100 : 0;
  const avgWin = wins ? trades.filter(t => t.won).reduce((s, t) => s + t.pnlUSD, 0) / wins : 0;
  const losses = trades.length - wins;
  const avgLoss = losses ? Math.abs(trades.filter(t => !t.won).reduce((s, t) => s + t.pnlUSD, 0) / losses) : 0;
  const profitFactor = avgLoss > 0 ? (avgWin * wins) / (avgLoss * losses) : null;
  let peak = 0, running = 0, maxDD = 0;
  for (const t of trades) { running += t.pnlUSD; if (running > peak) peak = running; const dd = peak - running; if (dd > maxDD) maxDD = dd; }
  return { symbol, trades: trades.length, wins, losses, winRate, totalPnl, avgWin, avgLoss, profitFactor, maxDD };
}

(async () => {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  Bulk Backtest — all ${SYMBOLS.length} symbols — last ${days} days (1H candles)`);
  console.log(`${"═".repeat(70)}\n`);

  const results = [];
  for (const symbol of SYMBOLS) {
    process.stdout.write(`  ${symbol.padEnd(12)}`);
    try {
      const candles = await fetchCandles(symbol, days);
      if (candles.length < 60) { console.log("skipped (not enough data)"); continue; }
      const trades = backtest(candles);
      if (trades.length === 0) { console.log("0 trades"); continue; }
      const s = summarize(symbol, trades, days);
      results.push(s);
      console.log(`${s.trades} trades | WR: ${s.winRate.toFixed(0)}% | P&L: ${s.totalPnl >= 0 ? "+" : ""}$${s.totalPnl.toFixed(2)} | PF: ${s.profitFactor ? s.profitFactor.toFixed(2) : "—"}`);
    } catch (err) {
      console.log(`error: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 300)); // rate limit
  }

  results.sort((a, b) => b.totalPnl - a.totalPnl);

  console.log(`\n${"═".repeat(70)}`);
  console.log(`  RANKED RESULTS (by total P&L)`);
  console.log(`${"═".repeat(70)}`);
  console.log(`  ${"Symbol".padEnd(12)} ${"Trades".padEnd(8)} ${"Win%".padEnd(7)} ${"Total P&L".padEnd(12)} ${"Avg Win".padEnd(10)} ${"Avg Loss".padEnd(10)} PF`);
  console.log(`  ${"-".repeat(67)}`);
  for (const s of results) {
    const pnlStr = `${s.totalPnl >= 0 ? "+" : ""}$${s.totalPnl.toFixed(2)}`;
    console.log(
      `  ${s.symbol.replace("USDT","").padEnd(12)}` +
      `${String(s.trades).padEnd(8)}` +
      `${s.winRate.toFixed(0).padEnd(7)}%` +
      `${pnlStr.padEnd(12)}` +
      `+$${s.avgWin.toFixed(2)}`.padEnd(10) +
      `-$${s.avgLoss.toFixed(2)}`.padEnd(10) +
      `${s.profitFactor ? s.profitFactor.toFixed(2) : "—"}`
    );
  }
  console.log(`${"═".repeat(70)}\n`);

  const winners = results.filter(r => r.totalPnl > 0).map(r => r.symbol);
  const losers = results.filter(r => r.totalPnl <= 0).map(r => r.symbol);
  console.log(`  ✅ Profitable (${winners.length}): ${winners.map(s => s.replace("USDT","")).join(", ") || "none"}`);
  console.log(`  ❌ Losing    (${losers.length}): ${losers.map(s => s.replace("USDT","")).join(", ") || "none"}\n`);

  writeFileSync("backtest-all-results.json", JSON.stringify({ days, generatedAt: new Date().toISOString(), results }, null, 2));
  console.log(`  Full results saved → backtest-all-results.json\n`);
})();
