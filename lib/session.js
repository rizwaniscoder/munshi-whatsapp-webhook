const { TIMEZONE } = require("./config");

const AM_RE =
  /subah|sobah|subha|subh|morning|\bam\b|صبح/;
const PM_RE =
  /shaam|sham|evening|raat|night|\bpm\b|شام|رات/;

function normalizeSession(value) {
  const t = String(value || "")
    .trim()
    .toLowerCase();
  if (!t) return "";
  if (["am", "morning", "subah", "sobah", "subha", "subh"].includes(t)) return "am";
  if (["pm", "evening", "shaam", "sham", "raat", "night"].includes(t)) return "pm";
  if (AM_RE.test(t) && !PM_RE.test(t)) return "am";
  if (PM_RE.test(t)) return "pm";
  return "";
}

function sessionFromText(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return "";
  const am = AM_RE.test(t);
  const pm = PM_RE.test(t);
  if (am && !pm) return "am";
  if (pm && !am) return "pm";
  return "";
}

function hourInZone(date, timeZone = TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  return Number(parts.find((p) => p.type === "hour")?.value);
}

function defaultSession(timestamp, timeZone = TIMEZONE) {
  const date =
    timestamp == null || timestamp === ""
      ? new Date()
      : new Date(Number(timestamp) * (Number(timestamp) > 1e12 ? 1 : 1000));
  if (Number.isNaN(date.getTime())) return hourInZone(new Date(), timeZone) < 14 ? "am" : "pm";
  return hourInZone(date, timeZone) < 14 ? "am" : "pm";
}

function sessionLabel(session) {
  return session === "am" ? "Subah" : "Shaam";
}

function applyMilkSessions(parsed, { text, timestamp } = {}) {
  const fromText = sessionFromText(text);
  const fallback = fromText || defaultSession(timestamp);
  const entries = (parsed.entries || []).map((entry) => {
    if (entry.type !== "milk") return entry;
    const spoken = normalizeSession(entry.session) || fromText;
    return { ...entry, session: spoken || fallback };
  });
  return { ...parsed, entries };
}

function applySaleSessions(parsed, { text } = {}) {
  const fromText = sessionFromText(text);
  const entries = (parsed.entries || []).map((entry) => {
    if (entry.type !== "sale") return entry;
    const spoken = normalizeSession(entry.session) || fromText || sessionFromText(entry.note || entry.source_note || "");
    return spoken ? { ...entry, session: spoken } : entry;
  });
  return { ...parsed, entries };
}

module.exports = {
  normalizeSession,
  sessionFromText,
  defaultSession,
  sessionLabel,
  applyMilkSessions,
  applySaleSessions,
  hourInZone,
};
