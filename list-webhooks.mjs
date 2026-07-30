// List all webhook subscriptions THIS app (Promotions) can see.
const SHOP = process.env.ELX_SHOP || "nkqtxa-gi.myshopify.com";
const VERSION = process.env.ELX_API_VERSION || "2026-01";
const CLIENT_ID = process.env.ELX_CLIENT_ID;
const CLIENT_SECRET = process.env.ELX_CLIENT_SECRET;

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
  body: JSON.stringify({ query: `{ webhookSubscriptions(first:100){ edges{ node{ id topic createdAt endpoint{ __typename ... on WebhookHttpEndpoint{ callbackUrl } } } } } }` }),
});
const j = await r.json();
const nodes = (j.data?.webhookSubscriptions?.edges || []).map(e => e.node);
console.log(`This app (Promotions) sees ${nodes.length} webhook subscription(s):`);
for (const n of nodes) console.log("  •", n.topic, "→", n.endpoint?.callbackUrl, "  (" + n.id + ")");
if (!nodes.some(n => n.topic === "ORDERS_CREATE")) {
  console.log("\n⚠ Promotions has NO orders/create webhook — the existing one belongs to a DIFFERENT app.");
}
