// netlify/functions/capture-sub.js
//
// Public intake endpoint for the "Bid My Job" QR signs. /bid POSTs here.
//
// Deliberately mirrors capture-lead.js: store in Netlify Blobs, alert Cole on
// Telegram, never fail the submission because a downstream alert hiccuped. A
// sub standing on the side of the road gets one shot at this — if the store
// write succeeds we return ok, and everything after that is best-effort.
//
// Stores:
//   "subs"       key "all"  → array of sub/vendor records
//   "sub-files"  key <id>   → base64 photo (business card, license, COI)
//
// Env vars (Netlify → Site configuration → Environment variables):
//   NETLIFY_SITE_ID, NETLIFY_API_TOKEN  — required (Blobs access)
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID — instant alert to Cole (optional)
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM — SMS auto-reply (optional)
//   RESEND_API_KEY, RESEND_FROM         — email auto-reply (optional)

const { getStore } = require("@netlify/blobs");

const MAX_FILES = 4;
const MAX_FILE_BYTES = 1_500_000; // ~1.5 MB of base64 per photo after client downscale

function json(code, obj) {
  return {
    statusCode: code,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

function store(name) {
  return getStore({
    name,
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_API_TOKEN,
    consistency: "strong",
  });
}

// Normalize a US phone to digits so "(501) 555-0123" and "5015550123" dedupe.
function phoneKey(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") return d.slice(1);
  return d;
}

function clean(v, max) {
  return String(v == null ? "" : v).trim().slice(0, max || 300);
}

function cleanList(v, max) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => clean(x, 60)).filter(Boolean).slice(0, max || 12);
}

// ── Telegram ────────────────────────────────────────────────────────────────
async function telegramAlert(rec, isReturning) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID || "8633099607";
  if (!token) return;

  const kindLabel =
    rec.kind === "vendor" ? "Vendor / Supplier"
    : rec.kind === "worker" ? "Looking for work (employee)"
    : "Subcontractor";

  const lines = [
    (isReturning ? "🔁 *Sub scan — updated existing*" : "🔨 *New sub scan — Bid My Job*"),
    "",
    "*Type:* " + kindLabel,
    "*Name:* " + (rec.name || "—"),
  ];
  if (rec.company) lines.push("*Company:* " + rec.company);
  lines.push("*Phone:* " + (rec.phone || "—"));
  if (rec.email) lines.push("*Email:* " + rec.email);
  if (rec.trades.length) lines.push("*Trades:* " + rec.trades.join(", "));
  lines.push("*Language:* " + (rec.lang === "es" ? "Spanish" : "English"));
  if (rec.city) lines.push("*Based in:* " + rec.city);
  if (rec.crew_size) lines.push("*Crew size:* " + rec.crew_size);
  if (rec.license_no) lines.push("*License #:* " + rec.license_no);
  if (rec.insured) lines.push("*Insured:* yes" + (rec.ins_carrier ? " (" + rec.ins_carrier + ")" : ""));
  if (rec.pricing_mode) lines.push("*Pricing:* " + rec.pricing_mode);
  if (rec.files.length) lines.push("*Photos:* " + rec.files.length + " attached");
  if (rec.src) lines.push("*Scanned sign:* " + rec.src);
  if (rec.notes) lines.push("", "*Notes:*", rec.notes);

  const text = lines.join("\n");
  const url = "https://api.telegram.org/bot" + token + "/sendMessage";
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true }),
    });
    if (!r.ok) {
      // Markdown parse failure (stray * or _ in a company name) — retry plain.
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: text.replace(/[*_`[\]]/g, "") }),
      });
    }
  } catch (e) { /* never fail capture on alert error */ }
}

// ── Auto-reply to the sub, in their language ────────────────────────────────
// Kept short and matched word-for-word to the sample messages submitted with
// the A2P campaign — carriers compare them. Every SMS carries STOP/HELP.
const REPLY = {
  en: "CRA Construction: thanks for scanning. You're on our list and we'll reach out when we have work in your trade. Reply STOP to stop, HELP for help. Msg&data rates may apply.",
  es: "CRA Construction: gracias por escanear. Está en nuestra lista y le contactaremos cuando tengamos trabajo de su oficio. Responda STOP para cancelar, HELP para ayuda. Pueden aplicar tarifas.",
};

async function smsReply(rec) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  // No box checked, no text. This is the line that keeps the campaign alive.
  if (!rec.sms_consent) return;
  if (!sid || !auth || !from || !rec.phone) return;
  try {
    const body = new URLSearchParams({
      To: rec.phone,
      From: from,
      Body: REPLY[rec.lang] || REPLY.en,
    });
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(sid + ":" + auth).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
  } catch (e) { /* best effort */ }
}

async function emailReply(rec) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !rec.email) return;
  const from = process.env.RESEND_FROM || "CRA Construction <hello@cra-construction.com>";
  const subject = rec.lang === "es"
    ? "CRA Construction — recibimos su información"
    : "CRA Construction — we got your info";
  const html =
    '<div style="font-family:system-ui,sans-serif;font-size:15px;color:#1a1814;line-height:1.6">' +
    "<p>" + (REPLY[rec.lang] || REPLY.en) + "</p>" +
    '<p style="color:#6b6560;font-size:13px">CRA Construction · Little Rock, AR</p></div>';
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [rec.email], subject, html }),
    });
  } catch (e) { /* best effort */ }
}

// ── Handler ─────────────────────────────────────────────────────────────────
exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  let data;
  try { data = JSON.parse(event.body || "{}"); }
  catch (e) { return json(400, { error: "bad body" }); }

  // Honeypot — bots fill every field; silently accept and drop.
  if (clean(data["company-website"])) return json(200, { ok: true });

  const phone = clean(data.phone, 40);
  const pkey = phoneKey(phone);
  if (pkey.length < 10) return json(400, { error: "phone required" });

  const now = new Date().toISOString();
  const id = "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // Photos: written to their own store so the record array stays small.
  const files = [];
  const incoming = Array.isArray(data.files) ? data.files.slice(0, MAX_FILES) : [];
  for (const f of incoming) {
    const b64 = String((f && f.data) || "");
    if (!b64 || b64.length > MAX_FILE_BYTES) continue;
    const fid = id + "-" + files.length;
    try {
      await store("sub-files").setJSON(fid, {
        data: b64,
        mime: clean((f && f.mime) || "image/jpeg", 40),
        label: clean((f && f.label) || "photo", 40),
        created_at: now,
      });
      files.push({ id: fid, label: clean((f && f.label) || "photo", 40) });
    } catch (e) { /* a failed photo must not sink the whole submission */ }
  }

  const rec = {
    id,
    kind: ["sub", "vendor", "worker"].indexOf(data.kind) >= 0 ? data.kind : "sub",
    name: clean(data.name, 120),
    company: clean(data.company, 140),
    phone,
    phone_key: pkey,
    email: clean(data.email, 140).toLowerCase(),
    trades: cleanList(data.trades, 12),
    lang: data.lang === "es" ? "es" : "en",
    city: clean(data.city, 100),
    service_area: clean(data.service_area, 160),
    crew_size: clean(data.crew_size, 40),
    years: clean(data.years, 40),
    license_no: clean(data.license_no, 80),
    license_exp: clean(data.license_exp, 20),
    insured: !!data.insured,
    ins_carrier: clean(data.ins_carrier, 120),
    ins_exp: clean(data.ins_exp, 20),
    workers_comp: !!data.workers_comp,
    pricing_mode: clean(data.pricing_mode, 40),
    rate_notes: clean(data.rate_notes, 500),
    notes: clean(data.notes, 1000),
    sms_consent: !!data.sms_consent,
    consent_text: clean(data.consent_text, 600),
    consent_at: data.sms_consent ? now : "",
    files,
    src: clean(data.src, 60),
    created_at: now,
    updated_at: now,
    status: "new",
    ratings: [],
  };

  let isReturning = false;
  try {
    const s = store("subs");
    const all = (await s.get("all", { type: "json" })) || [];
    const idx = all.findIndex((x) => x.phone_key === pkey);

    if (idx >= 0) {
      // Same guy scanned another sign. Enrich the existing record rather than
      // creating a second one — but never overwrite what your crew has since
      // edited in the portal (status, ratings, notes stay put).
      isReturning = true;
      const prev = all[idx];
      const merged = Object.assign({}, prev);
      const fillable = ["name", "company", "email", "city", "service_area", "crew_size",
                        "years", "license_no", "license_exp", "ins_carrier", "ins_exp",
                        "pricing_mode", "rate_notes"];
      fillable.forEach((k) => { if (!merged[k] && rec[k]) merged[k] = rec[k]; });
      merged.trades = Array.from(new Set((prev.trades || []).concat(rec.trades)));
      merged.insured = prev.insured || rec.insured;
      merged.workers_comp = prev.workers_comp || rec.workers_comp;
      // Consent is latest-wins, not sticky: an unchecked box on a later scan
      // is a withdrawal, and honoring that is the whole point of having it.
      merged.sms_consent = rec.sms_consent;
      merged.consent_text = rec.sms_consent ? rec.consent_text : "";
      merged.consent_at = rec.sms_consent ? (prev.consent_at || now) : "";
      merged.files = (prev.files || []).concat(files).slice(0, 12);
      merged.lang = rec.lang;
      merged.updated_at = now;
      merged.rescans = (prev.rescans || 0) + 1;
      if (rec.src && rec.src !== prev.src) {
        merged.also_scanned = Array.from(new Set((prev.also_scanned || []).concat([rec.src])));
      }
      if (rec.notes) merged.notes = (prev.notes ? prev.notes + "\n— — —\n" : "") + rec.notes;
      all[idx] = merged;
    } else {
      all.unshift(rec);
    }
    await s.setJSON("all", all);
  } catch (e) {
    return json(500, { error: "store failed: " + String((e && e.message) || e) });
  }

  await telegramAlert(rec, isReturning);
  await smsReply(rec);
  await emailReply(rec);

  return json(200, { ok: true, returning: isReturning });
};
