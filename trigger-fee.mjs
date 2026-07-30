// Faithfully re-send the orders/create webhook for the latest order to the LIVE
// app (properly signed), and print the app's exact response — this exercises the
// real order-edit path and surfaces any error.
import crypto from "node:crypto";
const SHOP = process.env.ELX_SHOP || "nkqtxa-gi.myshopify.com";
const VERSION = process.env.ELX_API_VERSION || "2026-01";
const CLIENT_ID = process.env.ELX_CLIENT_ID;
const CLIENT_SECRET = process.env.ELX_CLIENT_SECRET;
const COD_URL = process.env.COD_URL || "https://cod.elixirbeauty.com";

async function getToken() {
  const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "client_credentials" }),
  });
  const j = await r.json();
  if (!j.access_token) { console.error("token failed:", JSON.stringify(j)); process.exit(1); }
  return j.access_token;
}
const t = await getToken();
const r = await fetch(`https://${SHOP}/admin/api/${VERSION}/graphql.json`, {
  method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": t },
  body: JSON.stringify({ query: `{ orders(first:1, sortKey:CREATED_AT, reverse:true){ edges{ node{ id name paymentGatewayNames } } } }` }),
});
const o = (await r.json()).data.orders.edges[0].node;
const numericId = o.id.split("/").pop();
console.log(`Latest order: ${o.name} (id ${numericId}), gateways ${JSON.stringify(o.paymentGatewayNames)}`);

const payload = JSON.stringify({
  id: Number(numericId),
  name: o.name,
  currency: "AED",
  payment_gateway_names: o.paymentGatewayNames,
});
const hmac = crypto.createHmac("sha256", CLIENT_SECRET).update(payload, "utf8").digest("base64");
console.log(`\n→ POSTing signed webhook to ${COD_URL} …`);
const res = await fetch(COD_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Shopify-Hmac-Sha256": hmac, "X-Shopify-Topic": "orders/create" },
  body: payload,
});
console.log("app HTTP", res.status);
console.log("app says:", await res.text());
