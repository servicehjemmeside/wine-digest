require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const nodemailer = require("nodemailer");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "DELETE"],
  allowedHeaders: ["Content-Type"]
}));

const DB_FILE = path.join(__dirname, "digests.json");
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Storage ────────────────────────────────────────────────────────────────

function loadDigests() {
  if (!fs.existsSync(DB_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return []; }
}

function saveDigests(digests) {
  fs.writeFileSync(DB_FILE, JSON.stringify(digests, null, 2));
}

// ─── Gmail transport ────────────────────────────────────────────────────────

function createTransport() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
}

// ─── Wine search via Anthropic + web search ─────────────────────────────────

async function fetchWines(systemPrompt, userPrompt) {
  let messages = [{ role: "user", content: userPrompt }];

  for (let i = 0; i < 5; i++) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: systemPrompt,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages,
    });

    const textBlocks = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    if (textBlocks.trim()) {
      const clean = textBlocks.replace(/```json|```/g, "").trim();
      const start = clean.indexOf("[");
      const end = clean.lastIndexOf("]");
      if (start !== -1 && end !== -1) {
        try { return JSON.parse(clean.slice(start, end + 1)); }
        catch { /* keep retrying */ }
      }
    }

    if (response.stop_reason === "end_turn") break;
    messages.push({ role: "assistant", content: response.content });
    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (!toolUses.length) break;
    messages.push({
      role: "user",
      content: toolUses.map((t) => ({
        type: "tool_result",
        tool_use_id: t.id,
        content: "",
      })),
    });
  }
  return [];
}

async function getWinesForDigest(digest) {
  const { wineType, maxPrice, currency, region, includeTop, includeRising } = digest;
  const filters = [
    `Wine type: ${wineType || "any"}`,
    maxPrice ? `Max price: ${maxPrice} ${currency || "DKK"}` : null,
    region ? `Region: ${region}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const results = { top: [], rising: [] };

  const promises = [];

  if (includeTop !== false) {
    promises.push(
      fetchWines(
        `You are a wine expert. Search Vivino and Wine-Searcher. Return ONLY a valid JSON array, no markdown, no backticks. Fields: name, winery, vintage, type ("Red"|"White"|"Rosé"|"Sparkling"), region, rating (number), reviews (number), price_usd (number|null), price_dkk (number|null), grape, description (1-2 sentences), source. Return 5 top-rated wines with many reviews.`,
        `Find the top-rated wines this week:\n${filters}\nReturn JSON array only.`
      ).then((r) => { results.top = r; })
    );
  }

  if (includeRising !== false) {
    promises.push(
      fetchWines(
        `You are a wine trend analyst. Search Vivino for trending wines. Return ONLY a valid JSON array, no markdown, no backticks. Fields: name, winery, vintage, type ("Red"|"White"|"Rosé"|"Sparkling"), region, rating (number), reviews (number), price_usd (number|null), price_dkk (number|null), grape, description (1-2 sentences), source, momentum (short trend string like "Reviews up 3x in 6 months"). Return 5 rising star wines gaining rapid review momentum.`,
        `Find trending rising star wines this week:\n${filters}\nReturn JSON array only.`
      ).then((r) => { results.rising = r; })
    );
  }

  await Promise.all(promises);
  return results;
}

// ─── Email HTML builder ──────────────────────────────────────────────────────

function buildEmailHTML(topWines, risingWines, digest) {
  const cur = digest.currency || "DKK";
  const dateStr = new Date().toLocaleDateString("en-GB", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const stars = (r) => {
    const f = Math.floor(r), h = r % 1 >= 0.5 ? 1 : 0;
    return "★".repeat(f) + (h ? "½" : "") + "☆".repeat(5 - f - h);
  };
  const fmt = (n) => {
    if (!n) return "—";
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(0) + "k";
    return String(n);
  };

  const wineRow = (w) => {
    const pv = cur === "DKK" ? w.price_dkk : w.price_usd;
    const ps = pv ? `${Math.round(pv).toLocaleString()} ${cur}` : "—";
    return `
      <tr>
        <td style="padding:14px 0;border-bottom:1px solid #f0ede8;vertical-align:top;width:65%">
          <div style="font-family:Georgia,serif;font-size:15px;font-weight:600;color:#1a1a1a">${w.name || ""} ${w.vintage || ""}</div>
          <div style="font-size:12px;color:#666;margin-top:2px">${w.winery || ""} · ${w.region || ""}</div>
          <div style="font-size:12px;color:#999;font-style:italic;margin-top:2px">${w.grape || ""}</div>
          <div style="font-size:12px;color:#555;margin-top:5px;line-height:1.5">${w.description || ""}</div>
          ${w.momentum ? `<div style="font-size:11px;color:#0F6E56;margin-top:5px;font-weight:500">↑ ${w.momentum}</div>` : ""}
        </td>
        <td style="padding:14px 0;border-bottom:1px solid #f0ede8;vertical-align:top;text-align:right;width:35%">
          <div style="font-size:20px;font-weight:500;color:#1a1a1a">${parseFloat(w.rating || 0).toFixed(1)}</div>
          <div style="font-size:12px;color:#BA7517">${stars(parseFloat(w.rating || 0))}</div>
          <div style="font-size:11px;color:#999">${fmt(w.reviews)} reviews</div>
          <div style="font-size:14px;font-weight:500;color:#1a1a1a;margin-top:6px">${ps}</div>
        </td>
      </tr>`;
  };

  const topSection = topWines.length
    ? `<h2 style="font-family:Georgia,serif;font-size:20px;color:#1a1a1a;margin:0 0 4px 0;font-weight:600">Top Rated</h2>
       <p style="font-size:12px;color:#999;margin:0 0 12px 0">Established wines · high ratings · most reviewed</p>
       <table style="width:100%;border-collapse:collapse">${topWines.map(wineRow).join("")}</table>` : "";

  const risingSection = risingWines.length
    ? `<h2 style="font-family:Georgia,serif;font-size:20px;color:#1a1a1a;margin:28px 0 4px 0;font-weight:600">Rising Stars</h2>
       <p style="font-size:12px;color:#0F6E56;margin:0 0 12px 0;font-weight:500">Gaining momentum · trending upward on Vivino</p>
       <table style="width:100%;border-collapse:collapse">${risingWines.map(wineRow).join("")}</table>` : "";

  const filterSummary = [
    digest.wineType && digest.wineType !== "any" ? digest.wineType : "All types",
    digest.maxPrice ? `Max ${digest.maxPrice} ${cur}` : null,
    digest.region || null,
  ].filter(Boolean).join(" · ");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wine Digest</title></head>
<body style="margin:0;padding:0;background:#f7f4f0;font-family:Helvetica,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f4f0;padding:32px 16px">
    <tr><td>
      <table width="600" align="center" cellpadding="0" cellspacing="0"
        style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:600px;margin:0 auto">
        <tr>
          <td style="background:#1a1a1a;padding:28px 32px">
            <div style="font-family:Georgia,serif;font-size:24px;color:#ffffff;font-weight:600">🍷 Wine Discovery</div>
            <div style="font-size:12px;color:#888;margin-top:5px">Weekly digest · ${dateStr}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px">
            ${topSection}
            ${risingSection}
            <div style="margin-top:28px;padding-top:16px;border-top:1px solid #f0ede8;font-size:11px;color:#bbb;text-align:center;line-height:1.6">
              Weekly Wine Digest · Filters: ${filterSummary}<br>
              Powered by Vivino &amp; Wine-Searcher via Claude AI
            </div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ─── Send digest for one subscriber ─────────────────────────────────────────

async function sendDigestToSubscriber(digest) {
  console.log(`[digest] Sending to ${digest.email}…`);
  try {
    const { top, rising } = await getWinesForDigest(digest);
    const html = buildEmailHTML(top, rising, digest);
    const transport = createTransport();
    const dateStr = new Date().toLocaleDateString("en-GB", {
      weekday: "long", month: "long", day: "numeric",
    });
    await transport.sendMail({
      from: `Wine Discovery <${process.env.GMAIL_USER}>`,
      to: digest.email,
      subject: `🍷 Wine Digest — ${dateStr}`,
      html,
    });
    console.log(`[digest] ✓ Sent to ${digest.email}`);

    // Update last_sent
    const digests = loadDigests();
    const idx = digests.findIndex((d) => d.id === digest.id);
    if (idx !== -1) { digests[idx].last_sent = new Date().toISOString(); saveDigests(digests); }
  } catch (err) {
    console.error(`[digest] ✗ Failed for ${digest.email}:`, err.message);
  }
}

// ─── Cron: runs every day at 08:00, checks which digests fire today ──────────

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

cron.schedule("0 8 * * *", async () => {
  const today = DAY_NAMES[new Date().getDay()];
  console.log(`[cron] Running daily check — today is ${today}`);
  const digests = loadDigests().filter((d) => d.active && d.sendDay === today);
  console.log(`[cron] ${digests.length} digest(s) scheduled for today`);
  for (const digest of digests) await sendDigestToSubscriber(digest);
}, { timezone: process.env.TIMEZONE || "Europe/Copenhagen" });

// ─── REST API ────────────────────────────────────────────────────────────────

// GET /api/digests — list all subscriptions
app.get("/api/digests", (req, res) => {
  res.json(loadDigests());
});

// POST /api/digests — create or update a subscription
app.post("/api/digests", (req, res) => {
  const { email, sendDay, wineType, maxPrice, currency, region, includeTop, includeRising } = req.body;
  if (!email || !sendDay) return res.status(400).json({ error: "email and sendDay are required" });

  const digests = loadDigests();
  const existing = digests.findIndex((d) => d.email === email);
  const entry = {
    id: existing !== -1 ? digests[existing].id : Date.now().toString(),
    email, sendDay,
    wineType: wineType || "any",
    maxPrice: maxPrice || null,
    currency: currency || "DKK",
    region: region || null,
    includeTop: includeTop !== false,
    includeRising: includeRising !== false,
    active: true,
    created_at: existing !== -1 ? digests[existing].created_at : new Date().toISOString(),
    last_sent: existing !== -1 ? digests[existing].last_sent : null,
  };

  if (existing !== -1) digests[existing] = entry;
  else digests.push(entry);
  saveDigests(digests);
  res.json({ success: true, digest: entry });
});

// DELETE /api/digests/:id — unsubscribe
app.delete("/api/digests/:id", (req, res) => {
  const digests = loadDigests().filter((d) => d.id !== req.params.id);
  saveDigests(digests);
  res.json({ success: true });
});

// POST /api/digests/:id/send — send immediately (on-demand)
app.post("/api/digests/:id/send", async (req, res) => {
  const digest = loadDigests().find((d) => d.id === req.params.id);
  if (!digest) return res.status(404).json({ error: "Digest not found" });
  res.json({ success: true, message: "Digest sending in background…" });
  sendDigestToSubscriber(digest); // fire-and-forget
});

// POST /api/send-preview — send a one-off preview with custom settings
app.post("/api/send-preview", async (req, res) => {
  const digest = { id: "preview", active: true, ...req.body };
  if (!digest.email) return res.status(400).json({ error: "email required" });
  try {
    const { top, rising } = await getWinesForDigest(digest);
    const html = buildEmailHTML(top, rising, digest);
    const transport = createTransport();
    const dateStr = new Date().toLocaleDateString("en-GB", { weekday: "long", month: "long", day: "numeric" });
    await transport.sendMail({
      from: `Wine Discovery <${process.env.GMAIL_USER}>`,
      to: digest.email,
      subject: `🍷 Wine Digest Preview — ${dateStr}`,
      html,
    });
    res.json({ success: true, topCount: top.length, risingCount: rising.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/search — proxy wine search from frontend
app.post("/api/search", async (req, res) => {
  const { systemPrompt, userPrompt } = req.body;
  if (!systemPrompt || !userPrompt) return res.status(400).json({ error: "Missing prompts" });
  try {
    const wines = await fetchWines(systemPrompt, userPrompt);
    res.json({ wines });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get("/api/health", (req, res) => {
  const digests = loadDigests();
  res.json({
    status: "ok",
    uptime: Math.round(process.uptime()) + "s",
    subscribers: digests.length,
    active: digests.filter((d) => d.active).length,
    timezone: process.env.TIMEZONE || "Europe/Copenhagen",
    cron: "daily at 08:00",
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🍷 Wine Digest Server running on port ${PORT}`);
  console.log(`   Cron: daily at 08:00 (${process.env.TIMEZONE || "Europe/Copenhagen"})`);
  console.log(`   Subscribers: ${loadDigests().length}\n`);
});
