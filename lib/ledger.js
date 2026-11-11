function money(n) {
  const num = Number(n) || 0;
  if (Number.isInteger(num)) return String(num);
  return String(Math.round(num * 100) / 100);
}

function entryLines(entries) {
  const lines = [];
  for (const entry of entries || []) {
    if (entry.type === "milk") {
      const session = entry.session ? ` (${entry.session})` : "";
      lines.push(`- ${entry.cow_name}: ${money(entry.litres)} L doodh${session}`);
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
  const counts = { milk: 0, sale: 0, payment: 0, expense: 0, cow: 0 };
  for (const entry of entries || []) {
    if (counts[entry.type] != null) counts[entry.type] += 1;
  }
  const bits = [];
  if (counts.milk) bits.push(`${counts.milk} doodh`);
  if (counts.sale) bits.push(`${counts.sale} sale`);
  if (counts.payment) bits.push(`${counts.payment} payment`);
  if (counts.expense) bits.push(`${counts.expense} kharcha`);
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
};
