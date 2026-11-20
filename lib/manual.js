const { headerIndex } = require("./schema");
const { todayISO, TIMEZONE } = require("./config");
const { parseSheetDate } = require("./format");
const { normalizeCycle } = require("./billing");
const { normalizeSession } = require("./session");
const { isTotalCow } = require("./gaps");
const { expenseLabel } = require("./expenses");
const { num, round2, same, isDebitMethod, recomputeCustomer } = require("./balances");
const { syncFodderStock } = require("./feed");
const {
  TABLE_SHEET,
  snapshotRow,
  ensureOrigin,
  findByOrigin,
  listHistory,
  latestForRecord,
} = require("./history");

const CONFIRM = "Hatane ke liye pehle confirm karein.";
const LIST_LIMIT = 60;

const KIND_SHEET = {
  milk: "Milk_Log",
  sale: "Sales",
  payment: "Payments",
  customer_adjust: "Sales",
  fodder: "Fodder",
  supplier_payment: "Fodder",
  supplier_adjust: "Fodder",
  expense: "Expenses",
  committee: "Committees",
  committee_log: "Committee_Log",
  animal: "Animal_Events",
  feed: "Feed_Stock",
  cow: "Cows",
  customer: "Customers",
  supplier: "Fodder",
};

function bad(error) {
  return { ok: false, status: 400, error };
}

function noteFor(farmer) {
  return `Manual ${farmer && farmer.phone ? farmer.phone : ""}`.trim();
}

function dayOf(value) {
  return parseSheetDate(value) || todayISO(TIMEZONE);
}

function at(row, header, name) {
  const index = headerIndex(header, name);
  return index < 0 ? "" : row[index];
}

function setAt(row, header, name, value) {
  const index = headerIndex(header, name);
  if (index < 0) return;
  while (row.length <= index) row.push("");
  row[index] = value == null ? "" : value;
}

function customerRate(store, name) {
  const rows = store.Customers || [];
  const header = rows[0] || [];
  for (let i = rows.length - 1; i >= 1; i--) {
    if (same(at(rows[i], header, "name"), name)) return num(at(rows[i], header, "rate_pkr"));
  }
  return 0;
}

function fodderKind(item) {
  const name = String(item || "").trim().toLowerCase();
  if (name === "adaigi") return "supplier_payment";
  if (name === "jama") return "supplier_adjust";
  if (name === "opening") return "supplier_opening";
  return "fodder";
}

function stampAll(mem, rows) {
  for (let i = 1; i < (rows || []).length; i++) ensureOrigin(mem, rows[i]);
}

function recordBase(mem, row, kind, extra) {
  return { id: ensureOrigin(mem, row), kind, ...(extra || {}) };
}

function listMilk(store, mem) {
  const rows = store.Milk_Log || [];
  const header = rows[0] || [];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    out.push(recordBase(mem, row, "milk", {
      date: parseSheetDate(at(row, header, "date")) || "",
      session: normalizeSession(at(row, header, "session")) || String(at(row, header, "session") || ""),
      cow_name: String(at(row, header, "cow_name") || ""),
      litres: num(at(row, header, "litres")),
    }));
  }
  return out.reverse().slice(0, LIST_LIMIT);
}

function listSales(store, mem) {
  const rows = store.Sales || [];
  const header = rows[0] || [];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const note = String(at(row, header, "source_note") || "");
    const litres = num(at(row, header, "litres"));
    const amount = num(at(row, header, "amount"));
    const added = num(at(row, header, "balance_added"));
    let kind = "sale";
    if (/^jama:/i.test(note) || (litres === 0 && amount === 0 && added > 0)) kind = "customer_adjust";
    else if (/^credit:/i.test(note) || (litres === 0 && amount === 0 && added < 0)) kind = "customer_adjust";
    out.push(recordBase(mem, row, kind, {
      date: parseSheetDate(at(row, header, "date")) || "",
      customer: String(at(row, header, "customer") || ""),
      litres,
      rate_pkr: num(at(row, header, "rate_pkr")),
      amount,
      cash_received: num(at(row, header, "cash_received")),
      balance_added: added,
      direction: added < 0 || /^credit:/i.test(note) ? "credit" : "debit",
      note: note.replace(/^(jama|credit):\s*/i, ""),
    }));
  }
  return out.reverse().slice(0, LIST_LIMIT);
}

function listPayments(store, mem) {
  const rows = store.Payments || [];
  const header = rows[0] || [];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    out.push(recordBase(mem, row, "payment", {
      date: parseSheetDate(at(row, header, "date")) || "",
      customer: String(at(row, header, "customer") || ""),
      amount: num(at(row, header, "amount")),
      method: String(at(row, header, "method") || ""),
    }));
  }
  return out.reverse().slice(0, LIST_LIMIT);
}

function listExpenses(store, mem) {
  const rows = store.Expenses || [];
  const header = rows[0] || [];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const category = String(at(row, header, "category") || "");
    out.push(recordBase(mem, row, "expense", {
      date: parseSheetDate(at(row, header, "date")) || "",
      category,
      label: expenseLabel(category, "roman"),
      amount: num(at(row, header, "amount")),
      note: String(at(row, header, "note") || ""),
    }));
  }
  return out.reverse().slice(0, LIST_LIMIT);
}

function listFodder(store, mem) {
  const rows = store.Fodder || [];
  const header = rows[0] || [];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const item = String(at(row, header, "item") || "");
    const kind = fodderKind(item);
    if (kind === "supplier_opening") continue;
    out.push(recordBase(mem, row, kind === "fodder" ? "fodder" : kind, {
      date: parseSheetDate(at(row, header, "date")) || "",
      item,
      quantity: at(row, header, "quantity") === "" ? "" : num(at(row, header, "quantity")),
      unit: String(at(row, header, "unit") || ""),
      cost_pkr: num(at(row, header, "cost_pkr")),
      supplier: String(at(row, header, "supplier") || ""),
      cash_paid: num(at(row, header, "cash_paid")),
      balance_owed: num(at(row, header, "balance_owed")),
      note: String(at(row, header, "source_note") || ""),
      amount: Math.abs(num(at(row, header, "balance_owed"))) || num(at(row, header, "cash_paid")),
    }));
  }
  return out.reverse().slice(0, LIST_LIMIT);
}

function listCows(store, mem) {
  const rows = store.Cows || [];
  const header = rows[0] || [];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const name = String(at(row, header, "name") || "");
    if (!name) continue;
    out.push(recordBase(mem, row, "cow", {
      name,
      animal_type: String(at(row, header, "type") || ""),
      breed: String(at(row, header, "breed") || ""),
      status: String(at(row, header, "status") || ""),
      avg_daily_litres: at(row, header, "avg_daily_litres") === "" ? "" : num(at(row, header, "avg_daily_litres")),
      notes: String(at(row, header, "notes") || ""),
    }));
  }
  return out;
}

function listCustomers(store, mem) {
  const rows = store.Customers || [];
  const header = rows[0] || [];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const name = String(at(row, header, "name") || "");
    if (!name) continue;
    out.push(recordBase(mem, row, "customer", {
      name,
      phone: String(at(row, header, "phone") || ""),
      rate_pkr: num(at(row, header, "rate_pkr")),
      opening_balance: num(at(row, header, "opening_balance")),
      balance: round2(num(at(row, header, "current_balance"))),
      supply_type: String(at(row, header, "supply_type") || ""),
      daily_litres: at(row, header, "daily_litres") === "" ? "" : num(at(row, header, "daily_litres")),
      billing_cycle: String(at(row, header, "billing_cycle") || ""),
      notes: String(at(row, header, "notes") || ""),
    }));
  }
  return out;
}

function supplierGroups(store, mem) {
  const rows = store.Fodder || [];
  const header = rows[0] || [];
  const groups = new Map();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const name = String(at(row, header, "supplier") || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const group = groups.get(key) || { name, balance: 0, opening: 0, openingRow: null };
    group.balance += num(at(row, header, "balance_owed"));
    if (fodderKind(at(row, header, "item")) === "supplier_opening") {
      group.opening += num(at(row, header, "balance_owed"));
      group.openingRow = row;
    }
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      id: group.openingRow ? ensureOrigin(mem, group.openingRow) : `supplier:${group.name.toLowerCase()}`,
      kind: "supplier",
      name: group.name,
      balance_owed: round2(group.balance),
      opening_balance: round2(group.opening),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function listCommittees(store, mem) {
  const rows = store.Committees || [];
  const header = rows[0] || [];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const name = String(at(row, header, "name") || "");
    if (!name) continue;
    out.push(recordBase(mem, row, "committee", {
      name,
      amount: num(at(row, header, "amount")),
      frequency: String(at(row, header, "frequency") || ""),
      start_date: parseSheetDate(at(row, header, "start_date")) || "",
      organizer: String(at(row, header, "organizer") || ""),
      status: String(at(row, header, "status") || ""),
      notes: String(at(row, header, "notes") || ""),
    }));
  }
  return out;
}

function listCommitteeLog(store, mem) {
  const rows = store.Committee_Log || [];
  const header = rows[0] || [];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    out.push(recordBase(mem, row, "committee_log", {
      date: parseSheetDate(at(row, header, "date")) || "",
      committee: String(at(row, header, "committee") || ""),
      status: String(at(row, header, "status") || ""),
      amount: num(at(row, header, "amount")),
      note: String(at(row, header, "note") || ""),
    }));
  }
  return out.reverse().slice(0, LIST_LIMIT);
}

function listAnimals(store, mem) {
  const rows = store.Animal_Events || [];
  const header = rows[0] || [];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    out.push(recordBase(mem, row, "animal", {
      date: parseSheetDate(at(row, header, "date")) || "",
      cow: String(at(row, header, "cow") || ""),
      event_type: String(at(row, header, "event_type") || ""),
      details: String(at(row, header, "details") || ""),
      doctor_name: String(at(row, header, "doctor_name") || ""),
      diagnosis: String(at(row, header, "diagnosis") || ""),
      medicines: String(at(row, header, "medicines") || ""),
      cost_pkr: num(at(row, header, "cost_pkr")),
      next_due_date: parseSheetDate(at(row, header, "next_due_date")) || "",
    }));
  }
  return out.reverse().slice(0, LIST_LIMIT);
}

function listFeed(store, mem) {
  const rows = store.Feed_Stock || [];
  const header = rows[0] || [];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const item = String(at(row, header, "item") || "");
    if (!item) continue;
    out.push(recordBase(mem, row, "feed", {
      item,
      quantity: num(at(row, header, "quantity")),
      unit: String(at(row, header, "unit") || ""),
      daily_use: num(at(row, header, "daily_use")),
      notes: String(at(row, header, "notes") || ""),
    }));
  }
  return out;
}

function listsFor(store, mem, kind) {
  const all = {
    milk: () => listMilk(store, mem),
    sale: () => listSales(store, mem).filter((row) => row.kind === "sale"),
    customer_adjust: () => listSales(store, mem).filter((row) => row.kind === "customer_adjust"),
    payment: () => listPayments(store, mem),
    fodder: () => listFodder(store, mem).filter((row) => row.kind === "fodder"),
    supplier_payment: () => listFodder(store, mem).filter((row) => row.kind === "supplier_payment"),
    supplier_adjust: () => listFodder(store, mem).filter((row) => row.kind === "supplier_adjust"),
    expense: () => listExpenses(store, mem),
    committee: () => listCommittees(store, mem),
    committee_log: () => listCommitteeLog(store, mem),
    animal: () => listAnimals(store, mem),
    feed: () => listFeed(store, mem),
    cow: () => listCows(store, mem),
    customer: () => listCustomers(store, mem),
    supplier: () => supplierGroups(store, mem),
  };
  if (kind && all[kind]) return all[kind]();
  const records = [];
  for (const key of Object.keys(all)) records.push(...all[key]());
  return records.slice(0, 80);
}

function namesOf(records, field) {
  const seen = new Set();
  const out = [];
  for (const row of records) {
    const name = String(row[field] || "").trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function shapeManual(store, mem, kind) {
  const customers = listCustomers(store, mem);
  const cows = listCows(store, mem);
  const suppliers = supplierGroups(store, mem);
  const committees = listCommittees(store, mem);
  return {
    ok: true,
    kind: kind || "",
    records: listsFor(store, mem, kind),
    customers: customers.map((row) => ({ name: row.name, rate_pkr: row.rate_pkr, balance: row.balance })),
    cows: cows.map((row) => row.name),
    suppliers: suppliers.map((row) => ({ name: row.name, balance_owed: row.balance_owed })),
    committees: namesOf(committees, "name"),
  };
}

function requireConfirm(body) {
  if (body && body.confirm === true) return null;
  return bad(CONFIRM);
}

function renameCustomer(store, from, to) {
  const next = String(to || "").trim();
  const prev = String(from || "").trim();
  if (!next || same(prev, next)) return;
  for (const tab of ["Sales", "Payments"]) {
    const rows = store[tab] || [];
    const header = rows[0] || [];
    const index = headerIndex(header, "customer");
    if (index < 0) continue;
    for (let i = 1; i < rows.length; i++) {
      if (same(rows[i][index], prev)) rows[i][index] = next;
    }
  }
}

function renameCow(store, from, to) {
  const next = String(to || "").trim();
  const prev = String(from || "").trim();
  if (!next || same(prev, next)) return;
  const milk = store.Milk_Log || [];
  const header = milk[0] || [];
  const index = headerIndex(header, "cow_name");
  const events = store.Animal_Events || [];
  const eventHeader = events[0] || [];
  const cowIdx = headerIndex(eventHeader, "cow");
  for (let i = 1; i < milk.length; i++) {
    if (index >= 0 && same(milk[i][index], prev)) milk[i][index] = next;
  }
  for (let i = 1; i < events.length; i++) {
    if (cowIdx >= 0 && same(events[i][cowIdx], prev)) events[i][cowIdx] = next;
  }
}

function renameSupplier(store, from, to) {
  const next = String(to || "").trim();
  const prev = String(from || "").trim();
  if (!next || same(prev, next)) return;
  const rows = store.Fodder || [];
  const header = rows[0] || [];
  const index = headerIndex(header, "supplier");
  for (let i = 1; i < rows.length; i++) {
    if (index >= 0 && same(rows[i][index], prev)) rows[i][index] = next;
  }
}

function blankRow(header) {
  return (header || []).map(() => "");
}

function upsertOpening(store, mem, supplier, amount, date, note) {
  const rows = store.Fodder;
  const header = rows[0];
  let idx = -1;
  for (let i = 1; i < rows.length; i++) {
    if (same(at(rows[i], header, "supplier"), supplier) && fodderKind(at(rows[i], header, "item")) === "supplier_opening") {
      idx = i;
    }
  }
  if (idx < 0) {
    const row = blankRow(header);
    setAt(row, header, "date", date);
    setAt(row, header, "item", "opening");
    setAt(row, header, "supplier", supplier);
    setAt(row, header, "balance_owed", amount);
    setAt(row, header, "cost_pkr", 0);
    setAt(row, header, "cash_paid", 0);
    setAt(row, header, "source_note", note || "shuruati baqi");
    rows.push(row);
    mem.wrote(store, "Fodder", rows.length, "create", null, note);
    return ensureOrigin(mem, row);
  }
  const before = snapshotRow(header, rows[idx]);
  setAt(rows[idx], header, "balance_owed", amount);
  if (date) setAt(rows[idx], header, "date", date);
  if (note) setAt(rows[idx], header, "source_note", note);
  mem.wrote(store, "Fodder", idx + 1, "update", before, note);
  return ensureOrigin(mem, rows[idx]);
}

function saleMoney(body, store, customer) {
  const litres = num(body.litres);
  let rate = num(body.rate_pkr);
  if (!(rate > 0)) rate = customerRate(store, customer);
  const amount = round2(litres * rate);
  const cash = body.cash === true || String(body.pay || "") === "nagd" ? amount : num(body.cash_received);
  return { litres, rate, amount, cash: round2(Math.min(Math.max(cash, 0), amount)), added: round2(amount - Math.min(Math.max(cash, 0), amount)) };
}

function saveMilk(store, mem, body, farmer) {
  const named = String(body.cow_name || "").trim();
  const cow = isTotalCow(named) ? "kul" : named;
  const session = String(body.session || "") === "day" ? "" : normalizeSession(body.session);
  const litres = num(body.litres);
  if (!isTotalCow(cow) && !session && String(body.session || "") !== "day") return bad("Subah ya shaam chunein.");
  if (!(litres > 0)) return bad("Litre likhein.");
  const date = dayOf(body.date);
  const note = noteFor(farmer);
  if (body.id) {
    const idx = findByOrigin(store.Milk_Log, body.id);
    if (idx < 1) return bad("Record nahi mila.");
    const header = store.Milk_Log[0];
    const before = snapshotRow(header, store.Milk_Log[idx]);
    setAt(store.Milk_Log[idx], header, "date", date);
    setAt(store.Milk_Log[idx], header, "session", session);
    setAt(store.Milk_Log[idx], header, "cow_name", cow);
    setAt(store.Milk_Log[idx], header, "litres", litres);
    mem.wrote(store, "Milk_Log", idx + 1, "update", before, note);
    return { ok: true, id: body.id };
  }
  const saved = mem.commitOne(store, { type: "milk", date, session, cow_name: cow, litres }, note);
  if (!saved || saved.ok === false) return bad(saved && saved.error ? saved.error : "Record nahi likha.");
  return { ok: true, id: ensureOrigin(mem, store.Milk_Log[saved.row - 1]) };
}

function saveSale(store, mem, body, farmer) {
  const customer = String(body.customer || "").trim();
  if (!customer) return bad("Grahak ka naam likhein.");
  const money = saleMoney(body, store, customer);
  if (!(money.litres > 0)) return bad("Litre likhein.");
  if (!(money.rate > 0)) {
    money.rate = "";
    money.amount = "";
    money.cash = 0;
    money.added = "";
  }
  const date = dayOf(body.date);
  const note = noteFor(farmer);
  if (body.id) {
    const idx = findByOrigin(store.Sales, body.id);
    if (idx < 1) return bad("Record nahi mila.");
    const header = store.Sales[0];
    const before = snapshotRow(header, store.Sales[idx]);
    const previous = String(before.customer || "");
    setAt(store.Sales[idx], header, "date", date);
    setAt(store.Sales[idx], header, "customer", customer);
    setAt(store.Sales[idx], header, "litres", money.litres);
    setAt(store.Sales[idx], header, "rate_pkr", money.rate);
    setAt(store.Sales[idx], header, "amount", money.amount);
    setAt(store.Sales[idx], header, "cash_received", money.cash);
    setAt(store.Sales[idx], header, "balance_added", money.added);
    mem.wrote(store, "Sales", idx + 1, "update", before, note);
    mem.upsertCustomer(store, customer, "", money.rate, "");
    recomputeCustomer(store, previous);
    recomputeCustomer(store, customer);
    return { ok: true, id: body.id };
  }
  const saved = mem.commitOne(store, {
    type: "sale",
    date,
    customer,
    litres: money.litres,
    rate_pkr: money.rate,
    amount: money.amount,
    cash_received: money.cash,
    balance_added: money.added,
  }, note);
  if (!saved || saved.ok === false) return bad("Record nahi likha.");
  return { ok: true, id: ensureOrigin(mem, store.Sales[saved.row - 1]) };
}

function saveAdjust(store, mem, body, farmer) {
  const customer = String(body.customer || "").trim();
  const amount = num(body.amount);
  if (!customer) return bad("Grahak ka naam likhein.");
  if (!(amount > 0)) return bad("Raqam likhein.");
  const debit = String(body.direction || "debit") !== "credit";
  const date = dayOf(body.date);
  const text = `${debit ? "jama" : "credit"}: ${String(body.note || "").trim()}`;
  const note = noteFor(farmer);
  const added = debit ? amount : -amount;
  if (body.id) {
    const idx = findByOrigin(store.Sales, body.id);
    if (idx < 1) return bad("Record nahi mila.");
    const header = store.Sales[0];
    const before = snapshotRow(header, store.Sales[idx]);
    const previous = String(before.customer || "");
    setAt(store.Sales[idx], header, "date", date);
    setAt(store.Sales[idx], header, "customer", customer);
    setAt(store.Sales[idx], header, "litres", 0);
    setAt(store.Sales[idx], header, "amount", 0);
    setAt(store.Sales[idx], header, "cash_received", 0);
    setAt(store.Sales[idx], header, "balance_added", added);
    setAt(store.Sales[idx], header, "source_note", text);
    mem.wrote(store, "Sales", idx + 1, "update", before, note);
    recomputeCustomer(store, previous);
    recomputeCustomer(store, customer);
    return { ok: true, id: body.id };
  }
  const saved = mem.commitOne(store, {
    type: "sale",
    date,
    customer,
    litres: 0,
    rate_pkr: "",
    amount: 0,
    cash_received: 0,
    balance_added: added,
    note: text,
  }, note);
  if (!saved || saved.ok === false) return bad("Record nahi likha.");
  return { ok: true, id: ensureOrigin(mem, store.Sales[saved.row - 1]) };
}

function savePayment(store, mem, body, farmer) {
  const customer = String(body.customer || "").trim();
  const amount = num(body.amount);
  if (!customer) return bad("Grahak ka naam likhein.");
  if (!(amount > 0)) return bad("Raqam likhein.");
  const date = dayOf(body.date);
  const method = String(body.method || "wasool");
  const note = noteFor(farmer);
  if (body.id) {
    const idx = findByOrigin(store.Payments, body.id);
    if (idx < 1) return bad("Record nahi mila.");
    const header = store.Payments[0];
    const before = snapshotRow(header, store.Payments[idx]);
    const previous = String(before.customer || "");
    setAt(store.Payments[idx], header, "date", date);
    setAt(store.Payments[idx], header, "customer", customer);
    setAt(store.Payments[idx], header, "amount", amount);
    setAt(store.Payments[idx], header, "method", method);
    mem.wrote(store, "Payments", idx + 1, "update", before, note);
    mem.upsertCustomer(store, customer, "", "", "");
    recomputeCustomer(store, previous);
    recomputeCustomer(store, customer);
    return { ok: true, id: body.id };
  }
  const found = (store.Customers || []).slice(1).some((row) => same(at(row, store.Customers[0], "name"), customer));
  if (!found) return bad("Grahak nahi mila.");
  const saved = mem.commitOne(store, { type: "payment", date, customer, amount, method }, note);
  if (!saved || saved.ok === false) return bad("Record nahi likha.");
  return { ok: true, id: ensureOrigin(mem, store.Payments[saved.row - 1]) };
}

function saveExpense(store, mem, body, farmer) {
  const category = String(body.category || "").trim();
  const amount = num(body.amount);
  if (!category) return bad("Kharcha ka naam likhein.");
  if (!(amount > 0)) return bad("Raqam likhein.");
  const date = dayOf(body.date);
  const text = body.note == null ? "" : String(body.note);
  const note = noteFor(farmer);
  if (body.id) {
    const idx = findByOrigin(store.Expenses, body.id);
    if (idx < 1) return bad("Record nahi mila.");
    const header = store.Expenses[0];
    const before = snapshotRow(header, store.Expenses[idx]);
    setAt(store.Expenses[idx], header, "date", date);
    setAt(store.Expenses[idx], header, "category", category);
    setAt(store.Expenses[idx], header, "amount", amount);
    setAt(store.Expenses[idx], header, "note", text || note);
    mem.wrote(store, "Expenses", idx + 1, "update", before, note);
    return { ok: true, id: body.id };
  }
  const saved = mem.commitOne(store, { type: "expense", date, category, amount, note: text || note }, note);
  if (!saved || !saved.ok || saved.skipped) return bad("Raqam likhein.");
  return { ok: true, id: ensureOrigin(mem, store.Expenses[saved.row - 1]) };
}

function saveFodder(store, mem, body, farmer, mode) {
  const supplier = String(body.supplier || "").trim();
  const date = dayOf(body.date);
  const note = noteFor(farmer);
  let item = String(body.item || "").trim();
  let quantity = body.quantity == null || body.quantity === "" ? "" : num(body.quantity);
  let unit = String(body.unit || "");
  let cost = num(body.cost_pkr);
  let cash = num(body.cash_paid);
  let owed = body.balance_owed == null || body.balance_owed === "" ? null : num(body.balance_owed);
  if (mode === "supplier_payment") {
    const amount = num(body.amount || body.cash_paid);
    if (!supplier) return bad("Supplier ka naam likhein.");
    if (!(amount > 0)) return bad("Raqam likhein.");
    item = "adaigi";
    quantity = "";
    cost = 0;
    cash = amount;
    owed = -amount;
  } else if (mode === "supplier_adjust") {
    const amount = num(body.amount || body.balance_owed);
    if (!supplier) return bad("Supplier ka naam likhein.");
    if (!(amount > 0)) return bad("Raqam likhein.");
    item = "jama";
    quantity = "";
    cost = 0;
    cash = 0;
    owed = amount;
  } else {
    if (!item) return bad("Charra ka naam likhein.");
    if (!(cost > 0) && owed == null) return bad("Raqam likhein.");
    if (owed == null) owed = round2(cost - cash);
  }
  const text = String(body.note || note);
  if (body.id && !String(body.id).startsWith("supplier:")) {
    const idx = findByOrigin(store.Fodder, body.id);
    if (idx < 1) return bad("Record nahi mila.");
    const header = store.Fodder[0];
    const before = snapshotRow(header, store.Fodder[idx]);
    setAt(store.Fodder[idx], header, "date", date);
    setAt(store.Fodder[idx], header, "item", item);
    setAt(store.Fodder[idx], header, "quantity", quantity);
    setAt(store.Fodder[idx], header, "unit", unit);
    setAt(store.Fodder[idx], header, "cost_pkr", cost);
    setAt(store.Fodder[idx], header, "supplier", supplier);
    setAt(store.Fodder[idx], header, "cash_paid", cash);
    setAt(store.Fodder[idx], header, "balance_owed", owed);
    setAt(store.Fodder[idx], header, "source_note", text);
    const after = snapshotRow(header, store.Fodder[idx]);
    mem.wrote(store, "Fodder", idx + 1, "update", before, note);
    syncFodderStock(store, mem, before, after, note);
    return { ok: true, id: body.id };
  }
  const saved = mem.commitOne(store, {
    type: "fodder",
    date,
    item,
    quantity,
    unit,
    cost_pkr: cost,
    supplier,
    cash_paid: cash,
    balance_owed: owed,
    note: text,
  }, note);
  if (!saved || saved.ok === false) return bad("Record nahi likha.");
  return { ok: true, id: ensureOrigin(mem, store.Fodder[saved.row - 1]) };
}

function saveCommittee(store, mem, body, farmer) {
  const name = String(body.name || body.committee || "").trim();
  if (!name) return bad("Committee ka naam likhein.");
  const note = noteFor(farmer);
  if (body.kind === "committee_log" || body.status) {
    const status = /miss|nahi|not/.test(String(body.status || "").toLowerCase()) ? "not_paid" : "paid";
    const amount = status === "not_paid" ? "" : num(body.amount);
    if (status === "paid" && !(num(amount) > 0)) return bad("Raqam likhein.");
    const date = dayOf(body.date);
    if (body.id) {
      const idx = findByOrigin(store.Committee_Log, body.id);
      if (idx < 1) return bad("Record nahi mila.");
      const header = store.Committee_Log[0];
      const before = snapshotRow(header, store.Committee_Log[idx]);
      setAt(store.Committee_Log[idx], header, "date", date);
      setAt(store.Committee_Log[idx], header, "committee", name);
      setAt(store.Committee_Log[idx], header, "status", status);
      setAt(store.Committee_Log[idx], header, "amount", amount);
      setAt(store.Committee_Log[idx], header, "note", body.note || "");
      mem.wrote(store, "Committee_Log", idx + 1, "update", before, note);
      return { ok: true, id: body.id };
    }
    const saved = mem.commitOne(store, {
      type: "committee_log",
      date,
      committee: name,
      status,
      amount,
      note: body.note || "",
    }, note);
    if (!saved || !saved.ok || saved.skipped) return bad("Raqam likhein.");
    return { ok: true, id: ensureOrigin(mem, store.Committee_Log[saved.row - 1]) };
  }
  const saved = mem.commitOne(store, {
    type: "setup_committee",
    name,
    amount: num(body.amount),
    frequency: body.frequency || "daily",
    start_date: parseSheetDate(body.start_date) || dayOf(body.date),
    organizer: body.organizer || "",
    status: body.committee_status || "active",
    note: body.note || "",
  }, note);
  if (!saved || saved.ok === false) return bad("Record nahi likha.");
  return { ok: true, id: ensureOrigin(mem, store.Committees[saved.row - 1]) };
}

function saveAnimal(store, mem, body, farmer) {
  const cow = String(body.cow || body.cow_name || "").trim();
  const eventType = String(body.event_type || "health").trim();
  if (!cow) return bad("Janwar ka naam likhein.");
  if (!eventType) return bad("Wajah likhein.");
  const date = dayOf(body.date);
  const note = noteFor(farmer);
  if (body.id) {
    const idx = findByOrigin(store.Animal_Events, body.id);
    if (idx < 1) return bad("Record nahi mila.");
    const header = store.Animal_Events[0];
    const before = snapshotRow(header, store.Animal_Events[idx]);
    setAt(store.Animal_Events[idx], header, "date", date);
    setAt(store.Animal_Events[idx], header, "cow", cow);
    setAt(store.Animal_Events[idx], header, "event_type", eventType);
    setAt(store.Animal_Events[idx], header, "details", body.details || "");
    setAt(store.Animal_Events[idx], header, "doctor_name", body.doctor_name || "");
    setAt(store.Animal_Events[idx], header, "diagnosis", body.diagnosis || "");
    setAt(store.Animal_Events[idx], header, "medicines", body.medicines || "");
    setAt(store.Animal_Events[idx], header, "cost_pkr", body.cost_pkr == null || body.cost_pkr === "" ? "" : num(body.cost_pkr));
    setAt(store.Animal_Events[idx], header, "next_due_date", parseSheetDate(body.next_due_date) || "");
    mem.wrote(store, "Animal_Events", idx + 1, "update", before, note);
    return { ok: true, id: body.id };
  }
  const saved = mem.commitOne(store, {
    type: "animal_event",
    date,
    cow_name: cow,
    event_type: eventType,
    details: body.details || "",
    doctor_name: body.doctor_name || "",
    diagnosis: body.diagnosis || "",
    medicines: body.medicines || "",
    cost_pkr: body.cost_pkr,
    next_due_date: parseSheetDate(body.next_due_date) || "",
  }, note);
  if (!saved || saved.ok === false) return bad("Record nahi likha.");
  return { ok: true, id: ensureOrigin(mem, store.Animal_Events[saved.row - 1]) };
}

function saveFeed(store, mem, body, farmer) {
  const item = String(body.item || "").trim();
  if (!item) return bad("Feed ka naam likhein.");
  const note = noteFor(farmer);
  const rows = store.Feed_Stock;
  const header = rows[0];
  let idx = body.id ? findByOrigin(rows, body.id) : -1;
  if (idx < 0) {
    for (let i = 1; i < rows.length; i++) {
      if (same(at(rows[i], header, "item"), item)) idx = i;
    }
  }
  if (idx < 1) {
    const row = blankRow(header);
    setAt(row, header, "item", item);
    setAt(row, header, "quantity", num(body.quantity));
    setAt(row, header, "unit", body.unit || "kg");
    setAt(row, header, "daily_use", body.daily_use == null || body.daily_use === "" ? "" : num(body.daily_use));
    setAt(row, header, "notes", body.note || note);
    setAt(row, header, "updated_at", dayOf(body.date));
    rows.push(row);
    mem.wrote(store, "Feed_Stock", rows.length, "create", null, note);
    return { ok: true, id: ensureOrigin(mem, row) };
  }
  const before = snapshotRow(header, rows[idx]);
  setAt(rows[idx], header, "item", item);
  if (body.quantity != null && body.quantity !== "") setAt(rows[idx], header, "quantity", num(body.quantity));
  if (body.unit) setAt(rows[idx], header, "unit", body.unit);
  if (body.daily_use != null && body.daily_use !== "") setAt(rows[idx], header, "daily_use", num(body.daily_use));
  if (body.note != null) setAt(rows[idx], header, "notes", body.note);
  setAt(rows[idx], header, "updated_at", dayOf(body.date));
  mem.wrote(store, "Feed_Stock", idx + 1, "update", before, note);
  return { ok: true, id: ensureOrigin(mem, rows[idx]) };
}

function saveCow(store, mem, body, farmer) {
  const name = String(body.name || body.cow_name || "").trim();
  if (!name) return bad("Gay ka naam likhein.");
  const note = noteFor(farmer);
  if (body.id) {
    const idx = findByOrigin(store.Cows, body.id);
    if (idx < 1) return bad("Record nahi mila.");
    const header = store.Cows[0];
    const before = snapshotRow(header, store.Cows[idx]);
    const previous = String(before.name || "");
    setAt(store.Cows[idx], header, "name", name);
    if (body.animal_type) setAt(store.Cows[idx], header, "type", body.animal_type);
    if (body.breed != null) setAt(store.Cows[idx], header, "breed", body.breed);
    if (body.status) setAt(store.Cows[idx], header, "status", body.status);
    if (body.avg_daily_litres != null && body.avg_daily_litres !== "") {
      setAt(store.Cows[idx], header, "avg_daily_litres", num(body.avg_daily_litres));
    }
    if (body.notes != null) setAt(store.Cows[idx], header, "notes", body.notes);
    renameCow(store, previous, name);
    mem.wrote(store, "Cows", idx + 1, "update", before, note);
    return { ok: true, id: body.id };
  }
  const saved = mem.commitOne(store, {
    type: "add_cow",
    cow_name: name,
    animal_type: body.animal_type || "cow",
    breed: body.breed || "",
    status: body.status || "milking",
    avg_daily_litres: body.avg_daily_litres,
    notes: body.notes || "",
  }, note);
  if (!saved || saved.ok === false) return bad(saved && saved.error ? saved.error : "Record nahi likha.");
  if (saved.already) return bad("Yeh gay pehle se hai.");
  return { ok: true, id: ensureOrigin(mem, store.Cows[saved.row - 1]) };
}

function saveCustomer(store, mem, body, farmer) {
  const name = String(body.name || body.customer || "").trim();
  if (!name) return bad("Grahak ka naam likhein.");
  const note = noteFor(farmer);
  const supply = body.supply_type ? String(body.supply_type).toLowerCase() : "";
  if (body.id) {
    const idx = findByOrigin(store.Customers, body.id);
    if (idx < 1) return bad("Record nahi mila.");
    const header = store.Customers[0];
    const before = snapshotRow(header, store.Customers[idx]);
    const previous = String(before.name || "");
    setAt(store.Customers[idx], header, "name", name);
    if (body.phone != null) setAt(store.Customers[idx], header, "phone", body.phone);
    if (body.rate_pkr != null && body.rate_pkr !== "") setAt(store.Customers[idx], header, "rate_pkr", num(body.rate_pkr));
    if (body.opening_balance != null && body.opening_balance !== "") {
      setAt(store.Customers[idx], header, "opening_balance", num(body.opening_balance));
    }
    if (body.notes != null) setAt(store.Customers[idx], header, "notes", body.notes);
    if (body.billing_cycle) setAt(store.Customers[idx], header, "billing_cycle", normalizeCycle(body.billing_cycle));
    if (supply === "fixed" || supply === "flexible") {
      mem.applySupplyCells(store.Customers[idx], header, {
        supply_type: supply,
        daily_litres: supply === "fixed" ? body.daily_litres : "",
      });
    }
    renameCustomer(store, previous, name);
    mem.wrote(store, "Customers", idx + 1, "update", before, note);
    recomputeCustomer(store, name);
    return { ok: true, id: body.id };
  }
  const saved = mem.commitOne(store, {
    type: "add_customer",
    customer: name,
    phone: body.phone || "",
    rate_pkr: body.rate_pkr,
    opening_balance: body.opening_balance == null || body.opening_balance === "" ? 0 : num(body.opening_balance),
    billing_cycle: body.billing_cycle || "daily",
    supply_type: supply === "fixed" || supply === "flexible" ? supply : "",
    daily_litres: supply === "fixed" ? body.daily_litres : "",
    note,
  }, note);
  if (!saved || saved.ok === false) return bad("Record nahi likha.");
  recomputeCustomer(store, name);
  return { ok: true, id: ensureOrigin(mem, store.Customers[saved.row - 1]) };
}

function saveSupplier(store, mem, body, farmer) {
  const name = String(body.name || body.supplier || "").trim();
  if (!name) return bad("Supplier ka naam likhein.");
  const note = noteFor(farmer);
  const previous = String(body.previous_name || "").trim();
  if (previous) renameSupplier(store, previous, name);
  if (body.id && String(body.id).startsWith("supplier:")) {
    const oldName = String(body.id).slice("supplier:".length);
    renameSupplier(store, oldName, name);
  }
  const opening = body.opening_balance == null || body.opening_balance === "" ? null : num(body.opening_balance);
  if (opening != null) {
    const id = upsertOpening(store, mem, name, opening, dayOf(body.date), body.note || note);
    return { ok: true, id };
  }
  const existing = supplierGroups(store, mem).find((row) => same(row.name, name));
  if (existing) return { ok: true, id: existing.id };
  const id = upsertOpening(store, mem, name, 0, dayOf(body.date), body.note || "shuruati baqi");
  return { ok: true, id };
}

function saveRecord(store, mem, body, farmer) {
  const kind = String(body.kind || "");
  if (kind === "milk") return saveMilk(store, mem, body, farmer);
  if (kind === "sale") return saveSale(store, mem, body, farmer);
  if (kind === "customer_adjust") return saveAdjust(store, mem, body, farmer);
  if (kind === "payment") return savePayment(store, mem, body, farmer);
  if (kind === "expense") return saveExpense(store, mem, body, farmer);
  if (kind === "fodder" || kind === "supplier_payment" || kind === "supplier_adjust") {
    return saveFodder(store, mem, body, farmer, kind);
  }
  if (kind === "committee" || kind === "committee_log") return saveCommittee(store, mem, body, farmer);
  if (kind === "animal") return saveAnimal(store, mem, body, farmer);
  if (kind === "feed") return saveFeed(store, mem, body, farmer);
  if (kind === "cow") return saveCow(store, mem, body, farmer);
  if (kind === "customer") return saveCustomer(store, mem, body, farmer);
  if (kind === "supplier") return saveSupplier(store, mem, body, farmer);
  return bad("Yeh kaam theek nahi.");
}

function dropRow(store, mem, sheet, idx, note) {
  const rows = store[sheet];
  const before = snapshotRow(rows[0], rows[idx]);
  const id = ensureOrigin(mem, rows[idx]);
  rows.splice(idx, 1);
  mem.removed(store, sheet, id, before, note);
  return before;
}

function deleteRecord(store, mem, body, farmer) {
  const blocked = requireConfirm(body);
  if (blocked) return blocked;
  const kind = String(body.kind || "");
  const note = noteFor(farmer);
  if (kind === "supplier") {
    const name = String(body.name || body.supplier || "").trim();
    if (!name) return bad("Supplier ka naam likhein.");
    const rows = store.Fodder;
    const header = rows[0];
    for (let i = rows.length - 1; i >= 1; i--) {
      if (!same(at(rows[i], header, "supplier"), name)) continue;
      const dropped = dropRow(store, mem, "Fodder", i, note);
      syncFodderStock(store, mem, dropped, null, note);
    }
    return { ok: true };
  }
  const sheet = KIND_SHEET[kind];
  if (!sheet || !body.id) return bad("Record nahi mila.");
  const idx = findByOrigin(store[sheet], body.id);
  if (idx < 1) return bad("Record nahi mila.");
  const before = dropRow(store, mem, sheet, idx, note);
  if (sheet === "Fodder") syncFodderStock(store, mem, before, null, note);
  if (sheet === "Sales" || sheet === "Payments") recomputeCustomer(store, before.customer);
  if (sheet === "Customers") recomputeCustomer(store, before.name);
  return { ok: true };
}

function customerLedger(store, mem, name) {
  const wanted = String(name || "").trim();
  if (!wanted) return bad("Grahak ka naam likhein.");
  const customers = listCustomers(store, mem);
  const customer = customers.find((row) => same(row.name, wanted));
  if (!customer) return bad("Grahak nahi mila.");
  const lines = [];
  let running = 0;
  const opening = num(customer.opening_balance);
  running = opening;
  lines.push({
    id: customer.id,
    kind: "opening",
    date: "",
    label: "Shuruati baqi",
    debit: opening > 0 ? opening : 0,
    credit: opening < 0 ? round2(-opening) : 0,
    balance: round2(running),
    note: "",
  });
  const events = [];
  for (const sale of listSales(store, mem)) {
    if (!same(sale.customer, wanted)) continue;
    if (sale.kind === "customer_adjust") {
      const debit = sale.balance_added > 0 ? sale.balance_added : 0;
      const credit = sale.balance_added < 0 ? round2(-sale.balance_added) : 0;
      events.push({ id: sale.id, kind: sale.kind, date: sale.date, label: debit ? "Jama" : "Credit", debit, credit, note: sale.note, sort: sale.date });
      continue;
    }
    const debit = sale.amount > 0 ? sale.amount : (sale.balance_added > 0 ? sale.balance_added : 0);
    if (debit > 0) {
      events.push({
        id: sale.id,
        kind: "sale",
        date: sale.date,
        label: sale.litres ? `Bech ${sale.litres} L` : "Bech",
        debit,
        credit: 0,
        note: "",
        sort: sale.date,
      });
    }
    if (sale.cash_received > 0) {
      events.push({ id: sale.id, kind: "sale", date: sale.date, label: "Nagd", debit: 0, credit: sale.cash_received, note: "", sort: sale.date });
    }
  }
  for (const pay of listPayments(store, mem)) {
    if (!same(pay.customer, wanted)) continue;
    const debit = isDebitMethod(pay.method);
    events.push({
      id: pay.id,
      kind: "payment",
      date: pay.date,
      label: debit ? "Jama" : (String(pay.method) === "credit" ? "Credit" : "Wasool"),
      debit: debit ? pay.amount : 0,
      credit: debit ? 0 : pay.amount,
      note: "",
      sort: pay.date,
    });
  }
  events.sort((a, b) => String(a.sort).localeCompare(String(b.sort)));
  for (const event of events) {
    running = round2(running + num(event.debit) - num(event.credit));
    lines.push({ ...event, balance: running });
  }
  recomputeCustomer(store, wanted);
  return { ok: true, kind: "customer", name: customer.name, balance: round2(running), lines };
}

function supplierLedger(store, mem, name) {
  const wanted = String(name || "").trim();
  if (!wanted) return bad("Supplier ka naam likhein.");
  const rows = store.Fodder || [];
  const header = rows[0] || [];
  const events = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!same(at(row, header, "supplier"), wanted)) continue;
    const owed = num(at(row, header, "balance_owed"));
    const item = String(at(row, header, "item") || "");
    const kind = fodderKind(item);
    let label = item || "Khareed";
    if (kind === "supplier_opening") label = "Shuruati baqi";
    else if (kind === "supplier_payment") label = "Adaigi";
    else if (kind === "supplier_adjust") label = "Jama";
    else if (num(at(row, header, "quantity"))) label = `${item} ${at(row, header, "quantity")} ${at(row, header, "unit") || ""}`.trim();
    events.push({
      id: ensureOrigin(mem, row),
      kind: kind === "supplier_opening" ? "supplier" : kind,
      date: parseSheetDate(at(row, header, "date")) || "",
      label,
      debit: owed > 0 ? owed : 0,
      credit: owed < 0 ? round2(-owed) : 0,
      note: String(at(row, header, "source_note") || ""),
    });
  }
  if (!events.length) return bad("Supplier nahi mila.");
  events.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  let running = 0;
  const lines = events.map((event) => {
    running = round2(running + event.debit - event.credit);
    const signed = round2(-running);
    return { ...event, balance: running, signed_balance: signed };
  });
  return {
    ok: true,
    kind: "supplier",
    name: wanted,
    balance: running,
    signed_balance: round2(-running),
    lines,
  };
}

function publicEvent(event) {
  return {
    id: event.record_id,
    table: event.table_name,
    record_id: event.record_id,
    action: event.action,
    source: event.source,
    at: event.created_at,
    old_values: event.old_values || null,
    new_values: event.new_values || null,
    recoverable: event.action === "delete",
  };
}

function historyView(mem, farmer, query) {
  const events = listHistory(mem, {
    phone: farmer.phone,
    sheetKey: farmer.sheetId || "",
    table: query && query.table,
    recordId: query && (query.record || query.record_id),
    account: query && (query.account || query.name),
    limit: query && query.limit,
  });
  return {
    ok: true,
    events: events.map((event) => {
      const view = publicEvent(event);
      view.recoverable = latestForRecord(mem, event.record_id) === event && event.action === "delete";
      return view;
    }),
  };
}

function restoreRecord(store, mem, body, farmer) {
  const blocked = requireConfirm(body);
  if (blocked) return blocked;
  const recordId = String(body.record_id || body.id || "");
  if (!recordId) return bad("Record nahi mila.");
  const latest = latestForRecord(mem, recordId);
  if (!latest || latest.action !== "delete" || !latest.old_values) return bad("Yeh record wapas nahi aa sakta.");
  const sheet = TABLE_SHEET[latest.table_name];
  if (!sheet || !store[sheet]) return bad("Yeh record wapas nahi aa sakta.");
  if (findByOrigin(store[sheet], recordId) >= 1) return bad("Yeh record pehle se maujood hai.");
  const header = store[sheet][0];
  const row = header.map((name) => {
    const value = latest.old_values[name];
    return value == null ? "" : value;
  });
  store[sheet].push(row);
  ensureOrigin(mem, row);
  if (row.originId !== recordId) {
    Object.defineProperty(row, "originId", { value: recordId, writable: true, configurable: true, enumerable: false });
  }
  const { originMapOf } = require("./ledger-snapshot");
  originMapOf(mem).set(row, recordId);
  mem.wrote(store, sheet, store[sheet].length, "create", null, noteFor(farmer));
  if (sheet === "Fodder") syncFodderStock(store, mem, null, latest.old_values, noteFor(farmer));
  if (sheet === "Sales" || sheet === "Payments" || sheet === "Customers") {
    recomputeCustomer(store, latest.old_values.customer || latest.old_values.name);
  }
  return { ok: true, id: recordId };
}

function mutateManual(store, mem, body, farmer) {
  const op = String((body && body.op) || "save");
  if (op === "delete") return deleteRecord(store, mem, body || {}, farmer);
  if (op === "restore") return restoreRecord(store, mem, body || {}, farmer);
  return saveRecord(store, mem, body || {}, farmer);
}

module.exports = {
  CONFIRM,
  shapeManual,
  mutateManual,
  customerLedger,
  supplierLedger,
  historyView,
  stampAll,
  listCustomers,
  supplierGroups,
};
