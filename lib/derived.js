const { todayISO, TIMEZONE } = require("./config");
const { dueBills } = require("./billing");
const { deriveCow, upcomingEvents, rowToEvent } = require("./animals");
const { TAB_HEADERS, EXTRA_COLUMNS, ensureHeaderRow, headerIndex } = require("./schema");
const { applyComputedStock } = require("./feed");

function tab(store, name) {
  if (!store[name]) store[name] = (TAB_HEADERS[name] || []).slice();
  if (store[name].length && !Array.isArray(store[name][0])) {
    // already values
  }
  if (!store[name].length) store[name] = [(TAB_HEADERS[name] || []).slice()];
  return store[name];
}

function migrateStore(store) {
  if (!store) return store;
  for (const [name, headers] of Object.entries(TAB_HEADERS)) {
    if (!store[name] || !store[name].length) store[name] = [headers.slice()];
    else ensureHeaderRow(store[name], headers);
  }
  if (store.Customers) ensureHeaderRow(store.Customers, ["name", "phone", "rate_pkr", "opening_balance", "current_balance", "notes", ...EXTRA_COLUMNS.Customers]);
  if (store.Cows) ensureHeaderRow(store.Cows, ["name", "type", "breed", "date_added", "status", "notes", "avg_daily_litres", ...EXTRA_COLUMNS.Cows]);
  return store;
}

function refreshDerivedStore(store, refDate) {
  migrateStore(store);
  const today = (refDate || todayISO(TIMEZONE)).slice(0, 10);
  const cows = store.Cows;
  const events = store.Animal_Events || [[...TAB_HEADERS.Animal_Events]];
  const headerC = cows[0];
  const evRows = events.slice(1);
  const nameIdx = headerIndex(headerC, "name");
  const typeIdx = headerIndex(headerC, "type");
  for (let i = 1; i < cows.length; i++) {
    const cow = {
      name: cows[i][nameIdx],
      type: cows[i][typeIdx] || "cow",
    };
    const d = deriveCow(cow.name, cow.type, evRows.map((e) => rowToEvent(e, events[0])));
    const set = (col, val) => {
      const idx = headerIndex(headerC, col);
      if (idx !== -1) cows[i][idx] = val || "";
    };
    set("last_insemination", d.last_insemination);
    set("pregnancy_status", d.pregnancy_status);
    set("expected_calving", d.expected_calving);
    set("dry_off_due", d.dry_off_due);
    set("pregnancy_check_due", d.pregnancy_check_due);
  }

  const bills = dueBills(store.Customers, store.Sales, store.Payments, today);
  store.Due_Bills = [TAB_HEADERS.Due_Bills.slice()];
  for (const b of bills) {
    store.Due_Bills.push([
      b.customer,
      b.periodStart,
      b.periodEnd,
      b.dueDate,
      b.litres,
      b.amount,
      b.paid,
      b.balanceDue,
      b.status,
    ]);
  }

  applyComputedStock(store.Feed_Stock, today, store.Fodder);
  const upcoming = upcomingEvents(cows, evRows, today, 30);
  store.Upcoming_Events = [TAB_HEADERS.Upcoming_Events.slice()];
  for (const e of upcoming) {
    store.Upcoming_Events.push([e.date, e.cow, e.event, e.details || ""]);
  }
  return store;
}

module.exports = { migrateStore, refreshDerivedStore };
