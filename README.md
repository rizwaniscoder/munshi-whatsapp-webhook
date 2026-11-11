# Munshi WhatsApp Webhook

WhatsApp bookkeeping assistant for Munshi, operated by Nodeable AI LLC. Farmers send text or voice notes. Munshi parses them with Gemini, confirms before saving, and writes records to the dairy ledger Google Sheet.

## Endpoints

- `GET /` - health check, returns `ok`
- `GET /webhook` - Meta webhook verification (`hub.mode`, `hub.verify_token`, `hub.challenge`)
- `POST /webhook` - accepts the event, returns 200 immediately, then processes asynchronously
- `GET /privacy` - Privacy Policy
- `GET /terms` - Terms of Service
- `GET /data-deletion` - data deletion instructions

## Environment

Set these on the host. Do not commit secrets.

- `VERIFY_TOKEN` - Meta webhook verify token
- `WHATSAPP_TOKEN` - WhatsApp Cloud API token
- `PHONE_NUMBER_ID` - WhatsApp phone number ID
- `WHATSAPP_GRAPH_VERSION` - default `v25.0`
- `GEMINI_API_KEY` - Gemini API key
- `GEMINI_MODEL` - default `gemini-3.5-flash-lite`
- `ALLOWED_NUMBERS` - comma-separated allowlist; empty means allow all (test phase)
- `SHEETS_WEBHOOK_URL` - deployed Apps Script web app URL
- `SHEETS_SECRET` - shared secret for the Apps Script gateway
- `TZ` - `Asia/Karachi`

Until `SHEETS_WEBHOOK_URL` is set, pending records are held in memory only and will not survive a free-tier sleep. See `apps-script/README.md` for the one-time Sheet deploy.

A GitHub Actions workflow that pings `GET /` every 10 minutes is in `docs/keepalive-workflow.yml`. Add it in the GitHub UI as `.github/workflows/keepalive.yml` (the repo token used here cannot create workflow files). Scheduled runs can be delayed by GitHub.
