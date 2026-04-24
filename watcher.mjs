/**
 * Local TradingView watcher — runs node bot.js every minute in sync with Railway.
 * Keeps TradingView chart switching to whichever symbol fires a signal.
 * Run: node watcher.mjs
 */

import { execSync } from "child_process";

const INTERVAL_MS = 60 * 1000;

function run() {
  const time = new Date().toISOString().slice(11, 19);
  console.log(`\n[${time}] Running bot...`);
  try {
    execSync("node bot.js", { stdio: "inherit" });
  } catch {
    // bot.js exits with error — keep watcher alive
  }
}

console.log("TradingView watcher started — running every minute. Ctrl+C to stop.\n");
run();
setInterval(run, INTERVAL_MS);
