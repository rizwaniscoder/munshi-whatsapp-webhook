delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.MASTER_PHONE;
delete process.env.ALLOWED_NUMBERS;
process.env.WHATSAPP_DRY_RUN = "1";
process.env.REPLY_SCRIPT = "roman";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
const { MASTER_PHONE, isMasterPhone } = require("../lib/config");
const { MemorySheets } = require("../lib/sheets");
const { memoryToSnapshot } = require("../lib/ledger-snapshot");
const { mintWebToken } = require("../lib/web-token");
const { mountRecorder } = require("../lib/recorder-routes");
const { sourceFromNote } = require("../lib/history");
const { todayISO, TIMEZONE } = require("../lib/config");

assert.strictEqual(MASTER_PHONE, "");
assert.strictEqual(isMasterPhone("923155506704"), false);
assert.strictEqual(isMasterPhone(""), false);
assert.strictEqual(sourceFromNote("WhatsApp 923000000000"), "whatsapp");
assert.strictEqual(sourceFromNote("Web 923000000000"), "voice");
assert.strictEqual(sourceFromNote("Manual 923000000000"), "manual");
assert.strictEqual(sourceFromNote("Screen 923000000000"), "manual");

const migrationsDir = path.join(__dirname, "../supabase/migrations");
const historySql = fs.readFileSync(path.join(migrationsDir, "20261120120000_record_history.sql"), "utf8");
assert.ok(/create table public\.record_history/i.test(historySql));
assert.ok(/farmer_id uuid/i.test(historySql));
assert.ok(/farmer_phone text/i.test(historySql));
assert.ok(/table_name text not null/i.test(historySql));
assert.ok(/record_id text not null/i.test(historySql));
assert.ok(/old_values jsonb/i.test(historySql));
assert.ok(/new_values jsonb/i.test(historySql));
assert.ok(/source text not null/i.test(historySql));
assert.ok(/created_at timestamptz/i.test(historySql));
assert.ok(/enable row level security/i.test(historySql));
assert.ok(/force row level security/i.test(historySql));
assert.ok(/append_record_history/i.test(historySql));
assert.ok(!/references public\.farmers/i.test(historySql));
assert.ok(!/delete\s+from\s+public\.record_history/i.test(historySql));
for (const name of fs.readdirSync(migrationsDir)) {
  const sql = fs.readFileSync(path.join(migrationsDir, name), "utf8");
  assert.ok(!/delete\s+from\s+public\.record_history/i.test(sql), name + " must not wipe history");
}
const snapshotSql = fs.readFileSync(path.join(migrationsDir, "20261119000000_fix_snapshot_delete_where.sql"), "utf8");
assert.ok(!/record_history/i.test(snapshotSql));

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function request(server, method, reqPath, payload) {
  const body = payload == null ? null : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        method,
        path: reqPath,
        headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = {};
          try { json = text ? JSON.parse(text) : {}; } catch (err) { json = { raw: text }; }
          resolve({ status: res.statusCode, body: text, json });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
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
  await sheets.setWebToken(phone, token);
  return { phone, token, sheetId: copy.sheetId };
}

async function main() {
  const sheets = new MemorySheets();
  const farm = await seed(sheets, "923200000111", "Noman");
  const other = await seed(sheets, "923200000222", "Bano");
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  mountRecorder(app, sheets);
  const server = await listen(app);
  const today = todayISO(TIMEZONE);
  const base = `/r/${farm.token}`;

  const page = await request(server, "GET", base);
  assert.strictEqual(page.status, 200);
  assert.ok(page.body.includes("Likhein"));
  assert.ok(page.body.includes("Tareekh"));
  assert.ok(page.body.includes(">Bolein<"));
  assert.ok(!page.body.includes("🎤"));
  assert.ok(
    /\.chat-pane\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(page.body),
    "chat pane must stay hidden when another tab is open"
  );
  assert.ok(
    /\.party-row > span\.avatar\s*\{[^}]*display:\s*flex/.test(page.body),
    "avatar initials stay centred inside the circle"
  );
  assert.ok(page.body.includes("Wapas layein?"));
  assert.ok(page.body.includes("Haan, wapas layein"));
  assert.ok(page.body.includes("Pakka hatana hai?"));
  assert.ok(/body && body\.op === "restore"/.test(page.body));
  assert.ok(!/\.party-row strong,\s*\.party-row span\s*\{[^}]*display:\s*block/.test(page.body));

  const milk = await request(server, "POST", base + "/api/manual", {
    kind: "milk",
    cow_name: "Gori",
    session: "am",
    litres: 12,
    date: today,
  });
  assert.strictEqual(milk.status, 200, milk.body);
  assert.ok(milk.json.id);
  const milkId = milk.json.id;
  const edited = await request(server, "POST", base + "/api/manual", {
    kind: "milk",
    id: milkId,
    cow_name: "Gori",
    session: "am",
    litres: 9,
    date: today,
  });
  assert.strictEqual(edited.status, 200, edited.body);
  const aaj = await request(server, "GET", base + "/api/aaj");
  assert.strictEqual(aaj.json.milk_litres, 9);

  const blocked = await request(server, "POST", base + "/api/manual", { kind: "milk", op: "delete", id: milkId });
  assert.strictEqual(blocked.status, 400);
  const removed = await request(server, "POST", base + "/api/manual", { kind: "milk", op: "delete", id: milkId, confirm: true });
  assert.strictEqual(removed.status, 200, removed.body);
  const gone = await request(server, "GET", base + "/api/aaj");
  assert.strictEqual(gone.json.milk_litres, 0);
  const restored = await request(server, "POST", base + "/api/tareekh", { op: "restore", record_id: milkId, confirm: true });
  assert.strictEqual(restored.status, 200, restored.body);
  const back = await request(server, "GET", base + "/api/aaj");
  assert.strictEqual(back.json.milk_litres, 9);

  await request(server, "POST", base + "/api/manual", {
    kind: "customer",
    name: "Aslam",
    rate_pkr: 200,
    opening_balance: 100,
    supply_type: "fixed",
    daily_litres: 2,
    billing_cycle: "monthly",
  });
  const udhaar = await request(server, "POST", base + "/api/manual", {
    kind: "sale",
    customer: "Aslam",
    litres: 2,
    date: today,
  });
  assert.strictEqual(udhaar.status, 200, udhaar.body);
  const udhaarRow = udhaar.json.records.find((row) => row.kind === "sale");
  assert.strictEqual(udhaarRow.rate_pkr, 200);
  assert.strictEqual(udhaarRow.amount, 400);
  assert.strictEqual(udhaarRow.balance_added, 400);
  const nagd = await request(server, "POST", base + "/api/manual", {
    kind: "sale",
    customer: "Aslam",
    litres: 1,
    pay: "nagd",
    date: today,
  });
  assert.strictEqual(nagd.status, 200, nagd.body);
  await request(server, "POST", base + "/api/manual", {
    kind: "payment",
    customer: "Aslam",
    amount: 50,
    date: today,
  });
  await request(server, "POST", base + "/api/manual", {
    kind: "customer_adjust",
    customer: "Aslam",
    direction: "debit",
    amount: 25,
    note: "purana udhaar",
    date: today,
  });
  await request(server, "POST", base + "/api/manual", {
    kind: "customer_adjust",
    customer: "Aslam",
    direction: "credit",
    amount: 10,
    note: "maafi",
    date: today,
  });
  const ledger = await request(server, "GET", base + "/api/ledger?kind=customer&name=Aslam");
  assert.strictEqual(ledger.status, 200, ledger.body);
  assert.strictEqual(ledger.json.balance, 465);
  assert.ok(ledger.json.lines.some((line) => line.label === "Shuruati baqi" && line.debit === 100));
  assert.ok(ledger.json.lines.some((line) => line.label === "Jama" && line.debit === 25));
  assert.ok(ledger.json.lines.some((line) => line.label === "Credit" && line.credit === 10));
  const grahak = await request(server, "GET", base + "/api/grahak");
  assert.strictEqual(grahak.json.customers.find((row) => row.name === "Aslam").balance, 465);

  const saleId = udhaarRow.id;
  const changed = await request(server, "POST", base + "/api/manual", {
    kind: "sale",
    id: saleId,
    customer: "Aslam",
    litres: 3,
    rate_pkr: 200,
    date: today,
  });
  assert.strictEqual(changed.status, 200, changed.body);
  const afterEdit = await request(server, "GET", base + "/api/ledger?kind=customer&name=Aslam");
  assert.strictEqual(afterEdit.json.balance, 665);

  await request(server, "POST", base + "/api/manual", {
    kind: "supplier",
    name: "Raza",
    opening_balance: 40,
    date: today,
  });
  await request(server, "POST", base + "/api/manual", {
    kind: "fodder",
    item: "wanda",
    supplier: "Raza",
    quantity: 10,
    unit: "kg",
    cost_pkr: 800,
    cash_paid: 300,
    date: today,
  });
  await request(server, "POST", base + "/api/manual", {
    kind: "supplier_payment",
    supplier: "Raza",
    amount: 100,
    note: "ada",
    date: today,
  });
  const supplier = await request(server, "GET", base + "/api/ledger?kind=supplier&name=Raza");
  assert.strictEqual(supplier.status, 200, supplier.body);
  assert.strictEqual(supplier.json.balance, 440);
  const razaList = await request(server, "GET", base + "/api/party");
  const raza = razaList.json.suppliers.find((row) => row.name === "Raza");
  assert.strictEqual(raza.balance, -440);
  assert.strictEqual(raza.side, "Dene hain");
  assert.strictEqual(supplier.json.signed_balance, raza.balance);
  const lastBaqi = supplier.json.lines[supplier.json.lines.length - 1];
  assert.strictEqual(lastBaqi.signed_balance, raza.balance);
  assert.ok(lastBaqi.signed_balance < 0, "supplier ledger baqi uses the same sign as the party list");
  const khata = await request(server, "GET", base + "/api/khata");
  assert.strictEqual(khata.json.suppliers.find((row) => row.name === "Raza").balance_owed, 440);

  const expense = await request(server, "POST", base + "/api/manual", {
    kind: "expense",
    category: "labor",
    amount: 500,
    note: "mazdoor",
    date: today,
  });
  assert.strictEqual(expense.status, 200, expense.body);
  const expenseId = expense.json.records.find((row) => row.kind === "expense").id;
  await request(server, "POST", base + "/api/manual", {
    kind: "expense",
    id: expenseId,
    category: "salary",
    amount: 700,
    note: "tankhwah",
    date: today,
  });
  const expenses = await request(server, "GET", base + "/api/manual?kind=expense");
  assert.strictEqual(expenses.json.records[0].amount, 700);
  assert.strictEqual(expenses.json.records[0].category, "salary");

  assert.strictEqual((await request(server, "POST", base + "/api/manual", {
    kind: "committee",
    name: "Bazar",
    amount: 200,
    frequency: "daily",
    start_date: today,
  })).status, 200);
  assert.strictEqual((await request(server, "POST", base + "/api/manual", {
    kind: "committee_log",
    committee: "Bazar",
    status: "paid",
    amount: 200,
    date: today,
  })).status, 200);
  assert.strictEqual((await request(server, "POST", base + "/api/manual", {
    kind: "committee_log",
    committee: "Bazar",
    status: "not_paid",
    date: today,
  })).status, 200);
  assert.strictEqual((await request(server, "POST", base + "/api/manual", {
    kind: "animal",
    cow: "Gori",
    event_type: "vet_visit",
    doctor_name: "Ali",
    cost_pkr: 150,
    date: today,
  })).status, 200);
  assert.strictEqual((await request(server, "POST", base + "/api/manual", {
    kind: "feed",
    item: "wanda",
    quantity: 50,
    unit: "kg",
    daily_use: 2,
  })).status, 200);
  assert.strictEqual((await request(server, "POST", base + "/api/manual", {
    kind: "cow",
    name: "Lali",
    animal_type: "buffalo",
    status: "milking",
  })).status, 200);

  const listed = await request(server, "GET", base + "/api/manual");
  assert.ok(listed.json.records.some((row) => row.kind === "animal"));
  assert.ok(listed.json.records.some((row) => row.kind === "cow" && row.name === "Lali"));
  assert.ok(listed.json.records.some((row) => row.kind === "committee_log"));

  await sheets.commitRecords({
    sender: farm.phone,
    sheetId: farm.sheetId,
    sourceNote: "WhatsApp " + farm.phone,
    entries: [{ type: "expense", date: today, category: "fuel", amount: 80, note: "diesel" }],
  });
  await sheets.commitRecords({
    sender: farm.phone,
    sheetId: farm.sheetId,
    sourceNote: "Web " + farm.phone,
    entries: [{ type: "expense", date: today, category: "medicine", amount: 30 }],
  });

  const history = sheets._history.filter((event) => event.farmer_phone === farm.phone);
  assert.ok(history.some((event) => event.action === "create" && event.source === "manual" && event.table_name === "milk_records"));
  assert.ok(history.some((event) => event.action === "update" && event.source === "manual" && event.record_id === milkId));
  assert.ok(history.some((event) => event.action === "delete" && event.source === "manual" && event.record_id === milkId));
  assert.ok(history.some((event) => event.action === "create" && event.source === "whatsapp" && event.table_name === "expenses"));
  assert.ok(history.some((event) => event.action === "create" && event.source === "voice" && event.table_name === "expenses"));
  const snap = memoryToSnapshot(sheets);
  assert.ok(!Object.prototype.hasOwnProperty.call(snap, "history"));
  assert.ok(sheets._history.length > 0);

  const filtered = await request(server, "GET", base + "/api/tareekh?account=Aslam");
  assert.ok(filtered.json.events.length > 0);
  assert.ok(filtered.json.events.every((event) => {
    const blob = JSON.stringify(event.old_values || {}) + JSON.stringify(event.new_values || {});
    return /aslam/i.test(blob);
  }));
  const one = await request(server, "GET", base + "/api/tareekh?record=" + encodeURIComponent(milkId));
  assert.ok(one.json.events.every((event) => event.record_id === milkId));

  const hidden = await request(server, "GET", `/r/${other.token}/api/tareekh`);
  assert.ok(!(hidden.json.events || []).some((event) => event.record_id === milkId));
  const otherLedger = await request(server, "GET", `/r/${other.token}/api/grahak`);
  assert.ok(!(otherLedger.json.customers || []).some((row) => row.name === "Aslam"));

  const party = await request(server, "GET", base + "/api/party");
  assert.strictEqual(party.status, 200, party.body);
  assert.ok(party.json.milne >= 665);
  assert.ok(party.json.dene >= 440);
  assert.ok(party.json.customers.some((row) => row.name === "Aslam" && row.tone === "milne" && row.side === "Milne hain"));
  const aslamLedger = await request(server, "GET", base + "/api/party?kind=customer&name=Aslam");
  assert.ok(aslamLedger.json.lines.some((line) => line.diye > 0));
  assert.ok(aslamLedger.json.lines.some((line) => line.liye > 0));
  const archived = await request(server, "POST", base + "/api/party", { op: "archive", kind: "customer", name: "Aslam" });
  assert.strictEqual(archived.status, 200, archived.body);
  const afterArchive = await request(server, "GET", base + "/api/party");
  assert.strictEqual(afterArchive.json.customers.find((row) => row.name === "Aslam").archived, true);
  const pdf = await request(server, "GET", base + "/api/party.pdf");
  assert.ok(String(pdf.json.pdf || "").startsWith("JVBER"));
  const bank = await request(server, "POST", base + "/api/party", { op: "bank", name: "Cash", opening_balance: 1000 });
  assert.strictEqual(bank.status, 200, bank.body);
  assert.ok((bank.json.banks || []).some((row) => row.name === "Cash"));
  const cashIn = await request(server, "POST", base + "/api/party", {
    op: "entry",
    kind: "bank",
    name: "Cash",
    direction: "liye",
    amount: 50,
    note: "nagd",
    date: today,
  });
  assert.strictEqual(cashIn.status, 200, cashIn.body);
  assert.strictEqual(cashIn.json.balance, 1050);

  const said = await request(server, "POST", base + "/turn", { text: "aaj 20 chai", thread: "day:" + today });
  assert.strictEqual(said.status, 200, said.body);
  const chat = await request(server, "GET", base + "/api/chat?thread=day:" + today);
  assert.ok((chat.json.messages || []).some((row) => row.role === "farmer" && /chai/.test(row.content)));
  assert.ok((chat.json.messages || []).some((row) => row.role === "munshi"));
  const fresh = await request(server, "POST", base + "/api/chat", { op: "new" });
  assert.ok(String(fresh.json.thread_id || "").startsWith("chat:"));
  const found = await request(server, "GET", base + "/api/chat?threads=1&q=chai");
  assert.ok((found.json.threads || []).some((row) => String(row.thread_id).indexOf(today) >= 0));

  const bought = await request(server, "POST", base + "/api/manual", {
    kind: "fodder",
    item: "silage",
    supplier: "Sadiq",
    quantity: 6,
    unit: "kg",
    cost_pkr: 900,
    cash_paid: 0,
    date: today,
  });
  assert.strictEqual(bought.status, 200, bought.body);
  const more = await request(server, "POST", base + "/api/manual", {
    kind: "fodder",
    item: "silage",
    supplier: "Sadiq",
    quantity: 2,
    unit: "kg",
    cost_pkr: 200,
    cash_paid: 200,
    date: today,
  });
  assert.strictEqual(more.status, 200, more.body);
  const stockOn = await request(server, "GET", base + "/api/manual?kind=feed");
  const silage = (stockOn.json.records || []).find((row) => String(row.item).toLowerCase() === "silage");
  assert.ok(silage, "fodder purchase inserts feed stock");
  assert.strictEqual(silage.quantity, 8);
  const silageRows = bought.json.records.filter((row) => row.kind === "fodder" && row.supplier === "Sadiq" && row.quantity === 6);
  assert.strictEqual(silageRows.length, 1);
  const silageId = silageRows[0].id;
  const blockedStock = await request(server, "POST", base + "/api/manual", { op: "delete", kind: "fodder", id: silageId });
  assert.strictEqual(blockedStock.status, 400);
  const stillStock = await request(server, "GET", base + "/api/manual?kind=feed");
  assert.strictEqual(stillStock.json.records.find((row) => String(row.item).toLowerCase() === "silage").quantity, 8);
  const editedStock = await request(server, "POST", base + "/api/manual", {
    kind: "fodder",
    id: silageId,
    item: "khal",
    supplier: "Sadiq",
    quantity: 4,
    unit: "kg",
    cost_pkr: 900,
    cash_paid: 0,
    date: today,
  });
  assert.strictEqual(editedStock.status, 200, editedStock.body);
  const afterEditStock = await request(server, "GET", base + "/api/manual?kind=feed");
  assert.strictEqual(afterEditStock.json.records.find((row) => String(row.item).toLowerCase() === "silage").quantity, 2);
  assert.strictEqual(afterEditStock.json.records.find((row) => String(row.item).toLowerCase() === "khal").quantity, 4);
  const removedStock = await request(server, "POST", base + "/api/manual", {
    op: "delete",
    kind: "fodder",
    id: silageId,
    confirm: true,
  });
  assert.strictEqual(removedStock.status, 200, removedStock.body);
  const afterDeleteStock = await request(server, "GET", base + "/api/manual?kind=feed");
  assert.ok(!(afterDeleteStock.json.records || []).some((row) => String(row.item).toLowerCase() === "khal"));
  assert.strictEqual(afterDeleteStock.json.records.find((row) => String(row.item).toLowerCase() === "silage").quantity, 2);
  const leftBuy = (await request(server, "GET", base + "/api/manual?kind=fodder")).json.records.find((row) => row.supplier === "Sadiq" && row.item === "silage");
  assert.ok(leftBuy && leftBuy.id);
  const cleared = await request(server, "POST", base + "/api/manual", {
    op: "delete",
    kind: "fodder",
    id: leftBuy.id,
    confirm: true,
  });
  assert.strictEqual(cleared.status, 200, cleared.body);
  const emptyStock = await request(server, "GET", base + "/api/manual?kind=feed");
  assert.ok(!(emptyStock.json.records || []).some((row) => String(row.item).toLowerCase() === "silage"));
  assert.ok(!(emptyStock.json.records || []).some((row) => String(row.item).toLowerCase() === "khal"));

  const quiet = `/r/${other.token}`;
  assert.strictEqual((await request(server, "POST", quiet + "/api/manual", {
    kind: "customer", name: "Sana", rate_pkr: 100, date: today,
  })).status, 200);
  assert.strictEqual((await request(server, "POST", quiet + "/api/manual", {
    kind: "payment", customer: "Sana", amount: 50, date: today,
  })).status, 200);
  const aajWasool = await request(server, "GET", quiet + "/api/aaj");
  assert.strictEqual(aajWasool.json.wasool, 50, aajWasool.body);
  const weekWasool = await request(server, "GET", quiet + "/api/hisaab?range=week");
  assert.strictEqual(weekWasool.json.wasool, 50, weekWasool.body);
  assert.strictEqual((await request(server, "POST", quiet + "/api/manual", {
    kind: "sale", customer: "Sana", litres: 1, rate_pkr: 20, pay: "nagd", date: today,
  })).status, 200);
  assert.strictEqual((await request(server, "GET", quiet + "/api/aaj")).json.wasool, 70);
  assert.strictEqual((await request(server, "GET", quiet + "/api/hisaab?range=week")).json.wasool, 70);

  const booked = await request(server, "POST", quiet + "/turn", { text: "aaj 500 mazdoori", thread: "day:" + today });
  assert.strictEqual(booked.status, 200, booked.body);
  assert.strictEqual(booked.json.replies[0].kind, "confirm");
  const bookedChat = await request(server, "GET", quiet + "/api/chat?thread=day:" + today);
  const farmerMsg = (bookedChat.json.messages || []).find((row) => row.role === "farmer");
  const munshiMsg = [...(bookedChat.json.messages || [])].reverse().find((row) => row.payload && row.payload.kind === "confirm");
  assert.ok(munshiMsg, "bookable line stores a confirm card");
  assert.strictEqual(munshiMsg.payload.state, "open");
  assert.deepStrictEqual((munshiMsg.payload.actions || []).map((action) => action.id), ["confirm_yes", "confirm_no", "confirm_edit"]);
  assert.ok(farmerMsg && munshiMsg.created_at > farmerMsg.created_at, "confirm card sorts after the farmer line");

  assert.ok(page.body.includes("Kul litre"));
  assert.ok(page.body.includes('op: "add_day"'));
  assert.ok(page.body.includes('chipPicker([["am", "Subah"], ["pm", "Shaam"]], "am"'));
  assert.ok(!page.body.includes("Gaye ke hisaab se (optional)"));
  assert.ok(!page.body.includes('el("h2", "Becha")'));
  assert.ok(page.body.includes("Zyada"));
  const doodhAt = page.body.indexOf('el("h2", "Doodh likhein")');
  const cowLoopAt = page.body.indexOf("for (const cow of data.cows || [])");
  assert.ok(doodhAt > 0 && cowLoopAt > doodhAt);

  const milkFarm = await seed(sheets, "923200000333", "Latif");
  const milkBase = `/r/${milkFarm.token}`;
  const totalOnly = await request(server, "POST", milkBase + "/api/aaj", {
    op: "add_day",
    session: "am",
    litres: 40,
  });
  assert.strictEqual(totalOnly.status, 200, totalOnly.body);
  const totalAaj = await request(server, "GET", milkBase + "/api/aaj");
  assert.strictEqual(totalAaj.json.milk_litres, 40);
  assert.strictEqual(totalAaj.json.unsold_litres, 40);
  assert.ok(!(totalAaj.json.cows || []).some((row) => String(row.name).toLowerCase() === "kul"));
  assert.strictEqual((await request(server, "POST", milkBase + "/api/aaj", {
    op: "add_sale", customer: "Pakistan hotel", litres: 10, rate_pkr: 200,
  })).status, 200);
  assert.strictEqual((await request(server, "POST", milkBase + "/api/aaj", {
    op: "add_sale", customer: "Tabarak", litres: 5, rate_pkr: 180,
  })).status, 200);
  const withSales = await request(server, "GET", milkBase + "/api/aaj");
  assert.strictEqual(withSales.json.milk_litres, 40);
  assert.strictEqual(withSales.json.sold_litres, 15);
  assert.strictEqual(withSales.json.unsold_litres, 25);
  assert.strictEqual(withSales.json.sales.length, 2);
  assert.strictEqual((await request(server, "POST", milkBase + "/api/aaj", {
    op: "add", cow_name: "Gori", session: "am", litres: 18,
  })).status, 200);
  const withCow = await request(server, "GET", milkBase + "/api/aaj");
  assert.strictEqual(withCow.json.milk_litres, 40, "per-cow litres sit beside the total");
  assert.ok(withCow.json.cows.some((row) => row.name === "Gori" && row.subah === 18));
  const milkWeek = await request(server, "GET", milkBase + "/api/hisaab?range=week");
  assert.strictEqual(milkWeek.json.milk_litres, 40);

  const voiceFarm = await seed(sheets, "923200000444", "Rashid");
  const voiceBase = `/r/${voiceFarm.token}`;
  assert.strictEqual((await request(server, "POST", voiceBase + "/api/manual", {
    kind: "customer", name: "Pakistan hotel", rate_pkr: 200,
  })).status, 200);
  assert.strictEqual((await request(server, "POST", voiceBase + "/api/manual", {
    kind: "customer", name: "Tabarak", rate_pkr: 180,
  })).status, 200);
  const heard = await request(server, "POST", voiceBase + "/turn", {
    text: "aaj subah 40 litre hua, 10 Pakistan hotel ko, 5 Tabarak ko",
    thread: "day:" + today,
  });
  assert.strictEqual(heard.status, 200, heard.body);
  assert.strictEqual(heard.json.replies[0].kind, "confirm");
  const heardText = JSON.stringify(heard.json.replies[0]);
  assert.match(heardText, /40/);
  assert.match(heardText, /Pakistan hotel/);
  assert.match(heardText, /Tabarak/);
  assert.doesNotMatch(heardText, /Gay ka naam/);
  const heardChat = await request(server, "GET", voiceBase + "/api/chat?thread=day:" + today);
  const heardCard = [...(heardChat.json.messages || [])].reverse().find((row) => row.payload && row.payload.kind === "confirm");
  assert.ok(heardCard, "milk sentence stores a confirm card");
  assert.strictEqual(heardCard.payload.state, "open");
  const savedVoice = await request(server, "POST", voiceBase + "/turn", {
    action: "confirm_yes",
    thread: "day:" + today,
  });
  assert.strictEqual(savedVoice.status, 200, savedVoice.body);
  const voiceAaj = await request(server, "GET", voiceBase + "/api/aaj");
  assert.strictEqual(voiceAaj.json.milk_litres, 40, voiceAaj.body);
  assert.strictEqual(voiceAaj.json.sold_litres, 15);
  assert.strictEqual(voiceAaj.json.unsold_litres, 25);
  assert.strictEqual(voiceAaj.json.sales.length, 2);
  assert.ok(!(voiceAaj.json.cows || []).some((row) => row.name && row.name.toLowerCase() !== "kul" && row.rows && row.rows.length));

  const fixFarm = await seed(sheets, "923200000555", "Sohail");
  const fixBase = `/r/${fixFarm.token}`;
  assert.strictEqual((await request(server, "POST", fixBase + "/api/manual", {
    kind: "cow", name: "Gori", animal_type: "cow", status: "milking",
  })).status, 200);
  const emptyDay = await request(server, "GET", fixBase + "/api/aaj");
  assert.ok(emptyDay.json.cows.some((row) => row.name === "Gori" && row.subah === 0 && row.shaam === 0), emptyDay.body);
  const noRate = await request(server, "POST", fixBase + "/api/aaj", {
    op: "add_day",
    session: "am",
    litres: 40,
    sales: [{ customer: "Mehman", litres: 10 }],
  });
  assert.strictEqual(noRate.status, 200, noRate.body);
  assert.notStrictEqual(noRate.json.error, "Is grahak ka rate likhein.");
  assert.strictEqual(noRate.json.milk_litres, 40);
  assert.strictEqual(noRate.json.sold_litres, 10);
  assert.strictEqual(noRate.json.unsold_litres, 30);
  assert.strictEqual(noRate.json.sales.length, 1);
  assert.ok(!(Number(noRate.json.sales[0].amount) > 0));
  const kept = await request(server, "GET", fixBase + "/api/aaj");
  assert.strictEqual(kept.json.milk_litres, 40, "total stays saved when the customer has no rate");
  const again = await request(server, "POST", fixBase + "/api/aaj", {
    op: "add_day",
    session: "am",
    litres: 42,
  });
  assert.strictEqual(again.status, 200, again.body);
  assert.strictEqual(again.json.milk_litres, 42, "saving the same session again replaces the total");
  assert.strictEqual(again.json.totals.filter((row) => row.session === "am").length, 1);
  const shaam = await request(server, "POST", fixBase + "/api/aaj", {
    op: "add_day",
    session: "pm",
    litres: 22.5,
    sales: [
      { customer: "Pakistan hotel", litres: 10.5, rate_pkr: 200 },
      { customer: "Tabarak", litres: 5, rate_pkr: 180 },
    ],
  });
  assert.strictEqual(shaam.status, 200, shaam.body);
  assert.strictEqual(shaam.json.milk_litres, 64.5);
  assert.strictEqual(shaam.json.sold_litres, 25.5);
  const hotel = shaam.json.sales.find((row) => row.customer === "Pakistan hotel");
  assert.ok(hotel && hotel.litres === 10.5 && hotel.amount === 2100);
  const over = await request(server, "POST", fixBase + "/api/aaj", {
    op: "add_sale",
    customer: "Mehman",
    litres: 80,
  });
  assert.strictEqual(over.status, 200, over.body);
  assert.strictEqual(over.json.unsold_litres, 0);
  assert.ok(over.json.oversold_litres > 0, over.body);
  const editedTotal = await request(server, "POST", fixBase + "/api/aaj", {
    op: "update",
    date: today,
    session: "am",
    cow_name: "kul",
    litres: 42,
    new_litres: 30,
  });
  assert.strictEqual(editedTotal.status, 200, editedTotal.body);
  assert.strictEqual(editedTotal.json.milk_litres, 52.5);
  const removedTotal = await request(server, "POST", fixBase + "/api/aaj", {
    op: "delete",
    confirm: true,
    id: again.json.totals.find((row) => row.session === "am").id,
    date: today,
    session: "am",
    cow_name: "kul",
    litres: 30,
  });
  assert.strictEqual(removedTotal.status, 200, removedTotal.body);
  assert.strictEqual(removedTotal.json.milk_litres, 22.5);
  const rejected = await request(server, "POST", fixBase + "/api/aaj", {
    op: "add_day",
    session: "am",
    litres: 10,
    sales: [{ customer: "", litres: 4 }],
  });
  assert.strictEqual(rejected.status, 400);
  const afterBlock = await request(server, "GET", fixBase + "/api/aaj");
  assert.strictEqual(afterBlock.json.milk_litres, 22.5, "a rejected sale does not write the total");

  const historySql = fs.readFileSync(path.join(migrationsDir, "20261120120000_record_history.sql"), "utf8");
  assert.ok(/create table public\.chat_messages/i.test(historySql));
  assert.ok(/thread_id text not null/i.test(historySql));
  assert.ok(/payload jsonb/i.test(historySql));
  assert.ok(!/delete\s+from\s+public\.chat_messages/i.test(historySql));

  server.close();
  console.log("test-manual ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
