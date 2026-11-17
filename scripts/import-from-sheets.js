#!/usr/bin/env node
// One-off copy from the Apps Script gateway into Supabase.
// Prints counts only. Do not commit the environment or the output.

const { runImportCli } = require("../lib/import-from-sheets");

runImportCli().catch((err) => {
  const { safeMessage } = require("../lib/import-from-sheets");
  console.error("IMPORT_FROM_SHEETS failed: " + safeMessage(err));
  process.exit(1);
});
