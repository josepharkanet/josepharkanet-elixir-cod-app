// Create a hidden "Cash on Delivery Fee" product so the fee line shows a real
// icon (once you add one) instead of the gray placeholder. Draft = not buyable /
// not visible on the storefront, but still addable to orders via order-editing.
const SHOP = process.env.ELX_SHOP || "nkqtxa-gi.myshopify.com";
const VERSION = process.env.ELX_API_VERSION || "2026-01";
const CLIENT_ID = process.env.ELX_CLIENT_ID;
const CLIENT_SECRET = process.env.ELX_CLIENT_SECRET;
const PRICE = process.env.COD_FEE_AMOUNT || "10.00";

async function getToken() {
  const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "client_credentials" }),
  });
  const j = await r.json();
  if (!j.access_token) { console.error("token failed:", JSON.stringify(j)); process.exit(1); }
  return j.access_token;
}
const token = await getToken();
async function gql(query, variables) {
  const r = await fetch(`https://${SHOP}/admin/api/${VERSION}/graphql.json`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
}

// 1) create the product (draft)
const c = await gql(
  `mutation($product: ProductCreateInput!){ productCreate(product: $product){ product{ id handle variants(first:1){ edges{ node{ id } } } } userErrors{ field message } } }`,
  { product: { title: "Cash on Delivery Fee", status: "DRAFT", tags: ["cod-fee-internal", "do-not-publish"] } }
);
if (c.errors) { console.error("productCreate errors:", JSON.stringify(c.errors, null, 2)); process.exit(1); }
const ue1 = c.data?.productCreate?.userErrors || [];
if (ue1.length) { console.error("productCreate userErrors:", JSON.stringify(ue1)); process.exit(1); }
const product = c.data.productCreate.product;
const variantId = product.variants.edges[0].node.id;
console.log("✓ product:", product.id, "handle:", product.handle);
console.log("  default variant:", variantId);

// 2) set price, no tax, no inventory tracking, no shipping
const u = await gql(
  `mutation($pid: ID!, $variants: [ProductVariantsBulkInput!]!){ productVariantsBulkUpdate(productId: $pid, variants: $variants){ productVariants{ id price taxable inventoryItem{ tracked requiresShipping } } userErrors{ field message } } }`,
  { pid: product.id, variants: [{ id: variantId, price: PRICE, taxable: false, inventoryItem: { tracked: false, requiresShipping: false } }] }
);
if (u.errors) { console.error("variantUpdate errors:", JSON.stringify(u.errors, null, 2)); process.exit(1); }
const ue2 = u.data?.productVariantsBulkUpdate?.userErrors || [];
if (ue2.length) { console.error("variantUpdate userErrors:", JSON.stringify(ue2)); process.exit(1); }
console.log("✓ variant configured:", JSON.stringify(u.data.productVariantsBulkUpdate.productVariants[0]));

console.log("\n================  ADD THIS TO COOLIFY  ================");
console.log("COD_FEE_VARIANT_ID=" + variantId);
console.log("======================================================");
console.log("Product handle (add an icon image to it in admin):", product.handle);
