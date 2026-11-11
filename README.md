# Munshi WhatsApp Webhook

Minimal WhatsApp Cloud API webhook. It answers Meta's verification challenge and logs incoming message payloads, including audio media IDs.

## Endpoints

- `GET /` — health check, returns `ok`
- `GET /webhook` — Meta webhook verification (`hub.mode`, `hub.verify_token`, `hub.challenge`)
- `POST /webhook` — accepts the event, returns 200, and logs the JSON body

Set `VERIFY_TOKEN` in the host environment. Do not commit secrets.
