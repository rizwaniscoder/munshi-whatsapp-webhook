const { interpretCommittee } = require("./committee");
const { interpretExpenses } = require("./expenses");
const { interpretSupply } = require("./supply");

function splitClauses(text) {
  return String(text || "")
    .split(/\s+aur\s+|\s+and\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function interpretLocal(text, ctx = {}) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const supply = interpretSupply(raw, ctx);
  if (supply) return supply;
  const clauses = splitClauses(raw);
  if (clauses.length <= 1) {
    return interpretCommittee(raw, ctx) || interpretExpenses(raw, ctx);
  }
  const entries = [];
  let clarify = null;
  for (const clause of clauses) {
    const hit = interpretCommittee(clause, ctx) || interpretExpenses(clause, ctx);
    if (!hit) return null;
    if (hit.intent === "query") return hit;
    if (hit.intent === "clarify") clarify = hit;
    else if (hit.entries) entries.push(...hit.entries);
    else return null;
  }
  if (clarify && entries.length) return null;
  if (entries.length) return { intent: "record", entries };
  return clarify;
}

module.exports = { interpretLocal };
