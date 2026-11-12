const { hasOwnLedger, isTruthyAllowed, normalizePhone } = require("./config");
const { evaluateSlot, findGaps, formatGapMessage, inboundIsFresh, issuesFor } = require("./gaps");
const { sendText } = require("./whatsapp");

function blockReason(farmer) {
  if (!farmer || !normalizePhone(farmer.phone)) return "no_farmer";
  if (!isTruthyAllowed(farmer.allowed)) return "not_allowed";
  if (!hasOwnLedger(farmer, farmer.phone)) return "no_ledger";
  if (String(farmer.onboardingState || "").trim().toLowerCase() !== "complete") return "onboarding";
  return "";
}

async function remindFarmer(sheets, farmer, decision, now, send) {
  const phone = normalizePhone(farmer.phone);
  const blocked = blockReason(farmer);
  if (blocked) return { phone, status: "skipped", reason: blocked };
  if (!inboundIsFresh(farmer.lastInboundAt, now)) {
    return {
      phone,
      status: "skipped",
      reason: farmer.lastInboundAt ? "outside_window" : "no_inbound",
    };
  }

  let data;
  try {
    data = await sheets.readRecent({
      days: 7,
      refresh: false,
      sender: phone,
      sheetId: farmer.sheetId || undefined,
    });
  } catch (err) {
    console.error("reminder read failed", phone, err.message);
    return { phone, status: "skipped", reason: "read_failed" };
  }

  const gaps = findGaps(data, decision.date);
  const issues = issuesFor(gaps, decision.slot);
  if (!issues.length) return { phone, status: "skipped", reason: "complete" };

  const claimKey = { phone, date: decision.date, slot: decision.slot };
  let claim;
  try {
    claim = await sheets.claimReminder(claimKey);
  } catch (err) {
    console.error("reminder claim failed", phone, err.message);
    return { phone, status: "skipped", reason: "reminder_log_unavailable" };
  }
  if (!claim || claim.claimed !== true) {
    return {
      phone,
      status: "skipped",
      reason: claim && claim.already ? "duplicate" : "reminder_log_unavailable",
    };
  }

  const text = formatGapMessage(gaps, decision.slot, decision.date);
  try {
    await send(phone, text);
  } catch (err) {
    console.error("reminder send failed", phone, err.message);
    try {
      await sheets.releaseReminder(claimKey);
    } catch (releaseErr) {
      console.error("reminder release failed", phone, releaseErr.message);
    }
    return { phone, status: "skipped", reason: "send_failed" };
  }
  return { phone, status: "sent", reason: issues.join(","), issues };
}

async function runReminderJob(sheets, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const decision = evaluateSlot(options.slot, now);
  if (!decision.ok) {
    return {
      ok: true,
      sent: 0,
      skipped: 0,
      slot: decision.slot,
      date: decision.date,
      reason: decision.reason,
      results: [],
    };
  }

  const send = options.send || sendText;
  const listed = await sheets.listFarmers();
  const farmers = (listed && listed.farmers) || [];
  const results = [];
  for (const farmer of farmers) {
    results.push(await remindFarmer(sheets, farmer, decision, now, send));
  }
  const sent = results.filter((r) => r.status === "sent").length;
  return {
    ok: true,
    sent,
    skipped: results.length - sent,
    slot: decision.slot,
    date: decision.date,
    reason: "",
    results,
  };
}

module.exports = { runReminderJob, blockReason };
