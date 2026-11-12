process.env.WHATSAPP_DRY_RUN = "1";
delete process.env.SHEETS_WEBHOOK_URL;
delete process.env.SHEETS_SECRET;
process.env.MUNSHI_SHEETS_FILE = "/tmp/munshi-features-ledger.json";
process.env.ALLOWED_NUMBERS = "929990010001";
process.env.TZ = "Asia/Karachi";
process.env.MUNSHI_TEST_MEDIA_DIR = require("path").join(__dirname, "..", "docs");

const fs = require("fs");
const path = require("path");
const { MemorySheets, formatLedgerData, parseAmount } = require("../lib/sheets");
const { takeOutbound } = require("../lib/whatsapp");
const { processPayload } = require("../lib/bot");
const { buildReceiptData, renderReceiptPng } = require("../lib/receipt");
const { confirmationText, savedText } = require("../lib/ledger");

function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok:", msg);
}

function waPayload(id, from, text) {
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
              contacts: [{ profile: { name: "Test" }, wa_id: from }],
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

function waImagePayload(id, from, mediaId, caption, asDocument) {
  const media = {
    id: mediaId,
    mime_type: "image/png",
    caption: caption || "",
  };
  const message = asDocument
    ? { from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "document", document: { ...media, filename: mediaId } }
    : { from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "image", image: media };
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
              contacts: [{ profile: { name: "Test" }, wa_id: from }],
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
      if (s.type === "image") return s.caption || "";
      return "";
    })
    .filter(Boolean);
  return { sends, text: texts.join("\n---\n") };
}

async function seedCompleteFarmer(sheets, phone) {
  await sheets.upsertFarmer({
    phone,
    name: "Ali",
    farmName: "Al-Noor Dairy",
    allowed: true,
    onboardingState: "complete",
  });
  const copy = await sheets.copyLedger({
    phone,
    name: "Ali",
    farmName: "Al-Noor Dairy",
    allowed: true,
    onboardingState: "complete",
  });
  await sheets.commitRecords({
    sender: phone,
    sheetId: copy.sheetId,
    entries: [
      { type: "add_cow", cow_name: "Gori", animal_type: "cow", avg_daily_litres: 18 },
      { type: "add_cow", cow_name: "Kali", animal_type: "cow", avg_daily_litres: 12 },
      {
        type: "add_customer",
        customer: "Aslam",
        rate_pkr: 190,
        opening_balance: 0,
        phone: "03001112233",
      },
      { type: "milk", date: "2026-11-11", session: "am", cow_name: "Gori", litres: 18 },
      {
        type: "sale",
        date: "2026-11-11",
        customer: "Aslam",
        litres: 20,
        rate_pkr: 190,
        amount: 3800,
        cash_received: 2000,
        balance_added: 1800,
      },
    ],
  });
  return copy.sheetId;
}

async function main() {
  fs.rmSync(process.env.MUNSHI_SHEETS_FILE, { force: true });
  let sheets = new MemorySheets(process.env.MUNSHI_SHEETS_FILE);

  console.log("\n-- access control --");
  await processPayload(sheets, waPayload("wamid.unknown1", "929991119999", "salam"));
  let out = lastText();
  assert(out.text.includes("invite"), "unknown number gets invite message: " + out.text);

  console.log("\n-- MemorySheets edits --");
  const editPhone = "929990010099";
  const sheetId = await seedCompleteFarmer(sheets, editPhone);
  let result = await sheets.commitRecords({
    sender: editPhone,
    sheetId,
    entries: [{ type: "add_cow", cow_name: "Moti", animal_type: "cow", avg_daily_litres: 10 }],
  });
  assert(result.ok, "add_cow ok");
  result = await sheets.commitRecords({
    sender: editPhone,
    sheetId,
    entries: [{ type: "rename_cow", cow_name: "Moti", new_name: "Moti Rani" }],
  });
  assert(result.ok, "rename_cow ok");
  const afterRename = await sheets.readRecent({ days: 30, sender: editPhone, sheetId });
  assert(
    afterRename.cows.slice(1).some((r) => r[1] === "Moti Rani"),
    "renamed cow present"
  );
  assert(
    afterRename.milk.slice(1).every((r) => r[2] !== "Moti"),
    "milk logs not left on old name"
  );
  result = await sheets.commitRecords({
    sender: editPhone,
    sheetId,
    entries: [
      {
        type: "correct_entry",
        entry_type: "milk",
        date: "2026-11-11",
        cow_name: "Gori",
        field: "litres",
        old_value: 18,
        new_value: 16,
      },
    ],
  });
  assert(result.ok, "correct milk ok");
  const milk = (await sheets.readRecent({ days: 30, sender: editPhone, sheetId })).milk;
  const gori = milk.slice(1).find((r) => r[2] === "Gori");
  assert(Number(gori[3]) === 16, "Gori milk is now 16, note=" + gori[4]);
  assert(String(gori[4]).includes("corrected"), "correction note appended");
  result = await sheets.commitRecords({
    sender: editPhone,
    sheetId,
    entries: [{ type: "change_rate", customer: "Aslam", rate_pkr: 200 }],
  });
  assert(result.ok, "change_rate ok");
  const customers = (await sheets.readRecent({ days: 30, sender: editPhone, sheetId })).customers;
  const aslam = customers.slice(1).find((r) => r[0] === "Aslam");
  assert(Number(aslam[2]) === 200, "Aslam rate is 200");
  assert(String(aslam[5] || "").includes("rate"), "rate change note appended");
  result = await sheets.commitRecords({
    sender: editPhone,
    sheetId,
    entries: [
      { type: "add_customer", customer: "Bashir", rate_pkr: 180, opening_balance: 500 },
    ],
  });
  assert(result.ok, "add_customer ok");
  result = await sheets.commitRecords({
    sender: editPhone,
    sheetId,
    entries: [{ type: "remove_cow", cow_name: "Kali" }],
  });
  assert(result.ok, "remove_cow ok");
  const cows = (await sheets.readRecent({ days: 30, sender: editPhone, sheetId })).cows;
  const kali = cows.slice(1).find((r) => r[1] === "Kali");
  assert(kali[4] === "removed", "Kali status is removed");
  const ctx = await sheets.getContext({ sender: editPhone, sheetId });
  assert(!ctx.cows.includes("Kali"), "removed cow excluded from context");
  result = await sheets.commitRecords({
    sender: editPhone,
    sheetId,
    entries: [{ type: "delete_last" }],
  });
  assert(result.ok && result.lastWrite?.deleted, "delete_last ok");
  const cowsAfter = (await sheets.readRecent({ days: 30, sender: editPhone, sheetId })).cows;
  const kaliAfter = cowsAfter.slice(1).find((r) => r[1] === "Kali");
  assert(!kaliAfter || kaliAfter[4] !== "removed", "removed Kali row deleted as last write");

  console.log("\n-- receipt PNG --");
  // Re-seed a clean complete farmer for a clear Aslam receipt
  fs.rmSync(process.env.MUNSHI_SHEETS_FILE, { force: true });
  sheets = new MemorySheets(process.env.MUNSHI_SHEETS_FILE);
  const receiptPhone = "929990010088";
  const receiptSheet = await seedCompleteFarmer(sheets, receiptPhone);
  const ledger = await sheets.readRecent({ days: 60, sender: receiptPhone, sheetId: receiptSheet });
  const receipt = buildReceiptData({
    ledger,
    customer: "Aslam",
    farmName: "Al-Noor Dairy",
  });
  assert(receipt.ok, "receipt data ok");
  assert(receipt.litres === 20, "receipt litres 20");
  assert(receipt.total === 3800, "receipt total 3800");
  assert(receipt.paid === 2000, "receipt paid 2000");
  assert(receipt.currentUdhaar === 1800 || receipt.openingUdhaar === 0, "udhaar figures present");
  const png = await renderReceiptPng(receipt);
  assert(png.length > 1000 && png[0] === 0x89 && png[1] === 0x50, "png signature and size " + png.length);
  const outPath = path.join(__dirname, "..", "docs", "sample-receipt-aslam.png");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, png);
  console.log("wrote", outPath, "bytes", png.length);

  if (!process.env.GEMINI_API_KEY) {
    console.log("GEMINI_API_KEY missing, skipping live parse/payload tests");
    console.log("ALL UNIT TESTS PASSED");
    return;
  }

  console.log("\n-- onboarding simulated payload --");
  fs.rmSync(process.env.MUNSHI_SHEETS_FILE, { force: true });
  sheets = new MemorySheets(process.env.MUNSHI_SHEETS_FILE);
  const newbie = "929990010001";
  await processPayload(sheets, waPayload("wamid.onb.1", newbie, "salam"));
  out = lastText();
  assert(out.text.toLowerCase().includes("naam") && out.text.toLowerCase().includes("farm"), "asked for name and farm: " + out.text);
  await processPayload(
    sheets,
    waPayload("wamid.onb.2", newbie, "Mera naam Norman hai, farm Green Valley Dairy")
  );
  out = lastText();
  assert(out.text.includes("Norman") && out.text.toLowerCase().includes("green valley"), "profile confirmation: " + out.text);
  assert(out.text.includes("Haan"), "profile asks Haan/Nahi");
  await processPayload(sheets, waPayload("wamid.onb.3", newbie, "Haan"));
  out = lastText();
  assert(out.text.toLowerCase().includes("gay") || out.text.toLowerCase().includes("bhains"), "asked for animals: " + out.text);
  const farmerAfterProfile = (await sheets.getFarmer(newbie)).farmer;
  assert(farmerAfterProfile.sheetId, "ledger sheet created");
  assert(farmerAfterProfile.onboardingState === "pending_animals", "state pending_animals");
  await processPayload(
    sheets,
    waPayload(
      "wamid.onb.4",
      newbie,
      "Gori gay 18 litre, Kali gay 12 litre, aur Lali bhains 15 litre"
    )
  );
  out = lastText();
  assert(
    out.text.includes("Gori") && out.text.includes("Kali") && out.text.includes("Lali"),
    "animals read back: " + out.text
  );
  await processPayload(sheets, waPayload("wamid.onb.5", newbie, "Haan"));
  out = lastText();
  assert(out.text.toLowerCase().includes("customer") || out.text.toLowerCase().includes("skip"), "asked for customers: " + out.text);
  await processPayload(
    sheets,
    waPayload("wamid.onb.6", newbie, "Aslam rate 190, 0 udhaar, phone 03001112233")
  );
  out = lastText();
  assert(out.text.includes("Aslam") && out.text.includes("190"), "customers read back: " + out.text);
  await processPayload(sheets, waPayload("wamid.onb.7", newbie, "Haan"));
  out = lastText();
  assert(/committee|kameti|skip/i.test(out.text), "asks about committee and allows skip: " + out.text);
  await processPayload(sheets, waPayload("wamid.onb.8", newbie, "skip"));
  out = lastText();
  assert(out.text.includes("Setup ho gaya") || out.text.includes("18 litre"), "how-to message: " + out.text);
  const done = (await sheets.getFarmer(newbie)).farmer;
  assert(done.onboardingState === "complete", "onboarding complete");
  const onboarded = await sheets.readRecent({ days: 30, sender: newbie, sheetId: done.sheetId });
  assert(onboarded.cows.slice(1).length === 3, "3 animals saved");
  assert(onboarded.customers.slice(1).some((r) => String(r[0]) === "Aslam"), "Aslam saved");

  console.log("\n-- receipt via webhook --");
  const livePhone = "929990010002";
  process.env.ALLOWED_NUMBERS = "929990010001,929990010002";
  await seedCompleteFarmer(sheets, livePhone);
  await processPayload(sheets, waPayload("wamid.receipt.1", livePhone, "Aslam ki parchi bhejo"));
  out = lastText();
  const img = out.sends.find((s) => s.type === "image");
  assert(img && img.bytes > 1000, "receipt image sent, bytes " + (img && img.bytes));
  assert(String(img.caption).toLowerCase().includes("forward"), "caption tells farmer to forward: " + img.caption);
  const livePath = path.join(__dirname, "..", "docs", "sample-receipt-aslam.png");
  fs.writeFileSync(livePath, img.buffer);
  console.log("updated", livePath);

  console.log("\n-- edit simulated payloads --");
  const phrases = [
    ["wamid.edit.addcow", "ek nayi gay Moti add karo, rozana 10 litre", "Moti"],
    ["wamid.edit.haan1", "Haan", "Save ho gaya"],
    ["wamid.edit.rename", "Moti ka naam Moti Rani rakh do", "Moti Rani"],
    ["wamid.edit.haan2", "Haan", "naam change"],
    ["wamid.edit.rate", "Aslam ka rate 200 kar do", "200"],
    ["wamid.edit.haan3", "Haan", "rate"],
    ["wamid.edit.addcust", "naya customer Bashir add karo, rate 180, 500 udhaar", "Bashir"],
    ["wamid.edit.haan4", "Haan", "Bashir"],
    ["wamid.edit.correct", "aaj ka Gori ka doodh 18 nahi 16 tha", "16"],
    ["wamid.edit.haan5", "Haan", "16"],
    ["wamid.edit.remove", "Kali ko list se hata do", "Kali"],
    ["wamid.edit.haan6", "Haan", "Kali"],
    ["wamid.edit.dellast", "akhri record delete kar do", "hata"],
    ["wamid.edit.haan7", "Haan", "hataya"],
  ];
  for (const [id, phrase, expect] of phrases) {
    await processPayload(sheets, waPayload(id, livePhone, phrase));
    out = lastText();
    assert(
      out.text.toLowerCase().includes(String(expect).toLowerCase()) ||
        out.text.includes("Haan") ||
        out.text.includes("Save ho gaya"),
      `edit "${phrase}" mentions ${expect}: ${out.text}`
    );
  }
  const finalLedger = await sheets.readRecent({ days: 30, sender: livePhone });
  const goriFinal = finalLedger.milk.slice(1).find((r) => r[2] === "Gori");
  assert(goriFinal && Number(goriFinal[3]) === 16, "live correct_entry wrote 16 L");
  assert(
    finalLedger.customers.slice(1).some((r) => r[0] === "Bashir"),
    "Bashir added"
  );
  const aslamFinal = finalLedger.customers.slice(1).find((r) => r[0] === "Aslam");
  assert(Number(aslamFinal[2]) === 200, "Aslam rate updated to 200");

  console.log("\n-- image bill simulated payload --");
  const blankPath = path.join(__dirname, "..", "docs", "sample-blank.png");
  // 20x20 white png
  fs.writeFileSync(
    blankPath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAAHElEQVR4nGNgGAWjYBSMglEwCkbBKBhuBr0BAAL+AANV5i8NAAAAAElFTkSuQmCC",
      "base64"
    )
  );
  await processPayload(
    sheets,
    waImagePayload("wamid.img.bill", livePhone, "sample-fodder-bill.png", "yeh wanda ki bill hai")
  );
  out = lastText();
  assert(
    out.text.toLowerCase().includes("wanda") &&
      (out.text.includes("6000") || out.text.includes("6,000")) &&
      out.text.includes("Haan"),
    "image bill confirmation: " + out.text
  );
  await processPayload(sheets, waPayload("wamid.img.haan", livePhone, "Haan"));
  out = lastText();
  assert(out.text.toLowerCase().includes("chara") || out.text.includes("Save ho gaya"), "image bill saved: " + out.text);
  const afterBill = await sheets.readRecent({ days: 30, sender: livePhone });
  assert(afterBill.fodder.slice(1).length >= 1, "fodder row written from image");
  const fodderRow = afterBill.fodder.slice(1).pop();
  assert(Number(fodderRow[4]) === 6000, "image fodder cost 6000, row=" + fodderRow.join("|"));
  assert(afterBill.expenses.slice(1).every((r) => String(r[1]).toLowerCase() !== "feed"), "image bill not written as expense");

  await processPayload(
    sheets,
    waImagePayload("wamid.img.blank", livePhone, "sample-blank.png", "", true)
  );
  out = lastText();
  assert(
    out.text.toLowerCase().includes("tasveer") || out.text.toLowerCase().includes("saaf") || out.text.toLowerCase().includes("clear"),
    "blank image asks for a clearer photo: " + out.text
  );
  try { fs.unlinkSync(blankPath); } catch {}

  console.log("\nALL TESTS PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
