#!/usr/bin/env node
// One-off copy from the Apps Script gateway into Supabase.
// Re-running updates the same rows and does not delete anything the sheet no longer has.
// Prints counts only. Do not commit the environment or the output if you add tokens later.

const { createClient } = require("@supabase/supabase-js");
const { AppsScriptSheets } = require("../lib/sheets");
const { normalizePhone } = require("../lib/config");
const {
  memoryFromSheetsExport,
  memoryToSnapshot,
  farmerUpserts,
  childRows,
  CHILD_TABLES,
} = require("../lib/import-plan");

function envValue(names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function requireEnv(label, names) {
  const value = envValue(names);
  if (!value) {
    console.error(label + " is not set");
    process.exit(1);
  }
  return value;
}

async function upsertChunks(client, table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += 400) {
    const slice = rows.slice(i, i + 400);
    if (!slice.length) continue;
    const { error } = await client.from(table).upsert(slice, { onConflict });
    if (error) {
      console.error("import " + table + " failed", error.code || "");
      process.exit(1);
    }
  }
}

async function main() {
  const sheetsUrl = requireEnv("SHEETS_WEBHOOK_URL", ["SHEETS_WEBHOOK_URL", "SHEETS_URL"]);
  const sheetsSecret = requireEnv("SHEETS_SECRET", ["SHEETS_SECRET"]);
  const supabaseUrl = requireEnv("SUPABASE_URL", ["SUPABASE_URL"]);
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY", ["SUPABASE_SERVICE_ROLE_KEY"]);

  const gateway = new AppsScriptSheets(sheetsUrl, sheetsSecret);
  let listed;
  try {
    listed = await gateway.listRecorderFarmers();
  } catch (err) {
    console.error("farmer list failed");
    process.exit(1);
  }
  if (!listed || listed.ok === false) {
    if (listed && listed.redeploy) {
      try {
        listed = await gateway.listFarmers();
      } catch (err) {
        console.error("farmer list failed");
        process.exit(1);
      }
    } else {
      console.error("farmer list failed");
      process.exit(1);
    }
  }

  const farmers = listed.farmers || [];
  const ledgers = {};
  let skipped = 0;
  for (const farmer of farmers) {
    const sheetId = String(farmer.sheetId || "").trim();
    if (!sheetId || ledgers[sheetId]) continue;
    try {
      ledgers[sheetId] = await gateway.readRecent({
        days: 4000,
        refresh: false,
        sender: farmer.phone,
        sheetId,
      });
    } catch (err) {
      skipped += 1;
      console.error("ledger read failed");
    }
  }
  if (skipped) {
    console.error("import stopped because a ledger could not be read");
    process.exit(1);
  }

  const mem = await memoryFromSheetsExport({ farmers, ledgers });
  const snapshot = memoryToSnapshot(mem);
  const client = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  await upsertChunks(client, "farmers", farmerUpserts(snapshot), "phone");
  const found = await client.from("farmers").select("id, phone");
  if (found.error) {
    console.error("import farmers failed", found.error.code || "");
    process.exit(1);
  }
  const phoneToId = new Map((found.data || []).map((row) => [normalizePhone(row.phone), row.id]));
  let rows;
  try {
    rows = childRows(snapshot, phoneToId);
  } catch (err) {
    console.error("import owner missing");
    process.exit(1);
  }
  for (const [table] of CHILD_TABLES) {
    await upsertChunks(client, table, rows[table] || [], "origin");
  }
  await upsertChunks(client, "last_writes", rows.last_writes || [], "sheet_key");

  const counts = { farmers: snapshot.farmers.length, ledgers: snapshot.ledgers.length };
  for (const [table] of CHILD_TABLES) counts[table] = (rows[table] || []).length;
  console.log(JSON.stringify({ ok: true, ...counts }));
}

main().catch((err) => {
  console.error(err && err.code ? err.code : "import failed");
  process.exit(1);
});
