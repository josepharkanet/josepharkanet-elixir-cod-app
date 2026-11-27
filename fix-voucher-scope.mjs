// One-off: re-scope gift vouchers that were minted before the fix, so they stop
// discounting products a markdown promo has already cut.
//
// Every voucher created before 28 Nov 2026 carries items: { all: true }, so a 10% or
// 20% code takes a second cut off an Offers product. New vouchers are scoped by
// server.js; this repairs the ones already in customers' hands.
//
// The admin shows these as "Amount off order" with no scope field, but underneath they
// are DiscountCodeBasic, so their customerGets.items CAN be rewritten through the API.
//
// Dry run by default. Pass --apply to actually write.
//
//   ELX_CLIENT_ID=... ELX_CLIENT_SECRET=... node fix-voucher-scope.mjs
//   ELX_CLIENT_ID=... ELX_CLIENT_SECRET=... node fix-voucher-scope.mjs --apply

const SHOP = process.env.ELX_SHOP || "nkqtxa-gi.myshopify.com";
const VERSION = process.env.ELX_API_VERSION || "2026-01";
const CLIENT_ID = process.env.ELX_CLIENT_ID;
const CLIENT_SECRET = process.env.ELX_CLIENT_SECRET;
const FULL_PRICE_HANDLE = "full-price-no-offers";
const APPLY = process.argv.includes("--apply");

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set ELX_CLIENT_ID and ELX_CLIENT_SECRET.");
  process.exit(1);
}

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
const gql = async (query, variables) => {
  const r = await fetch(`https://${SHOP}/admin/api/${VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
};

// 1. the collection every voucher should be limited to
const col = await gql(
  `query($q:String!){ collections(first:1, query:$q){ nodes{ id handle title productsCount{ count } } } }`,
  { q: `handle:${FULL_PRICE_HANDLE}` }
);
const collection = col?.data?.collections?.nodes?.[0];
if (!collection || collection.handle !== FULL_PRICE_HANDLE) {
  console.error(`Collection "${FULL_PRICE_HANDLE}" not found. Nothing changed.`);
  process.exit(1);
}
console.log(`Scope: ${collection.title} (${collection.productsCount?.count ?? "?"} products)\n`);

// 2. every gift voucher the app has minted
const LIST = `
query($after:String){
  codeDiscountNodes(first:50, after:$after, query:"title:'Gift voucher'"){
    pageInfo{ hasNextPage endCursor }
    nodes{
      id
      codeDiscount{
        __typename
        ... on DiscountCodeBasic {
          title
          status
          codes(first:1){ nodes{ code } }
          customerGets{
            value{ __typename ... on DiscountPercentage { percentage } }
            items{ __typename }
          }
        }
      }
    }
  }
}`;

const vouchers = [];
let after = null;
for (;;) {
  const j = await gql(LIST, { after });
  const conn = j?.data?.codeDiscountNodes;
  if (!conn) { console.error("list failed:", JSON.stringify(j).slice(0, 400)); process.exit(1); }
  for (const n of conn.nodes) {
    const d = n.codeDiscount;
    if (d?.__typename !== "DiscountCodeBasic") continue;
    vouchers.push({
      id: n.id,
      title: d.title,
      status: d.status,
      code: d.codes?.nodes?.[0]?.code ?? "",
      percentage: d.customerGets?.value?.percentage ?? null,
      itemsType: d.customerGets?.items?.__typename ?? "",
    });
  }
  if (!conn.pageInfo.hasNextPage) break;
  after = conn.pageInfo.endCursor;
}

const needFix = vouchers.filter((v) => v.itemsType === "AllDiscountItems" && v.percentage != null);
const already = vouchers.filter((v) => v.itemsType !== "AllDiscountItems");
const noPct = vouchers.filter((v) => v.percentage == null);

console.log(`found      ${vouchers.length} gift vouchers`);
console.log(`to re-scope ${needFix.length}`);
console.log(`already scoped ${already.length}`);
if (noPct.length) console.log(`skipped (not a percentage discount) ${noPct.length}`);
console.log("");

if (!needFix.length) { console.log("Nothing to do."); process.exit(0); }

if (!APPLY) {
  for (const v of needFix) {
    console.log(`  would re-scope  ${v.code.padEnd(26)} ${String(Math.round(v.percentage * 100)).padStart(3)}%  ${v.status.padEnd(9)} ${v.title}`);
  }
  console.log(`\nDry run. Re-run with --apply to write these ${needFix.length} changes.`);
  process.exit(0);
}

// 3. rewrite the scope, resending the percentage so the value is not lost
const UPDATE = `
mutation($id:ID!,$d:DiscountCodeBasicInput!){
  discountCodeBasicUpdate(id:$id, basicCodeDiscount:$d){ userErrors{ field message } }
}`;

let ok = 0;
const failed = [];
for (const v of needFix) {
  const res = await gql(UPDATE, {
    id: v.id,
    d: {
      customerGets: {
        value: { percentage: v.percentage },
        items: { collections: { add: [collection.id] } },
      },
    },
  });
  const errs = res?.data?.discountCodeBasicUpdate?.userErrors || res?.errors || [];
  if (errs.length) {
    failed.push({ code: v.code, errs });
    console.log(`  FAILED  ${v.code}  ${JSON.stringify(errs).slice(0, 180)}`);
  } else {
    ok++;
    console.log(`  re-scoped ${v.code}`);
  }
}

console.log(`\nre-scoped ${ok} of ${needFix.length}`);
if (failed.length) { console.log(`${failed.length} failed - rerun to retry, it skips ones already done.`); process.exit(1); }
