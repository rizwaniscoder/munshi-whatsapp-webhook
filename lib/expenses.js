const { addDaysISO, formatRs, formatHumanDate } = require("./format");

const FILLERS = new Set([
  "ka", "ki", "ke", "aaj", "kal", "roz", "daily", "bill", "wala", "wali", "wale",
  "the", "of", "for", "par", "pe", "mein", "me",
]);

const CATEGORIES = [
  { key: "labor", roman: "mazdoori", urdu: "مزدوری", re: /\b(mazdo+ri|mazduri|mazdoor|labour|labor|mzdori)\b/i },
  { key: "salary", roman: "tankhwah", urdu: "تنخواہ", re: /\b(tankh?wah|tankhwa|tankhah|tanakhah|salary)\b/i },
  { key: "electricity", roman: "bijli", urdu: "بجلی", re: /\b(bijli|electricity|light bill|light)\b/i },
  { key: "fuel", roman: "fuel", urdu: "ایندھن", re: /\b(fuel|diesel|petrol|disel)\b/i },
  { key: "medicine", roman: "dawai", urdu: "دوائی", re: /\b(dawai|davai|dawa|medicine|medicines)\b/i },
  { key: "transport", roman: "kiraya", urdu: "کرایہ", re: /\b(transport|kiraya|kirayah|sawari|travel)\b/i },
  { key: "repairs", roman: "marammat", urdu: "مرمت", re: /\b(marammat|maramat|repair|repairs)\b/i },
  { key: "animal_health", roman: "janwar ilaaj", urdu: "جانور علاج", re: /\b(animal_health|animal health)\b/i },
];

const EXPENSE_WORD = /\b(kharcha|kharch|kharchay|expense|expenses)\b/i;
const NOT_EXPENSE = /\b(litre|liter|litr|doodh|dudh|gay|gaaye|bhains|rate|udhaar|customer|wanda|chara|chaara|charay|chare|bhoosa|toori|silage|khal|fodder|khoraak|khurak)\b/i;
const QUERY_WORD = /\b(kitni|kitna|kitne|total|hisab|kul)\b/i;
const TYPO_WORD = /\b(typo|galti|galat|theek karo|correction)\b/i;

function expenseLabel(category, script = "roman") {
  const key = normalizeExpenseCategory(category);
  const known = CATEGORIES.find((c) => c.key === key);
  if (known) return script === "urdu" ? known.urdu : known.roman;
  const raw = String(category || "").trim();
  if (!raw || key === "kharcha") return script === "urdu" ? "خرچہ" : "kharcha";
  return raw;
}

function normalizeExpenseCategory(raw) {
  const s = String(raw || "").trim().replace(/\s+/g, " ");
  if (!s) return "";
  if (/^(kharcha|kharch|expense|expenses|other)$/i.test(s)) return "kharcha";
  const words = s.toLowerCase().split(/\s+/).filter(Boolean);
  for (const rule of CATEGORIES) {
    if (!rule.re.test(s)) continue;
    const leftover = words.filter((w) => !rule.re.test(w) && !FILLERS.has(w));
    if (!leftover.length) return rule.key;
  }
  return s.toLowerCase();
}

function specificCategory(text) {
  const s = String(text || "");
  for (const rule of CATEGORIES) {
    if (rule.key === "animal_health") continue;
    if (rule.re.test(s)) return rule.key;
  }
  return "";
}

function positiveAmount(value) {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(n) || n === 0) return null;
  return n;
}

function isJunkExpense(entry) {
  if (!entry || entry.type !== "expense") return false;
  return positiveAmount(entry.amount) == null;
}

function sanitizeExpenseEntry(entry) {
  if (!entry || entry.type !== "expense") return entry;
  if (isJunkExpense(entry)) return null;
  const amount = positiveAmount(entry.amount);
  let category = normalizeExpenseCategory(entry.category || "");
  if (!category) category = normalizeExpenseCategory(entry.note || "");
  if (!category) category = "kharcha";
  return {
    type: "expense",
    date: entry.date || "",
    category,
    amount,
    note: entry.note || "",
  };
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

function isFodderQuestion(text) {
  return /\b(chara|chaara|charay|chare|wanda|bhoosa|toori|silage|khal|fodder|khoraak|khurak)\b/i.test(String(text || ""));
}

function looksLikeExpense(text) {
  const s = String(text || "");
  if (isFodderQuestion(s) && !specificCategory(s)) return false;
  if (NOT_EXPENSE.test(s) && !EXPENSE_WORD.test(s) && !specificCategory(s)) return false;
  if (EXPENSE_WORD.test(s) || specificCategory(s)) return true;
  if (NOT_EXPENSE.test(s)) return false;
  const amount = firstAmount(s);
  if (amount == null) return false;
  const leftover = s
    .replace(/\d+(?:\.\d+)?/g, " ")
    .replace(/\b(aaj|kal|parson|rs|pkr|rupee|rupees|ka|ki|ke|di|diya|dii|hai|hua|hue|huye|mein|me|for|the|and|aur)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Boolean(leftover) && leftover.length <= 40;
}

function isExpenseQuery(text) {
  if (isFodderQuestion(text) && !specificCategory(text)) return false;
  if (!looksLikeExpense(text) && !EXPENSE_WORD.test(text) && !specificCategory(text)) return false;
  return QUERY_WORD.test(text) || /\?/.test(String(text || ""));
}

function entryFromClause(clause, today, inheritedDate) {
  const amount = firstAmount(clause);
  if (amount == null) return null;
  let category = specificCategory(clause);
  if (!category && EXPENSE_WORD.test(clause)) category = "kharcha";
  if (!category) {
    const leftover = String(clause)
      .replace(/\d+(?:\.\d+)?/g, " ")
      .replace(/\b(aaj|kal|parson|rs|pkr|rupee|rupees|ka|ki|ke|di|diya|dii|hai|hua|hue|huye|mein|me|for|the|and|aur|kharcha|kharch|expense)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!leftover || NOT_EXPENSE.test(clause)) return null;
    category = leftover.toLowerCase();
  }
  const dated = /\b(aaj|kal|parson)\b/i.test(clause) ? dateFromText(clause, today) : inheritedDate || dateFromText(clause, today);
  return sanitizeExpenseEntry({ type: "expense", date: dated, category, amount, note: "" });
}

function interpretExpenses(text, { today } = {}) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  if (!looksLikeExpense(raw) && !isExpenseQuery(raw)) return null;
  if (isExpenseQuery(raw)) return { intent: "query" };
  if (TYPO_WORD.test(raw) && (specificCategory(raw) || EXPENSE_WORD.test(raw)) && firstAmount(raw) == null) {
    const label = expenseLabel(specificCategory(raw) || "kharcha", "roman");
    return {
      intent: "clarify",
      reply: `${label} ki kya tabdeeli karni hai? Purani aur nayi raqam likh dein. Maslan: tankhwah 2000 nahi 1800 thi.`,
    };
  }
  const inherited = dateFromText(raw, today);
  const clauses = raw.split(/\s+aur\s+|\s+and\s+|,\s*/i).map((s) => s.trim()).filter(Boolean);
  const entries = [];
  for (const clause of clauses) {
    if (NOT_EXPENSE.test(clause) && !specificCategory(clause) && !EXPENSE_WORD.test(clause)) continue;
    const entry = entryFromClause(clause, today, inherited);
    if (entry) entries.push(entry);
  }
  if (!entries.length) return null;
  return { intent: "record", entries };
}

function weekStart(today) {
  const [y, m, d] = String(today).slice(0, 10).split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDaysISO(today, -dow);
}

function expensePeriod(question, today) {
  const q = String(question || "").toLowerCase();
  if (/is mahine|is month|iss mahine|is mahina/.test(q)) {
    return { start: `${today.slice(0, 8)}01`, end: today, label: "Is mahine" };
  }
  if (/is hafte|is week|iss hafte/.test(q)) {
    return { start: weekStart(today), end: today, label: "Is hafte" };
  }
  if (/\bkal\b/.test(q)) {
    const day = addDaysISO(today, -1);
    return { start: day, end: day, label: formatHumanDate(day, today) };
  }
  return { start: today, end: today, label: "Aaj" };
}

function expenseRows(expenses) {
  const rows = expenses || [];
  if (!rows.length) return [];
  const header = rows[0] || [];
  const dateIdx = header.findIndex((h) => String(h || "").toLowerCase() === "date");
  const catIdx = header.findIndex((h) => String(h || "").toLowerCase() === "category");
  const amtIdx = header.findIndex((h) => String(h || "").toLowerCase() === "amount");
  const dI = dateIdx === -1 ? 0 : dateIdx;
  const cI = catIdx === -1 ? 1 : catIdx;
  const aI = amtIdx === -1 ? 2 : amtIdx;
  return rows.slice(1).map((r) => ({
    date: String(r[dI] || "").slice(0, 10),
    category: normalizeExpenseCategory(r[cI]),
    amount: positiveAmount(r[aI]) || 0,
  })).filter((r) => r.date && r.amount);
}

function formatExpenseReply(question, expenses, today) {
  const period = expensePeriod(question, today);
  const filter = specificCategory(question);
  const rows = expenseRows(expenses).filter((r) => r.date >= period.start && r.date <= period.end);
  const matched = filter ? rows.filter((r) => r.category === filter) : rows;
  const label = filter ? expenseLabel(filter, "roman") : "kharcha";
  if (!matched.length) {
    const roman = `${period.label} koi ${label} nahi hua.`;
    const urdu = `${period.label} کوئی ${expenseLabel(filter || "kharcha", "urdu")} نہیں ہوا۔`;
    return { urdu, roman };
  }
  const total = matched.reduce((sum, r) => sum + r.amount, 0);
  const byCat = new Map();
  for (const row of matched) byCat.set(row.category, (byCat.get(row.category) || 0) + row.amount);
  const lines = [`${period.label} ${label}: ${formatRs(total)}.`];
  if (!filter && byCat.size > 1) {
    for (const [cat, amt] of byCat) lines.push(`- ${expenseLabel(cat, "roman")}: ${formatRs(amt)}`);
  }
  const roman = lines.join("\n");
  const urduLabel = filter ? expenseLabel(filter, "urdu") : "خرچہ";
  const urduLines = [`${period.label} ${urduLabel}: ${formatRs(total)}.`];
  if (!filter && byCat.size > 1) {
    for (const [cat, amt] of byCat) urduLines.push(`- ${expenseLabel(cat, "urdu")}: ${formatRs(amt)}`);
  }
  return { urdu: urduLines.join("\n"), roman };
}

module.exports = {
  CATEGORIES,
  expenseLabel,
  normalizeExpenseCategory,
  specificCategory,
  isJunkExpense,
  sanitizeExpenseEntry,
  interpretExpenses,
  isExpenseQuery,
  formatExpenseReply,
  looksLikeExpense,
};
