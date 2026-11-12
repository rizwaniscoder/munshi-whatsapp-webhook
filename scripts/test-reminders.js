const assert = require("assert");
const { MemorySheets, emptyLedger } = require("../lib/sheets");
const { runReminderJob } = require("../lib/reminder-job");
const {
  findGaps,
  formatGapMessage,
  evaluateSlot,
  inboundIsFresh,
  issuesFor,
} = require("../lib/gaps");
const { authorizedCron, cronConfigured } = require("../lib/cron-auth");
const { reminderFooter } = require("../lib/reminders");

const DATE = "2026-11-12";
const PHONE = "923001110001";
const MORNING = new Date("2026-11-12T05:30:00.000Z");
const EVENING = new Date("2026-11-12T14:30:00.000Z");
const FRESH = new Date("2026-11-12T04:00:00.000Z").toISOString();
const STALE = new Date("2026-11-11T04:00:00.000Z").toISOString();

function recorder() {
  const sent = [];
  return {
    sent,
    async send(to, body) {
      sent.push({ to, body });
      return { ok: true };
    },
  };
}

async function farm(opts = {}) {
  const sheets = opts.sheets || new MemorySheets();
  const phone = opts.phone || PHONE;
  const copy = await sheets.copyLedger({
    phone,
    name: opts.name || "Ali",
    farmName: "Test Dairy",
    allowed: opts.allowed !== false,
    onboardingState: opts.onboardingState || "complete",
  });
  const ledger = sheets.ledgers[copy.sheetId];
  const cows = opts.cows || [
    { name: "Gori", status: "milking" },
    { name: "Kali", status: "milking" },
  ];
  cows.forEach((c, i) => {
    ledger.Cows.push([
      `C-${i + 1}`,
      c.name,
      c.type || "cow",
      "",
      c.status == null ? "milking" : c.status,
      "",
      "",
      "",
      c.pregnancy || "",
    ]);
  });
  for (const m of opts.milk || []) {
    ledger.Milk_Log.push([m.date || DATE, m.session, m.cow, m.litres, m.note || ""]);
  }
  for (const s of opts.sales || []) {
    const litres = s.litres;
    ledger.Sales.push([
      s.date || DATE,
      s.customer || "Aslam",
      litres,
      200,
      litres * 200,
      0,
      litres * 200,
      "",
    ]);
  }
  if (opts.inbound) await sheets.touchLastInbound(phone, opts.inbound);
  return { sheets, phone, sheetId: copy.sheetId, ledger };
}

function bothSessions(cows, litres = 10) {
  const milk = [];
  for (const cow of cows) {
    milk.push({ session: "am", cow, litres });
    milk.push({ session: "pm", cow, litres });
  }
  return milk;
}

(async () => {
  assert.strictEqual(evaluateSlot("morning", MORNING).ok, true);
  assert.strictEqual(evaluateSlot("morning", MORNING).slot, "morning");
  assert.strictEqual(evaluateSlot("morning", MORNING).date, DATE);
  assert.strictEqual(evaluateSlot("evening", EVENING).ok, true);
  assert.strictEqual(evaluateSlot("evening", EVENING).date, DATE);
  assert.strictEqual(evaluateSlot("evening", MORNING).ok, false, "evening is not due at 10:30 PKT");
  assert.strictEqual(
    evaluateSlot("morning", new Date("2026-11-12T04:59:00.000Z")).ok,
    false,
    "09:59 PKT is before the morning check"
  );
  assert.strictEqual(
    evaluateSlot("morning", new Date("2026-11-12T00:00:00.000Z")).ok,
    false,
    "00:00 UTC is 05:00 PKT, not 10:00"
  );
  assert.strictEqual(evaluateSlot("", EVENING).slot, "evening");
  assert.strictEqual(evaluateSlot("", MORNING).slot, "morning");

  assert.strictEqual(inboundIsFresh("", MORNING), false);
  assert.strictEqual(inboundIsFresh(null, MORNING), false);
  assert.strictEqual(inboundIsFresh(FRESH, MORNING), true);
  assert.strictEqual(inboundIsFresh(STALE, MORNING), false);
  assert.strictEqual(
    inboundIsFresh(new Date(MORNING.getTime() - 24 * 60 * 60 * 1000).toISOString(), MORNING),
    true,
    "exactly 24 hours is still inside the window"
  );
  assert.strictEqual(
    inboundIsFresh(new Date(MORNING.getTime() - 24 * 60 * 60 * 1000 - 60 * 1000).toISOString(), MORNING),
    false
  );

  const morningGaps = findGaps(
    {
      cows: [
        ["cow_id", "name", "type", "breed", "status"],
        ["C-1", "Gori", "cow", "", "milking"],
        ["C-2", "Kali", "cow", "", "milking"],
        ["C-3", "Soye", "cow", "", "dry"],
        ["C-4", "Gone", "cow", "", "removed"],
      ],
      milk: [
        ["date", "session", "cow_name", "litres"],
        [DATE, "am", "Kali", 12],
      ],
      sales: [["date", "customer", "litres"]],
    },
    DATE
  );
  assert.deepStrictEqual(morningGaps.missingBoth, ["Gori"]);
  assert.deepStrictEqual(morningGaps.missingMorningOnly, []);
  assert.ok(!morningGaps.missingBoth.includes("Soye"));
  assert.ok(!morningGaps.missingBoth.includes("Gone"));
  const morningText = formatGapMessage(morningGaps, "morning", DATE);
  assert.match(morningText, /Aaj, 12 Nov/);
  assert.match(morningText, /Subah ka doodh nahi likha/);
  assert.match(morningText, /Gori/);
  assert.doesNotMatch(morningText, /Kali/);
  assert.doesNotMatch(morningText, /Soye/);
  assert.doesNotMatch(morningText, /\bHaan\b/);
  assert.doesNotMatch(morningText, /\bNahi\b/);
  assert.match(morningText, /confirm karke likh lunga/);

  const eveningAnimal = findGaps(
    {
      cows: [
        ["name", "status", "pregnancy_status"],
        ["Gori", "milking", ""],
        ["Kali", "milking", ""],
        ["Moti", "milking", ""],
        ["Sukhi", "milking", "dry"],
      ],
      milk: [
        ["date", "session", "cow_name", "litres"],
        [DATE, "am", "Gori", 10],
        [DATE, "pm", "Gori", 8],
        [DATE, "am", "Kali", 9],
        [DATE, "subah", "Moti", 4],
      ],
      sales: [
        ["date", "customer", "litres"],
        [DATE, "Aslam", 20],
      ],
    },
    DATE
  );
  assert.deepStrictEqual(eveningAnimal.missingEvening, ["Kali", "Moti"]);
  assert.deepStrictEqual(eveningAnimal.missingBoth, []);
  assert.strictEqual(eveningAnimal.milkLitres, 31);
  assert.strictEqual(eveningAnimal.soldLitres, 20);
  assert.strictEqual(eveningAnimal.unaccountedLitres, 11);
  const eveningText = formatGapMessage(eveningAnimal, "evening", DATE);
  assert.match(eveningText, /Shaam ka doodh nahi likha/);
  assert.match(eveningText, /Kali/);
  assert.match(eveningText, /11 L ka hisab nahi bana/);
  assert.doesNotMatch(eveningText, /Sukhi/);
  assert.doesNotMatch(eveningText, /\bHaan\b/);

  const over = findGaps(
    {
      cows: [["name", "status"], ["Gori", "milking"]],
      milk: [
        ["date", "session", "cow_name", "litres"],
        [DATE, "am", "Gori", 10],
        [DATE, "shaam", "Gori", 10],
      ],
      sales: [["date", "customer", "litres"], [DATE, "Aslam", 28]],
    },
    DATE
  );
  assert.strictEqual(over.oversoldLitres, 8);
  assert.strictEqual(over.unaccountedLitres, 0);
  assert.match(formatGapMessage(over, "evening", DATE), /Sale doodh se zyada hai/);
  assert.deepStrictEqual(issuesFor(over, "morning"), []);
  assert.ok(issuesFor(over, "evening").includes("oversold_litres"));

  const balanced = findGaps(
    {
      cows: [["name", "status"], ["Gori", "milking"]],
      milk: [
        ["date", "session", "cow_name", "litres"],
        [DATE, "am", "Gori", 10],
        [DATE, "pm", "Gori", 10.02],
      ],
      sales: [["date", "customer", "litres"], [DATE, "Aslam", 20]],
    },
    DATE
  );
  assert.strictEqual(balanced.unaccountedLitres, 0, "tiny rounding is not a gap");
  assert.strictEqual(formatGapMessage(balanced, "evening", DATE), "");
  assert.strictEqual(formatGapMessage(balanced, "morning", DATE), "");

  const savedFooter = reminderFooter({
    cows: [["name", "status"], ["Gori", "milking"]],
    feed_stock: [["item", "quantity", "unit", "daily_use"], ["wanda", 1, "kg", 2]],
    sales: [["date", "customer", "litres"]],
    customers: [["name"]],
    payments: [["date", "customer", "amount"]],
  }, DATE);
  assert.match(savedFooter, /Khoraak|خوراک/);

  {
    const { sheets, ledger } = await farm({
      inbound: FRESH,
      milk: [{ session: "am", cow: "Kali", litres: 11, note: "keep-me" }],
      sales: [{ litres: 11 }],
    });
    const beforeMilk = ledger.Milk_Log.length;
    const rec = recorder();
    const result = await runReminderJob(sheets, { slot: "morning", now: MORNING, send: rec.send });
    assert.strictEqual(result.sent, 1);
    assert.strictEqual(rec.sent.length, 1);
    assert.strictEqual(rec.sent[0].to, PHONE);
    assert.match(rec.sent[0].body, /Subah ka doodh nahi likha/);
    assert.match(rec.sent[0].body, /Gori/);
    assert.doesNotMatch(rec.sent[0].body, /Kali/);
    assert.doesNotMatch(rec.sent[0].body, /hisab nahi/);
    assert.strictEqual(ledger.Milk_Log.length, beforeMilk);
    assert.strictEqual(ledger.Milk_Log[1][4], "keep-me");
  }

  {
    const { sheets } = await farm({
      inbound: FRESH,
      milk: [
        { session: "am", cow: "Gori", litres: 10 },
        { session: "am", cow: "Kali", litres: 8 },
        { session: "pm", cow: "Gori", litres: 9 },
      ],
      sales: [{ litres: 27 }],
    });
    const rec = recorder();
    const result = await runReminderJob(sheets, { slot: "evening", now: EVENING, send: rec.send });
    assert.strictEqual(result.sent, 1);
    assert.match(rec.sent[0].body, /Shaam ka doodh nahi likha/);
    assert.match(rec.sent[0].body, /Kali/);
    assert.doesNotMatch(rec.sent[0].body, /Gori/);
    assert.doesNotMatch(rec.sent[0].body, /hisab nahi/);
  }

  {
    const { sheets } = await farm({
      inbound: FRESH,
      milk: bothSessions(["Gori", "Kali"], 10),
      sales: [{ litres: 25 }],
    });
    const rec = recorder();
    const result = await runReminderJob(sheets, { slot: "evening", now: EVENING, send: rec.send });
    assert.strictEqual(result.sent, 1);
    assert.match(rec.sent[0].body, /Doodh 40 L likha hai, sale 25 L\. 15 L ka hisab nahi bana/);
    assert.doesNotMatch(rec.sent[0].body, /nahi likha/);
  }

  {
    const { sheets } = await farm({
      inbound: FRESH,
      milk: bothSessions(["Gori", "Kali"], 10),
      sales: [{ litres: 40 }],
    });
    const rec = recorder();
    const morning = await runReminderJob(sheets, { slot: "morning", now: MORNING, send: rec.send });
    const evening = await runReminderJob(sheets, { slot: "evening", now: EVENING, send: rec.send });
    assert.strictEqual(morning.sent, 0);
    assert.strictEqual(evening.sent, 0);
    assert.strictEqual(rec.sent.length, 0);
    assert.strictEqual(morning.results[0].reason, "complete");
    assert.strictEqual(evening.results[0].reason, "complete");
  }

  {
    const { sheets } = await farm({
      inbound: STALE,
      milk: [],
    });
    const rec = recorder();
    const result = await runReminderJob(sheets, { slot: "morning", now: MORNING, send: rec.send });
    assert.strictEqual(result.sent, 0);
    assert.strictEqual(rec.sent.length, 0);
    assert.strictEqual(result.results[0].reason, "outside_window");
  }

  {
    const { sheets } = await farm({
      inbound: null,
      milk: [],
    });
    const rec = recorder();
    const result = await runReminderJob(sheets, { slot: "evening", now: EVENING, send: rec.send });
    assert.strictEqual(result.sent, 0);
    assert.strictEqual(result.results[0].reason, "no_inbound");
    assert.strictEqual(rec.sent.length, 0);
  }

  {
    const { sheets } = await farm({
      inbound: FRESH,
      milk: [{ session: "am", cow: "Kali", litres: 5 }],
    });
    const rec = recorder();
    const first = await runReminderJob(sheets, { slot: "morning", now: MORNING, send: rec.send });
    const second = await runReminderJob(sheets, { slot: "morning", now: MORNING, send: rec.send });
    assert.strictEqual(first.sent, 1);
    assert.strictEqual(second.sent, 0);
    assert.strictEqual(rec.sent.length, 1);
    assert.strictEqual(second.results[0].reason, "duplicate");
  }

  {
    const { sheets } = await farm({
      inbound: FRESH,
      allowed: false,
      milk: [],
    });
    const rec = recorder();
    const result = await runReminderJob(sheets, { slot: "morning", now: MORNING, send: rec.send });
    assert.strictEqual(result.sent, 0);
    assert.strictEqual(result.results[0].reason, "not_allowed");
    assert.strictEqual(rec.sent.length, 0);
  }

  {
    const { sheets } = await farm({
      inbound: FRESH,
      onboardingState: "pending_animals",
      milk: [],
    });
    const rec = recorder();
    const result = await runReminderJob(sheets, { slot: "morning", now: MORNING, send: rec.send });
    assert.strictEqual(result.sent, 0);
    assert.strictEqual(result.results[0].reason, "onboarding");
  }

  {
    const { sheets } = await farm({
      inbound: FRESH,
      cows: [{ name: "Gori", status: "milking" }],
      milk: [],
    });
    let calls = 0;
    const result = await runReminderJob(sheets, {
      slot: "morning",
      now: MORNING,
      send: async () => {
        calls += 1;
        throw new Error("whatsapp down");
      },
    });
    assert.strictEqual(calls, 1);
    assert.strictEqual(result.sent, 0);
    assert.strictEqual(result.results[0].reason, "send_failed");
    const retry = recorder();
    const again = await runReminderJob(sheets, { slot: "morning", now: MORNING, send: retry.send });
    assert.strictEqual(again.sent, 1);
    assert.strictEqual(retry.sent.length, 1);
  }

  {
    const early = await runReminderJob(new MemorySheets(), {
      slot: "morning",
      now: new Date("2026-11-12T04:30:00.000Z"),
      send: async () => {
        throw new Error("should not send before 10:00 PKT");
      },
    });
    assert.strictEqual(early.sent, 0);
    assert.strictEqual(early.reason, "outside_hours");
  }

  {
    const sheets = new MemorySheets();
    sheets.Farmers = [
      ["phone", "sheet_id", "name", "farm_name", "onboarding_state", "allowed", "created_at"],
      ["923001110009", "mem-old", "Noman", "Naab", "complete", true, "2026-11-01"],
    ];
    sheets.ledgers["mem-old"] = emptyLedger();
    sheets.ledgers["mem-old"].Milk_Log.push(["2026-11-01", "am", "Gori", 12, "history"]);
    sheets.ledgers["mem-old"].Sales.push(["2026-11-01", "Aslam", 12, 180, 2160, 0, 2160, "history"]);
    sheets.ledgers["mem-old"].Cows.push(["C-1", "Gori", "cow", "", "milking", "", ""]);
    await sheets.touchLastInbound("923001110009", FRESH);
    assert.ok(sheets.Farmers[0].map((h) => String(h).toLowerCase()).includes("last_inbound_at"));
    assert.strictEqual(sheets.Farmers[1][2], "Noman");
    assert.strictEqual(sheets.Farmers[1][3], "Naab");
    assert.strictEqual(sheets.ledgers["mem-old"].Milk_Log[1][3], 12);
    assert.strictEqual(sheets.ledgers["mem-old"].Sales[1][2], 12);
    const rec = recorder();
    const result = await runReminderJob(sheets, { slot: "morning", now: MORNING, send: rec.send });
    assert.strictEqual(result.sent, 1);
    assert.match(rec.sent[0].body, /Gori/);
    assert.strictEqual(sheets.ledgers["mem-old"].Milk_Log[1][4], "history");
    assert.strictEqual(sheets.ledgers["mem-old"].Sales.length, 2);
  }

  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "test-secret-value";
  assert.strictEqual(cronConfigured(), true);
  assert.strictEqual(authorizedCron({ authorization: "Bearer test-secret-value" }), true);
  assert.strictEqual(authorizedCron({ authorization: "bearer test-secret-value" }), true);
  assert.strictEqual(authorizedCron({ authorization: "Bearer wrong-secret" }), false);
  assert.strictEqual(authorizedCron({ authorization: "" }), false);
  assert.strictEqual(authorizedCron({ "x-cron-secret": "test-secret-value" }), false);
  process.env.CRON_SECRET = "";
  assert.strictEqual(cronConfigured(), false);
  assert.strictEqual(authorizedCron({ authorization: "Bearer " }), false);
  if (previous == null) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previous;

  console.log("reminder tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
