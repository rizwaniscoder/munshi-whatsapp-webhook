const { addDaysISO, formatRs, formatHumanDate } = require("./format");
const { tx } = require("./reply");

const COMMITTEE_WORD = /(committee|commitee|commity|kameti|kameeti|kamiti|kumitee|kumiti|kumitty|کمیٹی)/i;

const NAME_STOP = new Set([
  "aaj", "kal", "parson", "wali", "wala", "meri", "hamari", "mera", "is", "us", "iss",
  "roz", "rozana", "nayi", "naya", "new", "ki", "ke", "ka", "di", "dii", "pending",
  "committee", "kameti", "kumitee", "nahi", "nahin", "the", "my", "hai", "thi", "tha",
]);

function mentionsCommittee(text) {
  return COMMITTEE_WORD.test(String(text || ""));
}

function normalizeFrequency(raw) {
  const t = String(raw || "").trim().toLowerCase();
  if (!t) return "daily";
  if (/(mahine|mahina|month|monthly)/.test(t)) return "monthly";
  if (/(bi-?week|15\s*din|pandrah|do\s*hafte)/.test(t)) return "biweekly";
  if (/(hafte|hafta|week|weekly)/.test(t)) return "weekly";
  if (/(roz|rozana|daily|har din)/.test(t)) return "daily";
  if (t === "daily" || t === "weekly" || t === "biweekly" || t === "monthly") return t;
  return "daily";
}

function frequencyWord(freq, script = "roman") {
  const f = normalizeFrequency(freq);
  if (f === "weekly") return script === "urdu" ? "ہفتے" : "hafte";
  if (f === "biweekly") return script === "urdu" ? "15 دن" : "15 din";
  if (f === "monthly") return script === "urdu" ? "مہینے" : "mahine";
  return script === "urdu" ? "روز" : "roz";
}

function firstAmount(text) {
  const re = /\d+(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(String(text || "")))) {
    if (m[0].length >= 8) continue;
    const around = String(text || "").slice(Math.max(0, m.index - 1), m.index + m[0].length + 1);
    if (/^\d{4}$/.test(m[0]) && /[-/]/.test(around)) continue;
    return Number(m[0]);
  }
  return null;
}

function dateFromText(text, today) {
  const s = String(text || "").toLowerCase();
  if (/\bparson\b/.test(s)) return addDaysISO(today, -2);
  if (/\bkal\b/.test(s)) return addDaysISO(today, -1);
  return today;
}

function cleanName(raw) {
  const name = String(raw || "").replace(/[,.!?].*$/, "").trim();
  if (!name || NAME_STOP.has(name.toLowerCase())) return "";
  return name;
}

function nameFromText(text) {
  const s = String(text || "");
  const naam = s.match(/\bnaam\s+([A-Za-z][A-Za-z0-9]*)/i);
  if (naam) return cleanName(naam[1]);
  const before = s.match(/\b([A-Za-z][A-Za-z0-9]{1,24})\s+(?:wali\s+|wala\s+)?(?:committee|commitee|kameti|kameeti|kumitee|kumiti)\b/i);
  if (before) {
    const got = cleanName(before[1]);
    if (got) return got;
  }
  const after = s.match(/\b(?:committee|commitee|kameti|kameeti|kumitee|kumiti)\s+([A-Za-z][A-Za-z0-9]{1,24})\b/i);
  if (after) return cleanName(after[1]);
  return "";
}

function organizerFromText(text) {
  const m = String(text || "").match(/\b(?:organizer|organiser)\s+([A-Za-z][A-Za-z0-9]*)/i);
  return m ? m[1] : "";
}

function frequencyFromText(text) {
  const s = String(text || "").toLowerCase();
  if (/(mahine|mahina|monthly|har mahine)/.test(s)) return "monthly";
  if (/(bi-?week|15\s*din|pandrah)/.test(s)) return "biweekly";
  if (/(hafte|hafta|weekly|har hafte)/.test(s)) return "weekly";
  if (/(roz|rozana|daily|har din)/.test(s)) return "daily";
  return "";
}

function statusFromText(text) {
  const s = String(text || "").toLowerCase();
  if (/(nahi\s*di|nahi\s*dii|nahi\s*de|nahin\s*di|not paid|\bpending\b|\bmiss\b)/.test(s)) return "not_paid";
  if (/(aadhi|adhi|partial|thori\s*di|kuch\s*di)/.test(s)) return "partial";
  if (/(\bdi\b|\bdii\b|\bdiya\b|\bditti\b|\bditta\b|de di|dedi|\bjama\b|\bada\b)/.test(s)) return "paid";
  return "";
}

function isCommitteeQuery(text) {
  if (!mentionsCommittee(text)) return false;
  const s = String(text || "");
  if (/\?/.test(s)) return true;
  if (/\b(kitni|kitna|kitne|baqi|arrears|hisab|status|total|kul|ab tak)\b/i.test(s)) return true;
  if (/\bkya\b/i.test(s)) return true;
  return false;
}

function activeCommittees(list) {
  return (list || []).filter((c) => String(c.status || "active").toLowerCase() !== "paused" && c.name);
}

function findCommittee(list, name) {
  if (!name) return null;
  const needle = String(name).toLowerCase();
  return activeCommittees(list).find((c) => String(c.name).toLowerCase() === needle) || null;
}

function askAmount(extra) {
  const roman = extra
    ? `${extra} Raqam kitni hai, aur naam agar alag ho? Maslan: roz 200, Bazar committee. Skip likh dein to baad mein.`
    : "Committee ki detail abhi set nahi. Raqam kitni hai, aur naam agar alag ho? Maslan: roz 200, Bazar committee. Skip likh dein to baad mein.";
  return tx(
    "کمیٹی کی رقم کتنی ہے، اور نام اگر الگ ہو؟ مثلاً: روز 200، Bazar committee۔ بعد میں بتانا ہو تو skip لکھ دیں۔",
    roman
  );
}

function askWhich() {
  return tx("کون سی کمیٹی؟ نام لکھ دیں۔", "Kaun si committee? Naam likh dein.");
}

function blankAmount(value) {
  return value == null || value === "";
}

function logEntry({ date, committee, status, amount }) {
  return {
    type: "committee_log",
    date,
    committee,
    status,
    amount: status === "not_paid" ? "" : amount,
  };
}

function setupEntry({ name, amount, frequency, start_date, organizer }) {
  return {
    type: "setup_committee",
    name: name || "Committee",
    amount,
    frequency: normalizeFrequency(frequency || "daily"),
    start_date: start_date || "",
    organizer: organizer || "",
    status: "active",
  };
}

function interpretCommittee(text, { today, committees } = {}) {
  if (!mentionsCommittee(text)) return null;
  const known = activeCommittees(committees);
  if (isCommitteeQuery(text)) return { intent: "query" };
  const status = statusFromText(text);
  const amount = firstAmount(text);
  const name = nameFromText(text);
  const frequency = frequencyFromText(text) || "daily";
  const date = dateFromText(text, today);
  const organizer = organizerFromText(text);
  const named = findCommittee(known, name);

  if (!status) {
    if (amount == null) {
      return {
        intent: "clarify",
        reply: askAmount(),
        pending: {
          type: "committee_details_needed",
          date,
          status: "",
          name,
          frequency: frequencyFromText(text) || "",
          asked: 1,
        },
      };
    }
    return {
      intent: "record",
      entries: [setupEntry({ name: name || "Committee", amount, frequency, start_date: date, organizer })],
    };
  }

  if (!named && !name && known.length > 1) {
    return {
      intent: "clarify",
      reply: askWhich(),
      pending: { type: "committee_details_needed", date, status, name: "", frequency, asked: 1 },
    };
  }

  const target = named || (known.length === 1 && !name ? known[0] : null);
  if (!target && amount == null && status !== "not_paid") {
    return {
      intent: "clarify",
      reply: askAmount(),
      pending: { type: "committee_details_needed", date, status, name, frequency: frequencyFromText(text) || "", asked: 1 },
    };
  }
  if (!target && amount == null && status === "not_paid") {
    return {
      intent: "clarify",
      reply: askAmount("Committee set nahi hai."),
      pending: { type: "committee_details_needed", date, status, name, frequency: frequencyFromText(text) || "", asked: 1 },
    };
  }

  let payStatus = status;
  let payAmount = amount;
  if (target && status === "paid" && blankAmount(payAmount)) payAmount = Number(target.amount) || "";
  if (target && status === "paid" && !blankAmount(payAmount) && Number(target.amount) > 0 && Number(payAmount) < Number(target.amount)) {
    payStatus = "partial";
  }
  const committeeName = target ? target.name : (name || "Committee");
  const entries = [];
  if (!target) {
    entries.push(setupEntry({
      name: committeeName,
      amount: blankAmount(payAmount) ? "" : payAmount,
      frequency,
      start_date: date,
      organizer,
    }));
  }
  entries.push(logEntry({ date, committee: committeeName, status: payStatus, amount: payAmount }));
  return { intent: "record", entries };
}

function finalizeCommitteeEntries(entries, committees, today) {
  const known = activeCommittees(committees);
  const out = [];
  for (const entry of entries || []) {
    if (entry.type === "setup_committee") {
      if (entry.amount == null || entry.amount === "") {
        return {
          ask: askAmount(),
          pending: {
            type: "committee_details_needed",
            date: entry.start_date || today,
            status: "",
            name: entry.name || "",
            frequency: entry.frequency || "",
            asked: 1,
          },
        };
      }
      out.push({
        ...entry,
        name: entry.name || "Committee",
        frequency: normalizeFrequency(entry.frequency || "daily"),
        status: entry.status || "active",
      });
      continue;
    }
    if (entry.type !== "committee_log") {
      out.push(entry);
      continue;
    }
    const named = findCommittee(known, entry.committee || entry.name);
    const target = named || (!entry.committee && known.length === 1 ? known[0] : null);
    if (!target && !entry.committee && known.length > 1) {
      return {
        ask: askWhich(),
        pending: {
          type: "committee_details_needed",
          date: entry.date || today,
          status: entry.status || "paid",
          name: "",
          frequency: "",
          asked: 1,
        },
      };
    }
    let status = entry.status || "paid";
    let amount = entry.amount;
    if (status === "not_paid") amount = "";
    else if (blankAmount(amount) && target && status === "paid") amount = Number(target.amount) || "";
    if (status === "paid" && target && !blankAmount(amount) && Number(target.amount) > 0 && Number(amount) < Number(target.amount)) {
      status = "partial";
    }
    if (status !== "not_paid" && blankAmount(amount)) {
      return {
        ask: askAmount(),
        pending: {
          type: "committee_details_needed",
          date: entry.date || today,
          status,
          name: target ? target.name : entry.committee || "",
          frequency: target ? target.frequency : "",
          asked: 1,
        },
      };
    }
    const committeeName = target ? target.name : (entry.committee || "Committee");
    if (!target && !known.some((c) => String(c.name).toLowerCase() === committeeName.toLowerCase())) {
      const already = out.some((e) => e.type === "setup_committee" && String(e.name).toLowerCase() === committeeName.toLowerCase());
      if (!already && !blankAmount(amount)) {
        out.push(setupEntry({
          name: committeeName,
          amount,
          frequency: "daily",
          start_date: entry.date || today,
          organizer: "",
        }));
      }
    }
    out.push(logEntry({ date: entry.date || today, committee: committeeName, status, amount }));
  }
  return { entries: out };
}

function applyCommitteeDetails(text, pending, { today, committees } = {}) {
  const p = pending || {};
  const raw = String(text || "").trim();
  if (/^(skip|skip karo|chor do|rehne do|baad mein)$/i.test(raw) || /\bskip\b/i.test(raw)) {
    return { skip: true };
  }
  const amount = firstAmount(raw);
  const name = nameFromText(raw) || p.name || "";
  const frequency = frequencyFromText(raw) || p.frequency || "daily";
  const date = p.date || dateFromText(raw, today);
  const status = p.status || statusFromText(raw) || "paid";
  const organizer = organizerFromText(raw);
  if (amount == null) {
    const asked = Number(p.asked || 1) + 1;
    return {
      intent: "clarify",
      giveUp: asked > 2,
      reply: askAmount(),
      pending: { ...p, type: "committee_details_needed", asked },
    };
  }
  const known = findCommittee(committees, name);
  const committeeName = known ? known.name : (name || "Committee");
  let payStatus = status || "paid";
  let payAmount = amount;
  if (known && payStatus === "paid" && Number(known.amount) > 0 && amount < Number(known.amount)) payStatus = "partial";
  const entries = [];
  if (!known) {
    entries.push(setupEntry({ name: committeeName, amount, frequency, start_date: date, organizer }));
  }
  if (payStatus) {
    entries.push(logEntry({
      date,
      committee: committeeName,
      status: payStatus,
      amount: payStatus === "not_paid" ? "" : payAmount,
    }));
  }
  return { intent: "record", entries };
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function nextSameDay(iso, months) {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  let ny = y;
  let nm = m + months;
  while (nm > 12) {
    nm -= 12;
    ny += 1;
  }
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad2(nm)}-${pad2(Math.min(d, last))}`;
}

function periodsFor(committee, today) {
  const freq = normalizeFrequency(committee.frequency);
  const start = String(committee.start_date || today).slice(0, 10);
  if (!start || start > today) return [];
  const periods = [];
  if (freq === "daily") {
    for (let d = start; d <= today && periods.length < 800; d = addDaysISO(d, 1)) {
      periods.push({ start: d, end: d, closed: true });
    }
    return periods;
  }
  const stepDays = freq === "weekly" ? 7 : freq === "biweekly" ? 14 : 0;
  if (stepDays) {
    let cursor = start;
    while (cursor <= today && periods.length < 400) {
      const end = addDaysISO(cursor, stepDays - 1);
      periods.push({ start: cursor, end, closed: end <= today });
      cursor = addDaysISO(cursor, stepDays);
    }
    return periods;
  }
  let cursor = start;
  while (cursor <= today && periods.length < 120) {
    const end = addDaysISO(nextSameDay(cursor, 1), -1);
    periods.push({ start: cursor, end, closed: end <= today });
    cursor = addDaysISO(end, 1);
  }
  return periods;
}

function lastLog(logs, name, period) {
  let found = null;
  for (const log of logs || []) {
    if (String(log.committee || "").toLowerCase() !== String(name || "").toLowerCase()) continue;
    const date = String(log.date || "").slice(0, 10);
    if (!date || date < period.start || date > period.end) continue;
    found = log;
  }
  return found;
}

function summarizeCommittee(committee, logs, today) {
  const expected = Number(committee.amount) || 0;
  const periods = periodsFor(committee, today);
  const monthStart = `${String(today).slice(0, 8)}01`;
  const summary = {
    name: committee.name,
    frequency: normalizeFrequency(committee.frequency),
    expected,
    monthPaid: 0,
    monthMissed: 0,
    monthPaidAmount: 0,
    arrears: 0,
    given: 0,
    todayStatus: "not_paid",
    todayAmount: 0,
  };
  for (const period of periods) {
    const log = lastLog(logs, committee.name, period);
    let status = log ? String(log.status || "not_paid") : "not_paid";
    let amount = log && log.amount !== "" && log.amount != null ? Number(log.amount) || 0 : 0;
    if (status === "paid" && !amount && expected) amount = expected;
    if (status === "paid" && expected && amount > 0 && amount < expected) status = "partial";
    const inMonth = period.start >= monthStart && period.start <= today;
    if (status === "paid") {
      summary.given += amount;
      if (inMonth) {
        summary.monthPaid += 1;
        summary.monthPaidAmount += amount;
      }
    } else if (status === "partial") {
      summary.given += amount;
      const short = Math.max(0, expected - amount);
      if (period.closed) summary.arrears += short;
      if (inMonth) {
        summary.monthPaidAmount += amount;
        summary.monthMissed += 1;
      }
    } else if (period.closed) {
      summary.arrears += expected;
      if (inMonth) summary.monthMissed += 1;
    } else if (inMonth) {
      summary.monthMissed += 1;
    }
    if (period.start <= today && period.end >= today) {
      summary.todayStatus = status === "paid" || status === "partial" ? status : "not_paid";
      summary.todayAmount = status === "not_paid" ? 0 : amount;
    }
  }
  return summary;
}

function rowsToCommittees(rows) {
  const list = rows || [];
  if (!list.length) return [];
  const header = Array.isArray(list[0]) ? list[0] : null;
  if (!header) return list.filter((c) => c && c.name);
  const idx = (name) => header.findIndex((h) => String(h || "").toLowerCase() === name);
  const ni = idx("name");
  const ai = idx("amount");
  const fi = idx("frequency");
  const si = idx("start_date");
  const oi = idx("organizer");
  const sti = idx("status");
  return list.slice(1).map((r) => ({
    name: r[ni],
    amount: r[ai],
    frequency: r[fi] || "daily",
    start_date: String(r[si] || "").slice(0, 10),
    organizer: oi === -1 ? "" : r[oi] || "",
    status: sti === -1 ? "active" : r[sti] || "active",
  })).filter((c) => c.name);
}

function rowsToLogs(rows) {
  const list = rows || [];
  if (!list.length) return [];
  const header = Array.isArray(list[0]) ? list[0] : null;
  if (!header) return list.filter((r) => r && r.date);
  const idx = (name) => header.findIndex((h) => String(h || "").toLowerCase() === name);
  const di = idx("date") === -1 ? 0 : idx("date");
  const ci = idx("committee") === -1 ? 1 : idx("committee");
  const si = idx("status") === -1 ? 2 : idx("status");
  const ai = idx("amount") === -1 ? 3 : idx("amount");
  return list.slice(1).map((r) => ({
    date: String(r[di] || "").slice(0, 10),
    committee: r[ci],
    status: r[si],
    amount: r[ai],
  })).filter((r) => r.date && r.committee);
}

function todayPhrase(summary, script) {
  const freq = summary.frequency;
  if (summary.todayStatus === "paid") {
    const bit = summary.todayAmount ? ` ${formatRs(summary.todayAmount)}` : "";
    if (freq === "weekly") return script === "urdu" ? `اس ہفتے دی${bit}` : `is hafte di${bit}`;
    if (freq === "monthly") return script === "urdu" ? `اس مہینے دی${bit}` : `is mahine di${bit}`;
    return script === "urdu" ? `آج دی${bit}` : `aaj di${bit}`;
  }
  if (summary.todayStatus === "partial") {
    const bit = ` ${formatRs(summary.todayAmount)}`;
    return script === "urdu" ? `آج تھوڑی دی${bit}` : `aaj thori di${bit}`;
  }
  if (freq === "weekly") return script === "urdu" ? "اس ہفتے نہیں دی" : "is hafte nahi di";
  if (freq === "monthly") return script === "urdu" ? "اس مہینے نہیں دی" : "is mahine nahi di";
  return script === "urdu" ? "آج نہیں دی" : "aaj nahi di";
}

function formatCommitteeReply(question, committeeRows, logRows, today) {
  const q = String(question || "").toLowerCase();
  const committees = activeCommittees(rowsToCommittees(committeeRows));
  const logs = rowsToLogs(logRows);
  if (!committees.length) {
    return tx(
      "کمیٹی ابھی سیٹ نہیں۔ روز، ہفتے یا مہینے کتنی دیتے ہیں؟",
      "Committee abhi set nahi. Roz, hafte ya mahine kitni dete hain?"
    );
  }
  const named = nameFromText(question);
  const list = named ? committees.filter((c) => String(c.name).toLowerCase() === named.toLowerCase()) : committees;
  const chosen = list.length ? list : committees;
  const summaries = chosen.map((c) => summarizeCommittee(c, logs, today));
  const todayAsk = /\baaj\b|\bkya\b|status/.test(q) && !/mahine|hafte|ab tak|baqi|arrear/.test(q);
  const allTime = /ab tak|shuru se|kul/.test(q);
  const linesR = [];
  const linesU = [];
  for (const s of summaries) {
    if (todayAsk) {
      linesR.push(`${s.name} committee ${todayPhrase(s, "roman")}.`);
      linesU.push(`${s.name} committee ${todayPhrase(s, "urdu")}۔`);
      continue;
    }
    if (allTime && !/mahine|hafte/.test(q)) {
      linesR.push(`Ab tak ${s.name} committee ${formatRs(s.given)} di. Baqi ${formatRs(s.arrears)}.`);
      linesU.push(`اب تک ${s.name} committee ${formatRs(s.given)} دی۔ باقی ${formatRs(s.arrears)}۔`);
      continue;
    }
    linesR.push(
      `Is mahine ${s.name} committee: ${formatRs(s.monthPaidAmount)} di, ${s.monthMissed} dafa nahi di. Baqi ${formatRs(s.arrears)}. Ab tak ${formatRs(s.given)} di.`
    );
    linesU.push(
      `اس مہینے ${s.name} committee: ${formatRs(s.monthPaidAmount)} دی، ${s.monthMissed} دفعہ نہیں دی۔ باقی ${formatRs(s.arrears)}۔ اب تک ${formatRs(s.given)} دی۔`
    );
  }
  return tx(linesU.join("\n"), linesR.join("\n"));
}

function committeeFooterLine(committeeRows, logRows, script, today) {
  const committees = activeCommittees(rowsToCommittees(committeeRows));
  if (!committees.length) return "";
  const logs = rowsToLogs(logRows);
  const bits = [];
  for (const c of committees) {
    const s = summarizeCommittee(c, logs, today);
    if (s.todayStatus === "paid" && !(s.arrears > 0)) continue;
    let bit = `${s.name} ${todayPhrase(s, script)}`;
    if (s.arrears > 0) bit += script === "urdu" ? `، باقی ${formatRs(s.arrears)}` : `, baqi ${formatRs(s.arrears)}`;
    bits.push(bit);
  }
  if (!bits.length) return "";
  const body = bits.slice(0, 2).join("; ");
  return script === "urdu" ? `⚠️ *کمیٹی*: ${body}` : `⚠️ *Committee*: ${body}`;
}

function parseCommitteeOnboarding(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  if (/^(skip|skip karo|chor do|rehne do|baad mein)$/i.test(raw) || /\bskip\b/i.test(raw)) {
    return { skip: true, committees: [] };
  }
  if (mentionsCommittee(raw) && /\b(nahi|nahin|no)\b/i.test(raw) && firstAmount(raw) == null) {
    return { skip: true, committees: [] };
  }
  const amount = firstAmount(raw);
  if (amount == null) return { skip: false, committees: [] };
  return {
    skip: false,
    committees: [{
      name: nameFromText(raw) || "Committee",
      amount,
      frequency: frequencyFromText(raw) || "daily",
      organizer: organizerFromText(raw),
      start_date: "",
    }],
  };
}

const STATUS_HEADERS = [
  "committee",
  "frequency",
  "as_of",
  "paid_periods",
  "missed_periods",
  "paid_amount",
  "arrears",
  "given_so_far",
  "today_status",
];

function committeeStatusRows(committeeRows, logRows, today) {
  const logs = rowsToLogs(logRows);
  const rows = [STATUS_HEADERS.slice()];
  for (const c of activeCommittees(rowsToCommittees(committeeRows))) {
    const s = summarizeCommittee(c, logs, today);
    rows.push([
      s.name,
      s.frequency,
      today,
      s.monthPaid,
      s.monthMissed,
      s.monthPaidAmount,
      s.arrears,
      s.given,
      s.todayStatus,
    ]);
  }
  return rows;
}

module.exports = {
  mentionsCommittee,
  normalizeFrequency,
  frequencyWord,
  interpretCommittee,
  applyCommitteeDetails,
  finalizeCommitteeEntries,
  summarizeCommittee,
  rowsToCommittees,
  rowsToLogs,
  formatCommitteeReply,
  committeeFooterLine,
  parseCommitteeOnboarding,
  committeeStatusRows,
  STATUS_HEADERS,
  isCommitteeQuery,
  askAmount,
};
