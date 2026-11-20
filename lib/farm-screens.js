const { headerIndex } = require("./schema");
const { todayISO, TIMEZONE } = require("./config");
const { parseSheetDate, addDaysISO } = require("./format");
const { findGaps, activeAnimals } = require("./gaps");
const { normalizeSession, sessionLabel } = require("./session");
const { expenseLabel } = require("./expenses");
const { recomputeCustomer } = require("./balances");
const { snapshotRow, ensureOrigin, findByOrigin } = require("./history");

const CONFIRM = "Hatane ke liye pehle confirm karein.";

function num(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value == null || value === "") return 0;
  const n = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function same(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function scope(farmer) {
  return { sender: farmer.phone, sheetId: farmer.sheetId || "" };
}

function noteFor(farmer) {
  return `Screen ${farmer.phone}`;
}

function at(row, header, name) {
  const index = headerIndex(header, name);
  return index < 0 ? "" : row[index];
}

function setAt(row, header, name, value) {
  const index = headerIndex(header, name);
  if (index < 0) return;
  while (row.length <= index) row.push("");
  row[index] = value;
}

function appendNote(row, header, name, note) {
  if (!note) return;
  const index = headerIndex(header, name);
  if (index < 0) return;
  while (row.length <= index) row.push("");
  row[index] = row[index] ? `${row[index]}; ${note}` : note;
}

function findLast(rows, pred) {
  for (let i = rows.length - 1; i >= 1; i--) if (pred(rows[i])) return i;
  return -1;
}

function dayOf(value, fallback) {
  return parseSheetDate(value) || fallback;
}

function bad(error) {
  return { ok: false, status: 400, error };
}

async function readAll(sheets, farmer) {
  return sheets.readRecent({ days: 4000, refresh: false, ...scope(farmer) });
}

async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    const message = String(err && err.message ? err.message : "");
    if (/ledger|onboarding|available nahi/i.test(message)) return bad(message);
    throw err;
  }
}

function customerRate(store, name) {
  const rows = store.Customers || [];
  const header = rows[0] || [];
  const idx = findLast(rows, (row) => same(at(row, header, "name"), name));
  if (idx < 1) return 0;
  return num(at(rows[idx], header, "rate_pkr"));
}

function milkRows(data, date) {
  const rows = data.milk || [];
  const header = rows[0] || [];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (parseSheetDate(at(row, header, "date")) !== date) continue;
    const session = normalizeSession(at(row, header, "session"));
    out.push({
      id: row.originId || "",
      date,
      session,
      label: session ? sessionLabel(session) : "",
      cow_name: String(at(row, header, "cow_name") || ""),
      litres: num(at(row, header, "litres")),
    });
  }
  return out;
}

function shapeAaj(data, date) {
  const gaps = findGaps(data, date);
  const names = new Set(activeAnimals(data.cows));
  const logged = milkRows(data, date);
  for (const row of logged) if (row.cow_name) names.add(row.cow_name);
  const cows = [...names].map((name) => {
    const rows = logged.filter((row) => same(row.cow_name, name));
    const subah = rows.filter((row) => row.session === "am").reduce((sum, row) => sum + row.litres, 0);
    const shaam = rows.filter((row) => row.session === "pm").reduce((sum, row) => sum + row.litres, 0);
    return { name, subah: round2(subah), shaam: round2(shaam), rows };
  });
  const salesHeader = (data.sales || [])[0] || [];
  const sales = [];
  for (const row of (data.sales || []).slice(1)) {
    if (parseSheetDate(at(row, salesHeader, "date")) !== date) continue;
    sales.push({
      id: row.originId || "",
      date,
      customer: String(at(row, salesHeader, "customer") || ""),
      litres: num(at(row, salesHeader, "litres")),
      amount: num(at(row, salesHeader, "amount")),
      rate_pkr: num(at(row, salesHeader, "rate_pkr")),
      cash_received: num(at(row, salesHeader, "cash_received")),
    });
  }
  const customers = [];
  const custHeader = (data.customers || [])[0] || [];
  for (const row of (data.customers || []).slice(1)) {
    const name = String(at(row, custHeader, "name") || "");
    if (!name) continue;
    customers.push({ name, rate_pkr: num(at(row, custHeader, "rate_pkr")) });
  }
  return {
    ok: true,
    date,
    cows,
    sales,
    customers,
    milk_litres: gaps.milkLitres,
    sold_litres: gaps.soldLitres,
    unsold_litres: gaps.unaccountedLitres,
    oversold_litres: gaps.oversoldLitres,
  };
}

function shapeGrahak(data) {
  const header = (data.customers || [])[0] || [];
  const customers = [];
  for (const row of (data.customers || []).slice(1)) {
    const name = String(at(row, header, "name") || "");
    if (!name) continue;
    const supply = String(at(row, header, "supply_type") || "").toLowerCase();
    customers.push({
      id: row.originId || "",
      name,
      phone: String(at(row, header, "phone") || ""),
      balance: round2(num(at(row, header, "current_balance"))),
      rate_pkr: num(at(row, header, "rate_pkr")),
      supply_type: supply === "fixed" || supply === "flexible" ? supply : "",
      daily_litres: at(row, header, "daily_litres") === "" ? null : num(at(row, header, "daily_litres")),
      billing_cycle: String(at(row, header, "billing_cycle") || ""),
    });
  }
  const payHeader = (data.payments || [])[0] || [];
  const payments = [];
  for (const row of (data.payments || []).slice(1)) {
    payments.push({
      id: row.originId || "",
      date: parseSheetDate(at(row, payHeader, "date")),
      customer: String(at(row, payHeader, "customer") || ""),
      amount: num(at(row, payHeader, "amount")),
      method: String(at(row, payHeader, "method") || ""),
    });
  }
  payments.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { ok: true, customers, payments: payments.slice(0, 30) };
}

function shapeKhata(data) {
  const expHeader = (data.expenses || [])[0] || [];
  const expenses = [];
  for (const row of (data.expenses || []).slice(1)) {
    const category = String(at(row, expHeader, "category") || "");
    expenses.push({
      id: row.originId || "",
      date: parseSheetDate(at(row, expHeader, "date")),
      category,
      label: expenseLabel(category, "roman"),
      amount: num(at(row, expHeader, "amount")),
      note: String(at(row, expHeader, "note") || ""),
    });
  }
  expenses.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const fodderHeader = (data.fodder || [])[0] || [];
  const totals = new Map();
  for (const row of (data.fodder || []).slice(1)) {
    const name = String(at(row, fodderHeader, "supplier") || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const prev = totals.get(key) || { name, balance_owed: 0 };
    prev.balance_owed += num(at(row, fodderHeader, "balance_owed"));
    totals.set(key, prev);
  }
  const suppliers = [...totals.values()]
    .map((item) => ({ name: item.name, balance_owed: round2(item.balance_owed) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, expenses: expenses.slice(0, 40), suppliers };
}

function filled(value) {
  return !(value == null || String(value).trim() === "");
}

function inRange(value, from, to) {
  const day = parseSheetDate(value);
  return Boolean(day) && day >= from && day <= to;
}

function customerRates(data) {
  const header = (data.customers || [])[0] || [];
  const rates = new Map();
  for (const row of (data.customers || []).slice(1)) {
    const name = String(at(row, header, "name") || "").trim().toLowerCase();
    if (!name || !filled(at(row, header, "rate_pkr"))) continue;
    const rate = num(at(row, header, "rate_pkr"));
    if (rate > 0) rates.set(name, rate);
  }
  return rates;
}

function sumSalesAmount(data, from, to) {
  const rows = data.sales || [];
  const header = rows[0] || [];
  const rates = customerRates(data);
  let total = 0;
  let missing = 0;
  for (const row of rows.slice(1)) {
    if (!inRange(at(row, header, "date"), from, to)) continue;
    if (filled(at(row, header, "amount"))) {
      total += num(at(row, header, "amount"));
      continue;
    }
    const saleRate = filled(at(row, header, "rate_pkr")) ? num(at(row, header, "rate_pkr")) : 0;
    const name = String(at(row, header, "customer") || "").trim().toLowerCase();
    const rate = saleRate > 0 ? saleRate : (rates.get(name) || 0);
    if (!(rate > 0)) {
      missing += 1;
      continue;
    }
    total += num(at(row, header, "litres")) * rate;
  }
  return { sales_amount: round2(total), sales_amount_missing: missing };
}

function fodderPurchaseCost(row, header) {
  if (filled(at(row, header, "cost_pkr"))) return num(at(row, header, "cost_pkr"));
  if (!(num(at(row, header, "quantity")) > 0)) return 0;
  return num(at(row, header, "cash_paid")) + num(at(row, header, "balance_owed"));
}

function sumFodderCost(rows, from, to) {
  const header = (rows || [])[0] || [];
  let total = 0;
  for (const row of (rows || []).slice(1)) {
    if (!inRange(at(row, header, "date"), from, to)) continue;
    total += fodderPurchaseCost(row, header);
  }
  return round2(total);
}

function sumTab(rows, from, to, amountName) {
  const header = (rows || [])[0] || [];
  let total = 0;
  for (const row of (rows || []).slice(1)) {
    if (!inRange(at(row, header, "date"), from, to)) continue;
    total += num(at(row, header, amountName));
  }
  return round2(total);
}

function shapeHisaab(data, range) {
  const today = todayISO(TIMEZONE);
  const bounds = range === "month"
    ? { range: "month", from: today.slice(0, 8) + "01", to: today }
    : { range: "week", from: addDaysISO(today, -6), to: today };
  const customers = shapeGrahak(data).customers;
  const due = round2(customers.reduce((sum, row) => sum + (row.balance > 0 ? row.balance : 0), 0));
  return {
    ok: true,
    ...bounds,
    milk_litres: sumTab(data.milk, bounds.from, bounds.to, "litres"),
    sold_litres: sumTab(data.sales, bounds.from, bounds.to, "litres"),
    ...sumSalesAmount(data, bounds.from, bounds.to),
    payments: sumTab(data.payments, bounds.from, bounds.to, "amount"),
    expenses: sumTab(data.expenses, bounds.from, bounds.to, "amount"),
    fodder_cost: sumFodderCost(data.fodder, bounds.from, bounds.to),
    customers_due: due,
  };
}

function stampRead(mem, data) {
  if (!mem || !data) return data;
  for (const key of ["milk", "sales", "payments", "expenses", "customers", "cows", "fodder"]) {
    const rows = data[key];
    if (!rows) continue;
    for (let i = 1; i < rows.length; i++) ensureOrigin(mem, rows[i]);
  }
  return data;
}

function mutateAaj(store, mem, body, farmer) {
  const date = dayOf(body.date, todayISO(TIMEZONE));
  const op = String(body.op || "add");
  if (op === "add") {
    const cow = String(body.cow_name || "").trim();
    const session = normalizeSession(body.session);
    const litres = num(body.litres);
    if (!cow) return bad("Gay ka naam likhein.");
    if (!session) return bad("Subah ya shaam chunein.");
    if (!(litres > 0)) return bad("Litre likhein.");
    mem.commitOne(store, { type: "milk", date, session, cow_name: cow, litres }, noteFor(farmer));
    return { ok: true };
  }
  if (op === "add_sale") {
    const customer = String(body.customer || "").trim();
    const litres = num(body.litres);
    if (!customer) return bad("Grahak ka naam likhein.");
    if (!(litres > 0)) return bad("Litre likhein.");
    const rate = num(body.rate_pkr) || customerRate(store, customer);
    if (!(rate > 0)) return bad("Is grahak ka rate likhein.");
    const amount = round2(litres * rate);
    const cash = body.cash === true ? amount : 0;
    mem.commitOne(store, {
      type: "sale",
      date,
      customer,
      litres,
      rate_pkr: rate,
      amount,
      cash_received: cash,
      balance_added: round2(amount - cash),
    }, noteFor(farmer));
    return { ok: true };
  }
  if (op === "delete_sale") {
    if (body.confirm !== true) return bad(CONFIRM);
    const rows = store.Sales;
    const saleHeader = rows[0];
    const saleIdx = findLast(rows, (row) => (
      parseSheetDate(at(row, saleHeader, "date")) === date
      && same(at(row, saleHeader, "customer"), body.customer)
      && closeAmount(at(row, saleHeader, "litres"), body.litres)
    ));
    if (saleIdx < 1) return bad("Record nahi mila.");
    const before = snapshotRow(saleHeader, rows[saleIdx]);
    const recordId = ensureOrigin(mem, rows[saleIdx]);
    rows.splice(saleIdx, 1);
    mem.removed(store, "Sales", recordId, before, noteFor(farmer));
    recomputeCustomer(store, before.customer);
    return { ok: true };
  }
  const milk = store.Milk_Log;
  const header = milk[0];
  const byId = body.id ? findByOrigin(milk, body.id) : -1;
  const match = (row) => (
    parseSheetDate(at(row, header, "date")) === date
    && normalizeSession(at(row, header, "session")) === normalizeSession(body.session)
    && same(at(row, header, "cow_name"), body.cow_name)
    && (body.litres == null || body.litres === "" || closeAmount(at(row, header, "litres"), body.litres))
  );
  const idx = byId >= 1 ? byId : findLast(milk, match);
  if (idx < 1) return bad("Record nahi mila.");
  if (op === "delete") {
    if (body.confirm !== true) return bad(CONFIRM);
    const before = snapshotRow(header, milk[idx]);
    const recordId = ensureOrigin(mem, milk[idx]);
    milk.splice(idx, 1);
    mem.removed(store, "Milk_Log", recordId, before, noteFor(farmer));
    return { ok: true };
  }
  if (op === "update") {
    const litres = num(body.new_litres);
    if (!(litres > 0)) return bad("Litre likhein.");
    const before = snapshotRow(header, milk[idx]);
    setAt(milk[idx], header, "litres", litres);
    appendNote(milk[idx], header, "source_note", `badla (${noteFor(farmer)})`);
    mem.wrote(store, "Milk_Log", idx + 1, "update", before, noteFor(farmer));
    return { ok: true };
  }
  return bad("Yeh kaam theek nahi.");
}

function closeAmount(a, b) {
  return Math.abs(num(a) - num(b)) < 0.001;
}

function mutateGrahak(store, mem, body, farmer) {
  const op = String(body.op || "pay");
  const date = dayOf(body.date, todayISO(TIMEZONE));
  if (op === "pay") {
    const customer = String(body.customer || "").trim();
    const amount = num(body.amount);
    if (!customer) return bad("Grahak ka naam likhein.");
    if (!(amount > 0)) return bad("Raqam likhein.");
    const idx = findLast(store.Customers, (row) => same(at(row, store.Customers[0], "name"), customer));
    if (idx < 1) return bad("Grahak nahi mila.");
    mem.commitOne(store, {
      type: "payment",
      date,
      customer,
      amount,
      method: String(body.method || "wasool"),
    }, noteFor(farmer));
    return { ok: true };
  }
  if (op === "supply") {
    const customer = String(body.customer || "").trim();
    const supply = String(body.supply_type || "").toLowerCase();
    if (supply !== "fixed" && supply !== "flexible") return bad("Supply fixed ya flexible honi chahiye.");
    const idx = findLast(store.Customers, (row) => same(at(row, store.Customers[0], "name"), customer));
    if (idx < 1) return bad("Grahak nahi mila.");
    mem.applySupplyCells(store.Customers[idx], store.Customers[0], {
      supply_type: supply,
      daily_litres: supply === "fixed" ? body.daily_litres : "",
    });
    return { ok: true };
  }
  if (op === "delete_payment") {
    if (body.confirm !== true) return bad(CONFIRM);
    const rows = store.Payments;
    const header = rows[0];
    const idx = findLast(rows, (row) => (
      parseSheetDate(at(row, header, "date")) === date
      && same(at(row, header, "customer"), body.customer)
      && closeAmount(at(row, header, "amount"), body.amount)
    ));
    if (idx < 1) return bad("Record nahi mila.");
    const before = snapshotRow(header, rows[idx]);
    const recordId = ensureOrigin(mem, rows[idx]);
    rows.splice(idx, 1);
    mem.removed(store, "Payments", recordId, before, noteFor(farmer));
    recomputeCustomer(store, before.customer);
    return { ok: true };
  }
  return bad("Yeh kaam theek nahi.");
}

function mutateKhata(store, mem, body, farmer) {
  const op = String(body.op || "add");
  const date = dayOf(body.date, todayISO(TIMEZONE));
  if (op === "add") {
    const category = String(body.category || "").trim();
    const amount = num(body.amount);
    if (!category) return bad("Kharcha ka naam likhein.");
    if (!(amount > 0)) return bad("Raqam likhein.");
    const saved = mem.commitOne(store, {
      type: "expense",
      date,
      category,
      amount,
      note: body.note || noteFor(farmer),
    }, noteFor(farmer));
    if (saved && saved.skipped) return bad("Raqam likhein.");
    return { ok: true };
  }
  if (op === "set_supplier") {
    const supplier = String(body.supplier || "").trim();
    if (!supplier) return bad("Supplier ka naam likhein.");
    const header = store.Fodder[0];
    let current = 0;
    for (const row of store.Fodder.slice(1)) {
      if (same(at(row, header, "supplier"), supplier)) current += num(at(row, header, "balance_owed"));
    }
    const delta = round2(num(body.balance_owed) - current);
    if (Math.abs(delta) < 0.001) return { ok: true };
    mem.commitOne(store, {
      type: "fodder",
      date,
      item: "hisab",
      quantity: "",
      unit: "",
      cost_pkr: 0,
      supplier,
      cash_paid: 0,
      balance_owed: delta,
      note: "balance theek",
    }, noteFor(farmer));
    return { ok: true };
  }
  const rows = store.Expenses;
  const header = rows[0];
  const idx = findLast(rows, (row) => (
    parseSheetDate(at(row, header, "date")) === date
    && same(at(row, header, "category"), body.category)
    && closeAmount(at(row, header, "amount"), body.amount)
  ));
  if (op === "delete") {
    if (body.confirm !== true) return bad(CONFIRM);
    if (idx < 1) return bad("Record nahi mila.");
    const before = snapshotRow(header, rows[idx]);
    const recordId = ensureOrigin(mem, rows[idx]);
    rows.splice(idx, 1);
    mem.removed(store, "Expenses", recordId, before, noteFor(farmer));
    return { ok: true };
  }
  if (op === "update") {
    if (idx < 1) return bad("Record nahi mila.");
    const amount = num(body.new_amount);
    if (!(amount > 0)) return bad("Raqam likhein.");
    const before = snapshotRow(header, rows[idx]);
    setAt(rows[idx], header, "amount", amount);
    if (body.note != null) setAt(rows[idx], header, "note", body.note);
    mem.wrote(store, "Expenses", idx + 1, "update", before, noteFor(farmer));
    return { ok: true };
  }
  return bad("Yeh kaam theek nahi.");
}

async function getAaj(sheets, farmer) {
  return guarded(async () => shapeAaj(stampRead(sheets, await readAll(sheets, farmer)), todayISO(TIMEZONE)));
}

async function postAaj(sheets, farmer, body) {
  return guarded(async () => {
    const result = await sheets.withLedger(scope(farmer), (store, mem) => mutateAaj(store, mem, body || {}, farmer));
    if (!result || result.ok === false) return result;
    return shapeAaj(stampRead(sheets, await readAll(sheets, farmer)), dayOf(body && body.date, todayISO(TIMEZONE)));
  });
}

async function getGrahak(sheets, farmer) {
  return guarded(async () => shapeGrahak(stampRead(sheets, await readAll(sheets, farmer))));
}

async function postGrahak(sheets, farmer, body) {
  return guarded(async () => {
    const result = await sheets.withLedger(scope(farmer), (store, mem) => mutateGrahak(store, mem, body || {}, farmer));
    if (!result || result.ok === false) return result;
    return shapeGrahak(stampRead(sheets, await readAll(sheets, farmer)));
  });
}

async function getKhata(sheets, farmer) {
  return guarded(async () => shapeKhata(stampRead(sheets, await readAll(sheets, farmer))));
}

async function postKhata(sheets, farmer, body) {
  return guarded(async () => {
    const result = await sheets.withLedger(scope(farmer), (store, mem) => mutateKhata(store, mem, body || {}, farmer));
    if (!result || result.ok === false) return result;
    return shapeKhata(stampRead(sheets, await readAll(sheets, farmer)));
  });
}

async function getHisaab(sheets, farmer, range) {
  return guarded(async () => shapeHisaab(await readAll(sheets, farmer), range === "month" ? "month" : "week"));
}

module.exports = {
  getAaj,
  postAaj,
  getGrahak,
  postGrahak,
  getKhata,
  postKhata,
  getHisaab,
  CONFIRM,
};
