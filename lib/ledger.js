function money(n) {
  const num = Number(n) || 0;
  if (Number.isInteger(num)) return String(num);
  return String(Math.round(num * 100) / 100);
}

const { sessionLabel } = require("./session");
const { todayISO, TIMEZONE } = require("./config");

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

function firstNumber(...vals) {
  for (const v of vals) {
    if (v == null || v === "") continue;
    const n = Number(String(v).replace(/[^0-9.-]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function inferCorrectionFromText(text) {
  const s = String(text || "");
  const patterns = [
    /(\d+(?:\.\d+)?)\s*(?:l(?:itre)?s?)?\s+nahi\s+(\d+(?:\.\d+)?)/i,
    /(\d+(?:\.\d+)?)\s+se\s+(?:(?:badal|theek|update|change)\s+\S+\s+)?(\d+(?:\.\d+)?)/i,
    /(\d+(?:\.\d+)?)[^\d]{0,40}(?:nahi|se|badal|theek)[^\d]{0,40}(\d+(?:\.\d+)?)/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return { old: Number(m[1]), neu: Number(m[2]) };
  }
  return null;
}

function inferOpeningFromText(text) {
  const s = String(text || "");
  const patterns = [
    /(\d+(?:\.\d+)?)\s*(?:rs|pkr)?\s*(?:udhaar|opening)/i,
    /(?:udhaar|opening(?:\s+balance)?)\s*(?:ke sath|of|:)?\s*(\d+(?:\.\d+)?)/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

function addDaysISO(iso, days) {
  const [y, m, d] = String(iso).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function inferCorrectionMeta(entry, text) {
  const s = String(text || "");
  const out = { ...entry };
  if (!out.entry_type) {
    if (/doodh|litre|gay|bhains/i.test(s)) out.entry_type = "milk";
    else if (/\b(sale|becha|farokht|customer ko)\b/i.test(s)) out.entry_type = "sale";
    else if (/\b(payment|wasool|jama)\b/i.test(s)) out.entry_type = "payment";
    else if (/\b(chara|wanda|bhoosa|fodder|khal|silage)\b/i.test(s)) out.entry_type = "fodder";
    else if (/\b(expense|kharcha)\b/i.test(s)) out.entry_type = "expense";
  }
  out.entry_type = out.entry_type || out.target_type || "milk";
  if (!out.field) {
    out.field = out.entry_type === "milk" ? "litres" : "amount";
  }
  if (!out.date) {
    if (/\bkal\b/i.test(s)) out.date = addDaysISO(todayISO(TIMEZONE), -1);
    else if (/\baaj\b/i.test(s) || out.entry_type === "milk") out.date = todayISO(TIMEZONE);
  }
  if (!out.cow_name) {
    const stop = /^(aaj|kal|ka|ki|ke|the|ek|nayi|naya|us|is)$/i;
    const patterns = [
      /([A-Za-z][A-Za-z0-9]*)\s+ka\s+doodh/i,
      /([A-Za-z][A-Za-z0-9]*)\s+ka\s+(?:aaj|kal)\s+ka\s+doodh/i,
      /\b(?:gay|bhains)\s+([A-Za-z][A-Za-z0-9]+)/i,
    ];
    for (const re of patterns) {
      const m = s.match(re);
      if (m && !stop.test(m[1])) {
        out.cow_name = m[1].trim();
        break;
      }
    }
  }
  if (!out.customer) {
    const m = s.match(/([A-Za-z][A-Za-z0-9]*)\s+(?:ki|ka)\s+(?:sale|bill|udhaar|payment|rate)/i);
    if (m) out.customer = m[1];
  }
  return out;
}

function normalizeEditEntries(entries, summary) {
  return (entries || []).map((entry) => {
    if (entry.type === "correct_entry") {
      const enriched = inferCorrectionMeta(entry, summary);
      let oldVal = firstNumber(enriched.old_value, enriched.oldValue, enriched.old_litres, enriched.old_amount);
      let newVal = firstNumber(
        enriched.new_value,
        enriched.newValue,
        enriched.new_litres,
        enriched.new_amount
      );
      if (newVal == null || oldVal == null) {
        const inferred = inferCorrectionFromText(`${summary || ""} ${enriched.note || ""}`);
        if (inferred) {
          if (oldVal == null) oldVal = inferred.old;
          if (newVal == null) newVal = inferred.neu;
        }
      }
      if (newVal == null && enriched.field === "litres") {
        newVal = firstNumber(enriched.rate_pkr);
      }
      return {
        ...enriched,
        old_value: oldVal,
        new_value: newVal,
      };
    }
    if (entry.type === "add_customer" || entry.type === "customer") {
      let opening = firstNumber(entry.opening_balance, entry.udhaar, entry.opening);
      if (opening == null || opening === 0) {
        const inferred = inferOpeningFromText(`${summary || ""} ${entry.note || ""}`);
        if (inferred != null) opening = inferred;
      }
      return {
        ...entry,
        opening_balance: opening ?? 0,
        rate_pkr: firstNumber(entry.rate_pkr, entry.rate),
      };
    }
    return entry;
  });
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
    } else if (entry.type === "profile") {
      lines.push(`- Naam: ${entry.name || "-"}`);
      lines.push(`- Farm: ${entry.farm_name || "-"}`);
    } else if (entry.type === "add_cow" || (entry.type === "cow" && (entry.animal_type || entry.avg_daily_litres))) {
      const kind = String(entry.animal_type || "").toLowerCase() === "buffalo" ? "bhains" : "gay";
      const avg =
        entry.avg_daily_litres != null && entry.avg_daily_litres !== ""
          ? `, rozana ${money(entry.avg_daily_litres)} L`
          : "";
      lines.push(`- Nayi ${kind}: ${entry.cow_name || entry.name}${avg}`);
    } else if (entry.type === "rename_cow") {
      lines.push(`- ${entry.cow_name} ka naam ${entry.new_name} ho jayega`);
    } else if (entry.type === "remove_cow") {
      lines.push(`- ${entry.cow_name} list se hata denge (purana doodh hisab rahega)`);
    } else if (entry.type === "add_customer" || entry.type === "customer") {
      const name = entry.customer || entry.name;
      const phone = entry.phone ? `, phone ${entry.phone}` : "";
      lines.push(
        `- Customer ${name}: rate ${money(entry.rate_pkr)}, udhaar ${money(entry.opening_balance)}${phone}`
      );
    } else if (entry.type === "change_rate") {
      lines.push(`- ${entry.customer} ka rate ${money(entry.rate_pkr)} ho jayega`);
    } else if (entry.type === "correct_entry") {
      const who = entry.cow_name || entry.customer || "";
      lines.push(
        `- ${entry.date || ""} ${who} ${entry.entry_type || ""}: ${entry.field || "value"} ${money(entry.old_value)} se ${money(entry.new_value)}`
      );
    } else if (entry.type === "delete_last") {
      lines.push(`- Akhri record hata denge${entry.summary ? `: ${entry.summary}` : ""}`);
    }
  }
  return lines;
}

function isEditEntries(entries) {
  const types = new Set([
    "rename_cow",
    "remove_cow",
    "change_rate",
    "correct_entry",
    "delete_last",
    "add_cow",
    "add_customer",
    "profile",
  ]);
  return (entries || []).some((e) => types.has(e.type));
}

function confirmationText(parsed) {
  const lines = entryLines(parsed.entries);
  const summary = (parsed.summary || "").trim();
  const heading = isEditEntries(parsed.entries) ? "Yeh change karun?" : "Yeh record karun?";
  const parts = [heading];
  if (summary) parts.push(summary);
  if (lines.length) parts.push(lines.join("\n"));
  parts.push(CONFIRM_FOOTER);
  return parts.join("\n\n").slice(0, 1024);
}

function savedText(entries) {
  const counts = {
    milk: 0,
    sale: 0,
    payment: 0,
    expense: 0,
    cow: 0,
    fodder: 0,
    add_cow: 0,
    add_customer: 0,
    rename_cow: 0,
    remove_cow: 0,
    change_rate: 0,
    correct_entry: 0,
    delete_last: 0,
  };
  for (const entry of entries || []) {
    const t = entry.type === "customer" ? "add_customer" : entry.type;
    if (counts[t] != null) counts[t] += 1;
  }
  const bits = [];
  if (counts.milk) bits.push(`${counts.milk} doodh`);
  if (counts.sale) bits.push(`${counts.sale} sale`);
  if (counts.payment) bits.push(`${counts.payment} payment`);
  if (counts.expense) bits.push(`${counts.expense} kharcha`);
  if (counts.fodder) bits.push(`${counts.fodder} chara`);
  if (counts.cow || counts.add_cow) bits.push(`${counts.cow + counts.add_cow} gay`);
  if (counts.add_customer) bits.push(`${counts.add_customer} customer`);
  if (counts.rename_cow) bits.push("naam change");
  if (counts.remove_cow) bits.push("gay hatai");
  if (counts.change_rate) bits.push("rate change");
  if (counts.correct_entry) bits.push("correction");
  if (counts.delete_last) bits.push("akhri record hataya");
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

const CONFIRM_FOOTER =
  "Haan dabain to save ho jayega. Nahi dabain to cancel. Edit dabain to tabdeeli karein.";

const ASK_EDIT = "Kya tabdeeli karni hai?";

function isEditText(text) {
  const t = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[!?.]+$/g, "");
  if (!t) return false;
  if (
    [
      "edit",
      "tabdeeli",
      "tabdeeli karni",
      "tabdeeli karo",
      "edit / tabdeeli",
      "edit/tabdeeli",
      "edit karo",
      "edit kardo",
      "badlo",
      "change",
    ].includes(t)
  ) {
    return true;
  }
  return /^(edit|tabdeeli)\b/.test(t);
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
  isEditText,
  isDeleteRequest,
  CONFIRM_FOOTER,
  ASK_EDIT,
  routeFodderEntries,
  normalizeEditEntries,
};
