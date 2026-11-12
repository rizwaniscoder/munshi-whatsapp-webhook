const assert = require("assert");
const { MemorySheets } = require("../lib/sheets");
const { migrateStore, refreshDerivedStore } = require("../lib/derived");
const { confirmationText, savedText, routeFodderEntries, CONFIRM_FOOTER } = require("../lib/ledger");
const { directQueryReply } = require("../lib/queries");
const { reminderFooter } = require("../lib/reminders");
const { confirmButtonTitles } = require("../lib/reply");
const { formatHumanDate, formatRs } = require("../lib/format");
const { ASK_COMMITTEE, parseCommitteeOnboarding } = require("../lib/onboarding");
const {
  interpretCommittee,
  applyCommitteeDetails,
  summarizeCommittee,
  rowsToCommittees,
  rowsToLogs,
} = require("../lib/committee");
const { interpretExpenses, isJunkExpense, normalizeExpenseCategory, expenseLabel } = require("../lib/expenses");
const { interpretLocal } = require("../lib/interpret");

const TODAY = "2026-11-12";

function fail(msg) {
  throw new Error(msg);
}

function committeeSheet(rows) {
  return [
    ["name", "amount", "frequency", "start_date", "organizer", "status", "notes"],
    ...rows,
  ];
}

function logSheet(rows) {
  return [["date", "committee", "status", "amount", "note"], ...rows];
}

async function main() {
  const buttons = confirmButtonTitles();
  assert.strictEqual(buttons.length, 3);
  for (const b of buttons) assert.ok(b.title.length <= 20, b.title);

  const noSetup = interpretCommittee("aaj committee di", { today: TODAY, committees: [] });
  assert.strictEqual(noSetup.intent, "clarify");
  assert.ok(/raqam|kitni|amount/i.test(noSetup.reply), noSetup.reply);
  assert.ok(!noSetup.entries, "must not invent a committee payment");
  assert.ok(!/Rs\s*200|amount":\s*200/.test(JSON.stringify(noSetup)));

  const details = applyCommitteeDetails("roz 200, naam Bazar", noSetup.pending, { today: TODAY, committees: [] });
  assert.strictEqual(details.intent, "record");
  const setup = details.entries.find((e) => e.type === "setup_committee");
  const paidLog = details.entries.find((e) => e.type === "committee_log");
  assert.ok(setup && setup.amount === 200 && setup.frequency === "daily");
  assert.strictEqual(setup.name, "Bazar");
  assert.ok(paidLog && paidLog.status === "paid" && paidLog.amount === 200);
  assert.strictEqual(paidLog.date, TODAY);
  assert.ok(!paidLog.method && !setup.method);

  const stated = interpretCommittee("kameti 200 di", { today: TODAY, committees: [] });
  assert.strictEqual(stated.intent, "record");
  assert.strictEqual(stated.entries.find((e) => e.type === "committee_log").amount, 200);
  assert.strictEqual(stated.entries.find((e) => e.type === "committee_log").status, "paid");

  const existing = [{ name: "Bazar", amount: 200, frequency: "daily", start_date: "2026-11-10", status: "active" }];
  const missed = interpretCommittee("committee nahi di", { today: TODAY, committees: existing });
  assert.strictEqual(missed.intent, "record");
  const missedLog = missed.entries.find((e) => e.type === "committee_log");
  assert.strictEqual(missedLog.status, "not_paid");
  assert.strictEqual(missedLog.committee, "Bazar");
  assert.ok(missedLog.amount == null || missedLog.amount === "" || Number(missedLog.amount) === 0);
  assert.notStrictEqual(Number(missedLog.amount), 200);

  const yesterday = interpretCommittee("kal wali committee pending hai", { today: TODAY, committees: existing });
  assert.strictEqual(yesterday.entries[0].date, "2026-11-11");
  assert.strictEqual(yesterday.entries[0].status, "not_paid");

  const monthQuery = interpretCommittee("is mahine committee kitni di", { today: TODAY, committees: existing });
  assert.strictEqual(monthQuery.intent, "query");

  const many = [
    { name: "Bazar", amount: 200, frequency: "daily", start_date: "2026-11-01", status: "active" },
    { name: "School", amount: 500, frequency: "weekly", start_date: "2026-11-02", status: "active" },
  ];
  const which = interpretCommittee("aaj committee di", { today: TODAY, committees: many });
  assert.strictEqual(which.intent, "clarify");
  assert.ok(/kaun|naam/i.test(which.reply), which.reply);
  assert.ok(!which.entries);

  const named = interpretCommittee("aaj Bazar committee di", { today: TODAY, committees: many });
  assert.strictEqual(named.intent, "record");
  assert.strictEqual(named.entries[0].committee, "Bazar");
  assert.strictEqual(named.entries[0].amount, 200);
  assert.strictEqual(named.entries[0].status, "paid");

  const partial = interpretCommittee("kameti 100 di", {
    today: TODAY,
    committees: [{ name: "Committee", amount: 200, frequency: "daily", start_date: TODAY, status: "active" }],
  });
  assert.strictEqual(partial.entries[0].status, "partial");
  assert.strictEqual(partial.entries[0].amount, 100);

  const summary = summarizeCommittee(
    { name: "Bazar", amount: 200, frequency: "daily", start_date: "2026-11-10", status: "active" },
    [
      { date: "2026-11-10", committee: "Bazar", status: "paid", amount: 200 },
      { date: "2026-11-11", committee: "Bazar", status: "not_paid", amount: "" },
    ],
    TODAY
  );
  assert.strictEqual(summary.monthPaid, 1);
  assert.strictEqual(summary.monthMissed, 2);
  assert.strictEqual(summary.arrears, 400);
  assert.strictEqual(summary.given, 200);
  assert.strictEqual(summary.todayStatus, "not_paid");

  const weekly = summarizeCommittee(
    { name: "School", amount: 1000, frequency: "weekly", start_date: "2026-11-02", status: "active" },
    [],
    TODAY
  );
  assert.strictEqual(weekly.arrears, 1000);
  assert.strictEqual(weekly.todayStatus, "not_paid");

  const data = {
    committees: committeeSheet([["Bazar", 200, "daily", "2026-11-10", "", "active", ""]]),
    committee_log: logSheet([
      ["2026-11-10", "Bazar", "paid", 200, ""],
      ["2026-11-11", "Bazar", "not_paid", "", ""],
    ]),
    expenses: [
      ["date", "category", "amount", "note"],
      ["2026-11-12", "labor", 300, ""],
      ["2026-11-12", "salary", 2000, ""],
      ["2026-11-08", "labor", 500, ""],
      ["2026-11-01", "labor", 1000, "purane hafte"],
      ["2026-11-12", "chai", 40, ""],
    ],
  };
  const monthText = directQueryReply("is mahine committee kitni di", data, TODAY);
  assert.ok(monthText && /200/.test(monthText) && /nahi di|baqi/i.test(monthText), monthText);
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(monthText), monthText);
  const todayText = directQueryReply("kya aaj committee di", data, TODAY);
  assert.ok(/nahi di/i.test(todayText), todayText);
  const soFar = directQueryReply("committee kitni di ab tak", data, TODAY);
  assert.ok(/200/.test(soFar), soFar);

  const confirm = confirmationText({
    entries: [
      { type: "setup_committee", name: "Bazar", amount: 200, frequency: "daily", organizer: "Rashid" },
      { type: "committee_log", date: TODAY, committee: "Bazar", status: "paid", amount: 200 },
    ],
  });
  assert.ok(confirm.includes("Haan") && confirm.includes("Nahi") && /Edit|Tabdeeli/i.test(confirm), confirm);
  assert.ok(confirm.includes(CONFIRM_FOOTER) || /Haan dabain/i.test(confirm));
  assert.ok(confirm.includes(formatRs(200)) && confirm.includes(formatHumanDate(TODAY)), confirm);
  assert.ok(/committee/i.test(confirm) && /roz/i.test(confirm), confirm);
  const saved = savedText([{ type: "committee_log", date: TODAY, committee: "Bazar", status: "not_paid", amount: "" }]);
  assert.ok(/Save ho gaya/i.test(saved) && /nahi di/i.test(saved), saved);

  const footer = reminderFooter(
    {
      committees: data.committees,
      committee_log: data.committee_log,
      feed_stock: [],
      cows: [],
      animal_events: [],
      customers: [],
      sales: [],
      payments: [],
    },
    TODAY
  );
  assert.ok(/Committee/i.test(footer) && /nahi di/i.test(footer), footer);

  const both = interpretLocal("aaj 500 mazdoori aur 2000 tankhwah", { today: TODAY, committees: [] });
  assert.strictEqual(both.intent, "record");
  assert.strictEqual(both.entries.length, 2);
  assert.strictEqual(both.entries[0].category, "labor");
  assert.strictEqual(both.entries[0].amount, 500);
  assert.strictEqual(both.entries[1].category, "salary");
  assert.strictEqual(both.entries[1].amount, 2000);
  assert.strictEqual(both.entries[0].date, TODAY);
  assert.ok(!both.entries[0].method && !both.entries[0].vendor);

  const notLocal = [
    "Gori 18",
    "Gori ne 18 diya",
    "Subah Gori 18",
    "Aslam ko 2000 diye",
    "Aslam se 2000 liye",
    "Aslam ne 2000 cash diye",
    "Aslam 2000 wasool",
    "aaj 80 chai",
  ];
  for (const phrase of notLocal) {
    assert.strictEqual(interpretExpenses(phrase, { today: TODAY }), null, phrase);
    assert.strictEqual(interpretLocal(phrase, { today: TODAY, committees: [] }), null, phrase);
  }
  const chai = interpretExpenses("aaj kharcha 80 chai", { today: TODAY });
  assert.strictEqual(chai.intent, "record");
  assert.strictEqual(chai.entries[0].category, "chai");
  assert.strictEqual(chai.entries[0].amount, 80);
  assert.strictEqual(interpretLocal("aaj 500 mazdoori", { today: TODAY, committees: [] }).entries[0].category, "labor");
  assert.strictEqual(interpretLocal("aaj 2000 tankhwah", { today: TODAY, committees: [] }).entries[0].category, "salary");
  assert.strictEqual(interpretLocal("aaj 300 bijli", { today: TODAY, committees: [] }).entries[0].category, "electricity");
  assert.strictEqual(interpretLocal("aaj committee di", { today: TODAY, committees: [] }).intent, "clarify");
  assert.strictEqual(interpretLocal("committee nahi di", { today: TODAY, committees: existing }).entries[0].status, "not_paid");
  assert.strictEqual(interpretLocal("kameti 200 di", { today: TODAY, committees: [] }).entries.find((e) => e.type === "committee_log").amount, 200);
  assert.strictEqual(normalizeExpenseCategory("chai"), "chai");
  assert.notStrictEqual(normalizeExpenseCategory("dukaan kiraya"), "other");
  assert.strictEqual(normalizeExpenseCategory("mazdoori"), "labor");
  assert.strictEqual(expenseLabel("labor", "roman"), "mazdoori");
  assert.strictEqual(expenseLabel("salary", "roman"), "tankhwah");

  const typo = interpretExpenses("tankhwah typo", { today: TODAY });
  assert.notStrictEqual(typo.intent, "record");
  assert.ok(!typo.entries || !typo.entries.length, "typo must not write an expense");

  assert.strictEqual(interpretExpenses("aaj 2 mann wanda liya 6000", { today: TODAY }), null);
  assert.strictEqual(interpretExpenses("is mahine chare pe kitna kharcha hua", { today: TODAY }), null);
  assert.strictEqual(interpretExpenses("aaj kharcha kitna hua", { today: TODAY }).intent, "query");
  assert.strictEqual(interpretExpenses("is hafte mazdoori kitni di", { today: TODAY }).intent, "query");

  const kharcha = directQueryReply("aaj kharcha kitna hua", data, TODAY);
  assert.ok(/2,340|2340/.test(kharcha), kharcha);
  assert.ok(/mazdoori/i.test(kharcha) && /tankhwah/i.test(kharcha), kharcha);
  const weekLabor = directQueryReply("is hafte mazdoori kitni di", data, TODAY);
  assert.ok(/800/.test(weekLabor), weekLabor);
  assert.ok(!/1,000|1000/.test(weekLabor), weekLabor);

  const routed = routeFodderEntries([
    { type: "expense", category: "feed", date: "", amount: "" },
    { type: "expense", category: "labor", date: TODAY, amount: "" },
    { type: "expense", category: "", date: "", amount: "", note: "" },
    { type: "expense", category: "mazdoori", date: TODAY, amount: 500 },
    { type: "expense", category: "chai", date: TODAY, amount: 80 },
  ]);
  assert.ok(!routed.some((e) => e.type === "expense" && (e.amount === "" || e.amount == null)));
  assert.ok(routed.some((e) => e.type === "expense" && e.category === "labor" && e.amount === 500));
  assert.ok(routed.some((e) => e.type === "expense" && e.category === "chai" && e.amount === 80));
  assert.strictEqual(isJunkExpense({ type: "expense", category: "salary", amount: "", date: TODAY }), true);

  const expConfirm = confirmationText({
    entries: [
      { type: "expense", date: TODAY, category: "labor", amount: 500 },
      { type: "expense", date: "2026-11-11", category: "salary", amount: 2000, note: "helper" },
    ],
  });
  assert.ok(/mazdoori/i.test(expConfirm) && /tankhwah/i.test(expConfirm), expConfirm);
  assert.ok(expConfirm.includes(formatRs(500)) && expConfirm.includes(formatHumanDate(TODAY)), expConfirm);
  assert.ok(/helper/i.test(expConfirm));
  assert.ok(!/cash|JazzCash|vendor/i.test(expConfirm));

  const oldStore = {
    Cows: [["cow_id", "name", "type"]],
    Customers: [["name", "phone", "rate_pkr", "opening_balance", "current_balance", "notes"], ["Aslam", "", 190, 0, 0, ""]],
    Expenses: [["date", "category", "amount", "note"], ["2026-11-01", "fuel", 100, "diesel"]],
    Milk_Log: [["date", "session", "cow_name", "litres", "source_note"], ["2026-11-01", "am", "Gori", 18, ""]],
    Sales: [["date", "customer", "litres", "rate_pkr", "amount", "cash_received", "balance_added", "source_note"]],
    Payments: [["date", "customer", "amount", "method"]],
  };
  migrateStore(oldStore);
  assert.strictEqual(oldStore.Expenses[1][2], 100);
  assert.strictEqual(oldStore.Milk_Log[1][3], 18);
  assert.ok(oldStore.Committees[0].includes("amount") && oldStore.Committees[0].includes("frequency"));
  assert.ok(oldStore.Committee_Log[0].includes("status"));
  assert.ok(oldStore.Committee_Status[0].includes("arrears"));
  assert.strictEqual(oldStore.Customers[1][0], "Aslam");
  refreshDerivedStore(oldStore, TODAY);
  assert.strictEqual(oldStore.Committee_Status.length, 1);

  const sheets = new MemorySheets();
  const phone = "923155506704";
  await sheets.upsertFarmer({ phone, name: "Rizwan", farmName: "Dairy Farm", allowed: true, onboardingState: "complete" });
  const copy = await sheets.copyLedger({ phone, name: "Rizwan", farmName: "Dairy Farm", allowed: true, onboardingState: "complete" });
  const junk = await sheets.commitRecords({
    sender: phone,
    sheetId: copy.sheetId,
    refresh: false,
    entries: [
      { type: "expense", category: "feed", date: "", amount: "" },
      { type: "expense", category: "", date: "", amount: 0, note: "" },
      { type: "expense", category: "tankhwah", date: TODAY, amount: "" },
    ],
  });
  assert.strictEqual(junk.ok, true);
  const afterJunk = await sheets.readRecent({ days: 60, refresh: false, sender: phone, sheetId: copy.sheetId });
  assert.ok((afterJunk.expenses || []).slice(1).every((r) => r[0] || Number(r[2])), "blank expense rows must not be stored");
  assert.strictEqual(afterJunk.expenses.slice(1).length, 0);

  const savedRows = await sheets.commitRecords({
    sender: phone,
    sheetId: copy.sheetId,
    refresh: false,
    entries: [
      { type: "setup_committee", name: "Bazar", amount: 200, frequency: "daily", start_date: "2026-11-10", organizer: "Rashid" },
      { type: "committee_log", date: "2026-11-10", committee: "Bazar", status: "paid", amount: 200 },
      { type: "committee_log", date: "2026-11-11", committee: "Bazar", status: "not_paid" },
      { type: "expense", date: TODAY, category: "mazdoori", amount: 500, note: "ali" },
      { type: "expense", date: TODAY, category: "salary", amount: 2000 },
      { type: "expense", date: TODAY, category: "generator diesel extra", amount: 150 },
    ],
  });
  assert.strictEqual(savedRows.ok, true, savedRows.error || "commit");
  const recent = await sheets.readRecent({ days: 30, refresh: false, sender: phone, sheetId: copy.sheetId });
  const committees = rowsToCommittees(recent.committees);
  assert.strictEqual(committees[0].name, "Bazar");
  assert.strictEqual(Number(committees[0].amount), 200);
  assert.strictEqual(committees[0].organizer, "Rashid");
  const logs = rowsToLogs(recent.committee_log);
  assert.strictEqual(logs.length, 2);
  assert.ok(logs.some((l) => l.status === "not_paid" && !(Number(l.amount) > 0)));
  const cats = recent.expenses.slice(1).map((r) => r[1]);
  assert.ok(cats.includes("labor") && cats.includes("salary"), cats.join(","));
  assert.ok(cats.includes("generator diesel extra"), cats.join(","));
  const live = directQueryReply("is mahine committee kitni di", recent, TODAY);
  assert.ok(/200/.test(live) && /baqi|nahi di/i.test(live), live);
  const ctx = await sheets.getContext({ sender: phone, sheetId: copy.sheetId });
  assert.ok(ctx.committees.some((c) => c.name === "Bazar" && Number(c.amount) === 200));

  await sheets.refreshDerived({ sender: phone, sheetId: copy.sheetId });
  const derived = await sheets.readRecent({ days: 5, refresh: false, sender: phone, sheetId: copy.sheetId });
  const statusRow = derived.committee_status.slice(1)[0];
  assert.ok(statusRow && String(statusRow[0]) === "Bazar", JSON.stringify(derived.committee_status));
  assert.ok(Number(statusRow[derived.committee_status[0].indexOf("arrears")]) >= 200);

  assert.ok(/skip/i.test(ASK_COMMITTEE) && /committee|kameti/i.test(ASK_COMMITTEE), ASK_COMMITTEE);
  assert.strictEqual(parseCommitteeOnboarding("skip").skip, true);
  assert.strictEqual(parseCommitteeOnboarding("committee nahi").skip, true);
  const onboard = parseCommitteeOnboarding("roz 200 ki committee, naam Bazar, organizer Rashid");
  assert.strictEqual(onboard.skip, false);
  assert.strictEqual(onboard.committees[0].amount, 200);
  assert.strictEqual(onboard.committees[0].frequency, "daily");
  assert.strictEqual(onboard.committees[0].name, "Bazar");
  assert.strictEqual(onboard.committees[0].organizer, "Rashid");
  assert.strictEqual(parseCommitteeOnboarding("meri committee hai").committees.length, 0);

  const mixed = interpretLocal("aaj committee nahi di aur 300 bijli", { today: TODAY, committees: existing });
  assert.strictEqual(mixed.intent, "record");
  assert.ok(mixed.entries.some((e) => e.type === "committee_log" && e.status === "not_paid"));
  assert.ok(mixed.entries.some((e) => e.type === "expense" && e.category === "electricity" && e.amount === 300));

  if (!monthText) fail("month query empty");
  console.log("test-committee-expenses ok");
}

main().catch((err) => {
  console.error("test-committee-expenses FAILED", err);
  process.exit(1);
});
