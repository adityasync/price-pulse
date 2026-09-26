/**
 * alerts.js — bonus: price-drop / back-in-stock email alerts via SendGrid.
 * In-app badges already exist in the frontend (Dashboard.jsx alertFor).
 * This module adds OPTIONAL email: only active when SENDGRID_API_KEY and
 * ALERT_TO_EMAIL are set. Otherwise it no-ops (returns { skipped: true }).
 * Uses plain fetch — no new dependency. Best-effort: never throws.
 */

async function detectAlert(history) {
  const ok = (history || []).filter((h) => h.outcome === "success" && h.price !== null);
  if (ok.length < 2) return null;
  const prev = ok[ok.length - 2];
  const cur = ok[ok.length - 1];
  if (Number(cur.price) < Number(prev.price))
    return { type: "drop", prev: Number(prev.price), cur: Number(cur.price), stock: cur.stock };
  const wasOut = /sold out/i.test(prev.stock || "");
  const isIn = !/sold out/i.test(cur.stock || "");
  if (wasOut && isIn) return { type: "back", prev: Number(prev.price), cur: Number(cur.price), stock: cur.stock };
  return null;
}

async function sendAlertEmail({ productName, productId, optionLabel, alert }) {
  const apiKey = process.env.SENDGRID_API_KEY;
  const to = process.env.ALERT_TO_EMAIL;
  const from = process.env.ALERT_FROM_EMAIL || "alerts@price-pulse.local";
  if (!apiKey || !to) return { skipped: true, reason: "SENDGRID_API_KEY/ALERT_TO_EMAIL not set" };
  if (!alert) return { skipped: true, reason: "no alert" };
  const subject =
    alert.type === "drop"
      ? `Price drop: ${productName} (${optionLabel}) Rs.${alert.cur}`
      : `Back in stock: ${productName} (${optionLabel})`;
  const text = [
    `${subject}`,
    `Product: ${productName} [${productId}] option ${optionLabel}`,
    alert.type === "drop"
      ? `Was Rs.${alert.prev}, now Rs.${alert.cur} (drop Rs.${alert.prev - alert.cur})`
      : `Was sold out, now: ${alert.stock} at Rs.${alert.cur}`,
  ].join("\n");
  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from },
        subject,
        content: [{ type: "text/plain", value: text }],
      }),
    });
    if (!res.ok) return { sent: false, status: res.status };
    return { sent: true, status: res.status };
  } catch (err) {
    return { sent: false, error: err && err.message ? err.message : String(err) };
  }
}

module.exports = { detectAlert, sendAlertEmail };
