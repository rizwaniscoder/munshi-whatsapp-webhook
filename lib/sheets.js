const fs = require("fs");
const path = require("path");
const { nowISO, todayISO, TIMEZONE, normalizePhone, SHEET_ID, isTruthyAllowed, isMasterPhone, isMasterSheetId } = require("./config");
const { routeFodderEntries, isFodderCategory } = require("./ledger");
const { TAB_HEADERS, EXTRA_COLUMNS, ensureHeaderRow } = require("./schema");
const { migrateStore, refreshDerivedStore } = require("./derived");
const { normalizeCycle } = require("./billing");
const { applyStockDelta } = require("./feed");
const { rowsToCommittees } = require("./committee");
const { sanitizeExpenseEntry } = require("./expenses");

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
  return ["phone", "sheet_id", "name", "farm_name", "onboarding_state", "allowed", "created_at", "last_inbound_at"];
}

function reminderLogHeader() {
  return ["phone", "date", "slot", "sent_at"];
}

function emptyLedger() {
  return {
    Cows: [["cow_id", "name", "type", "breed", "status", "avg_daily_litres", "notes", "last_insemination", "pregnancy_status", "expected_calving", "dry_off_due", "pregnancy_check_due"]],
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
    Customers: [["name", "phone", "rate_pkr", "opening_balance", "current_balance", "notes", "billing_cycle", "cycle_start_date"]],
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
    Animal_Events: [TAB_HEADERS.Animal_Events.slice()],
    Feed_Stock: [TAB_HEADERS.Feed_Stock.slice()],
    Due_Bills: [TAB_HEADERS.Due_Bills.slice()],
    Upcoming_Events: [TAB_HEADERS.Upcoming_Events.slice()],
    Committees: [TAB_HEADERS.Committees.slice()],
    Committee_Log: [TAB_HEADERS.Committee_Log.slice()],
    Committee_Status: [TAB_HEADERS.Committee_Status.slice()],
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
    this.Reminder_Log = [reminderLogHeader()];
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
    this.ensureFarmersShape();
  }

  load(raw) {
    if (raw.Farmers && raw.ledgers) {
      this.Farmers = raw.Farmers;
      this.ledgers = raw.ledgers;
      this.Reminder_Log = raw.Reminder_Log || this.Reminder_Log;
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
    migrateStore(ledger);
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
          Reminder_Log: this.Reminder_Log,
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
    const sender = normalizePhone(args.sender || args.phone);
    const requested = String(args.sheetId || "").trim();
    if (requested) {
      if (isMasterSheetId(requested) && sender && !isMasterPhone(sender)) {
        throw new Error("Ledger is number ke liye available nahi.");
      }
      if (this.ledgers[requested]) return this.ensureLedgerShape(this.ledgers[requested]);
      if (isMasterSheetId(requested) && isMasterPhone(sender)) {
        if (!this.ledgers.default) this.ledgers.default = emptyLedger();
        return this.ensureLedgerShape(this.ledgers.default);
      }
      throw new Error("Farm ka ledger abhi tayyar nahi. Pehle onboarding mukammal karein.");
    }
    const farmer = this.findFarmer(sender);
    const sheetId = String(farmer?.sheetId || "").trim();
    if (sheetId) {
      if (isMasterSheetId(sheetId) && !isMasterPhone(sender)) {
        throw new Error("Ledger is number ke liye available nahi.");
      }
      if (this.ledgers[sheetId]) return this.ensureLedgerShape(this.ledgers[sheetId]);
    }
    if (isMasterPhone(sender)) {
      if (!this.ledgers.default) this.ledgers.default = emptyLedger();
      return this.ensureLedgerShape(this.ledgers.default);
    }
    throw new Error("Farm ka ledger abhi tayyar nahi. Pehle onboarding mukammal karein.");
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

  ensureFarmersShape() {
    this.Farmers = ensureHeaderRow(
      this.Farmers && this.Farmers.length ? this.Farmers : [farmersHeader()],
      farmersHeader()
    );
    this.Reminder_Log = ensureHeaderRow(
      this.Reminder_Log && this.Reminder_Log.length ? this.Reminder_Log : [reminderLogHeader()],
      reminderLogHeader()
    );
  }

  rowToFarmer(row) {
    const header = this.Farmers[0] || farmersHeader();
    const at = (name, fallback) => {
      const i = headerIndex(header, name);
      return i === -1 ? row[fallback] : row[i];
    };
    return {
      phone: normalizePhone(at("phone", 0)),
      sheetId: String(at("sheet_id", 1) || ""),
      name: String(at("name", 2) || ""),
      farmName: String(at("farm_name", 3) || ""),
      onboardingState: String(at("onboarding_state", 4) || ""),
      allowed: isTruthyAllowed(at("allowed", 5)),
      createdAt: String(at("created_at", 6) || ""),
      lastInboundAt: String(at("last_inbound_at", 7) || ""),
    };
  }

  async ping() {
    return { ok: true, mode: this.filePath ? "file" : "memory", multiTenant: true };
  }

  async getFarmer(phone) {
    return { ok: true, farmer: this.findFarmer(phone) };
  }

  async upsertFarmer(body = {}) {
    this.ensureFarmersShape();
    const phone = normalizePhone(body.phone || body.sender);
    if (!phone) return { ok: false, error: "phone required" };
    const existing = this.findFarmer(phone);
    const allowed =
      body.allowed == null ? (existing ? existing.allowed : false) : isTruthyAllowed(body.allowed);
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
      body.lastInboundAt != null ? body.lastInboundAt : existing?.lastInboundAt || "",
    ];
    const idx = this.Farmers.findIndex((r, i) => i > 0 && normalizePhone(r[0]) === phone);
    if (idx === -1) this.Farmers.push(row);
    else this.Farmers[idx] = row;
    this.persist();
    return { ok: true, farmer: this.rowToFarmer(row) };
  }

  async listFarmers() {
    this.ensureFarmersShape();
    const farmers = [];
    for (let i = 1; i < this.Farmers.length; i++) {
      if (!normalizePhone(this.Farmers[i][0])) continue;
      farmers.push(this.rowToFarmer(this.Farmers[i]));
    }
    return { ok: true, farmers };
  }

  async touchLastInbound(phone, at) {
    this.ensureFarmersShape();
    const needle = normalizePhone(phone);
    if (!needle) return { ok: false, error: "phone required" };
    const col = headerIndex(this.Farmers[0], "last_inbound_at");
    const idx = this.Farmers.findIndex((r, i) => i > 0 && normalizePhone(r[0]) === needle);
    if (idx === -1) return { ok: true, updated: false };
    while (this.Farmers[idx].length <= col) this.Farmers[idx].push("");
    this.Farmers[idx][col] = at || new Date().toISOString();
    this.persist();
    return { ok: true, updated: true, farmer: this.rowToFarmer(this.Farmers[idx]) };
  }

  reminderColumns() {
    this.ensureFarmersShape();
    const header = this.Reminder_Log[0];
    return {
      header,
      phone: headerIndex(header, "phone"),
      date: headerIndex(header, "date"),
      slot: headerIndex(header, "slot"),
      sentAt: headerIndex(header, "sent_at"),
    };
  }

  findReminder(phone, date, slot) {
    const cols = this.reminderColumns();
    const needle = normalizePhone(phone);
    for (let i = 1; i < this.Reminder_Log.length; i++) {
      const row = this.Reminder_Log[i];
      if (
        normalizePhone(row[cols.phone]) === needle &&
        String(row[cols.date] || "") === String(date) &&
        String(row[cols.slot] || "") === String(slot)
      ) {
        return i;
      }
    }
    return -1;
  }

  async claimReminder({ phone, date, slot, sentAt } = {}) {
    const needle = normalizePhone(phone);
    if (!needle || !date || !slot) return { ok: false, error: "phone, date, and slot required" };
    if (this.findReminder(needle, date, slot) !== -1) {
      return { ok: true, claimed: false, already: true };
    }
    const cols = this.reminderColumns();
    const row = new Array(cols.header.length).fill("");
    row[cols.phone] = needle;
    row[cols.date] = String(date);
    row[cols.slot] = String(slot);
    row[cols.sentAt] = sentAt || new Date().toISOString();
    this.Reminder_Log.push(row);
    this.persist();
    return { ok: true, claimed: true, already: false };
  }

  async releaseReminder({ phone, date, slot } = {}) {
    const needle = normalizePhone(phone);
    const cols = this.reminderColumns();
    const kept = [this.Reminder_Log[0]];
    let removed = 0;
    for (let i = 1; i < this.Reminder_Log.length; i++) {
      const row = this.Reminder_Log[i];
      const match =
        normalizePhone(row[cols.phone]) === needle &&
        String(row[cols.date] || "") === String(date) &&
        String(row[cols.slot] || "") === String(slot);
      if (match) removed += 1;
      else kept.push(row);
    }
    this.Reminder_Log = kept;
    this.persist();
    return { ok: true, removed };
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
    const committees = rowsToCommittees(store.Committees)
      .filter((c) => String(c.status || "active").toLowerCase() !== "paused")
      .map((c) => ({
        name: c.name,
        amount: Number(String(c.amount).replace(/[^0-9.-]/g, "")) || 0,
        frequency: c.frequency || "daily",
        start_date: c.start_date || "",
      }));
    return { ok: true, cows, customers, committees };
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

  async setPending({ sender, language, entries, messageId, status }) {
    const rows = this.masterPending;
    const open = (s) => s === "pending" || s === "editing";
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === sender && open(rows[i][4])) rows[i][4] = "superseded";
    }
    rows.push([
      sender,
      nowISO(),
      language || "roman_urdu",
      JSON.stringify(entries || []),
      status === "editing" ? "editing" : "pending",
      messageId || "",
    ]);
    this.persist();
    return { ok: true };
  }

  async getPending(sender) {
    const rows = this.masterPending;
    const open = (s) => s === "pending" || s === "editing";
    for (let i = rows.length - 1; i >= 1; i--) {
      if (rows[i][0] === sender && open(rows[i][4])) {
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
    const open = (s) => s === "pending" || s === "editing";
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === sender && open(rows[i][4])) {
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

  upsertCustomer(store, name, phone, rate, opening, cycle, cycleStart) {
    const rows = store.Customers;
    const header = rows[0];
    const rateIdx = headerIndex(header, "rate_pkr");
    const openIdx = headerIndex(header, "opening_balance");
    const balIdx = headerIndex(header, "current_balance");
    const cycleIdx = headerIndex(header, "billing_cycle");
    const startIdx = headerIndex(header, "cycle_start_date");
    const idx = rows.findIndex(
      (r, i) => i > 0 && String(r[0]).toLowerCase() === String(name).toLowerCase()
    );
    const cycleVal = cycle ? normalizeCycle(cycle) : "";
    if (idx === -1) {
      const row = new Array(header.length).fill("");
      row[0] = name;
      row[1] = phone || "";
      if (rateIdx !== -1) row[rateIdx] = rate == null || rate === "" ? "" : rate;
      if (openIdx !== -1) row[openIdx] = opening == null || opening === "" ? 0 : opening;
      row[balIdx] = parseAmount(opening);
      if (cycleIdx !== -1) row[cycleIdx] = cycleVal || "daily";
      if (startIdx !== -1) row[startIdx] = cycleStart || todayISO(TIMEZONE);
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
    if (cycleVal && cycleIdx !== -1) rows[idx][cycleIdx] = cycleVal;
    if (cycleStart && startIdx !== -1) rows[idx][startIdx] = cycleStart;
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

  async commitRecords({ sender, entries, sourceNote, sheetId, refresh } = {}) {
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
    if (refresh !== false) refreshDerivedStore(store);
    this.persist();
    return { ok: true, saved, lastWrite: last };
  }

  async refreshDerived(args = {}) {
    const store = this.ledgerFor(args);
    refreshDerivedStore(store);
    this.persist();
    return { ok: true, refreshed: true };
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
      if (isFodderCategory(entry.category || entry.item)) {
        return this.commitOne(store, { ...entry, type: "fodder" }, note);
      }
      const cleaned = sanitizeExpenseEntry(entry);
      if (!cleaned) return { ok: true, skipped: true };
      store.Expenses.push([cleaned.date, cleaned.category, cleaned.amount, cleaned.note || note]);
      const row = store.Expenses.length;
      this.setLastWrite(store, "Expenses", row, "expense", `${cleaned.category} ${cleaned.amount}`);
      return { ok: true, sheet: "Expenses", row };
    }
    if (entry.type === "setup_committee") {
      return this.commitCommittee(store, entry, note);
    }
    if (entry.type === "committee_log") {
      return this.commitCommitteeLog(store, entry, note);
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
      if (entry.quantity != null && entry.quantity !== "") {
        applyStockDelta(store.Feed_Stock, {
          item: entry.item,
          quantity: Number(entry.quantity) || 0,
          unit: entry.unit || "",
          daily_use: entry.daily_use,
          notes: "purchase",
          today: entry.date,
        });
      }
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
        entry.opening_balance,
        entry.billing_cycle,
        entry.cycle_start_date
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
    if (entry.type === "change_billing_cycle") {
      const idx = store.Customers.findIndex(
        (r, i) => i > 0 && String(r[0]).toLowerCase() === String(entry.customer).toLowerCase()
      );
      if (idx === -1) return { error: `Customer nahi mila: ${entry.customer}` };
      const header = store.Customers[0];
      const cycleIdx = headerIndex(header, "billing_cycle");
      const startIdx = headerIndex(header, "cycle_start_date");
      const prev = cycleIdx !== -1 ? store.Customers[idx][cycleIdx] : "";
      if (cycleIdx !== -1) store.Customers[idx][cycleIdx] = normalizeCycle(entry.billing_cycle);
      if (entry.cycle_start_date && startIdx !== -1) {
        store.Customers[idx][startIdx] = entry.cycle_start_date;
      } else if (startIdx !== -1 && !store.Customers[idx][startIdx]) {
        store.Customers[idx][startIdx] = todayISO(TIMEZONE);
      }
      this.appendNote(
        store.Customers[idx],
        headerIndex(header, "notes"),
        `cycle ${prev} -> ${normalizeCycle(entry.billing_cycle)} (${note})`
      );
      this.setLastWrite(store, "Customers", idx + 1, "change_billing_cycle", `${entry.customer} ${entry.billing_cycle}`);
      return { ok: true, sheet: "Customers", row: idx + 1 };
    }
    if (entry.type === "animal_event" || entry.type === "vet_visit" || entry.type === "vet_appointment") {
      const typ = entry.event_type || entry.type;
      const header = store.Animal_Events[0];
      const row = new Array(header.length).fill("");
      const set = (col, val) => {
        const i = headerIndex(header, col);
        if (i !== -1) row[i] = val == null ? "" : val;
      };
      set("date", entry.date);
      set("cow", entry.cow_name || entry.cow || "all");
      set("event_type", typ);
      set("details", entry.details || "");
      set("doctor_name", entry.doctor_name || "");
      set("diagnosis", entry.diagnosis || "");
      set("medicines", entry.medicines || "");
      set("cost_pkr", entry.cost_pkr ?? entry.fee_pkr ?? "");
      set("next_due_date", entry.next_due_date || entry.next_appointment_date || "");
      set("source_note", entry.note || note);
      store.Animal_Events.push(row);
      const r = store.Animal_Events.length;
      this.setLastWrite(store, "Animal_Events", r, typ, `${entry.cow_name || entry.cow || "all"} ${typ}`);
      return { ok: true, sheet: "Animal_Events", row: r };
    }
    if (entry.type === "feed_use" || entry.type === "set_daily_use" || entry.type === "feed_stock") {
      const qty = entry.type === "feed_use" ? -(Number(entry.quantity) || 0) : (entry.type === "set_daily_use" ? 0 : Number(entry.quantity) || 0);
      const applied = applyStockDelta(store.Feed_Stock, {
        item: entry.item,
        quantity: qty,
        unit: entry.unit || "",
        daily_use: entry.daily_use,
        notes: entry.note || entry.type,
        today: entry.date || todayISO(TIMEZONE),
      });
      const r = (applied.idx || 0) + 1;
      this.setLastWrite(store, "Feed_Stock", r, entry.type, `${entry.item} ${entry.quantity || entry.daily_use || ""}`);
      return { ok: true, sheet: "Feed_Stock", row: r };
    }
    if (entry.type === "profile") return { ok: true };
    return { ok: true, skipped: true };
  }

  commitCommittee(store, entry) {
    const rows = store.Committees;
    const header = rows[0];
    const name = entry.name || "Committee";
    const idx = rows.findIndex(
      (r, i) => i > 0 && String(r[headerIndex(header, "name")] || "").toLowerCase() === String(name).toLowerCase()
    );
    const write = (row) => {
      const set = (col, val) => {
        const i = headerIndex(header, col);
        if (i !== -1 && val != null && val !== "") row[i] = val;
      };
      set("name", name);
      set("amount", entry.amount);
      set("frequency", entry.frequency || "daily");
      set("start_date", entry.start_date);
      set("organizer", entry.organizer);
      set("status", entry.status || "active");
      if (entry.note) set("notes", entry.note);
      return row;
    };
    if (idx === -1) {
      const row = write(new Array(header.length).fill(""));
      rows.push(row);
      const at = rows.length;
      this.setLastWrite(store, "Committees", at, "setup_committee", `${name} ${entry.amount || ""}`);
      return { ok: true, sheet: "Committees", row: at };
    }
    write(rows[idx]);
    this.setLastWrite(store, "Committees", idx + 1, "setup_committee", `${name} ${entry.amount || ""}`);
    return { ok: true, sheet: "Committees", row: idx + 1 };
  }

  commitCommitteeLog(store, entry) {
    const header = store.Committee_Log[0];
    let status = entry.status || "paid";
    let amount = entry.amount;
    if (status === "not_paid") amount = "";
    if (status !== "not_paid" && (amount == null || amount === "" || Number(amount) === 0)) {
      const known = rowsToCommittees(store.Committees).find(
        (c) => String(c.name).toLowerCase() === String(entry.committee || "").toLowerCase()
      );
      if (known && status === "paid" && Number(known.amount) > 0) amount = Number(known.amount);
      else return { ok: true, skipped: true };
    }
    const row = new Array(header.length).fill("");
    const set = (col, val) => {
      const i = headerIndex(header, col);
      if (i !== -1) row[i] = val == null ? "" : val;
    };
    set("date", entry.date);
    set("committee", entry.committee || "Committee");
    set("status", status);
    set("amount", amount);
    set("note", entry.note || "");
    store.Committee_Log.push(row);
    const at = store.Committee_Log.length;
    this.setLastWrite(store, "Committee_Log", at, "committee_log", `${entry.committee || ""} ${status}`);
    return { ok: true, sheet: "Committee_Log", row: at };
  }

  correctEntry(store, entry, note) {
    const map = {
      milk: "Milk_Log",
      sale: "Sales",
      payment: "Payments",
      expense: "Expenses",
      fodder: "Fodder",
      committee: "Committee_Log",
      committee_log: "Committee_Log",
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
    if (tab === "Committee_Log") {
      if (entry.committee && String(row[1] || "").toLowerCase() !== String(entry.committee).toLowerCase()) {
        return false;
      }
      if (entry.old_value != null && entry.old_value !== "" && parseAmount(row[3]) !== parseAmount(entry.old_value)) {
        return false;
      }
      return true;
    }
    if (tab === "Expenses") {
      if (entry.category) {
        const { normalizeExpenseCategory } = require("./expenses");
        if (normalizeExpenseCategory(row[1]) !== normalizeExpenseCategory(entry.category)) return false;
      }
      if (entry.old_value != null && entry.old_value !== "" && parseAmount(row[2]) !== parseAmount(entry.old_value)) {
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
    if (tab === "Committee_Log") return 3;
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
    if (tab === "Committee_Log") return 4;
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
    const opts = typeof days === "object" ? days : args;
    if (opts.refresh !== false) {
      refreshDerivedStore(store);
      this.persist();
    }
    return {
      ok: true,
      cows: store.Cows,
      customers: store.Customers,
      milk: filterDated(store.Milk_Log, 0),
      sales: filterDated(store.Sales, 0),
      payments: filterDated(store.Payments, 0),
      expenses: filterDated(store.Expenses, 0),
      fodder: filterDated(store.Fodder, 0),
      animal_events: store.Animal_Events,
      feed_stock: store.Feed_Stock,
      due_bills: store.Due_Bills,
      upcoming_events: store.Upcoming_Events,
      committees: store.Committees,
      committee_log: store.Committee_Log,
      committee_status: store.Committee_Status,
    };
  }
}


function requireFarmerLedger(args = {}) {
  const sender = normalizePhone(args.sender || args.phone);
  const sheetId = String(args.sheetId || "").trim();
  if (isMasterPhone(sender)) return;
  if (sheetId && !isMasterSheetId(sheetId)) return;
  throw new Error("Farm ka ledger abhi tayyar nahi. Pehle onboarding mukammal karein.");
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
    requireFarmerLedger(args);
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
    requireFarmerLedger(args);
    return this.call("commitRecords", args);
  }
  readRecent(days = 30, args = {}) {
    const payload = typeof days === "object" ? { days: days.days || 30, ...days } : { days, ...args };
    requireFarmerLedger(payload);
    return this.call("readRecent", payload);
  }
  refreshDerived(args = {}) {
    requireFarmerLedger(args);
    return this.call("refreshDerived", args);
  }
  listFarmers() {
    return this.call("listFarmers");
  }
  async touchLastInbound(phone, at) {
    try {
      return await this.call("touchLastInbound", { phone, sender: phone, at });
    } catch (err) {
      if (/unknown action/i.test(err.message || "")) {
        return { ok: true, updated: false, unavailable: true };
      }
      throw err;
    }
  }
  claimReminder(args = {}) {
    return this.call("claimReminder", args);
  }
  releaseReminder(args = {}) {
    return this.call("releaseReminder", args);
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
    section("Animal_Events", data.animal_events),
    section("Feed_Stock", data.feed_stock),
    section("Due_Bills", data.due_bills),
    section("Upcoming_Events", data.upcoming_events),
    section("Committees", data.committees),
    section("Committee_Log", data.committee_log),
    section("Committee_Status", data.committee_status),
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
