const path = require("path");
const express = require("express");
const { createSheets } = require("./lib/sheets");
const { processPayload } = require("./lib/bot");
const { authorizedCron, cronConfigured } = require("./lib/cron-auth");
const { runReminderJob } = require("./lib/reminder-job");

const app = express();
app.use(express.json({ limit: "2mb" }));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const pagesDir = path.join(__dirname, "pages");
const sheets = createSheets();

function sendPage(res, name) {
  res.sendFile(path.join(pagesDir, name));
}

app.get("/", (_req, res) => {
  res.type("text/plain").send("ok");
});

app.post("/cron/reminders", async (req, res) => {
  if (!cronConfigured()) {
    return res.status(503).type("text/plain").send("cron secret is not configured");
  }
  if (!authorizedCron(req)) {
    return res.status(401).type("text/plain").send("unauthorized");
  }
  try {
    const result = await runReminderJob(sheets, {
      slot: req.body && req.body.slot,
      now: new Date(),
    });
    return res.status(200).json(result);
  } catch (err) {
    console.error("reminder job failed", err.message);
    return res.status(500).json({ ok: false, error: "reminder job failed" });
  }
});

app.get("/privacy", (_req, res) => sendPage(res, "privacy.html"));
app.get("/terms", (_req, res) => sendPage(res, "terms.html"));
app.get("/data-deletion", (_req, res) => sendPage(res, "data-deletion.html"));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).type("text/plain").send(String(challenge ?? ""));
  }
  return res.sendStatus(403);
});

app.post("/webhook", (req, res) => {
  res.status(200).type("text/plain").send("EVENT_RECEIVED");

  const body = req.body ?? {};
  console.log(JSON.stringify(body));
  try {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        for (const message of change.value?.messages || []) {
          if (message.type === "audio") {
            console.log(
              "audio media id:",
              message.audio?.id,
              "mime type:",
              message.audio?.mime_type
            );
          }
        }
      }
    }
  } catch (err) {
    console.error("failed to parse audio fields:", err.message);
  }

  setImmediate(() => {
    processPayload(sheets, body).catch((err) => {
      console.error("processPayload failed", err.message);
    });
  });
});

const port = process.env.PORT || 10000;
app.listen(port, "0.0.0.0", () => {
  console.log(`munshi webhook listening on ${port}`);
});
