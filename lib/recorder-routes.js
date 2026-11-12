const crypto = require("crypto");
const path = require("path");
const express = require("express");
const { authorizedCron, cronConfigured } = require("./cron-auth");
const { createWindowLimiter } = require("./rate-limit");
const { ensureWebTokens } = require("./web-token");
const {
  GENERIC_DENY,
  renderDeniedPage,
  renderRecorderPage,
  renderManifest,
  handleRecorderTurn,
} = require("./recorder");
const { findAllowedFarmerByToken } = require("./web-token");

const AUDIO_LIMIT = 8;
const TURN_LIMIT = 30;
const WINDOW_MS = 10 * 60 * 1000;
const audioLimiter = createWindowLimiter({ limit: AUDIO_LIMIT, windowMs: WINDOW_MS });
const turnLimiter = createWindowLimiter({ limit: TURN_LIMIT, windowMs: WINDOW_MS });
const pagesDir = path.join(__dirname, "../pages");
const RATE_MESSAGE = "Bohat tez bhej rahe hain. Thori dair ruk kar dubara bhejein.";

function limitKey(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex").slice(0, 24);
}

function publicBase(req) {
  const forwarded = String(req.get("x-forwarded-proto") || "")
    .split(",")[0]
    .trim();
  const proto = forwarded || req.protocol || "https";
  const host = String(req.get("x-forwarded-host") || req.get("host") || "")
    .split(",")[0]
    .trim();
  return `${proto}://${host}`;
}

function sendDenied(res, asHtml) {
  if (asHtml) {
    return res
      .status(404)
      .set("Cache-Control", "no-store")
      .set("X-Robots-Tag", "noindex")
      .type("html")
      .send(renderDeniedPage());
  }
  return res.status(404).set("Cache-Control", "no-store").json({ ok: false, error: GENERIC_DENY });
}

function rawAudio(req, res, next) {
  express.raw({ type: () => true, limit: "8mb" })(req, res, (err) => {
    if (!err) return next();
    const tooLarge = err.status === 413 || err.type === "entity.too.large";
    if (tooLarge) {
      return res.status(413).json({ ok: false, error: "Awaz bohat lambi hai. Chhota note bhejein." });
    }
    return res.status(400).json({ ok: false, error: "Awaz nahi mili. Dobara record karein." });
  });
}

function mountRecorder(app, sheets) {
  app.get("/recorder/sw.js", (_req, res) => {
    res.set("Service-Worker-Allowed", "/r/");
    res.set("Cache-Control", "no-cache");
    res.type("application/javascript");
    res.sendFile(path.join(pagesDir, "recorder-sw.js"));
  });

  app.get("/recorder/icon-192.png", (_req, res) => {
    res.type("image/png").sendFile(path.join(pagesDir, "icon-192.png"));
  });

  app.get("/recorder/icon-512.png", (_req, res) => {
    res.type("image/png").sendFile(path.join(pagesDir, "icon-512.png"));
  });

  app.get("/r/:token/manifest.webmanifest", async (req, res) => {
    const farmer = await findAllowedFarmerByToken(sheets, req.params.token);
    if (!farmer) return sendDenied(res, false);
    res
      .status(200)
      .set("Cache-Control", "private, no-store")
      .type("application/manifest+json")
      .send(renderManifest(req.params.token));
  });

  app.get("/r/:token", async (req, res) => {
    const farmer = await findAllowedFarmerByToken(sheets, req.params.token);
    if (!farmer) return sendDenied(res, true);
    res
      .status(200)
      .set("Cache-Control", "private, no-store")
      .set("X-Robots-Tag", "noindex")
      .type("html")
      .send(renderRecorderPage(farmer, req.params.token));
  });

  app.post("/r/:token/turn", async (req, res) => {
    const token = req.params.token;
    const farmer = await findAllowedFarmerByToken(sheets, token);
    if (!farmer) return sendDenied(res, false);
    if (!turnLimiter.allow(limitKey(token))) {
      return res.status(429).json({ ok: false, error: RATE_MESSAGE });
    }
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const result = await handleRecorderTurn(sheets, {
      token,
      text: body.text,
      action: body.action,
    });
    return res.status(result.status).json({
      ok: result.ok,
      error: result.error,
      replies: result.replies || [],
    });
  });

  app.post("/r/:token/audio", rawAudio, async (req, res) => {
    const token = req.params.token;
    const farmer = await findAllowedFarmerByToken(sheets, token);
    if (!farmer) return sendDenied(res, false);
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (buffer.length < 200) {
      return res.status(400).json({ ok: false, error: "Awaz nahi mili. Dobara record karein." });
    }
    if (!audioLimiter.allow(limitKey(token))) {
      return res.status(429).json({ ok: false, error: RATE_MESSAGE });
    }
    const result = await handleRecorderTurn(sheets, {
      token,
      audio: { buffer, mimeType: req.get("content-type") || "audio/webm" },
    });
    return res.status(result.status).json({
      ok: result.ok,
      error: result.error,
      replies: result.replies || [],
    });
  });

  async function recorderLinks(req, res) {
    if (!cronConfigured()) {
      return res.status(503).type("text/plain").send("cron secret is not configured");
    }
    if (!authorizedCron(req)) {
      return res.status(401).type("text/plain").send("unauthorized");
    }
    try {
      const phones = [];
      if (req.body && Array.isArray(req.body.phones)) phones.push(...req.body.phones);
      if (req.query && req.query.phone) phones.push(req.query.phone);
      const result = await ensureWebTokens(sheets, phones.length ? { phones } : {});
      if (!result.ok && result.redeploy) {
        return res.status(503).json({
          ok: false,
          redeploy: true,
          error:
            "Paste apps-script/Code.gs and deploy a new version of the same web app before minting links. Do not change SHEETS_SECRET.",
        });
      }
      const base = publicBase(req);
      res.set("Cache-Control", "no-store");
      return res.status(200).json({
        ok: true,
        links: (result.links || []).map((link) => ({
          phone: link.phone,
          name: link.name || "",
          eligible: link.eligible !== false,
          minted: Boolean(link.minted),
          url: link.token ? `${base}/r/${link.token}` : "",
        })),
      });
    } catch (err) {
      console.error("recorder links failed", err.message);
      return res.status(500).json({ ok: false, error: "link mint failed" });
    }
  }

  app.get("/admin/recorder-links", recorderLinks);
  app.post("/admin/recorder-links", recorderLinks);
}

module.exports = {
  mountRecorder,
  limitKey,
  audioLimiter,
  turnLimiter,
  AUDIO_LIMIT,
  TURN_LIMIT,
};
