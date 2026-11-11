const { todayISO, TIMEZONE } = require("./config");

const CYCLES = ["daily", "weekly", "biweekly", "monthly"];

function inferCycleFromText(raw) {
  const t = String(raw || "")
    .trim()
    .toLowerCase();
  if (!t) return "";
  if (/(do\s*hafta|bi-?week|fortnight|15\s*din|pandrah)/i.test(t)) return "biweekly";
  if (/(mahine\s*baad|mahina|mahine|\bmonthly\b|\bmonth\b)/i.test(t)) return "monthly";
  if (/(hafte\s*baad|hafte|hafta|\bweekly\b|\bweek\b)/i.test(t)) return "weekly";
  if (/(rozana|har din|\broz\b|\bdaily\b)/i.test(t)) return "daily";
  if (CYCLES.includes(t)) return t;
  return "";
}

function normalizeCycle(raw) {
  return inferCycleFromText(raw) || "daily";
}

function cycleLabel(cycle) {
  return (
    {
      daily: "roz",
      weekly: "hafte baad",
      biweekly: "15 din baad",
      monthly: "mahine baad",
    }[normalizeCycle(cycle)] || "roz"
  );
}

function addDaysISO(iso, days) {
  const [y, m, d] = String(iso)
    .slice(0, 10)
    .split("-")
    .map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const toUtc = (iso) => {
    const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}

function startOfMonth(iso) {
  const [y, m] = String(iso).slice(0, 10).split("-").map(Number);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
}

function billingDayFrom(cycleStart, fallback = 1) {
  const d = Number(String(cycleStart || "").slice(8, 10));
  if (Number.isFinite(d) && d >= 1 && d <= 31) return d;
  return fallback;
}

function clampDay(year, month, day) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Math.min(day, last);
}

function monthlyPeriod(ref, billingDay) {
  const [y, m, d] = String(ref).slice(0, 10).split("-").map(Number);
  const day = billingDayFrom(null, billingDay);
  if (d >= day) {
    const startDay = clampDay(y, m, day);
    const start = `${y}-${String(m).padStart(2, "0")}-${String(startDay).padStart(2, "0")}`;
    let ny = y;
    let nm = m + 1;
    if (nm > 12) {
      nm = 1;
      ny += 1;
    }
    const end = addDaysISO(
      `${ny}-${String(nm).padStart(2, "0")}-${String(clampDay(ny, nm, day)).padStart(2, "0")}`,
      -1
    );
    const due = addDaysISO(end, 0);
    return { periodStart: start, periodEnd: end, dueDate: due };
  }
  let py = y;
  let pm = m - 1;
  if (pm < 1) {
    pm = 12;
    py -= 1;
  }
  const start = `${py}-${String(pm).padStart(2, "0")}-${String(clampDay(py, pm, day)).padStart(2, "0")}`;
  const end = addDaysISO(
    `${y}-${String(m).padStart(2, "0")}-${String(clampDay(y, m, day)).padStart(2, "0")}`,
    -1
  );
  return { periodStart: start, periodEnd: end, dueDate: end };
}

function periodFor(cycle, cycleStart, refDate) {
  const today = (refDate || todayISO(TIMEZONE)).slice(0, 10);
  const cyc = normalizeCycle(cycle);
  const anchor = (cycleStart || today).slice(0, 10);
  if (cyc === "daily") {
    return { periodStart: today, periodEnd: today, dueDate: today };
  }
  if (cyc === "monthly") {
    return monthlyPeriod(today, billingDayFrom(anchor, 1));
  }
  const length = cyc === "biweekly" ? 14 : 7;
  let offset = daysBetween(anchor, today);
  if (offset < 0) {
    return { periodStart: anchor, periodEnd: addDaysISO(anchor, length - 1), dueDate: addDaysISO(anchor, length - 1) };
  }
  const index = Math.floor(offset / length);
  const start = addDaysISO(anchor, index * length);
  const end = addDaysISO(start, length - 1);
  return { periodStart: start, periodEnd: end, dueDate: end };
}

function inPeriod(date, period) {
  const d = String(date || "").slice(0, 10);
  return d >= period.periodStart && d <= period.periodEnd;
}

function customerCycle(row, header) {
  const idx = (name) => {
    const needle = name.toLowerCase();
    return (header || []).findIndex((h) => String(h || "").toLowerCase() === needle);
  };
  const name = row[idx("name") === -1 ? 0 : idx("name")];
  const cycle = normalizeCycle(row[idx("billing_cycle")] || "daily");
  const start = String(row[idx("cycle_start_date")] || "").slice(0, 10);
  return { name, cycle, cycleStart: start };
}

function statementFor(customerName, customers, sales, payments, refDate) {
  const header = customers[0] || [];
  const row = (customers || []).slice(1).find((r) => String(r[0]).toLowerCase() === String(customerName).toLowerCase());
  if (!row) return null;
  const cycle = customerCycle(row, header);
  const period = periodFor(cycle.cycle, cycle.cycleStart, refDate);
  const rateIdx = header.findIndex((h) => String(h).toLowerCase() === "rate_pkr");
  const rate = rateIdx === -1 ? 0 : Number(row[rateIdx]) || 0;
  let litres = 0;
  let amount = 0;
  let paidFromSales = 0;
  for (const s of (sales || []).slice(1)) {
    if (String(s[1] || "").toLowerCase() !== String(customerName).toLowerCase()) continue;
    if (!inPeriod(s[0], period)) continue;
    litres += Number(s[2]) || 0;
    amount += Number(String(s[4]).replace(/[^0-9.-]/g, "")) || 0;
    paidFromSales += Number(String(s[5]).replace(/[^0-9.-]/g, "")) || 0;
  }
  if (!amount && litres && rate) amount = litres * rate;
  let paid = paidFromSales;
  for (const p of (payments || []).slice(1)) {
    if (String(p[1] || "").toLowerCase() !== String(customerName).toLowerCase()) continue;
    if (!inPeriod(p[0], period)) continue;
    paid += Number(String(p[2]).replace(/[^0-9.-]/g, "")) || 0;
  }
  const balanceDue = Math.round((amount - paid) * 100) / 100;
  return {
    customer: row[0],
    cycle: cycle.cycle,
    cycleLabel: cycleLabel(cycle.cycle),
    rate,
    ...period,
    litres,
    amount,
    paid,
    balanceDue,
    status: balanceDue > 0 && (refDate || todayISO(TIMEZONE)) >= period.dueDate ? "due" : balanceDue > 0 ? "open" : "paid",
  };
}

function dueBills(customers, sales, payments, refDate) {
  const today = (refDate || todayISO(TIMEZONE)).slice(0, 10);
  const out = [];
  for (const row of (customers || []).slice(1)) {
    if (!row[0]) continue;
    const bill = statementFor(row[0], customers, sales, payments, today);
    if (bill && bill.balanceDue > 0) out.push(bill);
  }
  return out;
}

function formatDueBills(bills) {
  if (!bills.length) return "Is waqt koi bill due nahi hai.";
  const lines = bills.map(
    (b) =>
      `- ${b.customer}: ${b.periodStart} se ${b.periodEnd}, ${b.litres} L, bill ${b.amount}, wasool ${b.paid}, baqi ${b.balanceDue} (due ${b.dueDate})`
  );
  return `Yeh bills due hain:\n\n${lines.join("\n")}`;
}

function dueSoonBills(customers, sales, payments, refDate, withinDays = 2) {
  const today = (refDate || todayISO(TIMEZONE)).slice(0, 10);
  const horizon = addDaysISO(today, withinDays);
  const out = [];
  for (const row of (customers || []).slice(1)) {
    if (!row[0]) continue;
    const bill = statementFor(row[0], customers, sales, payments, today);
    if (bill && bill.balanceDue > 0 && bill.dueDate <= horizon) out.push(bill);
  }
  return out;
}

function calendarMonthPeriod(refDate) {
  const today = (refDate || todayISO(TIMEZONE)).slice(0, 10);
  const start = startOfMonth(today);
  const [y, m] = start.split("-").map(Number);
  let ny = y;
  let nm = m + 1;
  if (nm > 12) {
    nm = 1;
    ny += 1;
  }
  const end = addDaysISO(`${ny}-${String(nm).padStart(2, "0")}-01`, -1);
  return { periodStart: start, periodEnd: today < end ? today : end, dueDate: end };
}

module.exports = {
  normalizeCycle,
  inferCycleFromText,
  cycleLabel,
  addDaysISO,
  periodFor,
  statementFor,
  dueBills,
  dueSoonBills,
  formatDueBills,
  calendarMonthPeriod,
  inPeriod,
  CYCLES,
};
