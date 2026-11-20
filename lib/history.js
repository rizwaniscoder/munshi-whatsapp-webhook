const { originFor, originMapOf } = require("./ledger-snapshot");

const SHEET_TABLE = {
  Milk_Log: "milk_records",
  Sales: "sales",
  Payments: "payments",
  Expenses: "expenses",
  Fodder: "fodder_purchases",
  Cows: "cows",
  Customers: "customers",
  Committees: "committees",
  Committee_Log: "committee_log",
  Animal_Events: "animal_events",
  Feed_Stock: "feed_stock",
};

const TABLE_SHEET = Object.fromEntries(Object.entries(SHEET_TABLE).map(([sheet, table]) => [table, sheet]));

const SOURCES = new Set(["voice", "manual", "whatsapp"]);
const ACTIONS = new Set(["create", "update", "delete"]);

function sourceFromNote(note, explicit) {
  const given = String(explicit || "").trim().toLowerCase();
  if (SOURCES.has(given)) return given;
  const text = String(note || "").trim();
  if (/^whatsapp\b/i.test(text)) return "whatsapp";
  if (/^web\b/i.test(text)) return "voice";
  if (/^(screen|manual)\b/i.test(text)) return "manual";
  return "manual";
}

function snapshotRow(header, row) {
  const out = {};
  (header || []).forEach((name, index) => {
    const key = String(name || "").trim();
    if (!key) return;
    const value = row ? row[index] : "";
    out[key] = value == null ? "" : value;
  });
  return out;
}

function ensureOrigin(mem, row) {
  if (!row) return "";
  if (row.originId) return row.originId;
  return originFor(originMapOf(mem || {}), row);
}

function findByOrigin(rows, id) {
  const wanted = String(id || "");
  if (!wanted || !rows) return -1;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i] && rows[i].originId === wanted) return i;
  }
  return -1;
}

function sheetKeyOf(mem, store) {
  const ledgers = mem && mem.ledgers;
  if (!ledgers || !store) return "";
  for (const key of Object.keys(ledgers)) {
    if (ledgers[key] === store) return key;
  }
  return "";
}

function farmerPhone(mem, sheetKey) {
  if (!mem || typeof mem.rowToFarmer !== "function" || !sheetKey) return "";
  for (let i = 1; i < (mem.Farmers || []).length; i++) {
    const farmer = mem.rowToFarmer(mem.Farmers[i]);
    if (farmer && farmer.sheetId === sheetKey) return farmer.phone || "";
  }
  return "";
}

function appendHistory(mem, store, spec) {
  if (!mem || !spec || !ACTIONS.has(spec.action) || !spec.sheet) return null;
  const rows = store && store[spec.sheet];
  const header = rows && rows[0] ? rows[0] : [];
  let row = null;
  if (spec.action !== "delete" && rows && spec.rowNumber >= 1) {
    row = rows[spec.rowNumber - 1] || null;
    if (!row || spec.rowNumber < 2) return null;
  }
  const recordId = spec.recordId || (row ? ensureOrigin(mem, row) : "");
  if (!recordId) return null;
  const sheetKey = spec.sheetKey || sheetKeyOf(mem, store);
  const event = {
    farmer_phone: spec.farmerPhone || farmerPhone(mem, sheetKey),
    sheet_key: sheetKey,
    table_name: SHEET_TABLE[spec.sheet] || String(spec.sheet).toLowerCase(),
    record_id: recordId,
    action: spec.action,
    old_values: spec.oldValues || null,
    new_values: spec.action === "delete" ? null : snapshotRow(header, row),
    source: sourceFromNote(spec.note, spec.source),
    created_at: spec.createdAt || new Date().toISOString(),
    persisted: false,
  };
  if (!Array.isArray(mem._history)) mem._history = [];
  mem._history.push(event);
  return event;
}

function valuesMatchAccount(values, account) {
  if (!values || typeof values !== "object") return false;
  const needle = String(account || "").trim().toLowerCase();
  if (!needle) return false;
  for (const key of ["customer", "supplier", "name", "cow", "cow_name", "committee"]) {
    if (String(values[key] || "").trim().toLowerCase() === needle) return true;
  }
  return false;
}

function listHistory(mem, query) {
  const phone = String((query && query.phone) || "").replace(/[^\d]/g, "");
  const sheetKey = String((query && query.sheetKey) || "");
  const table = String((query && query.table) || "").trim().toLowerCase();
  const recordId = String((query && query.recordId) || "").trim();
  const account = String((query && query.account) || "").trim();
  const limit = Math.max(1, Math.min(200, Number(query && query.limit) || 40));
  const rows = (mem && mem._history) || [];
  const matched = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const event = rows[i];
    if (!event) continue;
    if (phone && event.farmer_phone !== phone) continue;
    if (sheetKey && event.sheet_key && event.sheet_key !== sheetKey) continue;
    if (table && String(event.table_name || "").toLowerCase() !== table) continue;
    if (recordId && event.record_id !== recordId) continue;
    if (account && !valuesMatchAccount(event.old_values, account) && !valuesMatchAccount(event.new_values, account)) {
      continue;
    }
    matched.push(event);
    if (matched.length >= limit) break;
  }
  return matched;
}

function latestForRecord(mem, recordId) {
  const rows = (mem && mem._history) || [];
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i] && rows[i].record_id === recordId) return rows[i];
  }
  return null;
}

function pendingHistory(mem) {
  return ((mem && mem._history) || []).filter((event) => event && !event.persisted);
}

module.exports = {
  SHEET_TABLE,
  TABLE_SHEET,
  sourceFromNote,
  snapshotRow,
  ensureOrigin,
  findByOrigin,
  appendHistory,
  listHistory,
  latestForRecord,
  pendingHistory,
  valuesMatchAccount,
};
