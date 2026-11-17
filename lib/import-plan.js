const { normalizePhone } = require("./config");
const { migrateStore } = require("./derived");
const { memoryToSnapshot } = require("./ledger-snapshot");
const { emptyLedger, MemorySheets } = require("./sheets");

const EXPORT_TABS = [
  ["Cows", "cows"],
  ["Milk_Log", "milk"],
  ["Customers", "customers"],
  ["Sales", "sales"],
  ["Payments", "payments"],
  ["Expenses", "expenses"],
  ["Fodder", "fodder"],
  ["Animal_Events", "animal_events"],
  ["Feed_Stock", "feed_stock"],
  ["Due_Bills", "due_bills"],
  ["Upcoming_Events", "upcoming_events"],
  ["Committees", "committees"],
  ["Committee_Log", "committee_log"],
  ["Committee_Status", "committee_status"],
];

const CHILD_TABLES = [
  ["cows", "cows"],
  ["milk_records", "milk"],
  ["customers", "customers"],
  ["sales", "sales"],
  ["payments", "payments"],
  ["expenses", "expenses"],
  ["fodder_purchases", "fodder"],
  ["suppliers", "suppliers"],
  ["committees", "committees"],
  ["committee_log", "committee_log"],
  ["committee_status", "committee_status"],
  ["animal_events", "animal_events"],
  ["feed_stock", "feed_stock"],
  ["due_bills", "due_bills"],
  ["upcoming_events", "upcoming_events"],
];

function tagRows(map, rows, sheetKey, tab) {
  for (let i = 1; i < (rows || []).length; i++) {
    if (Array.isArray(rows[i])) map.set(rows[i], `sheets:${sheetKey}:${tab}:${i}`);
  }
}

function applyGrid(ledger, tab, grid) {
  if (!Array.isArray(grid) || !grid.length || !Array.isArray(grid[0])) return;
  ledger[tab] = grid.map((row) => (Array.isArray(row) ? row.slice() : [row]));
}

async function memoryFromSheetsExport({ farmers, ledgers } = {}) {
  const mem = new MemorySheets();
  mem._originMap = new WeakMap();
  mem._farmerSettings = {};
  for (const farmer of farmers || []) {
    const phone = normalizePhone(farmer.phone);
    if (!phone) continue;
    await mem.upsertFarmer({
      phone,
      sheetId: farmer.sheetId || farmer.sheet_id || "",
      name: farmer.name || "",
      farmName: farmer.farmName || farmer.farm_name || "",
      onboardingState: farmer.onboardingState || farmer.onboarding_state || "",
      allowed: farmer.allowed,
      lastInboundAt: farmer.lastInboundAt || farmer.last_inbound_at || "",
      webToken: farmer.webToken || farmer.web_token || "",
    });
    const created = farmer.createdAt || farmer.created_at || "";
    if (created) {
      const saved = mem.findFarmer(phone);
      if (saved) {
        const header = mem.Farmers[0];
        const phoneIdx = header.findIndex((name) => String(name).toLowerCase() === "phone");
        const createdIdx = header.findIndex((name) => String(name).toLowerCase() === "created_at");
        for (let i = 1; i < mem.Farmers.length; i++) {
          if (normalizePhone(mem.Farmers[i][phoneIdx]) === phone && createdIdx !== -1) {
            mem.Farmers[i][createdIdx] = created;
          }
        }
      }
    }
  }

  const seen = new Set();
  for (const farmer of farmers || []) {
    const sheetId = String(farmer.sheetId || farmer.sheet_id || "").trim();
    if (!sheetId || seen.has(sheetId)) continue;
    seen.add(sheetId);
    const recent = (ledgers || {})[sheetId];
    if (!recent) continue;
    const ledger = emptyLedger();
    for (const [tab, key] of EXPORT_TABS) applyGrid(ledger, tab, recent[key]);
    migrateStore(ledger);
    for (const [tab] of EXPORT_TABS) tagRows(mem._originMap, ledger[tab], sheetId, tab);
    mem.ledgers[sheetId] = ledger;
  }
  return mem;
}

function childRows(snapshot, phoneToId) {
  const out = {};
  for (const [table] of CHILD_TABLES) out[table] = [];
  out.last_writes = [];
  const idFor = typeof phoneToId === "function"
    ? phoneToId
    : (phone) => (phoneToId.get ? phoneToId.get(normalizePhone(phone)) : phoneToId[normalizePhone(phone)]);
  for (const ledger of snapshot.ledgers || []) {
    const farmerId = idFor(ledger.owner_phone);
    if (!farmerId) {
      const err = new Error("import owner missing");
      throw err;
    }
    for (const [table, field] of CHILD_TABLES) {
      for (const row of ledger[field] || []) {
        out[table].push({ ...row, farmer_id: farmerId, sheet_key: ledger.sheet_key });
      }
    }
    if (ledger.last_write && typeof ledger.last_write === "object") {
      out.last_writes.push({
        farmer_id: farmerId,
        sheet_key: ledger.sheet_key,
        sheet: ledger.last_write.sheet || "",
        row_num: ledger.last_write.row_num,
        entry_type: ledger.last_write.entry_type || "",
        summary: ledger.last_write.summary || "",
        written_at: ledger.last_write.written_at || "",
      });
    }
  }
  return out;
}

function mergeRows(existing, incoming, key) {
  const map = new Map();
  for (const row of existing || []) map.set(row[key], { ...row });
  for (const row of incoming || []) {
    const prev = map.get(row[key]) || {};
    map.set(row[key], { ...prev, ...row });
  }
  return [...map.values()];
}

function farmerUpserts(snapshot) {
  return (snapshot.farmers || []).map((farmer) => {
    const row = {
      phone: farmer.phone,
      sheet_id: farmer.sheet_id || "",
      name: farmer.name || "",
      farm_name: farmer.farm_name || "",
      onboarding_state: farmer.onboarding_state || "",
      allowed: Boolean(farmer.allowed),
      created_at: farmer.created_at || "",
      last_inbound_at: farmer.last_inbound_at || "",
    };
    if (farmer.web_token) row.web_token = farmer.web_token;
    return row;
  });
}

module.exports = {
  EXPORT_TABS,
  CHILD_TABLES,
  memoryFromSheetsExport,
  childRows,
  mergeRows,
  farmerUpserts,
  memoryToSnapshot,
};
