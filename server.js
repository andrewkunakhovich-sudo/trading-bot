/**
 * Combined server — dashboard + bot loop.
 * Deploy this to Railway instead of bot.js directly.
 * Dashboard is served on Railway's public URL.
 * Bot runs every 60 seconds internally.
 */

import { spawn } from "child_process";
import { createServer } from "http";
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "fs";
import { extname } from "path";

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
  let file = req.url === "/" ? "dashboard.html" : req.url.slice(1);
  file = file.split("?")[0];
  if (!existsSync(file)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME[extname(file)] || "text/plain",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(readFileSync(file));
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
scheduleMorningReport();
scheduleWeeklyLearn();
scheduleMonthlyYoutubeUpdate();
