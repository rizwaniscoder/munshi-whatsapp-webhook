const { todayISO, TIMEZONE } = require("./config");
const { addDaysISO } = require("./billing");
const { fodderItemName } = require("./ledger");
const { headerIndex } = require("./schema");

function stockItemName(raw) {
  return fodderItemName(raw || "other");
}

function findStockRow(rows, item) {
  const needle = stockItemName(item);
  for (let i = 1; i < (rows || []).length; i++) {
    if (stockItemName(rows[i][0]) === needle) return i;
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
    row[0] = stockItemName(item);
    row[1] = 0;
    rows.push(row);
    idx = rows.length - 1;
  }
  return idx;
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
  stockItemName,
  findStockRow,
  applyStockDelta,
  runoutFor,
  stockStatus,
  lowStock,
  formatStockLine,
};
