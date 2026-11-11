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
