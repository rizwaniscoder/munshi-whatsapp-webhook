const { AsyncLocalStorage } = require("async_hooks");

const storage = new AsyncLocalStorage();

function isWebTurn() {
  return storage.getStore()?.kind === "web";
}

function captureWebReply(reply) {
  const ctx = storage.getStore();
  if (!ctx || ctx.kind !== "web") return false;
  ctx.replies.push(reply);
  return true;
}

async function runWebTurn(fn) {
  const replies = [];
  await storage.run({ kind: "web", replies }, fn);
  return replies.slice();
}

module.exports = {
  isWebTurn,
  captureWebReply,
  runWebTurn,
};
