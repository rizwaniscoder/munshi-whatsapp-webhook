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
const {
  getAaj,
  postAaj,
  getGrahak,
  postGrahak,
  getKhata,
  postKhata,
  getHisaab,
} = require("./farm-screens");
const { shapeManual, mutateManual, customerLedger, supplierLedger, historyView } = require("./manual");
const { shapeParties, mutateParty, ledgerFor, ledgerPdf, exportLines, remember, bag } = require("./parties");
const { dayThread, newThread, addChatMessages, pageMessages, listThreads, setChatState, recentCreates } = require("./chat");

const AUDIO_LIMIT = 8;
const TURN_LIMIT = 30;
const WINDOW_MS = 10 * 60 * 1000;
const audioLimiter = createWindowLimiter({ limit: AUDIO_LIMIT, windowMs: WINDOW_MS });
const turnLimiter = createWindowLimiter({ limit: TURN_LIMIT, windowMs: WINDOW_MS });
const screenLimiter = createWindowLimiter({ limit: 120, windowMs: WINDOW_MS });
const pagesDir = path.join(__dirname, "../pages");
const RATE_MESSAGE = "Bohat tez bhej rahe hain. Thori dair ruk kar dubara bhejein.";

async function persistChatRows(sheets, farmer, rows) {
  if (!sheets || !sheets.client || typeof sheets.client.from !== "function" || !(rows || []).length) return;
  const payload = rows.map((row) => ({
    id: row.id,
    farmer_phone: farmer.phone,
    sheet_key: farmer.sheetId || "",
    thread_id: row.thread_id,
    role: row.role,
    content: row.content,
    payload: row.payload || {},
    created_at: row.created_at,
  }));
  const { error } = await sheets.client.from("chat_messages").insert(payload);
  if (error) console.error("chat save failed", error.code || "unknown");
}

async function hydrateChat(sheets, farmer) {
  if (!sheets || !sheets.client || typeof sheets.client.from !== "function") return;
  const { data, error } = await sheets.client
    .from("chat_messages")
    .select("id,farmer_phone,sheet_key,thread_id,role,content,payload,created_at")
    .eq("farmer_phone", farmer.phone)
    .order("created_at", { ascending: true })
    .limit(2000);
  if (error) return;
  sheets._chat = (data || []).map((row) => ({
    ...row,
    payload: row.payload || {},
    farmer_phone: row.farmer_phone || farmer.phone,
  }));
}

async function rememberTurn(sheets, farmer, info) {
  const thread = info.thread || dayThread();
  if (info.messageId && info.action) {
    const state = info.action === "confirm_yes" ? "yes" : info.action === "confirm_no" ? "no" : info.action === "confirm_edit" ? "edit" : "";
    if (state) {
      setChatState(sheets, farmer, info.messageId, state);
      if (sheets.client && typeof sheets.client.from === "function") {
        const row = (sheets._chat || []).find((item) => item.id === info.messageId);
        if (row) {
          await sheets.client.from("chat_messages").update({ payload: row.payload }).eq("id", info.messageId).eq("farmer_phone", farmer.phone);
        }
      }
    }
  }
  const records = recentCreates(sheets, info.since || 0);
  const items = [];
  if (info.text) items.push({ thread_id: thread, role: "farmer", content: String(info.text), payload: { kind: "text" } });
  else if (info.audio) items.push({ thread_id: thread, role: "farmer", content: "Awaz note", payload: { kind: "audio" } });
  else if (info.action === "confirm_yes" || info.action === "confirm_no" || info.action === "confirm_edit") {
    const label = info.action === "confirm_yes" ? "Haan" : info.action === "confirm_no" ? "Nahi" : "Edit";
    items.push({ thread_id: thread, role: "farmer", content: label, payload: { kind: "action" } });
  }
  for (const reply of info.replies || []) {
    const heard = reply.transcript ? "Maine yeh suna: " + reply.transcript : "";
    const text = String(reply.text || "");
    const content = [heard, text].filter(Boolean).join("\n");
    const kind = reply.kind === "confirm" && /save ho gaya/i.test(text) ? "receipt" : (reply.kind || "text");
    items.push({
      thread_id: thread,
      role: "munshi",
      content,
      payload: {
        kind,
        state: kind === "confirm" ? "open" : "",
        transcript: reply.transcript || "",
        entries: reply.entries || [],
        actions: reply.actions || [],
        record_ids: records,
      },
    });
  }
  const saved = addChatMessages(sheets, farmer, items);
  await persistChatRows(sheets, farmer, saved);
  return saved;
}

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
    const started = Date.now() - 2000;
    const result = await handleRecorderTurn(sheets, {
      token,
      text: body.text,
      action: body.action,
      entries: body.entries,
    });
    if (result.ok) {
      await rememberTurn(sheets, farmer, {
        thread: body.thread,
        text: body.text,
        action: body.action,
        messageId: body.message_id,
        replies: result.replies || [],
        since: started,
      });
    }
    return res.status(result.status).json({
      ok: result.ok,
      error: result.error,
      replies: result.replies || [],
      thread_id: body.thread || dayThread(),
    });
  });

  async function screenCall(req, res, handler) {
    const token = req.params.token;
    const farmer = await findAllowedFarmerByToken(sheets, token);
    if (!farmer) return sendDenied(res, false);
    if (!screenLimiter.allow(limitKey(token))) {
      return res.status(429).json({ ok: false, error: RATE_MESSAGE });
    }
    try {
      const result = await handler(farmer, req);
      const status = result && result.status ? result.status : result && result.ok === false ? 400 : 200;
      const body = { ...(result || { ok: false, error: "Masla aa gaya." }) };
      delete body.status;
      return res.status(status).json(body);
    } catch (err) {
      console.error("screen failed", err.code || "error");
      return res.status(500).json({ ok: false, error: "Masla aa gaya. Thori dair baad dubara koshish karein." });
    }
  }

  app.get("/r/:token/api/aaj", (req, res) => screenCall(req, res, (farmer) => getAaj(sheets, farmer)));
  app.post("/r/:token/api/aaj", (req, res) => screenCall(req, res, (farmer) => postAaj(sheets, farmer, req.body || {})));
  app.get("/r/:token/api/grahak", (req, res) => screenCall(req, res, (farmer) => getGrahak(sheets, farmer)));
  app.post("/r/:token/api/grahak", (req, res) => screenCall(req, res, (farmer) => postGrahak(sheets, farmer, req.body || {})));
  app.get("/r/:token/api/khata", (req, res) => screenCall(req, res, (farmer) => getKhata(sheets, farmer)));
  app.post("/r/:token/api/khata", (req, res) => screenCall(req, res, (farmer) => postKhata(sheets, farmer, req.body || {})));
  app.get("/r/:token/api/hisaab", (req, res) => screenCall(req, res, (farmer, inner) => getHisaab(sheets, farmer, inner.query && inner.query.range)));

  function withScreen(farmer, work) {
    return sheets.withLedger({ sender: farmer.phone, sheetId: farmer.sheetId || "" }, (store, mem) => work(store, mem)).catch((err) => {
      const message = String(err && err.message ? err.message : "");
      if (/ledger|onboarding|available nahi/i.test(message)) return { ok: false, status: 400, error: message };
      throw err;
    });
  }

  app.get("/r/:token/api/manual", (req, res) => screenCall(req, res, async (farmer, inner) => {
    const kind = inner.query && inner.query.kind;
    return withScreen(farmer, (store, mem) => shapeManual(store, mem, kind ? String(kind) : ""));
  }));
  app.post("/r/:token/api/manual", (req, res) => screenCall(req, res, async (farmer) => {
    const result = await withScreen(farmer, (store, mem) => mutateManual(store, mem, req.body || {}, farmer));
    if (!result || result.ok === false) return result;
    const kind = req.body && req.body.kind;
    const shaped = await withScreen(farmer, (store, mem) => shapeManual(store, mem, kind ? String(kind) : ""));
    return { ...shaped, id: result.id || "" };
  }));
  app.get("/r/:token/api/ledger", (req, res) => screenCall(req, res, (farmer, inner) => {
    const kind = String((inner.query && inner.query.kind) || "customer");
    const name = inner.query && (inner.query.name || inner.query.account);
    return withScreen(farmer, (store, mem) => (
      kind === "supplier" ? supplierLedger(store, mem, name) : customerLedger(store, mem, name)
    ));
  }));
  app.get("/r/:token/api/party", (req, res) => screenCall(req, res, (farmer, inner) => withScreen(farmer, (store, mem) => {
    const query = inner.query || {};
    if (query.export === "pdf") {
      return { ok: true, pdf: true, lines: exportLines(store, mem, farmer) };
    }
    if (query.kind && query.name) return ledgerFor(store, mem, farmer, String(query.kind), String(query.name));
    const data = shapeParties(store, mem, farmer);
    for (const row of [...data.customers, ...data.suppliers]) {
      const ledger = ledgerFor(store, mem, farmer, row.kind, row.name);
      const last = (ledger.lines || []).filter((line) => line.kind !== "opening").slice(-1)[0];
      row.when = last ? (last.when || "") : "";
      row.last_date = last ? last.date || "" : "";
    }
    return data;
  })));
  app.post("/r/:token/api/party", (req, res) => screenCall(req, res, async (farmer) => {
    const body = req.body || {};
    if (body.op === "entry") {
      const direction = body.direction === "liye" ? "liye" : "diye";
      let saved;
      if (body.kind === "supplier") {
        saved = await withScreen(farmer, (store, mem) => mutateManual(store, mem, direction === "diye"
          ? { kind: "supplier_payment", supplier: body.name, amount: body.amount, note: body.note, date: body.date }
          : { kind: "supplier_adjust", supplier: body.name, amount: body.amount, note: body.note, date: body.date }, farmer));
      } else if (body.kind === "bank") {
        saved = await withScreen(farmer, (store, mem) => mutateParty(store, mem, { ...body, op: "bank_entry", direction }, farmer));
      } else if (direction === "liye") {
        saved = await withScreen(farmer, (store, mem) => mutateManual(store, mem, {
          kind: "payment",
          customer: body.name,
          amount: body.amount,
          date: body.date,
          method: "wasool",
        }, farmer));
      } else {
        saved = await withScreen(farmer, (store, mem) => mutateManual(store, mem, {
          kind: "customer_adjust",
          customer: body.name,
          direction: "debit",
          amount: body.amount,
          note: body.note,
          date: body.date,
        }, farmer));
      }
      if (!saved || saved.ok === false) return saved;
      if (saved.id && (body.note || body.photo)) {
        const noted = await withScreen(farmer, (_store, mem) => {
          const parties = bag(mem, farmer.phone);
          return remember(parties, saved.id, body.note, body.photo) || { ok: true };
        });
        if (noted && noted.ok === false) return noted;
      }
      return withScreen(farmer, (store, mem) => ledgerFor(store, mem, farmer, body.kind || "customer", body.name));
    }
    const changed = await withScreen(farmer, (store, mem) => mutateParty(store, mem, body, farmer));
    if (!changed || changed.ok === false) return changed;
    const shaped = await withScreen(farmer, (store, mem) => shapeParties(store, mem, farmer));
    return { ...shaped, id: changed.id || "" };
  }));
  app.get("/r/:token/api/party.pdf", (req, res) => screenCall(req, res, (farmer) => (
    withScreen(farmer, (store, mem) => ({ ok: true, pdf: ledgerPdf(exportLines(store, mem, farmer)).toString("base64") }))
  )));
  app.get("/r/:token/api/chat", (req, res) => screenCall(req, res, async (farmer, inner) => {
    await hydrateChat(sheets, farmer);
    const query = inner.query || {};
    if (query.threads === "1") return listThreads(sheets, farmer, query);
    return pageMessages(sheets, farmer, query);
  }));
  app.post("/r/:token/api/chat", (req, res) => screenCall(req, res, async (farmer) => {
    const body = req.body || {};
    if (body.op === "new") {
      const thread = newThread();
      const saved = addChatMessages(sheets, farmer, [{
        thread_id: thread,
        role: "munshi",
        content: "Naya chat",
        payload: { kind: "text" },
      }]);
      await persistChatRows(sheets, farmer, saved);
      return { ok: true, thread_id: thread, messages: saved };
    }
    if (body.op === "state") {
      const updated = setChatState(sheets, farmer, body.id, body.state);
      if (updated.ok && sheets.client && typeof sheets.client.from === "function") {
        const row = (sheets._chat || []).find((item) => item.id === body.id);
        if (row) await sheets.client.from("chat_messages").update({ payload: row.payload }).eq("id", body.id).eq("farmer_phone", farmer.phone);
      }
      return updated;
    }
    return { ok: false, status: 400, error: "Yeh kaam theek nahi." };
  }));
  app.get("/r/:token/api/tareekh", (req, res) => screenCall(req, res, (farmer, inner) => (
    withScreen(farmer, (_store, mem) => historyView(mem, farmer, inner.query || {}))
  )));
  app.post("/r/:token/api/tareekh", (req, res) => screenCall(req, res, async (farmer) => {
    const result = await withScreen(farmer, (store, mem) => mutateManual(store, mem, { ...(req.body || {}), op: "restore" }, farmer));
    if (!result || result.ok === false) return result;
    return withScreen(farmer, (_store, mem) => historyView(mem, farmer, {}));
  }));

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
    const started = Date.now() - 2000;
    const result = await handleRecorderTurn(sheets, {
      token,
      audio: { buffer, mimeType: req.get("content-type") || "audio/webm" },
    });
    if (result.ok) {
      await rememberTurn(sheets, farmer, {
        thread: req.query && req.query.thread,
        audio: true,
        replies: result.replies || [],
        since: started,
      });
    }
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
