# Munshi ledger gateway (Google Apps Script)

The Render webhook cannot talk to Google Sheets on its own. This bound script is the gateway.

## Deploy

1. Open the ledger: https://docs.google.com/spreadsheets/d/1sIDMkUs76cgl8ecBGIOWFIPiofGzwGJI1D3Az6OyDW8
2. Extensions > Apps Script.
3. Delete any default code and paste the contents of `Code.gs`.
4. Click the gear (Project Settings) and under Script Properties add:
   - `SHEETS_SECRET` = the same value set on the Render service as `SHEETS_SECRET` (do not put it in this repo).
5. Click Deploy > New deployment.
6. Select type: Web app.
7. Description: `Munshi ledger gateway`.
8. Execute as: Me.
9. Who has access: Anyone.
10. Click Deploy, review and allow permissions for Google Sheets.
11. Copy the Web app URL and set it as `SHEETS_WEBHOOK_URL` on the Render service `munshi-whatsapp-webhook`, or send the URL to Munshi so it can be set for you.

The webhook only needs that URL plus the shared secret. Do not commit the secret or the live URL if it embeds a secret.

If the script is already deployed, paste the updated `Code.gs` and use Deploy > Manage deployments > the existing web app > pencil > New version, so the URL stays the same. The first time you deploy this version, Google will ask you to authorize Drive as well as Sheets. Drive is used only to copy a blank ledger for a new farmer. Review and allow. Leave the web app URL unchanged, and do not change `SHEETS_SECRET`.

This version also supports a `Farmers` registry on the master sheet, per-farmer ledgers, cow type / average yield, customer rate, edits (correct a row or delete the last write), saving committees (`Committees`, `Committee_Log`, derived `Committee_Status`), and open daily expenses on the existing `Expenses` tab (labor, salary, and any other named cost). Existing rows are kept. The first request after this deploy adds the new tabs and columns; it does not clear milk, sales, or expense history.

Proactive reminders also need this deploy. The script adds `last_inbound_at` on the master `Farmers` tab and a master-only `Reminder_Log` tab. Paste `Code.gs`, then Deploy > Manage deployments > edit the existing web app > New version. Keep the same URL and do not change `SHEETS_SECRET`. Farmer copies do not keep the reminder log. Existing milk, sales, committee, and expense rows stay.

Standing milk supply adds two columns on `Customers`, appended after the columns already there: `supply_type` (`fixed` or `flexible`) and `daily_litres` (a number only when `supply_type` is `fixed`). Paste this `Code.gs` and deploy a new web app version on the same URL. The first request appends any missing headers and does not clear existing customer rows, rates, balances, billing dates, or any extra columns such as a route. If `supply_type` and `daily_litres` are already filled, they are left as they are. Do not change `SHEETS_SECRET`.
