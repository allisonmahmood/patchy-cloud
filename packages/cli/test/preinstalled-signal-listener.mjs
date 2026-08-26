import { writeFileSync } from "node:fs";

const reportPath = process.env.PATCHY_TEST_SIGNAL_REPORT;
const signalAction = process.env.PATCHY_TEST_SIGNAL_ACTION;
let count = 0;
let keepAlive;

process.on("SIGTERM", () => {
  count += 1;
  if (signalAction === "exit") {
    if (reportPath) {
      writeFileSync(
        reportPath,
        JSON.stringify({ signal: "SIGTERM", count, raw: Boolean(process.stdin.isRaw) })
      );
    }
    process.exit(72);
  }
  keepAlive ??= setTimeout(() => {}, 60_000);
  if (reportPath) {
    writeFileSync(reportPath, JSON.stringify({ signal: "SIGTERM", count }));
  }
});
