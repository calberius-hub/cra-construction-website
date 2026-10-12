// netlify/functions/bid-pixel.js
//
// Bid My Job moved to the Alberius platform (bidmyjob.alberiusops.com) on
// 12 Oct 2026. Invitations, sent and yet to be sent, carry this address for
// their "opened" pixel, so it stays and passes the open along to the platform.
// The answer is always the same transparent pixel.

const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const PLATFORM = "https://bidmyjob.alberiusops.com/api/fn/bid-pixel";

exports.handler = async function (event) {
  const token = String((event.queryStringParameters || {}).t || "").replace(/[^a-f0-9]/gi, "").slice(0, 64);
  if (token) {
    try { await fetch(PLATFORM + "?t=" + token, { signal: AbortSignal.timeout(4000) }); } catch (e) { /* the pixel never fails */ }
  }
  return {
    statusCode: 200,
    headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, no-cache, must-revalidate, private", "Content-Length": String(GIF.length) },
    body: GIF.toString("base64"),
    isBase64Encoded: true,
  };
};
