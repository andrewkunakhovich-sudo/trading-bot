/**
 * Morning Report — runs at 9am EST (14:00 UTC) via Railway cron.
 * Writes morning-report.json which the dashboard reads and displays.
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";

function loadFile(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    const text = readFileSync(path, "utf8").replace(/^﻿/, "");
    return JSON.parse(text);
  } catch { return fallback; }
}

async function fetchNewsHeadlines() {
  const feeds = [
    "https://cointelegraph.com/rss",
    "https://coindesk.com/arc/outboundfeeds/rss/",
    "https://feeds.reuters.com/reuters/businessNews",
  ];
  const headlines = [];
  const cutoff = Date.now() - 8 * 60 * 60 * 1000; // last 8 hours

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
    } catch {}
  }
  return headlines;
}

async function getMarketSentiment(headlines) {
  if (!process.env.GROQ_API_KEY || headlines.length === 0) return "neutral";
  const prompt = `Analyze these financial headlines from the last 8 hours and return ONLY one word: "bullish", "bearish", or "neutral".

Headlines:
${headlines.slice(0, 10).map((h, i) => `${i + 1}. ${h}`).join("\n")}`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: "llama3-8b-8192", messages: [{ role: "user", content: prompt }], temperature: 0.1, max_tokens: 10 }),
    });
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.toLowerCase() || "neutral";
    if (text.includes("bullish")) return "bullish";
    if (text.includes("bearish")) return "bearish";
    return "neutral";
  } catch { return "neutral"; }
}

async function run() {
  console.log("Generating morning report...");

  const tradesData = loadFile("trades-data.json", { trades: [], openPositions: [], stats: {} });
  const dailyPnl = loadFile("daily-pnl.json", {});
  const positions = tradesData.openPositions || [];
  const stats = tradesData.stats || {};

  // Overnight trades (last 8 hours)
  const cutoff = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
  const trades = tradesData.trades || [];
  const overnightTrades = trades.filter(t => t.timestamp >= cutoff && t.orderPlaced);

  // Yesterday's P&L
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = yesterday.toISOString().slice(0, 10);
  const yesterdayData = dailyPnl[yesterdayKey] || {};
  const yesterdayPnl = yesterdayData.total || 0;

  // Best and worst symbols from all time
  const bySymbol = stats.bySymbol || {};
  const symList = Object.entries(bySymbol).sort((a, b) => b[1].pnl - a[1].pnl);
  const bestSymbol = symList[0] || null;
  const worstSymbol = symList[symList.length - 1] || null;

  // News sentiment
  const headlines = await fetchNewsHeadlines();
  const sentiment = await getMarketSentiment(headlines);
  const topHeadlines = headlines.slice(0, 5);

  const report = {
    generatedAt: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    marketSentiment: sentiment,
    topHeadlines,
    openPositions: positions.length,
    openPositionsList: positions,
    overnightTrades: overnightTrades.length,
    yesterdayPnl,
    bestSymbol: bestSymbol ? { symbol: bestSymbol[0], pnl: bestSymbol[1].pnl, winRate: bestSymbol[1].trades > 0 ? Math.round(bestSymbol[1].wins / bestSymbol[1].trades * 100) : 0 } : null,
    worstSymbol: worstSymbol && worstSymbol[0] !== bestSymbol?.[0] ? { symbol: worstSymbol[0], pnl: worstSymbol[1].pnl, winRate: worstSymbol[1].trades > 0 ? Math.round(worstSymbol[1].wins / worstSymbol[1].trades * 100) : 0 } : null,
    totalPnlAllTime: Object.values(dailyPnl).reduce((sum, d) => sum + (d.total || 0), 0),
    maxDrawdown: stats.maxDrawdown || 0,
    sharpe: stats.sharpe || null,
  };

  writeFileSync("morning-report.json", JSON.stringify(report, null, 2));
  console.log(`Morning report saved.`);
  console.log(`  Sentiment: ${sentiment}`);
  console.log(`  Open positions: ${positions.length}`);
  console.log(`  Overnight trades: ${overnightTrades.length}`);
  console.log(`  Yesterday P&L: $${yesterdayPnl.toFixed(2)}`);
}

run().catch(err => { console.error("Morning report error:", err); process.exit(1); });
