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

module.exports = {
  requiredEnv,
  optionalEnv,
  todayISO,
  nowISO,
  allowedNumbers,
  normalizePhone,
  isAllowed,
  TIMEZONE: "Asia/Karachi",
  GRAPH_VERSION: optionalEnv("WHATSAPP_GRAPH_VERSION", "v25.0"),
  PHONE_NUMBER_ID: optionalEnv("PHONE_NUMBER_ID", "1487063871152930"),
  GEMINI_MODEL: optionalEnv("GEMINI_MODEL", "gemini-3.5-flash-lite"),
  SHEET_ID: optionalEnv(
    "SHEET_ID",
    "1sIDMkUs76cgl8ecBGIOWFIPiofGzwGJI1D3Az6OyDW8"
  ),
};
