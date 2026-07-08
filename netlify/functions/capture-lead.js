// netlify/functions/capture-lead.js
//
// Direct lead capture — bypasses Netlify Forms auto-detection entirely.
// The website contact modal POSTs here; we store the lead in Netlify Blobs
// (store "leads-direct") and fire the Telegram alert. The /leads dashboard
// reads from this store as well, so leads show up regardless of whether
// Netlify's built-in form detection is working.
//
// This exists because Netlify form auto-detection did not register the
// AJAX-submitted form (forms:[]), so submissions had nowhere to land.

const { getStore } = require("@netlify/blobs");

const STORE = "leads-direct";

function store() {
  return getStore({
    name: STORE,
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_API_TOKEN,
    consistency: "strong",
  });
}

function json(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

async function telegramAlert(lead) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID || "8633099607";
  if (!token) return;
  let text =
    "🏡 *New lead — CRA website*\n\n" +
    "*Name:* " + (lead.name || "—") + "\n" +
    "*Email:* " + (lead.email || "—") + "\n" +
    "*Phone:* " + (lead.phone || "—") + "\n" +
    "*Interested in:* " + (lead.interest || "General Inquiry") + "\n" +
    "*Entity:* " + (lead.entity || "CRA");
  if (lead.message) text += "\n\n*Message:*\n" + lead.message;
  try {
    const r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true }),
    });
    if (!r.ok) {
      await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: text.replace(/[*_]/g, "") }),
      });
    }
  } catch (e) { /* never fail capture on alert error */ }
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  // Accept either JSON or urlencoded form bodies
  let data = {};
  try {
    const ct = (event.headers["content-type"] || "").toLowerCase();
    if (ct.includes("application/json")) {
      data = JSON.parse(event.body || "{}");
    } else {
      const params = new URLSearchParams(event.body || "");
      params.forEach((v, k) => { data[k] = v; });
    }
  } catch (e) {
    return json(400, { error: "bad body" });
  }

  // Honeypot — silently accept but drop bots
  if ((data["company-website"] || "").trim()) return json(200, { ok: true });

  const email = (data.email || "").trim();
  if (!email) return json(400, { error: "email required" });

  const lead = {
    id: "d" + Date.now().toString(36),
    name: (data.name || "").trim(),
    email,
    phone: (data.phone || "").trim(),
    interest: (data.interest || "General Inquiry").trim(),
    message: (data.message || "").trim(),
    entity: (data.entity || "CRA").trim(),
    source: (data.source || "website-contact-modal").trim(),
    created_at: new Date().toISOString(),
    status: "new",
  };

  try {
    const s = store();
    const existing = (await s.get("all", { type: "json" })) || [];
    // De-dupe by email (case-insensitive) — enrich, don't duplicate
    const lc = email.toLowerCase();
    const idx = existing.findIndex((l) => (l.email || "").toLowerCase() === lc);
    if (idx >= 0) {
      const prev = existing[idx];
      existing[idx] = Object.assign({}, prev, {
        name: prev.name || lead.name,
        phone: prev.phone || lead.phone,
        interest: prev.interest && prev.interest !== "General Inquiry" ? prev.interest : lead.interest,
        message: prev.message || lead.message,
      });
    } else {
      existing.unshift(lead);
    }
    await s.setJSON("all", existing);
  } catch (e) {
    return json(500, { error: "store failed: " + String((e && e.message) || e) });
  }

  await telegramAlert(lead);
  return json(200, { ok: true });
};
