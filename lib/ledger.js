function money(n) {
  const num = Number(n) || 0;
  if (Number.isInteger(num)) return String(num);
  return String(Math.round(num * 100) / 100);
}

const { sessionLabel, normalizeSession, sessionFromText } = require("./session");
const { formatRs, formatQty, formatHumanDate, eventLabel, sessionWord, prettyItem, parseSheetDate } = require("./format");
const { tx } = require("./reply");
const { todayISO, TIMEZONE } = require("./config");
const { cycleLabel, normalizeCycle, inferCycleFromText } = require("./billing");
const { sanitizeExpenseEntry, expenseLabel } = require("./expenses");
const { frequencyWord } = require("./committee");

const FODDER_CATEGORY_RE =
  /\b(chara|chaara|charay|wanda|bhoosa|toori|silage|khal|fodder|green fodder|hara chara|khoraak|khurak|feed)\b/i;

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
    else if (/\b(expense|kharcha|mazdoori|tankhwah|bijli|kiraya|marammat)\b/i.test(s)) out.entry_type = "expense";
    else if (/\b(committee|kameti|kumitee)\b/i.test(s)) out.entry_type = "committee_log";
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
      const cycle = inferCycleFromText(
        `${summary || ""} ${entry.billing_cycle || ""} ${entry.unit || ""} ${entry.note || ""}`
      ) || (entry.billing_cycle ? normalizeCycle(entry.billing_cycle) : "");
      return {
        ...entry,
        opening_balance: opening ?? 0,
        rate_pkr: firstNumber(entry.rate_pkr, entry.rate),
        billing_cycle: cycle || entry.billing_cycle,
      };
    }
    if (entry.type === "change_billing_cycle") {
      const cycle =
        inferCycleFromText(
          `${summary || ""} ${entry.billing_cycle || ""} ${entry.unit || ""} ${entry.new_value || ""} ${entry.note || ""}`
        ) || normalizeCycle(entry.billing_cycle);
      return {
        ...entry,
        billing_cycle: cycle,
      };
    }
    if (entry.type === "animal_event" || entry.type === "vet_visit" || entry.type === "vet_appointment") {
      const { normalizeEventType } = require("./animals");
      return {
        ...entry,
        event_type: normalizeEventType(entry.event_type || entry.type),
        cost_pkr: firstNumber(entry.cost_pkr, entry.fee_pkr, entry.amount) ?? entry.cost_pkr,
      };
    }
    return entry;
  });
}

function isFodderCategory(category) {
  return FODDER_CATEGORY_RE.test(String(category || "").trim());
}

function routeFodderEntries(entries) {
  const out = [];
  for (const entry of entries || []) {
    if (entry.type === "fodder") {
      out.push(asFodder(entry));
      continue;
    }
    if (entry.type === "expense" && isFodderCategory(entry.category || entry.item)) {
      const cost = Number(entry.cost_pkr ?? entry.amount) || 0;
      const qty = entry.quantity;
      // Empty "feed" expenses are junk and would double-count fodder on the Dashboard.
      if (!cost && (qty == null || qty === "")) continue;
      out.push(asFodder(entry));
      continue;
    }
    if (entry.type === "expense") {
      const cleaned = sanitizeExpenseEntry(entry);
      if (!cleaned) continue;
      out.push(cleaned);
      continue;
    }
    out.push(entry);
  }
  return out;
}

function isMissingRate(entry) {
  if (!entry || entry.type !== "sale") return false;
  const rate = Number(entry.rate_pkr ?? entry.rate);
  return !Number.isFinite(rate) || rate <= 0;
}

function salePayBit(entry, script) {
  const cash = Number(entry.cash_received) || 0;
  const udhaar = Number(entry.balance_added);
  const udhaarN = Number.isFinite(udhaar) ? udhaar : 0;
  if (udhaarN > 0 && cash > 0) {
    return script === "urdu"
      ? `(نقد ${formatRs(cash)}، ادھار ${formatRs(udhaarN)})`
      : `(nagd ${formatRs(cash)}, udhaar ${formatRs(udhaarN)})`;
  }
  if (udhaarN > 0) {
    return script === "urdu" ? `(ادھار ${formatRs(udhaarN)})` : `(udhaar ${formatRs(udhaarN)})`;
  }
  return script === "urdu" ? "(نقد)" : "(nagd)";
}

function entryLine(entry, script) {
  const urdu = script === "urdu";
  if (entry.type === "milk") {
    const label = sessionWord(entry.session, script) || (urdu ? "دودھ" : "Doodh");
    return `${label}: ${entry.cow_name} ${formatQty(entry.litres)} L`;
  }
  if (entry.type === "sale") {
    const sess = sessionWord(entry.session, script);
    const litres = `${formatQty(entry.litres)} L`;
    const sessBit = sess ? ` ${sess}` : "";
    if (isMissingRate(entry)) {
      return urdu
        ? `${entry.customer}: ${litres}${sessBit}، rate نہیں پتا`
        : `${entry.customer}: ${litres}${sessBit}, rate nahi pata`;
    }
    return `${entry.customer}: ${litres}${sessBit}, ${formatRs(entry.amount)} ${salePayBit(entry, script)}`;
  }
  if (entry.type === "payment") {
    const method = entry.method ? `, ${entry.method}` : "";
    return urdu
      ? `${entry.customer} سے ${formatRs(entry.amount)} وصول${method}`
      : `${entry.customer} se ${formatRs(entry.amount)} wasool${method}`;
  }
  if (entry.type === "expense") {
    const note = entry.note ? ` (${entry.note})` : "";
    const when = entry.date ? `, ${formatHumanDate(entry.date)}` : "";
    const cat = expenseLabel(entry.category, script);
    return urdu
      ? `خرچہ (${cat}): ${formatRs(entry.amount)}${when}${note}`
      : `Kharcha (${cat}): ${formatRs(entry.amount)}${when}${note}`;
  }
  if (entry.type === "setup_committee") {
    const who = entry.organizer ? (urdu ? `، منتظم ${entry.organizer}` : `, organizer ${entry.organizer}`) : "";
    const start = entry.start_date ? `, ${formatHumanDate(entry.start_date)}` : "";
    return urdu
      ? `کمیٹی ${entry.name || "Committee"}: ${frequencyWord(entry.frequency, "urdu")} ${formatRs(entry.amount)}${who}${start}`
      : `Committee ${entry.name || "Committee"}: ${frequencyWord(entry.frequency, "roman")} ${formatRs(entry.amount)}${who}${start}`;
  }
  if (entry.type === "committee_log") {
    const status = entry.status === "not_paid" ? (urdu ? "نہیں دی" : "nahi di")
      : entry.status === "partial" ? (urdu ? "تھوڑی دی" : "thori di")
      : (urdu ? "دی" : "di");
    const amt = entry.status === "not_paid" || entry.amount == null || entry.amount === ""
      ? ""
      : ` ${formatRs(entry.amount)}`;
    const when = entry.date ? `, ${formatHumanDate(entry.date)}` : "";
    return `${entry.committee || "Committee"} committee: ${status}${amt}${when}`;
  }
  if (entry.type === "fodder") {
    const qty =
      entry.quantity != null && entry.quantity !== ""
        ? ` ${formatQty(entry.quantity)}${entry.unit ? ` ${entry.unit}` : ""}`
        : "";
    const supplier = entry.supplier ? `, ${entry.supplier}` : "";
    const item = prettyItem(entry.item);
    return urdu
      ? `چارہ (${item})${qty}: ${formatRs(entry.cost_pkr)}, نقد ${formatRs(entry.cash_paid)}, باقی ${formatRs(entry.balance_owed)}${supplier}`
      : `Chara (${item})${qty}: ${formatRs(entry.cost_pkr)}, nagd ${formatRs(entry.cash_paid)}, baqi ${formatRs(entry.balance_owed)}${supplier}`;
  }
  if (entry.type === "profile") {
    return urdu
      ? `نام: ${entry.name || "-"}\nفارم: ${entry.farm_name || "-"}`
      : `Naam: ${entry.name || "-"}\nFarm: ${entry.farm_name || "-"}`;
  }
  if (entry.type === "add_cow" || entry.type === "cow") {
    const kind = String(entry.animal_type || "").toLowerCase() === "buffalo"
      ? (urdu ? "بھینس" : "bhains")
      : (urdu ? "گائے" : "gay");
    const avg =
      entry.avg_daily_litres != null && entry.avg_daily_litres !== ""
        ? (urdu ? `، روزانہ ${formatQty(entry.avg_daily_litres)} L` : `, rozana ${formatQty(entry.avg_daily_litres)} L`)
        : "";
    return urdu
      ? `نئی ${kind}: ${entry.cow_name || entry.name}${avg}`
      : `Nayi ${kind}: ${entry.cow_name || entry.name}${avg}`;
  }
  if (entry.type === "rename_cow") {
    return urdu
      ? `${entry.cow_name} کا نام ${entry.new_name} ہو جائے گا`
      : `${entry.cow_name} ka naam ${entry.new_name} ho jayega`;
  }
  if (entry.type === "remove_cow") {
    return urdu
      ? `${entry.cow_name} فہرست سے ہٹا دیں گے (پرانا دودھ حساب رہے گا)`
      : `${entry.cow_name} list se hata denge (purana doodh hisab rahega)`;
  }
  if (entry.type === "add_customer" || entry.type === "customer") {
    const name = entry.customer || entry.name;
    const phone = entry.phone ? `, phone ${entry.phone}` : "";
    const cycle = entry.billing_cycle
      ? (urdu ? `، بل ${cycleLabel(entry.billing_cycle)}` : `, bill ${cycleLabel(entry.billing_cycle)}`)
      : "";
    const rateBit = isMissingRate({ ...entry, type: "sale", rate_pkr: entry.rate_pkr })
      ? (urdu ? "rate نہیں پتا" : "rate nahi pata")
      : `rate ${formatRs(entry.rate_pkr)}`;
    return urdu
      ? `کسٹمر ${name}: ${rateBit}، ادھار ${formatRs(entry.opening_balance)}${phone}${cycle}`
      : `Customer ${name}: ${rateBit}, udhaar ${formatRs(entry.opening_balance)}${phone}${cycle}`;
  }
  if (entry.type === "change_rate") {
    return urdu
      ? `${entry.customer} کا rate ${formatRs(entry.rate_pkr)} ہو جائے گا`
      : `${entry.customer} ka rate ${formatRs(entry.rate_pkr)} ho jayega`;
  }
  if (entry.type === "change_billing_cycle") {
    return urdu
      ? `${entry.customer} کا بل اب ${cycleLabel(entry.billing_cycle)} ہو گا`
      : `${entry.customer} ka bill ab ${cycleLabel(entry.billing_cycle)} hoga`;
  }
  if (entry.type === "animal_event" || entry.type === "vet_visit" || entry.type === "vet_appointment") {
    const cow = entry.cow_name || entry.cow || "all";
    const typ = eventLabel(entry.event_type || entry.type, script);
    const extra = [entry.doctor_name, entry.diagnosis, entry.details].filter(Boolean).join(", ");
    const cost = entry.cost_pkr ?? entry.fee_pkr;
    const costBit = cost != null && cost !== ""
      ? (urdu ? `، خرچہ ${formatRs(cost)}` : `, kharcha ${formatRs(cost)}`)
      : "";
    const when = entry.date ? `, ${formatHumanDate(entry.date)}` : "";
    return `${cow}: ${typ}${extra ? ` (${extra})` : ""}${costBit}${when}`;
  }
  if (entry.type === "feed_use") {
    const item = prettyItem(entry.item);
    return urdu
      ? `خوراک استعمال: ${item} ${formatQty(entry.quantity)}${entry.unit ? ` ${entry.unit}` : ""}`
      : `Khoraak use: ${item} ${formatQty(entry.quantity)}${entry.unit ? ` ${entry.unit}` : ""}`;
  }
  if (entry.type === "set_daily_use") {
    const item = prettyItem(entry.item);
    return urdu
      ? `${item} روزانہ استعمال: ${formatQty(entry.daily_use)}${entry.unit ? ` ${entry.unit}` : ""}`
      : `${item} rozana use: ${formatQty(entry.daily_use)}${entry.unit ? ` ${entry.unit}` : ""}`;
  }
  if (entry.type === "feed_stock") {
    const item = prettyItem(entry.item);
    return urdu
      ? `اسٹاک: ${item} ${formatQty(entry.quantity)}${entry.unit ? ` ${entry.unit}` : ""}`
      : `Stock: ${item} ${formatQty(entry.quantity)}${entry.unit ? ` ${entry.unit}` : ""}`;
  }
  if (entry.type === "correct_entry") {
    const who = entry.cow_name || entry.customer || "";
    const when = entry.date ? `${formatHumanDate(entry.date)} ` : "";
    return urdu
      ? `${when}${who} ${entry.entry_type || ""}: ${entry.field || "value"} ${money(entry.old_value)} سے ${money(entry.new_value)}`
      : `${when}${who} ${entry.entry_type || ""}: ${entry.field || "value"} ${money(entry.old_value)} se ${money(entry.new_value)}`;
  }
  if (entry.type === "delete_last") {
    return urdu
      ? `آخری ریکارڈ ہٹا دیں گے${entry.summary ? `: ${entry.summary}` : ""}`
      : `Akhri record hata denge${entry.summary ? `: ${entry.summary}` : ""}`;
  }
  return "";
}

function entryLines(entries, script = "roman") {
  return (entries || []).map((entry) => entryLine(entry, script)).filter(Boolean);
}

function hasMissingSaleRate(entries) {
  return (entries || []).some(isMissingRate);
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
    "change_billing_cycle",
    "profile",
  ]);
  return (entries || []).some((e) => types.has(e.type));
}

function confirmFooter() {
  return tx(
    "ہاں دبائیں تو سیو ہو جائے گا۔ نہیں دبائیں تو کینسل۔ Edit دبائیں تو تبدیلی کریں۔",
    CONFIRM_FOOTER
  );
}

function confirmationText(parsed) {
  const headingU = isEditEntries(parsed.entries) ? "*یہ تبدیلی کروں؟*" : "*یہ ریکارڈ کروں؟*";
  const headingR = isEditEntries(parsed.entries) ? "*Yeh change karun?*" : "*Yeh record karun?*";
  const urduLines = entryLines(parsed.entries, "urdu");
  const romanLines = entryLines(parsed.entries, "roman");
  const rateAskU = hasMissingSaleRate(parsed.entries)
    ? "Rate نہیں پتا۔ کتنا rate ہے؟ Edit دبائیں اور rate لکھ دیں۔"
    : "";
  const rateAskR = hasMissingSaleRate(parsed.entries)
    ? "Rate nahi pata. Kitna rate hai? Edit dabain aur rate likh dein."
    : "";
  const build = (heading, lines, rateAsk, footer) => {
    const parts = [heading];
    if (lines.length) parts.push(lines.join("\n"));
    if (rateAsk) parts.push(rateAsk);
    parts.push(footer);
    return parts.join("\n\n");
  };
  const urdu = build(
    headingU,
    urduLines,
    rateAskU,
    "ہاں دبائیں تو سیو ہو جائے گا۔ نہیں دبائیں تو کینسل۔ Edit دبائیں تو تبدیلی کریں۔"
  );
  const roman = build(headingR, romanLines, rateAskR, CONFIRM_FOOTER);
  return tx(urdu, roman).slice(0, 1024);
}

function savedText(entries) {
  const urduLines = entryLines(entries, "urdu");
  const romanLines = entryLines(entries, "roman");
  const urdu = ["✅ *سیو ہو گیا*", ...urduLines].join("\n");
  const roman = ["✅ *Save ho gaya*", ...romanLines].join("\n");
  return tx(urdu, roman);
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

function askEdit() {
  return tx("کیا تبدیلی کرنی ہے؟", ASK_EDIT);
}

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
  askEdit,
  confirmFooter,
  isMissingRate,
  routeFodderEntries,
  normalizeEditEntries,
  fodderItemName,
  isFodderCategory,
};
