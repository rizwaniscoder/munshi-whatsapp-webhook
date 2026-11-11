const { optionalEnv } = require("./config");

const URDU_RE = /[\u0600-\u06FF]/;
const ROMAN_RE = /[A-Za-z]/;

let currentMode = "";
let incomingText = "";

function replyScript() {
  const v = String(optionalEnv("REPLY_SCRIPT", "both"))
    .trim()
    .toLowerCase();
  if (v === "roman" || v === "urdu" || v === "auto" || v === "both") return v;
  return "both";
}

function detectScript(text) {
  const s = String(text || "");
  const urdu = (s.match(/[\u0600-\u06FF]/g) || []).length;
  const roman = (s.match(/[A-Za-z]/g) || []).length;
  if (urdu > roman && urdu >= 4) return "urdu";
  return "roman";
}

function resolveMode(text) {
  const setting = replyScript();
  if (setting === "auto") return detectScript(text || incomingText);
  return setting;
}

function setReplyContext({ text, mode } = {}) {
  incomingText = text || "";
  currentMode = mode || resolveMode(incomingText);
  return currentMode;
}

function clearReplyContext() {
  incomingText = "";
  currentMode = "";
}

async function runWithReplyContext(ctx, fn) {
  const prevMode = currentMode;
  const prevText = incomingText;
  setReplyContext(ctx || {});
  try {
    return await fn();
  } finally {
    currentMode = prevMode;
    incomingText = prevText;
  }
}

function currentReplyMode() {
  return currentMode || resolveMode(incomingText);
}

function bilingual(urdu, roman) {
  const u = String(urdu || "").trim();
  const r = String(roman || "").trim();
  const mode = currentReplyMode();
  if (mode === "urdu") return u || r;
  if (mode === "roman") return r || u;
  if (!u) return r;
  if (!r) return u;
  if (u === r) return r;
  return `${u}\n\n${r}`;
}

function tx(urdu, roman) {
  return bilingual(urdu, roman);
}

function confirmButtonTitles() {
  return [
    { id: "confirm_yes", title: "ہاں Haan" },
    { id: "confirm_no", title: "نہیں Nahi" },
    { id: "confirm_edit", title: "ترمیم Edit" },
  ];
}

module.exports = {
  replyScript,
  detectScript,
  resolveMode,
  setReplyContext,
  clearReplyContext,
  runWithReplyContext,
  currentReplyMode,
  bilingual,
  tx,
  confirmButtonTitles,
  URDU_RE,
  ROMAN_RE,
};
