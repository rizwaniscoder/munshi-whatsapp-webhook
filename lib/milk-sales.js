const { sessionFromText } = require("./session");

function shiftISO(iso, days) {
  const [y, m, d] = String(iso || "").split("-").map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function interpretMilkSales(text, ctx = {}) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  if (/\b(rozana|fixed|flexible|har roz|har mahine|billing)\b/i.test(raw)) return null;
  if (!/\b(litre|liter|litr|ltr|doodh)\b/i.test(raw)) return null;
  if (/\b(mazdoori|tankhwah|kharcha|committee|kameti|wanda|chara)\b/i.test(raw) && !/\b(hua|huya|nikla|becha)\b/i.test(raw)) {
    return null;
  }
  const today = ctx.today;
  const date = /\bkal\b/i.test(raw) && today ? shiftISO(today, -1) : today;
  const session = sessionFromText(raw);
  const parts = raw.split(/,|\band\b|\baur\b/i).map((part) => part.trim()).filter(Boolean);
  let total = null;
  const sales = [];
  for (const part of parts) {
    const sold = part.match(/(\d+(?:\.\d+)?)\s*(?:litre|liter|litr|ltr)?\s+([A-Za-z][^,]*?)\s+ko\b/i);
    const produced = /\b(hua|huya|nikla|doodh|kul|total|paida)\b/i.test(part);
    if (sold && !produced) {
      sales.push({ customer: sold[2].replace(/\s+/g, " ").trim(), litres: Number(sold[1]) });
      continue;
    }
    const qty = part.match(/(\d+(?:\.\d+)?)\s*(?:litre|liter|litr|ltr)\b/i);
    if (qty && (produced || total == null)) total = Number(qty[1]);
  }
  if (total == null && !sales.length) return null;
  const entries = [];
  if (total != null) {
    entries.push({ type: "milk", date, session, cow_name: "kul", litres: total });
  }
  for (const sale of sales) {
    if (!(sale.litres > 0) || !sale.customer) continue;
    entries.push({ type: "sale", date, customer: sale.customer, litres: sale.litres, session });
  }
  if (!entries.length) return null;
  return { intent: "record", entries };
}

module.exports = { interpretMilkSales };
