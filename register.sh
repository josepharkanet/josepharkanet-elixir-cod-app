#!/bin/zsh
# Register the COD orders/create webhook using the Elixir Promotions app.
#
# HOW TO USE:
#   1. Go to dev.shopify.com -> Elixir Promotions -> Client credentials
#      -> reveal & COPY the Client secret (so it's on your clipboard).
#   2. In this folder run:   zsh register.sh
#
# The script pulls the secret from your clipboard (pbpaste) — you never paste it
# into the terminal, so there's no way to paste the wrong thing.

cd "$(dirname "$0")" || exit 1

SECRET="$(pbpaste | tr -d '[:space:]')"

if [ -z "$SECRET" ]; then
  echo "✗ Your clipboard is empty. Copy the Elixir Promotions Client secret first, then re-run:  zsh register.sh"
  exit 1
fi

# Sanity guard: a real client secret is a short-ish token, not a pasted command.
if [ "${#SECRET}" -gt 120 ] || printf '%s' "$SECRET" | grep -q "register-webhook\|node\|http"; then
  echo "✗ Clipboard doesn't look like a secret (${#SECRET} chars). Copy JUST the Client secret and re-run:  zsh register.sh"
  exit 1
fi

echo "→ Using secret from clipboard (${#SECRET} chars). Registering webhook…"
ELX_CLIENT_ID=e14d957eaf6d42099a5ad9bf6919f1e1 \
ELX_CLIENT_SECRET="$SECRET" \
node register-webhook.mjs "https://cod.elixirbeauty.com"
