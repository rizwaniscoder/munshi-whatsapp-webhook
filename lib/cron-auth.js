const crypto = require("crypto");

function cronSecret() {
  return (process.env.CRON_SECRET || "").trim();
}

function cronConfigured() {
  return Boolean(cronSecret());
}

function readAuthorization(req) {
  if (!req) return "";
  if (typeof req.get === "function") return req.get("authorization") || "";
  const headers = req.headers || req;
  return headers.authorization || headers.Authorization || "";
}

function authorizedCron(req) {
  const secret = cronSecret();
  if (!secret) return false;
  const header = String(readAuthorization(req) || "").trim();
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  if (!match) return false;
  const token = match[1];
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { authorizedCron, cronConfigured };
