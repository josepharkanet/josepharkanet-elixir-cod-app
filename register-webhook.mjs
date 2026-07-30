/*
 * Registers (idempotently) the orders/create webhook → the deployed service URL.
 * Auth: client-credentials from ELX_CLIENT_ID + ELX_CLIENT_SECRET (never hard-coded).
 *   node register-webhook.mjs "https://cod.yourdomain.com"
 */
const SHOP = process.env.ELX_SHOP || "nkqtxa-gi.myshopify.com";
const VERSION = process.env.ELX_API_VERSION || "2026-01";
const CLIENT_ID = process.env.ELX_CLIENT_ID;
const CLIENT_SECRET = process.env.ELX_CLIENT_SECRET;
const url = process.argv[2];

if (!CLIENT_ID || !CLIENT_SECRET) { console.error("✗ Set ELX_CLIENT_ID and ELX_CLIENT_SECRET first."); process.exit(1); }
if (!url || !/^https:\/\//.test(url)) { console.error("✗ Usage: node register-webhook.mjs <https service url>"); process.exit(1); }

async function getToken() {
  const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "client_credentials" }),
  });
  // Shopify returns OAuth errors as an HTML page, not JSON — read text and parse safely.
  const raw = await r.text();
  let j = null;
  try { j = JSON.parse(raw); } catch {}
  if (!j || !j.access_token) {
    const title = (raw.match(/<title>([^<]*)<\/title>/) || [])[1];
    const reason = (j && (j.error_description || j.error)) || title || `HTTP ${r.status}`;
    console.error("✗ Token grant failed:", reason);
    console.error("  → ELX_CLIENT_SECRET must be the ELIXIR PROMOTIONS secret (starts 'shps…'), matching client id " + CLIENT_ID + ".");
    console.error("  → Get it with:  cd ~/Desktop/elixir-promotions && shopify app env show   (SHOPIFY_API_SECRET)");
    process.exit(1);
  }
  return j.access_token;
}
const TOKEN = await getToken();

async function gql(query, variables) {
  const r = await fetch(`https://${SHOP}/admin/api/${VERSION}/graphql.json`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) { console.error("GraphQL error:", JSON.stringify(j.errors)); process.exit(1); }
  return j;
}

const existing = await gql(`{
  webhookSubscriptions(first: 100) {
    edges { node { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } }
  }
}`);
const nodes = (existing.data.webhookSubscriptions.edges || []).map((e) => e.node);
const match = nodes.find((n) => n.topic === "ORDERS_CREATE" && n.endpoint?.callbackUrl === url);
if (match) { console.log("✓ Already registered:", match.id, "→", url); process.exit(0); }

const res = await gql(`
  mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
      webhookSubscription { id }
      userErrors { field message }
    }
  }`, { topic: "ORDERS_CREATE", sub: { callbackUrl: url, format: "JSON" } });

const out = res.data.webhookSubscriptionCreate;
if (out.userErrors?.length) { console.error("✗ userErrors:", JSON.stringify(out.userErrors)); process.exit(1); }
console.log("✓ Registered orders/create webhook:", out.webhookSubscription.id, "→", url);
