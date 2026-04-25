/**
 * Combined server — dashboard + bot loop.
 * Deploy this to Railway instead of bot.js directly.
 * Dashboard is served on Railway's public URL.
 * Bot runs every 60 seconds internally.
 */

import { spawn } from "child_process";
import { createServer } from "http";
import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { extname, join } from "path";

const DATA_DIR = process.env.DATA_DIR || ".";
if (DATA_DIR !== ".") { try { mkdirSync(DATA_DIR, { recursive: true }); } catch {} }
const LOCK_FILE = "bot.lock";

const PORT = process.env.PORT || 3000;
const INTERVAL_MS = 60 * 1000;

const MIME = {
  ".html": "text/html",
  ".json": "application/json",
  ".js": "text/javascript",
  ".css": "text/css",
};

createServer((req, res) => {
  let name = req.url.split("?")[0];
  if (name === "/" || name === "") name = "dashboard.html";
  else name = name.slice(1);
  // JSON data files live in DATA_DIR (persistent volume); static assets stay in CWD
  const filePath = extname(name) === ".json" ? join(DATA_DIR, name) : name;
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const isHtml = extname(name) === ".html";
  res.writeHead(200, {
    "Content-Type": MIME[extname(name)] || "text/plain",
    "Access-Control-Allow-Origin": "*",
    ...(isHtml && { "Cache-Control": "no-cache, no-store, must-revalidate" }),
  });
  res.end(readFileSync(filePath));
}).listen(PORT, () => {
  console.log(`Dashboard live on port ${PORT}`);
});

function runBot() {
  const time = new Date().toISOString().slice(11, 19);
  if (existsSync(LOCK_FILE)) {
    console.log(`\n[${time}] Previous bot cycle still running — skipping.`);
    return;
  }
  writeFileSync(LOCK_FILE, time);
  console.log(`\n[${time}] Running bot...`);
  const child = spawn("node", ["bot.js"], { stdio: "inherit" });
  child.on("exit", (code) => {
    try { unlinkSync(LOCK_FILE); } catch {}
    if (code !== 0) console.log(`Bot exited with code ${code}`);
  });
}

function runMorningReport() {
  console.log("\n☀️  Running morning report...");
  const child = spawn("node", ["morning-report.js"], { stdio: "inherit" });
  child.on("exit", (code) => {
    if (code !== 0) console.log(`Morning report exited with code ${code}`);
  });
}

// Schedule morning report at 14:00 UTC (9am EST) daily
function scheduleMorningReport() {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(14, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const msUntil = next - now;
  console.log(`☀️  Morning report scheduled for ${next.toISOString()}`);
  setTimeout(() => {
    runMorningReport();
    setInterval(runMorningReport, 24 * 60 * 60 * 1000);
  }, msUntil);
}

function runScript(name) {
  console.log(`\n🔄 Running ${name}...`);
  const child = spawn("node", [name], { stdio: "inherit" });
  child.on("exit", code => { if (code !== 0) console.log(`${name} exited with code ${code}`); });
}

// Self-learning — every Sunday at 06:00 UTC
function scheduleWeeklyLearn() {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(6, 0, 0, 0);
  while (next.getUTCDay() !== 0 || next <= now) next.setUTCDate(next.getUTCDate() + 1);
  console.log(`🧠 Self-learning scheduled for ${next.toISOString()}`);
  setTimeout(() => { runScript("learn.js"); setInterval(() => runScript("learn.js"), 7 * 24 * 60 * 60 * 1000); }, next - now);
}

// YouTube strategy update — 1st of every month at 07:00 UTC
function scheduleMonthlyYoutubeUpdate() {
  const now = new Date();
  const next = new Date();
  next.setUTCDate(1);
  next.setUTCHours(7, 0, 0, 0);
  if (next <= now) { next.setUTCMonth(next.getUTCMonth() + 1); next.setUTCDate(1); }
  console.log(`📺 YouTube strategy update scheduled for ${next.toISOString()}`);
  const msUntil = next - now;
  setTimeout(() => {
    runScript("youtube-update.js");
    setInterval(() => runScript("youtube-update.js"), 30 * 24 * 60 * 60 * 1000);
  }, msUntil);
}

console.log("Bot loop started — firing every 60 seconds.\n");
runBot();
setInterval(runBot, INTERVAL_MS);

// Run morning report immediately on startup if it hasn't been generated today
const morningReportFile = join(DATA_DIR, "morning-report.json");
if (!existsSync(morningReportFile)) {
  console.log("No morning report found — generating now...");
  runMorningReport();
} else {
  try {
    const report = JSON.parse(readFileSync(morningReportFile, "utf8"));
    const reportDate = report.date || "";
    const today = new Date().toISOString().slice(0, 10);
    if (reportDate !== today) {
      console.log("Morning report is stale — regenerating...");
      runMorningReport();
    }
  } catch { runMorningReport(); }
}

scheduleMorningReport();
scheduleWeeklyLearn();
scheduleMonthlyYoutubeUpdate();
