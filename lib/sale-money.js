const { normalizeSession } = require("./session");

function num(value) {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(",", ".").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function positive(value) {
  const n = num(value);
  return n != null && n > 0 ? n : null;
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function textWindow(text, customer) {
  const src = String(text || "");
  const name = String(customer || "").trim();
  if (!name) return src;
  const hay = src.toLowerCase();
  let at = hay.indexOf(name.toLowerCase());
  if (at === -1) {
    const first = name.toLowerCase().split(/\s+/).find((part) => part.length >= 4);
    if (first) at = hay.indexOf(first);
  }
  if (at === -1) return src;
  return src.slice(Math.max(0, at - 12), at + name.length + 96);
}

function explicitSaleRate(text, entry) {
  const window = textWindow(text, entry && entry.customer);
  const litres = Number(entry && entry.litres);
  const corrected = window.match(/(?:rate|rete|ریٹ)\s*(\d+(?:[.,]\d+)?)\s*nahi\s*(\d+(?:[.,]\d+)?)/i);
  if (corrected) return positive(corrected[2]);
  const patterns = [
    /(?:rate|rete|ریٹ|bhao|bhaw|bhaav|keemat|qeemet|price)\s*[:=]?\s*(\d+(?:[.,]\d+)?)/i,
    /(\d+(?:[.,]\d+)?)\s*(?:ka\s+|ki\s+)?(?:rate|rete|ریٹ)\b/i,
    /(?:rs\.?|rupees?|rupay(?:e)?|pkr)\s*[:=]?\s*(\d+(?:[.,]\d+)?)/i,
    /(\d+(?:[.,]\d+)?)\s*(?:rs\.?|rupees?|rupay(?:e)?|pkr)\b/i,
    /(\d+(?:[.,]\d+)?)\s*(?:per\s+lit(?:re|er)|\/\s*l)\b/i,
    /@\s*(\d+(?:[.,]\d+)?)/,
  ];
  for (const re of patterns) {
    const match = window.match(re);
    const rate = match && positive(match[1]);
    if (rate) return rate;
  }
  const ka = window.match(/(\d+(?:[.,]\d+)?)\s*ka\b/i);
  const loose = ka && positive(ka[1]);
  if (loose && loose !== litres) return loose;
  return null;
}

function saysCash(text) {
  return /\b(nagd|naqd|naqad|cash|wasool)\b/i.test(String(text || ""));
}

function saysUdhaar(text) {
  return /\b(udhaar|udhar|baqi|credit)\b/i.test(String(text || ""));
}

function explicitCashAmount(text, amount, litres, rate) {
  const patterns = [
    /(?:nagd|naqd|naqad|cash|wasool)\s*[:=]?\s*(\d+(?:[.,]\d+)?)/i,
    /(\d+(?:[.,]\d+)?)\s*(?:nagd|naqd|naqad|cash|wasool)\b/i,
  ];
  for (const re of patterns) {
    const match = String(text || "").match(re);
    const cash = match && positive(match[1]);
    if (!cash) continue;
    if (cash === litres || cash === rate) continue;
    if (cash <= amount) return cash;
  }
  return null;
}

function storedRate(customers, name) {
  const header = (customers && customers[0]) || [];
  let rateIdx = header.findIndex((cell) => String(cell || "").toLowerCase() === "rate_pkr");
  if (rateIdx === -1) rateIdx = 2;
  const wanted = String(name || "").trim().toLowerCase();
  if (!wanted) return null;
  const rows = (customers || []).slice(1).filter((row) => String(row[0] || "").trim());
  const exact = rows.find((row) => String(row[0]).trim().toLowerCase() === wanted);
  if (exact) return positive(exact[rateIdx]);
  const partial = rows.filter((row) => {
    const have = String(row[0]).trim().toLowerCase();
    return have.includes(wanted) || wanted.includes(have);
  });
  if (partial.length === 1) return positive(partial[0][rateIdx]);
  return null;
}

function blankSale(entry) {
  return {
    ...entry,
    rate_pkr: "",
    amount: "",
    cash_received: "",
    balance_added: "",
  };
}

function paymentSplit(entry, text, amount, litres, rate) {
  const mode = String(entry.pay_mode || "").toLowerCase();
  if (mode === "nagd" || mode === "cash") return { cash: amount, balance: 0 };
  if (mode === "udhaar" || mode === "udhar") return { cash: 0, balance: amount };
  if (entry.cash_explicit) {
    const stated = num(entry.cash_received);
    const cash = stated == null ? 0 : Math.min(Math.max(stated, 0), amount);
    return { cash, balance: roundMoney(amount - cash) };
  }
  const window = textWindow(text, entry.customer);
  const partial = explicitCashAmount(window, amount, litres, rate);
  if (partial != null) return { cash: partial, balance: roundMoney(amount - partial) };
  if (saysCash(window) && !saysUdhaar(window)) return { cash: amount, balance: 0 };
  return { cash: 0, balance: amount };
}

function deriveSaleEntry(entry, customers, text) {
  if (!entry || entry.type !== "sale") return entry;
  const litres = Number(entry.litres);
  if (!Number.isFinite(litres) || litres <= 0) return entry;
  let rate = null;
  if (entry.rate_explicit) rate = positive(entry.rate_pkr);
  if (!rate) rate = explicitSaleRate(text, entry);
  if (!rate) rate = storedRate(customers, entry.customer);
  if (!rate) return blankSale(entry);
  const amount = roundMoney(litres * rate);
  const pay = paymentSplit(entry, text, amount, litres, rate);
  return {
    ...entry,
    rate_pkr: rate,
    amount,
    cash_received: pay.cash,
    balance_added: pay.balance,
  };
}

function deriveSaleEntries(entries, { customers, text } = {}) {
  return (entries || []).map((entry) => deriveSaleEntry(entry, customers || [], text || ""));
}

function applyOnePatch(entry, patch) {
  const next = { ...entry };
  const type = entry.type;
  if (type === "milk" || type === "sale") {
    if (patch.litres != null && patch.litres !== "") {
      const litres = Number(patch.litres);
      if (!Number.isFinite(litres) || litres <= 0) return { error: "Litre theek nahi." };
      next.litres = litres;
    }
    if (patch.session != null) next.session = normalizeSession(patch.session);
  }
  if (type === "milk" && patch.cow_name != null) {
    const name = String(patch.cow_name || "").trim().slice(0, 80);
    if (!name) return { error: "Gay ka naam likhein." };
    next.cow_name = name;
  }
  if (type === "sale") {
    if (patch.customer != null) {
      const name = String(patch.customer || "").trim().slice(0, 80);
      if (!name) return { error: "Grahak ka naam likhein." };
      next.customer = name;
    }
    if (patch.rate_pkr != null && String(patch.rate_pkr).trim() !== "") {
      const rate = Number(patch.rate_pkr);
      if (!Number.isFinite(rate) || rate <= 0) return { error: "Rate theek nahi." };
      next.rate_pkr = rate;
      next.rate_explicit = true;
    }
    if (patch.pay === "nagd" || patch.pay === "udhaar") next.pay_mode = patch.pay;
  }
  if ((type === "expense" || type === "payment" || type === "fodder") && patch.amount != null && patch.amount !== "") {
    const amount = Number(patch.amount);
    if (!Number.isFinite(amount) || amount < 0) return { error: "Raqam theek nahi." };
    next.amount = amount;
    if (type === "fodder") next.cost_pkr = amount;
  }
  return { entry: next };
}

function applyEntryPatches(entries, patches) {
  const existing = entries || [];
  const list = Array.isArray(patches) ? patches : [];
  if (!existing.length || list.length !== existing.length) {
    return { error: "Pending fields mukammal nahi." };
  }
  const next = [];
  for (let i = 0; i < existing.length; i++) {
    const patch = list[i] || {};
    if (patch.index != null && Number(patch.index) !== i) return { error: "Pending fields mukammal nahi." };
    const updated = applyOnePatch(existing[i], patch);
    if (updated.error) return updated;
    next.push(updated.entry);
  }
  return { entries: next };
}

module.exports = {
  explicitSaleRate,
  deriveSaleEntry,
  deriveSaleEntries,
  applyEntryPatches,
  storedRate,
};
