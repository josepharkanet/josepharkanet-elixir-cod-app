// Add the COD fee to the latest order directly with a FRESH token (bypasses the
// deployed app's cache) — proves the write_order_edits grant is live.
const SHOP = process.env.ELX_SHOP || "nkqtxa-gi.myshopify.com";
const VERSION = process.env.ELX_API_VERSION || "2026-01";
const CLIENT_ID = process.env.ELX_CLIENT_ID;
const CLIENT_SECRET = process.env.ELX_CLIENT_SECRET;
const AMOUNT = "10.00", CURRENCY = "AED", TITLE = "Cash on Delivery fee", TAG = "cod-fee-added";

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
const oq = await gql(`{ orders(first:1,sortKey:CREATED_AT,reverse:true){ edges{ node{ id name paymentGatewayNames tags } } } }`);
const o = oq.data.orders.edges[0].node;
console.log("Order:", o.name, JSON.stringify(o.paymentGatewayNames), "tags:", JSON.stringify(o.tags));
if (o.tags.includes(TAG)) { console.log("→ already has cod-fee-added, nothing to do."); process.exit(0); }

const begin = await gql(`mutation($id:ID!){ orderEditBegin(id:$id){ calculatedOrder{ id } userErrors{ message } } }`, { id: o.id });
const calcId = begin.data?.orderEditBegin?.calculatedOrder?.id;
if (!calcId) { console.error("✗ begin:", JSON.stringify(begin.data?.orderEditBegin?.userErrors || begin.errors || begin)); process.exit(1); }
console.log("✓ orderEditBegin");

const add = await gql(`mutation($id:ID!,$t:String!,$q:Int!,$p:MoneyInput!){ orderEditAddCustomItem(id:$id,title:$t,quantity:$q,price:$p,requiresShipping:false,taxable:false){ calculatedLineItem{ id } userErrors{ message } } }`,
  { id: calcId, t: TITLE, q: 1, p: { amount: AMOUNT, currencyCode: CURRENCY } });
if (add.data?.orderEditAddCustomItem?.userErrors?.length) { console.error("✗ add:", JSON.stringify(add.data.orderEditAddCustomItem.userErrors)); process.exit(1); }
console.log("✓ orderEditAddCustomItem (AED 10)");

const commit = await gql(`mutation($id:ID!){ orderEditCommit(id:$id,notifyCustomer:false,staffNote:"COD handling fee added automatically"){ order{ id } userErrors{ message } } }`, { id: calcId });
if (!commit.data?.orderEditCommit?.order?.id) { console.error("✗ commit:", JSON.stringify(commit.data?.orderEditCommit?.userErrors || commit)); process.exit(1); }
console.log("✓ orderEditCommit");

await gql(`mutation($id:ID!,$tags:[String!]!){ tagsAdd(id:$id,tags:$tags){ userErrors{ message } } }`, { id: o.id, tags: [TAG] });
console.log(`\n✅ Fee added to ${o.name} + tagged '${TAG}'. Re-checking…`);

const check = await gql(`{ orders(first:1,sortKey:CREATED_AT,reverse:true){ edges{ node{ name totalPriceSet{ shopMoney{ amount currencyCode } } tags lineItems(first:20){ edges{ node{ title } } } } } } }`);
const c = check.data.orders.edges[0].node;
console.log(`   ${c.name}: ${c.totalPriceSet.shopMoney.amount} ${c.totalPriceSet.shopMoney.currencyCode}  tags=${JSON.stringify(c.tags)}`);
console.log(`   items: ${c.lineItems.edges.map(x => x.node.title).join(" | ")}`);
