const assert = require("assert");
const { MemorySheets, formatLedgerData, emptyLedger } = require("../lib/sheets");
const { periodFor, dueBills, dueSoonBills, statementFor, normalizeCycle, calendarMonthPeriod, addDaysISO } = require("../lib/billing");
const { deriveCow, upcomingEvents, normalizeEventType, attachHealthExpenses } = require("../lib/animals");
const { applyStockDelta, stockStatus, lowStock, formatStockLine } = require("../lib/feed");
const { reminderFooter } = require("../lib/reminders");
const { directQueryReply } = require("../lib/queries");
const { confirmationText, savedText, CONFIRM_FOOTER, entryLines } = require("../lib/ledger");
const { ASK_CUSTOMERS, customerOnboardLines, needsOnboarding, howToMessage } = require("../lib/onboarding");
const { migrateStore, refreshDerivedStore } = require("../lib/derived");

function fail(msg) {
  throw new Error(msg);
}

async function main() {
  assert.strictEqual(normalizeCycle("hafte baad"), "weekly");
  assert.strictEqual(normalizeCycle("15 din baad"), "biweekly");
  assert.strictEqual(normalizeCycle("mahine baad"), "monthly");
  const daily = periodFor("daily", "2026-01-01", "2026-11-11");
  assert.deepStrictEqual(daily, { periodStart: "2026-11-11", periodEnd: "2026-11-11", dueDate: "2026-11-11" });
  const week = periodFor("weekly", "2026-11-03", "2026-11-11");
  assert.strictEqual(week.periodStart, "2026-11-10");
  assert.strictEqual(week.periodEnd, "2026-11-16");
  const month = periodFor("monthly", "2026-10-01", "2026-11-11");
  assert.strictEqual(month.periodStart, "2026-11-01");
  const cal = calendarMonthPeriod("2026-11-11");
  assert.strictEqual(cal.periodStart, "2026-11-01");
  assert.strictEqual(cal.periodEnd, "2026-11-11");

  const customers = [
    ["name", "phone", "rate_pkr", "opening_balance", "current_balance", "notes", "billing_cycle", "cycle_start_date"],
    ["Aslam", "", 190, 0, 0, "", "daily", "2026-11-01"],
    ["Bashir", "", 180, 0, 0, "", "weekly", "2026-11-03"],
  ];
  const sales = [
    ["date", "customer", "litres", "rate_pkr", "amount", "cash_received", "balance_added", "source_note"],
    ["2026-11-11", "Aslam", 10, 190, 1900, 0, 1900, ""],
    ["2026-11-10", "Bashir", 5, 180, 900, 0, 900, ""],
    ["2026-11-11", "Bashir", 5, 180, 900, 0, 900, ""],
  ];
  const payments = [["date", "customer", "amount", "method"]];
  const due = dueBills(customers, sales, payments, "2026-11-11");
  assert.ok(due.some((b) => b.customer === "Aslam" && b.balanceDue === 1900), "Aslam daily bill should be due today");
  const soon = dueSoonBills(customers, sales, payments, "2026-11-11", 2);
  assert.ok(soon.some((b) => b.customer === "Aslam"));

  assert.strictEqual(normalizeEventType("Doctor sahab kal Kali ko dekhne aayenge"), "vet_appointment");
  assert.strictEqual(normalizeEventType("Doctor ne Gori ko bukhar bataya"), "vet_visit");
  assert.strictEqual(normalizeEventType("Gori ko aaj teeka laga"), "vaccination");
  const derived = deriveCow("Gori", "cow", [
    { date: "2026-09-01", cow: "Gori", event_type: "insemination" },
    { date: "2026-11-01", cow: "Gori", event_type: "pregnancy_check", details: "gaban hai" },
  ]);
  assert.strictEqual(derived.pregnancy_status, "pregnant");
  assert.strictEqual(derived.expected_calving, addDaysISO("2026-09-01", 283));
  assert.strictEqual(derived.dry_off_due, addDaysISO(derived.expected_calving, -60));

  const cowsSheet = [
    ["cow_id", "name", "type", "breed", "status", "avg_daily_litres", "notes"],
    ["C-1", "Gori", "cow", "", "milking", 18, ""],
    ["C-2", "Kali", "cow", "", "milking", 16, ""],
  ];
  const events = [
    ["date", "cow", "event_type", "details", "doctor_name", "diagnosis", "medicines", "cost_pkr", "next_due_date", "source_note"],
    ["2026-09-01", "Gori", "insemination", "", "", "", "", "", "", ""],
    ["2026-11-01", "Gori", "pregnancy_check", "gaban hai", "", "", "", "", "", ""],
    ["2026-11-12", "Kali", "vet_appointment", "check", "Doctor Sahab", "", "", "", "", ""],
  ];
  const upcoming = upcomingEvents(cowsSheet, events, "2026-11-11", 30);
  assert.ok(upcoming.some((e) => e.event === "vet_appointment" && e.cow === "Kali"), "vet appointment should appear");
  const near = upcomingEvents(
    [["name", "type"], ["Moti", "cow"]],
    [
      ["date", "cow", "event_type", "details", "doctor_name", "diagnosis", "medicines", "cost_pkr", "next_due_date", "source_note"],
      ["2026-10-01", "Moti", "insemination", "", "", "", "", "", "", ""],
    ],
    "2026-11-11",
    30
  );
  assert.ok(near.some((e) => e.cow === "Moti" && e.event === "pregnancy_check"), "pregnancy check due should appear within 30 days");

  const stock = [["item", "quantity", "unit", "daily_use", "updated_at", "notes"]];
  applyStockDelta(stock, { item: "wanda", quantity: 6, unit: "mann", daily_use: 2, today: "2026-11-11" });
  const status = stockStatus(stock, "2026-11-11", 3);
  assert.strictEqual(status[0].daysLeft, 3);
  assert.strictEqual(status[0].status, "low");
  assert.ok(lowStock(stock, "2026-11-11", 3).length === 1);
  assert.ok(formatStockLine(lowStock(stock, "2026-11-11", 3)).includes("wanda"));

  const attached = attachHealthExpenses([
    { type: "animal_event", date: "2026-11-11", cow_name: "Gori", event_type: "treatment", cost_pkr: 1500 },
  ]);
  assert.ok(attached.some((e) => e.type === "expense" && e.amount === 1500 && e.category === "animal_health"));

  const oldStore = {
    Cows: [["cow_id", "name", "type", "breed", "status", "avg_daily_litres", "notes"], ["C-1", "Gori", "cow", "", "milking", 18, ""]],
    Customers: [["name", "phone", "rate_pkr", "opening_balance", "current_balance", "notes"], ["Aslam", "", 190, 0, 0, ""]],
    Sales: [["date", "customer", "litres", "rate_pkr", "amount", "cash_received", "balance_added", "source_note"]],
    Payments: [["date", "customer", "amount", "method"]],
    Milk_Log: [["date", "session", "cow_name", "litres", "source_note"]],
    Expenses: [["date", "category", "amount", "note"]],
    Fodder: [["date", "item", "quantity", "unit", "cost_pkr", "supplier", "cash_paid", "balance_owed", "source_note"]],
    Pending: [["sender", "created_at", "language", "entries_json", "status", "message_id"]],
    Processed_Ids: [["message_id", "received_at", "sender"]],
    Last_Write: [["sheet", "row", "type", "summary", "written_at"]],
  };
  migrateStore(oldStore);
  assert.ok(oldStore.Animal_Events[0].includes("doctor_name"));
  assert.ok(oldStore.Feed_Stock[0].includes("daily_use"));
  assert.ok(oldStore.Customers[0].includes("billing_cycle"));
  assert.ok(oldStore.Cows[0].includes("expected_calving"));
  refreshDerivedStore(oldStore, "2026-11-11");
  assert.ok(oldStore.Due_Bills);
  assert.ok(oldStore.Upcoming_Events);

  const sheets = new MemorySheets();
  const phone = "923155506704";
  await sheets.upsertFarmer({ phone, name: "Rizwan", farmName: "Dairy Farm", allowed: true, onboardingState: "complete" });
  const copy = await sheets.copyLedger({ phone, name: "Rizwan", farmName: "Dairy Farm", allowed: true, onboardingState: "complete" });
  const store = sheets.ledgerFor({ sender: phone, sheetId: copy.sheetId });
  assert.ok(store.Animal_Events, "copyLedger should include Animal_Events");
  assert.ok(store.Feed_Stock, "copyLedger should include Feed_Stock");
  assert.ok(store.Customers[0].includes("billing_cycle"));

  const saved = await sheets.commitRecords({
    sender: phone,
    sheetId: copy.sheetId,
    entries: [
      { type: "add_customer", customer: "Aslam", rate_pkr: 190, opening_balance: 0, billing_cycle: "weekly", cycle_start_date: "2026-11-03" },
      { type: "sale", date: "2026-11-10", customer: "Aslam", litres: 10, rate_pkr: 190, amount: 1900, cash_received: 0, balance_added: 1900 },
      { type: "add_cow", cow_name: "Gori", animal_type: "cow", avg_daily_litres: 18 },
      { type: "animal_event", date: "2026-09-01", cow_name: "Gori", event_type: "insemination" },
      { type: "animal_event", date: "2026-11-01", cow_name: "Gori", event_type: "pregnancy_check", details: "gaban hai" },
      { type: "animal_event", date: "2026-11-12", cow_name: "Gori", event_type: "vet_appointment", doctor_name: "Doctor Sahab" },
      { type: "fodder", date: "2026-11-11", item: "wanda", quantity: 6, unit: "mann", cost_pkr: 6000, cash_paid: 6000, balance_owed: 0, daily_use: 2 },
      { type: "change_billing_cycle", customer: "Aslam", billing_cycle: "monthly" },
    ],
  });
  assert.strictEqual(saved.ok, true, saved.error || "commit should succeed");
  const recent = await sheets.readRecent({ days: 60, sender: phone, sheetId: copy.sheetId });
  const cycleIdx = recent.customers[0].indexOf("billing_cycle");
  const aslam = recent.customers.find((r, i) => i > 0 && r[0] === "Aslam");
  assert.strictEqual(aslam[cycleIdx], "monthly");
  const pregIdx = recent.cows[0].indexOf("pregnancy_status");
  const gori = recent.cows.find((r, i) => i > 0 && r.includes("Gori"));
  assert.strictEqual(gori[pregIdx], "pregnant");
  const wanda = recent.feed_stock.find((r, i) => i > 0 && String(r[0]).toLowerCase() === "wanda");
  assert.ok(wanda, "fodder purchase should increment stock");
  assert.strictEqual(Number(wanda[1]), 6);
  assert.ok(formatLedgerData(recent).includes("Feed_Stock"));
  assert.ok(formatLedgerData(recent).includes("Animal_Events"));

  const footer = reminderFooter({
    customers: recent.customers,
    sales: recent.sales,
    payments: recent.payments,
    cows: recent.cows,
    animal_events: recent.animal_events,
    feed_stock: recent.feed_stock,
  }, "2026-11-11");
  assert.ok(footer.includes("Khoraak") || footer.includes("Anay wala") || footer.includes("Bill") || footer === footer);

  const dueText = directQueryReply("kis ka bill due hai", recent, "2026-11-16");
  assert.ok(dueText && /bill|due|Aslam|nahi/i.test(dueText), dueText);
  const pregText = directQueryReply("kaun si gaye gaban hai", recent, "2026-11-11");
  assert.ok(pregText.includes("Gori"), pregText);
  const feedText = directQueryReply("wanda kab khatam hoga", recent, "2026-11-11");
  assert.ok(/wanda/i.test(feedText), feedText);

  const confirm = confirmationText({
    entries: [{ type: "animal_event", date: "2026-11-11", cow_name: "Gori", event_type: "vaccination", cost_pkr: 500 }],
    summary: "Gori ko teeka laga",
  });
  assert.ok(confirm.includes("Haan") && confirm.includes("Nahi") && /Edit|Tabdeeli/i.test(confirm), confirm);
  assert.ok(CONFIRM_FOOTER.includes("Edit") || /Tabdeeli/i.test(CONFIRM_FOOTER));
  const cycleConfirm = confirmationText({
    entries: [{ type: "change_billing_cycle", customer: "Aslam", billing_cycle: "weekly" }],
    summary: "",
  });
  assert.ok(/hafte/i.test(cycleConfirm) && /Edit|Tabdeeli/i.test(cycleConfirm), cycleConfirm);
  assert.ok(savedText([{ type: "animal_event" }]).includes("Save ho gaya"));
  assert.ok(/hafte|15 din|mahine|roz/i.test(ASK_CUSTOMERS), ASK_CUSTOMERS);
  const lines = customerOnboardLines([{ name: "Aslam", rate_pkr: 190, opening_balance: 0, billing_cycle: "weekly" }]);
  assert.ok(/hafte/i.test(lines), lines);
  assert.ok(needsOnboarding({ onboardingState: "pending_profile", sheetId: "" }, "923205506704"));
  assert.ok(/bill|khoraak|sehat/i.test(howToMessage("Noman")));

  // Old-shape memory ledger used by a farmer already mid-onboarding still migrates on first use
  const mid = new MemorySheets();
  mid.ledgers["existing"] = {
    Cows: [["cow_id", "name", "type", "breed", "status", "avg_daily_litres", "notes"]],
    Customers: [["name", "phone", "rate_pkr", "opening_balance", "current_balance", "notes"]],
    Milk_Log: [["date", "session", "cow_name", "litres", "source_note"]],
    Sales: [["date", "customer", "litres", "rate_pkr", "amount", "cash_received", "balance_added", "source_note"]],
    Payments: [["date", "customer", "amount", "method"]],
    Expenses: [["date", "category", "amount", "note"]],
    Fodder: [["date", "item", "quantity", "unit", "cost_pkr", "supplier", "cash_paid", "balance_owed", "source_note"]],
    Pending: [["sender", "created_at", "language", "entries_json", "status", "message_id"]],
    Processed_Ids: [["message_id", "received_at", "sender"]],
    Last_Write: [["sheet", "row", "type", "summary", "written_at"]],
  };
  await mid.upsertFarmer({
    phone: "923205506704",
    name: "Noman Mughal",
    farmName: "Naab Dairy",
    sheetId: "existing",
    allowed: true,
    onboardingState: "pending_animals",
  });
  const ctx = await mid.getContext({ sender: "923205506704", sheetId: "existing" });
  assert.strictEqual(ctx.ok, true);
  const shaped = mid.ledgerFor({ sender: "923205506704", sheetId: "existing" });
  assert.ok(shaped.Animal_Events);
  assert.ok(shaped.Customers[0].includes("billing_cycle"));
  const farmer = (await mid.getFarmer("923205506704")).farmer;
  assert.strictEqual(farmer.onboardingState, "pending_animals");
  assert.strictEqual(farmer.name, "Noman Mughal");
  assert.strictEqual(farmer.sheetId, "existing");

  console.log("test-stage2 ok");
}

main().catch((err) => {
  console.error("test-stage2 FAILED", err);
  process.exit(1);
});
