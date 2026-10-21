// Test-only observer: record outbound method/path/status, never headers or bodies.
// This passes every request unchanged to the installed connector's real fetch.
import { appendFileSync } from "node:fs";
const original = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const url = new URL(input instanceof Request ? input.url : input);
  const record = {
    at: Date.now(),
    method: init?.method || (input instanceof Request ? input.method : "GET"),
    path: url.pathname,
  };
  try {
    const response = await original.call(this, input, init);
    record.status = response.status;
    return response;
  } finally {
    appendFileSync(
      process.env.PATCHY_HTTP_ACCEPTANCE_TRACE,
      JSON.stringify(record) + "\n",
    );
  }
};
