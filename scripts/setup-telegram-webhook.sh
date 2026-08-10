#!/usr/bin/env bash
# Registers the Telegram webhook + bot command menu for this deployment.
# Required env: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, APP_BASE_URL
set -euo pipefail

: "${TELEGRAM_BOT_TOKEN:?Set TELEGRAM_BOT_TOKEN}"
: "${TELEGRAM_WEBHOOK_SECRET:?Set TELEGRAM_WEBHOOK_SECRET}"
: "${APP_BASE_URL:?Set APP_BASE_URL (e.g. https://job-maxxing.<account>.workers.dev)}"

curl -sf -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"${APP_BASE_URL%/}/telegram/webhook\",
    \"secret_token\": \"${TELEGRAM_WEBHOOK_SECRET}\",
    \"allowed_updates\": [\"callback_query\", \"message\"],
    \"drop_pending_updates\": true
  }"

echo
echo "Webhook registered for ${APP_BASE_URL%/}/telegram/webhook"

curl -sf -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{
    "commands": [
      {"command": "shortlists", "description": "Show shortlisted jobs"},
      {"command": "skipped", "description": "Show skipped jobs"},
      {"command": "help", "description": "How to use the bot"}
    ]
  }'

echo
echo "Bot command menu registered (/shortlists, /skipped, /help)"
