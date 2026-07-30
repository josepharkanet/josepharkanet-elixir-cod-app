// Send a properly-signed test webhook to the live COD service to validate that
// Coolify's SHOPIFY_CLIENT_SECRET matches (HMAC passes) and the app processes.
// Uses a NON-COD payload so nothing real is edited (the app returns early).
import crypto from "node:crypto";

const URL = process.env.COD_URL || "https://cod.elixirbeauty.com";
const SECRET = process.env.ELX_CLIENT_SECRET;
if (!SECRET) { console.error("Set ELX_CLIENT_SECRET"); process.exit(1); }

const payload = JSON.stringify({
  id: 999999999,
  name: "#HMAC-TEST",
  currency: "AED",
  payment_gateway_names: ["diagnostic-not-cod"], // not COD -> app returns {skipped:"not COD"} without touching Shopify
});

const hmac = crypto.createHmac("sha256", SECRET).update(payload, "utf8").digest("base64");
const r = await fetch(URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Shopify-Hmac-Sha256": hmac,
    "X-Shopify-Topic": "orders/create",
  },
  body: payload,
});
console.log("HTTP", r.status);
console.log(await r.text());
console.log(r.status === 200 ? "\n✅ Signature OK — Coolify secret matches; a real COD order would get the fee."
  : r.status === 401 ? "\n❌ 401 Invalid HMAC — Coolify SHOPIFY_CLIENT_SECRET is wrong/missing; set it to the Promotions secret + redeploy."
  : "\n⚠ Unexpected — check the app logs.");
