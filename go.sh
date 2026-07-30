#!/bin/zsh
# Fully-automated COD webhook registration — no copy/paste.
# Pulls the Elixir Promotions app secret from the Shopify CLI, then registers the
# orders/create webhook to the live COD service.
#
#   run:  zsh ~/Desktop/elixir-cod-app/go.sh

COD_DIR="$HOME/Desktop/elixir-cod-app"
PROMO_DIR="$HOME/Desktop/elixir-promotions"
CALLBACK="https://cod.elixirbeauty.com"

echo "→ Reading the Elixir Promotions secret from the Shopify CLI…"
SECRET="$(cd "$PROMO_DIR" 2>/dev/null && shopify app env show 2>/dev/null \
          | grep 'SHOPIFY_API_SECRET' | sed 's/.*SHOPIFY_API_SECRET=//' | tr -d ' \r\n')"

if [ -z "$SECRET" ]; then
  echo "✗ Couldn't read SHOPIFY_API_SECRET via the CLI."
  echo "  Try manually:  cd $PROMO_DIR && shopify app env show"
  exit 1
fi
echo "  ✓ got secret (${#SECRET} chars, starts ${SECRET:0:4}…)"

echo "→ Registering orders/create webhook → $CALLBACK …"
cd "$COD_DIR" || exit 1
ELX_CLIENT_ID=e14d957eaf6d42099a5ad9bf6919f1e1 \
ELX_CLIENT_SECRET="$SECRET" \
node register-webhook.mjs "$CALLBACK"
