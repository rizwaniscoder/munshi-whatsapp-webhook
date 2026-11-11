process.env.WHATSAPP_DRY_RUN = "1";
delete process.env.SHEETS_WEBHOOK_URL;
delete process.env.SHEETS_SECRET;
process.env.MUNSHI_SHEETS_FILE = "/tmp/munshi-stage1-ledger.json";
process.env.ALLOWED_NUMBERS = "";
process.env.TZ = "Asia/Karachi";

const fs = require("fs");
const { MemorySheets } = require("../lib/sheets");
const { takeOutbound } = require("../lib/whatsapp");
const { processPayload } = require("../lib/bot");
const { SHEET_ID } = require("../lib/config");
const { needsOnboarding, hasPrefillProfile } = require("../lib/onboarding");
const { isEditText } = require("../lib/ledger");

function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok:", msg);
}

function waPayload(id, from, text, buttonId) {
  const message = buttonId
    ? {
        from,
        id,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: "interactive",
        interactive: { button_reply: { id: buttonId, title: buttonId === "confirm_edit" ? "Edit / Tabdeeli" : buttonId } },
      }
    : {
        from,
        id,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: "text",
        text: { body: text },
      };
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
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

function lastText() {
  const sends = takeOutbound();
  const texts = sends
    .map((s) => {
      if (s.type === "text") return s.text?.body || "";
      if (s.type === "interactive") return s.interactive?.body?.text || "";
      return "";
    })
    .filter(Boolean);
  const last = sends[sends.length - 1];
  const buttonIds = last?.interactive?.action?.buttons?.map((b) => b.reply?.id) || [];
  return { sends, text: texts.join("\n---\n"), buttonIds, last };
}

async function main() {
  fs.rmSync(process.env.MUNSHI_SHEETS_FILE, { force: true });
  const sheets = new MemorySheets(process.env.MUNSHI_SHEETS_FILE);
  const masterPhone = "923155506704";
  const noman = "923205506704";

  if (!sheets.ledgers.default) sheets.ledgers.default = require("../lib/sheets").emptyLedger();
  sheets.ledgers.default.Milk_Log.push(["2026-11-11", "am", "Gori", 18, "WhatsApp " + masterPhone]);
  await sheets.upsertFarmer({
    phone: masterPhone,
    sheetId: SHEET_ID,
    farmName: "Dairy Farm",
    allowed: true,
    onboardingState: "complete",
  });
  sheets.ledgers[SHEET_ID] = sheets.ledgers.default;

  // exact live registry row
  sheets.Farmers.push([noman, "", "Noman Mughal", "Naab Dairy", "", "TRUE", "2026-11-11"]);
  sheets.persist();

  const farmer = (await sheets.getFarmer(noman)).farmer;
  assert(farmer && farmer.name === "Noman Mughal", "registry row loaded");
  assert(farmer.allowed === true, "TRUE allowed flag parsed");
  assert(needsOnboarding(farmer, noman), "blank state + no sheet needs onboarding");
  assert(hasPrefillProfile(farmer), "prefill name/farm present");
  assert((await sheets.getFarmer("+92 320 5506704")).farmer?.name === "Noman Mughal", "phone with + and spaces matches");

  let threw = false;
  try {
    await sheets.getContext({ sender: noman });
  } catch (err) {
    threw = /tayyar nahi|available nahi/.test(err.message);
  }
  assert(threw, "Noman cannot read the default ledger");

  await processPayload(sheets, waPayload("wamid.noman.salam", noman, "SALAM"));
  let out = lastText();
  assert(
    out.text.includes("Noman Mughal") && out.text.includes("Naab Dairy") && out.text.includes("Haan"),
    "SALAM asks to confirm prefilled profile: " + out.text
  );
  assert(
    out.buttonIds.includes("confirm_yes") &&
      out.buttonIds.includes("confirm_no") &&
      out.buttonIds.includes("confirm_edit"),
    "confirmation has Haan, Nahi, and Edit buttons: " + out.buttonIds.join(",")
  );
  assert(
    sheets.ledgers.default.Milk_Log.slice(1).length === 1 &&
      sheets.ledgers.default.Milk_Log[1][3] === 18,
    "main ledger milk unchanged after SALAM"
  );
  const pending = (await sheets.getPending(noman)).pending;
  assert(pending && pending.entries[0].type === "profile", "profile pending for Noman");
  assert(
    !sheets.masterPending.some((r) => r[0] === noman && String(r[3] || "").includes("milk")),
    "no milk pending for Noman on master"
  );

  // Edit path: change farm name
  await processPayload(sheets, waPayload("wamid.noman.edit", noman, "", "confirm_edit"));
  out = lastText();
  assert(/kya tabdeeli/i.test(out.text), "Edit asks what to change: " + out.text);

  await processPayload(sheets, waPayload("wamid.noman.edittext", noman, "farm ka naam Naab Dairy Farm hai"));
  out = lastText();
  assert(
    out.text.includes("Naab Dairy Farm") && out.buttonIds.includes("confirm_yes"),
    "edit applied and re-confirmation shown: " + out.text
  );

  await processPayload(sheets, waPayload("wamid.noman.haan", noman, "Haan"));
  out = lastText();
  const after = (await sheets.getFarmer(noman)).farmer;
  assert(after.sheetId && after.sheetId !== SHEET_ID, "copyLedger created a new sheet, not the main ledger");
  assert(after.onboardingState === "pending_animals", "state is pending_animals after profile confirm");
  assert(/janwar|gayen|bhains/i.test(out.text), "asks for animals after Haan: " + out.text);
  assert(
    sheets.ledgers.default.Milk_Log.slice(1).length === 1,
    "main ledger still has only the original milk row"
  );
  assert(!sheets.ledgers[after.sheetId].Milk_Log.slice(1).length, "Noman's new ledger has no milk rows");

  // yes flag and change_rate not needed
  assert(isEditText("Edit / Tabdeeli") && isEditText("tabdeeli"), "edit text aliases work");

  // allowed yes
  const sheets2 = new MemorySheets("");
  sheets2.Farmers.push(["923209991111", "", "Ali", "Test Farm", "", "yes", "2026-11-11"]);
  const f2 = sheets2.findFarmer("923209991111");
  assert(f2.allowed === true && needsOnboarding(f2, "923209991111"), "allowed=yes and blank state onboards");

  console.log("\nSTAGE 1 TESTS PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
