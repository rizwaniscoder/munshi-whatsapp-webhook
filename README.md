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
- `ALLOWED_NUMBERS` - comma-separated extra allowlist. Empty does not mean allow everyone. A number that is not an allowed farmer in the registry, and not on this list, gets the invite reply and is not created.
- `MASTER_PHONE` - optional. Leave it unset. There is no built-in master number. The old test number `923155506704` is not privileged and a message from it does not recreate a farmer or open the template ledger. Supabase is the ledger. The template `SHEET_ID` is not a farm book.
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
  -d '{"phones":["923205506704"]}' \
  https://munshi-whatsapp-webhook.onrender.com/admin/recorder-links
```

Allowed farmers with no token get one. Farmers who are not allowed are skipped. Running it again returns the same link. There is no new Render env var. Browser recordings are often `audio/webm`; the server sends `audio/ogg` when `ffmpeg` can remux them, and otherwise sends `audio/webm` through the same Gemini audio path WhatsApp uses.

## Supabase

Apply the SQL files in `supabase/migrations/` in filename order. Do not skip one. They create the farm tables (farmers, cows, milk, customers with `supply_type` of `fixed` or `flexible`, sales, payments, expenses, fodder and supplier balances, committee, vet and breeding events, feed stock, billing rows, reminders) and turn on row level security with no policies. The service role bypasses that lock; the anon key cannot read the tables. This repo does not apply the migrations itself.

1. `supabase/migrations/20261117120000_munshi_tables.sql`
2. `supabase/migrations/20261117120100_munshi_snapshot.sql`
3. `supabase/migrations/20261119000000_fix_snapshot_delete_where.sql`
4. `supabase/migrations/20261120120000_record_history.sql`

Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on the existing Render web service, keep `REPLY_SCRIPT=roman`, and redeploy. `GET /` still returns `ok`. If `SUPABASE_URL` is unset, the process keeps using Apps Script so the current deployment does not break. When both are set, Postgres wins.

The Sheets and cron secrets live on Render. Copy the ledgers from there: set `IMPORT_FROM_SHEETS_ON_BOOT=1` together with `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SHEETS_WEBHOOK_URL`, and `SHEETS_SECRET`, then deploy. After the process is listening, it runs the import once in the background. `GET /` does not wait for it. The log has one line of row counts per table and then `IMPORT_FROM_SHEETS done`, or `IMPORT_FROM_SHEETS failed:` plus a short message that does not include secrets. A second start in the same process does not run a second import. Unset `IMPORT_FROM_SHEETS_ON_BOOT` after a successful copy so the next restart does not repeat it.

The same work can be run by hand where those variables are already set:

```bash
node scripts/import-from-sheets.js
```

`SHEETS_URL` is accepted as an alias of `SHEETS_WEBHOOK_URL`. The import calls `listFarmers` and `readRecent` with `sender`, `phone`, `sheetId`, `days`, and `refresh: false`, which the Apps Script deployed before the web recorder understands. If `listRecorderFarmers` is missing or fails, it uses `listFarmers`. Running it again updates the same rows; it does not delete rows that were removed from the sheet, and it does not remove rows the web app added later. The gateway does not export the pending-confirmation queue or the reminder log, so finish or cancel open confirms before the cutover. Reminder claims start empty in Postgres.

Mint links after the farmers are in Postgres. Existing `web_token` values are copied by the import, so farmers keep the same `/r/<token>` link.

```bash
node scripts/mint-recorder-links.js --remote
```

`CRON_SECRET` must be set. Or:

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: application/json" \
  -d '{"phones":["923205506704"]}' \
  https://munshi-whatsapp-webhook.onrender.com/admin/recorder-links
```

The output contains secrets. Do not commit it or paste it into chat.

## Farmer web app

`GET /r/<token>` is the installable page for one allowed farmer. Android Chrome is the target, including a 390px-wide phone. Add it to the Home screen from the Chrome menu. The page is Roman Urdu, with large buttons. Voice stays on Bolein. **Likhein** on every tab opens a form that does not call Gemini.

- **Bolein** is a chat. The farmer's messages sit on the right and Munshi's on the left. A voice note shows `Maine yeh suna` with the transcript, then Haan / Nahi / Edit on the card. A saved entry is a receipt; tap it to open that record. The bottom bar has a text box, `+` for Doodh, Farokht, Wasooli, Kharcha, Chara, Udhaar/Jama, and Janwar, and a round Record button (tap or hold). One thread per day, plus Naya chat. Purani chats opens an older thread read-only and can be searched by date or name. The page loads the latest 50 messages.
- **Aaj** shows today's milk per cow and sold / unsold litres. Rows open an edit form. Delete asks for confirmation.
- **Grahak** and **Khata** share a Party list: Grahak, Supplier, Bank, and Sab. The card on top is Aap ne dene hain and Aap ko milne hain, with a hide-balance control, search, a filter, and a PDF. Archived parties sit in their own row. A party opens a ledger with Diye and Liye columns, a running balance, and Diye / Liye buttons (amount, date, note, optional photo). Edit, archive, and Tareekh are on that screen. Khata still has the expense form above the supplier list.
- **Hisaab** shows this week and this month.
- **Tareekh** is the recent change list. Filter by account or record. A deleted row can be brought back from there.

Likhein covers milk (subah/shaam), sales (rate from the customer, nagd or udhaar), payments, customer jama/credit, fodder purchases, supplier payments, expenses, committee paid or missed, animal events, feed stock, and add/edit for cows, customers, and suppliers. Save and delete recompute the balances. Every create, update, and delete from Likhein, from a confirmed voice or web note, and from WhatsApp is appended to `record_history`. Bolein messages are appended to `chat_messages` (farmer phone, thread, role, text, and a jsonb payload). `save_ledger_snapshot` does not delete either table.

Unknown tokens get a generic failure. A visit still updates `last_inbound_at`, so the 10:00 and 19:00 PKT reminders can see a fresh 24-hour window. Those reminder routes stay behind `CRON_SECRET`.

## Multi-tenant ledgers

Each allowed WhatsApp number gets its own ledger. In Supabase that is the farmer row plus that farmer's cows, milk, sales, and the other tables. Naab Dairy (`923205506704`) is the live farm. The old test number `923155506704` was removed and is not a master. Do not set `MASTER_PHONE` to it. An inbound message from an unknown number, including that old number, gets the invite reply. It does not create a farmer and it does not open the template sheet.

To add a farmer, put their number in `farmers` with `allowed` = true, or set `ALLOWED_NUMBERS` on Render (comma-separated, no plus sign). A new allowed number is walked through onboarding: name and farm, animals (cows and buffaloes), customers (or `skip`), then an optional saving committee (or `skip`). Every write is confirmed with Haan/Nahi first. Onboarding copies a blank ledger. It does not attach `SHEET_ID`.

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
