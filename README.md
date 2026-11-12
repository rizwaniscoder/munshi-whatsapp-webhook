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

## Multi-tenant ledgers

Each allowed WhatsApp number gets its own Google Sheet, copied from the template ledger. A `Farmers` tab on the master sheet (`SHEET_ID`) maps phone number, sheet id, name, farm name, onboarding state, and `allowed`. The existing test number `923155506704` is already registered to the current ledger.

Unknown numbers are told the service is invite-only. To add a farmer, put their number in the `Farmers` tab with `allowed` = TRUE, or set `ALLOWED_NUMBERS` on Render (comma-separated, no plus sign). A new allowed number is walked through onboarding: name and farm, animals (cows and buffaloes), customers (or `skip`), then an optional saving committee (or `skip`). Every write is confirmed with Haan/Nahi first.

New farmer sheets are copied by Apps Script (`DriveApp.makeCopy`) and data rows are cleared. Until the updated `apps-script/Code.gs` is deployed as a new version of the existing web app, the webhook falls back to the previous single-ledger behaviour so current records keep working. Do not change `SHEETS_SECRET` or `SHEETS_WEBHOOK_URL`.

## Receipts, edits, and photos

Farmers can text "Aslam ki parchi bhejo" to get a PNG receipt to forward. They can also add, rename, or remove a cow, add a customer, change a rate, correct a previous entry, or delete the last saved row. Photos of khata pages, fodder bills, or receipts are read the same way as text and voice notes; Munshi reads them back and waits for Haan/Nahi before writing.

## Committee and daily expenses

A saving committee (Roman Urdu: committee / kameti / kumitee) is stored on `Committees` (name, amount, frequency, optional start date and organizer) and `Committee_Log` (paid, not paid, or partial for each day or period). `Committee_Status` is derived when the ledger refreshes. Farmers can ask what they paid this month, what is still due, and whether today is paid. If today is unpaid, a normal reply can include one short footer line. Munshi does not send a separate WhatsApp reminder for it.

`Expenses` accepts any daily cost, including mazdoori, tankhwah, bijli, fuel, dawai, kiraya, marammat, and free-form notes. Fodder purchases still go to `Fodder`, not `Expenses`. An expense with no amount is not written. Several costs in one message are confirmed together, with the amount, category, and date.

Examples: `aaj committee di`, `committee nahi di`, `kameti 200 di`, `is mahine committee kitni di`, `aaj 500 mazdoori aur 2000 tankhwah`, `aaj kharcha kitna hua`, `is hafte mazdoori kitni di`.

## Reply language (`REPLY_SCRIPT`)

WhatsApp replies can be Roman Urdu, Urdu script, or both. Set the Render env var `REPLY_SCRIPT`:

- `both` (default): Urdu script first, then a blank line, then Roman Urdu
- `roman`: Roman Urdu only
- `urdu`: Urdu script only
- `auto`: match the script of the farmer's last text message

Numbers, names, Rs amounts, and dates stay the same in both versions. Button titles stay short (`ہاں Haan`, `نہیں Nahi`, `ترمیم Edit`).
