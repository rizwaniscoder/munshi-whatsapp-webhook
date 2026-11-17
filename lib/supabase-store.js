const { createClient } = require("@supabase/supabase-js");
const WebSocket = require("ws");
const { memoryToSnapshot, snapshotToMemory } = require("./ledger-snapshot");

const DELEGATED = [
  "getFarmer",
  "upsertFarmer",
  "listFarmers",
  "listRecorderFarmers",
  "findFarmerByToken",
  "setWebToken",
  "touchLastInbound",
  "claimReminder",
  "releaseReminder",
  "copyLedger",
  "getContext",
  "isProcessed",
  "markProcessed",
  "setPending",
  "getPending",
  "clearPending",
  "commitRecords",
  "refreshDerived",
  "readRecent",
  "withLedger",
];

function schemaNotReady(error) {
  const code = String((error && error.code) || "");
  const message = String((error && error.message) || "");
  return code === "PGRST202" || /load_ledger_snapshot|save_ledger_snapshot|schema cache|does not exist/i.test(message);
}

function fail(error, fallback) {
  const code = String((error && error.code) || "");
  if (schemaNotReady(error)) {
    const err = new Error("Supabase schema is not ready. Apply supabase/migrations in order.");
    err.code = code;
    throw err;
  }
  console.error("ledger database error", code || "unknown");
  const err = new Error(fallback);
  err.code = code;
  throw err;
}

function createServiceClient(url, serviceRoleKey) {
  // Node 20 has no global WebSocket. The ledger never subscribes to realtime;
  // the transport only lets the client construct on that runtime.
  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    realtime: { transport: WebSocket },
  });
}

class SupabaseSheets {
  constructor(url, serviceRoleKey) {
    this.client = createServiceClient(url, serviceRoleKey);
  }

  async load() {
    const { data, error } = await this.client.rpc("load_ledger_snapshot");
    if (error) fail(error, "ledger read failed");
    if (!data || typeof data !== "object") {
      throw new Error("Supabase schema is not ready. Apply supabase/migrations in order.");
    }
    const mem = await snapshotToMemory(data);
    return { mem, version: Number(data.version || 0) };
  }

  async run(work) {
    let last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const loaded = await this.load();
      const mem = loaded.mem;
      mem.persist = function persist() {
        this._dirty = true;
      };
      const result = await work(mem);
      if (!mem._dirty) return result;
      const snapshot = memoryToSnapshot(mem);
      const saved = await this.client.rpc("save_ledger_snapshot", {
        snapshot,
        expected_version: loaded.version,
      });
      if (saved.error) fail(saved.error, "ledger save failed");
      if (saved.data && saved.data.conflict) {
        last = new Error("ledger conflict");
        continue;
      }
      return result;
    }
    throw last || new Error("ledger conflict");
  }

  async ping() {
    await this.load();
    return { ok: true, mode: "supabase", multiTenant: true };
  }
}

for (const name of DELEGATED) {
  SupabaseSheets.prototype[name] = async function delegated(...args) {
    const proto = require("./sheets").MemorySheets.prototype;
    return this.run((mem) => proto[name].apply(mem, args));
  };
}

module.exports = { SupabaseSheets, createServiceClient };
