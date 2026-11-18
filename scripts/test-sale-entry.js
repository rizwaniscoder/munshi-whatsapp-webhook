const assert = require("assert");

process.env.REPLY_SCRIPT = "roman";
process.env.WHATSAPP_DRY_RUN = "1";
delete process.env.ALLOWED_NUMBERS;
delete process.env.GEMINI_API_KEY;

const { confirmationText, entryLines } = require("../lib/ledger");
const { setReplyContext, clearReplyContext } = require("../lib/reply");
const { flattenParsed, buildParsePrompt } = require("../lib/gemini");
const { deriveSaleEntries } = require("../lib/sale-money");
const { isStalePending, looksLikeFreshEntry, isCorrectionText } = require("../lib/pending-guard");
const { MemorySheets } = require("../lib/sheets");
const { fillSaleRates } = require("../lib/bot");
const { handleRecorderTurn } = require("../lib/recorder");
const { mintWebToken } = require("../lib/web-token");

function roman(fn) {
  setReplyContext({ mode: "roman" });
  try {
    return fn();
  } finally {
    clearReplyContext();
  }
}

function customersWith(name, rate) {
  return [
    ["name", "phone", "rate_pkr", "opening_balance", "current_balance", "notes", "supply_type", "daily_litres"],
    [name, "", rate, 0, 0, "", "flexible", ""],
  ];
}

const FARMER_TEXT = "subah Kali 10 litre, Tabarak Hotel ko 10 litre";

const invented = deriveSaleEntries(
  [
    { type: "milk", cow_name: "Kali", litres: 10, session: "am", date: "2026-11-18" },
    {
      type: "sale",
      customer: "Tabarak Hotel",
      litres: 10,
      rate_pkr: 180,
      session: "am",
      date: "2026-11-18",
    },
  ],
  { customers: customersWith("Tabarak Hotel", 200), text: FARMER_TEXT }
);
const sale = invented.find((entry) => entry.type === "sale");
assert.strictEqual(sale.rate_pkr, 200, "stored rate replaces an invented rate");
assert.strictEqual(sale.amount, 2000);
assert.strictEqual(sale.cash_received, 0);
assert.strictEqual(sale.balance_added, 2000);
assert.strictEqual(invented.find((entry) => entry.type === "milk").litres, 10);

const line = roman(() => entryLines([sale], "roman")[0]);
assert.ok(line.includes("Tabarak Hotel"), line);
assert.ok(line.includes("10 L"), line);
assert.ok(line.includes("Rs 2,000"), line);
assert.ok(/udhaar/i.test(line), line);
assert.ok(!/Rs 0 \(nagd\)/.test(line), line);

const stated = deriveSaleEntries(
  [{ type: "sale", customer: "Tabarak Hotel", litres: 10, rate_pkr: 200, session: "am" }],
  { customers: customersWith("Tabarak Hotel", 200), text: "Tabarak Hotel ko 10 litre rate 180" }
)[0];
assert.strictEqual(stated.rate_pkr, 180, "a rate the farmer said wins");
assert.strictEqual(stated.amount, 1800);
assert.strictEqual(stated.balance_added, 1800);

const ka = deriveSaleEntries(
  [{ type: "sale", customer: "Tabarak Hotel", litres: 10, rate_pkr: 200, session: "am" }],
  { customers: customersWith("Tabarak Hotel", 200), text: "Tabarak Hotel ko 10 litre 180 ka" }
)[0];
assert.strictEqual(ka.rate_pkr, 180);
assert.strictEqual(ka.amount, 1800);

const nagd = deriveSaleEntries(
  [{ type: "sale", customer: "Tabarak Hotel", litres: 10, rate_pkr: 180, session: "am" }],
  { customers: customersWith("Tabarak Hotel", 200), text: "Tabarak Hotel ko 10 litre nagd" }
)[0];
assert.strictEqual(nagd.rate_pkr, 200);
assert.strictEqual(nagd.amount, 2000);
assert.strictEqual(nagd.cash_received, 2000);
assert.strictEqual(nagd.balance_added, 0);
const nagdLine = roman(() => entryLines([nagd], "roman")[0]);
assert.ok(nagdLine.includes("Rs 2,000"), nagdLine);
assert.ok(/\(nagd\)/.test(nagdLine), nagdLine);
assert.ok(!/Rs 0 \(nagd\)/.test(nagdLine), nagdLine);

const partial = deriveSaleEntries(
  [{ type: "sale", customer: "Tabarak Hotel", litres: 10, session: "am" }],
  { customers: customersWith("Tabarak Hotel", 200), text: "Tabarak Hotel ko 10 litre, 500 nagd" }
)[0];
assert.strictEqual(partial.amount, 2000);
assert.strictEqual(partial.cash_received, 500);
assert.strictEqual(partial.balance_added, 1500);

const unknown = deriveSaleEntries(
  [{ type: "sale", customer: "Naya Grahak", litres: 10, rate_pkr: 180, session: "am" }],
  { customers: customersWith("Tabarak Hotel", 200), text: "Naya Grahak ko 10 litre" }
)[0];
assert.ok(!(Number(unknown.rate_pkr) > 0), "do not keep an invented rate");
assert.ok(!(Number(unknown.amount) > 0));
const missingCard = roman(() =>
  confirmationText({
    entries: [{ type: "sale", customer: "Tabarak Hotel", litres: 10, rate_pkr: 180, session: "am" }],
  })
);
assert.ok(/rate nahi pata/i.test(missingCard), missingCard);
assert.ok(!/Rs 0 \(nagd\)/.test(missingCard), missingCard);
assert.ok(!/Rs 0/.test(missingCard), missingCard);

const explicitForm = deriveSaleEntries(
  [{ type: "sale", customer: "Tabarak Hotel", litres: 10, rate_pkr: 190, rate_explicit: true, pay_mode: "nagd" }],
  { customers: customersWith("Tabarak Hotel", 200), text: "" }
)[0];
assert.strictEqual(explicitForm.rate_pkr, 190);
assert.strictEqual(explicitForm.amount, 1900);
assert.strictEqual(explicitForm.cash_received, 1900);
assert.strictEqual(explicitForm.balance_added, 0);

assert.strictEqual(looksLikeFreshEntry(FARMER_TEXT), true);
assert.strictEqual(looksLikeFreshEntry("aaj 500 mazdoori"), true);
assert.strictEqual(isCorrectionText("18 nahi 20 litre"), true);
assert.strictEqual(looksLikeFreshEntry("18 nahi 20 litre"), false);
assert.strictEqual(looksLikeFreshEntry("farm ka naam Naab Dairy Farm hai"), false);

function karachiIso(ms) {
  return new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Karachi" }).replace(" ", "T");
}
assert.strictEqual(
  isStalePending({ status: "editing", created_at: karachiIso(Date.now() - 31 * 60 * 1000) }),
  true
);
assert.strictEqual(
  isStalePending({ status: "awaiting", created_at: karachiIso(Date.now() - 31 * 60 * 1000) }),
  true
);
assert.strictEqual(
  isStalePending({ status: "pending", created_at: karachiIso(Date.now() - 5 * 60 * 1000) }),
  false
);
assert.strictEqual(
  isStalePending({ status: "saved", created_at: "2020-01-01T00:00:00" }),
  false
);

const heard = flattenParsed(
  {
    intent: "record",
    language: "roman_urdu",
    transcript: "subah Kali 10 litre, Tabarak Hotel ko 10 litre",
    milk: [{ date: "2026-11-18", cow_name: "Kali", litres: 10, session: "am" }],
    sales: [{ date: "2026-11-18", customer: "Tabarak Hotel", litres: 10, session: "am", rate_pkr: 180 }],
  },
  ""
);
assert.strictEqual(heard.transcript, FARMER_TEXT);
assert.strictEqual(heard.entries.find((entry) => entry.type === "sale").rate_pkr, 180, "flatten keeps the model field; code fills the rate later");

const fromText = flattenParsed(
  { intent: "record", language: "roman_urdu", milk: [{ date: "2026-11-18", cow_name: "Kali", litres: 10 }] },
  "subah Kali 10 litre"
);
assert.strictEqual(fromText.transcript, "subah Kali 10 litre");

const prompt = buildParsePrompt({
  cows: ["Kali"],
  customers: ["Tabarak Hotel"],
  customer_roster: ["Tabarak Hotel @ Rs 200/L, flexible"],
  customer_supply: ["Tabarak Hotel flexible"],
});
assert.ok(prompt.includes("Kali"), prompt);
assert.ok(prompt.includes("Tabarak Hotel @ Rs 200/L"), prompt);
assert.ok(/omit rate_pkr/i.test(prompt), prompt);
assert.ok(!/you may use it/i.test(prompt), prompt);
assert.ok(/transcript/i.test(prompt), prompt);
assert.ok(/roman urdu/i.test(prompt), prompt);
const configSrc = require("fs").readFileSync(require("path").join(__dirname, "../lib/config.js"), "utf8");
assert.ok(configSrc.includes('optionalEnv("GEMINI_MODEL", "gemini-3.5-flash-lite")'), "do not switch the Gemini model");

async function seed(phone) {
  const sheets = new MemorySheets();
  const copy = await sheets.copyLedger({
    phone,
    name: "Ali",
    farmName: "Al Noor Dairy",
    allowed: true,
    onboardingState: "complete",
  });
  await sheets.commitRecords({
    sender: phone,
    sheetId: copy.sheetId,
    entries: [
      { type: "add_cow", cow_name: "Kali", animal_type: "cow" },
      {
        type: "add_customer",
        customer: "Tabarak Hotel",
        rate_pkr: 200,
        opening_balance: 0,
        supply_type: "flexible",
        supply_note: "typical 50 L/day",
      },
    ],
  });
  const token = mintWebToken();
  await sheets.setWebToken(phone, token);
  return { sheets, token, sheetId: copy.sheetId, phone };
}

async function main() {
  const phone = "923111222555";
  const farm = await seed(phone);
  const ctx = await farm.sheets.getContext({ sender: phone, sheetId: farm.sheetId });
  assert.ok(ctx.cows.includes("Kali"), JSON.stringify(ctx.cows));
  assert.ok(
    (ctx.customer_roster || []).some((line) => line.includes("Tabarak Hotel @ Rs 200/L")),
    JSON.stringify(ctx.customer_roster)
  );
  assert.ok(
    (ctx.customer_roster || []).some((line) => /flexible/i.test(line) && /50/.test(line)),
    JSON.stringify(ctx.customer_roster)
  );
  assert.ok((ctx.customers || []).includes("Tabarak Hotel"));

  const filled = await fillSaleRates(
    farm.sheets,
    { sheetId: farm.sheetId },
    phone,
    [{ type: "sale", customer: "Tabarak Hotel", litres: 10, rate_pkr: 180, session: "am" }],
    FARMER_TEXT
  );
  assert.strictEqual(filled[0].rate_pkr, 200);
  assert.strictEqual(filled[0].amount, 2000);
  assert.strictEqual(filled[0].cash_received, 0);
  assert.strictEqual(filled[0].balance_added, 2000);

  const logs = [];
  const orig = console.log;
  console.log = (...args) => {
    logs.push(args.map((part) => String(part)).join(" "));
    orig(...args);
  };
  let draft;
  try {
    draft = await handleRecorderTurn(farm.sheets, { token: farm.token, text: "aaj 500 mazdoori" });
  } finally {
    console.log = orig;
  }
  assert.strictEqual(draft.replies[0].kind, "confirm");
  assert.strictEqual(draft.replies[0].transcript, "aaj 500 mazdoori");
  assert.ok(logs.some((row) => row.startsWith("heard ") && row.includes("aaj 500 mazdoori")));
  assert.ok(!logs.some((row) => /eyJ|sk-|supabase|service_role|\/r\//i.test(row)));
  assert.ok((draft.replies[0].entries || []).some((entry) => entry.type === "expense"));

  const opened = await handleRecorderTurn(farm.sheets, { token: farm.token, action: "confirm_edit" });
  const openedText = opened.replies.map((reply) => reply.text || "").join("\n");
  assert.ok(!/kya tabdeeli/i.test(openedText), openedText);
  assert.ok(opened.replies.some((reply) => reply.kind === "edit" && reply.entries.length));
  assert.ok(/save|record/i.test(openedText), openedText);
  assert.notStrictEqual((await farm.sheets.getPending(phone)).pending.status, "editing");

  const savedEdit = await handleRecorderTurn(farm.sheets, {
    token: farm.token,
    action: "save_edit",
    entries: [{ index: 0, type: "expense", amount: 650 }],
  });
  const savedEditText = savedEdit.replies.map((reply) => reply.text || "").join("\n");
  assert.ok(/650/.test(savedEditText), savedEditText);
  assert.strictEqual((await farm.sheets.getPending(phone)).pending.entries[0].amount, 650);
  assert.strictEqual(farm.sheets.ledgers[farm.sheetId].Expenses.slice(1).length, 0);

  await farm.sheets.clearPending(phone, "cancelled");
  await farm.sheets.setPending({
    sender: phone,
    language: "roman_urdu|editing",
    status: "editing",
    entries: [{ type: "sale", customer: "Tabarak Hotel", litres: 4, rate_pkr: 200, amount: 800, cash_received: 0, balance_added: 800, session: "am" }],
    messageId: "old-edit",
  });
  const swallowed = await handleRecorderTurn(farm.sheets, { token: farm.token, text: FARMER_TEXT });
  const swallowedText = swallowed.replies.map((reply) => reply.text || "").join("\n");
  assert.ok(/pending khula/i.test(swallowedText), swallowedText);
  assert.ok(swallowed.replies.some((reply) => (reply.actions || []).some((action) => action.id === "confirm_no")));
  assert.strictEqual((await farm.sheets.getPending(phone)).pending.entries[0].litres, 4);
  assert.ok(!/tabdeeli samajh nahi/i.test(swallowedText), swallowedText);

  const audio = Buffer.alloc(280);
  audio.write("OggS");
  const voiced = await handleRecorderTurn(farm.sheets, {
    token: farm.token,
    audio: { buffer: audio, mimeType: "audio/ogg" },
  });
  const voicedText = voiced.replies.map((reply) => reply.text || "").join("\n");
  assert.ok(/pending khula/i.test(voicedText), voicedText);
  assert.strictEqual((await farm.sheets.getPending(phone)).pending.entries[0].customer, "Tabarak Hotel");

  const rows = farm.sheets.masterPending;
  rows[rows.length - 1][1] = "2020-01-01T00:00:00";
  const fresh = await handleRecorderTurn(farm.sheets, { token: farm.token, text: "aaj 500 mazdoori" });
  const freshText = fresh.replies.map((reply) => reply.text || "").join("\n");
  assert.ok(/mazdoori/i.test(freshText), freshText);
  assert.ok(/Rs 500/.test(freshText), freshText);
  assert.ok(!/pending khula/i.test(freshText), freshText);
  assert.strictEqual((await farm.sheets.getPending(phone)).pending.entries[0].type, "expense");

  const page = require("fs").readFileSync(require("path").join(__dirname, "../pages/recorder.html"), "utf8");
  assert.ok(page.includes("Maine yeh suna:"));
  assert.ok(page.includes("Dobara record karein"));
  assert.ok(page.includes("save_edit"));
  assert.ok(!page.includes("Kya tabdeeli karni hai?"));

  console.log("test-sale-entry ok");
}

main().catch((err) => {
  console.error("test-sale-entry FAILED", err);
  process.exit(1);
});
