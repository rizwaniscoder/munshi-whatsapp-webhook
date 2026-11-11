# Munshi WhatsApp Webhook

Minimal WhatsApp Cloud API webhook for Munshi, a bookkeeping assistant operated by Nodeable AI LLC. It answers Meta's verification challenge, logs incoming message payloads (including audio media IDs), and serves the public policy pages Meta requires to publish an app.

## Endpoints

- `GET /` - health check, returns `ok`
- `GET /webhook` - Meta webhook verification (`hub.mode`, `hub.verify_token`, `hub.challenge`)
- `POST /webhook` - accepts the event, returns 200, and logs the JSON body
- `GET /privacy` - Privacy Policy
- `GET /terms` - Terms of Service
- `GET /data-deletion` - data deletion instructions

Set `VERIFY_TOKEN` in the host environment. Do not commit secrets.
