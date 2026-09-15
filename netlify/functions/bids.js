// netlify/functions/bids.js
//
// The Bid Board — internal API behind /bids.
//
// The job this does: when a plan set is ready, Cole should not be hand-writing
// twenty emails. He makes a project, the plans get read for which trades the
// job actually needs, the sub library fills in who to send it to, and one
// approved click blasts the plan link to all of them. Every response comes
// back to one dashboard.
//
// Auth: header  x-leads-key: <key>, same key as /subs — BIDS_DASHBOARD_KEY if
// set, else SUBS_DASHBOARD_KEY, else LEADS_DASHBOARD_KEY. Nothing new to
// configure on day one.
//
// Blobs layout ("bids" store):
//   "index"        → [ {id,name,status,bid_due,...} ] lightweight list
//   "p:<id>"       → the whole project: trades, invites, plan links
//   "t:<token>"    → { project_id, invite_id } so a vendor link resolves
// and, in the separate "bid-responses" store:
//   "<token>"      → what that one vendor did (opened / bidding / passed /
//                    number submitted)
//
// Responses live in their own key per vendor on purpose. Twelve subs opening
// the same email at once each write only their own blob, so nobody's answer
// clobbers anybody else's — the project doc is written by the dashboard only.
//
// Actions (POST JSON { action, ... }):
//   list | get | create | update | delete            projects
//   catalog | analyze | set-trades                   scope / trade packages
//   match | add-invites | remove-invite              who gets it
//   prepare-send | send                              the blast (approval-gated)
//   set-invite | award                               record what came back
//
// Env vars: NETLIFY_SITE_ID, NETLIFY_API_TOKEN (required)
//           BIDS_DASHBOARD_KEY / SUBS_DASHBOARD_KEY / LEADS_DASHBOARD_KEY
//           RESEND_API_KEY, RESEND_FROM       — sending the invitations
//           TWILIO_ACCOUNT_SID / _AUTH_TOKEN / _FROM — optional SMS nudge
//           ANTHROPIC_API_KEY                 — optional deep plan read
//           SITE_URL                          — for the vendor response links

const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");

const PROJECT_STATUSES = ["draft", "out", "closed", "awarded"];
const INVITE_STATUSES = ["queued", "sent", "opened", "bidding", "declined", "submitted", "awarded"];
const PROJECT_TYPES = ["custom", "spec", "development", "commercial", "remodel"];

function json(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

function store(name) {
  return getStore({
    name,
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_API_TOKEN,
    consistency: "strong",
  });
}

function clean(v, max) {
  return String(v == null ? "" : v).trim().slice(0, max || 300);
}

function newId(prefix) {
  return prefix + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
}

function newToken() {
  return crypto.randomBytes(12).toString("hex");
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function siteUrl() {
  return (process.env.SITE_URL || "https://cra-construction.com").replace(/\/+$/, "");
}

function prettyDate(d) {
  if (!d) return "";
  const t = Date.parse(d.length === 10 ? d + "T12:00:00" : d);
  if (isNaN(t)) return d;
  return new Date(t).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

// ── Bid packages ─────────────────────────────────────────────────────────────
// "trades" are the labels the /bid intake form already uses, so matching a
// package to the sub library is a label comparison, not guesswork. "kw" are
// what the plan text has to say for the package to get suggested — sheet
// prefixes (E1., M2., S1.) count, because a plan index is often all you get.
const PACKAGES = [
  { key: "survey", label: "Survey & Staking", trades: ["Surveying", "Survey"],
    kw: ["survey", "plat", "staking", "boundary", "topographic", "benchmark"] },
  { key: "sitework", label: "Site Work & Excavation", trades: ["Excavation & Dirt Work", "Grading", "Demolition", "Trucking & Delivery", "Equipment Rental"],
    kw: ["grading", "excavat", "site plan", "erosion", "silt fence", "cut and fill", "building pad", "c1.", "c2.", "civil", "detention", "swale"] },
  { key: "septic", label: "Septic & Site Utilities", trades: ["Septic"],
    kw: ["septic", "leach", "lateral field", "water tap", "sewer tap", "utility plan", "water meter"] },
  { key: "concrete", label: "Concrete & Foundation", trades: ["Concrete / Flatwork", "Foundation", "Concrete Supply"],
    kw: ["slab", "footing", "foundation", "concrete", "flatwork", "driveway", "rebar", "stem wall", "turndown", "post tension", "psi"] },
  { key: "framing", label: "Framing & Lumber", trades: ["Framing", "Lumber"],
    kw: ["framing", "truss", "joist", "header", "stud", "rafter", "beam", "lvl", "sheathing", "s1.", "s2.", "structural plan", "shear wall"] },
  { key: "roofing", label: "Roofing", trades: ["Roofing", "Roofing Supply"],
    kw: ["roof", "shingle", "underlayment", "ridge vent", "valley", "standing seam", "fascia", "soffit"] },
  { key: "windows", label: "Windows & Exterior Doors", trades: ["Windows & Doors"],
    kw: ["window schedule", "window", "exterior door", "glazing", "sliding door", "door schedule", "transom"] },
  { key: "exterior", label: "Siding, Masonry & Stucco", trades: ["Siding", "Masonry & Stone", "Stucco"],
    kw: ["siding", "brick", "stone veneer", "stucco", "hardie", "lap siding", "board and batten", "masonry", "exterior elevation"] },
  { key: "plumbing", label: "Plumbing", trades: ["Plumbing", "Plumbing Fixtures"],
    kw: ["plumbing", "p1.", "p2.", "water heater", "tankless", "lavatory", "water closet", "supply line", "drain", "dwv", "fixture schedule"] },
  { key: "hvac", label: "HVAC", trades: ["HVAC", "HVAC Supply"],
    kw: ["hvac", "mechanical", "m1.", "m2.", "duct", "condenser", "air handler", "manual j", "mini split", "return air", "register"] },
  { key: "electrical", label: "Electrical", trades: ["Electrical", "Electrical Supply"],
    kw: ["electrical", "e1.", "e2.", "panel schedule", "circuit", "receptacle", "lighting plan", "amp service", "can light", "switch leg"] },
  { key: "lowvolt", label: "Low Voltage, Security & AV", trades: ["Low Voltage / Security"],
    kw: ["low voltage", "security", "camera", "cat6", "structured wiring", "speaker", "alarm", "data drop", "smart home"] },
  { key: "insulation", label: "Insulation", trades: ["Insulation"],
    kw: ["insulation", "batt", "spray foam", "blown", "r-value", "r-38", "r-19", "radiant barrier"] },
  { key: "drywall", label: "Drywall", trades: ["Drywall"],
    kw: ["drywall", "sheetrock", "gypsum", "texture", "level 4", "tape and float", "5/8 type x"] },
  { key: "trim", label: "Interior Trim & Doors", trades: ["Trim & Finish Carpentry"],
    kw: ["trim", "baseboard", "casing", "crown", "interior door", "shelving", "millwork", "wainscot", "mantel"] },
  { key: "cabinets", label: "Cabinets & Countertops", trades: ["Cabinets", "Countertops", "Countertops & Stone"],
    kw: ["cabinet", "vanity", "countertop", "quartz", "granite", "island", "cabinetry", "pantry shelving"] },
  { key: "paint", label: "Painting", trades: ["Paint", "Paint Supply"],
    kw: ["paint", "primer", "finish schedule", "sheen", "stain grade", "caulk and paint"] },
  { key: "flooring", label: "Flooring & Tile", trades: ["Flooring", "Tile"],
    kw: ["flooring", "lvp", "hardwood", "carpet", "tile", "shower pan", "grout", "backsplash", "finish floor"] },
  { key: "gutters", label: "Gutters", trades: ["Gutters"],
    kw: ["gutter", "downspout", "collection box"] },
  { key: "garage", label: "Garage Doors", trades: ["Garage Doors"],
    kw: ["garage door", "overhead door", "door opener"] },
  { key: "appliances", label: "Appliances", trades: ["Appliances", "Appliance Install"],
    kw: ["appliance", "range", "cooktop", "refrigerator", "dishwasher", "microwave", "vent hood"] },
  { key: "glass", label: "Glass, Mirror & Shower Doors", trades: ["Glass & Mirror"],
    kw: ["mirror", "shower glass", "glass enclosure", "frameless"] },
  { key: "metal", label: "Welding, Railing & Steel", trades: ["Welding & Metal"],
    kw: ["handrail", "railing", "structural steel", "welding", "canopy", "steel column", "w8x", "hss"] },
  { key: "waterproof", label: "Waterproofing & Drainage", trades: ["Waterproofing"],
    kw: ["waterproof", "damp proofing", "french drain", "vapor barrier", "foundation drain"] },
  { key: "decks", label: "Decks & Outdoor Living", trades: ["Decks"],
    kw: ["deck", "pergola", "screened porch", "outdoor kitchen", "patio cover", "fire pit"] },
  { key: "pool", label: "Pool & Spa", trades: ["Pools"],
    kw: ["pool", "gunite", "spa", "pool deck"] },
  { key: "landscape", label: "Landscaping & Irrigation", trades: ["Landscaping", "Irrigation"],
    kw: ["landscap", "sod", "irrigation", "planting plan", "l1.", "shrub", "mulch", "seeding"] },
  { key: "fencing", label: "Fencing", trades: ["Fencing"],
    kw: ["fence", "fencing", "gate operator", "privacy fence"] },
  { key: "cleanup", label: "Final Clean, Dumpsters & Toilets", trades: ["Cleanup / Trash Out", "Dumpsters & Waste", "Portable Toilets"],
    kw: ["final clean", "trash out", "dumpster", "portable toilet", "construction debris"] },
];

// What a job of this type needs whether or not the plans spell it out. A plan
// set rarely contains the word "framing" — that doesn't mean you skip framers.
const BASELINE = {
  custom: ["sitework", "concrete", "framing", "roofing", "windows", "exterior", "plumbing", "hvac",
           "electrical", "insulation", "drywall", "trim", "cabinets", "paint", "flooring",
           "gutters", "garage", "landscape", "cleanup"],
  spec: ["sitework", "concrete", "framing", "roofing", "windows", "exterior", "plumbing", "hvac",
         "electrical", "insulation", "drywall", "trim", "cabinets", "paint", "flooring",
         "gutters", "garage", "landscape", "cleanup"],
  development: ["survey", "sitework", "septic", "concrete", "waterproof", "fencing", "landscape", "cleanup"],
  commercial: ["survey", "sitework", "concrete", "metal", "framing", "roofing", "windows", "exterior",
               "plumbing", "hvac", "electrical", "insulation", "drywall", "paint", "flooring", "cleanup"],
  remodel: ["concrete", "framing", "plumbing", "hvac", "electrical", "insulation", "drywall", "trim",
            "cabinets", "paint", "flooring", "cleanup"],
};

function packageByKey(key) {
  return PACKAGES.filter(function (p) { return p.key === key; })[0] || null;
}

// ── The plan read (no API key needed) ────────────────────────────────────────
// Counts what the plan text actually mentions, then unions that with the
// baseline for the project type. Every suggestion carries its reason so Cole
// can tell "the plans say so" from "every house needs one".
function keywordRead(text, type) {
  const hay = String(text || "").toLowerCase();
  const base = BASELINE[type] || BASELINE.custom;
  const out = [];
  PACKAGES.forEach(function (p) {
    const hits = p.kw.filter(function (k) { return hay.indexOf(k) >= 0; });
    const inBase = base.indexOf(p.key) >= 0;
    if (!hits.length && !inBase) return;
    out.push({
      key: p.key,
      label: p.label,
      scope: "",
      why: hits.length
        ? "Plans mention " + hits.slice(0, 3).map(function (h) { return '"' + h.trim() + '"'; }).join(", ")
        : "Standard package for this job type",
      confidence: hits.length ? (hits.length >= 3 ? "high" : "medium") : "baseline",
      hits: hits.length,
    });
  });
  out.sort(function (a, b) { return b.hits - a.hits; });
  return out;
}

// ── The deep plan read (optional) ────────────────────────────────────────────
// Claude reads the sheet index and general notes and writes the per-trade
// scope lines — the "here's what you're actually bidding" sentence that makes
// a sub answer instead of calling to ask. Falls back to the keyword read on
// any failure, including the Netlify function clock running out, because a
// blast that goes out today beats a perfect scope that never sends.
const PLAN_SCHEMA = {
  type: "object",
  properties: {
    project_summary: { type: "string" },
    sheet_count: { type: "integer" },
    packages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string", enum: PACKAGES.map(function (p) { return p.key; }) },
          scope: { type: "string" },
          why: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["key", "scope", "why", "confidence"],
        additionalProperties: false,
      },
    },
    flags: { type: "array", items: { type: "string" } },
  },
  required: ["project_summary", "packages", "flags"],
  additionalProperties: false,
};

async function deepRead(text, project) {
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const controller = new AbortController();
  // Netlify cuts a synchronous function off at 10s. Bail at 8.5 and fall back.
  const timer = setTimeout(function () { controller.abort(); }, 8500);
  try {
    const res = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 8000,
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: PLAN_SCHEMA },
      },
      system:
        "You are an estimator for a residential and light-commercial general contractor in central Arkansas. " +
        "You read plan sets and decide which bid packages the job needs and what each sub is actually bidding.\n\n" +
        "Rules:\n" +
        "- Only use package keys from the provided list.\n" +
        "- Include a package when the plans show that work, or when the job plainly requires it even if the " +
        "sheets never name it (a house with a slab needs framers).\n" +
        "- scope: one or two plain sentences a subcontractor can price from. Name the sheets, quantities, " +
        "materials and finishes the plans actually specify. Never invent a number the plans do not show.\n" +
        "- why: a short reason, citing the sheet or note when there is one.\n" +
        "- confidence: high when the plans show the work directly, low when you are inferring it.\n" +
        "- flags: things that will cost the GC money if missed — missing sheets, an allowance with no spec, " +
        "an unusual detail, a long-lead item. Empty array if nothing stands out.",
      messages: [{
        role: "user",
        content:
          "Bid package keys you may use:\n" +
          PACKAGES.map(function (p) { return p.key + " = " + p.label; }).join("\n") +
          "\n\nProject: " + (project.name || "(unnamed)") +
          "\nType: " + (project.type || "custom") +
          "\nAddress: " + (project.address || "—") +
          "\nWhat CRA already knows about the scope: " + (project.scope_notes || "(nothing written down yet)") +
          "\n\nText extracted from the plan set follows.\n\n---\n" + text,
      }],
    }, { signal: controller.signal });

    let payload = "";
    (res.content || []).forEach(function (b) { if (b.type === "text") payload += b.text; });
    const parsed = JSON.parse(payload);
    const seen = {};
    const packages = (parsed.packages || []).map(function (row) {
      const pkg = packageByKey(row.key);
      if (!pkg || seen[row.key]) return null;
      seen[row.key] = true;
      return {
        key: pkg.key,
        label: pkg.label,
        scope: clean(row.scope, 900),
        why: clean(row.why, 300),
        confidence: row.confidence || "medium",
        hits: 1,
      };
    }).filter(Boolean);
    if (!packages.length) throw new Error("no packages returned");
    return {
      engine: "claude",
      summary: clean(parsed.project_summary, 900),
      flags: (parsed.flags || []).map(function (f) { return clean(f, 240); }).slice(0, 12),
      packages: packages,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Storage ──────────────────────────────────────────────────────────────────
async function readIndex() {
  const arr = await store("bids").get("index", { type: "json" });
  return Array.isArray(arr) ? arr : [];
}

async function readProject(id) {
  return await store("bids").get("p:" + id, { type: "json" });
}

// The index is a derived summary — the project doc is the record. Any write to
// a project refreshes its row so the board loads in one get.
async function writeProject(p) {
  p.updated_at = new Date().toISOString();
  await store("bids").setJSON("p:" + p.id, p);
  const index = await readIndex();
  const row = summarize(p);
  const i = index.findIndex(function (x) { return x.id === p.id; });
  if (i >= 0) index[i] = row; else index.unshift(row);
  index.sort(function (a, b) { return new Date(b.updated_at) - new Date(a.updated_at); });
  await store("bids").setJSON("index", index);
}

function summarize(p) {
  const invites = p.invites || [];
  return {
    id: p.id,
    name: p.name,
    address: p.address,
    type: p.type,
    status: p.status,
    bid_due: p.bid_due,
    walk_at: p.walk_at,
    trade_count: (p.trades || []).length,
    invite_count: invites.length,
    sent_count: invites.filter(function (v) { return v.sent_at; }).length,
    created_at: p.created_at,
    updated_at: p.updated_at || p.created_at,
  };
}

// Vendor-side state lives one blob per invite token, so the dashboard reads
// them back in parallel and merges. Ten at a time keeps us inside the clock.
async function loadResponses(tokens) {
  const s = store("bid-responses");
  const out = {};
  for (let i = 0; i < tokens.length; i += 10) {
    const batch = tokens.slice(i, i + 10);
    const got = await Promise.all(batch.map(function (t) {
      return s.get(t, { type: "json" }).catch(function () { return null; });
    }));
    batch.forEach(function (t, n) { if (got[n]) out[t] = got[n]; });
  }
  return out;
}

// ── Derived view ─────────────────────────────────────────────────────────────
function decorateInvite(inv, resp, project) {
  const r = resp || {};
  let status = r.status || (inv.sent_at ? "sent" : "queued");
  if (INVITE_STATUSES.indexOf(status) < 0) status = "sent";
  if (inv.awarded) status = "awarded";
  const dueMs = project.bid_due ? Date.parse(project.bid_due + "T23:59:59") : null;
  const answered = ["bidding", "declined", "submitted", "awarded"].indexOf(status) >= 0;
  return Object.assign({}, inv, {
    status: status,
    opened_at: r.opened_at || "",
    responded_at: r.responded_at || "",
    amount: r.amount == null ? "" : r.amount,
    bid_notes: r.notes || "",
    eta: r.eta || "",
    answered: answered,
    silent: !answered && !!inv.sent_at,
    overdue: !answered && !!inv.sent_at && dueMs != null && Date.now() > dueMs,
  });
}

// Coverage is the number Cole actually cares about: not "did I email people"
// but "is there a real bid on this trade, and is the clock running out".
function decorate(project, responses) {
  const invites = (project.invites || []).map(function (inv) {
    return decorateInvite(inv, responses[inv.token], project);
  });
  const trades = (project.trades || []).map(function (t) {
    const mine = invites.filter(function (v) { return v.trade === t.key; });
    const submitted = mine.filter(function (v) { return v.status === "submitted" || v.status === "awarded"; });
    const bidding = mine.filter(function (v) { return v.status === "bidding"; });
    const declined = mine.filter(function (v) { return v.status === "declined"; });
    let coverage = "none";
    if (submitted.length >= 2) coverage = "good";
    else if (submitted.length === 1) coverage = "thin";
    else if (bidding.length) coverage = "pending";
    else if (mine.some(function (v) { return v.sent_at; })) coverage = "waiting";
    return Object.assign({}, t, {
      invited: mine.length,
      sent: mine.filter(function (v) { return v.sent_at; }).length,
      opened: mine.filter(function (v) { return v.opened_at; }).length,
      bidding: bidding.length,
      declined: declined.length,
      submitted: submitted.length,
      awarded: mine.filter(function (v) { return v.status === "awarded"; }).length,
      low: submitted.reduce(function (acc, v) {
        const n = Number(v.amount);
        return n > 0 && (acc == null || n < acc) ? n : acc;
      }, null),
      coverage: coverage,
    });
  });
  return Object.assign({}, project, {
    invites: invites,
    trades: trades,
    totals: {
      trades: trades.length,
      invited: invites.length,
      sent: invites.filter(function (v) { return v.sent_at; }).length,
      opened: invites.filter(function (v) { return v.opened_at; }).length,
      bidding: invites.filter(function (v) { return v.status === "bidding"; }).length,
      declined: invites.filter(function (v) { return v.status === "declined"; }).length,
      submitted: invites.filter(function (v) { return v.status === "submitted" || v.status === "awarded"; }).length,
      silent: invites.filter(function (v) { return v.silent; }).length,
      uncovered: trades.filter(function (t) { return t.coverage === "none" || t.coverage === "waiting"; }).length,
    },
  });
}

// ── Matching the sub library ─────────────────────────────────────────────────
function normTrade(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// A sub typed "Concrete / Flatwork" on the QR form; the package wants
// "Concrete / Flatwork" or "Foundation". Compare normalized, both directions,
// so "Concrete" and "Concrete Supply" still find each other.
function vendorMatches(sub, pkg) {
  const want = pkg.trades.map(normTrade);
  const has = (sub.trades || []).map(normTrade);
  return has.some(function (h) {
    return want.some(function (w) {
      return h === w || (h.length > 3 && w.indexOf(h) >= 0) || (w.length > 3 && h.indexOf(w) >= 0);
    });
  });
}

async function readSubs() {
  const arr = await store("subs").get("all", { type: "json" });
  return Array.isArray(arr) ? arr : [];
}

function subRating(sub) {
  const ratings = Array.isArray(sub.ratings) ? sub.ratings : [];
  const keys = ["on_time", "quality", "price", "cleanup", "again"];
  const vals = [];
  ratings.forEach(function (r) {
    keys.forEach(function (k) { const n = Number(r[k]); if (n >= 1 && n <= 5) vals.push(n); });
  });
  if (!vals.length) return null;
  return Math.round((vals.reduce(function (a, b) { return a + b; }, 0) / vals.length) * 10) / 10;
}

// ── Email + SMS ──────────────────────────────────────────────────────────────
function inviteLink(token, action) {
  return siteUrl() + "/bid-invite?t=" + token + (action ? "&a=" + action : "");
}

function inviteEmail(project, trade, invite) {
  const link = inviteLink(invite.token);
  const due = project.bid_due ? prettyDate(project.bid_due) : "";
  const rows = [
    ["Project", project.name],
    ["Location", project.address],
    ["Scope", trade.label],
    ["Bids due", due || "As soon as you can"],
    ["Walk-through", project.walk_at ? prettyDate(project.walk_at) + (project.walk_time ? " at " + project.walk_time : "") : ""],
    ["Target start", project.start_date ? prettyDate(project.start_date) : ""],
  ].filter(function (r) { return r[1]; });

  const html =
    '<div style="font-family:Helvetica,Arial,sans-serif;background:#f8f5f0;padding:26px 0;">' +
    '<div style="max-width:560px;margin:0 auto;background:#fff;border-top:4px solid #c9a54a;">' +
    '<div style="background:#1d3a4a;color:#fff;padding:22px 26px;">' +
    '<div style="font-size:11px;letter-spacing:.22em;text-transform:uppercase;opacity:.75;">CRA Construction</div>' +
    '<div style="font-size:21px;margin-top:6px;">' + esc(trade.label) + " — " + esc(project.name) + "</div></div>" +
    '<div style="padding:24px 26px;color:#1a1814;font-size:15px;line-height:1.6;">' +
    "<p>We have plans ready and we want your number on the <strong>" + esc(trade.label) +
    "</strong> package.</p>" +
    '<table style="width:100%;border-collapse:collapse;margin:18px 0;font-size:14px;">' +
    rows.map(function (r) {
      return '<tr><td style="padding:7px 0;color:#6b6560;width:38%;">' + esc(r[0]) +
        '</td><td style="padding:7px 0;font-weight:600;">' + esc(r[1]) + "</td></tr>";
    }).join("") + "</table>" +
    (trade.scope ? '<p style="background:#f8f5f0;border-left:3px solid #c9a54a;padding:12px 14px;margin:0 0 18px;">' +
      "<strong>What you're bidding:</strong><br>" + esc(trade.scope) + "</p>" : "") +
    (project.scope_notes ? "<p>" + esc(project.scope_notes) + "</p>" : "") +
    (project.plan_url
      ? '<p style="margin:20px 0;"><a href="' + esc(project.plan_url) + '" style="display:inline-block;background:#1d3a4a;color:#fff;padding:13px 22px;text-decoration:none;font-size:13px;letter-spacing:.1em;text-transform:uppercase;">View the plans</a></p>'
      : "") +
    (project.plan_notes ? '<p style="font-size:13px;color:#6b6560;">' + esc(project.plan_notes) + "</p>" : "") +
    '<div style="border-top:1px solid #e6e1d8;margin-top:22px;padding-top:20px;">' +
    "<p style=\"margin:0 0 14px;\"><strong>Tell us where you stand</strong> — it takes one tap:</p>" +
    '<p style="margin:0 0 10px;"><a href="' + inviteLink(invite.token, "bidding") + '" style="display:inline-block;background:#c9a54a;color:#1a1814;padding:12px 20px;text-decoration:none;font-weight:600;font-size:14px;">I\'m bidding it</a>' +
    '&nbsp;&nbsp;<a href="' + inviteLink(invite.token, "submit") + '" style="display:inline-block;background:#1d3a4a;color:#fff;padding:12px 20px;text-decoration:none;font-weight:600;font-size:14px;">Send my number</a>' +
    '&nbsp;&nbsp;<a href="' + inviteLink(invite.token, "pass") + '" style="display:inline-block;border:1px solid #d4cec3;color:#6b6560;padding:11px 19px;text-decoration:none;font-size:14px;">Pass this one</a></p>' +
    '<p style="font-size:12.5px;color:#6b6560;margin-top:14px;">Or just reply to this email. Questions on scope, call us.</p>' +
    "</div>" +
    '<p style="margin-top:22px;">Thanks,<br>CRA Construction<br>' +
    '<span style="color:#6b6560;font-size:13px;">Little Rock, AR · Built to Last</span></p>' +
    "</div>" +
    '<img src="' + siteUrl() + "/.netlify/functions/bid-pixel?t=" + invite.token + '" width="1" height="1" alt="" style="display:block;">' +
    '<div style="padding:14px 26px;background:#f8f5f0;color:#8b857c;font-size:11px;">' +
    "You're getting this because you're in CRA's subcontractor library. Not bidding our work anymore? " +
    "Reply and tell us — we'll take you off bid invitations." +
    "</div></div></div>";

  const subject = "Bidding " + trade.label + " — " + project.name + (due ? " (due " + due + ")" : "");
  return { subject: subject, html: html };
}

function reminderEmail(project, trade, invite) {
  const base = inviteEmail(project, trade, invite);
  const due = project.bid_due ? prettyDate(project.bid_due) : "";
  return {
    subject: "Still need your " + trade.label + " number — " + project.name + (due ? " (due " + due + ")" : ""),
    html: base.html.replace(
      "We have plans ready and we want your number on the",
      "Following up — we still have a spot open for your number on the"
    ),
  };
}

function inviteSms(project, trade, invite) {
  const due = project.bid_due ? prettyDate(project.bid_due) : "";
  return "CRA Construction: bidding " + trade.label + " on " + project.name +
    (due ? ", due " + due : "") + ". Plans + one-tap reply: " + inviteLink(invite.token) +
    " Reply STOP to opt out.";
}

async function resendSend(to, subject, html, replyTo) {
  const from = process.env.RESEND_FROM || "CRA Construction <hello@cra-construction.com>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.RESEND_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: from, to: [to], reply_to: replyTo, subject: subject, html: html }),
  });
  return { ok: res.ok, body: await res.text() };
}

async function twilioSend(phone, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!sid || !auth || !from || !phone) return false;
  try {
    const res = await fetch("https://api.twilio.com/2010-04-01/Accounts/" + sid + "/Messages.json", {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(sid + ":" + auth).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: phone, From: from, Body: body }),
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

// ── Handler ──────────────────────────────────────────────────────────────────
exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const key = process.env.BIDS_DASHBOARD_KEY || process.env.SUBS_DASHBOARD_KEY || process.env.LEADS_DASHBOARD_KEY;
  if (!key) return json(500, { error: "BIDS_DASHBOARD_KEY / SUBS_DASHBOARD_KEY / LEADS_DASHBOARD_KEY not configured" });
  if ((event.headers["x-leads-key"] || "") !== key) return json(401, { error: "unauthorized" });

  if (!process.env.NETLIFY_SITE_ID || !process.env.NETLIFY_API_TOKEN) {
    return json(500, { error: "NETLIFY_SITE_ID / NETLIFY_API_TOKEN not configured" });
  }

  let req;
  try { req = JSON.parse(event.body || "{}"); }
  catch (e) { return json(400, { error: "bad JSON" }); }

  try {
    // ── catalog ─────────────────────────────────────────────────────────────
    if (req.action === "catalog") {
      return json(200, {
        packages: PACKAGES.map(function (p) { return { key: p.key, label: p.label, trades: p.trades }; }),
        types: PROJECT_TYPES,
        deep_read: !!process.env.ANTHROPIC_API_KEY,
        can_email: !!process.env.RESEND_API_KEY,
        can_sms: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM),
      });
    }

    // ── list ────────────────────────────────────────────────────────────────
    if (req.action === "list") {
      const index = await readIndex();
      return json(200, { projects: index, count: index.length });
    }

    // ── create ──────────────────────────────────────────────────────────────
    if (req.action === "create") {
      const p = req.project || {};
      const name = clean(p.name, 160);
      if (!name) return json(400, { error: "a project name is required" });
      const now = new Date().toISOString();
      const rec = {
        id: newId("b"),
        name: name,
        address: clean(p.address, 240),
        type: PROJECT_TYPES.indexOf(p.type) >= 0 ? p.type : "custom",
        status: "draft",
        scope_notes: clean(p.scope_notes, 2000),
        plan_url: clean(p.plan_url, 600),
        plan_notes: clean(p.plan_notes, 600),
        bid_due: clean(p.bid_due, 20),
        walk_at: clean(p.walk_at, 20),
        walk_time: clean(p.walk_time, 20),
        start_date: clean(p.start_date, 20),
        plan_summary: "",
        plan_flags: [],
        trades: [],
        invites: [],
        created_at: now,
        updated_at: now,
      };
      await writeProject(rec);
      return json(200, { ok: true, id: rec.id, project: rec });
    }

    // Everything past here is about one project.
    const id = clean(req.id, 80);
    if (!id) return json(400, { error: "id required" });
    const project = await readProject(id);
    if (!project) return json(404, { error: "project not found" });

    // ── get ─────────────────────────────────────────────────────────────────
    if (req.action === "get") {
      const responses = await loadResponses((project.invites || []).map(function (v) { return v.token; }));
      return json(200, { project: decorate(project, responses) });
    }

    // ── update ──────────────────────────────────────────────────────────────
    if (req.action === "update") {
      const patch = req.patch || {};
      ["name", "address", "scope_notes", "plan_url", "plan_notes", "bid_due", "walk_at",
       "walk_time", "start_date"].forEach(function (k) {
        if (patch[k] != null) project[k] = clean(patch[k], k === "scope_notes" ? 2000 : 600);
      });
      if (patch.type != null && PROJECT_TYPES.indexOf(patch.type) >= 0) project.type = patch.type;
      if (patch.status != null && PROJECT_STATUSES.indexOf(patch.status) >= 0) project.status = patch.status;
      await writeProject(project);
      return json(200, { ok: true });
    }

    // ── delete ──────────────────────────────────────────────────────────────
    if (req.action === "delete") {
      const s = store("bids");
      for (const inv of project.invites || []) {
        try { await s.delete("t:" + inv.token); } catch (e) { /* ignore */ }
        try { await store("bid-responses").delete(inv.token); } catch (e) { /* ignore */ }
      }
      try { await s.delete("stage:" + project.id); } catch (e) { /* ignore */ }
      await s.delete("p:" + project.id);
      const index = (await readIndex()).filter(function (x) { return x.id !== project.id; });
      await s.setJSON("index", index);
      return json(200, { ok: true, remaining: index.length });
    }

    // ── analyze ─────────────────────────────────────────────────────────────
    // Client-side pdf.js pulls the text out of the plan PDF and posts it here,
    // which sidesteps the 6 MB function payload limit that a real plan set
    // blows past on sheet three.
    if (req.action === "analyze") {
      const text = String(req.text || "").slice(0, 120000);
      const wantDeep = !!req.deep && !!process.env.ANTHROPIC_API_KEY;
      let result = null;
      let fallbackReason = "";
      if (wantDeep && text.trim().length > 40) {
        try {
          result = await deepRead(text, project);
        } catch (err) {
          fallbackReason = String((err && err.message) || err).slice(0, 200);
        }
      }
      if (!result) {
        result = {
          engine: "keywords",
          summary: "",
          flags: [],
          packages: keywordRead(text, project.type),
        };
      }
      // Never drop a package that is already on the board — Cole put it there.
      const have = {};
      result.packages.forEach(function (p) { have[p.key] = true; });
      (project.trades || []).forEach(function (t) {
        if (!have[t.key]) {
          result.packages.push({ key: t.key, label: t.label, scope: t.scope || "",
            why: "Already on this project", confidence: "high", hits: 1 });
        }
      });
      if (req.save) {
        project.plan_summary = result.summary || project.plan_summary;
        project.plan_flags = result.flags && result.flags.length ? result.flags : project.plan_flags;
        project.plan_text_chars = text.length;
        project.analyzed_at = new Date().toISOString();
        project.analyzed_with = result.engine;
        await writeProject(project);
      }
      return json(200, {
        engine: result.engine,
        summary: result.summary,
        flags: result.flags,
        packages: result.packages,
        fallback_reason: fallbackReason,
        chars_read: text.length,
      });
    }

    // ── set-trades ──────────────────────────────────────────────────────────
    // Trades already carrying invites are never silently dropped; the invites
    // would be orphaned and the sub would still have a live link.
    if (req.action === "set-trades") {
      const wanted = Array.isArray(req.trades) ? req.trades : [];
      const next = [];
      const seen = {};
      wanted.forEach(function (t) {
        const pkg = packageByKey(clean(t.key, 40));
        if (!pkg || seen[pkg.key]) return;
        seen[pkg.key] = true;
        next.push({ key: pkg.key, label: pkg.label, scope: clean(t.scope, 900), why: clean(t.why, 300) });
      });
      const kept = [];
      (project.trades || []).forEach(function (t) {
        if (seen[t.key]) return;
        const stillUsed = (project.invites || []).some(function (v) { return v.trade === t.key; });
        if (stillUsed) { kept.push(t.key); next.push(t); }
      });
      project.trades = next;
      await writeProject(project);
      return json(200, { ok: true, trades: project.trades, kept_because_invited: kept });
    }

    // ── match ───────────────────────────────────────────────────────────────
    if (req.action === "match") {
      const subs = await readSubs();
      const invitedBy = {};
      (project.invites || []).forEach(function (v) { invitedBy[v.trade + "|" + v.vendor_id] = true; });
      const out = (project.trades || []).map(function (t) {
        const pkg = packageByKey(t.key);
        const candidates = subs.filter(function (s) {
          return s.status !== "do-not-use" && s.kind !== "worker" && pkg && vendorMatches(s, pkg);
        }).map(function (s) {
          return {
            vendor_id: s.id,
            name: s.name || s.company || s.phone,
            company: s.company || "",
            email: (s.email || "").toLowerCase(),
            phone: s.phone || "",
            trades: s.trades || [],
            status: s.status || "new",
            sms_consent: !!s.sms_consent,
            rating: subRating(s),
            ins_exp: s.ins_exp || "",
            already_invited: !!invitedBy[t.key + "|" + s.id],
            reachable: !!(s.email || s.phone),
          };
        });
        // Best first: people you've used and rated, then vetted, then the rest.
        const rank = { approved: 0, used: 1, vetted: 2, new: 3 };
        candidates.sort(function (a, b) {
          const ra = rank[a.status] == null ? 4 : rank[a.status];
          const rb = rank[b.status] == null ? 4 : rank[b.status];
          if (ra !== rb) return ra - rb;
          return (b.rating || 0) - (a.rating || 0);
        });
        return { key: t.key, label: t.label, candidates: candidates };
      });
      return json(200, { matches: out, library_size: subs.length });
    }

    // ── add-invites ─────────────────────────────────────────────────────────
    if (req.action === "add-invites") {
      const rows = Array.isArray(req.invites) ? req.invites.slice(0, 300) : [];
      const subs = await readSubs();
      const byId = {};
      subs.forEach(function (s) { byId[s.id] = s; });
      const existing = {};
      (project.invites || []).forEach(function (v) { existing[v.trade + "|" + v.vendor_id] = true; });
      const tokenStore = store("bids");
      let added = 0;
      const skipped = [];
      for (const row of rows) {
        const trade = clean(row.trade, 40);
        const vid = clean(row.vendor_id, 80);
        if (!packageByKey(trade)) { skipped.push({ vendor_id: vid, why: "unknown trade" }); continue; }
        if (!(project.trades || []).some(function (t) { return t.key === trade; })) {
          skipped.push({ vendor_id: vid, why: "trade not on this project" }); continue;
        }
        if (existing[trade + "|" + vid]) continue;
        const sub = byId[vid];
        if (!sub) { skipped.push({ vendor_id: vid, why: "not in the library" }); continue; }
        if (!sub.email && !sub.phone) { skipped.push({ vendor_id: vid, why: "no email or phone on file" }); continue; }
        const token = newToken();
        const inv = {
          id: newId("i"),
          vendor_id: vid,
          token: token,
          trade: trade,
          name: sub.name || sub.company || sub.phone,
          company: sub.company || "",
          email: (sub.email || "").toLowerCase(),
          phone: sub.phone || "",
          sms_consent: !!sub.sms_consent,
          added_at: new Date().toISOString(),
          sent_at: "",
          reminders: [],
        };
        project.invites.push(inv);
        existing[trade + "|" + vid] = true;
        await tokenStore.setJSON("t:" + token, { project_id: project.id, invite_id: inv.id });
        added += 1;
      }
      await writeProject(project);
      return json(200, { ok: true, added: added, skipped: skipped, invite_count: project.invites.length });
    }

    // ── remove-invite ───────────────────────────────────────────────────────
    if (req.action === "remove-invite") {
      const inviteId = clean(req.inviteId, 80);
      const idx = (project.invites || []).findIndex(function (v) { return v.id === inviteId; });
      if (idx < 0) return json(404, { error: "invite not found" });
      const gone = project.invites.splice(idx, 1)[0];
      try { await store("bids").delete("t:" + gone.token); } catch (e) { /* ignore */ }
      try { await store("bid-responses").delete(gone.token); } catch (e) { /* ignore */ }
      await writeProject(project);
      return json(200, { ok: true });
    }

    // ── prepare-send ────────────────────────────────────────────────────────
    // Nothing leaves the building without a second click. Prepare stages the
    // exact recipient list and returns a preview; send quotes the token back.
    if (req.action === "prepare-send") {
      const mode = ["new", "remind", "selected"].indexOf(req.mode) >= 0 ? req.mode : "new";
      const picked = Array.isArray(req.inviteIds) ? req.inviteIds.map(function (x) { return clean(x, 80); }) : [];
      const responses = await loadResponses((project.invites || []).map(function (v) { return v.token; }));
      const tradeByKey = {};
      (project.trades || []).forEach(function (t) { tradeByKey[t.key] = t; });

      const chosen = (project.invites || []).filter(function (inv) {
        const view = decorateInvite(inv, responses[inv.token], project);
        if (mode === "selected") return picked.indexOf(inv.id) >= 0;
        if (mode === "remind") return !!inv.sent_at && !view.answered;
        return !inv.sent_at;
      }).filter(function (inv) { return inv.email || inv.phone; });

      if (!chosen.length) return json(400, { error: "nobody to send to in that group" });
      const token = newToken();
      const preview = chosen.map(function (inv) {
        const trade = tradeByKey[inv.trade] || { key: inv.trade, label: inv.trade, scope: "" };
        const mail = mode === "remind" ? reminderEmail(project, trade, inv) : inviteEmail(project, trade, inv);
        return {
          invite_id: inv.id,
          name: inv.name,
          company: inv.company,
          email: inv.email,
          phone: inv.phone,
          sms_consent: !!inv.sms_consent,
          trade: trade.label,
          subject: mail.subject,
        };
      });

      await store("bids").setJSON("stage:" + project.id, {
        token: token,
        mode: mode,
        invite_ids: chosen.map(function (v) { return v.id; }),
        also_sms: !!req.alsoSms,
        prepared_at: new Date().toISOString(),
        sent: false,
      });

      return json(200, {
        token: token,
        mode: mode,
        count: chosen.length,
        no_email: chosen.filter(function (v) { return !v.email; }).length,
        sample_html: (function () {
          const inv = chosen[0];
          const trade = tradeByKey[inv.trade] || { key: inv.trade, label: inv.trade, scope: "" };
          return (mode === "remind" ? reminderEmail : inviteEmail)(project, trade, inv).html;
        })(),
        recipients: preview,
      });
    }

    // ── send ────────────────────────────────────────────────────────────────
    if (req.action === "send") {
      if (!process.env.RESEND_API_KEY) {
        return json(400, { error: "RESEND_API_KEY not configured — add it before sending bid invitations." });
      }
      const staged = await store("bids").get("stage:" + project.id, { type: "json" });
      if (!staged) return json(400, { error: "nothing prepared — review the blast first" });
      if (staged.sent) return json(400, { error: "that blast already went out" });
      if (req.token !== staged.token) return json(400, { error: "token mismatch — prepare it again" });

      const tradeByKey = {};
      (project.trades || []).forEach(function (t) { tradeByKey[t.key] = t; });
      const byId = {};
      (project.invites || []).forEach(function (v) { byId[v.id] = v; });
      const replyTo = clean(req.replyTo, 160) || "calberius@cra-construction.com";

      let sent = 0, failed = 0, texted = 0;
      const failures = [];
      const now = new Date().toISOString();

      for (const inviteId of staged.invite_ids) {
        const inv = byId[inviteId];
        if (!inv) continue;
        const trade = tradeByKey[inv.trade] || { key: inv.trade, label: inv.trade, scope: "" };
        const mail = staged.mode === "remind" ? reminderEmail(project, trade, inv) : inviteEmail(project, trade, inv);
        let ok = false;
        if (inv.email) {
          const r = await resendSend(inv.email, mail.subject, mail.html, replyTo);
          ok = r.ok;
          if (!r.ok) failures.push({ name: inv.name, to: inv.email, err: r.body.slice(0, 140) });
        }
        // SMS only where the sub checked the box on the QR form. That consent
        // record is what keeps the whole number alive with the carriers.
        if (staged.also_sms && inv.sms_consent && inv.phone) {
          const texted_ok = await twilioSend(inv.phone, inviteSms(project, trade, inv));
          if (texted_ok) { texted += 1; ok = ok || true; }
        }
        if (ok) {
          sent += 1;
          if (staged.mode === "remind") {
            inv.reminders = (inv.reminders || []).concat([now]);
          } else {
            inv.sent_at = inv.sent_at || now;
          }
        } else if (inv.email) {
          failed += 1;
        }
      }

      if (project.status === "draft" && sent) project.status = "out";
      await writeProject(project);
      staged.sent = true;
      staged.sent_at = now;
      staged.result = { sent: sent, failed: failed, texted: texted };
      await store("bids").setJSON("stage:" + project.id, staged);
      return json(200, { sent: sent, failed: failed, texted: texted, failures: failures });
    }

    // ── set-invite ──────────────────────────────────────────────────────────
    // For the number that came in by phone, or the sub who told you in person
    // he's out. Writes the same blob the vendor's own link writes.
    if (req.action === "set-invite") {
      const inviteId = clean(req.inviteId, 80);
      const inv = (project.invites || []).filter(function (v) { return v.id === inviteId; })[0];
      if (!inv) return json(404, { error: "invite not found" });
      const patch = req.patch || {};
      const s = store("bid-responses");
      const cur = (await s.get(inv.token, { type: "json" })) || {};
      if (patch.status != null) {
        if (INVITE_STATUSES.indexOf(patch.status) < 0) return json(400, { error: "bad status" });
        cur.status = patch.status;
        cur.responded_at = cur.responded_at || new Date().toISOString();
      }
      if (patch.amount != null) {
        const n = Number(String(patch.amount).replace(/[^0-9.]/g, ""));
        cur.amount = isNaN(n) || n <= 0 ? "" : Math.round(n * 100) / 100;
        if (cur.amount && (!cur.status || cur.status === "sent" || cur.status === "opened" || cur.status === "bidding")) {
          cur.status = "submitted";
          cur.responded_at = cur.responded_at || new Date().toISOString();
        }
      }
      if (patch.notes != null) cur.notes = clean(patch.notes, 1200);
      if (patch.eta != null) cur.eta = clean(patch.eta, 60);
      cur.by = "CRA";
      cur.updated_at = new Date().toISOString();
      await s.setJSON(inv.token, cur);
      return json(200, { ok: true, invite: decorateInvite(inv, cur, project) });
    }

    // ── award ───────────────────────────────────────────────────────────────
    // One winner per trade: awarding clears the flag off anyone else in it.
    if (req.action === "award") {
      const inviteId = clean(req.inviteId, 80);
      const inv = (project.invites || []).filter(function (v) { return v.id === inviteId; })[0];
      if (!inv) return json(404, { error: "invite not found" });
      (project.invites || []).forEach(function (v) {
        if (v.trade === inv.trade) v.awarded = false;
      });
      inv.awarded = req.awarded === false ? false : true;
      await writeProject(project);
      return json(200, { ok: true });
    }

    return json(400, { error: "unknown action: " + clean(req.action, 40) });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
};
