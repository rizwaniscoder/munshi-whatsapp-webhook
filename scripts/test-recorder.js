const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");

process.env.REPLY_SCRIPT = "roman";
process.env.WHATSAPP_DRY_RUN = "1";
process.env.CRON_SECRET = "unit-test-cron-secret";
delete process.env.ALLOWED_NUMBERS;

const { MemorySheets } = require("../lib/sheets");
const { takeOutbound } = require("../lib/whatsapp");
const {
  mintWebToken,
  tokenLooksValid,
  redactToken,
  ensureWebTokens,
  farmerMayUseRecorder,
} = require("../lib/web-token");
const { normalizeAudioMime, prepareAudioForGemini } = require("../lib/audio-mime");
const { handleRecorderTurn, GENERIC_DENY } = require("../lib/recorder");
const { mountRecorder, limitKey, audioLimiter, AUDIO_LIMIT } = require("../lib/recorder-routes");
const { app } = require("../index");

const PHONE_A = "923111222333";
const PHONE_B = "923111222444";
const KNOWN_A = "923155506704";
const KNOWN_B = "923205506704";

function listen(serverApp) {
  return new Promise((resolve) => {
    const server = serverApp.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function request(server, method, reqPath, { headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        method,
        path: reqPath,
        headers: headers || {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function seedFarmer(sheets, phone, opts = {}) {
  const copy = await sheets.copyLedger({
    phone,
    name: opts.name || "Ali",
    farmName: opts.farmName || "Al Noor Dairy",
    allowed: opts.allowed !== false,
    onboardingState: "complete",
  });
  const token = opts.token || mintWebToken();
  const saved = await sheets.setWebToken(phone, token);
  assert.strictEqual(saved.ok, true);
  return { phone, token, sheetId: copy.sheetId };
}

function expenseRows(sheets, sheetId) {
  return sheets.ledgers[sheetId].Expenses.slice(1);
}

async function main() {
  const fresh = mintWebToken();
  assert.strictEqual(tokenLooksValid(fresh), true);
  assert.strictEqual(tokenLooksValid("923155506704"), false);
  assert.strictEqual(tokenLooksValid("short"), false);
  assert.notStrictEqual(redactToken(fresh), fresh);
  assert.ok(redactToken(fresh).includes("…"));
  assert.ok(!redactToken(fresh).includes(fresh.slice(6, 20)));

  const ogg = Buffer.from("OggS");
  const prepared = await prepareAudioForGemini(ogg, "audio/ogg; codecs=opus");
  assert.strictEqual(prepared.mimeType, "audio/ogg");
  assert.strictEqual(prepared.buffer, ogg);
  assert.strictEqual(normalizeAudioMime("audio/webm;codecs=opus"), "audio/webm");
  assert.strictEqual(normalizeAudioMime("video/webm"), "audio/webm");

  const sheets = new MemorySheets();
  const a = await seedFarmer(sheets, PHONE_A, { name: "Ali", farmName: "Al Noor Dairy" });
  const b = await seedFarmer(sheets, PHONE_B, { name: "Bilal", farmName: "Bilal Farm" });

  const renamed = await sheets.upsertFarmer({ phone: PHONE_A, name: "Ali Khan" });
  assert.strictEqual(renamed.farmer.webToken, a.token, "upsert must keep the recorder token");

  const found = await sheets.findFarmerByToken(a.token);
  assert.strictEqual(found.farmer.phone, PHONE_A);
  assert.strictEqual(found.farmer.farmName, "Al Noor Dairy");
  const missing = await sheets.findFarmerByToken(mintWebToken());
  assert.strictEqual(missing.farmer, null);
  const byPhone = await sheets.findFarmerByToken(PHONE_A);
  assert.strictEqual(byPhone.farmer, null);

  const blockedSheets = new MemorySheets();
  const blocked = await seedFarmer(blockedSheets, "923100000099", {
    name: "Hidden",
    farmName: "Secret Farm",
    allowed: false,
  });
  assert.strictEqual(farmerMayUseRecorder(blockedSheets.findFarmer(blocked.phone) || (await blockedSheets.findFarmerByToken(blocked.token)).farmer), false);
  const denied = await handleRecorderTurn(blockedSheets, { token: blocked.token, text: "aaj 500 mazdoori" });
  assert.strictEqual(denied.status, 404);
  assert.strictEqual(denied.error, GENERIC_DENY);
  assert.ok(!JSON.stringify(denied).includes("Secret Farm"));
  assert.ok(!JSON.stringify(denied).includes("923100000099"));

  const unknown = await handleRecorderTurn(sheets, { token: mintWebToken(), text: "aaj 500 mazdoori" });
  assert.strictEqual(unknown.status, 404);
  assert.strictEqual(unknown.error, GENERIC_DENY);
  const phoneAsToken = await handleRecorderTurn(sheets, { token: PHONE_A, text: "aaj 500 mazdoori" });
  assert.strictEqual(phoneAsToken.status, 404);
  assert.strictEqual(phoneAsToken.error, GENERIC_DENY);

  takeOutbound();
  const draft = await handleRecorderTurn(sheets, { token: a.token, text: "aaj 500 mazdoori" });
  assert.strictEqual(draft.status, 200);
  assert.strictEqual(draft.replies[0].kind, "confirm");
  assert.ok(/Yeh record karun/i.test(draft.replies[0].text), draft.replies[0].text);
  assert.ok(/mazdoori/i.test(draft.replies[0].text), draft.replies[0].text);
  assert.ok(/Rs 500/.test(draft.replies[0].text), draft.replies[0].text);
  assert.ok(!/[\u0600-\u06FF]/.test(draft.replies[0].text), draft.replies[0].text);
  assert.deepStrictEqual(
    draft.replies[0].actions.map((item) => item.id),
    ["confirm_yes", "confirm_no", "confirm_edit"]
  );
  assert.strictEqual(takeOutbound().length, 0, "web confirm must not send WhatsApp");
  assert.strictEqual(expenseRows(sheets, a.sheetId).length, 0);

  const cancelled = await handleRecorderTurn(sheets, { token: a.token, action: "confirm_no" });
  assert.strictEqual(cancelled.status, 200);
  assert.ok(/nahi likha/i.test(cancelled.replies.map((r) => r.text).join("\n")), cancelled.replies.map((r) => r.text).join("\n"));
  assert.strictEqual(expenseRows(sheets, a.sheetId).length, 0);
  assert.strictEqual((await sheets.getPending(PHONE_A)).pending, null);
  assert.strictEqual(takeOutbound().length, 0);

  const again = await handleRecorderTurn(sheets, { token: a.token, text: "aaj 500 mazdoori" });
  assert.strictEqual(again.replies[0].kind, "confirm");
  const editing = await handleRecorderTurn(sheets, { token: a.token, action: "confirm_edit" });
  assert.ok(/tabdeeli/i.test(editing.replies.map((r) => r.text).join("\n")));
  assert.strictEqual(expenseRows(sheets, a.sheetId).length, 0);
  assert.strictEqual((await sheets.getPending(PHONE_A)).pending.status, "editing");

  await sheets.clearPending(PHONE_A, "cancelled");
  await handleRecorderTurn(sheets, { token: a.token, text: "aaj 500 mazdoori" });
  const saved = await handleRecorderTurn(sheets, { token: a.token, action: "confirm_yes" });
  const savedText = saved.replies.map((r) => r.text).join("\n");
  assert.ok(/Save ho gaya/i.test(savedText), savedText);
  assert.strictEqual(takeOutbound().length, 0);
  const rows = expenseRows(sheets, a.sheetId);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0][1], "labor");
  assert.strictEqual(Number(rows[0][2]), 500);
  assert.ok(String(rows[0][3]).startsWith(`Web ${PHONE_A}`), rows[0][3]);
  assert.strictEqual(expenseRows(sheets, b.sheetId).length, 0, "token A must not write farm B");
  const touched = await sheets.getFarmer(PHONE_A);
  assert.ok(touched.farmer.lastInboundAt, "web use must update last_inbound_at");
  const other = await sheets.getFarmer(PHONE_B);
  assert.strictEqual(other.farmer.lastInboundAt, "");

  await sheets.upsertFarmer({
    phone: KNOWN_A,
    name: "Rizwan",
    farmName: "Home Farm",
    allowed: true,
    onboardingState: "complete",
  });
  await sheets.upsertFarmer({
    phone: KNOWN_B,
    name: "Second",
    farmName: "Second Farm",
    allowed: true,
    onboardingState: "complete",
  });
  await sheets.upsertFarmer({
    phone: "923000000000",
    name: "No",
    farmName: "No Farm",
    allowed: false,
    onboardingState: "complete",
  });
  const minted = await ensureWebTokens(sheets, { phones: [KNOWN_A, KNOWN_B, "923000000000"] });
  assert.strictEqual(minted.ok, true);
  const linkA = minted.links.find((link) => link.phone === KNOWN_A);
  const linkB = minted.links.find((link) => link.phone === KNOWN_B);
  const linkNo = minted.links.find((link) => link.phone === "923000000000");
  assert.strictEqual(linkA.minted, true);
  assert.strictEqual(tokenLooksValid(linkA.token), true);
  assert.strictEqual(linkB.minted, true);
  assert.strictEqual(linkNo.eligible, false);
  assert.ok(!linkNo.token);
  const second = await ensureWebTokens(sheets, { phones: [KNOWN_A, KNOWN_B] });
  assert.strictEqual(second.links.find((link) => link.phone === KNOWN_A).token, linkA.token);
  assert.strictEqual(second.links.find((link) => link.phone === KNOWN_A).minted, false);

  const express = require("express");
  const httpApp = express();
  httpApp.use(express.json({ limit: "2mb" }));
  const httpSheets = new MemorySheets();
  const farmer = await seedFarmer(httpSheets, PHONE_A, { name: "Ali", farmName: "Al Noor Dairy" });
  mountRecorder(httpApp, httpSheets);
  const server = await listen(httpApp);

  const root = await listen(app);
  const rootRes = await request(root, "GET", "/");
  assert.strictEqual(rootRes.status, 200);
  assert.strictEqual(rootRes.body, "ok");
  const hookGet = await request(root, "GET", "/webhook");
  assert.strictEqual(hookGet.status, 403);
  const hookPost = await request(root, "POST", "/webhook", {
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.strictEqual(hookPost.status, 200);
  assert.strictEqual(hookPost.body, "EVENT_RECEIVED");
  root.close();

  const badPage = await request(server, "GET", `/r/${encodeURIComponent(PHONE_A)}`);
  assert.strictEqual(badPage.status, 404);
  assert.ok(badPage.body.includes(GENERIC_DENY));
  assert.ok(!badPage.body.includes("Al Noor Dairy"));
  assert.ok(!badPage.body.includes(PHONE_A));

  const page = await request(server, "GET", `/r/${farmer.token}`);
  assert.strictEqual(page.status, 200);
  assert.ok(page.body.includes("Record"));
  assert.ok(page.body.includes("Haan"));
  assert.ok(page.body.includes("Nahi"));
  assert.ok(page.body.includes("Edit"));
  assert.ok(page.body.includes("Al Noor Dairy"));
  assert.ok(page.body.includes("/recorder/sw.js"));

  const manifest = await request(server, "GET", `/r/${farmer.token}/manifest.webmanifest`);
  assert.strictEqual(manifest.status, 200);
  assert.ok(/manifest/i.test(manifest.headers["content-type"] || ""));
  const manifestJson = JSON.parse(manifest.body);
  assert.strictEqual(manifestJson.start_url, `/r/${farmer.token}`);
  assert.strictEqual(manifestJson.display, "standalone");

  const icon = await request(server, "GET", "/recorder/icon-192.png");
  assert.strictEqual(icon.status, 200);
  assert.ok((icon.headers["content-type"] || "").includes("image/png"));

  const sw = await request(server, "GET", "/recorder/sw.js");
  assert.strictEqual(sw.status, 200);
  assert.ok(String(sw.headers["service-worker-allowed"] || "").includes("/r/"));

  const badTurn = await request(server, "POST", `/r/${mintWebToken()}/turn`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "aaj 500 mazdoori" }),
  });
  assert.strictEqual(badTurn.status, 404);
  assert.strictEqual(JSON.parse(badTurn.body).error, GENERIC_DENY);

  const noAuth = await request(server, "POST", "/admin/recorder-links", {
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.strictEqual(noAuth.status, 401);

  const admin = await request(server, "POST", "/admin/recorder-links", {
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer unit-test-cron-secret",
    },
    body: JSON.stringify({ phones: [PHONE_A] }),
  });
  assert.strictEqual(admin.status, 200);
  const adminBody = JSON.parse(admin.body);
  assert.strictEqual(adminBody.ok, true);
  assert.strictEqual(adminBody.links.length, 1);
  assert.ok(adminBody.links[0].url.endsWith(`/r/${farmer.token}`));
  assert.strictEqual(adminBody.links[0].minted, false);

  audioLimiter.reset();
  const key = limitKey(farmer.token);
  for (let i = 0; i < AUDIO_LIMIT; i++) assert.strictEqual(audioLimiter.allow(key), true);
  const limited = await request(server, "POST", `/r/${farmer.token}/audio`, {
    headers: { "Content-Type": "audio/webm" },
    body: Buffer.alloc(300, 1),
  });
  assert.strictEqual(limited.status, 429);
  assert.ok(/tez/i.test(JSON.parse(limited.body).error));
  assert.strictEqual(expenseRows(httpSheets, farmer.sheetId).length, 0);

  audioLimiter.reset();
  const turn = await request(server, "POST", `/r/${farmer.token}/turn`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "aaj 500 mazdoori" }),
  });
  assert.strictEqual(turn.status, 200);
  const turnBody = JSON.parse(turn.body);
  assert.strictEqual(turnBody.replies[0].kind, "confirm");
  const no = await request(server, "POST", `/r/${farmer.token}/turn`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "confirm_no" }),
  });
  assert.strictEqual(no.status, 200);
  assert.ok(/nahi likha/i.test(JSON.parse(no.body).replies.map((r) => r.text).join("\n")));
  assert.strictEqual(expenseRows(httpSheets, farmer.sheetId).length, 0);
  await request(server, "POST", `/r/${farmer.token}/turn`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "aaj 500 mazdoori" }),
  });
  const yes = await request(server, "POST", `/r/${farmer.token}/turn`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "confirm_yes" }),
  });
  assert.strictEqual(yes.status, 200);
  assert.ok(/Save ho gaya/i.test(JSON.parse(yes.body).replies.map((r) => r.text).join("\n")));
  assert.strictEqual(expenseRows(httpSheets, farmer.sheetId).length, 1);
  const inbound = await httpSheets.getFarmer(PHONE_A);
  assert.ok(inbound.farmer.lastInboundAt);

  const gs = fs.readFileSync(path.join(__dirname, "../apps-script/Code.gs"), "utf8");
  assert.ok(gs.includes("web_token"));
  assert.ok(gs.includes("setWebToken"));
  assert.ok(gs.includes("findFarmerByToken"));

  server.close();
  console.log("test-recorder ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
