# COD Fee app

Automatically adds the **Cash on Delivery fee** to COD orders (after checkout,
so the courier collects it *with* the product) and never touches card orders.
Plain Node, no dependencies — runs on any host.

This is **Phase 1** (single store). It's the foundation of a future multi-store,
sellable Shopify app (see Roadmap).

## How it works
Shopify `orders/create` webhook → this service → if the order's payment gateway
is Cash on Delivery, it edits the order to add a "Cash on Delivery fee" line
(AED 10) and tags it `cod-fee-added` (idempotent). Card orders are ignored.

## Prerequisites
- A **Dev-Dashboard app** with **`read_orders` + `write_orders`** granted (you're
  reusing the *Elixir Promotions* app: add the scopes to its `shopify.app.toml`,
  `shopify app deploy`, approve). Copy its **Client ID + Secret**.
- A host that can run a Node process on a public HTTPS URL.

## Deploy on your Coolify VPS (recommended — you already run one)
1. Push this folder to a Git repo (or point Coolify at it).
2. Coolify → **New Resource → Application** → your Git repo → build pack
   **Dockerfile** (the Dockerfile is here).
3. Set **Environment variables** (from `.env.example`), especially:
   `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOP`, `COD_FEE_AMOUNT`.
4. Give it a **domain** (e.g. `cod.yourdomain.com`) and set the port to **3000**.
5. **Deploy.** Visit the URL — it should say "COD Fee service is running."

### Alternative hosts (all work, no code change)
Render / Railway / Fly.io (free tiers, Git deploy), or `node server.js` on any VPS
behind a reverse proxy. It's a standard Node HTTP server on `PORT`.

## Register the webhook (once, after deploy)
```bash
export ELX_CLIENT_ID="…"        # Dev-Dashboard app Client ID
export ELX_CLIENT_SECRET="…"    # Secret
node register-webhook.mjs "https://cod.yourdomain.com"
```

## Test
Place a COD order → the service adds AED 10 + tags `cod-fee-added`. Place a card
order → untouched. Check the service logs (Coolify → Logs) to see each run.

## Config
All settings are env vars (`.env.example`): fee amount/currency/title, whether
it's taxable, and which payment-method name counts as COD.

## Caveat
Shopify emails the order confirmation a moment before the edit lands, so that
email shows the pre-fee total; the order and the courier collect the correct
amount. Phase 2's COD order-form removes this.

## Roadmap → sellable multi-store app (Phase 2+)
- **Multi-tenant install:** OAuth so any store adds it (not client-credentials).
- **Database:** per-shop settings + access tokens.
- **Settings UI:** fee amount/type, conditions, which method = COD (embedded admin app).
- **Shopify billing:** charge merchants (free/paid tiers).
- **OTP phone verification:** the feature COD sellers pay for (cuts fake orders).
- **COD order form:** create the order with the fee at checkout time (correct email).
- **App Store listing** + review + support. Differentiator: OTP + fees + Arabic/MENA focus.
