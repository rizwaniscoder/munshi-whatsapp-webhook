const { todayISO, TIMEZONE } = require("./config");
const { dueSoonBills } = require("./billing");
const { upcomingEvents } = require("./animals");
const { lowStock, formatStockLine } = require("./feed");

function reminderFooter(data, refDate) {
  const today = (refDate || todayISO(TIMEZONE)).slice(0, 10);
  const lines = [];
  const bills = dueSoonBills(data.customers, data.sales, data.payments, today, 2);
  if (bills.length) {
    const names = bills
      .slice(0, 3)
      .map((b) => `${b.customer} (${b.dueDate})`)
      .join(", ");
    lines.push(`Bill jald due: ${names}.`);
  }
  const stock = lowStock(data.feed_stock || data.feedStock, today, 3);
  const stockLine = formatStockLine(stock);
  if (stockLine) lines.push(`Khoraak: ${stockLine}.`);
  const upcoming = upcomingEvents(
    data.cows,
    data.animal_events || data.animalEvents,
    today,
    7
  );
  const soon = upcoming.filter((e) => e.date <= today || e.date <= today);
  const nextWeek = upcoming.slice(0, 2);
  if (nextWeek.length && lines.length < 2) {
    const ev = nextWeek
      .map((e) => `${e.cow || "all"} ${e.event} ${e.date}`)
      .join("; ");
    lines.push(`Anay wala: ${ev}.`);
  }
  if (!lines.length) return "";
  return "\n\n" + lines.slice(0, 2).join(" ");
}

async function withReminder(sheets, farmer, sender, text, scopeFn) {
  if (!text) return text;
  try {
    const data = await sheets.readRecent({ days: 45, ...scopeFn(farmer, sender) });
    return text + reminderFooter(data);
  } catch (err) {
    console.error("reminder footer failed", err.message);
    return text;
  }
}

module.exports = { reminderFooter, withReminder };
