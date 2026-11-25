const { todayISO, TIMEZONE } = require("./config");
const { addDaysISO } = require("./billing");
const { fodderItemName } = require("./ledger");
const { headerIndex } = require("./schema");

const FEED_SYNONYMS = [
  ["silega", "silage"],
  ["silej", "silage"],
  ["silaj", "silage"],
  ["silage", "silage"],
  ["toori", "bhoosa"],
  ["turi", "bhoosa"],
  ["bhoosa", "bhoosa"],
  ["wanda", "wanda"],
  ["khal", "khal"],
  ["chara", "chara"],
];

function canonicalFeedItem(raw) {
  const words = String(raw || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  for (const [key, canon] of FEED_SYNONYMS) {
    if (words.includes(key)) return canon;
  }
  return words.join(" ");
}

function stockItemName(raw) {
  return canonicalFeedItem(raw) || fodderItemName(raw || "other");
}

function findStockRow(rows, item) {
  const needle = canonicalFeedItem(item);
  if (!needle) return -1;
  for (let i = 1; i < (rows || []).length; i++) {
    if (canonicalFeedItem(rows[i][0]) === needle) return i;
  }
  return -1;
}

function ensureStockRow(rows, item) {
  if (!rows || !rows.length) {
    rows = [["item", "quantity", "unit", "daily_use", "updated_at", "notes"]];
  }
  let idx = findStockRow(rows, item);
  if (idx === -1) {
    const header = rows[0];
    const row = new Array(header.length).fill("");
    row[0] = canonicalFeedItem(item) || stockItemName(item);
    row[1] = 0;
    rows.push(row);
    idx = rows.length - 1;
  }
  return idx;
}

function purchasePart(values) {
  if (!values || typeof values !== "object") return null;
  const item = String(values.item || "").trim();
  if (!item) return null;
  const kind = item.toLowerCase();
  if (kind === "adaigi" || kind === "jama" || kind === "opening") return null;
  if (values.quantity === "" || values.quantity == null) return null;
  const quantity = Number(values.quantity);
  if (!Number.isFinite(quantity) || Math.abs(quantity) < 0.0000001) return null;
  return { item, quantity, unit: String(values.unit || "") };
}

function rowSnapshot(header, row) {
  const out = {};
  (header || []).forEach((name, index) => {
    const key = String(name || "").trim();
    if (!key) return;
    const value = row ? row[index] : "";
    out[key] = value == null ? "" : value;
  });
  return out;
}

function shiftPurchaseStock(store, mem, item, delta, unit, note) {
  if (!store || !item || !Number.isFinite(Number(delta)) || Math.abs(Number(delta)) < 0.0000001) return;
  const rows = store.Feed_Stock;
  if (!rows || !rows.length) return;
  const header = rows[0];
  const beforeIdx = findStockRow(rows, item);
  if (Number(delta) < 0 && beforeIdx < 1) return;
  const before = beforeIdx > 0 ? rowSnapshot(header, rows[beforeIdx]) : null;
  const applied = applyStockDelta(rows, {
    item,
    quantity: Number(delta),
    unit: unit || "",
    notes: before ? "" : "purchase",
    today: todayISO(TIMEZONE),
  });
  const idx = applied.idx;
  if (idx == null || idx < 1 || !rows[idx]) return;
  const qtyIdx = Math.max(1, headerIndex(header, "quantity"));
  const useIdx = headerIndex(header, "daily_use");
  const qty = Number(rows[idx][qtyIdx]) || 0;
  const daily = useIdx >= 0 ? Number(rows[idx][useIdx]) || 0 : 0;
  if (Math.abs(qty) < 0.0005 && Math.abs(daily) < 0.0005) {
    const { ensureOrigin } = require("./history");
    const id = ensureOrigin(mem, rows[idx]);
    const snap = rowSnapshot(header, rows[idx]);
    rows.splice(idx, 1);
    if (mem && typeof mem.removed === "function") mem.removed(store, "Feed_Stock", id, snap, note);
    return;
  }
  if (mem && typeof mem.wrote === "function") {
    mem.wrote(store, "Feed_Stock", idx + 1, before ? "update" : "create", before, note);
  }
}

function syncFodderStock(store, mem, before, after, note) {
  const prev = purchasePart(before);
  const next = purchasePart(after);
  if (prev && next && stockItemName(prev.item) === stockItemName(next.item)) {
    const delta = Math.round((next.quantity - prev.quantity) * 1000) / 1000;
    shiftPurchaseStock(store, mem, next.item, delta, next.unit || prev.unit, note);
    return;
  }
  if (prev) shiftPurchaseStock(store, mem, prev.item, -prev.quantity, prev.unit, note);
  if (next) shiftPurchaseStock(store, mem, next.item, next.quantity, next.unit, note);
}

function applyStockDelta(rows, { item, quantity, unit, daily_use, notes, today }) {
  const idx = ensureStockRow(rows, item);
  const header = rows[0];
  const qtyIdx = Math.max(1, headerIndex(header, "quantity"));
  const unitIdx = headerIndex(header, "unit");
  const useIdx = headerIndex(header, "daily_use");
  const updIdx = headerIndex(header, "updated_at");
  const noteIdx = headerIndex(header, "notes");
  const current = Number(rows[idx][qtyIdx]) || 0;
  const delta = Number(quantity);
  if (Number.isFinite(delta)) {
    rows[idx][qtyIdx] = Math.round((current + delta) * 1000) / 1000;
  }
  if (unit && unitIdx !== -1 && !rows[idx][unitIdx]) rows[idx][unitIdx] = unit;
  if (daily_use != null && daily_use !== "" && useIdx !== -1) {
    rows[idx][useIdx] = Number(daily_use) || 0;
  }
  if (updIdx !== -1) rows[idx][updIdx] = today || todayISO(TIMEZONE);
  if (notes && noteIdx !== -1) {
    rows[idx][noteIdx] = rows[idx][noteIdx] ? `${rows[idx][noteIdx]}; ${notes}` : notes;
  }
  return { idx, quantity: rows[idx][qtyIdx], unit: unitIdx !== -1 ? rows[idx][unitIdx] : "" };
}

const MANN_KG = 40;
const REORDER_DAYS = 3;

function toKg(quantity, unit) {
  const qty = Number(quantity) || 0;
  const u = String(unit || "").toLowerCase();
  if (u === "mann" || u === "man" || u === "mun") return qty * MANN_KG;
  if (u === "kg" || u === "kilo" || u === "kgs") return qty;
  return null;
}

function averageCostPerKg(fodderRows, item) {
  const needle = stockItemName(item);
  let cost = 0;
  let kg = 0;
  const rows = fodderRows || [];
  const header = rows[0] || [];
  const hasHeader = header && String(header[0] || "").toLowerCase() === "date";
  const body = hasHeader ? rows.slice(1) : rows;
  for (const row of body) {
    if (stockItemName(row[1]) !== needle) continue;
    const converted = toKg(row[2], row[3]);
    const rowCost = Number(String(row[4] == null ? "" : row[4]).replace(/[^0-9.-]/g, "")) || 0;
    if (converted && converted > 0 && rowCost > 0) {
      kg += converted;
      cost += rowCost;
    }
  }
  if (!kg) return "";
  return Math.round((cost / kg) * 100) / 100;
}

function computeStockFields(row, header, today, fodderRows) {
  const { headerIndex } = require("./schema");
  const info = runoutFor(row, header, today);
  const daysLeft = info.daysLeft;
  const runOut = info.runoutDate || "";
  let reorderBy = "";
  if (runOut) {
    const { addDaysISO } = require("./billing");
    reorderBy = addDaysISO(runOut, -REORDER_DAYS);
  }
  const item = row[headerIndex(header, "item") === -1 ? 0 : headerIndex(header, "item")];
  const avg = fodderRows ? averageCostPerKg(fodderRows, item) : row[headerIndex(header, "avg_cost_per_kg")] || "";
  return {
    ...info,
    days_left: daysLeft == null ? "" : daysLeft,
    run_out_date: runOut,
    reorder_by: reorderBy,
    avg_cost_per_kg: avg,
  };
}

function applyComputedStock(rows, today, fodderRows) {
  const { headerIndex, ensureHeaderRow, TAB_HEADERS } = require("./schema");
  if (!rows || !rows.length) return rows;
  ensureHeaderRow(rows, TAB_HEADERS.Feed_Stock);
  const header = rows[0];
  const set = (row, col, val) => {
    const i = headerIndex(header, col);
    if (i !== -1) {
      while (row.length <= i) row.push("");
      row[i] = val == null ? "" : val;
    }
  };
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    const computed = computeStockFields(rows[i], header, today, fodderRows);
    set(rows[i], "days_left", computed.days_left);
    set(rows[i], "run_out_date", computed.run_out_date);
    set(rows[i], "reorder_by", computed.reorder_by);
    set(rows[i], "avg_cost_per_kg", computed.avg_cost_per_kg);
  }
  return rows;
}

function runoutFor(row, header, today) {
  const qty = Number(row[headerIndex(header, "quantity")]) || 0;
  const daily = Number(row[headerIndex(header, "daily_use")]) || 0;
  const unit = row[headerIndex(header, "unit")] || "";
  const item = row[0];
  if (qty < 0) {
    return { item, quantity: qty, unit, daily_use: daily, daysLeft: 0, runoutDate: today, status: "empty" };
  }
  if (!daily || daily <= 0) {
    return { item, quantity: qty, unit, daily_use: daily, daysLeft: null, runoutDate: "", status: qty <= 0 ? "empty" : "unknown" };
  }
  const daysLeft = Math.floor(qty / daily);
  const runoutDate = addDaysISO(today, daysLeft);
  let status = "ok";
  if (qty <= 0 || daysLeft <= 0) status = "empty";
  else if (daysLeft <= 3) status = "low";
  return { item, quantity: qty, unit, daily_use: daily, daysLeft, runoutDate, status };
}

function stockStatus(rows, refDate, lowDays = 3) {
  const today = (refDate || todayISO(TIMEZONE)).slice(0, 10);
  const header = (rows && rows[0]) || ["item", "quantity", "unit", "daily_use", "updated_at", "notes"];
  return (rows || []).slice(1).filter((r) => r[0]).map((r) => {
    const info = runoutFor(r, header, today);
    if (info.daysLeft != null && info.daysLeft <= lowDays && info.status === "ok") info.status = "low";
    return info;
  });
}

function lowStock(rows, refDate, lowDays = 3) {
  return stockStatus(rows, refDate, lowDays).filter((s) => s.status === "low" || s.status === "empty");
}

function formatStockLine(items) {
  if (!items.length) return "";
  return items
    .map((s) => {
      if (s.status === "empty") return `${s.item} khatam ho chuka hai`;
      if (s.daysLeft != null) return `${s.item} ~${s.daysLeft} din mein khatam ho sakta hai`;
      return `${s.item} kam reh gaya hai`;
    })
    .join("; ");
}

module.exports = {
  canonicalFeedItem,
  stockItemName,
  findStockRow,
  applyStockDelta,
  purchasePart,
  syncFodderStock,
  runoutFor,
  stockStatus,
  lowStock,
  formatStockLine,
  toKg,
  averageCostPerKg,
  computeStockFields,
  applyComputedStock,
  REORDER_DAYS,
};
