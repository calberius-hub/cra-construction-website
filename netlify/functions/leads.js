// netlify/functions/leads.js
//
// Backing API for the /leads dashboard. Zero external deps (fetch only).
//
// Actions (POST JSON { action, ... }):
//   "list"          → all leads from the Netlify Forms submissions store,
//                     merged with status overrides from Netlify Blobs.
//   "set-status"    → { email, status } persist a status override in Blobs.
//   "prepare-blast" → { subject, html, interest } build recipient list +
//                     return a confirm token (nothing sent yet).
//   "send-blast"    → { token } actually send via Resend (approval-gated).
//
// Auth: every request must carry header  x-leads-key: <LEADS_DASHBOARD_KEY>.
//
// Env vars (Netlify → Site config → Environment variables):
//   LEADS_DASHBOARD_KEY   — shared password for the dashboard (required)
//   NETLIFY_API_TOKEN     — personal access token to read form submissions (required)
//   NETLIFY_SITE_ID       — this site's API id (required)
//   RESEND_API_KEY        — for send-blast (optional until you send email)
//   RESEND_FROM           — e.g. "CRA Construction <hello@cra-construction.com>"

const { getStore } = require("@netlify/blobs");

const NETLIFY_API = "https://api.netlify.com/api/v1";
const FORM_NAME = "cra-leads";
const BLOBS_STORE = "lead-status";

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

// ── Netlify Blobs (status overrides + pending blast) ─────────────────────────
// getStore auto-configures inside Netlify Functions.
function store() {
  return getStore({ name: BLOBS_STORE, consistency: "strong" });
}

async function blobGet(key) {
  try {
    const v = await store().get(key, { type: "json" });
    return v || null;
  } catch (e) {
    return null;
  }
}

async function blobSet(key, value) {
  try {
    await store().setJSON(key, value);
    return true;
  } catch (e) {
    return false;
  }
}

// ── Fetch all cra-leads submissions ──────────────────────────────────────────
async function fetchSubmissions(siteId, token) {
  const formsRes = await fetch(`${NETLIFY_API}/sites/${siteId}/forms`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!formsRes.ok) throw new Error(`forms list failed: ${formsRes.status}`);
  const forms = await formsRes.json();
  const form = forms.find((f) => f.name === FORM_NAME);
  if (!form) return [];

  const out = [];
  let page = 1;
  for (;;) {
    const res = await fetch(
      `${NETLIFY_API}/forms/${form.id}/submissions?per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) break;
    const batch = await res.json();
    if (!batch.length) break;
    out.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return out;
}

function toLead(sub) {
  const d = sub.data || {};
  return {
    id: sub.id,
    name: (d.name || "").trim(),
    email: (d.email || "").trim(),
    phone: (d.phone || "").trim(),
    interest: (d.interest || "General Inquiry").trim(),
    message: (d.message || "").trim(),
    entity: (d.entity || "CRA").trim(),
    source: (d.source || "").trim(),
    created_at: sub.created_at,
    status: "new", // default; overlaid from Blobs below
  };
}

// ── Resend send ──────────────────────────────────────────────────────────────
async function resendSend(to, subject, html, from, replyTo) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], reply_to: replyTo, subject, html }),
  });
  return { ok: res.ok, body: await res.text() };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const key = process.env.LEADS_DASHBOARD_KEY;
  if (!key) return json(500, { error: "LEADS_DASHBOARD_KEY not configured" });
  if ((event.headers["x-leads-key"] || "") !== key) {
    return json(401, { error: "unauthorized" });
  }

  const siteId = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN;
  if (!siteId || !token) {
    return json(500, { error: "NETLIFY_SITE_ID / NETLIFY_API_TOKEN not configured" });
  }

  let req;
  try { req = JSON.parse(event.body || "{}"); }
  catch (e) { return json(400, { error: "bad JSON" }); }

  const action = req.action;

  try {
    if (action === "list") {
      const subs = await fetchSubmissions(siteId, token);
      const overrides = (await blobGet("overrides")) || {};
      const leads = subs.map((s) => {
        const lead = toLead(s);
        const ov = overrides[lead.email.toLowerCase()];
        if (ov && ov.status) lead.status = ov.status;
        if (ov && ov.notes) lead.notes = ov.notes;
        return lead;
      });
      // newest first
      leads.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return json(200, { leads, count: leads.length });
    }

    if (action === "set-status") {
      const email = (req.email || "").toLowerCase();
      if (!email) return json(400, { error: "email required" });
      const overrides = (await blobGet("overrides")) || {};
      overrides[email] = Object.assign({}, overrides[email], {
        status: req.status || "new",
        notes: req.notes != null ? req.notes : (overrides[email] || {}).notes || "",
        updated_at: new Date().toISOString(),
      });
      const ok = await blobSet("overrides", overrides);
      return json(ok ? 200 : 500, { ok });
    }

    if (action === "prepare-blast") {
      const subs = await fetchSubmissions(siteId, token);
      const overrides = (await blobGet("overrides")) || {};
      const interest = (req.interest || "").toLowerCase();
      const recipients = subs
        .map(toLead)
        .filter((l) => l.email)
        .filter((l) => {
          const ov = overrides[l.email.toLowerCase()];
          const status = (ov && ov.status) || "new";
          if (status === "unsubscribed") return false;
          if (interest && !l.interest.toLowerCase().includes(interest)) return false;
          return true;
        });
      // de-dupe by email
      const seen = new Set();
      const emails = [];
      for (const r of recipients) {
        const e = r.email.toLowerCase();
        if (!seen.has(e)) { seen.add(e); emails.push(r.email); }
      }
      const token2 = Math.random().toString(36).slice(2, 12);
      await blobSet("pending-blast", {
        token: token2,
        subject: req.subject || "",
        html: req.html || "",
        interest: req.interest || "",
        recipients: emails,
        prepared_at: new Date().toISOString(),
        sent: false,
      });
      return json(200, { token: token2, recipient_count: emails.length, recipients: emails });
    }

    if (action === "send-blast") {
      if (!process.env.RESEND_API_KEY) {
        return json(400, { error: "RESEND_API_KEY not configured — add it to send email." });
      }
      const staged = await blobGet("pending-blast");
      if (!staged) return json(400, { error: "no prepared blast" });
      if (staged.sent) return json(400, { error: "already sent" });
      if (req.token !== staged.token) return json(400, { error: "token mismatch" });

      const from = process.env.RESEND_FROM || "CRA Construction <hello@cra-construction.com>";
      const replyTo = "calberius@cra-construction.com";
      let sent = 0, failed = 0;
      const failures = [];
      for (const to of staged.recipients) {
        const r = await resendSend(to, staged.subject, staged.html, from, replyTo);
        if (r.ok) sent += 1; else { failed += 1; failures.push({ to, err: r.body.slice(0, 120) }); }
      }
      staged.sent = true;
      staged.sent_at = new Date().toISOString();
      staged.result = { sent, failed };
      await blobSet("pending-blast", staged);
      return json(200, { sent, failed, failures });
    }

    return json(400, { error: `unknown action: ${action}` });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
};
