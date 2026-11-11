const fs = require("fs");
const path = require("path");
const { nowISO, todayISO, TIMEZONE, normalizePhone, SHEET_ID } = require("./config");
const { routeFodderEntries } = require("./ledger");

function daysAgoISO(days) {
  const [y, m, d] = todayISO(TIMEZONE).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10);
}

function parseAmount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value == null || value === "") return 0;
  const n = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function farmersHeader() {
  return ["phone", "sheet_id", "name", "farm_name", "onboarding_state", "allowed", "created_at"];
}

function emptyLedger() {
  return {
    Cows: [["cow_id", "name", "type", "breed", "status", "avg_daily_litres", "notes"]],
    Milk_Log: [["date", "session", "cow_name", "litres", "source_note"]],
    Sales: [[
      "date",
      "customer",
      "litres",
      "rate_pkr",
      "amount",
      "cash_received",
      "balance_added",
      "source_note",
    ]],
    Customers: [["name", "phone", "rate_pkr", "opening_balance", "current_balance", "notes"]],
    Payments: [["date", "customer", "amount", "method"]],
    Expenses: [["date", "category", "amount", "note"]],
    Fodder: [[
      "date",
      "item",
      "quantity",
      "unit",
      "cost_pkr",
      "supplier",
      "cash_paid",
      "balance_owed",
      "source_note",
    ]],
    Pending: [["sender", "created_at", "language", "entries_json", "status", "message_id"]],
    Processed_Ids: [["message_id", "received_at", "sender"]],
    Last_Write: [["sheet", "row", "type", "summary", "written_at"]],
  };
}

function headerIndex(header, name) {
  const needle = String(name || "").toLowerCase();
  return (header || []).findIndex((h) => String(h || "").toLowerCase() === needle);
}

function normalizeAnimalType(raw) {
  const t = String(raw || "").toLowerCase();
  if (/bhains|buffalo|bheins|bhainse/.test(t)) return "buffalo";
  return "cow";
}

class MemorySheets {
  constructor(filePath) {
    this.filePath = filePath || "";
    this.Farmers = [farmersHeader()];
    this.ledgers = {};
    this.masterPending = emptyLedger().Pending;
    this.masterProcessed = emptyLedger().Processed_Ids;
    if (this.filePath && fs.existsSync(this.filePath)) {
      try {
        this.load(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
      } catch (err) {
        console.error("failed to load local sheet file", err.message);
      }
    }
  }

  load(raw) {
    if (raw.Farmers && raw.ledgers) {
      this.Farmers = raw.Farmers;
      this.ledgers = raw.ledgers;
      this.masterPending = raw.Pending || this.masterPending;
      this.masterProcessed = raw.Processed_Ids || this.masterProcessed;
      return;
    }
    // Legacy single-store file.
    const ledger = emptyLedger();
    for (const key of Object.keys(ledger)) {
      if (raw[key]) ledger[key] = raw[key];
    }
    this.ensureLedgerShape(ledger);
    this.ledgers.default = ledger;
    this.masterPending = raw.Pending || ledger.Pending;
    this.masterProcessed = raw.Processed_Ids || ledger.Processed_Ids;
  }

  ensureLedgerShape(ledger) {
    const blank = emptyLedger();
    for (const key of Object.keys(blank)) {
      if (!ledger[key]) ledger[key] = blank[key];
    }
    return ledger;
  }

  persist() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(
      this.filePath,
      JSON.stringify(
        {
          Farmers: this.Farmers,
          ledgers: this.ledgers,
          Pending: this.masterPending,
          Processed_Ids: this.masterProcessed,
        },
        null,
        2
      )
    );
  }

  ledgerFor(args = {}) {
    const sheetId = args.sheetId;
    if (sheetId && this.ledgers[sheetId]) return this.ensureLedgerShape(this.ledgers[sheetId]);
    const farmer = this.findFarmer(args.sender || args.phone);
    if (farmer?.sheetId && this.ledgers[farmer.sheetId]) {
      return this.ensureLedgerShape(this.ledgers[farmer.sheetId]);
    }
    if (!this.ledgers.default) this.ledgers.default = emptyLedger();
    return this.ensureLedgerShape(this.ledgers.default);
  }

  findFarmer(phone) {
    const needle = normalizePhone(phone);
    if (!needle) return null;
    for (let i = 1; i < this.Farmers.length; i++) {
      if (normalizePhone(this.Farmers[i][0]) === needle) {
        return this.rowToFarmer(this.Farmers[i]);
      }
    }
    return null;
  }

  rowToFarmer(row) {
    const allowed = row[5] === true || String(row[5]).toLowerCase() === "true" || row[5] === 1;
    return {
      phone: normalizePhone(row[0]),
      sheetId: String(row[1] || ""),
      name: String(row[2] || ""),
      farmName: String(row[3] || ""),
      onboardingState: String(row[4] || ""),
      allowed,
      createdAt: String(row[6] || ""),
    };
  }

  async ping() {
    return { ok: true, mode: this.filePath ? "file" : "memory", multiTenant: true };
  }

  async getFarmer(phone) {
    return { ok: true, farmer: this.findFarmer(phone) };
  }

  async upsertFarmer(body = {}) {
    const phone = normalizePhone(body.phone || body.sender);
    if (!phone) return { ok: false, error: "phone required" };
    const existing = this.findFarmer(phone);
    const allowed =
      body.allowed == null ? (existing ? existing.allowed : false) : Boolean(body.allowed);
    const row = [
      phone,
      body.sheetId != null ? body.sheetId : existing?.sheetId || "",
      body.name != null ? body.name : existing?.name || "",
      body.farmName != null ? body.farmName : existing?.farmName || "",
      body.onboardingState != null
        ? body.onboardingState
        : existing?.onboardingState || "pending_profile",
      allowed,
      existing?.createdAt || nowISO(),
    ];
    const idx = this.Farmers.findIndex((r, i) => i > 0 && normalizePhone(r[0]) === phone);
    if (idx === -1) this.Farmers.push(row);
    else this.Farmers[idx] = row;
    this.persist();
    return { ok: true, farmer: this.rowToFarmer(row) };
  }

  async copyLedger({ farmName, phone, name, onboardingState, allowed } = {}) {
    const sheetId = `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.ledgers[sheetId] = emptyLedger();
    if (phone) {
      await this.upsertFarmer({
        phone,
        name,
        farmName,
        sheetId,
        onboardingState: onboardingState || "pending_animals",
        allowed: allowed == null ? true : allowed,
      });
    }
    this.persist();
    return { ok: true, sheetId, url: "" };
  }

  async getContext(args = {}) {
    const store = this.ledgerFor(args);
    const header = store.Cows[0] || [];
    const statusIdx = headerIndex(header, "status");
    const cows = store.Cows.slice(1)
      .filter((r) => r[1] && String(r[statusIdx] || "").toLowerCase() !== "removed")
      .map((r) => r[1]);
    const customers = store.Customers.slice(1).map((r) => r[0]).filter(Boolean);
    return { ok: true, cows, customers };
  }

  async isProcessed(messageId) {
    return {
      ok: true,
      processed: this.masterProcessed.slice(1).some((r) => r[0] === messageId),
    };
  }

  async markProcessed(messageId, sender) {
    if (this.masterProcessed.slice(1).some((r) => r[0] === messageId)) {
      return { ok: true, already: true };
    }
    this.masterProcessed.push([messageId, nowISO(), sender || ""]);
    this.persist();
    return { ok: true };
  }

  async setPending({ sender, language, entries, messageId }) {
    const rows = this.masterPending;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === sender && rows[i][4] === "pending") rows[i][4] = "superseded";
    }
    rows.push([
      sender,
      nowISO(),
      language || "roman_urdu",
      JSON.stringify(entries || []),
      "pending",
      messageId || "",
    ]);
    this.persist();
    return { ok: true };
  }

  async getPending(sender) {
    const rows = this.masterPending;
    for (let i = rows.length - 1; i >= 1; i--) {
      if (rows[i][0] === sender && rows[i][4] === "pending") {
        return {
          ok: true,
          pending: {
            sender: rows[i][0],
            created_at: rows[i][1],
            language: rows[i][2],
            entries: JSON.parse(rows[i][3] || "[]"),
            status: rows[i][4],
            message_id: rows[i][5],
          },
        };
      }
    }
    return { ok: true, pending: null };
  }

  async clearPending(sender, status) {
    const rows = this.masterPending;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === sender && rows[i][4] === "pending") {
        rows[i][4] = status || "cancelled";
      }
    }
    this.persist();
    return { ok: true };
  }

  nextCowId(store) {
    let max = 0;
    for (const row of store.Cows.slice(1)) {
      const m = String(row[0] || "").match(/(\d+)/);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `C-${String(max + 1).padStart(3, "0")}`;
  }

  setLastWrite(store, sheet, row, type, summary) {
    store.Last_Write = [store.Last_Write[0], [sheet, row, type, summary || "", nowISO()]];
  }

  upsertCustomer(store, name, phone, rate, opening) {
    const rows = store.Customers;
    const header = rows[0];
    const rateIdx = headerIndex(header, "rate_pkr");
    const openIdx = headerIndex(header, "opening_balance");
    const balIdx = headerIndex(header, "current_balance");
    const idx = rows.findIndex(
      (r, i) => i > 0 && String(r[0]).toLowerCase() === String(name).toLowerCase()
    );
    if (idx === -1) {
      const row = new Array(header.length).fill("");
      row[0] = name;
      row[1] = phone || "";
      if (rateIdx !== -1) row[rateIdx] = rate == null || rate === "" ? "" : rate;
      if (openIdx !== -1) row[openIdx] = opening == null || opening === "" ? 0 : opening;
      row[balIdx] = parseAmount(opening);
      rows.push(row);
      return rows.length - 1;
    }
    if (phone) rows[idx][1] = phone;
    if (rate != null && rate !== "" && rateIdx !== -1) rows[idx][rateIdx] = rate;
    if (opening != null && opening !== "" && openIdx !== -1) {
      const delta = parseAmount(opening) - parseAmount(rows[idx][openIdx]);
      rows[idx][openIdx] = opening;
      rows[idx][balIdx] = parseAmount(rows[idx][balIdx]) + delta;
    }
    return idx;
  }

  bumpBalance(store, name, delta) {
    const rows = store.Customers;
    const balIdx = headerIndex(rows[0], "current_balance");
    const idx = this.upsertCustomer(store, name, "", "", "");
    rows[idx][balIdx] = parseAmount(rows[idx][balIdx]) + (delta || 0);
  }

  appendNote(row, col, note) {
    if (col < 0 || !note) return;
    row[col] = row[col] ? `${row[col]}; ${note}` : note;
  }

  async commitRecords({ sender, entries, sourceNote, sheetId }) {
    const store = this.ledgerFor({ sender, sheetId });
    const note = sourceNote || `WhatsApp ${sender}`;
    entries = routeFodderEntries(entries);
    let saved = 0;
    let last = null;
    for (const entry of entries || []) {
      const result = this.commitOne(store, entry, note);
      if (result?.error) {
        await this.clearPending(sender, "cancelled");
        this.persist();
        return { ok: false, error: result.error, saved };
      }
      if (result?.ok) {
        saved += 1;
        last = result;
      }
    }
    await this.clearPending(sender, "saved");
    this.persist();
    return { ok: true, saved, lastWrite: last };
  }

  commitOne(store, entry, note) {
    if (entry.type === "milk") {
      store.Milk_Log.push([
        entry.date,
        entry.session || "",
        entry.cow_name,
        entry.litres,
        entry.note || note,
      ]);
      const row = store.Milk_Log.length;
      this.setLastWrite(store, "Milk_Log", row, "milk", `${entry.cow_name} ${entry.litres} L`);
      return { ok: true, sheet: "Milk_Log", row };
    }
    if (entry.type === "sale") {
      store.Sales.push([
        entry.date,
        entry.customer,
        entry.litres,
        entry.rate_pkr,
        entry.amount,
        entry.cash_received,
        entry.balance_added,
        entry.note || note,
      ]);
      this.upsertCustomer(store, entry.customer, "", entry.rate_pkr, "");
      this.bumpBalance(store, entry.customer, parseAmount(entry.balance_added));
      const row = store.Sales.length;
      this.setLastWrite(store, "Sales", row, "sale", `${entry.customer} ${entry.amount}`);
      return { ok: true, sheet: "Sales", row };
    }
    if (entry.type === "payment") {
      store.Payments.push([entry.date, entry.customer, entry.amount, entry.method || ""]);
      this.bumpBalance(store, entry.customer, -parseAmount(entry.amount));
      const row = store.Payments.length;
      this.setLastWrite(store, "Payments", row, "payment", `${entry.customer} ${entry.amount}`);
      return { ok: true, sheet: "Payments", row };
    }
    if (entry.type === "expense") {
      store.Expenses.push([entry.date, entry.category, entry.amount, entry.note || note]);
      const row = store.Expenses.length;
      this.setLastWrite(store, "Expenses", row, "expense", `${entry.category} ${entry.amount}`);
      return { ok: true, sheet: "Expenses", row };
    }
    if (entry.type === "fodder") {
      store.Fodder.push([
        entry.date,
        entry.item,
        entry.quantity ?? "",
        entry.unit || "",
        entry.cost_pkr,
        entry.supplier || "",
        entry.cash_paid,
        entry.balance_owed,
        entry.note || note,
      ]);
      const row = store.Fodder.length;
      this.setLastWrite(store, "Fodder", row, "fodder", `${entry.item} ${entry.cost_pkr}`);
      return { ok: true, sheet: "Fodder", row };
    }
    if (entry.type === "cow" || entry.type === "add_cow") {
      const name = entry.cow_name || entry.name;
      const exists = store.Cows.slice(1).some(
        (r) => String(r[1]).toLowerCase() === String(name).toLowerCase()
      );
      if (exists) return { ok: true, already: true };
      store.Cows.push([
        this.nextCowId(store),
        name,
        normalizeAnimalType(entry.animal_type || "cow"),
        entry.breed || "",
        entry.status || "milking",
        entry.avg_daily_litres ?? "",
        entry.notes || note,
      ]);
      const row = store.Cows.length;
      this.setLastWrite(store, "Cows", row, "add_cow", name);
      return { ok: true, sheet: "Cows", row };
    }
    if (entry.type === "customer" || entry.type === "add_customer") {
      const name = entry.customer || entry.name;
      const idx = this.upsertCustomer(
        store,
        name,
        entry.phone || "",
        entry.rate_pkr,
        entry.opening_balance
      );
      this.appendNote(store.Customers[idx], headerIndex(store.Customers[0], "notes"), entry.note || note);
      this.setLastWrite(store, "Customers", idx + 1, "add_customer", name);
      return { ok: true, sheet: "Customers", row: idx + 1 };
    }
    if (entry.type === "rename_cow") {
      const idx = store.Cows.findIndex(
        (r, i) => i > 0 && String(r[1]).toLowerCase() === String(entry.cow_name).toLowerCase()
      );
      if (idx === -1) return { error: `Gay nahi mili: ${entry.cow_name}` };
      const old = store.Cows[idx][1];
      store.Cows[idx][1] = entry.new_name;
      this.appendNote(store.Cows[idx], 6, `renamed from ${old} (${note})`);
      for (const row of store.Milk_Log.slice(1)) {
        if (String(row[2]).toLowerCase() === String(old).toLowerCase()) row[2] = entry.new_name;
      }
      this.setLastWrite(store, "Cows", idx + 1, "rename_cow", `${old} -> ${entry.new_name}`);
      return { ok: true, sheet: "Cows", row: idx + 1 };
    }
    if (entry.type === "remove_cow") {
      const idx = store.Cows.findIndex(
        (r, i) => i > 0 && String(r[1]).toLowerCase() === String(entry.cow_name).toLowerCase()
      );
      if (idx === -1) return { error: `Gay nahi mili: ${entry.cow_name}` };
      store.Cows[idx][4] = "removed";
      this.appendNote(store.Cows[idx], 6, `removed (${note})`);
      this.setLastWrite(store, "Cows", idx + 1, "remove_cow", entry.cow_name);
      return { ok: true, sheet: "Cows", row: idx + 1 };
    }
    if (entry.type === "change_rate") {
      const idx = store.Customers.findIndex(
        (r, i) => i > 0 && String(r[0]).toLowerCase() === String(entry.customer).toLowerCase()
      );
      if (idx === -1) return { error: `Customer nahi mila: ${entry.customer}` };
      const prev = store.Customers[idx][2];
      store.Customers[idx][2] = entry.rate_pkr;
      this.appendNote(
        store.Customers[idx],
        5,
        `rate ${prev} -> ${entry.rate_pkr} (${note})`
      );
      this.setLastWrite(store, "Customers", idx + 1, "change_rate", `${entry.customer} ${entry.rate_pkr}`);
      return { ok: true, sheet: "Customers", row: idx + 1 };
    }
    if (entry.type === "correct_entry") {
      return this.correctEntry(store, entry, note);
    }
    if (entry.type === "delete_last") {
      return this.deleteLast(store, note);
    }
    if (entry.type === "profile") return { ok: true };
    return { ok: true, skipped: true };
  }

  correctEntry(store, entry, note) {
    const map = {
      milk: "Milk_Log",
      sale: "Sales",
      payment: "Payments",
      expense: "Expenses",
      fodder: "Fodder",
    };
    const tab = entry.sheet || map[entry.entry_type || entry.target_type];
    if (!tab || !store[tab]) return { error: "Purana record nahi mila." };
    const rows = store[tab];
    const found = rows.findIndex((row, i) => i > 0 && this.rowMatches(tab, row, entry));
    if (found === -1) return { error: "Purana record nahi mila." };
    const fieldCol = this.fieldCol(tab, entry.field);
    const oldVal = rows[found][fieldCol];
    rows[found][fieldCol] = entry.new_value;
    const noteCol = this.noteCol(tab);
    this.appendNote(
      rows[found],
      noteCol,
      `corrected ${entry.field || "value"} ${oldVal} -> ${entry.new_value} (${note})`
    );
    this.setLastWrite(store, tab, found + 1, "correct_entry", `${oldVal} -> ${entry.new_value}`);
    return { ok: true, sheet: tab, row: found + 1 };
  }

  rowMatches(tab, row, entry) {
    if (entry.date && String(row[0]) !== String(entry.date)) return false;
    if (tab === "Milk_Log") {
      if (entry.cow_name && String(row[2]).toLowerCase() !== String(entry.cow_name).toLowerCase()) {
        return false;
      }
      if (entry.session && String(row[1] || "") !== String(entry.session)) return false;
      if (entry.old_value != null && entry.old_value !== "" && parseAmount(row[3]) !== parseAmount(entry.old_value)) {
        return false;
      }
      return true;
    }
    if (tab === "Sales" || tab === "Payments") {
      if (entry.customer && String(row[1]).toLowerCase() !== String(entry.customer).toLowerCase()) {
        return false;
      }
      if (entry.old_value != null && entry.old_value !== "") {
        const col = tab === "Sales" ? (entry.field === "litres" ? 2 : 4) : 2;
        if (parseAmount(row[col]) !== parseAmount(entry.old_value)) return false;
      }
      return true;
    }
    return true;
  }

  fieldCol(tab, field) {
    const f = String(field || "").toLowerCase();
    if (tab === "Milk_Log") return f === "session" ? 1 : 3;
    if (tab === "Sales") {
      if (f === "litres") return 2;
      if (f === "rate_pkr" || f === "rate") return 3;
      if (f === "cash_received") return 5;
      if (f === "balance_added") return 6;
      return 4;
    }
    if (tab === "Payments" || tab === "Expenses") return 2;
    if (tab === "Fodder") {
      if (f === "quantity") return 2;
      if (f === "cash_paid") return 6;
      return 4;
    }
    return 0;
  }

  noteCol(tab) {
    if (tab === "Milk_Log") return 4;
    if (tab === "Sales") return 7;
    if (tab === "Expenses") return 3;
    if (tab === "Fodder") return 8;
    return 0;
  }

  deleteLast(store, note) {
    const info = (store.Last_Write || [])[1];
    if (!info) return { error: "Koi akhri record nahi mila." };
    const [tab, row] = info;
    const rows = store[tab];
    if (!rows || row < 2 || row >= rows.length + 1) {
      return { error: "Akhri record pehle hi hat chuka hai." };
    }
    // row is 1-based including header
    if (!rows[row - 1]) return { error: "Akhri record pehle hi hat chuka hai." };
    this.appendNote(rows[row - 1], this.noteCol(tab), `deleted (${note || ""})`);
    rows.splice(row - 1, 1);
    store.Last_Write = [store.Last_Write[0]];
    return { ok: true, sheet: tab, row, deleted: true };
  }

  async readRecent(days = 30, args = {}) {
    const cutoff = daysAgoISO(typeof days === "number" ? days : days?.days || 30);
    const store = this.ledgerFor(typeof days === "object" ? days : args);
    const filterDated = (rows, dateIdx) => {
      const header = rows[0];
      const body = rows.slice(1).filter((r) => String(r[dateIdx] || "") >= cutoff);
      return [header, ...body];
    };
    return {
      ok: true,
      cows: store.Cows,
      customers: store.Customers,
      milk: filterDated(store.Milk_Log, 0),
      sales: filterDated(store.Sales, 0),
      payments: filterDated(store.Payments, 0),
      expenses: filterDated(store.Expenses, 0),
      fodder: filterDated(store.Fodder, 0),
    };
  }
}

class AppsScriptSheets {
  constructor(url, secret) {
    this.url = url;
    this.secret = secret;
  }

  async call(action, payload = {}) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: this.secret, action, ...payload }),
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Sheets gateway returned non-JSON (HTTP ${res.status})`);
    }
    if (!res.ok || body.ok === false) {
      throw new Error(body.error || `Sheets gateway HTTP ${res.status}`);
    }
    return body;
  }

  ping() {
    return this.call("ping");
  }
  async getFarmer(phone) {
    try {
      return await this.call("getFarmer", { phone, sender: phone });
    } catch (err) {
      if (/unknown action/i.test(err.message || "")) {
        return { ok: true, farmer: null, registryUnavailable: true };
      }
      throw err;
    }
  }
  upsertFarmer(args) {
    return this.call("upsertFarmer", args);
  }
  copyLedger(args) {
    return this.call("copyLedger", args);
  }
  getContext(args = {}) {
    return this.call("getContext", args);
  }
  isProcessed(messageId) {
    return this.call("isProcessed", { messageId });
  }
  markProcessed(messageId, sender) {
    return this.call("markProcessed", { messageId, sender });
  }
  setPending(args) {
    return this.call("setPending", args);
  }
  getPending(sender) {
    return this.call("getPending", { sender });
  }
  clearPending(sender, status) {
    return this.call("clearPending", { sender, status });
  }
  commitRecords(args) {
    return this.call("commitRecords", args);
  }
  readRecent(days = 30, args = {}) {
    const payload = typeof days === "object" ? { days: days.days || 30, ...days } : { days, ...args };
    return this.call("readRecent", payload);
  }
}

function createSheets() {
  const url = (process.env.SHEETS_WEBHOOK_URL || "").trim();
  const secret = (process.env.SHEETS_SECRET || "").trim();
  if (url) {
    if (!secret) throw new Error("SHEETS_SECRET is required when SHEETS_WEBHOOK_URL is set");
    console.log("sheets backend: apps script");
    return new AppsScriptSheets(url, secret);
  }
  const filePath = (process.env.MUNSHI_SHEETS_FILE || "").trim();
  console.log(
    "sheets backend:",
    filePath ? `local file (ledger gateway not configured)` : "memory (ledger gateway not configured)"
  );
  return new MemorySheets(filePath);
}

function formatLedgerData(data) {
  const section = (title, rows) => {
    if (!rows || !rows.length) return `${title}: (empty)`;
    return `${title}:\n` + rows.map((r) => r.join(" | ")).join("\n");
  };
  return [
    section("Cows", data.cows),
    section("Customers", data.customers),
    section("Milk_Log (last 30 days)", data.milk),
    section("Sales (last 30 days)", data.sales),
    section("Payments (last 30 days)", data.payments),
    section("Expenses (last 30 days)", data.expenses),
    section("Fodder (last 30 days)", data.fodder),
  ].join("\n\n");
}

module.exports = {
  createSheets,
  MemorySheets,
  AppsScriptSheets,
  formatLedgerData,
  parseAmount,
  emptyLedger,
  SHEET_ID,
};
