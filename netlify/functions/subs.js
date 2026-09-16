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

// ── Bid tiers ───────────────────────────────────────────────────────────────
// Derived, not another field to keep up to date. The library already knows a
// sub's status, how they've been rated and whether their insurance is current,
// and those are exactly what decides whether you'd let them bid your job. The
// payoff for deriving it: a COI that lapses drops that sub out of the bidding
// pool by itself, with nobody remembering to go change a setting.
//
//   preferred  — proven on CRA jobs, rated well, papers current
//   approved   — vetted, papers current, fine to send plans to
//   unvetted   — never checked out, or something has lapsed
//   blocked    — do-not-use; never appears anywhere near a bid
//
// tier_override sets it by hand when the ladder is wrong about somebody. The
// one thing an override cannot do is un-block a do-not-use sub — that call is
// made in the library, deliberately, and a bid screen is the wrong place to
// quietly reverse it.
const TIERS = {
  preferred: { level: 1, label: "Preferred" },
  approved: { level: 2, label: "Approved to bid" },
  unvetted: { level: 3, label: "Unvetted" },
  blocked: { level: 9, label: "Blocked" },
};
const TIER_KEYS = Object.keys(TIERS);

function tierOf(rec, view) {
  function warning() {
    if (view.ins_expired) return "COI expired " + rec.ins_exp;
    if (view.ins_expiring) return "COI expires in " + view.ins_days + " day" + (view.ins_days === 1 ? "" : "s");
    if (!rec.insured && !rec.ins_exp) return "No insurance on file — get a COI before they start";
    if (!rec.workers_comp) return "No workers comp on file";
    return "";
  }
  function out(key, reason, overridden) {
    return {
      tier: key,
      tier_level: TIERS[key].level,
      tier_label: TIERS[key].label,
      tier_reason: reason,
      tier_warning: warning(),
      tier_overridden: !!overridden,
    };
  }

  if (rec.status === "do-not-use") return out("blocked", "Marked do-not-use in the library");

  const override = String(rec.tier_override || "");
  if (TIER_KEYS.indexOf(override) >= 0) {
    return out(override, "Set by hand" + (override === "blocked" ? "" : ", overriding the library"), true);
  }

  // A lapse outranks a good history: an expired COI is why you don't send
  // somebody plans, however well they framed the last house.
  //
  // A *missing* COI is deliberately not a demotion. Most of the library came
  // in off a QR sign where nobody filled in the insurance box, and treating
  // blank as uninsured would drop nearly everyone into unvetted — which just
  // teaches you to click past the gate until it means nothing. Marking a sub
  // approved is your vetting call; the ladder only overrides it on evidence,
  // and surfaces the blank as a warning instead.
  if (view.ins_expired) return out("unvetted", "Insurance expired — renew the COI to put them back in");
  if (view.license_expired) return out("unvetted", "License expired");
  if (rec.status === "new") return out("unvetted", "Never vetted");

  const rated = view.rating_count > 0 && view.overall != null;
  const jobs = view.rating_count + " job" + (view.rating_count === 1 ? "" : "s");

  // Marking a sub "used" is the record that they worked a CRA job and were not
  // blacklisted afterwards — which is the working definition of somebody you'd
  // call first, and it earns Preferred on its own. Requiring a star rating on
  // top of that was wrong: it left the crews Cole actually builds with sitting
  // at the same tier as a stranger who filled in a form, purely because nobody
  // had gone back and scored a finished job.
  //
  // A rating can still pull somebody up or push them down. Rate a sub you have
  // only approved and never used, and a good score promotes them. Rate a sub
  // you have used badly, and they drop — a bad score is evidence, and it is the
  // one thing that should outrank having hired them before.
  if (rated && view.overall < 3.5) {
    return out("approved", "Used, but rated " + view.overall + " across " + jobs);
  }
  if (rec.status === "used") {
    return out("preferred", rated ? "Used on CRA jobs, rated " + view.overall : "Used on a CRA job");
  }
  if (rec.status === "approved" && rated && view.overall >= 4) {
    return out("preferred", "Rated " + view.overall + " across " + jobs);
  }
  if (rec.status === "approved" || rec.status === "vetted") {
    return out("approved", rec.status === "approved" ? "Approved, not used yet" : "Vetted, papers current");
  }
  return out("unvetted", "Not vetted yet");
}
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
  const view = {
    avg,
    rating_count: ratings.length,
    overall: overallVals.length
      ? Math.round((overallVals.reduce((a, b) => a + b, 0) / overallVals.length) * 10) / 10
      : null,
    ins_days: insDays,
    ins_expired: insDays != null && insDays < 0,
    ins_expiring: insDays != null && insDays >= 0 && insDays <= 30,
    license_expired: licDays != null && licDays < 0,
  };
  return Object.assign({}, rec, view, tierOf(rec, view));
}

// Fields the portal is allowed to edit. Anything not listed here — id,
// phone_key, created_at, ratings — is off limits to a stray patch.
const EDITABLE = [
  "name", "company", "phone", "email", "trades", "lang", "city", "service_area",
  "crew_size", "years", "license_no", "license_exp", "insured", "ins_carrier",
  "ins_exp", "workers_comp", "pricing_mode", "rate_notes", "notes",
  "internal_notes", "kind", "tags", "sms_consent", "tier_override",
];

// Exported so the bid board gates on exactly the tier the library shows.
// One implementation, so the two screens can never disagree about who is
// allowed to receive a set of plans.
exports.decorateSub = decorate;
exports.TIERS = TIERS;

// The library screen now lives on the Alberius Ops Hub, but the data — and the
// tier logic the bid board shares — stays here. So this function answers a
// named short list of origins, and nothing else.
const ALLOWED_ORIGINS = [
  "https://alberiusops.com",
  "https://www.alberiusops.com",
  "https://alberius-operations-hub.netlify.app",
  "http://localhost:8888",
];

function corsHeaders(event) {
  const h = event.headers || {};
  const origin = h.origin || h.Origin || "";
  if (!ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type, x-leads-key",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const handleRequest = async function (event) {
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
        } else if (k === "tier_override") {
          const v = clean(patch[k], 20);
          all[idx][k] = TIER_KEYS.indexOf(v) >= 0 ? v : "";
        } else if (k === "insured" || k === "workers_comp" || k === "sms_consent") {
          all[idx][k] = !!patch[k];
          // Revoking from the portal (they called and said stop) clears the
          // consent record too, so we never claim an opt-in we no longer have.
          if (k === "sms_consent" && !patch[k]) {
            all[idx].consent_text = "";
            all[idx].consent_at = "";
          }
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

// CORS is bolted on out here so the logic above stays exactly as it was — the
// shared key is still the thing that authorises a call; an allowed origin only
// gets the browser to make it.
exports.handler = async function (event) {
  const cors = corsHeaders(event);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }

  const res = await handleRequest(event);
  return Object.assign({}, res, {
    headers: Object.assign({}, res.headers || {}, cors),
  });
};
