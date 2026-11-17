const crypto = require("crypto");
const { allowedNumbers, isTruthyAllowed, normalizePhone } = require("./config");

const GENERIC_DENY = "Yeh link theek nahi.";

function mintWebToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function tokenLooksValid(token) {
  return /^[A-Za-z0-9_-]{40,80}$/.test(String(token || ""));
}

function redactToken(token) {
  const value = String(token || "");
  if (value.length < 12) return "…";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function farmerMayUseRecorder(farmer) {
  if (!farmer || !normalizePhone(farmer.phone)) return false;
  if (isTruthyAllowed(farmer.allowed)) return true;
  return allowedNumbers().includes(normalizePhone(farmer.phone));
}

function needsRedeploy(err) {
  return /unknown action|web_token column missing/i.test(String(err && err.message ? err.message : err || ""));
}

async function findAllowedFarmerByToken(sheets, token) {
  if (!tokenLooksValid(token)) return null;
  if (!sheets || typeof sheets.findFarmerByToken !== "function") return null;
  let result;
  try {
    result = await sheets.findFarmerByToken(token);
  } catch (err) {
    console.error("recorder lookup failed", err.message);
    return null;
  }
  if (result && result.redeploy) return null;
  const farmer = result && result.farmer;
  if (!farmerMayUseRecorder(farmer)) return null;
  const safe = { ...farmer };
  delete safe.webToken;
  return safe;
}

async function ensureWebTokens(sheets, { phones } = {}) {
  let listed;
  try {
    listed = typeof sheets.listRecorderFarmers === "function"
      ? await sheets.listRecorderFarmers()
      : await sheets.listFarmers();
  } catch (err) {
    if (needsRedeploy(err)) return { ok: false, redeploy: true };
    throw err;
  }
  if (listed && listed.redeploy) return { ok: false, redeploy: true };
  const want = Array.isArray(phones) && phones.length ? new Set(phones.map((phone) => normalizePhone(phone))) : null;
  const byPhone = new Map();
  for (const farmer of listed.farmers || []) {
    const phone = normalizePhone(farmer.phone);
    if (phone) byPhone.set(phone, farmer);
  }
  const targets = want ? [...want] : [...byPhone.keys()];
  const links = [];
  for (const phone of targets) {
    const farmer = byPhone.get(phone);
    if (!farmer || !farmerMayUseRecorder(farmer)) {
      if (want) links.push({ phone, name: farmer?.name || "", eligible: false });
      continue;
    }
    let token = String(farmer.webToken || "").trim();
    let minted = false;
    if (!tokenLooksValid(token)) {
      let saved = null;
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        token = mintWebToken();
        try {
          saved = await sheets.setWebToken(phone, token);
          lastErr = null;
        } catch (err) {
          lastErr = err;
          break;
        }
        if (saved && saved.ok) break;
        if (saved && /already used/i.test(saved.error || "")) continue;
        break;
      }
      if (lastErr) {
        if (needsRedeploy(lastErr)) return { ok: false, redeploy: true };
        throw lastErr;
      }
      if (!saved || !saved.ok) {
        if (needsRedeploy(saved && saved.error)) return { ok: false, redeploy: true };
        throw new Error("token save failed");
      }
      minted = true;
    }
    links.push({
      phone,
      name: farmer.name || "",
      eligible: true,
      minted,
      token,
    });
  }
  return { ok: true, links };
}

module.exports = {
  GENERIC_DENY,
  mintWebToken,
  tokenLooksValid,
  redactToken,
  farmerMayUseRecorder,
  findAllowedFarmerByToken,
  ensureWebTokens,
};
