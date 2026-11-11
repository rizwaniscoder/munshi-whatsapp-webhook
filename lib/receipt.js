const fs = require("fs");
const path = require("path");
const { parseAmount } = require("./sheets");
const { todayISO, TIMEZONE } = require("./config");

function loadSatori() {
  const mod = require("satori");
  return mod.default || mod;
}

function monthBounds(isoDate) {
  const [y, m] = String(isoDate).split("-").map(Number);
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  const end = isoDate;
  return { start, end };
}

function toISODate(value) {
  if (value == null || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    const epoch = Date.UTC(1899, 11, 30);
    return new Date(epoch + value * 86400000).toISOString().slice(0, 10);
  }
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    return d.toLocaleDateString("en-CA", { timeZone: TIMEZONE });
  }
  return s;
}

function inPeriod(date, start, end) {
  const iso = toISODate(date);
  return iso && iso >= start && iso <= end;
}

function prettyDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d} ${months[m - 1]} ${y}`;
}

function formatRs(n) {
  const num = Math.round(Number(n) || 0);
  return `Rs ${num.toLocaleString("en-PK")}`;
}

function findCustomer(rows, name) {
  if (!rows || rows.length < 2) return null;
  const header = rows[0].map((h) => String(h || "").toLowerCase());
  const nameIdx = 0;
  const phoneIdx = header.indexOf("phone");
  const rateIdx = header.indexOf("rate_pkr");
  const openIdx = header.indexOf("opening_balance");
  const balIdx = header.indexOf("current_balance");
  const needle = String(name || "").toLowerCase();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][nameIdx] || "").toLowerCase() === needle) {
      return {
        name: rows[i][nameIdx],
        phone: phoneIdx >= 0 ? rows[i][phoneIdx] : "",
        rate: rateIdx >= 0 ? parseAmount(rows[i][rateIdx]) : 0,
        opening: openIdx >= 0 ? parseAmount(rows[i][openIdx]) : 0,
        current: balIdx >= 0 ? parseAmount(rows[i][balIdx]) : 0,
      };
    }
  }
  return null;
}

function priorBalance(opening, sales, payments, customer, start) {
  let bal = opening;
  const name = String(customer).toLowerCase();
  for (const row of sales.slice(1)) {
    if (String(row[1] || "").toLowerCase() !== name) continue;
    if (toISODate(row[0]) < start) bal += parseAmount(row[6]);
  }
  for (const row of payments.slice(1)) {
    if (String(row[1] || "").toLowerCase() !== name) continue;
    if (toISODate(row[0]) < start) bal -= parseAmount(row[2]);
  }
  return bal;
}

function buildReceiptData({ ledger, customer, farmName, periodStart, periodEnd }) {
  const today = todayISO(TIMEZONE);
  const bounds = monthBounds(today);
  const start = periodStart || bounds.start;
  const end = periodEnd || bounds.end;
  const found = findCustomer(ledger.customers || [], customer);
  if (!found) {
    return { ok: false, error: `${customer} ledger mein nahi mila.` };
  }
  const name = String(found.name);
  const daily = {};
  let litres = 0;
  let total = 0;
  let paidSales = 0;
  let lastRate = found.rate || 0;
  for (const row of (ledger.sales || []).slice(1)) {
    if (String(row[1] || "").toLowerCase() !== name.toLowerCase()) continue;
    if (!inPeriod(row[0], start, end)) continue;
    const day = toISODate(row[0]);
    const qty = parseAmount(row[2]);
    const amount = parseAmount(row[4]);
    const cash = parseAmount(row[5]);
    const rate = parseAmount(row[3]);
    daily[day] = (daily[day] || 0) + qty;
    litres += qty;
    total += amount;
    paidSales += cash;
    if (rate) lastRate = rate;
  }
  let paidPayments = 0;
  for (const row of (ledger.payments || []).slice(1)) {
    if (String(row[1] || "").toLowerCase() !== name.toLowerCase()) continue;
    if (!inPeriod(row[0], start, end)) continue;
    paidPayments += parseAmount(row[2]);
  }
  const paid = paidSales + paidPayments;
  const openingUdhaar = priorBalance(found.opening, ledger.sales || [], ledger.payments || [], name, start);
  const currentUdhaar =
    found.current || found.current === 0
      ? found.current
      : openingUdhaar + (total - paidSales) - paidPayments;
  const days = Object.keys(daily)
    .sort()
    .map((date) => ({ date, litres: daily[date] }));
  return {
    ok: true,
    farmName: farmName || "Dairy Farm",
    customer: name,
    phone: found.phone || "",
    periodStart: start,
    periodEnd: end,
    issuedOn: today,
    days,
    litres,
    rate: lastRate || found.rate || 0,
    total,
    paid,
    openingUdhaar,
    currentUdhaar,
  };
}

function row(label, value, bold) {
  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        justifyContent: "space-between",
        padding: "8px 0",
        borderBottom: "1px solid #E6E8EE",
        fontWeight: bold ? 700 : 400,
        fontSize: bold ? 28 : 24,
      },
      children: [
        { type: "span", props: { children: label } },
        { type: "span", props: { children: value } },
      ],
    },
  };
}

async function renderReceiptPng(data) {
  const satori = loadSatori();
  const { Resvg } = require("@resvg/resvg-js");
  const fontDir = path.join(__dirname, "..", "fonts");
  const regular = fs.readFileSync(path.join(fontDir, "NotoSans-Regular.ttf"));
  const bold = fs.readFileSync(path.join(fontDir, "NotoSans-Bold.ttf"));
  const dayRows = (data.days || []).slice(-16);
  const height = 780 + dayRows.length * 34;
  const periodLabel = `${prettyDate(data.periodStart)} - ${prettyDate(data.periodEnd)}`;
  const element = {
    type: "div",
    props: {
      style: {
        width: "800px",
        height: `${height}px`,
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#F4F6FA",
        fontFamily: "Noto Sans",
        color: "#1A1F2B",
      },
      children: [
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              flexDirection: "column",
              backgroundColor: "#1F4E79",
              color: "#FFFFFF",
              padding: "36px 48px 28px",
            },
            children: [
              {
                type: "div",
                props: {
                  style: { fontSize: 18, letterSpacing: 4, fontWeight: 700 },
                  children: "PARCHI",
                },
              },
              {
                type: "div",
                props: {
                  style: { fontSize: 36, fontWeight: 700, marginTop: 8 },
                  children: String(data.farmName || "Dairy Farm"),
                },
              },
              {
                type: "div",
                props: {
                  style: { fontSize: 20, marginTop: 8, opacity: 0.9 },
                  children: `Issued ${prettyDate(data.issuedOn)}`,
                },
              },
            ],
          },
        },
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              flexDirection: "column",
              backgroundColor: "#FFFFFF",
              margin: "24px 32px",
              padding: "28px 32px",
              borderRadius: 16,
            },
            children: [
              row("Customer", String(data.customer), true),
              row("Period", periodLabel, false),
              row("Milk", `${data.litres} L`, false),
              row("Rate", `${formatRs(data.rate)} / L`, false),
              row("Total", formatRs(data.total), true),
              row("Paid", formatRs(data.paid), false),
              row("Opening udhaar", formatRs(data.openingUdhaar), false),
              row("Current udhaar", formatRs(data.currentUdhaar), true),
            ],
          },
        },
        dayRows.length
          ? {
              type: "div",
              props: {
                style: {
                  display: "flex",
                  flexDirection: "column",
                  backgroundColor: "#FFFFFF",
                  margin: "0 32px 32px",
                  padding: "24px 32px 28px",
                  borderRadius: 16,
                },
                children: [
                  {
                    type: "div",
                    props: {
                      style: { fontSize: 20, fontWeight: 700, marginBottom: 8 },
                      children: "Daily milk",
                    },
                  },
                  ...dayRows.map((d) => row(prettyDate(d.date), `${d.litres} L`, false)),
                ],
              },
            }
          : {
              type: "div",
              props: {
                style: { margin: "0 32px 32px", color: "#5C6573", fontSize: 20 },
                children: "Is daur mein koi sale nahi mili.",
              },
            },
      ],
    },
  };
  const svg = await satori(element, {
    width: 800,
    height,
    fonts: [
      { name: "Noto Sans", data: regular, weight: 400, style: "normal" },
      { name: "Noto Sans", data: bold, weight: 700, style: "normal" },
    ],
  });
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 800 } });
  return Buffer.from(resvg.render().asPng());
}

module.exports = {
  buildReceiptData,
  renderReceiptPng,
  monthBounds,
  toISODate,
  formatRs,
};
