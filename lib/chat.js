const crypto = require("crypto");
const { todayISO, TIMEZONE } = require("./config");

function dayThread(date) {
  return "day:" + (date || todayISO(TIMEZONE));
}

function newThread() {
  return "chat:" + crypto.randomUUID();
}

function publicMessage(row) {
  return {
    id: row.id,
    thread_id: row.thread_id,
    role: row.role,
    content: row.content || "",
    payload: row.payload || {},
    created_at: row.created_at,
  };
}

function ensureChat(sheets) {
  if (!Array.isArray(sheets._chat)) sheets._chat = [];
  return sheets._chat;
}

function addChatMessages(sheets, farmer, items) {
  const phone = String(farmer && farmer.phone || "");
  const sheetKey = String(farmer && (farmer.sheetId || farmer.sheet_id) || "");
  const saved = [];
  const list = ensureChat(sheets);
  for (const item of items || []) {
    const threadId = String(item.thread_id || dayThread());
    const row = {
      id: crypto.randomUUID(),
      farmer_phone: phone,
      sheet_key: sheetKey,
      thread_id: threadId,
      role: item.role === "munshi" ? "munshi" : "farmer",
      content: String(item.content || "").slice(0, 4000),
      payload: item.payload && typeof item.payload === "object" ? item.payload : {},
      created_at: item.created_at || new Date().toISOString(),
    };
    list.push(row);
    saved.push(publicMessage(row));
  }
  return saved;
}

function pageMessages(sheets, farmer, query) {
  const phone = String(farmer && farmer.phone || "");
  const threadId = String((query && query.thread) || dayThread());
  const before = String((query && query.before) || "");
  const limit = Math.max(1, Math.min(50, Number(query && query.limit) || 50));
  const rows = ensureChat(sheets)
    .filter((row) => row.farmer_phone === phone && row.thread_id === threadId)
    .filter((row) => !before || String(row.created_at) < before)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
  const slice = rows.slice(Math.max(0, rows.length - limit));
  return {
    ok: true,
    thread_id: threadId,
    messages: slice.map(publicMessage),
    has_older: rows.length > slice.length,
  };
}

function listThreads(sheets, farmer, query) {
  const phone = String(farmer && farmer.phone || "");
  const q = String((query && (query.q || query.search)) || "").trim().toLowerCase();
  const groups = new Map();
  for (const row of ensureChat(sheets)) {
    if (row.farmer_phone !== phone) continue;
    const group = groups.get(row.thread_id) || {
      thread_id: row.thread_id,
      created_at: row.created_at,
      updated_at: row.created_at,
      title: "",
      count: 0,
    };
    group.count += 1;
    if (String(row.created_at) < String(group.created_at)) group.created_at = row.created_at;
    if (String(row.created_at) > String(group.updated_at)) group.updated_at = row.created_at;
    if (!group.title && row.role === "farmer" && row.content) group.title = String(row.content).slice(0, 80);
    groups.set(row.thread_id, group);
  }
  let threads = [...groups.values()];
  if (q) {
    threads = threads.filter((thread) => {
      const hay = (thread.title + " " + thread.thread_id + " " + thread.updated_at).toLowerCase();
      if (hay.includes(q)) return true;
      return ensureChat(sheets).some((row) => (
        row.farmer_phone === phone
        && row.thread_id === thread.thread_id
        && String(row.content || "").toLowerCase().includes(q)
      ));
    });
  }
  threads.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return { ok: true, threads };
}

function setChatState(sheets, farmer, id, state) {
  const phone = String(farmer && farmer.phone || "");
  const row = ensureChat(sheets).find((item) => item.id === id && item.farmer_phone === phone);
  if (!row) return { ok: false, status: 400, error: "Message nahi mili." };
  const allowed = new Set(["open", "yes", "no", "edit"]);
  const next = allowed.has(state) ? state : "open";
  row.payload = { ...(row.payload || {}), state: next };
  return { ok: true, message: publicMessage(row) };
}

function recentCreates(sheets, sinceMs) {
  const rows = []
    .concat(sheets._history || [])
    .concat(sheets._recentCreates || []);
  const out = [];
  const seen = new Set();
  for (const event of rows) {
    if (!event || event.action !== "create" || !event.record_id) continue;
    const at = Date.parse(event.created_at || "") || 0;
    if (sinceMs && at && at < sinceMs) continue;
    if (seen.has(event.record_id)) continue;
    seen.add(event.record_id);
    out.push({ id: event.record_id, table: event.table_name || "" });
  }
  return out;
}

module.exports = {
  dayThread,
  newThread,
  addChatMessages,
  pageMessages,
  listThreads,
  setChatState,
  recentCreates,
  publicMessage,
};
