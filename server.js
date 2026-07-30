/*
 * COD Fee service — Phase 1 (single store, Docker/Coolify-deployable).
 * -------------------------------------------------------------------
 * Shopify calls POST / on `orders/create`. If the order was paid with Cash on
 * Delivery, the service adds a "Cash on Delivery fee" line to that order (Admin
 * order-editing API) so the courier collects it with the product. Card / online
 * orders are never touched.
 *
 * This is the automated version of the fee — the thing the theme could never do.
 * It's plain Node (no framework, no deps) so it runs on any host: Coolify/Docker,
 * a VPS, Render, Railway, Fly, etc. Phase 2 grows this into a multi-store app
 * (OAuth install, per-shop settings DB, billing, OTP, a settings UI).
 *
 * Config = env vars (see .env.example). Auth = a Dev-Dashboard app's Client ID +
 * Secret via client-credentials (mints a short-lived Admin token, caches it);
 * the Secret also verifies the webhook HMAC.
 */
const http = require("http");
const crypto = require("crypto");

const {
  SHOP = "nkqtxa-gi.myshopify.com",
  API_VERSION = "2026-01",
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  COD_FEE_AMOUNT = "10.00",
  COD_FEE_CURRENCY = "AED",
  COD_FEE_TITLE = "Cash on Delivery fee",
  COD_FEE_TAXABLE = "false",
  COD_FEE_VARIANT_ID = "", // optional: gid of a hidden "COD Fee" product variant. If set, add THAT (shows its image) instead of a placeholder custom item.
  COD_GATEWAY_MATCH = "cash on delivery",
  COD_NOTIFY_CUSTOMER = "true", // email the customer the updated order (with the fee). Set "false" to add silently.
  PORT = "3000",
} = process.env;

const TAG = "cod-fee-added";
let cachedToken = null;
let cachedExp = 0;

async function getToken() {
  const now = Date.now();
  if (cachedToken && now < cachedExp - 60000) return cachedToken;
  const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET, grant_type: "client_credentials" }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("token grant failed: " + JSON.stringify(j));
  cachedToken = j.access_token;
  cachedExp = now + (Number(j.expires_in) || 86400) * 1000;
  return cachedToken;
}

async function gql(query, variables) {
  const token = await getToken();
  const r = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
}

function verifyHmac(rawBody, sent) {
  if (!sent || !SHOPIFY_CLIENT_SECRET) return false;
  const digest = crypto.createHmac("sha256", SHOPIFY_CLIENT_SECRET).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(sent);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function addCodFee(order) {
  const gateways = (order.payment_gateway_names || []).join(" | ").toLowerCase();
  if (!gateways.includes(COD_GATEWAY_MATCH.toLowerCase())) return { skipped: "not COD", gateways };

  const gid = `gid://shopify/Order/${order.id}`;

  // Idempotency — the webhook can be retried.
  const cur = await gql(`query($id:ID!){ order(id:$id){ id tags } }`, { id: gid });
  const tags = cur?.data?.order?.tags || [];
  if (tags.includes(TAG)) return { skipped: "already added" };

  const begin = await gql(`mutation($id:ID!){ orderEditBegin(id:$id){ calculatedOrder{ id } userErrors{ message } } }`, { id: gid });
  const calcId = begin?.data?.orderEditBegin?.calculatedOrder?.id;
  if (!calcId) throw new Error("begin: " + JSON.stringify(begin?.data?.orderEditBegin?.userErrors || begin));

  let add, addErr;
  if (COD_FEE_VARIANT_ID) {
    // Preferred: add a hidden "COD Fee" product variant so the order line shows
    // its image (price/tax/shipping come from that product) instead of a gray box.
    add = await gql(
      `mutation($id:ID!,$variantId:ID!,$qty:Int!){
         orderEditAddVariant(id:$id,variantId:$variantId,quantity:$qty,allowDuplicates:true){
           calculatedLineItem{ id } userErrors{ message }
         }
       }`,
      { id: calcId, variantId: COD_FEE_VARIANT_ID, qty: 1 }
    );
    addErr = add?.data?.orderEditAddVariant?.userErrors || [];
  } else {
    // Fallback: a custom line item (renders with a placeholder image).
    add = await gql(
      `mutation($id:ID!,$title:String!,$qty:Int!,$price:MoneyInput!,$taxable:Boolean!){
         orderEditAddCustomItem(id:$id,title:$title,quantity:$qty,price:$price,requiresShipping:false,taxable:$taxable){
           calculatedLineItem{ id } userErrors{ message }
         }
       }`,
      { id: calcId, title: COD_FEE_TITLE, qty: 1, price: { amount: COD_FEE_AMOUNT, currencyCode: order.currency || COD_FEE_CURRENCY }, taxable: COD_FEE_TAXABLE === "true" }
    );
    addErr = add?.data?.orderEditAddCustomItem?.userErrors || [];
  }
  if (addErr.length) throw new Error("add: " + JSON.stringify(addErr));

  const commit = await gql(
    `mutation($id:ID!,$notify:Boolean!){ orderEditCommit(id:$id,notifyCustomer:$notify,staffNote:"COD handling fee added automatically"){ order{ id } userErrors{ message } } }`,
    { id: calcId, notify: COD_NOTIFY_CUSTOMER !== "false" }
  );
  if (!commit?.data?.orderEditCommit?.order?.id) throw new Error("commit: " + JSON.stringify(commit?.data?.orderEditCommit?.userErrors || commit));

  await gql(`mutation($id:ID!,$tags:[String!]!){ tagsAdd(id:$id,tags:$tags){ userErrors{ message } } }`, { id: gid, tags: [TAG] });
  return { added: true, order: order.name || order.id };
}

const server = http.createServer((req, res) => {
  if (req.method === "GET") { res.writeHead(200); res.end("COD Fee service is running."); return; }
  if (req.method !== "POST") { res.writeHead(405); res.end("Method not allowed"); return; }

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!verifyHmac(raw, req.headers["x-shopify-hmac-sha256"] || "")) { res.writeHead(401); res.end("Invalid HMAC"); return; }
    let order;
    try { order = JSON.parse(raw); } catch { res.writeHead(400); res.end("Bad JSON"); return; }
    try {
      const result = await addCodFee(order);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (e) {
      console.error("COD fee error:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
});

server.listen(Number(PORT), () => console.log(`COD Fee service listening on :${PORT}`));
