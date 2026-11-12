function createWindowLimiter({ limit, windowMs, now = () => Date.now() }) {
  const buckets = new Map();
  return {
    allow(key) {
      const id = String(key || "");
      if (!id) return false;
      const at = now();
      const recent = (buckets.get(id) || []).filter((stamp) => at - stamp < windowMs);
      if (recent.length >= limit) {
        buckets.set(id, recent);
        return false;
      }
      recent.push(at);
      buckets.set(id, recent);
      return true;
    },
    reset() {
      buckets.clear();
    },
  };
}

module.exports = { createWindowLimiter };
