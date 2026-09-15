// netlify/functions/bid-pixel.js
//
// One transparent pixel at the bottom of every bid invitation. When it loads
// we know the email was opened, which is the difference between "he's ignoring
// me" and "it went to spam" when a trade goes quiet two days before bids are
// due. It only ever records the open — it never downgrades a real answer.
//
// Image clients block remote images often enough that a missing open means
// nothing; a present one is real.

const { getStore } = require("@netlify/blobs");

const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

function pixel() {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "image/gif",
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      "Content-Length": String(GIF.length),
    },
    body: GIF.toString("base64"),
    isBase64Encoded: true,
  };
}

exports.handler = async function (event) {
  const token = String((event.queryStringParameters || {}).t || "").replace(/[^a-f0-9]/gi, "").slice(0, 64);
  if (!token || !process.env.NETLIFY_SITE_ID || !process.env.NETLIFY_API_TOKEN) return pixel();

  try {
    const opts = {
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
      consistency: "strong",
    };
    // Confirm the token belongs to a real invite before writing anything —
    // otherwise a crawler hitting made-up codes seeds junk in the store.
    const pointer = await getStore(Object.assign({ name: "bids" }, opts)).get("t:" + token, { type: "json" });
    if (!pointer) return pixel();

    const store = getStore(Object.assign({ name: "bid-responses" }, opts));
    const cur = (await store.get(token, { type: "json" })) || {};
    if (!cur.opened_at) {
      cur.opened_at = new Date().toISOString();
      if (!cur.status || cur.status === "sent") cur.status = "opened";
      await store.setJSON(token, cur);
    }
  } catch (e) { /* tracking never breaks the email */ }

  return pixel();
};
