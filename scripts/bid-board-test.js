// scripts/bid-board-test.js
//
// Walks the whole bid board with Netlify Blobs, Resend and the Claude SDK
// mocked, so the flow can be checked without a deploy, a key, or sending a
// real subcontractor a real email.
//
//   node scripts/bid-board-test.js
//
// Phase 1 is the flow Cole actually runs: new project → read the plans →
// pick packages → match the library → blast → a sub answers → the board.
// Phase 2 is the optional Claude plan read and, more importantly, the two
// ways it is allowed to fail.

const assert = require("assert");
const ROOT = require("path").join(__dirname, "..");
// ── in-memory blob store ─────────────────────────────────────────────────────
const DB = {};
function getStore(opts) {
  const name = opts.name;
  DB[name] = DB[name] || {};
  return {
    async get(key) { const v = DB[name][key]; return v === undefined ? null : JSON.parse(v); },
    async setJSON(key, val) { DB[name][key] = JSON.stringify(val); },
    async delete(key) { delete DB[name][key]; },
  };
}
const blobsPath = require.resolve("@netlify/blobs", { paths: [ROOT] });
require.cache[blobsPath] = { id: blobsPath, filename: blobsPath, loaded: true, exports: { getStore } };


// ── mocked Claude SDK (phase 2 drives it; phase 1 never reaches it) ──────────
let seenCall = null;
let sdkMode = "ok";
class FakeAnthropic {
  constructor(opts) {
    this.opts = opts;
    this.messages = { create: async (body, options) => {
      seenCall = { body, options };
      if (sdkMode === "throw") throw new Error("upstream said no");
      if (sdkMode === "abort") { const e = new Error("Request was aborted."); e.name = "AbortError"; throw e; }
      return { content: [{ type: "text", text: JSON.stringify({
        project_summary: "2,850 sf single story on a slab.",
        packages: [
          { key: "electrical", scope: "200A service per E1.1.", basis: "sf", quantity: 2850,
            why: "Sheet E1.1", confidence: "high" },
          { key: "roofing", scope: "30 sq architectural shingle.", basis: "squares", quantity: 0,
            why: "Roof plan", confidence: "medium" },
          { key: "not_a_real_key", scope: "x", basis: "sf", quantity: 1, why: "y", confidence: "low" },
          { key: "electrical", scope: "dupe", basis: "sf", quantity: 1, why: "dupe", confidence: "low" },
        ],
        flags: ["Spec book missing the window schedule"],
      }) }] };
    } };
  }
}
require.cache[require.resolve("@anthropic-ai/sdk", { paths: [ROOT] })] =
  { id: "anthropic-mock", filename: "anthropic-mock", loaded: true, exports: FakeAnthropic };

// ── env + network ────────────────────────────────────────────────────────────
process.env.NETLIFY_SITE_ID = "site";
process.env.NETLIFY_API_TOKEN = "tok";
process.env.BIDS_DASHBOARD_KEY = "secret";
process.env.RESEND_API_KEY = "re_test";
process.env.SITE_URL = "https://cra-construction.com";

const mail = [];
global.fetch = async function (url, init) {
  if (String(url).indexOf("resend") >= 0) {
    mail.push(JSON.parse(init.body));
    return { ok: true, text: async () => "{}" };
  }
  return { ok: true, text: async () => "{}" };
};

const bids = require(ROOT + "/netlify/functions/bids.js");
const respond = require(ROOT + "/netlify/functions/bid-respond.js");
const pixel = require(ROOT + "/netlify/functions/bid-pixel.js");

const call = (fn, body, key) => fn.handler({
  httpMethod: "POST",
  headers: { "x-leads-key": key === undefined ? "secret" : key },
  body: JSON.stringify(body),
});
const parse = (r) => ({ status: r.statusCode, body: JSON.parse(r.body) });

// Two subs in the library: one framer we've used, one electrician, one banned.
DB.subs = { all: JSON.stringify([
  { id: "s1", name: "Diego Ruiz", company: "Ruiz Framing", email: "diego@ruizframing.com",
    phone: "5015550111", trades: ["Framing", "Trim & Finish Carpentry"], status: "used",
    sms_consent: true, ratings: [{ on_time: 5, quality: 4 }] },
  { id: "s2", name: "Sparks Electric", email: "bids@sparkselec.com", phone: "5015550122",
    trades: ["Electrical"], status: "approved", ratings: [] },
  { id: "s3", name: "Never Again LLC", email: "no@example.com", trades: ["Framing"], status: "do-not-use" },
  { id: "s4", name: "No Contact Guy", trades: ["Electrical"], status: "new" },
]) };

async function phaseOne() {
  // auth
  assert.strictEqual(parse(await call(bids, { action: "list" }, "wrong")).status, 401, "bad key rejected");

  // create
  let r = parse(await call(bids, { action: "create", project: {
    name: "307 Fletcher Lp", address: "307 Fletcher Loop", type: "custom",
    bid_due: "2026-10-01", walk_at: "2026-09-24", scope_notes: "2,850 sf slab on grade.",
  } }));
  assert.strictEqual(r.status, 200, "create ok");
  const id = r.body.id;

  // plan read (keyword engine — no ANTHROPIC_API_KEY set)
  r = parse(await call(bids, { action: "analyze", id, save: true,
    text: "A1.1 FLOOR PLAN  E1.1 ELECTRICAL PLAN PANEL SCHEDULE  S1.1 FOUNDATION PLAN FOOTING" }));
  assert.strictEqual(r.body.engine, "keywords");
  const keys = r.body.packages.map(p => p.key);
  assert.ok(keys.indexOf("electrical") >= 0, "electrical suggested from the sheet index");
  assert.ok(keys.indexOf("framing") >= 0, "framing suggested from the baseline");
  const elec = r.body.packages.filter(p => p.key === "electrical")[0];
  assert.ok(/mention/.test(elec.why), "suggestion carries its reason: " + elec.why);

  // packages, each with the basis its bids get compared on
  r = parse(await call(bids, { action: "set-trades", id, trades: [
    { key: "framing", scope: "Frame per S1.1, labor only, CRA supplies material.",
      basis: "sf", qty: "2,850 sf" },
    { key: "electrical", scope: "200 amp service per E1.1, fixtures by owner.",
      basis: "per hot dog", qty: "99" },
  ] }));
  assert.strictEqual(r.body.trades.length, 2, "two packages saved");
  const framingPkg = r.body.trades.filter(t => t.key === "framing")[0];
  assert.strictEqual(framingPkg.qty, 2850, "a typed-in quantity is read as a number");
  assert.strictEqual(framingPkg.basis_line, "Per square foot · 2,850 sf on the plans");
  const elecPkg = r.body.trades.filter(t => t.key === "electrical")[0];
  assert.strictEqual(elecPkg.basis, "lump", "a basis we don't know falls back to the package default");
  assert.strictEqual(elecPkg.qty, "", "a lump-sum package carries no quantity");

  // match the library
  r = parse(await call(bids, { action: "match", id }));
  const byKey = {}; r.body.matches.forEach(m => byKey[m.key] = m);
  assert.deepStrictEqual(byKey.framing.candidates.map(c => c.vendor_id), ["s1"], "do-not-use excluded");
  assert.deepStrictEqual(byKey.electrical.candidates.map(c => c.vendor_id), ["s2", "s4"], "approved first");
  assert.strictEqual(byKey.electrical.candidates[1].reachable, false, "unreachable sub flagged");

  // invite
  r = parse(await call(bids, { action: "add-invites", id, invites: [
    { trade: "framing", vendor_id: "s1" },
    { trade: "electrical", vendor_id: "s2" },
    { trade: "electrical", vendor_id: "s4" },   // no email, no phone → skipped
    { trade: "roofing", vendor_id: "s1" },      // package not on the project → skipped
  ] }));
  assert.strictEqual(r.body.added, 2, "two invitable, two skipped");
  assert.deepStrictEqual(r.body.skipped.map(s => s.why).sort(),
    ["no email or phone on file", "trade not on this project"]);

  // a blast needs two clicks
  r = parse(await call(bids, { action: "send", id, token: "made-up" }));
  assert.strictEqual(r.status, 400, "send without prepare refused");

  r = parse(await call(bids, { action: "prepare-send", id, mode: "new" }));
  assert.strictEqual(r.body.count, 2);
  const stageToken = r.body.token;
  assert.ok(/Frame per S1.1/.test(r.body.sample_html), "scope line rides in the email");
  assert.ok(/Per square foot · 2,850 sf on the plans/.test(r.body.sample_html),
    "so does how to price it, so every number comes back on the same basis");

  assert.strictEqual(parse(await call(bids, { action: "send", id, token: "nope" })).status, 400, "token must match");

  r = parse(await call(bids, { action: "send", id, token: stageToken }));
  assert.strictEqual(r.body.sent, 2, "both sent");
  assert.strictEqual(mail.length, 2, "two emails handed to Resend");
  assert.strictEqual(parse(await call(bids, { action: "send", id, token: stageToken })).status, 400, "no double send");

  // the sub's side
  const project = JSON.parse(DB.bids["p:" + id]);
  assert.strictEqual(project.status, "out", "sending flipped the project live");
  const framerToken = project.invites.filter(v => v.trade === "framing")[0].token;
  const elecInvite = project.invites.filter(v => v.trade === "electrical")[0];
  assert.ok(mail[0].html.indexOf(framerToken) > 0, "email carries the vendor's own token");

  r = parse(await respond.handler({ httpMethod: "POST", body: JSON.stringify({ token: framerToken, action: "get" }) }));
  assert.strictEqual(r.body.trade.label, "Framing & Lumber");
  assert.strictEqual(r.body.response.status, "opened", "opening the page counts as an open");

  r = parse(await respond.handler({ httpMethod: "POST", body: JSON.stringify({
    token: framerToken, action: "respond", response: "submit", amount: "$42,500.00", notes: "Labor only." }) }));
  assert.strictEqual(r.body.status, "submitted");
  assert.strictEqual(r.body.amount, 42500, "money parsed out of what they typed");

  r = parse(await respond.handler({ httpMethod: "POST", body: JSON.stringify({
    token: framerToken, action: "respond", response: "submit", amount: "call me" }) }));
  assert.strictEqual(r.status, 400, "a bid with no number is refused");

  // a stranger's token gets nothing
  r = parse(await respond.handler({ httpMethod: "POST", body: JSON.stringify({ token: "deadbeef", action: "get" }) }));
  assert.strictEqual(r.status, 404, "unknown token rejected");
  const before = Object.keys(DB["bid-responses"]).length;
  await pixel.handler({ httpMethod: "GET", queryStringParameters: { t: "abc123" } });
  assert.strictEqual(Object.keys(DB["bid-responses"]).length, before, "pixel ignores made-up tokens");

  // the electrician opens the email but never answers
  const px = await pixel.handler({ httpMethod: "GET", queryStringParameters: { t: elecInvite.token } });
  assert.strictEqual(px.headers["Content-Type"], "image/gif");

  // CRA records a phone bid against the electrician
  r = parse(await call(bids, { action: "set-invite", id, inviteId: elecInvite.id,
    patch: { amount: "18750", notes: "Called it in." } }));
  assert.strictEqual(r.body.invite.status, "submitted", "a number implies a bid");

  // the board
  r = parse(await call(bids, { action: "get", id }));
  const t = r.body.project.totals;
  assert.strictEqual(t.submitted, 2, "two numbers in");
  assert.strictEqual(t.opened, 2, "both opened");
  assert.strictEqual(t.silent, 0);
  const framingRow = r.body.project.trades.filter(x => x.key === "framing")[0];
  assert.strictEqual(framingRow.coverage, "thin", "one bid is thin coverage");
  assert.strictEqual(framingRow.low, 42500);
  assert.strictEqual(framingRow.unit_low, 14.91, "$42,500 over 2,850 sf is $14.91/sf");
  assert.strictEqual(r.body.project.invites.filter(v => v.trade === "framing")[0].unit_rate, 14.91,
    "and each bid carries its own rate");
  const elecRow = r.body.project.trades.filter(x => x.key === "electrical")[0];
  assert.strictEqual(elecRow.low, 18750);
  assert.strictEqual(elecRow.unit_low, null, "a lump-sum package never invents a unit price");

  // award
  const framerInvite = r.body.project.invites.filter(v => v.trade === "framing")[0];
  await call(bids, { action: "award", id, inviteId: framerInvite.id });
  r = parse(await call(bids, { action: "get", id }));
  assert.strictEqual(r.body.project.invites.filter(v => v.id === framerInvite.id)[0].status, "awarded");

  // a package with live invites can't be silently dropped
  r = parse(await call(bids, { action: "set-trades", id, trades: [{ key: "framing", scope: "same" }] }));
  assert.deepStrictEqual(r.body.kept_because_invited, ["electrical"], "invited package kept");

  // reminders only chase the ones who never answered
  r = parse(await call(bids, { action: "prepare-send", id, mode: "remind" }));
  assert.strictEqual(r.status, 400, "nobody silent, nothing to nudge");

  // delete cleans up after itself
  r = parse(await call(bids, { action: "delete", id }));
  assert.strictEqual(r.body.remaining, 0);
  assert.strictEqual(DB.bids["t:" + framerToken], undefined, "vendor links revoked");
  assert.strictEqual(DB["bid-responses"][framerToken], undefined, "responses cleaned up");
  r = parse(await respond.handler({ httpMethod: "POST", body: JSON.stringify({ token: framerToken, action: "get" }) }));
  assert.strictEqual(r.status, 404, "an emailed link stops working after delete");

  console.log("Phase 1 — flow: create → read plans → package → match → blast → respond → board → award → delete");
}

async function phaseTwo() {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  const callBids = (b) => call(bids, b).then(parse);

  const id = (await callBids({ action:"create", project:{ name:"Deep Read Test", type:"custom" } })).body.id;

  let r = await callBids({ action:"analyze", id, deep:true, save:true, text:"E1.1 ELECTRICAL PLAN ".repeat(10) });
  assert.strictEqual(r.body.engine, "claude", "deep read used when the key is set");
  assert.strictEqual(seenCall.body.model, "claude-opus-5");
  assert.strictEqual(seenCall.body.output_config.format.type, "json_schema", "structured output requested");
  assert.ok(seenCall.body.output_config.format.schema.properties.packages, "schema sent");
  const pkgProps = seenCall.body.output_config.format.schema.properties.packages.items.properties;
  assert.ok(pkgProps.basis.enum.indexOf("sf") >= 0, "the model picks a basis from CRA's list");
  assert.strictEqual(pkgProps.quantity.type, "number", "and reads the takeoff quantity off the plans");
  assert.ok(/guessed quantity is worse than none/.test(seenCall.body.system),
    "and is told not to invent one");
  assert.strictEqual(r.body.packages[0].qty, 2850, "a quantity it did find comes through");
  assert.strictEqual(r.body.packages[1].basis, "sq",
    "a basis it made up falls back to that package's own default, not a generic one");
  assert.strictEqual(r.body.packages[1].qty, "", "quantity 0 means the plans didn't show it");
  assert.ok(seenCall.options.signal, "the call carries an abort signal for the function clock");
  assert.deepStrictEqual(r.body.packages.map(p=>p.key), ["electrical","roofing"],
    "unknown keys and duplicates dropped");
  assert.strictEqual(r.body.packages[0].label, "Electrical", "label comes from CRA's catalog, not the model");
  assert.deepStrictEqual(r.body.flags, ["Spec book missing the window schedule"]);
  assert.strictEqual(JSON.parse(DB.bids["p:"+id]).analyzed_with, "claude", "how it was read is recorded");

  sdkMode = "throw";
  r = await callBids({ action:"analyze", id, deep:true, text:"E1.1 ELECTRICAL PLAN PANEL SCHEDULE ".repeat(10) });
  assert.strictEqual(r.body.engine, "keywords", "falls back when the model call fails");
  assert.ok(r.body.packages.some(p=>p.key==="electrical"), "fallback still finds the trades");
  assert.ok(/upstream said no/.test(r.body.fallback_reason), "the reason is reported, not swallowed");

  sdkMode = "abort";
  r = await callBids({ action:"analyze", id, deep:true, text:"FOUNDATION PLAN FOOTING ".repeat(10) });
  assert.strictEqual(r.body.engine, "keywords", "a timeout falls back too");

  sdkMode = "ok";
  r = await callBids({ action:"analyze", id, deep:false, text:"ROOF SHINGLE" });
  assert.strictEqual(r.body.engine, "keywords", "deep read only runs when asked");

  console.log("Phase 2 — plan read: request shape, catalog-bound parsing, and both fallbacks.");
  delete process.env.ANTHROPIC_API_KEY;
}


// ── Phase 3 — the tier ladder ───────────────────────────────────────────────
// Who is allowed to receive a set of plans, and who decides.
async function phaseThree() {
  const callBids = (b) => call(bids, b).then(parse);

  DB.subs = { all: JSON.stringify([
    { id: "t1", name: "Proven Framing", email: "a@x.com", trades: ["Framing"], status: "used",
      insured: true, ins_exp: "2030-01-01", workers_comp: true,
      ratings: [{ on_time: 5, quality: 4, price: 4 }] },
    { id: "t2", name: "Vetted Framing", email: "b@x.com", trades: ["Framing"], status: "vetted",
      insured: true, ins_exp: "2030-01-01", workers_comp: true, ratings: [] },
    { id: "t3", name: "Walked Up Yesterday", email: "c@x.com", trades: ["Framing"], status: "new", ratings: [] },
    { id: "t4", name: "Lapsed Papers", email: "d@x.com", trades: ["Framing"], status: "approved",
      insured: true, ins_exp: "2020-03-01", workers_comp: true,
      ratings: [{ on_time: 5, quality: 5, price: 5 }] },
    { id: "t5", name: "Never Again", email: "e@x.com", trades: ["Framing"], status: "do-not-use", ratings: [] },
    { id: "t6", name: "No Paperwork But Trusted", email: "f@x.com", trades: ["Framing"], status: "approved",
      ratings: [] },
    { id: "t7", name: "Hand Promoted", email: "g@x.com", trades: ["Framing"], status: "new",
      tier_override: "approved", ratings: [] },
  ]) };

  const id = (await callBids({ action: "create", project: { name: "Tier Test", type: "custom" } })).body.id;
  await callBids({ action: "set-trades", id, trades: [{ key: "framing", scope: "Frame it." }] });

  let r = await callBids({ action: "match", id });
  const byId = {};
  r.body.matches[0].candidates.forEach(c => byId[c.vendor_id] = c);

  assert.strictEqual(byId.t1.tier, "preferred", "used + well rated + papers current");
  assert.strictEqual(byId.t2.tier, "approved", "vetted with current papers");
  assert.strictEqual(byId.t3.tier, "unvetted", "walked up yesterday");
  assert.strictEqual(byId.t4.tier, "unvetted", "an expired COI outranks a perfect rating");
  assert.ok(/expired/i.test(byId.t4.tier_reason), "and says why: " + byId.t4.tier_reason);
  assert.strictEqual(byId.t5, undefined, "do-not-use never reaches a bid screen at all");
  assert.strictEqual(byId.t6.tier, "approved",
    "a blank insurance box is a warning, not a demotion — otherwise the gate means nothing");
  assert.ok(/No insurance on file/.test(byId.t6.tier_warning), "but it is surfaced: " + byId.t6.tier_warning);
  assert.strictEqual(byId.t7.tier, "approved", "a hand override beats the ladder");
  assert.strictEqual(byId.t7.tier_overridden, true);

  assert.deepStrictEqual(r.body.matches[0].candidates.map(c => c.vendor_id),
    ["t1", "t2", "t6", "t7", "t4", "t3"],
    "tier decides the order, rating breaks ties inside a tier — so the lapsed sub still sorts " +
    "above the unrated one, but both sit below everyone allowed to bid");
  assert.strictEqual(r.body.matches[0].eligible_count, 4, "four are allowed to bid without an override");

  // The gate
  r = await callBids({ action: "add-invites", id, invites: [
    { trade: "framing", vendor_id: "t1" },
    { trade: "framing", vendor_id: "t3" },   // unvetted → skipped
    { trade: "framing", vendor_id: "t4" },   // lapsed COI → skipped
    { trade: "framing", vendor_id: "t5" },   // blocked → skipped
  ] });
  assert.strictEqual(r.body.added, 1, "only the eligible one goes on the list");
  assert.deepStrictEqual(r.body.skipped.map(x => x.vendor_id).sort(), ["t3", "t4", "t5"]);
  assert.ok(/do-not-use/.test(r.body.skipped.filter(x => x.vendor_id === "t5")[0].why));

  // Short on coverage? Say so explicitly, per click.
  r = await callBids({ action: "add-invites", id, allowUnvetted: true, invites: [
    { trade: "framing", vendor_id: "t3" },
    { trade: "framing", vendor_id: "t5" },   // still blocked, override or not
  ] });
  assert.strictEqual(r.body.added, 1, "unvetted can be let in deliberately");
  assert.deepStrictEqual(r.body.skipped.map(x => x.vendor_id), ["t5"],
    "but do-not-use is absolute — no flag reopens it");

  const saved = JSON.parse(DB.bids["p:" + id]);
  assert.strictEqual(saved.invites.filter(v => v.vendor_id === "t1")[0].tier_at_invite, "preferred",
    "what they were when invited is kept, so a later lapse is visible as a change");

  console.log("Phase 3 — tiers: ladder, warnings, overrides, and the gate on both sides.");
}

(async function () {
  await phaseOne();
  await phaseTwo();
  await phaseThree();
  console.log("\nBid board OK.");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
