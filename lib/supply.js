const { todayISO, TIMEZONE } = require("./config");
const { inferCycleFromText } = require("./billing");
const { formatQty } = require("./format");
const { tx } = require("./reply");
const { headerIndex } = require("./schema");

const NOT_NAMES = new Set([
  "rate", "rete", "udhaar", "udhar", "phone", "fon", "mobile", "mob", "number", "nmbr",
  "rozana", "fixed", "hotel", "hotels", "restaurant", "dhaba", "canteen", "flexible",
  "payment", "bill", "hafte", "hafta", "mahine", "mahina", "month", "week",
  "liter", "litre", "liters", "litres", "litter", "litters", "ltr",
  "roz", "daily", "weekly", "monthly", "biweekly", "paise", "paisa",
  "deta", "deti", "dete", "hai", "hain", "ho", "ab", "bhi",
  "ko", "ki", "ka", "ke", "se", "har", "tareekh", "tarikh", "taareekh", "taarikh",
  "jitna", "jitan", "le", "ley", "leta", "leti", "us", "is", "hisab", "hisaab",
  "typical", "lagbhag", "taqreeban", "and", "aur", "customer", "customers",
  "naam", "shuru", "opening", "balance", "baad", "din", "pandrah", "theek", "skip",
  "aaj", "kal", "subah", "shaam", "doodh", "milk", "sale", "nahi", "nahin",
  "mein", "main", "per", "pe", "wala", "wali", "standing", "household", "ghar",
  "wasool", "due", "note", "notes", "area", "route", "yeh", "woh", "kaun",
  "kitna", "kitni", "kitne", "bhejo", "parchi", "the",
]);

const FLEXIBLE_RE = /hotel|restaurant|dhaba|daaba|canteen|\bflexible\b|\bjitna\b|us\s+hisaa?b|\bkabhi\s+\d|\bjo\s+le\b/i;
const FIXED_WORD_RE = /\bfixed\b|\brozana\b|\bhar\s+roz\b|\bhar\s+din\b|\bstanding\b|\broz\s+ka\b/i;
const BILLING_WORD_RE = /payment|\bbill\b|paise|wasool|\bdue\b|hafte|hafta|mahine|mahina|\bweekly\b|\bmonthly\b|\bbiweekly\b/i;
const LITRE_RE = /(\d+(?:[.,]\d+)?)\s*(?:litters?|litres?|liters?|ltr)\b/gi;
const HOUSEHOLD_MAX = 20;

function isNameToken(word) {
  if (!word || !/^[A-Za-z][A-Za-z.'-]{1,}$/.test(word)) return false;
  return !NOT_NAMES.has(String(word).toLowerCase());
}

function extractName(chunk) {
  const match = String(chunk || "").trim().match(/^([A-Za-z][A-Za-z.'-]{1,})/);
  if (!match || !isNameToken(match[1])) return "";
  return match[1];
}

function extractLitres(text) {
  const out = [];
  for (const match of String(text || "").matchAll(LITRE_RE)) {
    const n = Number(String(match[1]).replace(",", "."));
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

function cleanLitres(value) {
  if (value == null || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  return n;
}

function dateOnDay(refDate, day) {
  const iso = String(refDate || todayISO(TIMEZONE)).slice(0, 10);
  const [y, m] = iso.split("-").map(Number);
  if (!y || !m) return "";
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const d = Math.min(Math.max(Number(day) || 1, 1), last);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function inferBillingAnchor(raw, refDate) {
  const t = String(raw || "").toLowerCase();
  if (!t) return null;
  const every = t.match(/\bhar\s+(\d{1,2})\s*din\b/);
  const tareekh = t.match(/\b(\d{1,2})\s*(?:tareekh|tarikh|taareekh|taarikh)\b/);
  if (every && !tareekh) {
    return { every_n_days: true, day: Number(every[1]) };
  }
  if (!tareekh) return null;
  const day = Number(tareekh[1]);
  if (day < 1 || day > 31) return null;
  return {
    every_n_days: false,
    day,
    billing_cycle: "monthly",
    cycle_start_date: dateOnDay(refDate, day),
  };
}

function billingCycleFromText(text) {
  const stripped = String(text || "")
    .replace(/\brozana\b/gi, " ")
    .replace(/\bhar\s+roz\b/gi, " ")
    .replace(/\bhar\s+din\b/gi, " ");
  return inferCycleFromText(stripped) || "";
}

function typicalNote(litres) {
  return `typical ${formatQty(litres)} L/day`;
}

function parseSupplyClause(text, refDate) {
  const raw = String(text || "");
  const ref = refDate || todayISO(TIMEZONE);
  const anchor = inferBillingAnchor(raw, ref);
  const litres = extractLitres(raw);
  const flexible = FLEXIBLE_RE.test(raw) || (/\bkabhi\b/i.test(raw) && litres.length >= 2);
  const fixedWord = FIXED_WORD_RE.test(raw);
  const billingWords = BILLING_WORD_RE.test(raw) || Boolean(anchor && anchor.cycle_start_date);
  let supply_type = "";
  let daily_litres = "";
  let supply_note = "";
  if (flexible) {
    supply_type = "flexible";
    if (litres.length === 1) supply_note = typicalNote(litres[0]);
  } else if (fixedWord && litres.length === 1) {
    supply_type = "fixed";
    daily_litres = litres[0];
  } else if (litres.length === 1 && (billingWords || litres[0] < HOUSEHOLD_MAX)) {
    supply_type = "fixed";
    daily_litres = litres[0];
  } else if (litres.length === 1 && litres[0] >= HOUSEHOLD_MAX) {
    supply_type = "flexible";
    supply_note = typicalNote(litres[0]);
  }
  let billing_cycle = "";
  let cycle_start_date = "";
  if (anchor && anchor.every_n_days) {
    billing_cycle = billingCycleFromText(raw);
  } else if (anchor && anchor.cycle_start_date) {
    billing_cycle = "monthly";
    cycle_start_date = anchor.cycle_start_date;
  } else {
    billing_cycle = billingCycleFromText(raw);
  }
  return {
    supply_type,
    daily_litres,
    supply_note,
    billing_cycle,
    cycle_start_date,
    every_n_days: Boolean(anchor && anchor.every_n_days),
  };
}

function splitCustomerChunks(text) {
  const rough = String(text || "")
    .split(/\n+|(?<=[.!?])\s+|;\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  const out = [];
  for (const piece of rough) {
    const bits = piece.split(/\s*,\s*|\s+aur\s+|\s+and\s+/i).map((bit) => bit.trim()).filter(Boolean);
    let current = "";
    for (const bit of bits) {
      const first = (bit.match(/^([A-Za-z][A-Za-z.'-]{1,})/) || [])[1] || "";
      const startsNew = current && isNameToken(first) && extractName(current);
      if (startsNew) {
        out.push(current.trim());
        current = bit;
      } else {
        current = current ? `${current}, ${bit}` : bit;
      }
    }
    if (current.trim()) out.push(current.trim());
  }
  return out;
}

function clauseForCustomer(text, name) {
  const chunks = splitCustomerChunks(text);
  if (name) {
    const hit = chunks.find((chunk) => chunk.toLowerCase().includes(String(name).toLowerCase()));
    if (hit) return hit;
    if (chunks.length === 1 && !extractName(chunks[0])) return chunks[0];
    return "";
  }
  return chunks.length === 1 ? chunks[0] : "";
}

function extractRate(chunk) {
  const text = String(chunk || "");
  let match = text.match(/(?:rate|rete)\s*[:=]?\s*(\d+(?:\.\d+)?)/i);
  if (match) return Number(match[1]);
  match = text.match(/(\d+(?:\.\d+)?)\s*(?:rs|rupees?)?\s*(?:ka|ki|per)?\s*rate/i);
  if (match) return Number(match[1]);
  return undefined;
}

function extractOpening(chunk) {
  const text = String(chunk || "");
  let match = text.match(/(\d+(?:\.\d+)?)\s*(?:ka|ki)?\s*udh?aar/i);
  if (match) return Number(match[1]);
  match = text.match(/udh?aar\s*[:=]?\s*(\d+(?:\.\d+)?)/i);
  if (match) return Number(match[1]);
  return undefined;
}

function extractPhone(chunk) {
  const match = String(chunk || "").match(/(?:phone|fon|mobile|mob|number|nmbr)\s*[:=]?\s*(\+?\d[\d\s-]{9,16})/i);
  if (!match) return "";
  return match[1].replace(/[^\d+]/g, "");
}

function isCustomerSkip(text) {
  const t = String(text || "").trim().toLowerCase().replace(/[!?.]+$/g, "");
  if (!t) return false;
  return t === "skip" || t.includes("skip") || t.includes("koi customer nahi") || t.includes("customer nahi") || t.includes("customers nahi");
}

function looksLikeAnimal(text) {
  return /\b(gay|gai|gaaye|gaye|bhains|buffalo|doodh\s+diya|doodh\s+di)\b/i.test(String(text || ""));
}

function looksLikeDelivery(text) {
  const raw = String(text || "");
  if (/\b(diye|diya|de\s+diya|becha|bechi|bech[ae]|bheja|bheji|sale)\b/i.test(raw)) return true;
  return /\bko\s+\d+(?:[.,]\d+)?\s*(?:litters?|litres?|liters?|ltr)\b/i.test(raw);
}

function looksLikeOtherEntry(text) {
  return /\b(mazdoori|tankhwah|kharcha|committee|kameti|kumitee|wanda|bhoosa|chara|silage|khal)\b/i.test(String(text || ""));
}

function looksLikeQuestion(text) {
  return /\?|\b(kitna|kitni|kitne|kab|kaun|kya|kis|kyun|kon)\b/i.test(String(text || ""));
}

function isSupplyQuestion(text) {
  return /rozana\s+kitn|kitn[aei]\s+(?:doodh\s+)?let[aei]|har\s+roz\s+kitn|kitna\s+let[aei]|supply\s*type|fixed\s+hai|flexible\s+hai/i.test(
    String(text || "")
  );
}

function knownName(chunk, customers) {
  const hay = String(chunk || "").toLowerCase();
  let best = "";
  for (const customer of customers || []) {
    const name = typeof customer === "string" ? customer : customer.name || customer.customer || customer[0] || "";
    if (name && hay.includes(String(name).toLowerCase()) && String(name).length > best.length) best = String(name);
  }
  return best;
}

function parseCustomersOnboarding(text, refDate) {
  if (isCustomerSkip(text)) return { skip: true, customers: [] };
  const ref = refDate || todayISO(TIMEZONE);
  const customers = [];
  for (const chunk of splitCustomerChunks(text)) {
    if (looksLikeAnimal(chunk)) continue;
    const name = extractName(chunk);
    if (!name) continue;
    const parsed = parseSupplyClause(chunk, ref);
    customers.push({
      name,
      rate_pkr: extractRate(chunk),
      opening_balance: extractOpening(chunk),
      phone: extractPhone(chunk),
      billing_cycle: parsed.billing_cycle || "",
      cycle_start_date: parsed.cycle_start_date || "",
      supply_type: parsed.supply_type || "",
      daily_litres: parsed.supply_type === "fixed" ? parsed.daily_litres : "",
      supply_note: parsed.supply_note || "",
    });
  }
  return { skip: false, customers };
}

function buildOnboardingCustomerEntries(customers, refDate) {
  const ref = refDate || todayISO(TIMEZONE);
  return (customers || []).map((customer) => {
    const type = customer.supply_type === "fixed" || customer.supply_type === "flexible" ? customer.supply_type : "";
    return {
      type: "add_customer",
      customer: customer.name || customer.customer,
      rate_pkr: customer.rate_pkr,
      opening_balance: customer.opening_balance == null ? 0 : customer.opening_balance,
      phone: customer.phone || "",
      billing_cycle: customer.billing_cycle || "daily",
      cycle_start_date: customer.cycle_start_date || ref,
      supply_type: type,
      daily_litres: type === "fixed" ? customer.daily_litres : "",
      supply_note: customer.supply_note || "",
    };
  });
}

function applyCustomerFieldHints(entries, text, refDate) {
  const ref = refDate || todayISO(TIMEZONE);
  const source = String(text || "");
  return (entries || []).map((entry) => {
    if (entry.type === "change_billing_cycle") {
      const clause = clauseForCustomer(source, entry.customer) || source;
      const parsed = parseSupplyClause(clause, ref);
      if (parsed.every_n_days || !parsed.cycle_start_date) return entry;
      return { ...entry, billing_cycle: "monthly", cycle_start_date: parsed.cycle_start_date };
    }
    if (entry.type !== "add_customer" && entry.type !== "customer" && entry.type !== "set_supply") return entry;
    const name = entry.customer || entry.name || "";
    const clause = clauseForCustomer(source, name);
    if (!clause) return sanitizeSupplyEntry(entry);
    const parsed = parseSupplyClause(clause, ref);
    const next = { ...entry };
    if (parsed.supply_type) {
      next.supply_type = parsed.supply_type;
      next.daily_litres = parsed.supply_type === "fixed" ? parsed.daily_litres : "";
      if (parsed.supply_note) next.supply_note = parsed.supply_note;
    }
    if (parsed.cycle_start_date) {
      next.billing_cycle = "monthly";
      next.cycle_start_date = parsed.cycle_start_date;
    } else if (parsed.billing_cycle) {
      next.billing_cycle = parsed.billing_cycle;
    }
    return sanitizeSupplyEntry(next);
  });
}

function sanitizeSupplyEntry(entry) {
  const type = String(entry.supply_type || "").toLowerCase();
  if (type !== "fixed" && type !== "flexible") return entry;
  const next = { ...entry, supply_type: type };
  if (type === "flexible") {
    const litres = cleanLitres(entry.daily_litres);
    if (litres !== "" && !entry.supply_note) next.supply_note = typicalNote(litres);
    next.daily_litres = "";
    return next;
  }
  next.daily_litres = cleanLitres(entry.daily_litres);
  return next;
}

function hasStandingCue(text) {
  const raw = String(text || "");
  if (FIXED_WORD_RE.test(raw) || FLEXIBLE_RE.test(raw)) return true;
  if (!extractLitres(raw).length) return false;
  if (BILLING_WORD_RE.test(raw)) return true;
  const anchor = inferBillingAnchor(raw);
  return Boolean(anchor && anchor.cycle_start_date);
}

function interpretSupply(text, ctx = {}) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  if (looksLikeQuestion(raw)) {
    if (isSupplyQuestion(raw)) return { intent: "query" };
    return null;
  }
  if (looksLikeDelivery(raw) || looksLikeAnimal(raw) || looksLikeOtherEntry(raw)) return null;
  const ref = ctx.today || todayISO(TIMEZONE);
  const entries = [];
  for (const chunk of splitCustomerChunks(raw)) {
    const name = knownName(chunk, ctx.customers) || extractName(chunk);
    if (name && extractLitres(chunk).length && !hasStandingCue(chunk)) return null;
    const parsed = parseSupplyClause(chunk, ref);
    if (!name) continue;
    if (parsed.supply_type && hasStandingCue(chunk)) {
      const entry = {
        type: "set_supply",
        customer: name,
        supply_type: parsed.supply_type,
        daily_litres: parsed.supply_type === "fixed" ? parsed.daily_litres : "",
        supply_note: parsed.supply_note || "",
      };
      if (parsed.billing_cycle) entry.billing_cycle = parsed.billing_cycle;
      if (parsed.cycle_start_date) entry.cycle_start_date = parsed.cycle_start_date;
      entries.push(entry);
    } else if (parsed.cycle_start_date) {
      entries.push({
        type: "change_billing_cycle",
        customer: name,
        billing_cycle: "monthly",
        cycle_start_date: parsed.cycle_start_date,
      });
    }
  }
  if (!entries.length) return null;
  return { intent: "edit", entries };
}

function supplyPhrase(entry, script) {
  const type = String(entry.supply_type || "").toLowerCase();
  const note = entry.supply_note ? `, ${entry.supply_note}` : "";
  if (type === "fixed" && entry.daily_litres !== "" && entry.daily_litres != null) {
    const litres = formatQty(entry.daily_litres);
    return script === "urdu" ? `، روزانہ ${litres} L` : `, rozana ${litres} L`;
  }
  if (type === "flexible") {
    return script === "urdu" ? `، جتنا لے${note}` : `, flexible${note}`;
  }
  return "";
}

function cell(header, row, name) {
  const idx = headerIndex(header, name);
  if (idx === -1) return "";
  return row[idx] == null ? "" : row[idx];
}

function typicalFromNotes(notes) {
  const match = String(notes || "").match(/typical\s+[\d.]+\s*L\/day/i);
  return match ? match[0] : "";
}

function answerSupplyQuestion(question, customers) {
  if (!isSupplyQuestion(question)) return null;
  const header = (customers && customers[0]) || [];
  const q = String(question || "").toLowerCase();
  let row = null;
  let name = "";
  for (const candidate of (customers || []).slice(1)) {
    const who = String(candidate[0] || "");
    if (who && q.includes(who.toLowerCase()) && who.length > name.length) {
      name = who;
      row = candidate;
    }
  }
  if (!row) return null;
  const type = String(cell(header, row, "supply_type") || "").toLowerCase();
  const litres = cell(header, row, "daily_litres");
  const typical = typicalFromNotes(cell(header, row, "notes"));
  if (type === "fixed" && litres !== "" && litres != null) {
    const n = formatQty(litres);
    return tx(`${name} روزانہ ${n} L لیتا ہے (fixed).`, `${name} rozana ${n} L leta hai (fixed).`);
  }
  if (type === "flexible") {
    const extra = typical ? `, ${typical}` : "";
    return tx(
      `${name} flexible ہے${extra}. روزانہ fixed litre نہیں۔`,
      `${name} flexible hai${extra}. Rozana fixed litre nahi.`
    );
  }
  return tx(`${name} کا روزانہ litre ابھی لکھا نہیں۔`, `${name} ka rozana litre abhi likha nahi.`);
}

function supplyContextLines(customers) {
  const header = (customers && customers[0]) || [];
  const lines = [];
  for (const row of (customers || []).slice(1)) {
    if (!row[0]) continue;
    const type = String(cell(header, row, "supply_type") || "").toLowerCase();
    const litres = cell(header, row, "daily_litres");
    const typical = typicalFromNotes(cell(header, row, "notes"));
    if (type === "fixed" && litres !== "" && litres != null) lines.push(`${row[0]} fixed ${formatQty(litres)} L/day`);
    else if (type === "flexible") lines.push(`${row[0]} flexible${typical ? ` ${typical}` : ""}`);
  }
  return lines;
}

module.exports = {
  parseSupplyClause,
  parseCustomersOnboarding,
  buildOnboardingCustomerEntries,
  applyCustomerFieldHints,
  interpretSupply,
  supplyPhrase,
  answerSupplyQuestion,
  supplyContextLines,
  inferBillingAnchor,
};
