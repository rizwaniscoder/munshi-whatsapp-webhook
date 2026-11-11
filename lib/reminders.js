const { todayISO, TIMEZONE } = require("./config");
const { dueSoonBills } = require("./billing");
const { upcomingEvents } = require("./animals");
const { lowStock } = require("./feed");
const { formatHumanDate, formatShortDate, eventLabel, prettyItem, parseSheetDate } = require("./format");
const { tx } = require("./reply");

function stockFooterLine(items, script) {
  if (!items.length) return "";
  const bits = items.map((s) => {
    const name = prettyItem(s.item);
    if (s.status === "empty") {
      return script === "urdu" ? `${name} ختم ہو چکا ہے` : `${name} khatam ho chuka hai`;
    }
    const days = s.daysLeft;
    const until = s.runoutDate ? formatShortDate(s.runoutDate) : "";
    const untilBit = until ? ` (${until} ${script === "urdu" ? "تک" : "tak"})` : "";
    if (days != null) {
      return script === "urdu"
        ? `${name} ${days} دن کا بچا${untilBit}`
        : `${name} ${days} din ka bacha${untilBit}`;
    }
    return script === "urdu" ? `${name} کم رہ گیا ہے` : `${name} kam reh gaya hai`;
  });
  const body = bits.join("; ");
  return script === "urdu" ? `⚠️ *خوراک*: ${body}` : `⚠️ *Khoraak*: ${body}`;
}

function upcomingFooterLine(events, script, refDate) {
  if (!events.length) return "";
  const bits = events.slice(0, 2).map((e) => {
    const when = formatHumanDate(e.date, refDate);
    const cow = e.cow || "all";
    const typ = eventLabel(e.event || e.event_type, script);
    return `${when}: ${cow}, ${typ}`;
  });
  const body = bits.join("; ");
  return script === "urdu" ? `📅 *آنے والا*: ${body}` : `📅 *Aane wala*: ${body}`;
}

function billsFooterLine(bills, script, refDate) {
  if (!bills.length) return "";
  const bits = bills.slice(0, 3).map((b) => `${b.customer}, ${formatHumanDate(b.dueDate, refDate)}`);
  const body = bits.join("; ");
  return script === "urdu" ? `💰 *بل*: ${body}` : `💰 *Bill*: ${body}`;
}

function reminderFooter(data, refDate) {
  const today = parseSheetDate(refDate) || todayISO(TIMEZONE);
  const stock = lowStock(data.feed_stock || data.feedStock, today, 3);
  const upcoming = upcomingEvents(
    data.cows,
    data.animal_events || data.animalEvents,
    today,
    7
  );
  const bills = dueSoonBills(data.customers, data.sales, data.payments, today, 2);

  const pick = (script) => {
    const lines = [];
    const stockLine = stockFooterLine(stock, script);
    if (stockLine) lines.push(stockLine);
    const upLine = upcomingFooterLine(upcoming, script, today);
    if (upLine && lines.length < 3) lines.push(upLine);
    const billLine = billsFooterLine(bills, script, today);
    if (billLine && lines.length < 3) lines.push(billLine);
    return lines.slice(0, 3).join("\n");
  };

  const urdu = pick("urdu");
  const roman = pick("roman");
  if (!urdu && !roman) return "";
  return "\n\n" + tx(urdu, roman);
}

async function withReminder(sheets, farmer, sender, text, scopeFn) {
  if (!text) return text;
  try {
    const data = await sheets.readRecent({ days: 45, refresh: false, ...scopeFn(farmer, sender) });
    return text + reminderFooter(data);
  } catch (err) {
    console.error("reminder footer failed", err.message);
    return text;
  }
}

module.exports = { reminderFooter, withReminder };
