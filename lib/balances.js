const { headerIndex } = require("./schema");

function num(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value == null || value === "") return 0;
  const n = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function same(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function isDebitMethod(method) {
  return /^(jama|udhaar|debit)$/i.test(String(method || "").trim());
}

function paymentEffect(method, amount) {
  const value = num(amount);
  return isDebitMethod(method) ? value : -value;
}

function recomputeCustomer(store, name) {
  const wanted = String(name || "").trim().toLowerCase();
  if (!store || !wanted) return 0;
  const customers = store.Customers || [];
  const header = customers[0] || [];
  const nameIdx = headerIndex(header, "name");
  const openIdx = headerIndex(header, "opening_balance");
  const balIdx = headerIndex(header, "current_balance");
  let idx = -1;
  for (let i = 1; i < customers.length; i++) {
    if (String(customers[i][nameIdx] || "").trim().toLowerCase() === wanted) idx = i;
  }
  if (idx < 1 || balIdx < 0) return 0;
  let balance = num(openIdx < 0 ? 0 : customers[idx][openIdx]);
  const sales = store.Sales || [];
  const salesHeader = sales[0] || [];
  const saleName = headerIndex(salesHeader, "customer");
  const addedIdx = headerIndex(salesHeader, "balance_added");
  for (let i = 1; i < sales.length; i++) {
    if (String(sales[i][saleName] || "").trim().toLowerCase() !== wanted) continue;
    balance += num(sales[i][addedIdx]);
  }
  const payments = store.Payments || [];
  const payHeader = payments[0] || [];
  const payName = headerIndex(payHeader, "customer");
  const amountIdx = headerIndex(payHeader, "amount");
  const methodIdx = headerIndex(payHeader, "method");
  for (let i = 1; i < payments.length; i++) {
    if (String(payments[i][payName] || "").trim().toLowerCase() !== wanted) continue;
    balance += paymentEffect(payments[i][methodIdx], payments[i][amountIdx]);
  }
  const rounded = round2(balance);
  customers[idx][balIdx] = rounded;
  return rounded;
}

module.exports = {
  num,
  round2,
  same,
  isDebitMethod,
  paymentEffect,
  recomputeCustomer,
};
