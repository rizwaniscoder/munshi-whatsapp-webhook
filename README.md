# Munshi WhatsApp Webhook

Bookkeeping assistant for Munshi, operated by Nodeable AI LLC. Small dairy farmers open a personal link on Android Chrome, speak or tap, confirm, and the rows land in Supabase Postgres. WhatsApp text and voice still work when Meta delivery is available, but the web app is the primary channel. Google Sheets remains the fallback until `SUPABASE_URL` is set.

## Endpoints

- `GET /` - health check, returns `ok`
- `POST /cron/reminders` - authenticated missing-data check. Body `{"slot":"morning"}` or `{"slot":"evening"}`. Requires `Authorization: Bearer $CRON_SECRET`. Sends nothing when the ledger is complete, the farmer is outside the WhatsApp 24-hour window, or that slot was already sent today.
- `GET /webhook` - Meta webhook verification (`hub.mode`, `hub.verify_token`, `hub.challenge`)
- `POST /webhook` - accepts the event, returns 200 immediately, then processes asynchronously
- `GET /privacy` - Privacy Policy
- `GET /terms` - Terms of Service
- `GET /data-deletion` - data deletion instructions
- `GET /r/<token>` - personal mobile voice recorder for one allowed farmer. Replies stay on the page. Unknown tokens get a generic failure.
- `POST /admin/recorder-links` - list or mint those links. Same `Authorization: Bearer $CRON_SECRET` as the reminder job. No new environment variable.

## Environment

Set these on the host. Do not commit secrets.

- `VERIFY_TOKEN` - Meta webhook verify token
- `WHATSAPP_TOKEN` - WhatsApp Cloud API token
- `PHONE_NUMBER_ID` - WhatsApp phone number ID
- `WHATSAPP_GRAPH_VERSION` - default `v25.0`
- `GEMINI_API_KEY` - Gemini API key
- `GEMINI_MODEL` - default `gemini-3.5-flash-lite`
- `REPLY_SCRIPT` - set `roman` so farmer-facing text stays Roman Urdu
- `ALLOWED_NUMBERS` - comma-separated allowlist; empty means allow all (test phase)
- `SUPABASE_URL` - Supabase project URL. When this is set, Postgres replaces Sheets for every read and write.
- `SUPABASE_SERVICE_ROLE_KEY` - service-role key. Required when `SUPABASE_URL` is set. Server only. Never put it in the browser, a log, or git.
- `SHEETS_WEBHOOK_URL` - deployed Apps Script web app URL. Used when `SUPABASE_URL` is unset, and by the one-shot sheet import. `SHEETS_URL` is an alias.
- `SHEETS_SECRET` - shared secret for the Apps Script gateway
- `IMPORT_FROM_SHEETS_ON_BOOT` - set to `1` on Render to copy Sheets into Postgres once after the process starts listening. Leave it unset after that copy has succeeded.
- `CRON_SECRET` - shared secret for `POST /cron/reminders` and `POST /admin/recorder-links`. Set the same value as the GitHub Actions secret `CRON_SECRET`. Do not commit it.
- `TZ` - `Asia/Karachi`

Until `SUPABASE_URL` or `SHEETS_WEBHOOK_URL` is set, pending records are held in memory only and will not survive a free-tier sleep. See below for Supabase, and `apps-script/README.md` for the Sheet fallback.

A GitHub Actions workflow that pings `GET /` every 10 minutes is in `.github/workflows/keepalive.yml`. Scheduled runs can be delayed by GitHub.

Missing-data reminders run from `.github/workflows/reminders.yml` at 10:00 and 19:00 Asia/Karachi (05:00 and 14:00 UTC; Pakistan has no daylight saving). The morning check names active animals with no subah milk log. The evening check names animals with no shaam log, animals with neither session, litres recorded today that were not sold, and sales that exceed recorded milk. One Roman Urdu message per farmer per slot, and only if that farmer messaged within the last 24 hours. The same slot is not sent twice in one day. Normal replies still use the existing footer. GitHub's schedule only runs from the default branch, so it starts after this is on `main`. Add `CRON_SECRET` on Render and as a GitHub Actions secret before relying on it.

## Web recorder

Farmers open `https://munshi-whatsapp-webhook.onrender.com/r/<token>` in Android Chrome. The link is personal. A phone number is not enough. Bolein is the record button, then the same Roman Urdu summary with Haan, Nahi, and Edit. Confirmed rows are stored in Supabase when `SUPABASE_URL` is set, and in Google Sheets otherwise. The page does not send a WhatsApp message. A web visit still updates `last_inbound_at`, so the 10:00 and 19:00 reminders can see a fresh 24-hour window. The other tabs are described under Farmer web app.

`web_token` is a column on the master `Farmers` tab. Apps Script adds it in `migrateMaster_`, not in `extraColumns_` (that map is only for columns on each farm ledger). Paste `apps-script/Code.gs` and deploy a new version of the same web app before minting links. Keep the URL and do not change `SHEETS_SECRET`.

After that deploy, mint or list links with either of these. The output contains secrets. Do not commit it or paste it into chat.

```bash
node scripts/mint-recorder-links.js --remote
```

`CRON_SECRET` must already be in the environment. Or call the service directly:

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: application/json" \
  -d '{"phones":["923155506704","923205506704"]}' \
  https://munshi-whatsapp-webhook.onrender.com/admin/recorder-links
```

Allowed farmers with no token get one. Farmers who are not allowed are skipped. Running it again returns the same link. There is no new Render env var. Browser recordings are often `audio/webm`; the server sends `audio/ogg` when `ffmpeg` can remux them, and otherwise sends `audio/webm` through the same Gemini audio path WhatsApp uses.

## Supabase

Apply the SQL files in `supabase/migrations/` in filename order. Do not skip one. They create the farm tables (farmers, cows, milk, customers with `supply_type` of `fixed` or `flexible`, sales, payments, expenses, fodder and supplier balances, committee, vet and breeding events, feed stock, billing rows, reminders) and turn on row level security with no policies. The service role bypasses that lock; the anon key cannot read the tables. This repo does not apply the migrations itself.

1. `supabase/migrations/20261117120000_munshi_tables.sql`
2. `supabase/migrations/20261117120100_munshi_snapshot.sql`

Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on the existing Render web service, keep `REPLY_SCRIPT=roman`, and redeploy. `GET /` still returns `ok`. If `SUPABASE_URL` is unset, the process keeps using Apps Script so the current deployment does not break. When both are set, Postgres wins.

The Sheets and cron secrets live on Render. Copy the ledgers from there: set `IMPORT_FROM_SHEETS_ON_BOOT=1` together with `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SHEETS_WEBHOOK_URL`, and `SHEETS_SECRET`, then deploy. After the process is listening, it runs the import once in the background. `GET /` does not wait for it. The log has one line of row counts per table and then `IMPORT_FROM_SHEETS done`, or `IMPORT_FROM_SHEETS failed:` plus a short message that does not include secrets. A second start in the same process does not run a second import. Unset `IMPORT_FROM_SHEETS_ON_BOOT` after a successful copy so the next restart does not repeat it.

The same work can be run by hand where those variables are already set:

```bash
node scripts/import-from-sheets.js
```

`SHEETS_URL` is accepted as an alias of `SHEETS_WEBHOOK_URL`. Running it again updates the same rows; it does not delete rows that were removed from the sheet, and it does not remove rows the web app added later. The gateway does not export the pending-confirmation queue or the reminder log, so finish or cancel open confirms before the cutover. Reminder claims start empty in Postgres.

Mint links after the farmers are in Postgres. Existing `web_token` values are copied by the import, so farmers keep the same `/r/<token>` link.

```bash
node scripts/mint-recorder-links.js --remote
```

`CRON_SECRET` must be set. Or:

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: application/json" \
  -d '{"phones":["923155506704"]}' \
  https://munshi-whatsapp-webhook.onrender.com/admin/recorder-links
```

The output contains secrets. Do not commit it or paste it into chat.

## Farmer web app

`GET /r/<token>` is the installable page for one allowed farmer. Android Chrome is the target. Add it to the Home screen from the Chrome menu. The page is Roman Urdu, with large buttons and five tabs:

- **Bolein** records a voice note or a typed line, then Haan / Nahi / Edit. Gemini parses the voice note. A confirmed entry is stored and shows up on the other tabs. The page does not send a WhatsApp message.
- **Aaj** shows today's milk per cow and sold / unsold litres, and can add, edit, or delete those rows. Delete asks for confirmation.
- **Grahak** lists customers, the balance they owe, and standing supply. Tap to record a payment.
- **Khata** records expenses, including mazdoori and tankhwah, and shows supplier balances.
- **Hisaab** shows this week and this month.

Unknown tokens get a generic failure. A visit still updates `last_inbound_at`, so the 10:00 and 19:00 PKT reminders can see a fresh 24-hour window. Those reminder routes stay behind `CRON_SECRET`.

## Multi-tenant ledgers

Each allowed WhatsApp number gets its own Google Sheet, copied from the template ledger. A `Farmers` tab on the master sheet (`SHEET_ID`) maps phone number, sheet id, name, farm name, onboarding state, and `allowed`. The existing test number `923155506704` is already registered to the current ledger.

Unknown numbers are told the service is invite-only. To add a farmer, put their number in the `Farmers` tab with `allowed` = TRUE, or set `ALLOWED_NUMBERS` on Render (comma-separated, no plus sign). A new allowed number is walked through onboarding: name and farm, animals (cows and buffaloes), customers (or `skip`), then an optional saving committee (or `skip`). Every write is confirmed with Haan/Nahi first.

Customer standing supply is `supply_type` and `daily_litres` on the Customers tab. `fixed` means that many litres every day, even when the bill is weekly or monthly ("2 liter, payment har mahine ki 2 tareekh ko" is 2 litres a day, billed on the 2nd). `flexible` is for hotels and similar buyers; a mentioned typical amount is stored as a note and `daily_litres` stays blank. If the farmer does not say, both stay blank. "Aslam rozana kitna leta hai?" is answered from those fields. Apps Script must be redeployed as a new version of the same web app before the live sheet will store the new columns. Do not change `SHEETS_SECRET`.

New farmer sheets are copied by Apps Script (`DriveApp.makeCopy`) and data rows are cleared. Until the updated `apps-script/Code.gs` is deployed as a new version of the existing web app, the webhook falls back to the previous single-ledger behaviour so current records keep working. Do not change `SHEETS_SECRET` or `SHEETS_WEBHOOK_URL`.

## Receipts, edits, and photos

Farmers can text "Aslam ki parchi bhejo" to get a PNG receipt to forward. They can also add, rename, or remove a cow, add a customer, change a rate, correct a previous entry, or delete the last saved row. Photos of khata pages, fodder bills, or receipts are read the same way as text and voice notes; Munshi reads them back and waits for Haan/Nahi before writing.

## Committee and daily expenses

A saving committee (Roman Urdu: committee / kameti / kumitee) is stored on `Committees` (name, amount, frequency, optional start date and organizer) and `Committee_Log` (paid, not paid, or partial for each day or period). `Committee_Status` is derived when the ledger refreshes. Farmers can ask what they paid this month, what is still due, and whether today is paid. If today is unpaid, a normal reply can include one short footer line. Munshi does not send a separate WhatsApp reminder for it.

`Expenses` accepts any daily cost, including mazdoori, tankhwah, bijli, fuel, dawai, kiraya, marammat, and free-form notes. Fodder purchases still go to `Fodder`, not `Expenses`. An expense with no amount is not written. Several costs in one message are confirmed together, with the amount, category, and date.

Examples: `aaj committee di`, `committee nahi di`, `kameti 200 di`, `is mahine committee kitni di`, `aaj 500 mazdoori aur 2000 tankhwah`, `aaj kharcha 80 chai`, `aaj kharcha kitna hua`, `is hafte mazdoori kitni di`. Milk and customer payments are not treated as expenses.

## Reply language (`REPLY_SCRIPT`)

WhatsApp replies can be Roman Urdu, Urdu script, or both. Set the Render env var `REPLY_SCRIPT`:

- `both` (default): Urdu script first, then a blank line, then Roman Urdu
- `roman`: Roman Urdu only
- `urdu`: Urdu script only
- `auto`: match the script of the farmer's last text message

Numbers, names, Rs amounts, and dates stay the same in both versions. Button titles stay short (`ہاں Haan`, `نہیں Nahi`, `ترمیم Edit`).
