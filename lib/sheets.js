const fs = require("fs");
const path = require("path");
const { nowISO, todayISO, TIMEZONE } = require("./config");
const { routeFodderEntries } = require("./ledger");

function daysAgoISO(days) {
  const [y, m, d] = todayISO(TIMEZONE).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10);
}

function parseAmount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value == null || value === "") return 0;
  const n = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function emptyStore() {
  return {
    Cows: [
      ["cow_id", "name", "breed", "status", "notes"],
      ["C-001", "Gori", "Sahiwal", "milking", ""],
      ["C-002", "Kali", "Friesian cross", "milking", ""],
      ["C-003", "Rani", "Sahiwal", "milking", ""],
      ["C-004", "Moti", "Cholistani", "milking", ""],
      ["C-005", "Champi", "Jersey cross", "milking", ""],
      ["C-006", "Sundri", "Sahiwal", "milking", ""],
      ["C-007", "Lali", "Local mixed", "milking", ""],
    ],
    Milk_Log: [["date", "session", "cow_name", "litres", "source_note"]],
    Sales: [[
      "date",
      "customer",
      "litres",
      "rate_pkr",
      "amount",
      "cash_received",
      "balance_added",
      "source_note",
    ]],
    Customers: [
      ["name", "phone", "opening_balance", "current_balance"],
      ["Aslam", "", 0, 0],
      ["Bashir", "", 0, 0],
      ["Hotel Mehran", "", 0, 0],
    ],
    Payments: [["date", "customer", "amount", "method"]],
    Expenses: [["date", "category", "amount", "note"]],
    Fodder: [[
      "date",
      "item",
      "quantity",
      "unit",
      "cost_pkr",
      "supplier",
      "cash_paid",
      "balance_owed",
      "source_note",
    ]],
    Pending: [["sender", "created_at", "language", "entries_json", "status", "message_id"]],
    Processed_Ids: [["message_id", "received_at", "sender"]],
  };
}

class MemorySheets {
  constructor(filePath) {
    this.filePath = filePath || "";
    this.store = emptyStore();
    if (this.filePath && fs.existsSync(this.filePath)) {
      try {
        this.store = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      } catch (err) {
        console.error("failed to load local sheet file", err.message);
      }
    }
    if (!this.store.Fodder) {
      this.store.Fodder = emptyStore().Fodder;
    }
  }

  persist() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.store, null, 2));
  }

  async ping() {
    return { ok: true, mode: this.filePath ? "file" : "memory" };
  }

  async getContext() {
    const cows = this.store.Cows.slice(1).map((r) => r[1]).filter(Boolean);
    const customers = this.store.Customers.slice(1).map((r) => r[0]).filter(Boolean);
    return { ok: true, cows, customers };
  }

  async isProcessed(messageId) {
    return {
      ok: true,
      processed: this.store.Processed_Ids.slice(1).some((r) => r[0] === messageId),
    };
  }

  async markProcessed(messageId, sender) {
    if (this.store.Processed_Ids.slice(1).some((r) => r[0] === messageId)) {
      return { ok: true, already: true };
    }
    this.store.Processed_Ids.push([messageId, nowISO(), sender || ""]);
    this.persist();
    return { ok: true };
  }

  async setPending({ sender, language, entries, messageId }) {
    const rows = this.store.Pending;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === sender && rows[i][4] === "pending") {
        rows[i][4] = "superseded";
      }
    }
    rows.push([
      sender,
      nowISO(),
      language || "roman_urdu",
      JSON.stringify(entries || []),
      "pending",
      messageId || "",
    ]);
    this.persist();
    return { ok: true };
  }

  async getPending(sender) {
    const rows = this.store.Pending;
    for (let i = rows.length - 1; i >= 1; i--) {
      if (rows[i][0] === sender && rows[i][4] === "pending") {
        return {
          ok: true,
          pending: {
            sender: rows[i][0],
            created_at: rows[i][1],
            language: rows[i][2],
            entries: JSON.parse(rows[i][3] || "[]"),
            status: rows[i][4],
            message_id: rows[i][5],
          },
        };
      }
    }
    return { ok: true, pending: null };
  }

  async clearPending(sender, status) {
    const rows = this.store.Pending;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === sender && rows[i][4] === "pending") {
        rows[i][4] = status || "cancelled";
      }
    }
    this.persist();
    return { ok: true };
  }

  nextCowId() {
    let max = 0;
    for (const row of this.store.Cows.slice(1)) {
      const m = String(row[0] || "").match(/(\d+)/);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `C-${String(max + 1).padStart(3, "0")}`;
  }

  upsertCustomer(name, phone, delta) {
    const rows = this.store.Customers;
    const idx = rows.findIndex(
      (r, i) => i > 0 && String(r[0]).toLowerCase() === String(name).toLowerCase()
    );
    if (idx === -1) {
      rows.push([name, phone || "", 0, delta || 0]);
      return;
    }
    if (phone) rows[idx][1] = phone;
    rows[idx][3] = parseAmount(rows[idx][3]) + (delta || 0);
  }

  async commitRecords({ sender, entries, sourceNote }) {
    const note = sourceNote || `WhatsApp ${sender}`;
    entries = routeFodderEntries(entries);
    for (const entry of entries || []) {
      if (entry.type === "milk") {
        this.store.Milk_Log.push([
          entry.date,
          entry.session || "",
          entry.cow_name,
          entry.litres,
          entry.note || note,
        ]);
      } else if (entry.type === "sale") {
        this.store.Sales.push([
          entry.date,
          entry.customer,
          entry.litres,
          entry.rate_pkr,
          entry.amount,
          entry.cash_received,
          entry.balance_added,
          entry.note || note,
        ]);
        this.upsertCustomer(entry.customer, "", parseAmount(entry.balance_added));
      } else if (entry.type === "payment") {
        this.store.Payments.push([
          entry.date,
          entry.customer,
          entry.amount,
          entry.method || "",
        ]);
        this.upsertCustomer(entry.customer, "", -parseAmount(entry.amount));
      } else if (entry.type === "expense") {
        this.store.Expenses.push([
          entry.date,
          entry.category,
          entry.amount,
          entry.note || note,
        ]);
      } else if (entry.type === "cow") {
        const exists = this.store.Cows.slice(1).some(
          (r) => String(r[1]).toLowerCase() === String(entry.cow_name).toLowerCase()
        );
        if (!exists) {
          this.store.Cows.push([
            this.nextCowId(),
            entry.cow_name,
            entry.breed || "",
            entry.status || "milking",
            entry.notes || note,
          ]);
        }
      } else if (entry.type === "fodder") {
        this.store.Fodder.push([
          entry.date,
          entry.item,
          entry.quantity ?? "",
          entry.unit || "",
          entry.cost_pkr,
          entry.supplier || "",
          entry.cash_paid,
          entry.balance_owed,
          entry.note || note,
        ]);
      }
    }
    await this.clearPending(sender, "saved");
    this.persist();
    return { ok: true, saved: (entries || []).length };
  }

  async readRecent(days = 30) {
    const cutoff = daysAgoISO(days);
    const filterDated = (rows, dateIdx) => {
      const header = rows[0];
      const body = rows.slice(1).filter((r) => String(r[dateIdx] || "") >= cutoff);
      return [header, ...body];
    };
    return {
      ok: true,
      cows: this.store.Cows,
      customers: this.store.Customers,
      milk: filterDated(this.store.Milk_Log, 0),
      sales: filterDated(this.store.Sales, 0),
      payments: filterDated(this.store.Payments, 0),
      expenses: filterDated(this.store.Expenses, 0),
      fodder: filterDated(this.store.Fodder, 0),
    };
  }
}

class AppsScriptSheets {
  constructor(url, secret) {
    this.url = url;
    this.secret = secret;
  }

  async call(action, payload = {}) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: this.secret, action, ...payload }),
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Sheets gateway returned non-JSON (HTTP ${res.status})`);
    }
    if (!res.ok || body.ok === false) {
      throw new Error(body.error || `Sheets gateway HTTP ${res.status}`);
    }
    return body;
  }

  ping() {
    return this.call("ping");
  }
  getContext() {
    return this.call("getContext");
  }
  isProcessed(messageId) {
    return this.call("isProcessed", { messageId });
  }
  markProcessed(messageId, sender) {
    return this.call("markProcessed", { messageId, sender });
  }
  setPending(args) {
    return this.call("setPending", args);
  }
  getPending(sender) {
    return this.call("getPending", { sender });
  }
  clearPending(sender, status) {
    return this.call("clearPending", { sender, status });
  }
  commitRecords(args) {
    return this.call("commitRecords", args);
  }
  readRecent(days = 30) {
    return this.call("readRecent", { days });
  }
}

function createSheets() {
  const url = (process.env.SHEETS_WEBHOOK_URL || "").trim();
  const secret = (process.env.SHEETS_SECRET || "").trim();
  if (url) {
    if (!secret) throw new Error("SHEETS_SECRET is required when SHEETS_WEBHOOK_URL is set");
    console.log("sheets backend: apps script");
    return new AppsScriptSheets(url, secret);
  }
  const filePath = (process.env.MUNSHI_SHEETS_FILE || "").trim();
  console.log(
    "sheets backend:",
    filePath ? `local file (ledger gateway not configured)` : "memory (ledger gateway not configured)"
  );
  return new MemorySheets(filePath);
}

function formatLedgerData(data) {
  const section = (title, rows) => {
    if (!rows || !rows.length) return `${title}: (empty)`;
    return `${title}:\n` + rows.map((r) => r.join(" | ")).join("\n");
  };
  return [
    section("Cows", data.cows),
    section("Customers", data.customers),
    section("Milk_Log (last 30 days)", data.milk),
    section("Sales (last 30 days)", data.sales),
    section("Payments (last 30 days)", data.payments),
    section("Expenses (last 30 days)", data.expenses),
    section("Fodder (last 30 days)", data.fodder),
  ].join("\n\n");
}

module.exports = {
  createSheets,
  MemorySheets,
  AppsScriptSheets,
  formatLedgerData,
  parseAmount,
};
