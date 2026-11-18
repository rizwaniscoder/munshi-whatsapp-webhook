const { spawnSync } = require("child_process");
const path = require("path");

const files = [
  "scripts/test-format.js",
  "scripts/test-sale-entry.js",
  "scripts/test-stage1-onboarding.js",
  "scripts/test-stage2.js",
  "scripts/test-supply.js",
  "scripts/test-features.js",
  "scripts/test-committee-expenses.js",
  "scripts/test-reminders.js",
  "scripts/test-recorder.js",
  "scripts/test-webapp.js",
  "scripts/test-import-boot.js",
];

const root = path.join(__dirname, "..");
for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(root, file)], { stdio: "inherit", cwd: root });
  if (result.status !== 0) {
    console.error(file + " failed");
    process.exit(result.status || 1);
  }
}
console.log("all tests ok");
