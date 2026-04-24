/**
 * Self-learning analyzer — runs weekly.
 * Reads trade history, finds which symbols win vs lose,
 * and writes learned-adjustments.json for the bot to use.
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";

function loadFile(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")); } catch { return fallback; }
}

async function summarizeWithGroq(analysis) {
  if (!process.env.GROQ_API_KEY) return null;
  const prompt = `You are a trading strategy optimizer. Here is the performance data for a crypto trading bot:

${JSON.stringify(analysis, null, 2)}

Based on this data, provide 3 specific, actionable strategy improvements in plain English. Focus on:
1. Which symbols to avoid or focus on
2. Any time patterns (best/worst hours)
3. One indicator adjustment to consider

Keep each point to one sentence. Return as a JSON array of strings.`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: "llama3-8b-8192", messages: [{ role: "user", content: prompt }], temperature: 0.3, max_tokens: 300 }),
    });
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || "[]";
    return JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] || "[]");
  } catch { return null; }
}

async function run() {
  console.log("Running self-learning analysis...");

  const dailyPnl = loadFile("daily-pnl.json", {});
  const days = Object.keys(dailyPnl);

  if (days.length < 3) {
    console.log("Not enough trading history yet (need at least 3 days). Skipping.");
    return;
  }

  // Aggregate per-symbol performance
  const bySymbol = {};
  Object.values(dailyPnl).forEach(day => {
    Object.entries(day.bySymbol || {}).forEach(([sym, s]) => {
      if (!bySymbol[sym]) bySymbol[sym] = { pnl: 0, trades: 0, wins: 0 };
      bySymbol[sym].pnl += s.pnl;
      bySymbol[sym].trades += s.trades;
      bySymbol[sym].wins += s.wins;
    });
  });

  // Aggregate per-hour performance
  const byHour = {};
  Object.values(dailyPnl).forEach(day => {
    Object.entries(day.byHour || {}).forEach(([hr, h]) => {
      if (!byHour[hr]) byHour[hr] = { pnl: 0, trades: 0 };
      byHour[hr].pnl += h.pnl;
      byHour[hr].trades += h.trades;
    });
  });

  // Find consistently losing symbols (min 5 trades, win rate < 30%)
  const excludedSymbols = Object.entries(bySymbol)
    .filter(([, s]) => s.trades >= 5 && (s.wins / s.trades) < 0.30)
    .map(([sym]) => sym);

  // Find top performing symbols (win rate > 60%, min 5 trades) — boost their size
  const positionMultipliers = {};
  Object.entries(bySymbol).forEach(([sym, s]) => {
    if (s.trades >= 5) {
      const wr = s.wins / s.trades;
      if (wr > 0.60) positionMultipliers[sym] = 1.25;
      else if (wr < 0.30) positionMultipliers[sym] = 0.5;
    }
  });

  // Best and worst hours
  const bestHour = Object.entries(byHour).sort((a, b) => b[1].pnl - a[1].pnl)[0];
  const worstHour = Object.entries(byHour).sort((a, b) => a[1].pnl - b[1].pnl)[0];

  const analysis = {
    daysAnalyzed: days.length,
    totalSymbols: Object.keys(bySymbol).length,
    topPerformers: Object.entries(bySymbol)
      .filter(([, s]) => s.trades >= 3)
      .sort((a, b) => b[1].pnl - a[1].pnl)
      .slice(0, 5)
      .map(([sym, s]) => ({ sym, pnl: s.pnl.toFixed(2), winRate: `${Math.round(s.wins / s.trades * 100)}%` })),
    worstPerformers: Object.entries(bySymbol)
      .filter(([, s]) => s.trades >= 3)
      .sort((a, b) => a[1].pnl - b[1].pnl)
      .slice(0, 5)
      .map(([sym, s]) => ({ sym, pnl: s.pnl.toFixed(2), winRate: `${Math.round(s.wins / s.trades * 100)}%` })),
    bestHour: bestHour ? `${bestHour[0]}:00 UTC ($${bestHour[1].pnl.toFixed(2)})` : null,
    worstHour: worstHour ? `${worstHour[0]}:00 UTC ($${worstHour[1].pnl.toFixed(2)})` : null,
    excludedSymbols,
  };

  console.log("\n── Analysis Results ─────────────────────────────────────\n");
  console.log(`  Days analyzed: ${analysis.daysAnalyzed}`);
  console.log(`  Excluded symbols (poor performance): ${excludedSymbols.join(", ") || "none"}`);
  console.log(`  Best hour: ${analysis.bestHour || "N/A"}`);
  console.log(`  Worst hour: ${analysis.worstHour || "N/A"}`);

  // Get Groq recommendations
  const recommendations = await summarizeWithGroq(analysis);
  if (recommendations) {
    console.log("\n── Groq Recommendations ─────────────────────────────────\n");
    recommendations.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
  }

  const adjustments = {
    updatedAt: new Date().toISOString(),
    daysAnalyzed: days.length,
    excludedSymbols,
    positionMultipliers,
    recommendations: recommendations || [],
    analysis,
  };

  writeFileSync("learned-adjustments.json", JSON.stringify(adjustments, null, 2));
  console.log("\nLearned adjustments saved to learned-adjustments.json");
}

run().catch(err => { console.error("Learn error:", err); process.exit(1); });
