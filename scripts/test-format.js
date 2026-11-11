const assert = require("assert");
const { parseSheetDate, formatHumanDate, formatShortDate, formatRs, eventLabel } = require("../lib/format");
const { bilingual, setReplyContext, clearReplyContext, detectScript, confirmButtonTitles } = require("../lib/reply");
const { confirmationText, savedText, CONFIRM_FOOTER } = require("../lib/ledger");
const { reminderFooter } = require("../lib/reminders");

function withScript(mode, fn) {
  setReplyContext({ mode });
  try {
    return fn();
  } finally {
    clearReplyContext();
  }
}

const ref = "2026-11-11";
assert.strictEqual(parseSheetDate("2026-11-12T00:00:00.000Z"), "2026-11-12");
assert.strictEqual(parseSheetDate("2026-11-11"), "2026-11-11");
assert.strictEqual(parseSheetDate(46337), "2026-11-11");
assert.strictEqual(formatHumanDate("2026-11-11", ref), "Aaj, 11 Nov");
assert.strictEqual(formatHumanDate("2026-11-12T00:00:00.000Z", ref), "Kal, 12 Nov");
assert.strictEqual(formatHumanDate("2026-11-13", ref), "13 Nov (Jumma)");
assert.strictEqual(formatShortDate("2026-11-13"), "13 Nov");
assert.strictEqual(formatRs(1800), "Rs 1,800");
assert.strictEqual(formatRs(600), "Rs 600");
assert.strictEqual(eventLabel("vet_appointment", "roman"), "Doctor ki visit");
assert.strictEqual(eventLabel("vet_appointment", "urdu"), "ڈاکٹر کی وزٹ");
assert.strictEqual(eventLabel("pregnancy_check", "roman"), "Gaban check");
assert.ok(!/vet_appointment/.test(eventLabel("vet_appointment")));

assert.strictEqual(detectScript("Aslam ko 3 litre diye"), "roman");
assert.strictEqual(detectScript("اسلام علیکم یہ حساب لکھیں براہ مہربانی"), "urdu");

const both = withScript("both", () => bilingual("السلام علیکم", "Assalam o alaikum"));
assert.ok(both.startsWith("السلام علیکم"));
assert.ok(both.includes("\n\nAssalam o alaikum"));
assert.strictEqual(withScript("roman", () => bilingual("السلام علیکم", "Assalam o alaikum")), "Assalam o alaikum");
assert.strictEqual(withScript("urdu", () => bilingual("السلام علیکم", "Assalam o alaikum")), "السلام علیکم");

for (const btn of confirmButtonTitles()) {
  assert.ok([...btn.title].length <= 20, btn.title);
}
assert.ok(confirmButtonTitles().some((b) => b.title.includes("Haan")));
assert.ok(confirmButtonTitles().some((b) => b.title.includes("Nahi")));
assert.ok(confirmButtonTitles().some((b) => /Edit/.test(b.title)));

const sale = {
  type: "sale",
  customer: "Tabarak Hotel",
  litres: 3,
  rate_pkr: 200,
  amount: 600,
  cash_received: 600,
  balance_added: 0,
  session: "am",
};
const confirm = withScript("both", () => confirmationText({ entries: [sale], summary: "ignore me" }));
assert.ok(confirm.includes("*Yeh record karun?*"));
assert.ok(confirm.includes("یہ ریکارڈ کروں"));
assert.ok(confirm.includes("Tabarak Hotel: 3 L subah, Rs 600 (nagd)"));
assert.ok(confirm.includes("Tabarak Hotel: 3 L صبح، Rs 600 (نقد)") || confirm.includes("صبح"));
assert.ok(confirm.includes("Haan") && confirm.includes("Nahi") && /Edit/i.test(confirm));
assert.ok(!/2026-11-12T/.test(confirm));
assert.ok(!/cash_received|balance_added/.test(confirm));

const missing = withScript("roman", () =>
  confirmationText({
    entries: [{ type: "sale", customer: "Tabarak Hotel", litres: 3, session: "am" }],
  })
);
assert.ok(/rate nahi pata/i.test(missing), missing);

const saved = withScript("both", () => savedText([sale]));
assert.ok(saved.includes("✅ *Save ho gaya*"));
assert.ok(saved.includes("✅ *سیو ہو گیا*") || saved.includes("سیو ہو گیا"));
assert.ok(saved.includes("Tabarak Hotel: 3 L subah, Rs 600 (nagd)"));
assert.ok(!saved.includes("1 sale"));

const stock = [
  ["item", "quantity", "unit", "daily_use", "updated_at", "notes", "days_left", "run_out_date"],
  ["wanda", 2, "mann", 1, "2026-11-11", "", 2, "2026-11-13"],
];
const events = [
  ["date", "cow", "event_type", "details", "doctor_name", "diagnosis", "medicines", "cost_pkr", "next_due_date"],
  ["2026-11-12T00:00:00.000Z", "Kali", "vet_appointment", "", "", "", "", "", ""],
];
const footer = withScript("both", () =>
  reminderFooter(
    {
      customers: [["name", "phone", "rate_pkr", "opening_balance", "current_balance", "notes", "billing_cycle", "cycle_start_date"]],
      sales: [["date"]],
      payments: [["date"]],
      cows: [["cow_id", "name", "type"]],
      animal_events: events,
      feed_stock: stock,
    },
    "2026-11-11"
  )
);
assert.ok(/Wanda 2 din ka bacha \(13 Nov tak\)/.test(footer), footer);
assert.ok(footer.includes("*Khoraak*"));
assert.ok(footer.includes("*Aane wala*") || footer.includes("آنے والا"));
assert.ok(footer.includes("Kal, 12 Nov: Kali, Doctor ki visit"), footer);
assert.ok(!/2026-11-12T/.test(footer), footer);
assert.ok(!/vet_appointment/.test(footer), footer);
assert.ok(CONFIRM_FOOTER.includes("Edit"));

console.log("test-format ok");
