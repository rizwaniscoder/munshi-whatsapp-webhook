process.env.MASTER_PHONE = "923155506704";
process.env.ALLOWED_NUMBERS = "";
process.env.WHATSAPP_DRY_RUN = "1";
process.env.REPLY_SCRIPT = "roman";
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SHEETS_WEBHOOK_URL;

const assert = require("assert");
const { MASTER_PHONE, isMasterPhone, SHEET_ID } = require("../lib/config");
const { MemorySheets, emptyLedger } = require("../lib/sheets");
const { processPayload } = require("../lib/bot");
const { takeOutbound } = require("../lib/whatsapp");

const DELETED = "923155506704";

function waPayload(id, from, text) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "WABA_TEST",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          contacts: [{ profile: { name: "Old" }, wa_id: from }],
          messages: [{
            from,
            id,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: "text",
            text: { body: text },
          }],
        },
      }],
    }],
  };
}

async function main() {
  assert.strictEqual(MASTER_PHONE, DELETED);
  assert.strictEqual(isMasterPhone(DELETED), true);
  assert.strictEqual(isMasterPhone("923205506704"), false);

  const sheets = new MemorySheets();
  sheets.ledgers.default = emptyLedger();
  sheets.ledgers.default.Milk_Log.push(["2026-11-11", "am", "Gori", 18, "old"]);
  sheets.ledgers[SHEET_ID] = sheets.ledgers.default;

  await processPayload(sheets, waPayload("wamid.deleted.1", DELETED, "salam"));
  const text = takeOutbound().map((send) => send.text?.body || send.interactive?.body?.text || "").join("\n");
  assert.ok(/invite|Rizwan/i.test(text), text);
  assert.strictEqual((await sheets.getFarmer(DELETED)).farmer, null);
  let blocked = false;
  try {
    await sheets.getContext({ sender: DELETED });
  } catch (err) {
    blocked = /tayyar nahi|available nahi/.test(err.message);
  }
  assert.strictEqual(blocked, true);
  assert.strictEqual(sheets.ledgers.default.Milk_Log[1][3], 18);
  assert.strictEqual(sheets.Farmers.length, 1);

  console.log("test-master-phone ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
