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

/* ------------------------------------------------------------------ gift vouchers
 * Spend-tier reward. On a new order we read the merchant's tier config (a shop
 * metafield set by the Elixir Promotions app), pick the % by the order subtotal,
 * create a unique single-use discount code LOCKED to that customer, and store it
 * on the customer (for the "My Vouchers" account page) and on the order (so the
 * shipping-confirmation email can show it). Runs on orders/create — the same
 * webhook the COD fee uses — so the code exists before fulfillment, which is when
 * the email is sent (this also covers COD orders, which are not "paid" until later).
 */
const VOUCHER_TAG = "voucher-issued";
const VOUCHER_CANCELLED_TAG = "voucher-cancelled";
const VOUCHER_MAX_ISSUED = 25;                            // T&C: first 25 customers
const VOUCHER_PROGRAM_END = "2026-09-30T23:59:59+04:00";  // T&C: valid until 30 Sep 2026 (Gulf time)
let vCfg = null, vCfgExp = 0;

async function voucherConfig() {
  const now = Date.now();
  if (vCfg !== null && now < vCfgExp) return vCfg;
  const j = await gql(`{ shop { metafield(namespace:"elixir_promotions", key:"voucher_config"){ value } } }`);
  let cfg = null;
  try { const v = j?.data?.shop?.metafield?.value; cfg = v ? JSON.parse(v) : null; } catch { cfg = null; }
  vCfg = cfg; vCfgExp = now + 60000; // cache 60s to avoid a lookup per order
  return cfg;
}

/** Highest tier whose overAmount is strictly below the subtotal wins. 0 = none. */
function voucherPercentFor(cfg, subtotal) {
  let percent = 0, best = -1;
  for (const t of (cfg.tiers || [])) {
    const over = Number(t.overAmount) || 0;
    if (subtotal > over && over >= best) { best = over; percent = Number(t.percent) || 0; }
  }
  return percent;
}

async function issueVoucher(order) {
  const cfg = await voucherConfig();
  if (!cfg || !cfg.active) return { skipped: "voucher program inactive" };

  const customerId = order.customer && order.customer.id;
  if (!customerId) return { skipped: "no customer on order" };

  const subtotal = parseFloat(order.current_subtotal_price || order.subtotal_price || "0") || 0;
  const percent = voucherPercentFor(cfg, subtotal);
  if (!percent) return { skipped: "no matching tier", subtotal };

  const gid = `gid://shopify/Order/${order.id}`;

  // Idempotency — the webhook can be retried.
  const cur = await gql(`query($id:ID!){ order(id:$id){ tags } }`, { id: gid });
  if ((cur?.data?.order?.tags || []).includes(VOUCHER_TAG)) return { skipped: "voucher already issued" };

  // T&C caps — merchant-managed in the Gift Vouchers screen (cfg.endDate,
  // cfg.maxRedemptions), falling back to the built-in defaults for a config that
  // predates these fields. endDate "" = no end; maxRedemptions 0 = unlimited.
  const endStr = (cfg.endDate !== undefined) ? String(cfg.endDate).trim() : VOUCHER_PROGRAM_END;
  if (endStr) {
    const endMs = new Date(/[T ]\d\d:/.test(endStr) ? endStr : endStr + "T23:59:59+04:00").getTime();
    if (Number.isFinite(endMs) && Date.now() > endMs) return { skipped: "voucher program ended", endDate: endStr };
  }
  const cap = (cfg.maxRedemptions !== undefined) ? Number(cfg.maxRedemptions) : VOUCHER_MAX_ISSUED;
  if (cap > 0) {
    const issuedRes = await gql(`query($q:String){ ordersCount(query:$q){ count } }`, { q: `tag:${VOUCHER_TAG}` });
    const issuedSoFar = issuedRes?.data?.ordersCount?.count ?? 0;
    if (issuedSoFar >= cap) return { skipped: `voucher cap reached (${cap} issued)` };
  }

  const customerGid = `gid://shopify/Customer/${customerId}`;
  const now = new Date();
  const expiryDays = Math.max(1, Number(cfg.expiryDays) || 90);
  const endsAt = new Date(now.getTime() + expiryDays * 86400000);
  const minRedeem = Number(cfg.minRedeemSubtotal) || 0;
  const code = "ELX-GIFT-" + crypto.randomBytes(4).toString("hex").toUpperCase();

  const input = {
    title: `Gift voucher ${percent}% (${order.name || order.id})`,
    code,
    startsAt: now.toISOString(),
    endsAt: endsAt.toISOString(),
    usageLimit: 1,
    appliesOncePerCustomer: true,
    customerSelection: { customers: { add: [customerGid] } },
    customerGets: { value: { percentage: percent / 100 }, items: { all: true } },
    combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
  };
  if (minRedeem > 0) input.minimumRequirement = { subtotal: { greaterThanOrEqualToSubtotal: String(minRedeem) } };

  const created = await gql(
    `mutation($d:DiscountCodeBasicInput!){ discountCodeBasicCreate(basicCodeDiscount:$d){ codeDiscountNode{ id } userErrors{ field message } } }`,
    { d: input }
  );
  const cErr = created?.data?.discountCodeBasicCreate?.userErrors || [];
  if (cErr.length) throw new Error("voucher create: " + JSON.stringify(cErr));

  const voucher = { code, percent, expiresAt: endsAt.toISOString(), minRedeem, status: "active", issuedFor: order.name || String(order.id) };

  // Append to the customer's voucher list (read-modify-write) + stamp the order.
  const existing = await gql(`query($id:ID!){ customer(id:$id){ metafield(namespace:"custom", key:"gift_vouchers"){ value } } }`, { id: customerGid });
  let list = [];
  try { const v = existing?.data?.customer?.metafield?.value; list = v ? JSON.parse(v) : []; } catch { list = []; }
  list.unshift(voucher);

  const mset = await gql(
    `mutation($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ userErrors{ field message } } }`,
    { m: [
      { ownerId: customerGid, namespace: "custom", key: "gift_vouchers", type: "json", value: JSON.stringify(list) },
      { ownerId: gid, namespace: "custom", key: "gift_voucher", type: "json", value: JSON.stringify(voucher) },
    ] }
  );
  const mErr = mset?.data?.metafieldsSet?.userErrors || [];
  if (mErr.length) throw new Error("voucher metafields: " + JSON.stringify(mErr));

  // Shopify email notifications CANNOT read order metafields (only product/variant),
  // but they CAN read order custom attributes via {{ attributes.key }}. So also expose
  // the voucher as order attributes for the shipping-confirmation email. Read-modify-write
  // to preserve any attributes already on the order (e.g. a greeting-card message).
  const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const expiryStr = `${String(endsAt.getUTCDate()).padStart(2,"0")} ${MON[endsAt.getUTCMonth()]} ${endsAt.getUTCFullYear()}`;
  const curAttrs = await gql(`query($id:ID!){ order(id:$id){ customAttributes{ key value } } }`, { id: gid });
  const keep = (curAttrs?.data?.order?.customAttributes || [])
    .filter((a) => a && a.key && !a.key.startsWith("gift_voucher_"))
    .map((a) => ({ key: a.key, value: a.value == null ? "" : String(a.value) }));
  const attrs = keep.concat([
    { key: "gift_voucher_code", value: code },
    { key: "gift_voucher_percent", value: String(percent) },
    { key: "gift_voucher_expiry", value: expiryStr },
    { key: "gift_voucher_minredeem", value: String(minRedeem) },
  ]);
  const oup = await gql(
    `mutation($id:ID!,$a:[AttributeInput!]!){ orderUpdate(input:{id:$id, customAttributes:$a}){ userErrors{ field message } } }`,
    { id: gid, a: attrs }
  );
  const oErr = oup?.data?.orderUpdate?.userErrors || [];
  if (oErr.length) throw new Error("voucher order attributes: " + JSON.stringify(oErr));

  await gql(`mutation($id:ID!,$tags:[String!]!){ tagsAdd(id:$id,tags:$tags){ userErrors{ message } } }`, { id: gid, tags: [VOUCHER_TAG] });
  return { issued: true, code, percent, order: order.name || order.id };
}

/* When an order is cancelled or fully refunded/returned, revoke the voucher it
 * earned: DEACTIVATE the discount code so it can't be redeemed, and mark it
 * "cancelled" on the order + customer metafields (so the My Vouchers page shows
 * it as void). Idempotent via a `voucher-cancelled` tag. */
async function cancelVoucherForOrder(orderGid, reason) {
  const cur = await gql(
    `query($id:ID!){ order(id:$id){ tags customAttributes{ key value } customer{ id } metafield(namespace:"custom",key:"gift_voucher"){ value } } }`,
    { id: orderGid }
  );
  const o = cur?.data?.order;
  if (!o) return { skipped: "order not found" };
  const tags = o.tags || [];
  if (!tags.includes(VOUCHER_TAG)) return { skipped: "no voucher was issued for this order" };
  if (tags.includes(VOUCHER_CANCELLED_TAG)) return { skipped: "voucher already cancelled" };

  const codeAttr = (o.customAttributes || []).find((a) => a && a.key === "gift_voucher_code");
  const code = codeAttr && codeAttr.value;
  if (!code) return { skipped: "voucher tag present but no code found" };

  // Deactivate the discount code so it can no longer be applied at checkout.
  let deactivated = false;
  const found = await gql(`query($code:String!){ codeDiscountNodeByCode(code:$code){ id } }`, { code });
  const discId = found?.data?.codeDiscountNodeByCode?.id;
  if (discId) {
    const deact = await gql(
      `mutation($id:ID!){ discountCodeDeactivate(id:$id){ codeDiscountNode{ id } userErrors{ field message } } }`,
      { id: discId }
    );
    const dErr = deact?.data?.discountCodeDeactivate?.userErrors || [];
    if (dErr.length) console.warn("voucher deactivate:", JSON.stringify(dErr));
    else deactivated = true;
  }

  // Flip the stored status to "cancelled" on the order + the customer's list.
  try {
    const mfs = [];
    let ov = null;
    try { ov = o.metafield?.value ? JSON.parse(o.metafield.value) : null; } catch { ov = null; }
    if (ov) { ov.status = "cancelled"; mfs.push({ ownerId: orderGid, namespace: "custom", key: "gift_voucher", type: "json", value: JSON.stringify(ov) }); }
    const customerGid = o.customer && o.customer.id;
    if (customerGid) {
      const ex = await gql(`query($id:ID!){ customer(id:$id){ metafield(namespace:"custom",key:"gift_vouchers"){ value } } }`, { id: customerGid });
      let list = [];
      try { const lv = ex?.data?.customer?.metafield?.value; list = lv ? JSON.parse(lv) : []; } catch { list = []; }
      list = list.map((x) => (x && x.code === code ? { ...x, status: "cancelled" } : x));
      mfs.push({ ownerId: customerGid, namespace: "custom", key: "gift_vouchers", type: "json", value: JSON.stringify(list) });
    }
    if (mfs.length) await gql(`mutation($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ userErrors{ message } } }`, { m: mfs });
  } catch (e) { console.warn("voucher status update:", e.message); }

  await gql(`mutation($id:ID!,$tags:[String!]!){ tagsAdd(id:$id,tags:$tags){ userErrors{ message } } }`, { id: orderGid, tags: [VOUCHER_CANCELLED_TAG] });
  return { cancelled: true, code, deactivated, reason };
}

/* On boot, make sure the cancel/refund webhooks exist. We reuse the callback URL
 * of the already-registered orders/create webhook, so no extra config is needed;
 * it is idempotent and never blocks startup. */
async function ensureWebhooks() {
  const existing = await gql(`{ webhookSubscriptions(first:100){ edges{ node{ topic endpoint{ __typename ... on WebhookHttpEndpoint{ callbackUrl } } } } } }`);
  const nodes = (existing?.data?.webhookSubscriptions?.edges || []).map((e) => e.node);
  const base = nodes.find((n) => n.topic === "ORDERS_CREATE")?.endpoint?.callbackUrl;
  if (!base) { console.warn("ensureWebhooks: orders/create webhook not found; skipping auto-register"); return; }
  for (const topic of ["ORDERS_CANCELLED", "REFUNDS_CREATE"]) {
    if (nodes.some((n) => n.topic === topic && n.endpoint?.callbackUrl === base)) continue;
    const res = await gql(
      `mutation($t:WebhookSubscriptionTopic!,$s:WebhookSubscriptionInput!){ webhookSubscriptionCreate(topic:$t,webhookSubscription:$s){ webhookSubscription{ id } userErrors{ message } } }`,
      { t: topic, s: { callbackUrl: base, format: "JSON" } }
    );
    const err = res?.data?.webhookSubscriptionCreate?.userErrors || [];
    if (err.length) console.warn(`ensureWebhooks ${topic}:`, JSON.stringify(err));
    else console.log(`✓ registered ${topic} → ${base}`);
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "GET") { res.writeHead(200); res.end("COD Fee service is running."); return; }
  if (req.method !== "POST") { res.writeHead(405); res.end("Method not allowed"); return; }

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!verifyHmac(raw, req.headers["x-shopify-hmac-sha256"] || "")) { res.writeHead(401); res.end("Invalid HMAC"); return; }
    let body;
    try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end("Bad JSON"); return; }
    const topic = (req.headers["x-shopify-topic"] || "").toLowerCase();
    try {
      let result;
      if (topic === "orders/cancelled") {
        // Order voided -> revoke its gift voucher.
        result = { voucher: await cancelVoucherForOrder(`gid://shopify/Order/${body.id}`, "order cancelled") };
      } else if (topic === "refunds/create") {
        // Only revoke when the WHOLE order is refunded; a partial refund keeps the voucher.
        const orderGid = `gid://shopify/Order/${body.order_id}`;
        const ord = await gql(`query($id:ID!){ order(id:$id){ displayFinancialStatus } }`, { id: orderGid });
        const fin = ord?.data?.order?.displayFinancialStatus;
        result = fin === "REFUNDED"
          ? { voucher: await cancelVoucherForOrder(orderGid, "order fully refunded") }
          : { voucher: { skipped: `refund but order is ${fin || "not fully refunded"}; voucher kept` } };
      } else if (topic === "orders/create" || topic === "") {
        // Add the COD fee + issue the voucher. Each is independently idempotent
        // (its own tag), so a webhook retry after a partial failure is safe.
        const cod = await addCodFee(body);
        const voucher = await issueVoucher(body);
        result = { cod, voucher };
      } else {
        result = { skipped: `unhandled topic ${topic}` };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, topic: topic || "orders/create", ...result }));
    } catch (e) {
      console.error(`webhook error (${topic || "orders/create"}):`, e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
});

server.listen(Number(PORT), () => {
  console.log(`COD Fee service listening on :${PORT}`);
  ensureWebhooks().catch((e) => console.warn("ensureWebhooks:", e.message));
});
