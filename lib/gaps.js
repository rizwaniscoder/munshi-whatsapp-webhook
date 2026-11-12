const { TIMEZONE } = require("./config");
const { headerIndex } = require("./schema");
const { normalizeSession } = require("./session");
const { formatHumanDate, formatQty, parseSheetDate } = require("./format");

const INACTIVE_STATUS = new Set([
  "removed",
  "sold",
  "dead",
  "dry",
  "soye",
  "culled",
  "inactive",
  "archived",
]);

const WINDOW_MS = 24 * 60 * 60 * 1000;
const LITRE_EPS = 0.05;
const MORNING_START = 10 * 60;
const EVENING_START = 19 * 60;
const DAY_END = 23 * 60 + 30;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function colIndex(header, name, fallback) {
  const i = headerIndex(header, name);
  return i === -1 ? fallback : i;
}

function zonedParts(date, timeZone = TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour,
    minute: Number(get("minute")),
  };
}

function normalizeSlot(slot) {
  const s = String(slot || "")
    .trim()
    .toLowerCase();
  if (["morning", "am", "subah", "10"].includes(s)) return "morning";
  if (["evening", "pm", "shaam", "19"].includes(s)) return "evening";
  return "";
}

function evaluateSlot(requested, now = new Date(), timeZone = TIMEZONE) {
  const when = now instanceof Date ? now : new Date(now);
  const parts = zonedParts(when, timeZone);
  const minutes = parts.hour * 60 + parts.minute;
  const explicit = normalizeSlot(requested);
  const slot = explicit || (minutes >= EVENING_START ? "evening" : "morning");
  if (minutes < MORNING_START || minutes > DAY_END) {
    return { ok: false, reason: "outside_hours", date: parts.date, slot };
  }
  if (slot === "evening" && minutes < EVENING_START) {
    return { ok: false, reason: "evening_not_due", date: parts.date, slot };
  }
  return { ok: true, slot, date: parts.date, reason: "" };
}

function inboundIsFresh(lastInboundAt, now, windowMs = WINDOW_MS) {
  if (lastInboundAt == null || lastInboundAt === "") return false;
  const t = new Date(lastInboundAt);
  if (Number.isNaN(t.getTime())) return false;
  const n = now instanceof Date ? now : new Date(now);
  const age = n.getTime() - t.getTime();
  if (age < -5 * 60 * 1000) return false;
  return age <= windowMs;
}

function activeAnimals(cows) {
  const rows = cows || [];
  const header = rows[0] || [];
  const nameI = colIndex(header, "name", 1);
  const statusI = colIndex(header, "status", 4);
  const pregI = headerIndex(header, "pregnancy_status");
  const out = [];
  const seen = new Set();
  for (const row of rows.slice(1)) {
    const name = String(row[nameI] || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    const status = String(row[statusI] || "")
      .trim()
      .toLowerCase();
    if (INACTIVE_STATUS.has(status)) continue;
    if (pregI !== -1 && String(row[pregI] || "").trim().toLowerCase() === "dry") continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function sessionsFor(milk, cow, date) {
  const rows = milk || [];
  const header = rows[0] || [];
  const dateI = colIndex(header, "date", 0);
  const sessI = colIndex(header, "session", 1);
  const cowI = colIndex(header, "cow_name", 2);
  const set = new Set();
  for (const row of rows.slice(1)) {
    if (parseSheetDate(row[dateI]) !== date) continue;
    if (String(row[cowI] || "").trim().toLowerCase() !== cow.toLowerCase()) continue;
    const session = normalizeSession(row[sessI]);
    if (session) set.add(session);
  }
  return set;
}

function sumLitres(rows, date, fallbackCol) {
  const header = (rows && rows[0]) || [];
  const dateI = colIndex(header, "date", 0);
  const litreI = colIndex(header, "litres", fallbackCol);
  let sum = 0;
  for (const row of (rows || []).slice(1)) {
    if (parseSheetDate(row[dateI]) !== date) continue;
    sum += Number(row[litreI]) || 0;
  }
  return round2(sum);
}

function findGaps(data, date) {
  const day = parseSheetDate(date) || String(date || "").slice(0, 10);
  const missingBoth = [];
  const missingMorningOnly = [];
  const missingEvening = [];
  for (const name of activeAnimals(data && data.cows)) {
    const sessions = sessionsFor(data && data.milk, name, day);
    const am = sessions.has("am");
    const pm = sessions.has("pm");
    if (!am && !pm) missingBoth.push(name);
    else if (!am) missingMorningOnly.push(name);
    else if (!pm) missingEvening.push(name);
  }
  const milkLitres = sumLitres(data && data.milk, day, 3);
  const soldLitres = sumLitres(data && data.sales, day, 2);
  const diff = round2(milkLitres - soldLitres);
  return {
    missingBoth,
    missingMorningOnly,
    missingEvening,
    milkLitres,
    soldLitres,
    unaccountedLitres: diff > LITRE_EPS ? diff : 0,
    oversoldLitres: diff < -LITRE_EPS ? round2(-diff) : 0,
  };
}

function issuesFor(gaps, slot) {
  const issues = [];
  if (slot === "morning") {
    if ((gaps.missingBoth || []).length || (gaps.missingMorningOnly || []).length) {
      issues.push("missing_morning");
    }
    return issues;
  }
  if ((gaps.missingBoth || []).length) issues.push("missing_both");
  if ((gaps.missingEvening || []).length) issues.push("missing_evening");
  if (gaps.unaccountedLitres > 0) issues.push("unaccounted_litres");
  if (gaps.oversoldLitres > 0) issues.push("oversold_litres");
  return issues;
}

function bullet(names) {
  return names.map((name) => `- ${name}`).join("\n");
}

function formatGapMessage(gaps, slot, date) {
  const when = formatHumanDate(date, date) || String(date || "");
  const lines = [];
  if (slot === "morning") {
    const names = [...(gaps.missingBoth || []), ...(gaps.missingMorningOnly || [])];
    if (!names.length) return "";
    lines.push(`${when}:`);
    lines.push("");
    lines.push("Subah ka doodh nahi likha:");
    lines.push(bullet(names));
  } else {
    const both = gaps.missingBoth || [];
    const shaam = gaps.missingEvening || [];
    const unsold = gaps.unaccountedLitres > 0;
    const over = gaps.oversoldLitres > 0;
    if (!both.length && !shaam.length && !unsold && !over) return "";
    lines.push(`${when}:`);
    if (both.length) {
      lines.push("");
      lines.push("Subah aur shaam dono ka doodh nahi likha:");
      lines.push(bullet(both));
    }
    if (shaam.length) {
      lines.push("");
      lines.push("Shaam ka doodh nahi likha:");
      lines.push(bullet(shaam));
    }
    if (unsold) {
      lines.push("");
      lines.push(
        `Doodh ${formatQty(gaps.milkLitres)} L likha hai, sale ${formatQty(gaps.soldLitres)} L. ${formatQty(gaps.unaccountedLitres)} L ka hisab nahi bana.`
      );
    }
    if (over) {
      lines.push("");
      lines.push(
        `Sale doodh se zyada hai: doodh ${formatQty(gaps.milkLitres)} L, sale ${formatQty(gaps.soldLitres)} L (${formatQty(gaps.oversoldLitres)} L zyada).`
      );
    }
  }
  lines.push("");
  lines.push("Jawab mein jo reh gaya hai woh bhej dein. Main confirm karke likh lunga.");
  return lines.join("\n").trim();
}

module.exports = {
  evaluateSlot,
  inboundIsFresh,
  findGaps,
  issuesFor,
  formatGapMessage,
  activeAnimals,
  WINDOW_MS,
};
