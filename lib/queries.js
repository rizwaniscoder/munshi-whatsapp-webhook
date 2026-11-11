const { todayISO, TIMEZONE } = require("./config");
const { formatHumanDate, formatShortDate, formatRs, formatQty, eventLabel, prettyItem, parseSheetDate } = require("./format");
const { tx } = require("./reply");
const { dueBills, formatDueBills, statementFor, calendarMonthPeriod, cycleLabel } = require("./billing");
const { upcomingEvents, pregnantCows, rowToEvent, deriveCow } = require("./animals");
const { stockStatus } = require("./feed");

function looksLike(question, re) {
  return re.test(String(question || "").toLowerCase());
}

function namedCow(question, cows) {
  const q = String(question || "").toLowerCase();
  const rows = cows && Array.isArray(cows[0]) ? cows.slice(1) : cows || [];
  const header = cows && Array.isArray(cows[0]) && /name|cow_id/i.test(String(cows[0][0] || "")) ? cows[0] : null;
  const names = rows.map((r) => {
    if (header) {
      const i = header.findIndex((h) => String(h || "").toLowerCase() === "name");
      return String(r[i] || "");
    }
    return r.name || r[1] || r[0] || "";
  }).filter(Boolean);
  return names.find((n) => q.includes(String(n).toLowerCase())) || "";
}

function namedCustomer(question, customers) {
  const q = String(question || "").toLowerCase();
  for (const row of (customers || []).slice(1)) {
    const name = String(row[0] || "");
    if (name && q.includes(name.toLowerCase())) return name;
  }
  return "";
}

function formatStatement(bill, refDate) {
  if (!bill) return tx("وہ کسٹمر لیجر میں نہیں ملا۔", "Woh customer ledger mein nahi mila.");
  const period = `${formatHumanDate(bill.periodStart, refDate)} se ${formatHumanDate(bill.periodEnd, refDate)}`;
  const due = formatHumanDate(bill.dueDate, refDate);
  const body = `${bill.customer} ka bill (${period}, ${cycleLabel(bill.cycle)}):\n${formatQty(bill.litres)} L, bill ${formatRs(bill.amount)}, wasool ${formatRs(bill.paid)}, baqi ${formatRs(bill.balanceDue)}. Due ${due}.`;
  const urdu = `${bill.customer} کا بل (${period}, ${cycleLabel(bill.cycle)}):\n${formatQty(bill.litres)} L, bill ${formatRs(bill.amount)}, وصول ${formatRs(bill.paid)}, باقی ${formatRs(bill.balanceDue)}. Due ${due}.`;
  return tx(urdu, body);
}

function cowType(cows, name) {
  const header = cows && cows[0];
  if (!header || !Array.isArray(header)) return "cow";
  const ni = header.findIndex((h) => String(h || "").toLowerCase() === "name");
  const ti = header.findIndex((h) => String(h || "").toLowerCase() === "type");
  const row = (cows || []).slice(1).find((r) => String(r[ni] || "").toLowerCase() === String(name).toLowerCase());
  return row && ti !== -1 ? row[ti] || "cow" : "cow";
}

function directQueryReply(question, data, refDate) {
  const today = (refDate || todayISO(TIMEZONE)).slice(0, 10);
  const q = String(question || "").toLowerCase();

  if (looksLike(q, /kis ka bill due|kaun sa bill due|due bills|bill due hai/)) {
    const bills = data.due_bills && data.due_bills.length > 1
      ? null
      : dueBills(data.customers, data.sales, data.payments, today);
    if (bills) return formatDueBills(bills, today);
    const rows = (data.due_bills || []).slice(1).filter((r) => r[0] && Number(r[7]) > 0);
    if (!rows.length) return tx("اس وقت کوئی بل due نہیں ہے۔", "Is waqt koi bill due nahi hai.");
    return formatDueBills(rows.map((r) => ({
      customer: r[0], periodStart: r[1], periodEnd: r[2], dueDate: r[3],
      litres: r[4], amount: r[5], paid: r[6], balanceDue: r[7],
    })), today);
  }

  if (looksLike(q, /ka (is mahine|is month|mahin[ae]|daur|cycle|hafte) ka bill|ka bill\b/) && !looksLike(q, /parchi|photo|image/)) {
    const name = namedCustomer(question, data.customers);
    if (name) {
      let bill;
      if (looksLike(q, /is mahine|is month/)) {
        const period = calendarMonthPeriod(today);
        bill = statementFor(name, data.customers, data.sales, data.payments, today);
        // Override period aggregation using calendar month via a temporary statement by filtering is done in statementFor with cycle; for "is mahine" rebuild:
        const { inPeriod } = require("./billing");
        const base = statementFor(name, data.customers, data.sales, data.payments, today) || { customer: name, cycle: "monthly", litres: 0, amount: 0, paid: 0, balanceDue: 0 };
        let litres = 0, amount = 0, paid = 0;
        for (const s of (data.sales || []).slice(1)) {
          if (String(s[1] || "").toLowerCase() !== name.toLowerCase()) continue;
          if (String(s[0] || "").slice(0, 10) < period.periodStart || String(s[0] || "").slice(0, 10) > period.periodEnd) continue;
          litres += Number(s[2]) || 0;
          amount += Number(String(s[4]).replace(/[^0-9.-]/g, "")) || 0;
        }
        for (const pmt of (data.payments || []).slice(1)) {
          if (String(pmt[1] || "").toLowerCase() !== name.toLowerCase()) continue;
          if (String(pmt[0] || "").slice(0, 10) < period.periodStart || String(pmt[0] || "").slice(0, 10) > period.periodEnd) continue;
          paid += Number(String(pmt[2]).replace(/[^0-9.-]/g, "")) || 0;
        }
        bill = { ...base, ...period, litres, amount, paid, balanceDue: Math.round((amount - paid) * 100) / 100, cycle: "monthly" };
      } else {
        bill = statementFor(name, data.customers, data.sales, data.payments, today);
      }
      return formatStatement(bill, today);
    }
  }

  if (looksLike(q, /gaban hai|pregnant|kaun si (gaye|gay|bhains)/)) {
    const evs = (data.animal_events || []).slice(1).map((e) => rowToEvent(e, (data.animal_events || [])[0]));
    const header = data.cows && data.cows[0];
    const nameIdx = header ? header.findIndex((h) => String(h || "").toLowerCase() === "name") : 1;
    const typeIdx = header ? header.findIndex((h) => String(h || "").toLowerCase() === "type") : 2;
    const derived = (data.cows || []).slice(1).map((r) => deriveCow(r[nameIdx], r[typeIdx] || "cow", evs)).filter((d) => d.cow);
    const list = pregnantCows(derived);
    if (!list.length) return tx("اس وقت کوئی گائے گابن نہیں دیکھی (یا ایونٹ ابھی سیو نہیں ہوا)۔", "Is waqt koi gay gaban nahi dikhi (ya event abhi save nahi hua).");
    return tx(
      "گابن: " + list.map((c) => `${c.cow}${c.expected_calving ? ` (bachha ~${formatHumanDate(c.expected_calving, today)})` : ""}`).join(", ") + ".",
      "Gaban: " + list.map((c) => `${c.cow}${c.expected_calving ? ` (bachha ~${formatHumanDate(c.expected_calving, today)})` : ""}`).join(", ") + "."
    );
  }

  const cow = namedCow(question, data.cows);
  if (cow && looksLike(q, /soye|dry off|kab soye|sukh/)) {
    const typ = cowType(data.cows, cow);
    const evs = (data.animal_events || []).slice(1).map((e) => rowToEvent(e, (data.animal_events || [])[0]));
    const d = deriveCow(cow, typ, evs);
    if (d.dry_off_due) {
      const when = formatHumanDate(d.dry_off_due, today);
      return tx(`${cow} ~${when} کو دودھ بند / سوئے ہو سکتی ہے۔`, `${cow} ~${when} ko doodh band / soye ho sakti hai.`);
    }
    return tx(`${cow} کی دودھ بند تاریخ ابھی نہیں نکل سکی۔ پہلے ٹیکہ یا چیک کا ریکارڈ بھیج دیں۔`, `${cow} ki doodh band date abhi nahi nikal saki. Pehle teeka ya check ka record bhej dein.`);
  }
  if (cow && looksLike(q, /bachha|calving|bya|kab degi/)) {
    const typ = cowType(data.cows, cow);
    const evs = (data.animal_events || []).slice(1).map((e) => rowToEvent(e, (data.animal_events || [])[0]));
    const d = deriveCow(cow, typ, evs);
    if (d.expected_calving) {
      const when = formatHumanDate(d.expected_calving, today);
      return tx(`${cow} کا بچہ ~${when} کو ہونے کا اندازہ ہے۔`, `${cow} ka bachha ~${when} ko hone ka andaaza hai.`);
    }
    return tx(`${cow} کی بچے کی تاریخ ابھی نہیں نکل سکی۔`, `${cow} ki bachha date abhi nahi nikal saki.`);
  }
  if (cow && looksLike(q, /history|bimari|sehat|ilaaj|treatment/)) {
    const evs = (data.animal_events || []).slice(1).map((e) => rowToEvent(e, (data.animal_events || [])[0]))
      .filter((e) => String(e.cow || "").toLowerCase() === cow.toLowerCase());
    if (!evs.length) {
      return tx(`${cow} کی کوئی صحت کی ہسٹری نہیں ملی۔`, `${cow} ki koi sehat / event history nahi mili.`);
    }
    const linesU = evs.slice(-8).map((e) => `- ${formatHumanDate(e.date, today)}: ${eventLabel(e.event_type, "urdu")}${e.diagnosis || e.details ? ` (${e.diagnosis || e.details})` : ""}`);
    const linesR = evs.slice(-8).map((e) => `- ${formatHumanDate(e.date, today)}: ${eventLabel(e.event_type, "roman")}${e.diagnosis || e.details ? ` (${e.diagnosis || e.details})` : ""}`);
    return tx(`${cow} کی ہسٹری:\n${linesU.join("\n")}`, `${cow} ki history:\n${linesR.join("\n")}`);
  }
  if (looksLike(q, /doctor kab|daktar kab|vet kab|appointment kab/)) {
    const upcoming = upcomingEvents(data.cows, data.animal_events, today, 30)
      .filter((e) => e.event === "vet_appointment" || /vet_appointment/.test(String(e.event || "")));
    if (!upcoming.length) {
      return tx("آنے والا کوئی ڈاکٹر کا وزٹ نہیں ملا۔", "Aane wala koi doctor ki visit nahi mila.");
    }
    const e = upcoming[0];
    const when = formatHumanDate(e.date, today);
    const who = e.cow || "farm";
    return tx(
      `ڈاکٹر ${when} کو ${who} کے لیے آنے والے ہیں${e.details ? ` (${e.details})` : ""}۔`,
      `Doctor ${when} ko ${who} ke liye aane wale hain${e.details ? ` (${e.details})` : ""}.`
    );
  }
  if (looksLike(q, /khoraak|wanda|chara|stock|khatam|runout|kitna chara/)) {
    const status = stockStatus(data.feed_stock, today, 3);
    if (!status.length) {
      return tx(
        "خوراک کا اسٹاک ابھی سیٹ نہیں ہے۔ Wanda/چارہ خریدتے وقت مقدار بھیجیں، یا روزانہ استعمال بتائیں۔",
        "Khoraak stock abhi set nahi hai. Wanda/chara kharidte waqt quantity bhej dein, ya rozana use bata dein."
      );
    }
    const line = (s, script) => {
      const name = prettyItem(s.item);
      const qty = `${formatQty(s.quantity)} ${s.unit || ""}`.trim();
      if (s.daysLeft == null) {
        return script === "urdu"
          ? `- ${name}: ${qty} (روزانہ استعمال سیٹ نہیں)`
          : `- ${name}: ${qty} (rozana use set nahi)`;
      }
      const until = s.runoutDate ? formatShortDate(s.runoutDate) : "";
      return script === "urdu"
        ? `- ${name}: ${qty}, ${s.daysLeft} دن کا بچا (${until} ${script === "urdu" ? "تک" : "tak"})`
        : `- ${name}: ${qty}, ${s.daysLeft} din ka bacha (${until} ${script === "urdu" ? "تک" : "tak"})`;
    };
    const urdu = "خوراک اسٹاک:\n" + status.map((s) => line(s, "urdu")).join("\n");
    const roman = "Khoraak stock:\n" + status.map((s) => line(s, "roman")).join("\n");
    return tx(urdu, roman);
  }
  return null;
}

module.exports = { directQueryReply, formatStatement, namedCustomer };
