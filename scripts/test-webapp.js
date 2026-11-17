const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.REPLY_SCRIPT = "roman";
process.env.WHATSAPP_DRY_RUN = "1";
delete process.env.ALLOWED_NUMBERS;

const { MemorySheets, createSheets } = require("../lib/sheets");
const { SupabaseSheets } = require("../lib/supabase-store");
const { memoryToSnapshot, snapshotToMemory } = require("../lib/ledger-snapshot");
const {
  memoryFromSheetsExport,
  childRows,
  mergeRows,
  farmerUpserts,
} = require("../lib/import-plan");
const { mintWebToken } = require("../lib/web-token");
const { mountRecorder } = require("../lib/recorder-routes");
const { GENERIC_DENY } = require("../lib/recorder");
const { takeOutbound } = require("../lib/whatsapp");
const { todayISO, TIMEZONE } = require("../lib/config");
const express = require("express");

const PHONE_A = "923100000001";
const PHONE_B = "923100000002";

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

function jsonRequest(server, method, reqPath, payload) {
  const body = payload == null ? null : JSON.stringify(payload);
  return request(server, method, reqPath, {
    headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {},
    body,
  }).then((res) => ({ ...res, json: res.body ? JSON.parse(res.body) : {} }));
}

async function seed(sheets, phone, name) {
  const copy = await sheets.copyLedger({
    phone,
    name,
    farmName: name + " Dairy",
    allowed: true,
    onboardingState: "complete",
  });
  const token = mintWebToken();
  const saved = await sheets.setWebToken(phone, token);
  assert.strictEqual(saved.ok, true);
  return { phone, token, sheetId: copy.sheetId };
}

function col(rows, name) {
  const header = rows[0] || [];
  const index = header.findIndex((item) => String(item).toLowerCase() === name);
  return index;
}

async function main() {
  const migrations = fs.readdirSync(path.join(__dirname, "../supabase/migrations")).filter((name) => name.endsWith(".sql")).sort();
  assert.deepStrictEqual(migrations, [
    "20261117120000_munshi_tables.sql",
    "20261117120100_munshi_snapshot.sql",
  ]);
  const sql = migrations.map((name) => fs.readFileSync(path.join(__dirname, "../supabase/migrations", name), "utf8")).join("\n");
  assert.ok(!/create policy/i.test(sql), "tables stay closed: no public policies");
  for (const table of [
    "farmers", "cows", "milk_records", "customers", "sales", "payments", "expenses",
    "fodder_purchases", "suppliers", "committees", "committee_log", "committee_status",
    "animal_events", "feed_stock", "due_bills", "upcoming_events", "reminders",
    "pending_entries", "processed_messages", "last_writes", "ledger_meta",
  ]) {
    assert.ok(sql.includes(table), table);
  }
  assert.ok(/enable row level security/i.test(sql));
  assert.ok(/force row level security/i.test(sql));
  assert.ok(/revoke all on table/i.test(sql));
  assert.ok(sql.includes("supply_type"));
  assert.ok(sql.includes("web_token"));
  assert.ok(sql.includes("settings"));

  const savedEnv = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SHEETS_WEBHOOK_URL: process.env.SHEETS_WEBHOOK_URL,
  };
  try {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SHEETS_WEBHOOK_URL;
    assert.ok(createSheets() instanceof MemorySheets);
    process.env.SUPABASE_URL = "https://example.supabase.co";
    assert.throws(() => createSheets(), /SUPABASE_SERVICE_ROLE_KEY/);
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-not-a-real-key";
    const nativeWebSocket = globalThis.WebSocket;
    Object.defineProperty(globalThis, "WebSocket", { value: undefined, configurable: true, writable: true });
    try {
      assert.ok(createSheets() instanceof SupabaseSheets);
    } finally {
      Object.defineProperty(globalThis, "WebSocket", {
        value: nativeWebSocket,
        configurable: true,
        writable: true,
      });
    }
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const round = new MemorySheets();
  const farmer = await seed(round, PHONE_A, "Ali");
  round._farmerSettings = { [PHONE_A]: { text_size: "large" } };
  await round.claimReminder({
    phone: PHONE_A,
    date: "2026-11-17",
    slot: "morning",
    sentAt: "2026-11-17T05:00:00Z",
  });
  await round.setPending({
    sender: PHONE_A,
    language: "roman_urdu",
    entries: [{ type: "expense", amount: 1 }],
    status: "pending",
  });
  const savedRecords = await round.commitRecords({
    sender: PHONE_A,
    sheetId: farmer.sheetId,
    entries: [
      { type: "add_cow", cow_name: "Gori", animal_type: "cow" },
      {
        type: "add_customer",
        customer: "Aslam",
        rate_pkr: 200,
        opening_balance: 0,
        supply_type: "fixed",
        daily_litres: 2,
        billing_cycle: "monthly",
      },
      { type: "milk", date: "2026-11-17", session: "am", cow_name: "Gori", litres: 10 },
      {
        type: "sale",
        date: "2026-11-17",
        customer: "Aslam",
        litres: 2,
        rate_pkr: 200,
        amount: 400,
        cash_received: 0,
        balance_added: 400,
      },
      { type: "expense", date: "2026-11-17", category: "labor", amount: 500 },
      {
        type: "fodder",
        date: "2026-11-17",
        item: "wanda",
        quantity: 10,
        unit: "kg",
        cost_pkr: 800,
        supplier: "Raza",
        cash_paid: 300,
        balance_owed: 500,
      },
      { type: "setup_committee", name: "Committee", amount: 200, frequency: "daily" },
      { type: "animal_event", date: "2026-11-17", cow_name: "Gori", event_type: "vet_visit", cost_pkr: 100 },
    ],
  });
  assert.strictEqual(savedRecords.ok, true, savedRecords.error);
  const snap = memoryToSnapshot(round);
  assert.strictEqual(snap.farmers[0].settings.text_size, "large");
  assert.strictEqual(snap.farmers[0].web_token.length > 20, true);
  assert.strictEqual(snap.ledgers[0].suppliers[0].name, "Raza");
  assert.strictEqual(snap.ledgers[0].suppliers[0].balance_owed, 500);
  assert.strictEqual(snap.ledgers[0].customers[0].supply_type, "fixed");
  assert.strictEqual(snap.ledgers[0].customers[0].daily_litres, 2);
  const back = await snapshotToMemory(snap);
  const again = memoryToSnapshot(back);
  assert.strictEqual(again.ledgers[0].milk[0].origin, snap.ledgers[0].milk[0].origin);
  assert.strictEqual(again.ledgers[0].milk[0].litres, 10);
  assert.strictEqual(again.farmers[0].settings.text_size, "large");
  const found = await back.findFarmerByToken(snap.farmers[0].web_token);
  assert.strictEqual(found.farmer.phone, PHONE_A);
  const claimed = await back.claimReminder({ phone: PHONE_A, date: "2026-11-17", slot: "morning" });
  assert.strictEqual(claimed.already, true);
  const pending = await back.getPending(PHONE_A);
  assert.strictEqual(pending.pending.entries[0].type, "expense");
  const recent = await back.readRecent({ days: 30, refresh: false, sender: PHONE_A, sheetId: farmer.sheetId });
  const milkLitres = col(recent.milk, "litres");
  assert.strictEqual(Number(recent.milk[1][milkLitres]), 10);
  const supplyCol = col(recent.customers, "supply_type");
  const dailyCol = col(recent.customers, "daily_litres");
  assert.strictEqual(String(recent.customers[1][supplyCol]), "fixed");
  assert.strictEqual(Number(recent.customers[1][dailyCol]), 2);

  const exportFarmers = [{
    phone: "923001112233",
    sheetId: "sheet-1",
    name: "Ali",
    farmName: "Dairy",
    allowed: true,
    onboardingState: "complete",
    createdAt: "2026-11-01T00:00:00",
    webToken: mintWebToken(),
  }];
  const grids = {
    "sheet-1": {
      cows: [["cow_id", "name", "type", "status"], ["C-001", "Gori", "cow", "milking"]],
      milk: [["date", "session", "cow_name", "litres", "source_note"], ["2026-11-01", "am", "Gori", 12, "note"]],
      customers: [[
        "name", "phone", "rate_pkr", "opening_balance", "current_balance", "notes",
        "billing_cycle", "cycle_start_date", "supply_type", "daily_litres",
      ], ["Aslam", "", 180, 0, 180, "", "daily", "", "fixed", 2]],
      expenses: [["date", "category", "amount", "note"], ["2026-11-02", "salary", 2000, "tankhwah"]],
      fodder: [[
        "date", "item", "quantity", "unit", "cost_pkr", "supplier", "cash_paid", "balance_owed", "source_note",
      ], ["2026-11-02", "wanda", 5, "kg", 400, "Kamal", 0, 400, ""]],
    },
  };
  const imported = memoryToSnapshot(await memoryFromSheetsExport({ farmers: exportFarmers, ledgers: grids }));
  const milkOrigin = imported.ledgers[0].milk[0].origin;
  assert.strictEqual(milkOrigin, "sheets:sheet-1:Milk_Log:1");
  assert.strictEqual(imported.ledgers[0].milk[0].litres, 12);
  assert.strictEqual(imported.ledgers[0].customers[0].supply_type, "fixed");
  assert.strictEqual(imported.ledgers[0].customers[0].daily_litres, 2);
  assert.strictEqual(imported.ledgers[0].expenses[0].category, "salary");
  assert.strictEqual(imported.ledgers[0].suppliers[0].balance_owed, 400);
  assert.strictEqual(farmerUpserts(imported)[0].web_token.length > 20, true);
  const changed = JSON.parse(JSON.stringify(grids));
  changed["sheet-1"].milk[1][3] = 9;
  const importedAgain = memoryToSnapshot(await memoryFromSheetsExport({ farmers: exportFarmers, ledgers: changed }));
  assert.strictEqual(importedAgain.ledgers[0].milk[0].origin, milkOrigin);
  assert.strictEqual(importedAgain.ledgers[0].milk[0].litres, 9);
  const ids = new Map([["923001112233", "farmer-1"]]);
  let milkRows = mergeRows(
    [{ origin: "app:extra", litres: 1, farmer_id: "farmer-1" }],
    childRows(imported, ids).milk_records,
    "origin"
  );
  milkRows = mergeRows(milkRows, childRows(importedAgain, ids).milk_records, "origin");
  assert.strictEqual(milkRows.length, 2);
  assert.strictEqual(milkRows.find((row) => row.origin === milkOrigin).litres, 9);
  assert.strictEqual(milkRows.find((row) => row.origin === "app:extra").litres, 1);
  assert.strictEqual(milkRows.find((row) => row.origin === milkOrigin).farmer_id, "farmer-1");

  const sheets = new MemorySheets();
  const a = await seed(sheets, PHONE_A, "Ali");
  const b = await seed(sheets, PHONE_B, "Bano");
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  mountRecorder(app, sheets);
  const server = await listen(app);
  const today = todayISO(TIMEZONE);

  const missing = await jsonRequest(server, "GET", `/r/${mintWebToken()}/api/aaj`);
  assert.strictEqual(missing.status, 404);
  assert.strictEqual(missing.json.error, GENERIC_DENY);
  assert.ok(!missing.body.includes("Ali Dairy"));

  const page = await request(server, "GET", `/r/${a.token}`);
  assert.strictEqual(page.status, 200);
  assert.ok(page.body.includes("Record"));
  assert.ok(page.body.includes("Haan"));
  assert.ok(page.body.includes("Nahi"));
  assert.ok(page.body.includes("Edit"));
  assert.ok(page.body.includes("Bolein"));
  assert.ok(page.body.includes("Aaj"));
  assert.ok(page.body.includes("Grahak"));
  assert.ok(page.body.includes("Khata"));
  assert.ok(page.body.includes("Hisaab"));
  assert.ok(page.body.includes("Ali Dairy"));

  takeOutbound();
  const draft = await jsonRequest(server, "POST", `/r/${a.token}/turn`, { text: "aaj 500 mazdoori" });
  assert.strictEqual(draft.status, 200);
  assert.strictEqual(draft.json.replies[0].kind, "confirm");
  const yes = await jsonRequest(server, "POST", `/r/${a.token}/turn`, { action: "confirm_yes" });
  assert.strictEqual(yes.status, 200);
  assert.ok(/Save ho gaya/i.test(yes.json.replies.map((reply) => reply.text).join("\n")));
  assert.strictEqual(takeOutbound().length, 0);
  const khata = await jsonRequest(server, "GET", `/r/${a.token}/api/khata`);
  assert.strictEqual(khata.status, 200);
  assert.strictEqual(khata.json.expenses.length, 1);
  assert.strictEqual(khata.json.expenses[0].category, "labor");
  assert.strictEqual(khata.json.expenses[0].amount, 500);
  assert.strictEqual(khata.json.expenses[0].label, "mazdoori");

  takeOutbound();
  const added = await jsonRequest(server, "POST", `/r/${a.token}/api/aaj`, {
    op: "add",
    cow_name: "Gori",
    session: "subah",
    litres: 10,
    date: today,
  });
  assert.strictEqual(added.status, 200, added.body);
  assert.strictEqual(takeOutbound().length, 0);
  const aaj = await jsonRequest(server, "GET", `/r/${a.token}/api/aaj`);
  assert.strictEqual(aaj.json.milk_litres, 10);
  assert.strictEqual(aaj.json.unsold_litres, 10);
  assert.ok(aaj.json.cows.some((cow) => cow.name === "Gori" && cow.subah === 10));

  const hisaab = await jsonRequest(server, "GET", `/r/${a.token}/api/hisaab?range=week`);
  assert.strictEqual(hisaab.status, 200);
  assert.strictEqual(hisaab.json.range, "week");
  assert.ok(hisaab.json.milk_litres >= 10);
  assert.strictEqual(hisaab.json.expenses, 500);
  const month = await jsonRequest(server, "GET", `/r/${a.token}/api/hisaab?range=month`);
  assert.strictEqual(month.json.range, "month");
  assert.ok(month.json.milk_litres >= 10);

  const edited = await jsonRequest(server, "POST", `/r/${a.token}/api/aaj`, {
    op: "update",
    date: today,
    session: "am",
    cow_name: "Gori",
    litres: 10,
    new_litres: 8,
  });
  assert.strictEqual(edited.status, 200, edited.body);
  assert.strictEqual(edited.json.milk_litres, 8);

  const blockedDelete = await jsonRequest(server, "POST", `/r/${a.token}/api/aaj`, {
    op: "delete",
    date: today,
    session: "am",
    cow_name: "Gori",
    litres: 8,
  });
  assert.strictEqual(blockedDelete.status, 400);
  assert.ok(/confirm/i.test(blockedDelete.json.error));
  const still = await jsonRequest(server, "GET", `/r/${a.token}/api/aaj`);
  assert.strictEqual(still.json.milk_litres, 8);
  const removed = await jsonRequest(server, "POST", `/r/${a.token}/api/aaj`, {
    op: "delete",
    confirm: true,
    date: today,
    session: "am",
    cow_name: "Gori",
    litres: 8,
  });
  assert.strictEqual(removed.status, 200, removed.body);
  assert.strictEqual(removed.json.milk_litres, 0);

  await sheets.commitRecords({
    sender: PHONE_A,
    sheetId: a.sheetId,
    entries: [{ type: "add_customer", customer: "Aslam", rate_pkr: 200, opening_balance: 0 }],
  });
  const sale = await jsonRequest(server, "POST", `/r/${a.token}/api/aaj`, {
    op: "add_sale",
    customer: "Aslam",
    litres: 2,
    date: today,
  });
  assert.strictEqual(sale.status, 200, sale.body);
  const pay = await jsonRequest(server, "POST", `/r/${a.token}/api/grahak`, {
    op: "pay",
    customer: "Aslam",
    amount: 150,
    date: today,
  });
  assert.strictEqual(pay.status, 200, pay.body);
  const grahak = await jsonRequest(server, "GET", `/r/${a.token}/api/grahak`);
  const aslam = grahak.json.customers.find((row) => row.name === "Aslam");
  assert.ok(aslam, "customer missing");
  assert.strictEqual(aslam.balance, 250);
  const other = await jsonRequest(server, "GET", `/r/${b.token}/api/aaj`);
  assert.strictEqual(other.status, 200);
  assert.strictEqual(other.json.milk_litres, 0);
  assert.strictEqual(other.json.sold_litres, 0);
  const otherKhata = await jsonRequest(server, "GET", `/r/${b.token}/api/khata`);
  assert.strictEqual(otherKhata.json.expenses.length, 0);
  const hidden = await jsonRequest(server, "GET", `/r/${b.token}/api/grahak`);
  assert.ok(!(hidden.json.customers || []).some((row) => row.name === "Aslam"));

  const kept = await jsonRequest(server, "POST", `/r/${a.token}/api/grahak`, {
    op: "delete_payment",
    date: today,
    customer: "Aslam",
    amount: 150,
  });
  assert.strictEqual(kept.status, 400);
  const gone = await jsonRequest(server, "POST", `/r/${a.token}/api/grahak`, {
    op: "delete_payment",
    confirm: true,
    date: today,
    customer: "Aslam",
    amount: 150,
  });
  assert.strictEqual(gone.status, 200, gone.body);
  assert.strictEqual(gone.json.customers.find((row) => row.name === "Aslam").balance, 400);

  server.close();
  console.log("test-webapp ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
