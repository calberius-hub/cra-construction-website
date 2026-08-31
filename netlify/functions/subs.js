// netlify/functions/subs.js
//
// Backing API for the /subs library (the internal side of "Bid My Job").
//
// Auth: every request carries header  x-leads-key: <key>. The key is
// SUBS_DASHBOARD_KEY if set, otherwise LEADS_DASHBOARD_KEY — so this works
// with zero new configuration, and Cole can split the two later if he wants
// the crew to see subs but not the homeowner leads.
//
// Actions (POST JSON { action, ... }):
//   "list"        → every sub/vendor record, newest first, with derived
//                   rating averages and insurance-expiry flags
//   "update"      → { id, patch } edit any portal-owned field
//   "set-status"  → { id, status } new | vetted | approved | used | do-not-use
//   "add-rating"  → { id, rating } push a field rating onto a sub
//   "add-sub"     → { rec } manually add someone you met in person
//   "delete"      → { id } remove a record entirely
//   "file"        → { fileId } return a stored photo as a data URI
//
// Env vars: NETLIFY_SITE_ID, NETLIFY_API_TOKEN, and one of
//           SUBS_DASHBOARD_KEY / LEADS_DASHBOARD_KEY

const { getStore } = require("@netlify/blobs");

const STATUSES = ["new", "vetted", "approved", "used", "do-not-use"];
const RATING_KEYS = ["on_time", "quality", "price", "cleanup", "again"];

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

async function readAll() {
  const arr = await store("subs").get("all", { type: "json" });
  return Array.isArray(arr) ? arr : [];
}

function clean(v, max) {
  return String(v == null ? "" : v).trim().slice(0, max || 300);
}

function phoneKey(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") return d.slice(1);
  return d;
}

// Days until an ISO-ish date (YYYY-MM-DD). Null when unparseable/absent.
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  if (isNaN(t)) return null;
  return Math.round((t - Date.now()) / 86400000);
}

// Derived fields the portal displays but never stores — computed fresh so an
// expiring COI turns red on its own without anyone re-saving the record.
function decorate(rec) {
  const ratings = Array.isArray(rec.ratings) ? rec.ratings : [];
  const avg = {};
  RATING_KEYS.forEach((k) => {
    const vals = ratings.map((r) => Number(r[k])).filter((n) => n >= 1 && n <= 5);
    avg[k] = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
  });
  const overallVals = RATING_KEYS.map((k) => avg[k]).filter((n) => n != null);
  const insDays = daysUntil(rec.ins_exp);
  const licDays = daysUntil(rec.license_exp);
  return Object.assign({}, rec, {
    avg,
    rating_count: ratings.length,
    overall: overallVals.length
      ? Math.round((overallVals.reduce((a, b) => a + b, 0) / overallVals.length) * 10) / 10
      : null,
    ins_days: insDays,
    ins_expired: insDays != null && insDays < 0,
    ins_expiring: insDays != null && insDays >= 0 && insDays <= 30,
    license_expired: licDays != null && licDays < 0,
  });
}

// Fields the portal is allowed to edit. Anything not listed here — id,
// phone_key, created_at, ratings — is off limits to a stray patch.
const EDITABLE = [
  "name", "company", "phone", "email", "trades", "lang", "city", "service_area",
  "crew_size", "years", "license_no", "license_exp", "insured", "ins_carrier",
  "ins_exp", "workers_comp", "pricing_mode", "rate_notes", "notes",
  "internal_notes", "kind", "tags",
];

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const key = process.env.SUBS_DASHBOARD_KEY || process.env.LEADS_DASHBOARD_KEY;
  if (!key) return json(500, { error: "SUBS_DASHBOARD_KEY / LEADS_DASHBOARD_KEY not configured" });
  if ((event.headers["x-leads-key"] || "") !== key) return json(401, { error: "unauthorized" });

  if (!process.env.NETLIFY_SITE_ID || !process.env.NETLIFY_API_TOKEN) {
    return json(500, { error: "NETLIFY_SITE_ID / NETLIFY_API_TOKEN not configured" });
  }

  let req;
  try { req = JSON.parse(event.body || "{}"); }
  catch (e) { return json(400, { error: "bad JSON" }); }

  try {
    // ── list ────────────────────────────────────────────────────────────────
    if (req.action === "list") {
      const all = await readAll();
      const subs = all.map(decorate);
      subs.sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
      return json(200, { subs, count: subs.length });
    }

    // ── file ────────────────────────────────────────────────────────────────
    if (req.action === "file") {
      const fid = clean(req.fileId, 80);
      if (!fid) return json(400, { error: "fileId required" });
      const f = await store("sub-files").get(fid, { type: "json" });
      if (!f) return json(404, { error: "not found" });
      return json(200, { dataUri: "data:" + (f.mime || "image/jpeg") + ";base64," + f.data, label: f.label || "" });
    }

    // ── add-sub (manual entry) ──────────────────────────────────────────────
    if (req.action === "add-sub") {
      const r = req.rec || {};
      const phone = clean(r.phone, 40);
      const pkey = phoneKey(phone);
      if (pkey.length < 10) return json(400, { error: "a 10-digit phone is required" });

      const all = await readAll();
      if (all.some((x) => x.phone_key === pkey)) {
        return json(409, { error: "That phone number is already in the library." });
      }
      const now = new Date().toISOString();
      const rec = {
        id: "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        kind: ["sub", "vendor", "worker"].indexOf(r.kind) >= 0 ? r.kind : "sub",
        phone, phone_key: pkey,
        trades: Array.isArray(r.trades) ? r.trades.map((t) => clean(t, 60)).filter(Boolean).slice(0, 12) : [],
        lang: r.lang === "es" ? "es" : "en",
        insured: !!r.insured,
        workers_comp: !!r.workers_comp,
        files: [],
        src: "manual",
        created_at: now, updated_at: now,
        status: STATUSES.indexOf(r.status) >= 0 ? r.status : "new",
        ratings: [],
      };
      ["name", "company", "email", "city", "service_area", "crew_size", "years",
       "license_no", "license_exp", "ins_carrier", "ins_exp", "pricing_mode",
       "rate_notes", "notes", "internal_notes"].forEach((k) => { rec[k] = clean(r[k], 1000); });
      rec.email = rec.email.toLowerCase();
      all.unshift(rec);
      await store("subs").setJSON("all", all);
      return json(200, { ok: true, id: rec.id });
    }

    // Everything below acts on one existing record.
    const id = clean(req.id, 80);
    if (!id) return json(400, { error: "id required" });
    const all = await readAll();
    const idx = all.findIndex((x) => x.id === id);
    if (idx < 0) return json(404, { error: "not found" });

    // ── set-status ──────────────────────────────────────────────────────────
    if (req.action === "set-status") {
      const status = clean(req.status, 20);
      if (STATUSES.indexOf(status) < 0) return json(400, { error: "bad status" });
      all[idx].status = status;
      all[idx].updated_at = new Date().toISOString();
      await store("subs").setJSON("all", all);
      return json(200, { ok: true });
    }

    // ── update ──────────────────────────────────────────────────────────────
    if (req.action === "update") {
      const patch = req.patch || {};
      Object.keys(patch).forEach((k) => {
        if (EDITABLE.indexOf(k) < 0) return;
        if (k === "trades" || k === "tags") {
          all[idx][k] = Array.isArray(patch[k])
            ? patch[k].map((t) => clean(t, 60)).filter(Boolean).slice(0, 16) : [];
        } else if (k === "insured" || k === "workers_comp") {
          all[idx][k] = !!patch[k];
        } else {
          all[idx][k] = clean(patch[k], 1000);
        }
      });
      if (patch.phone) all[idx].phone_key = phoneKey(patch.phone);
      all[idx].updated_at = new Date().toISOString();
      await store("subs").setJSON("all", all);
      return json(200, { ok: true, sub: decorate(all[idx]) });
    }

    // ── add-rating ──────────────────────────────────────────────────────────
    if (req.action === "add-rating") {
      const r = req.rating || {};
      const rating = {
        by: clean(r.by, 60) || "CRA",
        job: clean(r.job, 120),
        note: clean(r.note, 600),
        date: new Date().toISOString(),
      };
      let any = false;
      RATING_KEYS.forEach((k) => {
        const n = Number(r[k]);
        if (n >= 1 && n <= 5) { rating[k] = n; any = true; }
      });
      if (!any && !rating.note) return json(400, { error: "rate at least one thing, or leave a note" });
      if (!Array.isArray(all[idx].ratings)) all[idx].ratings = [];
      all[idx].ratings.unshift(rating);
      // First real rating means you've actually used them.
      if (any && all[idx].status === "new") all[idx].status = "used";
      all[idx].updated_at = new Date().toISOString();
      await store("subs").setJSON("all", all);
      return json(200, { ok: true, sub: decorate(all[idx]) });
    }

    // ── delete ──────────────────────────────────────────────────────────────
    if (req.action === "delete") {
      const removed = all.splice(idx, 1)[0];
      await store("subs").setJSON("all", all);
      // Best-effort cleanup of the photos so the file store doesn't grow orphans.
      for (const f of removed.files || []) {
        try { await store("sub-files").delete(f.id); } catch (e) { /* ignore */ }
      }
      return json(200, { ok: true, remaining: all.length });
    }

    return json(400, { error: "unknown action: " + clean(req.action, 40) });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
};
