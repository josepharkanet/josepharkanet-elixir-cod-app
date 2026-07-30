// Inspect the most recent orders: total, tags, gateway names, line items.
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
const q = `{
  orders(first: 4, sortKey: CREATED_AT, reverse: true) {
    edges { node {
      name createdAt tags displayFinancialStatus paymentGatewayNames
      totalPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: 20) { edges { node { title quantity } } }
    } }
  }
}`;
const r = await fetch(`https://${SHOP}/admin/api/${VERSION}/graphql.json`, {
  method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": t },
  body: JSON.stringify({ query: q }),
});
const j = await r.json();
if (j.errors) { console.error("GraphQL error:", JSON.stringify(j.errors, null, 2)); process.exit(1); }
for (const e of j.data.orders.edges) {
  const o = e.node;
  console.log(`\n${o.name}  ${o.totalPriceSet.shopMoney.amount} ${o.totalPriceSet.shopMoney.currencyCode}  [${o.displayFinancialStatus}]`);
  console.log(`  gateways: ${JSON.stringify(o.paymentGatewayNames)}`);
  console.log(`  tags: ${JSON.stringify(o.tags)}`);
  console.log(`  items: ${o.lineItems.edges.map(x => `${x.node.title} x${x.node.quantity}`).join(" | ")}`);
}
