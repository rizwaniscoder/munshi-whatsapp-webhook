process.env.WHATSAPP_DRY_RUN = "1";
delete process.env.SHEETS_WEBHOOK_URL;
delete process.env.SHEETS_SECRET;
process.env.MUNSHI_SHEETS_FILE = "/tmp/munshi-supply-ledger.json";
process.env.ALLOWED_NUMBERS = "";
process.env.TZ = "Asia/Karachi";
process.env.REPLY_SCRIPT = "roman";

const assert = require("assert");
const fs = require("fs");
const { MemorySheets } = require("../lib/sheets");
const { migrateStore } = require("../lib/derived");
const { takeOutbound } = require("../lib/whatsapp");
const { processPayload } = require("../lib/bot");
const { directQueryReply } = require("../lib/queries");
const { confirmationText } = require("../lib/ledger");
const { customerOnboardLines, ASK_CUSTOMERS } = require("../lib/onboarding");
const {
  parseSupplyClause,
  parseCustomersOnboarding,
  buildOnboardingCustomerEntries,
  interpretSupply,
} = require("../lib/supply");

const REF = "2026-11-12";

function wa(id, from, text) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_TEST",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              contacts: [{ profile: { name: "Noman" }, wa_id: from }],
              messages: [
                {
                  from,
                  id,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function lastText() {
  const sends = takeOutbound();
  return sends
    .map((s) => s.text?.body || s.interactive?.body?.text || "")
    .filter(Boolean)
    .join("\n");
}

function col(header, row, name) {
  const i = header.indexOf(name);
  assert.notStrictEqual(i, -1, `missing column ${name}`);
  return row[i];
}

function dayOf(iso) {
  return String(iso || "").slice(8, 10);
}

// --- parse rules ---
const one = parseSupplyClause("1 litter", REF);
assert.strictEqual(one.supply_type, "fixed");
assert.strictEqual(one.daily_litres, 1);

const half = parseSupplyClause("1.5 liter", REF);
assert.strictEqual(half.supply_type, "fixed");
assert.strictEqual(half.daily_litres, 1.5);

const rozana = parseSupplyClause("rozana 2 liter", REF);
assert.strictEqual(rozana.supply_type, "fixed");
assert.strictEqual(rozana.daily_litres, 2);

const fixedWord = parseSupplyClause("fixed 2 liter", REF);
assert.strictEqual(fixedWord.supply_type, "fixed");
assert.strictEqual(fixedWord.daily_litres, 2);

const hotel = parseSupplyClause("hotel hai jitna le us hisab se", REF);
assert.strictEqual(hotel.supply_type, "flexible");
assert.strictEqual(hotel.daily_litres, "");
assert.strictEqual(hotel.supply_note || "", "");

const standing = parseSupplyClause("2 liter, payment har mahine ki 2 tareekh ko", REF);
assert.strictEqual(standing.supply_type, "fixed");
assert.strictEqual(standing.daily_litres, 2, "2 is every day, not the monthly total");
assert.strictEqual(standing.billing_cycle, "monthly");
assert.strictEqual(dayOf(standing.cycle_start_date), "02");

const typical = parseSupplyClause("Tabarak 50 liter", REF);
assert.strictEqual(typical.supply_type, "flexible");
assert.strictEqual(typical.daily_litres, "");
assert.ok(/typical 50 L\/day/i.test(typical.supply_note || ""), typical.supply_note);

const sixth = parseSupplyClause("Aslam har 6 tareekh ko", REF);
assert.strictEqual(sixth.billing_cycle, "monthly");
assert.strictEqual(dayOf(sixth.cycle_start_date), "06");
assert.strictEqual(sixth.supply_type, "");
assert.strictEqual(sixth.daily_litres, "");

const tenth = parseSupplyClause("har 10 tareekh ko", REF);
assert.strictEqual(tenth.billing_cycle, "monthly");
assert.strictEqual(dayOf(tenth.cycle_start_date), "10");

const everySix = parseSupplyClause("Aslam har 6 din baad paise deta hai", REF);
assert.notStrictEqual(dayOf(everySix.cycle_start_date), "06");
assert.notStrictEqual(everySix.billing_cycle, "monthly");
assert.strictEqual(everySix.supply_type, "");

const everyFifteen = parseSupplyClause("Aslam har 15 din baad paise deta hai, rozana 2 liter", REF);
assert.strictEqual(everyFifteen.supply_type, "fixed");
assert.strictEqual(everyFifteen.daily_litres, 2);
assert.strictEqual(everyFifteen.billing_cycle, "biweekly");
assert.notStrictEqual(dayOf(everyFifteen.cycle_start_date), "15");

const quiet = parseSupplyClause("Aslam rate 190, 2000 udhaar", REF);
assert.strictEqual(quiet.supply_type, "");
assert.strictEqual(quiet.daily_litres, "");
assert.strictEqual(quiet.cycle_start_date, "");

const bigFixed = parseSupplyClause("rozana 50 liter", REF);
assert.strictEqual(bigFixed.supply_type, "fixed");
assert.strictEqual(bigFixed.daily_litres, 50);

assert.strictEqual(interpretSupply("Aslam ko 20 litre diye, rate 190"), null);
assert.strictEqual(interpretSupply("Gori ne 18 litre doodh diya"), null);

// --- onboarding parse ---
const onboard = parseCustomersOnboarding(
  "Aslam 2 liter, payment har mahine ki 2 tareekh ko. Tabarak 50 liter. Bilal hotel hai jitna le us hisab se. Sana 1.5 liter hafte baad. Raza 1 litter. Kamran rate 190, phone 03001234567",
  REF
);
assert.strictEqual(onboard.skip, false);
const byName = Object.fromEntries(onboard.customers.map((c) => [c.name, c]));
assert.strictEqual(byName.Aslam.supply_type, "fixed");
assert.strictEqual(byName.Aslam.daily_litres, 2);
assert.strictEqual(byName.Aslam.billing_cycle, "monthly");
assert.strictEqual(dayOf(byName.Aslam.cycle_start_date), "02");
assert.ok(byName.Aslam.rate_pkr == null, "do not invent Aslam's rate");

assert.strictEqual(byName.Tabarak.supply_type, "flexible");
assert.strictEqual(byName.Tabarak.daily_litres, "");
assert.ok(/typical 50 L\/day/i.test(byName.Tabarak.supply_note || ""));

assert.strictEqual(byName.Bilal.supply_type, "flexible");
assert.strictEqual(byName.Bilal.daily_litres, "");
assert.strictEqual(byName.Bilal.supply_note || "", "");

assert.strictEqual(byName.Sana.supply_type, "fixed");
assert.strictEqual(byName.Sana.daily_litres, 1.5);
assert.strictEqual(byName.Sana.billing_cycle, "weekly");

assert.strictEqual(byName.Raza.supply_type, "fixed");
assert.strictEqual(byName.Raza.daily_litres, 1);

assert.strictEqual(byName.Kamran.supply_type, "");
assert.strictEqual(byName.Kamran.daily_litres, "");
assert.strictEqual(byName.Kamran.rate_pkr, 190);
assert.ok(String(byName.Kamran.phone).includes("03001234567"));

const entries = buildOnboardingCustomerEntries(onboard.customers, REF);
const aslamEntry = entries.find((e) => e.customer === "Aslam");
assert.strictEqual(aslamEntry.daily_litres, 2);
assert.strictEqual(aslamEntry.billing_cycle, "monthly");
assert.strictEqual(dayOf(aslamEntry.cycle_start_date), "02");
const kamranEntry = entries.find((e) => e.customer === "Kamran");
assert.strictEqual(kamranEntry.supply_type, "");
assert.strictEqual(kamranEntry.daily_litres, "");
assert.strictEqual(kamranEntry.billing_cycle, "daily");
assert.strictEqual(kamranEntry.cycle_start_date, REF);

assert.ok(/rozana|liter|hotel|jitna/i.test(ASK_CUSTOMERS), ASK_CUSTOMERS);
const lines = customerOnboardLines([
  { name: "Aslam", rate_pkr: 190, opening_balance: 0, billing_cycle: "monthly", supply_type: "fixed", daily_litres: 2 },
  { name: "Tabarak", rate_pkr: "", opening_balance: 0, supply_type: "flexible", supply_note: "typical 50 L/day" },
]);
assert.ok(/rozana 2 L/i.test(lines), lines);
assert.ok(/typical 50 L\/day/i.test(lines), lines);

const confirm = confirmationText({
  entries: [
    { type: "set_supply", customer: "Aslam", supply_type: "fixed", daily_litres: 2, billing_cycle: "monthly" },
  ],
});
assert.ok(/rozana 2 L/i.test(confirm), confirm);

// --- migrate keeps existing cells and unknown columns ---
const oldStore = {
  Cows: [["cow_id", "name", "type", "breed", "status", "avg_daily_litres", "notes"], ["C-1", "Gori", "cow", "", "milking", 18, ""]],
  Customers: [
    ["name", "phone", "rate_pkr", "opening_balance", "current_balance", "notes", "billing_cycle", "cycle_start_date", "route", "supply_type", "daily_litres"],
    ["Aslam", "03001112233", 220, 100, 1500, "gate", "monthly", "2026-11-06", "north", "fixed", 2],
    ["Tabarak", "", 200, 0, 0, "typical 50 L/day", "daily", "2026-11-01", "south", "flexible", ""],
  ],
  Milk_Log: [["date", "session", "cow_name", "litres", "source_note"], ["2026-11-11", "am", "Gori", 18, "keep"]],
  Sales: [["date", "customer", "litres", "rate_pkr", "amount", "cash_received", "balance_added", "source_note"], ["2026-11-11", "Aslam", 2, 220, 440, 0, 440, "keep"]],
  Payments: [["date", "customer", "amount", "method"], ["2026-11-01", "Aslam", 100, "cash"]],
};
migrateStore(oldStore);
assert.strictEqual(oldStore.Customers[0].filter((h) => h === "supply_type").length, 1);
assert.strictEqual(oldStore.Customers[0].filter((h) => h === "daily_litres").length, 1);
assert.ok(oldStore.Customers[0].includes("route"));
assert.strictEqual(col(oldStore.Customers[0], oldStore.Customers[1], "supply_type"), "fixed");
assert.strictEqual(col(oldStore.Customers[0], oldStore.Customers[1], "daily_litres"), 2);
assert.strictEqual(col(oldStore.Customers[0], oldStore.Customers[1], "route"), "north");
assert.strictEqual(col(oldStore.Customers[0], oldStore.Customers[1], "rate_pkr"), 220);
assert.strictEqual(col(oldStore.Customers[0], oldStore.Customers[1], "opening_balance"), 100);
assert.strictEqual(col(oldStore.Customers[0], oldStore.Customers[1], "notes"), "gate");
assert.strictEqual(col(oldStore.Customers[0], oldStore.Customers[1], "billing_cycle"), "monthly");
assert.strictEqual(col(oldStore.Customers[0], oldStore.Customers[1], "cycle_start_date"), "2026-11-06");
assert.strictEqual(col(oldStore.Customers[0], oldStore.Customers[2], "supply_type"), "flexible");
assert.strictEqual(col(oldStore.Customers[0], oldStore.Customers[2], "daily_litres"), "");
assert.strictEqual(oldStore.Cows[1][5], 18);
assert.strictEqual(oldStore.Milk_Log[1][3], 18);
assert.strictEqual(oldStore.Sales[1][2], 2);
assert.strictEqual(oldStore.Payments[1][2], 100);

const bare = {
  Customers: [
    ["name", "phone", "rate_pkr", "opening_balance", "current_balance", "notes", "area"],
    ["Aslam", "", 190, 50, 50, "purana", "lahore"],
  ],
};
migrateStore(bare);
assert.ok(bare.Customers[0].includes("supply_type"));
assert.ok(bare.Customers[0].includes("daily_litres"));
assert.ok(bare.Customers[0].includes("area"));
assert.strictEqual(col(bare.Customers[0], bare.Customers[1], "area"), "lahore");
assert.strictEqual(col(bare.Customers[0], bare.Customers[1], "supply_type"), "");
assert.strictEqual(col(bare.Customers[0], bare.Customers[1], "daily_litres"), "");
assert.strictEqual(col(bare.Customers[0], bare.Customers[1], "notes"), "purana");
assert.strictEqual(col(bare.Customers[0], bare.Customers[1], "opening_balance"), 50);

async function main() {
// --- ledger writes ---
const sheets = new MemorySheets();
const phone = "923001112233";
await sheets.upsertFarmer({
  phone,
  name: "Noman",
  farmName: "Naab Dairy",
  allowed: true,
  onboardingState: "complete",
});
const copy = await sheets.copyLedger({
  phone,
  name: "Noman",
  farmName: "Naab Dairy",
  allowed: true,
  onboardingState: "complete",
});
const saved = await sheets.commitRecords({
  sender: phone,
  sheetId: copy.sheetId,
  refresh: false,
  entries: [
    {
      type: "add_customer",
      customer: "Aslam",
      rate_pkr: 220,
      opening_balance: 100,
      phone: "03001112233",
      billing_cycle: "monthly",
      cycle_start_date: "2026-11-02",
      supply_type: "fixed",
      daily_litres: 2,
    },
    {
      type: "add_customer",
      customer: "Tabarak",
      rate_pkr: 200,
      opening_balance: 0,
      supply_type: "flexible",
      daily_litres: "",
      supply_note: "typical 50 L/day",
    },
    { type: "add_cow", cow_name: "Gori", animal_type: "cow", avg_daily_litres: 18 },
  ],
});
assert.strictEqual(saved.ok, true, saved.error || "commit");
let recent = await sheets.readRecent({ days: 30, refresh: false, sender: phone, sheetId: copy.sheetId });
let header = recent.customers[0];
let aslam = recent.customers.find((r, i) => i > 0 && r[0] === "Aslam");
let tabarak = recent.customers.find((r, i) => i > 0 && r[0] === "Tabarak");
assert.strictEqual(col(header, aslam, "supply_type"), "fixed");
assert.strictEqual(Number(col(header, aslam, "daily_litres")), 2);
assert.strictEqual(col(header, aslam, "billing_cycle"), "monthly");
assert.strictEqual(col(header, aslam, "rate_pkr"), 220);
assert.strictEqual(Number(col(header, aslam, "opening_balance")), 100);
assert.strictEqual(col(header, tabarak, "supply_type"), "flexible");
assert.strictEqual(col(header, tabarak, "daily_litres"), "");
assert.ok(/typical 50 L\/day/i.test(String(col(header, tabarak, "notes"))));

const sale = await sheets.commitRecords({
  sender: phone,
  sheetId: copy.sheetId,
  refresh: false,
  entries: [
    { type: "sale", date: REF, customer: "Aslam", litres: 2, rate_pkr: 220, amount: 440, cash_received: 0, balance_added: 440 },
  ],
});
assert.strictEqual(sale.ok, true, sale.error || "sale");
recent = await sheets.readRecent({ days: 30, refresh: false, sender: phone, sheetId: copy.sheetId });
header = recent.customers[0];
aslam = recent.customers.find((r, i) => i > 0 && r[0] === "Aslam");
assert.strictEqual(col(header, aslam, "supply_type"), "fixed");
assert.strictEqual(Number(col(header, aslam, "daily_litres")), 2);
assert.strictEqual(col(header, aslam, "billing_cycle"), "monthly");
assert.strictEqual(col(header, aslam, "cycle_start_date"), "2026-11-02");
assert.strictEqual(Number(col(header, aslam, "opening_balance")), 100);
assert.strictEqual(recent.sales[1][1], "Aslam");
assert.strictEqual(Number(recent.sales[1][2]), 2);
assert.strictEqual(recent.cows[1][1], "Gori");

const edited = await sheets.commitRecords({
  sender: phone,
  sheetId: copy.sheetId,
  refresh: false,
  entries: [
    { type: "set_supply", customer: "Aslam", supply_type: "flexible", supply_note: "" },
  ],
});
assert.strictEqual(edited.ok, true, edited.error || "set_supply");
recent = await sheets.readRecent({ days: 30, refresh: false, sender: phone, sheetId: copy.sheetId });
aslam = recent.customers.find((r, i) => i > 0 && r[0] === "Aslam");
assert.strictEqual(col(recent.customers[0], aslam, "supply_type"), "flexible");
assert.strictEqual(col(recent.customers[0], aslam, "daily_litres"), "");
assert.strictEqual(col(recent.customers[0], aslam, "rate_pkr"), 220);
assert.strictEqual(col(recent.customers[0], aslam, "billing_cycle"), "monthly");

await sheets.commitRecords({
  sender: phone,
  sheetId: copy.sheetId,
  refresh: false,
  entries: [{ type: "set_supply", customer: "Aslam", supply_type: "fixed", daily_litres: 2 }],
});

const answer = directQueryReply("Aslam rozana kitna leta hai?", {
  customers: (await sheets.readRecent({ days: 5, refresh: false, sender: phone, sheetId: copy.sheetId })).customers,
}, REF);
assert.ok(/Aslam/.test(answer) && /2/.test(answer) && /fixed|rozana/i.test(answer), answer);
assert.ok(!/mahine ka total|monthly total/i.test(answer), answer);

const flexAnswer = directQueryReply("Tabarak rozana kitna leta hai?", {
  customers: (await sheets.readRecent({ days: 5, refresh: false, sender: phone, sheetId: copy.sheetId })).customers,
}, REF);
assert.ok(/Tabarak/.test(flexAnswer) && /flexible|jitna/i.test(flexAnswer), flexAnswer);
assert.ok(/typical 50/i.test(flexAnswer), flexAnswer);

const unknown = directQueryReply("Kamran rozana kitna leta hai?", {
  customers: [
    ["name", "phone", "rate_pkr", "opening_balance", "current_balance", "notes", "billing_cycle", "cycle_start_date", "supply_type", "daily_litres"],
    ["Kamran", "", 190, 0, 0, "", "daily", REF, "", ""],
  ],
}, REF);
assert.ok(/nahi|likha nahi|blank/i.test(unknown), unknown);
assert.ok(!/\b190\b/.test(unknown), unknown);

// --- WhatsApp onboarding text, then a later edit and a query. No Gemini. ---
fs.rmSync(process.env.MUNSHI_SHEETS_FILE, { force: true });
const live = new MemorySheets(process.env.MUNSHI_SHEETS_FILE);
const farmerPhone = "923215550001";
const made = await live.copyLedger({
  phone: farmerPhone,
  name: "Noman",
  farmName: "Naab Dairy",
  allowed: true,
  onboardingState: "pending_customers",
});
await processPayload(
  live,
  wa(
    "wamid.supply.onboard",
    farmerPhone,
    "Aslam 2 liter, payment har mahine ki 2 tareekh ko. Tabarak 50 liter. Bilal hotel hai jitna le us hisab se"
  )
);
let out = lastText();
assert.ok(/Aslam/.test(out) && /rozana 2 L/i.test(out), out);
assert.ok(/Tabarak/.test(out) && /typical 50 L\/day/i.test(out), out);
assert.ok(/Bilal/.test(out) && /flexible|jitna/i.test(out), out);
await processPayload(live, wa("wamid.supply.haan", farmerPhone, "Haan"));
const ledger = live.ledgerFor({ sender: farmerPhone, sheetId: made.sheetId });
const h = ledger.Customers[0];
const rowA = ledger.Customers.find((r, i) => i > 0 && r[0] === "Aslam");
const rowT = ledger.Customers.find((r, i) => i > 0 && r[0] === "Tabarak");
const rowB = ledger.Customers.find((r, i) => i > 0 && r[0] === "Bilal");
assert.strictEqual(col(h, rowA, "supply_type"), "fixed");
assert.strictEqual(Number(col(h, rowA, "daily_litres")), 2);
assert.strictEqual(col(h, rowA, "billing_cycle"), "monthly");
assert.strictEqual(dayOf(col(h, rowA, "cycle_start_date")), "02");
assert.strictEqual(col(h, rowT, "supply_type"), "flexible");
assert.strictEqual(col(h, rowT, "daily_litres"), "");
assert.ok(/typical 50 L\/day/i.test(String(col(h, rowT, "notes"))));
assert.strictEqual(col(h, rowB, "supply_type"), "flexible");
assert.strictEqual(col(h, rowB, "daily_litres"), "");
assert.ok(col(h, rowA, "rate_pkr") === "" || col(h, rowA, "rate_pkr") == null);

await live.upsertFarmer({
  phone: farmerPhone,
  onboardingState: "complete",
  sheetId: made.sheetId,
  allowed: true,
});
await processPayload(live, wa("wamid.supply.edit", farmerPhone, "Aslam ab fixed 1.5 liter"));
out = lastText();
assert.ok(/1\.5/.test(out), out);
await processPayload(live, wa("wamid.supply.edit.haan", farmerPhone, "Haan"));
const afterEdit = live.ledgerFor({ sender: farmerPhone, sheetId: made.sheetId });
const aslamNow = afterEdit.Customers.find((r, i) => i > 0 && r[0] === "Aslam");
assert.strictEqual(col(afterEdit.Customers[0], aslamNow, "supply_type"), "fixed");
assert.strictEqual(Number(col(afterEdit.Customers[0], aslamNow, "daily_litres")), 1.5);
assert.strictEqual(col(afterEdit.Customers[0], aslamNow, "billing_cycle"), "monthly");
assert.strictEqual(dayOf(col(afterEdit.Customers[0], aslamNow, "cycle_start_date")), "02");

await processPayload(live, wa("wamid.supply.ask", farmerPhone, "Aslam rozana kitna leta hai?"));
out = lastText();
assert.ok(/1\.5/.test(out) && /Aslam/.test(out), out);

console.log("test-supply ok");
}

main().catch((err) => {
  console.error("test-supply FAILED", err);
  process.exit(1);
});
