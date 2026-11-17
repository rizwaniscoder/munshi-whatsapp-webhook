const crypto = require("crypto");
const { headerIndex } = require("./schema");
const { parseSheetDate } = require("./format");
const { isMasterPhone, normalizePhone } = require("./config");

const TAB_SPECS = {
  Cows: [
    ["cow_id", "cow_id", "text"],
    ["name", "name", "text"],
    ["type", "animal_type", "text"],
    ["breed", "breed", "text"],
    ["status", "status", "text"],
    ["avg_daily_litres", "avg_daily_litres", "num"],
    ["notes", "notes", "text"],
    ["date_added", "date_added", "text"],
    ["last_insemination", "last_insemination", "text"],
    ["pregnancy_status", "pregnancy_status", "text"],
    ["expected_calving", "expected_calving", "text"],
    ["dry_off_due", "dry_off_due", "text"],
    ["pregnancy_check_due", "pregnancy_check_due", "text"],
  ],
  Milk_Log: [
    ["date", "record_date", "day"],
    ["session", "session", "text"],
    ["cow_name", "cow_name", "text"],
    ["litres", "litres", "num"],
    ["source_note", "source_note", "text"],
  ],
  Customers: [
    ["name", "name", "text"],
    ["phone", "phone", "text"],
    ["rate_pkr", "rate_pkr", "num"],
    ["opening_balance", "opening_balance", "num"],
    ["current_balance", "current_balance", "num"],
    ["notes", "notes", "text"],
    ["billing_cycle", "billing_cycle", "text"],
    ["cycle_start_date", "cycle_start_date", "day"],
    ["supply_type", "supply_type", "supply"],
    ["daily_litres", "daily_litres", "num"],
  ],
  Sales: [
    ["date", "record_date", "day"],
    ["customer", "customer", "text"],
    ["litres", "litres", "num"],
    ["rate_pkr", "rate_pkr", "num"],
    ["amount", "amount", "num"],
    ["cash_received", "cash_received", "num"],
    ["balance_added", "balance_added", "num"],
    ["source_note", "source_note", "text"],
  ],
  Payments: [
    ["date", "record_date", "day"],
    ["customer", "customer", "text"],
    ["amount", "amount", "num"],
    ["method", "method", "text"],
  ],
  Expenses: [
    ["date", "record_date", "day"],
    ["category", "category", "text"],
    ["amount", "amount", "num"],
    ["note", "note", "text"],
  ],
  Fodder: [
    ["date", "record_date", "day"],
    ["item", "item", "text"],
    ["quantity", "quantity", "num"],
    ["unit", "unit", "text"],
    ["cost_pkr", "cost_pkr", "num"],
    ["supplier", "supplier", "text"],
    ["cash_paid", "cash_paid", "num"],
    ["balance_owed", "balance_owed", "num"],
    ["source_note", "source_note", "text"],
  ],
  Committees: [
    ["name", "name", "text"],
    ["amount", "amount", "num"],
    ["frequency", "frequency", "text"],
    ["start_date", "start_date", "day"],
    ["organizer", "organizer", "text"],
    ["status", "status", "text"],
    ["notes", "notes", "text"],
  ],
  Committee_Log: [
    ["date", "record_date", "day"],
    ["committee", "committee", "text"],
    ["status", "status", "text"],
    ["amount", "amount", "num"],
    ["note", "note", "text"],
  ],
  Committee_Status: [
    ["committee", "committee", "text"],
    ["frequency", "frequency", "text"],
    ["as_of", "as_of", "day"],
    ["paid_periods", "paid_periods", "int"],
    ["missed_periods", "missed_periods", "int"],
    ["paid_amount", "paid_amount", "num"],
    ["arrears", "arrears", "num"],
    ["given_so_far", "given_so_far", "num"],
    ["today_status", "today_status", "text"],
  ],
  Animal_Events: [
    ["date", "record_date", "day"],
    ["cow", "cow", "text"],
    ["event_type", "event_type", "text"],
    ["details", "details", "text"],
    ["doctor_name", "doctor_name", "text"],
    ["diagnosis", "diagnosis", "text"],
    ["medicines", "medicines", "text"],
    ["cost_pkr", "cost_pkr", "num"],
    ["next_due_date", "next_due_date", "day"],
    ["source_note", "source_note", "text"],
  ],
  Feed_Stock: [
    ["item", "item", "text"],
    ["quantity", "quantity", "num"],
    ["unit", "unit", "text"],
    ["daily_use", "daily_use", "num"],
    ["updated_at", "updated_at", "text"],
    ["notes", "notes", "text"],
    ["days_left", "days_left", "num"],
    ["run_out_date", "run_out_date", "day"],
    ["reorder_by", "reorder_by", "day"],
    ["avg_cost_per_kg", "avg_cost_per_kg", "num"],
  ],
  Due_Bills: [
    ["customer", "customer", "text"],
    ["period_start", "period_start", "day"],
    ["period_end", "period_end", "day"],
    ["due_date", "due_date", "day"],
    ["litres", "litres", "num"],
    ["amount", "amount", "num"],
    ["paid", "paid", "num"],
    ["balance_due", "balance_due", "num"],
    ["status", "status", "text"],
  ],
  Upcoming_Events: [
    ["date", "record_date", "day"],
    ["cow", "cow", "text"],
    ["event", "event", "text"],
    ["details", "details", "text"],
  ],
};

const LEDGER_FIELDS = {
  Cows: "cows",
  Milk_Log: "milk",
  Customers: "customers",
  Sales: "sales",
  Payments: "payments",
  Expenses: "expenses",
  Fodder: "fodder",
  Committees: "committees",
  Committee_Log: "committee_log",
  Committee_Status: "committee_status",
  Animal_Events: "animal_events",
  Feed_Stock: "feed_stock",
  Due_Bills: "due_bills",
  Upcoming_Events: "upcoming_events",
};

function text(value) {
  if (value == null) return "";
  return String(value);
}

function numOrNull(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const n = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function dayOrNull(value) {
  const parsed = parseSheetDate(value);
  return parsed || null;
}

function supplyType(value) {
  const kind = text(value).trim().toLowerCase();
  if (kind === "fixed" || kind === "flexible") return kind;
  return null;
}

function cell(row, header, name) {
  const index = headerIndex(header, name);
  if (index < 0) return "";
  const value = row[index];
  return value == null ? "" : value;
}

function originMapOf(mem) {
  if (!mem._originMap) mem._originMap = new WeakMap();
  return mem._originMap;
}

function originFor(map, row) {
  const existing = map.get(row);
  if (existing) return existing;
  const value = `app:${crypto.randomUUID()}`;
  map.set(row, value);
  return value;
}

function settingsBag(mem) {
  if (!mem._farmerSettings) mem._farmerSettings = {};
  return mem._farmerSettings;
}

function typed(kind, raw) {
  if (kind === "num") return numOrNull(raw);
  if (kind === "day") return dayOrNull(raw);
  if (kind === "int") {
    const n = numOrNull(raw);
    return n == null ? null : Math.round(n);
  }
  if (kind === "supply") return supplyType(raw);
  return text(raw);
}

function mapTab(store, tab, map) {
  const rows = store[tab] || [];
  const header = rows[0] || [];
  const spec = TAB_SPECS[tab];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row) || !row.some((item) => item != null && String(item).trim() !== "")) continue;
    const record = { origin: originFor(map, row), sort_order: i };
    for (const [from, to, kind] of spec) record[to] = typed(kind, cell(row, header, from));
    out.push(record);
  }
  return out;
}

function ledgerHasRows(store) {
  if (!store) return false;
  for (const tab of Object.keys(LEDGER_FIELDS)) {
    if ((store[tab] || []).length > 1) return true;
  }
  return Boolean(store.Last_Write && store.Last_Write[1]);
}

function ownerPhone(mem, sheetKey) {
  let master = "";
  for (let i = 1; i < mem.Farmers.length; i++) {
    const farmer = mem.rowToFarmer(mem.Farmers[i]);
    if (!farmer.phone) continue;
    if (farmer.sheetId === sheetKey) return farmer.phone;
    if (sheetKey === "default" && isMasterPhone(farmer.phone)) master = farmer.phone;
  }
  return master;
}

function supplierRecords(fodder, sheetKey) {
  const totals = new Map();
  for (const row of fodder || []) {
    const name = text(row.supplier).trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const prev = totals.get(key) || { name, balance: 0 };
    prev.balance += Number(row.balance_owed) || 0;
    totals.set(key, prev);
  }
  return [...totals.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, item], index) => ({
      origin: `supplier:${sheetKey}:${key}`,
      sort_order: index + 1,
      name: item.name,
      balance_owed: Math.round(item.balance * 100) / 100,
    }));
}

function lastWriteRecord(store) {
  const info = store.Last_Write && store.Last_Write[1];
  if (!info) return null;
  const rowNum = numOrNull(info[1]);
  return {
    sheet: text(info[0]),
    row_num: rowNum == null ? null : Math.round(rowNum),
    entry_type: text(info[2]),
    summary: text(info[3]),
    written_at: text(info[4]),
  };
}

function memoryToSnapshot(mem) {
  mem.ensureFarmersShape();
  const map = originMapOf(mem);
  const settings = settingsBag(mem);
  const farmers = [];
  for (let i = 1; i < mem.Farmers.length; i++) {
    const farmer = mem.rowToFarmer(mem.Farmers[i]);
    if (!farmer.phone) continue;
    const extra = settings[farmer.phone];
    farmers.push({
      phone: farmer.phone,
      sheet_id: farmer.sheetId || "",
      name: farmer.name || "",
      farm_name: farmer.farmName || "",
      onboarding_state: farmer.onboardingState || "",
      allowed: Boolean(farmer.allowed),
      created_at: farmer.createdAt || "",
      last_inbound_at: farmer.lastInboundAt || "",
      web_token: farmer.webToken || "",
      settings: extra && typeof extra === "object" && !Array.isArray(extra) ? extra : {},
    });
  }
  farmers.sort((a, b) => a.phone.localeCompare(b.phone));

  const reminders = [];
  const reminderHeader = mem.Reminder_Log[0] || [];
  for (let i = 1; i < mem.Reminder_Log.length; i++) {
    const row = mem.Reminder_Log[i];
    const phone = normalizePhone(cell(row, reminderHeader, "phone"));
    const reminderDate = dayOrNull(cell(row, reminderHeader, "date"));
    const slot = text(cell(row, reminderHeader, "slot"));
    if (!phone || !reminderDate || !slot) continue;
    reminders.push({
      phone,
      reminder_date: reminderDate,
      slot,
      sent_at: text(cell(row, reminderHeader, "sent_at")),
    });
  }

  const pendingHeader = (mem.masterPending && mem.masterPending[0]) || [];
  const pending = [];
  for (let i = 1; i < (mem.masterPending || []).length; i++) {
    const row = mem.masterPending[i];
    pending.push({
      sender: text(cell(row, pendingHeader, "sender") || row[0]),
      created_at: text(row[1]),
      language: text(row[2]),
      entries_json: text(row[3] || "[]"),
      status: text(row[4]),
      message_id: text(row[5]),
      sort_order: i,
    });
  }

  const processedHeader = (mem.masterProcessed && mem.masterProcessed[0]) || [];
  const processed = [];
  for (let i = 1; i < (mem.masterProcessed || []).length; i++) {
    const row = mem.masterProcessed[i];
    const messageId = text(cell(row, processedHeader, "message_id") || row[0]);
    if (!messageId) continue;
    processed.push({
      message_id: messageId,
      received_at: text(row[1]),
      sender: text(row[2]),
    });
  }

  const ledgers = [];
  for (const sheetKey of Object.keys(mem.ledgers || {}).sort()) {
    const store = mem.ledgers[sheetKey];
    const owner = ownerPhone(mem, sheetKey);
    if (!owner) {
      if (ledgerHasRows(store)) throw new Error("ledger is missing a farmer");
      continue;
    }
    const ledger = { sheet_key: sheetKey, owner_phone: owner };
    for (const [tab, field] of Object.entries(LEDGER_FIELDS)) {
      ledger[field] = mapTab(store, tab, map);
    }
    ledger.suppliers = supplierRecords(ledger.fodder, sheetKey);
    ledger.last_write = lastWriteRecord(store);
    ledgers.push(ledger);
  }

  return { farmers, reminders, pending, processed, ledgers };
}

function show(value) {
  return value == null ? "" : value;
}

function fillTab(store, tab, records, map) {
  const rows = store[tab];
  const header = rows[0];
  const spec = TAB_SPECS[tab];
  const byHeader = new Map(spec.map(([from, to]) => [from, to]));
  const sorted = (records || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  for (const record of sorted) {
    const row = header.map((name) => {
      const key = byHeader.get(String(name || "").toLowerCase());
      if (!key || !Object.prototype.hasOwnProperty.call(record, key)) return "";
      return show(record[key]);
    });
    rows.push(row);
    if (record.origin) map.set(row, record.origin);
  }
}

async function snapshotToMemory(snapshot) {
  const { MemorySheets, emptyLedger } = require("./sheets");
  const { migrateStore } = require("./derived");
  const mem = new MemorySheets();
  const map = originMapOf(mem);
  const settings = settingsBag(mem);
  for (const farmer of snapshot.farmers || []) {
    const phone = normalizePhone(farmer.phone);
    if (!phone) continue;
    await mem.upsertFarmer({
      phone,
      sheetId: farmer.sheet_id || "",
      name: farmer.name || "",
      farmName: farmer.farm_name || "",
      onboardingState: farmer.onboarding_state || "",
      allowed: farmer.allowed,
      lastInboundAt: farmer.last_inbound_at || "",
      webToken: farmer.web_token || "",
    });
    const header = mem.Farmers[0];
    const createdIdx = headerIndex(header, "created_at");
    const phoneIdx = headerIndex(header, "phone");
    if (farmer.created_at && createdIdx !== -1) {
      for (let i = 1; i < mem.Farmers.length; i++) {
        if (normalizePhone(mem.Farmers[i][phoneIdx]) === phone) {
          mem.Farmers[i][createdIdx] = farmer.created_at;
        }
      }
    }
    const extra = farmer.settings;
    settings[phone] = extra && typeof extra === "object" && !Array.isArray(extra) ? { ...extra } : {};
  }

  for (const reminder of snapshot.reminders || []) {
    if (!reminder.phone || !reminder.reminder_date || !reminder.slot) continue;
    mem.Reminder_Log.push([
      normalizePhone(reminder.phone),
      reminder.reminder_date,
      reminder.slot,
      reminder.sent_at || "",
    ]);
  }

  const pending = (snapshot.pending || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  for (const row of pending) {
    mem.masterPending.push([
      row.sender || "",
      row.created_at || "",
      row.language || "",
      row.entries_json || "[]",
      row.status || "",
      row.message_id || "",
    ]);
  }

  for (const row of snapshot.processed || []) {
    if (!row.message_id) continue;
    mem.masterProcessed.push([row.message_id, row.received_at || "", row.sender || ""]);
  }

  for (const ledger of snapshot.ledgers || []) {
    const sheetKey = text(ledger.sheet_key);
    if (!sheetKey) continue;
    const store = migrateStore(emptyLedger());
    for (const [tab, field] of Object.entries(LEDGER_FIELDS)) {
      fillTab(store, tab, ledger[field], map);
    }
    if (ledger.last_write && typeof ledger.last_write === "object") {
      store.Last_Write[1] = [
        ledger.last_write.sheet || "",
        ledger.last_write.row_num == null ? "" : ledger.last_write.row_num,
        ledger.last_write.entry_type || "",
        ledger.last_write.summary || "",
        ledger.last_write.written_at || "",
      ];
    }
    mem.ledgers[sheetKey] = store;
  }

  for (const farmer of snapshot.farmers || []) {
    const sheetId = text(farmer.sheet_id);
    if (sheetId && !mem.ledgers[sheetId]) mem.ledgers[sheetId] = migrateStore(emptyLedger());
  }
  return mem;
}

module.exports = {
  TAB_SPECS,
  LEDGER_FIELDS,
  memoryToSnapshot,
  snapshotToMemory,
  originMapOf,
  numOrNull,
  text,
};
