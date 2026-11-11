function requiredEnv(name) {
  const value = (process.env[name] || "").trim();
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function optionalEnv(name, fallback = "") {
  const value = process.env[name];
  return value == null || value === "" ? fallback : value;
}

function todayISO(timeZone = "Asia/Karachi") {
  return new Date().toLocaleDateString("en-CA", { timeZone });
}

function nowISO(timeZone = "Asia/Karachi") {
  return new Date().toLocaleString("sv-SE", { timeZone }).replace(" ", "T");
}

function allowedNumbers() {
  return (process.env.ALLOWED_NUMBERS || "")
    .split(",")
    .map((n) => normalizePhone(n))
    .filter(Boolean);
}

function normalizePhone(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function isAllowed(phone) {
  const list = allowedNumbers();
  if (list.length === 0) return true;
  return list.includes(normalizePhone(phone));
}

const SHEET_ID = optionalEnv(
  "SHEET_ID",
  "1sIDMkUs76cgl8ecBGIOWFIPiofGzwGJI1D3Az6OyDW8"
);
const MASTER_PHONE = normalizePhone(optionalEnv("MASTER_PHONE", "923155506704"));

function isTruthyAllowed(value) {
  if (value === true || value === 1) return true;
  const s = String(value == null ? "" : value)
    .trim()
    .toLowerCase();
  return s === "true" || s === "yes" || s === "1";
}

function isMasterPhone(phone) {
  return normalizePhone(phone) === MASTER_PHONE;
}

function isMasterSheetId(sheetId) {
  return String(sheetId || "").trim() === String(SHEET_ID || "").trim() && String(SHEET_ID || "").trim() !== "";
}

function hasOwnLedger(farmer, phone) {
  if (isMasterPhone(phone)) return true;
  const sheetId = String(farmer?.sheetId || "").trim();
  return Boolean(sheetId) && !isMasterSheetId(sheetId);
}

module.exports = {
  requiredEnv,
  optionalEnv,
  todayISO,
  nowISO,
  allowedNumbers,
  normalizePhone,
  isAllowed,
  isTruthyAllowed,
  isMasterPhone,
  isMasterSheetId,
  hasOwnLedger,
  TIMEZONE: "Asia/Karachi",
  GRAPH_VERSION: optionalEnv("WHATSAPP_GRAPH_VERSION", "v25.0"),
  PHONE_NUMBER_ID: optionalEnv("PHONE_NUMBER_ID", "1487063871152930"),
  GEMINI_MODEL: optionalEnv("GEMINI_MODEL", "gemini-3.5-flash-lite"),
  SHEET_ID,
  MASTER_PHONE,
};
