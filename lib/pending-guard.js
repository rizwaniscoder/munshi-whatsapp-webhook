const STALE_MS = 30 * 60 * 1000;

function pendingCreatedMs(createdAt) {
  const raw = String(createdAt || "").trim();
  if (!raw) return NaN;
  const stamped = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw.replace(" ", "T")}+05:00`;
  const ms = Date.parse(stamped);
  return Number.isFinite(ms) ? ms : NaN;
}

function isStalePending(pending, nowMs = Date.now()) {
  if (!pending) return false;
  const status = String(pending.status || "").toLowerCase();
  if (status !== "editing" && status !== "pending" && status !== "awaiting") return false;
  const created = pendingCreatedMs(pending.created_at);
  if (!Number.isFinite(created)) return false;
  return nowMs - created > STALE_MS;
}

function isCorrectionText(text) {
  const t = String(text || "").toLowerCase();
  if (/\b\d+(?:[.,]\d+)?\s+nahi\s+\d+/.test(t)) return true;
  if (/\b(galat|ghalat|badal do|badlo|theek karo|sahi karo|correct karo)\b/.test(t)) return true;
  if (/\b(farm\s+ka\s+naam|mera\s+naam)\b/.test(t)) return true;
  return false;
}

function looksLikeFreshEntry(text) {
  if (isCorrectionText(text)) return false;
  const t = String(text || "").trim();
  if (!t) return false;
  if (/\b(mazdoori|tankhwah|kharcha|bijli|diesel|petrol|chara|wanda|bhoosa|silage|khal)\b/i.test(t) && /\d/.test(t)) {
    return true;
  }
  const litreHits = t.match(/\d+(?:[.,]\d+)?\s*(?:litte?rs?|litres?|liters?|ltr)\b/gi) || [];
  if (litreHits.length >= 2) return true;
  if (/\bko\b/i.test(t) && litreHits.length >= 1) return true;
  if (/\b(subah|shaam|morning|evening)\b/i.test(t) && litreHits.length >= 1) return true;
  return false;
}

module.exports = {
  STALE_MS,
  isStalePending,
  isCorrectionText,
  looksLikeFreshEntry,
};
