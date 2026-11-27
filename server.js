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
  COD_NOTIFY_CUSTOMER = "false", // see the commit note on the edit below. Set "true" only if you mean it.
  GIFT_BOX_VARIANT_ID = "", // gid of the hidden "Gift Box" variant. Empty = feature off.
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

  // Never notify by default. Adding the fee raises the balance due, and on an unpaid order
  // Shopify answers notifyCustomer:true with its INVOICE email: "Payment of X is due" over a
  // Pay now button. Every one of these orders is cash on delivery, so that email invites the
  // customer to pay online for an amount the courier is already on the way to collect in cash.
  // EL 1055 was paid by card on 17 Nov 2026 after exactly this email, three days after the
  // customer chose COD. The fee still needs to reach the customer, but through the invoice the
  // packer encloses, not a payment link.
  const commit = await gql(
    `mutation($id:ID!,$notify:Boolean!){ orderEditCommit(id:$id,notifyCustomer:$notify,staffNote:"COD handling fee added automatically"){ order{ id } userErrors{ message } } }`,
    { id: calcId, notify: COD_NOTIFY_CUSTOMER === "true" }
  );
  if (!commit?.data?.orderEditCommit?.order?.id) throw new Error("commit: " + JSON.stringify(commit?.data?.orderEditCommit?.userErrors || commit));

  await gql(`mutation($id:ID!,$tags:[String!]!){ tagsAdd(id:$id,tags:$tags){ userErrors{ message } } }`, { id: gid, tags: [TAG] });
  return { added: true, order: order.name || order.id };
}

/* ------------------------------------------------------------------ gift box
 * Every Elixir order ships with complimentary gift packaging, so every order
 * carries a Gift Box line at zero cost. It is there to tell the packer, and to
 * show the customer what is included, so it has to appear on the invoice and the
 * pickup slip. Priced 0 and not taxable, so no total changes and the customer is
 * not emailed an "order edited" notice over a free line.
 */
const GIFT_BOX_TAG = "gift-box-added";

async function addGiftBox(order) {
  if (!GIFT_BOX_VARIANT_ID) return { skipped: "gift box not configured" };
  const gid = `gid://shopify/Order/${order.id}`;

  // Idempotency — the webhook can be retried, and a second free box on the
  // invoice would have the packer sending two.
  const cur = await gql(`query($id:ID!){ order(id:$id){ tags lineItems(first:100){ nodes{ variant{ id } } } } }`, { id: gid });
  const tags = cur?.data?.order?.tags || [];
  if (tags.includes(GIFT_BOX_TAG)) return { skipped: "already added" };
  const already = (cur?.data?.order?.lineItems?.nodes || []).some((li) => li.variant && li.variant.id === GIFT_BOX_VARIANT_ID);
  if (already) return { skipped: "gift box already on the order" };

  const begin = await gql(`mutation($id:ID!){ orderEditBegin(id:$id){ calculatedOrder{ id } userErrors{ message } } }`, { id: gid });
  const calcId = begin?.data?.orderEditBegin?.calculatedOrder?.id;
  if (!calcId) throw new Error("giftbox begin: " + JSON.stringify(begin?.data?.orderEditBegin?.userErrors || begin));

  const add = await gql(
    `mutation($id:ID!,$variantId:ID!,$qty:Int!){
       orderEditAddVariant(id:$id,variantId:$variantId,quantity:$qty,allowDuplicates:false){
         calculatedOrder{ id } userErrors{ message } } }`,
    { id: calcId, variantId: GIFT_BOX_VARIANT_ID, qty: 1 }
  );
  const addErr = add?.data?.orderEditAddVariant?.userErrors || [];
  if (addErr.length) throw new Error("giftbox add: " + JSON.stringify(addErr));

  // Never notify: the total does not move, so an edit email would only confuse.
  const commit = await gql(
    `mutation($id:ID!){ orderEditCommit(id:$id,notifyCustomer:false,staffNote:"Complimentary gift box added automatically"){ order{ id } userErrors{ message } } }`,
    { id: calcId }
  );
  if (!commit?.data?.orderEditCommit?.order?.id) throw new Error("giftbox commit: " + JSON.stringify(commit?.data?.orderEditCommit?.userErrors || commit));

  await gql(`mutation($id:ID!,$tags:[String!]!){ tagsAdd(id:$id,tags:$tags){ userErrors{ message } } }`, { id: gid, tags: [GIFT_BOX_TAG] });
  return { added: true, variantId: GIFT_BOX_VARIANT_ID };
}

/* ------------------------------------------------------------------ gift vouchers
 * Every purchase earns a voucher, with no condition on the order that earned it.
 * What the voucher is WORTH is decided by the order it is SPENT on: under the
 * threshold it is the lower percentage, at or over it the higher one.
 *
 * A Shopify discount code carries one fixed percentage, so that ladder cannot live
 * on a single code. Each reward is therefore issued as one code per rung, both
 * locked to the customer and single-use: a 10% code with no minimum, and a 20% code
 * that needs a 2,500 subtotal. They share a group id carried in the code itself
 * (ELX-GIFT-<group>-<percent>), and the moment one is redeemed the rest of its group
 * is deactivated, so a purchase still earns exactly one reward.
 *
 * cfg.tiers is that ladder. overAmount is the subtotal the rung needs on the NEXT
 * order, 0 meaning no minimum, and it becomes the code's minimum purchase
 * requirement, which Shopify evaluates as greater-than-or-equal. That is what makes
 * "equal or more than 2,500" land on the 20% rung rather than just above it.
 *
 * Runs on orders/create, the same webhook the COD fee uses, so the codes exist
 * before fulfillment, which is when the email goes out. That also covers COD orders,
 * which are not "paid" until much later.
 */
/* A markdown promo rewrites real prices and leaves compareAtPrice behind, so those
 * products show a strike-through and gather in an automated offers collection. A voucher
 * must never reach them, or the customer takes a second cut off an already reduced price.
 * This collection is the mirror of the offers one: every product NOT currently marked down.
 * Looked up by handle once per process rather than hard-coded, so it survives a restore.
 * If it is missing we fall back to the old behaviour and say so, because refusing to mint
 * the voucher would break the promise made on the product page. */
const FULL_PRICE_HANDLE = "full-price-no-offers";
let fullPriceGid; // undefined = not looked up yet, null = not found

async function fullPriceCollection() {
  if (fullPriceGid !== undefined) return fullPriceGid;
  try {
    const j = await gql(
      `query($q:String!){ collections(first:1, query:$q){ nodes{ id handle } } }`,
      { q: `handle:${FULL_PRICE_HANDLE}` }
    );
    const n = j?.data?.collections?.nodes?.[0];
    fullPriceGid = n?.handle === FULL_PRICE_HANDLE ? n.id : null;
  } catch {
    fullPriceGid = null;
  }
  if (!fullPriceGid) {
    console.warn(`[voucher] collection "${FULL_PRICE_HANDLE}" not found - vouchers will apply to every product, including ones already marked down`);
  }
  return fullPriceGid;
}

/** What a voucher may be spent on: full-price products only. */
async function voucherItemsScope() {
  const gid = await fullPriceCollection();
  return gid ? { collections: { add: [gid] } } : { all: true };
}

const VOUCHER_TAG = "voucher-issued";
const VOUCHER_CANCELLED_TAG = "voucher-cancelled";
const VOUCHER_SPENT_TAG = "voucher-spent";
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

/** The redeem ladder: one code per rung, cheapest to reach first. */
function voucherLadder(cfg) {
  const seen = new Set();
  return (cfg.tiers || [])
    .map((t) => ({ percent: Number(t.percent) || 0, minRedeem: Math.max(0, Number(t.overAmount) || 0) }))
    .filter((t) => {
      if (t.percent <= 0) return false;
      const key = t.percent + "@" + t.minRedeem;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.minRedeem - b.minRedeem);
}

/** Deactivate one code by its string. Returns whether it actually went inactive. */
async function deactivateCode(code) {
  const found = await gql(`query($code:String!){ codeDiscountNodeByCode(code:$code){ id } }`, { code });
  const id = found?.data?.codeDiscountNodeByCode?.id;
  if (!id) return false;
  const deact = await gql(
    `mutation($id:ID!){ discountCodeDeactivate(id:$id){ codeDiscountNode{ id } userErrors{ field message } } }`,
    { id }
  );
  const errs = deact?.data?.discountCodeDeactivate?.userErrors || [];
  if (errs.length) { console.warn("voucher deactivate:", JSON.stringify(errs)); return false; }
  return true;
}

/** Every code in a stored voucher record, new ladder shape or the single-code one before it. */
function groupCodes(record, fallback) {
  if (record && Array.isArray(record.codes) && record.codes.length) {
    return record.codes.map((c) => c && c.code).filter(Boolean);
  }
  if (record && record.code) return [record.code];
  return fallback ? [fallback] : [];
}

async function issueVoucher(order) {
  const cfg = await voucherConfig();
  if (!cfg || !cfg.active) return { skipped: "voucher program inactive" };

  const customerId = order.customer && order.customer.id;
  if (!customerId) return { skipped: "no customer on order" };

  // No condition on the order that earns it. The ladder only decides what it is worth
  // when it is spent, so an empty ladder is the only thing that stops a voucher here.
  const ladder = voucherLadder(cfg);
  if (!ladder.length) return { skipped: "no voucher tiers configured" };

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
  // A floor the merchant can put under the whole programme, on top of each rung's own.
  const floor = Number(cfg.minRedeemSubtotal) || 0;
  const group = crypto.randomBytes(4).toString("hex").toUpperCase();
  const issuedFor = order.name || String(order.id);

  const issued = [];
  const itemsScope = await voucherItemsScope();
  for (const rung of ladder) {
    const minRedeem = Math.max(rung.minRedeem, floor);
    const code = `ELX-GIFT-${group}-${rung.percent}`;
    const input = {
      title: `Gift voucher ${rung.percent}% (${issuedFor})`,
      code,
      startsAt: now.toISOString(),
      endsAt: endsAt.toISOString(),
      usageLimit: 1,
      appliesOncePerCustomer: true,
      customerSelection: { customers: { add: [customerGid] } },
      customerGets: { value: { percentage: rung.percent / 100 }, items: itemsScope },
      combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
    };
    // greaterThanOrEqualToSubtotal, so 2,500 exactly earns the higher rung
    if (minRedeem > 0) input.minimumRequirement = { subtotal: { greaterThanOrEqualToSubtotal: String(minRedeem) } };

    const created = await gql(
      `mutation($d:DiscountCodeBasicInput!){ discountCodeBasicCreate(basicCodeDiscount:$d){ codeDiscountNode{ id } userErrors{ field message } } }`,
      { d: input }
    );
    const cErr = created?.data?.discountCodeBasicCreate?.userErrors || [];
    if (cErr.length) {
      // Roll back the rungs already created, or the customer is left holding half a ladder.
      for (const v of issued) await deactivateCode(v.code).catch(() => {});
      throw new Error("voucher create: " + JSON.stringify(cErr));
    }
    issued.push({ code, percent: rung.percent, minRedeem, group, expiresAt: endsAt.toISOString(), status: "active", issuedFor });
  }

  const base = issued[0];
  const upgrade = issued.length > 1 ? issued[issued.length - 1] : null;
  const percent = base.percent;
  const code = base.code;
  const minRedeem = base.minRedeem;
  const voucher = { group, expiresAt: endsAt.toISOString(), status: "active", issuedFor, codes: issued.map((v) => ({ code: v.code, percent: v.percent, minRedeem: v.minRedeem })) };

  // Append to the customer's voucher list (read-modify-write) + stamp the order.
  const existing = await gql(`query($id:ID!){ customer(id:$id){ metafield(namespace:"custom", key:"gift_vouchers"){ value } } }`, { id: customerGid });
  let list = [];
  try { const v = existing?.data?.customer?.metafield?.value; list = v ? JSON.parse(v) : []; } catch { list = []; }
  list.unshift(...issued);

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
  // The existing four keys still describe the base rung, so an email written against
  // them keeps working untouched. The upgrade_* keys are the second rung, for the line
  // that tells the customer what the same reward is worth on a larger order.
  const attrs = keep.concat([
    { key: "gift_voucher_code", value: code },
    { key: "gift_voucher_percent", value: String(percent) },
    { key: "gift_voucher_expiry", value: expiryStr },
    { key: "gift_voucher_minredeem", value: String(minRedeem) },
  ]).concat(upgrade ? [
    { key: "gift_voucher_upgrade_code", value: upgrade.code },
    { key: "gift_voucher_upgrade_percent", value: String(upgrade.percent) },
    { key: "gift_voucher_upgrade_min", value: String(upgrade.minRedeem) },
  ] : []);
  const oup = await gql(
    `mutation($id:ID!,$a:[AttributeInput!]!){ orderUpdate(input:{id:$id, customAttributes:$a}){ userErrors{ field message } } }`,
    { id: gid, a: attrs }
  );
  const oErr = oup?.data?.orderUpdate?.userErrors || [];
  if (oErr.length) throw new Error("voucher order attributes: " + JSON.stringify(oErr));

  await gql(`mutation($id:ID!,$tags:[String!]!){ tagsAdd(id:$id,tags:$tags){ userErrors{ message } } }`, { id: gid, tags: [VOUCHER_TAG] });
  return { issued: true, group, codes: issued.map((v) => ({ code: v.code, percent: v.percent, minRedeem: v.minRedeem })), order: issuedFor };
}

/* One purchase earns one reward, but the reward is several codes, so the moment the
 * customer spends one the rest of its group has to stop working, or a single purchase
 * would pay out twice. The group id travels inside the code, so a redemption is traced
 * back without a lookup table. Idempotent via a `voucher-spent` tag. */
async function retireVoucherGroup(order) {
  const used = (order.discount_codes || [])
    .map((d) => String((d && d.code) || "").trim().toUpperCase())
    .filter(Boolean);
  const groups = [...new Set(
    used.map((c) => (c.match(/^ELX-GIFT-([0-9A-Z]+)-\d+$/) || [])[1]).filter(Boolean)
  )];
  if (!groups.length) return { skipped: "no laddered gift voucher used" };

  const gid = `gid://shopify/Order/${order.id}`;
  const cur = await gql(`query($id:ID!){ order(id:$id){ tags customer{ id } } }`, { id: gid });
  const o = cur?.data?.order;
  if (!o) return { skipped: "order not found" };
  if ((o.tags || []).includes(VOUCHER_SPENT_TAG)) return { skipped: "group already retired" };

  const customerGid = o.customer && o.customer.id;
  if (!customerGid) return { skipped: "no customer on order" };

  const ex = await gql(`query($id:ID!){ customer(id:$id){ metafield(namespace:"custom",key:"gift_vouchers"){ value } } }`, { id: customerGid });
  let list = [];
  try { const v = ex?.data?.customer?.metafield?.value; list = v ? JSON.parse(v) : []; } catch { list = []; }

  const retired = [];
  for (const v of list) {
    if (!v || !v.code || !groups.includes(v.group)) continue;
    if (used.includes(String(v.code).toUpperCase())) { v.status = "redeemed"; continue; }
    if (v.status !== "active") continue;
    if (await deactivateCode(v.code)) retired.push(v.code);
    v.status = "superseded";
  }

  await gql(
    `mutation($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ userErrors{ message } } }`,
    { m: [{ ownerId: customerGid, namespace: "custom", key: "gift_vouchers", type: "json", value: JSON.stringify(list) }] }
  );
  await gql(`mutation($id:ID!,$tags:[String!]!){ tagsAdd(id:$id,tags:$tags){ userErrors{ message } } }`, { id: gid, tags: [VOUCHER_SPENT_TAG] });
  return { spent: used.filter((c) => /^ELX-GIFT-/.test(c)), retired };
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

  let record = null;
  try { record = o.metafield?.value ? JSON.parse(o.metafield.value) : null; } catch { record = null; }
  const codeAttr = (o.customAttributes || []).find((a) => a && a.key === "gift_voucher_code");
  // Every rung of the reward, so a cancelled order cannot leave the 20% code alive.
  const codes = groupCodes(record, codeAttr && codeAttr.value);
  if (!codes.length) return { skipped: "voucher tag present but no code found" };

  const deactivatedCodes = [];
  for (const c of codes) if (await deactivateCode(c)) deactivatedCodes.push(c);

  // Flip the stored status to "cancelled" on the order + the customer's list.
  try {
    const mfs = [];
    const ov = record;
    if (ov) { ov.status = "cancelled"; mfs.push({ ownerId: orderGid, namespace: "custom", key: "gift_voucher", type: "json", value: JSON.stringify(ov) }); }
    const customerGid = o.customer && o.customer.id;
    if (customerGid) {
      const ex = await gql(`query($id:ID!){ customer(id:$id){ metafield(namespace:"custom",key:"gift_vouchers"){ value } } }`, { id: customerGid });
      let list = [];
      try { const lv = ex?.data?.customer?.metafield?.value; list = lv ? JSON.parse(lv) : []; } catch { list = []; }
      list = list.map((x) => (x && codes.includes(x.code) ? { ...x, status: "cancelled" } : x));
      mfs.push({ ownerId: customerGid, namespace: "custom", key: "gift_vouchers", type: "json", value: JSON.stringify(list) });
    }
    if (mfs.length) await gql(`mutation($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ userErrors{ message } } }`, { m: mfs });
  } catch (e) { console.warn("voucher status update:", e.message); }

  await gql(`mutation($id:ID!,$tags:[String!]!){ tagsAdd(id:$id,tags:$tags){ userErrors{ message } } }`, { id: orderGid, tags: [VOUCHER_CANCELLED_TAG] });
  return { cancelled: true, codes, deactivated: deactivatedCodes, reason };
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
        const giftBox = await addGiftBox(body);
        // Retire first: this order may both SPEND an old reward and EARN a new one, and
        // the new group must not be in the list while the old one is being swept.
        const spent = await retireVoucherGroup(body);
        const voucher = await issueVoucher(body);
        result = { cod, giftBox, spent, voucher };
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
