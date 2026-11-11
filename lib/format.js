const { TIMEZONE, todayISO } = require("./config");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Itwar", "Peer", "Mangal", "Budh", "Jumeraat", "Jumma", "Hafta"];

const EVENT_LABELS = {
  vet_appointment: { roman: "Doctor ki visit", urdu: "ڈاکٹر کی وزٹ" },
  vet_visit: { roman: "Doctor aaya", urdu: "ڈاکٹر آیا" },
  pregnancy_check: { roman: "Gaban check", urdu: "گابن چیک" },
  insemination: { roman: "Teeka/Bharai", urdu: "ٹیکہ/بھرائی" },
  natural_service: { roman: "Natural service", urdu: "قدرتی سروس" },
  calving: { roman: "Bachha", urdu: "بچہ" },
  treatment: { roman: "Ilaaj/Injection", urdu: "علاج/انجیکشن" },
  dry_off: { roman: "Doodh band", urdu: "دودھ بند" },
  heat: { roman: "Garmi", urdu: "گرمی" },
  vaccination: { roman: "Teeka", urdu: "ٹیکہ" },
  other: { roman: "Event", urdu: "ایونٹ" },
};

function pad2(n) {
  return String(n).padStart(2, "0");
}

function isoFromParts(y, m, d) {
  if (!y || !m || !d) return "";
  return `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(d)}`;
}

function isoInZone(date, timeZone = TIMEZONE) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return isoFromParts(get("year"), get("month"), get("day"));
}

function parseSheetDate(value, timeZone = TIMEZONE) {
  if (value == null || value === "") return "";
  if (value instanceof Date) return isoInZone(value, timeZone);
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 20000 && value < 80000) {
      const epoch = Date.UTC(1899, 11, 30);
      return isoInZone(new Date(epoch + Math.round(value) * 86400000), "UTC");
    }
    if (value > 1e11) return isoInZone(new Date(value), timeZone);
    if (value > 1e9) return isoInZone(new Date(value * 1000), timeZone);
  }
  const s = String(value).trim();
  if (!s) return "";
  const isoDay = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDay) return `${isoDay[1]}-${isoDay[2]}-${isoDay[3]}`;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return isoInZone(d, timeZone);
  }
  const serial = Number(s);
  if (Number.isFinite(serial) && serial > 20000 && serial < 80000 && !/[A-Za-z]/.test(s)) {
    return parseSheetDate(serial, timeZone);
  }
  return "";
}

function addDaysISO(iso, days) {
  const [y, m, d] = String(iso)
    .slice(0, 10)
    .split("-")
    .map(Number);
  if (!y || !m || !d) return "";
  const dt = new Date(Date.UTC(y, m - 1, d + Number(days || 0)));
  return dt.toISOString().slice(0, 10);
}

function weekdayName(iso) {
  const [y, m, d] = String(iso)
    .slice(0, 10)
    .split("-")
    .map(Number);
  if (!y || !m || !d) return "";
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] || "";
}

function formatShortDate(value) {
  const iso = parseSheetDate(value);
  if (!iso) return "";
  const day = Number(iso.slice(8, 10));
  const mon = MONTHS[Number(iso.slice(5, 7)) - 1] || iso.slice(5, 7);
  return `${day} ${mon}`;
}

function formatHumanDate(value, refDate) {
  const iso = parseSheetDate(value);
  if (!iso) return "";
  const ref = parseSheetDate(refDate) || todayISO(TIMEZONE);
  const day = Number(iso.slice(8, 10));
  const mon = MONTHS[Number(iso.slice(5, 7)) - 1] || iso.slice(5, 7);
  const token = `${day} ${mon}`;
  if (iso === ref) return `Aaj, ${token}`;
  if (iso === addDaysISO(ref, 1)) return `Kal, ${token}`;
  const wd = weekdayName(iso);
  return wd ? `${token} (${wd})` : token;
}

function formatRs(n) {
  if (n == null || n === "") return "Rs 0";
  const num = Number(String(n).replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(num)) return "Rs 0";
  const rounded = Math.round(num * 100) / 100;
  const [whole, frac] = String(Math.abs(rounded)).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = rounded < 0 ? "-" : "";
  return frac ? `${sign}Rs ${grouped}.${frac}` : `${sign}Rs ${grouped}`;
}

function formatQty(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n || "0");
  if (Number.isInteger(num)) return String(num);
  return String(Math.round(num * 100) / 100);
}

function eventLabel(type, script = "roman") {
  const key = String(type || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  const pair = EVENT_LABELS[key];
  if (!pair) return script === "urdu" ? "ایونٹ" : key.replace(/_/g, " ");
  return script === "urdu" ? pair.urdu : pair.roman;
}

function sessionWord(session, script = "roman") {
  const t = String(session || "")
    .trim()
    .toLowerCase();
  if (t === "am" || t === "subah" || t === "morning") return script === "urdu" ? "صبح" : "subah";
  if (t === "pm" || t === "shaam" || t === "evening" || t === "raat") {
    return script === "urdu" ? "شام" : "shaam";
  }
  return "";
}

function prettyItem(name) {
  const s = String(name || "").trim();
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function looksIsoOrSnake(text) {
  return /\d{4}-\d{2}-\d{2}T|\b[a-z]+_[a-z_]+\b/.test(String(text || ""));
}

module.exports = {
  parseSheetDate,
  formatHumanDate,
  formatShortDate,
  formatRs,
  formatQty,
  eventLabel,
  sessionWord,
  prettyItem,
  addDaysISO,
  looksIsoOrSnake,
  EVENT_LABELS,
  MONTHS,
  WEEKDAYS,
};
