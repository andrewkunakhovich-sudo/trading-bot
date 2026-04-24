/**
 * Backtesting engine — runs the bot strategy against historical Kraken 1H data.
 * Usage: node backtest.js [SYMBOL] [DAYS]
 *   node backtest.js BTCUSDT 90
 *   node backtest.js ETHUSDT 180
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";

const symbol = process.argv[2] || "BTCUSDT";
const days = parseInt(process.argv[3] || "90");

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * multiplier + ema * (1 - multiplier);
  return ema;
}

function calcEMAArray(closes, period) {
  if (closes.length < period) return [];
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result = [ema];
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
    result.push(ema);
  }
  return result;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const rs = (gains / period) / (losses / period || 0.0001);
  return 100 - 100 / (1 + rs);
}

function calcVWAP(candles) {
  const midnightUTC = new Date(candles[0].time);
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const session = candles.filter(c => c.time >= midnightUTC.getTime());
  if (!session.length) return null;
  const cumTPV = session.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0);
  const cumVol = session.reduce((s, c) => s + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
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
  return { histogram: macdLine[macdLine.length - 1] - signalLine[signalLine.length - 1] };
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
  const plusDI = sPlus / sTR * 100;
  const minusDI = sMinus / sTR * 100;
  return Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
}

const OKX_SYMBOL_MAP = { "MATICUSDT": "POLUSDT" };

async function fetchHistoricalCandles(symbol, days) {
  const mapped = OKX_SYMBOL_MAP[symbol] || symbol;
  const instId = mapped.replace("USDT", "-USDT");
  const totalNeeded = days * 24;
  const allCandles = [];
  let after = "";

  console.log(`Fetching ${days}-day 1H history for ${symbol} from OKX...`);

  while (allCandles.length < totalNeeded) {
    const param = after ? `&after=${after}` : "";
    const url = `https://www.okx.com/api/v5/market/history-candles?instId=${instId}&bar=1H&limit=300${param}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.code !== "0" || !data.data?.length) break;
    const batch = data.data.map(k => ({
      time: parseInt(k[0]),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
    allCandles.push(...batch);
    after = batch[batch.length - 1].time;
    if (batch.length < 300) break;
  }

  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  return allCandles.reverse().filter(c => c.time >= cutoff);
}

function runBacktest(candles, portfolioValue = 10000, maxTradeSizeUSD = 500) {
  const trades = [];
  let position = null;
  const WINDOW = 50; // minimum candles needed before evaluating

  for (let i = WINDOW; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const closes = window.map(c => c.close);
    const price = closes[closes.length - 1];

    const ema8 = calcEMA(closes, 8);
    const vwap = calcVWAP(window);
    const rsi3 = calcRSI(closes, 3);
    const adx = calcADX(window, 14);
    const macd = calcMACD(closes, 12, 26, 9);
    const atr = calcATR(window, 14);

    if (!vwap || !rsi3 || !ema8) continue;

    // Check exit on open position
    if (position) {
      position.highestPrice = Math.max(position.highestPrice, price);
      const trailingStop = position.highestPrice * 0.997;
      let exitReason = null;

      const gainPct = (price - position.entryPrice) / position.entryPrice * 100;
      if (gainPct <= -1.0) exitReason = "hard_stop";
      else if (gainPct >= 3.0) exitReason = "take_profit";
      else if (price <= trailingStop) exitReason = "trailing_stop";
      else if (rsi3 > 65) exitReason = "rsi_exit";
      else if (price <= vwap) exitReason = "vwap_touch";
      else if (price < ema8) exitReason = "ema_cross";

      if (exitReason) {
        const pnlUSD = (price - position.entryPrice) * position.quantity;
        const pnlPct = (price - position.entryPrice) / position.entryPrice * 100;
        trades.push({
          entryTime: new Date(position.entryTime).toISOString().slice(0, 16),
          exitTime: new Date(candles[i].time).toISOString().slice(0, 16),
          entryPrice: position.entryPrice,
          exitPrice: price,
          pnlUSD,
          pnlPct,
          won: pnlUSD > 0,
          reason: exitReason,
        });
        position = null;
      }
    }

    // Check entry conditions
    if (!position) {
      const bullish = price > vwap && price > ema8;
      const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;

      const lastMove = Math.abs((closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2] * 100);
      if (lastMove > 2) continue;
      if (adx !== null && adx < 10) continue;

      const avgVol = window.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20;
      if (window[window.length - 1].volume < avgVol * 1.0) continue;

      if (bullish && rsi3 < 28 && distFromVWAP < 0.8) {
        const macdOk = macd ? macd.histogram > 0 : true;
        if (!macdOk) continue;

        const tradeSize = atr
          ? Math.min((portfolioValue * 0.01) / (atr / price * 1.5), maxTradeSizeUSD)
          : Math.min(portfolioValue * 0.01, maxTradeSizeUSD);

        position = {
          entryPrice: price,
          highestPrice: price,
          entryTime: candles[i].time,
          quantity: tradeSize / price,
          sizeUSD: tradeSize,
        };
      }
    }
  }

  // Close any open position at end of data
  if (position) {
    const price = candles[candles.length - 1].close;
    const pnlUSD = (price - position.entryPrice) * position.quantity;
    trades.push({
      entryTime: new Date(position.entryTime).toISOString().slice(0, 16),
      exitTime: new Date(candles[candles.length - 1].time).toISOString().slice(0, 16),
      entryPrice: position.entryPrice,
      exitPrice: price,
      pnlUSD,
      pnlPct: (price - position.entryPrice) / position.entryPrice * 100,
      won: pnlUSD > 0,
      reason: "end_of_data",
    });
  }

  return trades;
}

function printReport(trades, symbol, days) {
  const wins = trades.filter(t => t.won).length;
  const totalPnl = trades.reduce((s, t) => s + t.pnlUSD, 0);
  const avgWin = wins ? trades.filter(t => t.won).reduce((s, t) => s + t.pnlUSD, 0) / wins : 0;
  const losses = trades.length - wins;
  const avgLoss = losses ? trades.filter(t => !t.won).reduce((s, t) => s + t.pnlUSD, 0) / losses : 0;
  const winRate = trades.length ? (wins / trades.length * 100).toFixed(1) : 0;

  // Max drawdown
  let peak = 0, running = 0, maxDrawdown = 0;
  for (const t of trades) {
    running += t.pnlUSD;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Sharpe
  let sharpe = "N/A";
  if (trades.length >= 2) {
    const returns = trades.map(t => t.pnlUSD);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const std = Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length);
    if (std > 0) sharpe = ((mean / std) * Math.sqrt(252)).toFixed(2);
  }

  // Exit reason breakdown
  const byReason = {};
  trades.forEach(t => {
    byReason[t.reason] = (byReason[t.reason] || 0) + 1;
  });

  console.log(`\n${"═".repeat(57)}`);
  console.log(`  Backtest Results — ${symbol} (last ${days} days, 1H candles)`);
  console.log(`${"═".repeat(57)}`);
  console.log(`  Total trades   : ${trades.length}`);
  console.log(`  Win rate       : ${winRate}% (${wins}W / ${losses}L)`);
  console.log(`  Total P&L      : ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`);
  console.log(`  Avg win        : +$${avgWin.toFixed(2)}`);
  console.log(`  Avg loss       : $${avgLoss.toFixed(2)}`);
  console.log(`  Max drawdown   : $${maxDrawdown.toFixed(2)}`);
  console.log(`  Sharpe ratio   : ${sharpe}`);
  console.log(`\n  Exit reasons:`);
  Object.entries(byReason).forEach(([r, n]) => console.log(`    ${r.padEnd(16)} ${n}`));
  console.log(`\n  Last 5 trades:`);
  trades.slice(-5).forEach(t => {
    const sign = t.pnlUSD >= 0 ? "+" : "";
    console.log(`    ${t.entryTime} → ${t.exitTime}  ${sign}$${t.pnlUSD.toFixed(2)} (${sign}${t.pnlPct.toFixed(2)}%)  [${t.reason}]`);
  });
  console.log(`${"═".repeat(57)}\n`);

  writeFileSync("backtest-results.json", JSON.stringify({ symbol, days, trades, summary: { totalTrades: trades.length, wins, losses, winRate: parseFloat(winRate), totalPnl, avgWin, avgLoss, maxDrawdown, sharpe, byReason } }, null, 2));
  console.log(`Full results saved → backtest-results.json`);
}

(async () => {
  try {
    const candles = await fetchHistoricalCandles(symbol, days);
    console.log(`  Got ${candles.length} candles`);
    if (candles.length < 60) { console.log("Not enough data to backtest."); process.exit(1); }
    const trades = runBacktest(candles);
    printReport(trades, symbol, days);
  } catch (err) {
    console.error("Backtest error:", err.message);
    process.exit(1);
  }
})();
