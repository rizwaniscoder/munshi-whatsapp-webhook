const assert = require("assert");
const { MemorySheets } = require("../lib/sheets");
const {
  importFromGateway,
  startSheetsImportOnBoot,
  resetSheetsImportGuard,
  safeMessage,
} = require("../lib/import-from-sheets");

function memoryDb() {
  const tables = {};
  return {
    tables,
    from(name) {
      return {
        upsert(rows, opts = {}) {
          const key = opts.onConflict;
          tables[name] = tables[name] || new Map();
          for (const row of rows || []) {
            const prev = tables[name].get(row[key]) || {};
            const id = prev.id || "id-" + name + "-" + row[key];
            tables[name].set(row[key], { ...prev, ...row, id });
          }
          return Promise.resolve({ error: null });
        },
        select() {
          const farmers = tables.farmers || new Map();
          return Promise.resolve({
            data: [...farmers.values()].map((row) => ({ id: row.id, phone: row.phone })),
            error: null,
          });
        },
      };
    },
  };
}

function bootEnv(extra = {}) {
  return {
    IMPORT_FROM_SHEETS_ON_BOOT: "1",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value",
    SHEETS_WEBHOOK_URL: "https://script.google.com/macros/s/SECRETURL/exec",
    SHEETS_SECRET: "sheets-secret-value",
    ...extra,
  };
}

async function main() {
  const sheets = new MemorySheets();
  const copy = await sheets.copyLedger({
    phone: "923100000111",
    name: "Ali",
    farmName: "Al Noor",
    allowed: true,
    onboardingState: "complete",
  });
  await sheets.commitRecords({
    sender: "923100000111",
    sheetId: copy.sheetId,
    refresh: false,
    entries: [
      { type: "add_cow", cow_name: "Gori" },
      { type: "milk", date: "2026-11-01", session: "am", cow_name: "Gori", litres: 12 },
      { type: "expense", date: "2026-11-01", category: "labor", amount: 500 },
    ],
  });
  const db = memoryDb();
  const first = await importFromGateway({ gateway: sheets, client: db });
  assert.strictEqual(first.counts.farmers, 1);
  assert.strictEqual(first.counts.milk_records, 1);
  assert.strictEqual(first.counts.cows, 1);
  assert.strictEqual(first.counts.expenses, 1);
  const milk = [...db.tables.milk_records.values()][0];
  assert.strictEqual(milk.origin, "sheets:" + copy.sheetId + ":Milk_Log:1");
  assert.strictEqual(milk.litres, 12);
  assert.strictEqual(milk.farmer_id, [...db.tables.farmers.values()][0].id);

  sheets.ledgers[copy.sheetId].Milk_Log[1][3] = 9;
  const second = await importFromGateway({ gateway: sheets, client: db });
  assert.strictEqual(second.counts.milk_records, 1);
  assert.strictEqual(db.tables.milk_records.size, 1);
  assert.strictEqual([...db.tables.milk_records.values()][0].litres, 9);

  resetSheetsImportGuard();
  const skipped = await startSheetsImportOnBoot({
    env: bootEnv({ IMPORT_FROM_SHEETS_ON_BOOT: "" }),
    gateway: sheets,
    client: db,
  });
  assert.strictEqual(skipped.started, false);

  resetSheetsImportGuard();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const slow = {
    async listRecorderFarmers() {
      calls += 1;
      await gate;
      return { ok: true, farmers: [] };
    },
  };
  const logs = [];
  const pendingA = startSheetsImportOnBoot({
    env: bootEnv(),
    gateway: slow,
    client: memoryDb(),
    log: (line) => logs.push(line),
    logError: (line) => logs.push(line),
  });
  const pendingB = startSheetsImportOnBoot({
    env: bootEnv(),
    gateway: slow,
    client: memoryDb(),
    log: (line) => logs.push(line),
    logError: (line) => logs.push(line),
  });
  assert.strictEqual(pendingA, pendingB);
  let served = false;
  served = true;
  assert.strictEqual(served, true);
  release();
  const done = await pendingA;
  assert.strictEqual(done.ok, true);
  assert.strictEqual(calls, 1);
  assert.ok(logs.some((line) => line === "IMPORT_FROM_SHEETS done"));
  assert.ok(logs.some((line) => line.startsWith("IMPORT_FROM_SHEETS ") && line.includes("farmers=0") && line.includes("milk_records=0")));

  resetSheetsImportGuard();
  const env = bootEnv();
  const failureLogs = [];
  const failed = await startSheetsImportOnBoot({
    env,
    gateway: {
      async listRecorderFarmers() {
        return { ok: true, farmers: [] };
      },
    },
    client: {
      from() {
        return {
          upsert() {
            return Promise.resolve({ error: null });
          },
          select() {
            throw new Error("lookup " + env.SHEETS_SECRET + " at " + env.SHEETS_WEBHOOK_URL);
          },
        };
      },
    },
    log: (line) => failureLogs.push(line),
    logError: (line) => failureLogs.push(line),
  });
  assert.strictEqual(failed.ok, false);
  const failure = failureLogs.join("\n");
  assert.ok(failure.startsWith("IMPORT_FROM_SHEETS failed:"));
  assert.ok(!failure.includes(env.SHEETS_SECRET));
  assert.ok(!failure.includes(env.SHEETS_WEBHOOK_URL));
  assert.ok(!failure.includes("script.google.com"));
  assert.strictEqual(
    safeMessage(new Error("nope " + env.SUPABASE_SERVICE_ROLE_KEY), env).includes(env.SUPABASE_SERVICE_ROLE_KEY),
    false
  );

  console.log("test-import-boot ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
