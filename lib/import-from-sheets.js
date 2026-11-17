const { AppsScriptSheets } = require("./sheets");
const { createServiceClient } = require("./supabase-store");
const { normalizePhone } = require("./config");
const {
  memoryFromSheetsExport,
  memoryToSnapshot,
  farmerUpserts,
  childRows,
  CHILD_TABLES,
} = require("./import-plan");

let inFlight = null;

function envValue(env, names) {
  for (const name of names) {
    const value = String((env && env[name]) || "").trim();
    if (value) return value;
  }
  return "";
}

function sheetsImportEnabled(env = process.env) {
  return String(env.IMPORT_FROM_SHEETS_ON_BOOT || "").trim() === "1";
}

function missingImportEnv(env = process.env) {
  const missing = [];
  if (!envValue(env, ["SUPABASE_URL"])) missing.push("SUPABASE_URL");
  if (!envValue(env, ["SUPABASE_SERVICE_ROLE_KEY"])) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!envValue(env, ["SHEETS_WEBHOOK_URL", "SHEETS_URL"])) missing.push("SHEETS_WEBHOOK_URL");
  if (!envValue(env, ["SHEETS_SECRET"])) missing.push("SHEETS_SECRET");
  return missing;
}

function safeMessage(err, env = process.env) {
  let message = String((err && err.message) || "import failed");
  const secrets = [
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    env.SHEETS_WEBHOOK_URL,
    env.SHEETS_URL,
    env.SHEETS_SECRET,
    env.CRON_SECRET,
  ];
  for (const secret of secrets) {
    const value = String(secret || "").trim();
    if (value.length >= 4) message = message.split(value).join("[redacted]");
  }
  message = message.replace(/https?:\/\/\S+/gi, "[redacted]");
  message = message.replace(/[\r\n]+/g, " ").trim().slice(0, 300);
  return message || "import failed";
}

function gatewayDetail(err) {
  if (!err) return "failed";
  if (typeof err === "string") return err;
  const code = err.code ? String(err.code) : "";
  const message = String(err.message || err.error || "failed");
  if (code && message.indexOf(code) === -1) return `${code} ${message}`.trim();
  return message;
}

function stepError(step, err) {
  const error = new Error(`${step}: ${gatewayDetail(err)}`);
  error.step = step;
  if (err && err.code) error.code = err.code;
  return error;
}

async function upsertChunks(client, table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += 400) {
    const slice = rows.slice(i, i + 400);
    if (!slice.length) continue;
    const { error } = await client.from(table).upsert(slice, { onConflict });
    if (error) {
      throw stepError("upsert " + table, new Error([error.code, error.message].filter(Boolean).join(" ") || "failed"));
    }
  }
}

async function listImportFarmers(gateway) {
  let recorderError = null;
  if (typeof gateway.listRecorderFarmers === "function") {
    try {
      const listed = await gateway.listRecorderFarmers();
      if (listed && listed.ok !== false && Array.isArray(listed.farmers)) return listed;
      const reason = listed && (listed.error || (listed.redeploy ? "unknown action" : ""));
      recorderError = new Error(reason || "listRecorderFarmers failed");
    } catch (err) {
      recorderError = err;
    }
  }
  let listed;
  try {
    listed = await gateway.listFarmers();
  } catch (err) {
    const prior = recorderError ? ` (listRecorderFarmers: ${gatewayDetail(recorderError)})` : "";
    throw stepError("listFarmers", new Error(gatewayDetail(err) + prior));
  }
  if (!listed || listed.ok === false || !Array.isArray(listed.farmers)) {
    const reason = (listed && listed.error) || "listFarmers failed";
    const prior = recorderError ? ` (listRecorderFarmers: ${gatewayDetail(recorderError)})` : "";
    throw stepError("listFarmers", new Error(reason + prior));
  }
  return listed;
}

async function readImportLedger(gateway, farmer, sheetId) {
  const payload = {
    days: 4000,
    refresh: false,
    sender: farmer.phone,
    phone: farmer.phone,
    sheetId,
  };
  let recent;
  try {
    recent = await gateway.readRecent(payload);
  } catch (err) {
    throw stepError("readRecent", new Error(`${farmer.phone}: ${gatewayDetail(err)}`));
  }
  if (recent && recent.ok === false) {
    throw stepError("readRecent", new Error(`${farmer.phone}: ${recent.error || "failed"}`));
  }
  return recent;
}

async function importFromGateway({ gateway, client }) {
  if (!gateway || !client) throw stepError("import", new Error("import is not configured"));
  const listed = await listImportFarmers(gateway);

  const farmers = listed.farmers || [];
  const ledgers = {};
  for (const farmer of farmers) {
    const sheetId = String(farmer.sheetId || "").trim();
    if (!sheetId || ledgers[sheetId]) continue;
    ledgers[sheetId] = await readImportLedger(gateway, farmer, sheetId);
  }

  const mem = await memoryFromSheetsExport({ farmers, ledgers });
  const snapshot = memoryToSnapshot(mem);
  await upsertChunks(client, "farmers", farmerUpserts(snapshot), "phone");
  const found = await client.from("farmers").select("id, phone");
  if (found.error) {
    throw stepError("farmers lookup", new Error([found.error.code, found.error.message].filter(Boolean).join(" ") || "failed"));
  }
  const phoneToId = new Map((found.data || []).map((row) => [normalizePhone(row.phone), row.id]));
  let rows;
  try {
    rows = childRows(snapshot, phoneToId);
  } catch (err) {
    throw stepError("import owner", err);
  }
  for (const [table] of CHILD_TABLES) {
    await upsertChunks(client, table, rows[table] || [], "origin");
  }
  await upsertChunks(client, "last_writes", rows.last_writes || [], "sheet_key");

  const counts = { farmers: snapshot.farmers.length };
  for (const [table] of CHILD_TABLES) counts[table] = (rows[table] || []).length;
  counts.last_writes = (rows.last_writes || []).length;
  return { counts };
}

function countLine(counts) {
  return Object.keys(counts)
    .map((name) => name + "=" + counts[name])
    .join(" ");
}

async function runSheetsImport({ env = process.env, gateway, client, log = console.log, logError = console.error } = {}) {
  const missing = missingImportEnv(env);
  if (missing.length) {
    logError("IMPORT_FROM_SHEETS failed: " + missing[0] + " is not set");
    return { ok: false };
  }
  const sheetsUrl = envValue(env, ["SHEETS_WEBHOOK_URL", "SHEETS_URL"]);
  const sheetsSecret = envValue(env, ["SHEETS_SECRET"]);
  const supabaseUrl = envValue(env, ["SUPABASE_URL"]);
  const serviceKey = envValue(env, ["SUPABASE_SERVICE_ROLE_KEY"]);
  try {
    const source = gateway || new AppsScriptSheets(sheetsUrl, sheetsSecret);
    const db = client || createServiceClient(supabaseUrl, serviceKey);
    const { counts } = await importFromGateway({ gateway: source, client: db });
    log("IMPORT_FROM_SHEETS " + countLine(counts));
    log("IMPORT_FROM_SHEETS done");
    return { ok: true, counts };
  } catch (err) {
    logError("IMPORT_FROM_SHEETS failed: " + safeMessage(err, env));
    return { ok: false };
  }
}

function startSheetsImportOnBoot(options = {}) {
  const env = options.env || process.env;
  if (!sheetsImportEnabled(env)) return Promise.resolve({ started: false });
  if (inFlight) return inFlight;
  inFlight = runSheetsImport(options);
  return inFlight;
}

function resetSheetsImportGuard() {
  inFlight = null;
}

async function runImportCli() {
  resetSheetsImportGuard();
  const result = await startSheetsImportOnBoot({
    env: { ...process.env, IMPORT_FROM_SHEETS_ON_BOOT: "1" },
  });
  if (!result || result.ok !== true) process.exitCode = 1;
}

module.exports = {
  importFromGateway,
  runSheetsImport,
  startSheetsImportOnBoot,
  resetSheetsImportGuard,
  sheetsImportEnabled,
  safeMessage,
  runImportCli,
};
