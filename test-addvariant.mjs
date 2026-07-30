// Verify the draft COD-fee variant can be added via order-editing. Begins an edit
// on the latest order and tries orderEditAddVariant, but does NOT commit — safe.
const SHOP = process.env.ELX_SHOP || "nkqtxa-gi.myshopify.com";
const VERSION = process.env.ELX_API_VERSION || "2026-01";
const CLIENT_ID = process.env.ELX_CLIENT_ID;
const CLIENT_SECRET = process.env.ELX_CLIENT_SECRET;
const VARIANT = process.env.COD_FEE_VARIANT_ID;

async function getToken() {
  const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "client_credentials" }),
  });
  return (await r.json()).access_token;
}
const token = await getToken();
async function gql(query, variables) {
  const r = await fetch(`https://${SHOP}/admin/api/${VERSION}/graphql.json`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
}
const o = (await gql(`{ orders(first:1,sortKey:CREATED_AT,reverse:true){ edges{ node{ id name } } } }`)).data.orders.edges[0].node;
const begin = await gql(`mutation($id:ID!){ orderEditBegin(id:$id){ calculatedOrder{ id } userErrors{ message } } }`, { id: o.id });
const calcId = begin.data?.orderEditBegin?.calculatedOrder?.id;
if (!calcId) { console.error("begin failed:", JSON.stringify(begin)); process.exit(1); }
const add = await gql(
  `mutation($id:ID!,$v:ID!,$q:Int!){ orderEditAddVariant(id:$id,variantId:$v,quantity:$q,allowDuplicates:true){ calculatedLineItem{ id title } userErrors{ message } } }`,
  { id: calcId, v: VARIANT, q: 1 }
);
const errs = add.data?.orderEditAddVariant?.userErrors || add.errors;
if (errs && errs.length) { console.error("❌ addVariant FAILED (draft not addable?):", JSON.stringify(errs)); process.exit(1); }
console.log("✅ addVariant OK on", o.name, "→", JSON.stringify(add.data.orderEditAddVariant.calculatedLineItem), "\n(not committed — order unchanged)");
