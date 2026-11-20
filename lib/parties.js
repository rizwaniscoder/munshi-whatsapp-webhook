const { todayISO, TIMEZONE, normalizePhone } = require("./config");
const { parseSheetDate } = require("./format");
const { customerLedger, supplierLedger, listCustomers, supplierGroups } = require("./manual");
const { num, round2 } = require("./balances");

const PHOTO_LIMIT = 40000;

function bag(mem, phone) {
  const key = normalizePhone(phone);
  if (!mem._farmerSettings) mem._farmerSettings = {};
  const current = mem._farmerSettings[key] && typeof mem._farmerSettings[key] === "object"
    ? mem._farmerSettings[key]
    : {};
  if (!current.parties || typeof current.parties !== "object") {
    current.parties = { archived: [], banks: [], txns: [], photos: {}, meta: {} };
  }
  const parties = current.parties;
  parties.archived = Array.isArray(parties.archived) ? parties.archived : [];
  parties.banks = Array.isArray(parties.banks) ? parties.banks : [];
  parties.txns = Array.isArray(parties.txns) ? parties.txns : [];
  parties.photos = parties.photos && typeof parties.photos === "object" ? parties.photos : {};
  parties.meta = parties.meta && typeof parties.meta === "object" ? parties.meta : {};
  current.parties = parties;
  mem._farmerSettings[key] = current;
  return parties;
}

function archivedKey(kind, name) {
  return kind + ":" + String(name || "").trim().toLowerCase();
}

function isArchived(parties, kind, name) {
  return parties.archived.includes(archivedKey(kind, name));
}

function clock(iso) {
  const when = iso ? new Date(iso) : new Date();
  if (Number.isNaN(when.getTime())) return "";
  return when.toLocaleString("en-US", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function prettyWhen(date, iso) {
  const day = parseSheetDate(date) || "";
  if (!day && !iso) return "";
  const source = day || String(iso || "").slice(0, 10);
  const [y, m, d] = source.split("-").map(Number);
  if (!y || !m || !d) return source;
  const dt = new Date(Date.UTC(y, m - 1, d));
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  let text = days[dt.getUTCDay()] + ", " + d + " " + months[m - 1] + " " + String(y).slice(2);
  const time = iso ? clock(iso) : "";
  if (time) text += " . " + time;
  return text;
}

function side(balance) {
  const value = round2(balance);
  if (Math.abs(value) < 0.001) return { tone: "zero", label: "", amount: 0 };
  if (value > 0) return { tone: "milne", label: "Milne hain", amount: value };
  return { tone: "dene", label: "Dene hain", amount: round2(-value) };
}

function lastOf(lines) {
  let last = null;
  for (const line of lines || []) {
    if (!line || line.kind === "opening") continue;
    if (!last || String(line.date || "") >= String(last.date || "")) last = line;
  }
  return last;
}

function mapLines(lines, parties, kind) {
  const supplier = kind === "supplier";
  return (lines || []).map((line) => {
    const meta = (parties.meta && parties.meta[line.id]) || {};
    const photo = parties.photos && parties.photos[line.id];
    const gave = supplier ? round2(line.credit || 0) : round2(line.debit || 0);
    const took = supplier ? round2(line.debit || 0) : round2(line.credit || 0);
    return {
      ...line,
      diye: line.diye != null ? line.diye : gave,
      liye: line.liye != null ? line.liye : took,
      note: line.note || meta.note || "",
      when: line.when || prettyWhen(line.date, meta.at),
      has_photo: Boolean(photo),
      photo: photo || "",
    };
  });
}

function bankBalance(bank, txns) {
  let balance = num(bank.opening_balance);
  for (const txn of txns) {
    if (txn.bank_id !== bank.id) continue;
    balance += num(txn.liye) - num(txn.diye);
  }
  return round2(balance);
}

function bankLines(bank, parties) {
  const lines = [{
    id: bank.id,
    kind: "opening",
    date: "",
    label: "Shuruati baqi",
    diye: num(bank.opening_balance) < 0 ? round2(-num(bank.opening_balance)) : 0,
    liye: num(bank.opening_balance) > 0 ? num(bank.opening_balance) : 0,
    debit: num(bank.opening_balance) > 0 ? num(bank.opening_balance) : 0,
    credit: num(bank.opening_balance) < 0 ? round2(-num(bank.opening_balance)) : 0,
    balance: num(bank.opening_balance),
    note: "",
  }];
  let running = num(bank.opening_balance);
  const txns = parties.txns.filter((txn) => txn.bank_id === bank.id)
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const txn of txns) {
    running = round2(running + num(txn.liye) - num(txn.diye));
    lines.push({
      id: txn.id,
      kind: "bank",
      date: txn.date || "",
      label: num(txn.diye) > 0 ? "Diye" : "Liye",
      diye: num(txn.diye),
      liye: num(txn.liye),
      debit: num(txn.liye),
      credit: num(txn.diye),
      balance: running,
      note: txn.note || "",
      when: prettyWhen(txn.date, txn.at),
      has_photo: Boolean(parties.photos[txn.id]),
      photo: parties.photos[txn.id] || "",
    });
  }
  return lines;
}

function shapeParties(store, mem, farmer) {
  const parties = bag(mem, farmer.phone);
  const customers = listCustomers(store, mem).map((row) => {
    const view = side(row.balance);
    return {
      kind: "customer",
      id: row.id,
      name: row.name,
      balance: row.balance,
      tone: view.tone,
      side: view.label,
      show_amount: view.amount,
      phone: row.phone || "",
      rate_pkr: row.rate_pkr,
      opening_balance: row.opening_balance,
      supply_type: row.supply_type || "",
      daily_litres: row.daily_litres,
      billing_cycle: row.billing_cycle || "",
      archived: isArchived(parties, "customer", row.name),
    };
  });
  const suppliers = supplierGroups(store, mem).map((row) => {
    const view = side(-row.balance_owed);
    return {
      kind: "supplier",
      id: row.id,
      name: row.name,
      balance: round2(-row.balance_owed),
      owed: row.balance_owed,
      tone: view.tone,
      side: view.label,
      show_amount: view.amount,
      opening_balance: row.opening_balance,
      archived: isArchived(parties, "supplier", row.name),
    };
  });
  const banks = parties.banks.map((bank) => {
    const balance = bankBalance(bank, parties.txns);
    const view = side(balance);
    const txns = parties.txns.filter((txn) => txn.bank_id === bank.id);
    const last = txns[txns.length - 1];
    return {
      kind: "bank",
      id: bank.id,
      name: bank.name,
      balance,
      tone: view.tone,
      side: view.label,
      show_amount: view.amount,
      opening_balance: num(bank.opening_balance),
      archived: Boolean(bank.archived) || isArchived(parties, "bank", bank.id),
      last_date: last ? last.date : "",
      last_at: last ? last.at : "",
      when: last ? prettyWhen(last.date, last.at) : "",
    };
  });
  let milne = 0;
  let dene = 0;
  for (const row of [...customers, ...suppliers, ...banks]) {
    if (row.archived) continue;
    if (row.balance > 0) milne += row.balance;
    if (row.balance < 0) dene += -row.balance;
  }
  return {
    ok: true,
    milne: round2(milne),
    dene: round2(dene),
    customers,
    suppliers,
    banks,
  };
}

function remember(parties, id, note, photo) {
  if (!id) return { ok: false, status: 400, error: "Record nahi mila." };
  parties.meta[id] = { at: new Date().toISOString(), note: String(note || "") };
  if (photo) {
    if (String(photo).length > PHOTO_LIMIT) return { ok: false, status: 400, error: "Photo chhoti rakhein." };
    parties.photos[id] = String(photo);
  }
  return null;
}

function mutateParty(store, mem, body, farmer) {
  const parties = bag(mem, farmer.phone);
  const op = String((body && body.op) || "");
  if (op === "archive" || op === "unarchive") {
    const kind = String(body.kind || "");
    const name = String(body.name || body.id || "").trim();
    if (!kind || !name) return { ok: false, status: 400, error: "Party ka naam likhein." };
    const key = kind === "bank" ? archivedKey("bank", body.id || name) : archivedKey(kind, name);
    parties.archived = parties.archived.filter((item) => item !== key);
    if (op === "archive") parties.archived.push(key);
    if (kind === "bank") {
      const bank = parties.banks.find((item) => item.id === (body.id || name));
      if (bank) bank.archived = op === "archive";
    }
    return { ok: true };
  }
  if (op === "bank") {
    const name = String(body.name || "").trim();
    if (!name) return { ok: false, status: 400, error: "Account ka naam likhein." };
    if (body.id) {
      const bank = parties.banks.find((item) => item.id === body.id);
      if (!bank) return { ok: false, status: 400, error: "Account nahi mila." };
      bank.name = name;
      if (body.opening_balance != null && body.opening_balance !== "") bank.opening_balance = num(body.opening_balance);
      return { ok: true, id: bank.id };
    }
    const bank = {
      id: "bank:" + Date.now().toString(36),
      name,
      opening_balance: num(body.opening_balance),
      archived: false,
    };
    parties.banks.push(bank);
    return { ok: true, id: bank.id };
  }
  if (op === "bank_entry") {
    const bank = parties.banks.find((item) => item.id === body.id || item.name === body.name);
    if (!bank) return { ok: false, status: 400, error: "Account nahi mila." };
    const amount = num(body.amount);
    if (!(amount > 0)) return { ok: false, status: 400, error: "Raqam likhein." };
    const diye = body.direction === "liye" ? 0 : amount;
    const txn = {
      id: "txn:" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      bank_id: bank.id,
      date: parseSheetDate(body.date) || todayISO(TIMEZONE),
      note: String(body.note || ""),
      diye,
      liye: body.direction === "liye" ? amount : 0,
      at: new Date().toISOString(),
    };
    const photoError = remember(parties, txn.id, txn.note, body.photo);
    if (photoError) return photoError;
    parties.txns.push(txn);
    return { ok: true, id: txn.id };
  }
  return { ok: false, status: 400, error: "Yeh kaam theek nahi." };
}

function attachMeta(parties, result) {
  if (!result || result.ok === false) return result;
  result.lines = mapLines(result.lines, parties, result.kind);
  const last = [...(result.lines || [])].reverse().find((line) => line.kind !== "opening");
  result.when = last ? (last.when || prettyWhen(last.date, "")) : "";
  return result;
}

function ledgerFor(store, mem, farmer, kind, name) {
  const parties = bag(mem, farmer.phone);
  if (kind === "bank") {
    const bank = parties.banks.find((item) => item.id === name || item.name === name);
    if (!bank) return { ok: false, status: 400, error: "Account nahi mila." };
    const lines = bankLines(bank, parties);
    return {
      ok: true,
      kind: "bank",
      name: bank.name,
      id: bank.id,
      balance: bankBalance(bank, parties.txns),
      lines,
      when: (lines[lines.length - 1] && lines[lines.length - 1].when) || "",
    };
  }
  if (kind === "supplier") return attachMeta(parties, supplierLedger(store, mem, name));
  return attachMeta(parties, customerLedger(store, mem, name));
}

function pdfEscape(value) {
  return String(value || "").replace(/[^\x20-\x7e]/g, " ").replace(/[()\\]/g, " ");
}

function ledgerPdf(rows) {
  const commands = ["BT", "/F1 11 Tf", "40 800 Td"];
  rows.slice(0, 60).forEach((line, index) => {
    if (index) commands.push("0 -14 Td");
    commands.push("(" + pdfEscape(line).slice(0, 90) + ") Tj");
  });
  commands.push("ET");
  const stream = commands.join("\n");
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
    "2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj\n",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n",
    "4 0 obj << /Length " + stream.length + " >> stream\n" + stream + "\nendstream\nendobj\n",
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n",
  ];
  let pdf = "%PDF-1.1\n";
  const xref = [0];
  for (const object of objects) {
    xref.push(pdf.length);
    pdf += object;
  }
  const start = pdf.length;
  pdf += "xref\n0 " + xref.length + "\n";
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i < xref.length; i++) pdf += String(xref[i]).padStart(10, "0") + " 00000 n \n";
  pdf += "trailer << /Size " + xref.length + " /Root 1 0 R >>\nstartxref\n" + start + "\n%%EOF";
  return Buffer.from(pdf);
}

function exportLines(store, mem, farmer) {
  const data = shapeParties(store, mem, farmer);
  const lines = [
    "Munshi khata",
    "Aap ko milne hain Rs " + data.milne,
    "Aap ne dene hain Rs " + data.dene,
    "",
  ];
  for (const row of [...data.customers, ...data.suppliers, ...data.banks]) {
    if (row.archived) continue;
    lines.push(row.kind + " " + row.name + " Rs " + row.show_amount + " " + (row.side || "zero"));
  }
  return lines;
}

module.exports = {
  PHOTO_LIMIT,
  shapeParties,
  mutateParty,
  ledgerFor,
  ledgerPdf,
  exportLines,
  prettyWhen,
  remember,
  bag,
  lastOf,
};
