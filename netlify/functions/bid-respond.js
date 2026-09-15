// netlify/functions/bid-respond.js
//
// The subcontractor's side of the bid board. Public on purpose: the only
// credential is the 96-bit token in the link we emailed, and it only ever
// reaches one invite on one project.
//
// A sub standing in a truck gets one shot at this, same as the /bid QR form —
// so the page asks for three taps at most and we never bounce them to a login.
//
// Actions (POST JSON { token, action, ... }):
//   "get"     → what they were invited to bid, and what they've already said
//   "respond" → bidding / pass / submitted (with the number)
//
// Writes only "bid-responses"/<token>, which is that one vendor's blob. Twelve
// subs answering at the same moment never touch each other's answer, and the
// project doc — written by the dashboard — is left alone entirely.

const { getStore } = require("@netlify/blobs");

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

async function telegramAlert(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID || "8633099607";
  if (!token) return;
  try {
    await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text, disable_web_page_preview: true }),
    });
  } catch (e) { /* an alert hiccup never costs us the response */ }
}

// token → the project and the one invite inside it
async function resolve(token) {
  const ptr = await store("bids").get("t:" + token, { type: "json" });
  if (!ptr) return null;
  const project = await store("bids").get("p:" + ptr.project_id, { type: "json" });
  if (!project) return null;
  const invite = (project.invites || []).filter(function (v) { return v.id === ptr.invite_id; })[0];
  if (!invite) return null;
  const trade = (project.trades || []).filter(function (t) { return t.key === invite.trade; })[0]
    || { key: invite.trade, label: invite.trade, scope: "" };
  return { project: project, invite: invite, trade: trade };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (!process.env.NETLIFY_SITE_ID || !process.env.NETLIFY_API_TOKEN) {
    return json(500, { error: "storage not configured" });
  }

  let req;
  try { req = JSON.parse(event.body || "{}"); }
  catch (e) { return json(400, { error: "bad JSON" }); }

  const token = clean(req.token, 64).replace(/[^a-f0-9]/gi, "");
  if (!token) return json(400, { error: "missing link code" });

  try {
    const found = await resolve(token);
    if (!found) return json(404, { error: "This bid link is no longer active. Call CRA and we'll get you a new one." });
    const project = found.project, invite = found.invite, trade = found.trade;
    const responses = store("bid-responses");
    const current = (await responses.get(token, { type: "json" })) || {};

    if (req.action === "get") {
      // Opening the page is the open we count — the pixel is just a backstop
      // for the ones who never click.
      if (!current.opened_at) {
        current.opened_at = new Date().toISOString();
        if (!current.status || current.status === "sent") current.status = "opened";
        await responses.setJSON(token, current);
      }
      return json(200, {
        project: {
          name: project.name,
          address: project.address,
          type: project.type,
          status: project.status,
          bid_due: project.bid_due,
          walk_at: project.walk_at,
          walk_time: project.walk_time,
          start_date: project.start_date,
          plan_url: project.plan_url,
          plan_notes: project.plan_notes,
          scope_notes: project.scope_notes,
        },
        trade: { key: trade.key, label: trade.label, scope: trade.scope || "" },
        invite: { name: invite.name, company: invite.company },
        response: {
          status: current.status || "opened",
          amount: current.amount == null ? "" : current.amount,
          notes: current.notes || "",
          eta: current.eta || "",
          responded_at: current.responded_at || "",
        },
        closed: project.status === "closed" || project.status === "awarded",
      });
    }

    if (req.action === "respond") {
      const kind = clean(req.response, 20);
      if (["bidding", "pass", "submit"].indexOf(kind) < 0) return json(400, { error: "unknown response" });

      if (kind === "submit") {
        const n = Number(String(req.amount == null ? "" : req.amount).replace(/[^0-9.]/g, ""));
        if (!(n > 0)) return json(400, { error: "Enter your bid amount to send it." });
        current.amount = Math.round(n * 100) / 100;
        current.status = "submitted";
      } else {
        current.status = kind === "bidding" ? "bidding" : "declined";
        if (kind === "pass") current.amount = "";
      }
      current.notes = clean(req.notes, 1200);
      current.eta = clean(req.eta, 60);
      current.by = invite.name || invite.company || "sub";
      current.responded_at = new Date().toISOString();
      current.updated_at = current.responded_at;
      current.history = (current.history || []).concat([{ at: current.responded_at, status: current.status }]).slice(-20);
      await responses.setJSON(token, current);

      const who = (invite.name || "") + (invite.company ? " (" + invite.company + ")" : "");
      const line =
        current.status === "submitted"
          ? "💰 BID IN — $" + Number(current.amount).toLocaleString("en-US")
          : current.status === "bidding" ? "✅ Bidding it" : "🚫 Passing";
      await telegramAlert(
        line + "\n" + trade.label + " — " + project.name + "\n" + who +
        (current.notes ? "\n\n" + current.notes : "")
      );

      return json(200, {
        ok: true,
        status: current.status,
        amount: current.amount == null ? "" : current.amount,
      });
    }

    return json(400, { error: "unknown action" });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
};
