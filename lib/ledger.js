function money(n) {
  const num = Number(n) || 0;
  if (Number.isInteger(num)) return String(num);
  return String(Math.round(num * 100) / 100);
}

const { sessionLabel } = require("./session");

const FODDER_CATEGORY_RE =
  /\b(chara|chaara|charay|wanda|bhoosa|toori|silage|khal|fodder|green fodder|hara chara)\b|^feed$/i;

function fodderItemName(raw) {
  const t = String(raw || "").toLowerCase();
  if (t.includes("wanda")) return "wanda";
  if (t.includes("bhoosa") || t.includes("toori")) return "bhoosa";
  if (t.includes("silage")) return "silage";
  if (t.includes("khal")) return "khal";
  if (t.includes("chara") || t.includes("green fodder") || t.includes("hara chara") || t.includes("fodder")) {
    return "chara";
  }
  return "other";
}

function asFodder(entry) {
  const cost = Number(entry.cost_pkr ?? entry.amount) || 0;
  let cash = entry.cash_paid;
  if (cash == null || cash === "") cash = 0;
  cash = Number(cash) || 0;
  let bal = entry.balance_owed;
  if (bal == null || bal === "") bal = cost - cash;
  bal = Number(bal) || 0;
  return {
    ...entry,
    type: "fodder",
    item: fodderItemName(entry.item || entry.category),
    quantity: entry.quantity == null ? "" : entry.quantity,
    unit: entry.unit || "",
    cost_pkr: cost,
    supplier: entry.supplier || "",
    cash_paid: cash,
    balance_owed: bal,
  };
}

function routeFodderEntries(entries) {
  return (entries || []).map((entry) => {
    if (entry.type === "fodder") return asFodder(entry);
    if (entry.type === "expense" && FODDER_CATEGORY_RE.test(String(entry.category || ""))) {
      return asFodder(entry);
    }
    return entry;
  });
}

function entryLines(entries) {
  const lines = [];
  for (const entry of entries || []) {
    if (entry.type === "milk") {
      const label = sessionLabel(entry.session);
      lines.push(`${label}: ${entry.cow_name} ${money(entry.litres)} L`);
    } else if (entry.type === "sale") {
      lines.push(
        `- ${entry.customer}: ${money(entry.litres)} L x ${money(entry.rate_pkr)} = ${money(entry.amount)}, cash ${money(entry.cash_received)}, udhaar ${money(entry.balance_added)}`
      );
    } else if (entry.type === "payment") {
      const method = entry.method ? `, ${entry.method}` : "";
      lines.push(`- ${entry.customer} se ${money(entry.amount)} wasool${method}`);
    } else if (entry.type === "expense") {
      lines.push(`- Kharcha (${entry.category}): ${money(entry.amount)}${entry.note ? ` (${entry.note})` : ""}`);
    } else if (entry.type === "cow") {
      lines.push(`- Nayi gay: ${entry.cow_name}${entry.breed ? `, ${entry.breed}` : ""}`);
    } else if (entry.type === "fodder") {
      const qty =
        entry.quantity != null && entry.quantity !== ""
          ? ` ${money(entry.quantity)}${entry.unit ? ` ${entry.unit}` : ""}`
          : "";
      const supplier = entry.supplier ? `, ${entry.supplier}` : "";
      lines.push(
        `- Chara (${entry.item})${qty}: ${money(entry.cost_pkr)}, cash ${money(entry.cash_paid)}, baqi ${money(entry.balance_owed)}${supplier}`
      );
    }
  }
  return lines;
}

function confirmationText(parsed) {
  const lines = entryLines(parsed.entries);
  const summary = (parsed.summary || "").trim();
  const parts = ["Yeh record karun?"];
  if (summary) parts.push(summary);
  if (lines.length) parts.push(lines.join("\n"));
  parts.push("Haan dabain to save ho jayega. Nahi dabain to cancel.");
  return parts.join("\n\n").slice(0, 1024);
}

function savedText(entries) {
  const counts = { milk: 0, sale: 0, payment: 0, expense: 0, cow: 0, fodder: 0 };
  for (const entry of entries || []) {
    if (counts[entry.type] != null) counts[entry.type] += 1;
  }
  const bits = [];
  if (counts.milk) bits.push(`${counts.milk} doodh`);
  if (counts.sale) bits.push(`${counts.sale} sale`);
  if (counts.payment) bits.push(`${counts.payment} payment`);
  if (counts.expense) bits.push(`${counts.expense} kharcha`);
  if (counts.fodder) bits.push(`${counts.fodder} chara`);
  if (counts.cow) bits.push(`${counts.cow} gay`);
  const detail = bits.length ? bits.join(", ") : "record";
  return `Save ho gaya. ${detail}.`;
}

function isYesText(text) {
  const t = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[!?.]+$/g, "");
  return ["haan", "han", "ha", "yes", "y", "ji", "theek hai", "ok", "okay"].includes(t);
}

function isNoText(text) {
  const t = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[!?.]+$/g, "");
  return ["nahi", "nahin", "na", "no", "n", "cancel"].includes(t);
}

function isDeleteRequest(text) {
  const t = String(text || "").trim().toLowerCase();
  return t.includes("delete my data") || t.includes("mera data delete");
}

module.exports = {
  confirmationText,
  savedText,
  entryLines,
  isYesText,
  isNoText,
  isDeleteRequest,
  routeFodderEntries,
};
