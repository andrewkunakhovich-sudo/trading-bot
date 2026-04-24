/**
 * YouTube Strategy Updater — runs monthly.
 * Re-scrapes configured trader channels via Apify,
 * extracts updated strategy rules via Groq, merges into rules.json.
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";

const TRADER_CHANNELS = [
  "https://www.youtube.com/@LewisJacksonTrading",
];

async function scrapeTranscripts() {
  if (!process.env.APIFY_API_KEY) { console.log("No APIFY_API_KEY — skipping transcript scrape."); return null; }

  console.log("Scraping latest trader videos via Apify...");
  try {
    // Start Apify actor run
    const startRes = await fetch("https://api.apify.com/v2/acts/bernardo_lewczuk~youtube-transcript-scraper/runs?token=" + process.env.APIFY_API_KEY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelUrls: TRADER_CHANNELS, maxVideos: 5 }),
    });
    const startData = await startRes.json();
    const runId = startData.data?.id;
    if (!runId) { console.log("Failed to start Apify run."); return null; }

    console.log(`  Apify run started: ${runId}`);

    // Poll for completion (max 5 min)
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 10000));
      const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${process.env.APIFY_API_KEY}`);
      const status = await statusRes.json();
      if (status.data?.status === "SUCCEEDED") {
        const dataRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${process.env.APIFY_API_KEY}`);
        const items = await dataRes.json();
        return items.map(v => v.transcript || v.text || "").join("\n\n").slice(0, 50000);
      }
      if (status.data?.status === "FAILED") { console.log("Apify run failed."); return null; }
    }
    console.log("Apify run timed out.");
    return null;
  } catch (err) { console.log(`Apify error: ${err.message}`); return null; }
}

async function extractStrategyUpdates(transcripts, currentRules) {
  if (!process.env.GROQ_API_KEY || !transcripts) return null;

  const prompt = `You are a trading strategy analyst. Here are recent video transcripts from a crypto trader:

${transcripts.slice(0, 20000)}

Here is the current trading strategy in JSON format:
${JSON.stringify(currentRules, null, 2)}

Based on the new content, suggest updates to the strategy. Return ONLY a valid JSON object with the same structure as the current rules, with any updates applied. Only change things that are clearly mentioned in the transcripts. If nothing new is mentioned, return the same rules unchanged.`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: "llama3-70b-8192", messages: [{ role: "user", content: prompt }], temperature: 0.2, max_tokens: 2000 }),
    });
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || "";
    const json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "null");
    return json;
  } catch { return null; }
}

async function run() {
  console.log("YouTube strategy updater running...");

  const currentRules = JSON.parse(readFileSync("rules.json", "utf8"));
  const transcripts = await scrapeTranscripts();

  if (!transcripts) {
    console.log("No transcripts retrieved — rules.json unchanged.");
    return;
  }

  console.log(`  Retrieved ${transcripts.length} characters of transcript content.`);
  console.log("  Analyzing with Groq...");

  const updatedRules = await extractStrategyUpdates(transcripts, currentRules);

  if (!updatedRules) {
    console.log("  No strategy updates extracted — rules.json unchanged.");
    return;
  }

  // Backup current rules
  writeFileSync("rules.json.backup", JSON.stringify(currentRules, null, 2));

  // Save updated rules
  updatedRules._lastUpdated = new Date().toISOString();
  writeFileSync("rules.json", JSON.stringify(updatedRules, null, 2));

  console.log("  rules.json updated with latest strategy insights.");
  console.log("  Previous rules backed up to rules.json.backup");
}

run().catch(err => { console.error("YouTube update error:", err); process.exit(1); });
