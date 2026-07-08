// netlify/functions/submission-created.js
//
// Fires automatically whenever a Netlify Form is submitted (Netlify's built-in
// "submission-created" event — no webhook config required). Sends Cole a
// Telegram alert with the lead's details so new leads surface instantly.
//
// Secrets come from Netlify environment variables (never hardcoded, never in Git):
//   TELEGRAM_BOT_TOKEN   — the bot that DMs Cole (reuse the CRA marketing bot)
//   TELEGRAM_CHAT_ID     — Cole's chat id (default below is his Jarvis chat)
//
// Set them in: Netlify → Site configuration → Environment variables.

exports.handler = async function (event) {
  try {
    const payload = JSON.parse(event.body || "{}").payload || {};
    const d = payload.data || {};

    // Only alert on the CRA leads form (ignore any other forms on the site)
    const formName = payload.form_name || "";
    if (formName && formName !== "cra-leads") {
      return { statusCode: 200, body: "ignored (not cra-leads)" };
    }

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID || "8633099607";
    if (!token) {
      // No token configured yet — don't fail the submission, just log.
      console.log("TELEGRAM_BOT_TOKEN not set; skipping alert.");
      return { statusCode: 200, body: "no token" };
    }

    const name = (d.name || "—").trim();
    const email = (d.email || "—").trim();
    const phone = (d.phone || "—").trim();
    const interest = (d.interest || "General Inquiry").trim();
    const message = (d.message || "").trim();
    const entity = (d.entity || "CRA").trim();

    let text =
      "🏡 *New lead — CRA website*\n\n" +
      "*Name:* " + name + "\n" +
      "*Email:* " + email + "\n" +
      "*Phone:* " + phone + "\n" +
      "*Interested in:* " + interest + "\n" +
      "*Entity:* " + entity;
    if (message) text += "\n\n*Message:*\n" + message;

    const res = await fetch(
      "https://api.telegram.org/bot" + token + "/sendMessage",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: text,
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        }),
      }
    );

    // Fall back to plain text if Markdown parsing fails (special chars in message)
    if (!res.ok) {
      await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text:
            "New lead — CRA website\n\n" +
            "Name: " + name + "\nEmail: " + email + "\nPhone: " + phone +
            "\nInterested in: " + interest + "\nEntity: " + entity +
            (message ? "\n\nMessage:\n" + message : ""),
        }),
      });
    }

    return { statusCode: 200, body: "alert sent" };
  } catch (err) {
    console.log("submission-created error:", err && err.message);
    // Never fail the submission because of an alerting hiccup
    return { statusCode: 200, body: "error handled" };
  }
};
