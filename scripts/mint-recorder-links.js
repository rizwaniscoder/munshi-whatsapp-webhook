#!/usr/bin/env node
/**
 * List or mint personal recorder links for allowed farmers.
 *
 * Prints URLs to stdout. Those URLs are secrets. Do not commit them, paste
 * them into git, or copy them into an issue or chat log.
 *
 * Local sheet gateway (SHEETS_WEBHOOK_URL and SHEETS_SECRET in the environment):
 *   node scripts/mint-recorder-links.js
 *
 * Deployed service, using CRON_SECRET from the environment (not as an argument):
 *   node scripts/mint-recorder-links.js --remote
 *   node scripts/mint-recorder-links.js --remote https://munshi-whatsapp-webhook.onrender.com
 */
const { createSheets } = require("../lib/sheets");
const { ensureWebTokens } = require("../lib/web-token");

const DEFAULT_BASE = "https://munshi-whatsapp-webhook.onrender.com";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

async function fromRemote(base) {
  const secret = (process.env.CRON_SECRET || "").trim();
  if (!secret) {
    console.error("CRON_SECRET is not set");
    process.exit(1);
  }
  const res = await fetch(`${base.replace(/\/$/, "")}/admin/recorder-links`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    console.error("recorder links request failed", res.status);
    process.exit(1);
  }
  if (!res.ok || body.ok === false) {
    console.error(body.error || `HTTP ${res.status}`);
    process.exit(1);
  }
  return body.links || [];
}

async function fromSheets() {
  const sheets = createSheets();
  const result = await ensureWebTokens(sheets);
  if (!result.ok && result.redeploy) {
    console.error(
      "Paste apps-script/Code.gs and deploy a new version of the same web app before minting links. Do not change SHEETS_SECRET."
    );
    process.exit(1);
  }
  const base = DEFAULT_BASE;
  return (result.links || []).map((link) => ({
    phone: link.phone,
    name: link.name || "",
    eligible: link.eligible !== false,
    minted: Boolean(link.minted),
    url: link.token ? `${base}/r/${link.token}` : "",
  }));
}

async function main() {
  const remote = process.argv.includes("--remote");
  const base = argValue("--remote") || DEFAULT_BASE;
  console.error("These links are secrets. Do not commit them or paste them into chat logs.");
  const links = remote ? await fromRemote(base) : await fromSheets();
  for (const link of links) {
    if (!link.url) {
      console.log(`${link.phone}\tnot eligible`);
      continue;
    }
    const flag = link.minted ? "new" : "existing";
    console.log(`${link.phone}\t${flag}\t${link.url}`);
  }
}

main().catch((err) => {
  console.error(err.message || "mint failed");
  process.exit(1);
});
