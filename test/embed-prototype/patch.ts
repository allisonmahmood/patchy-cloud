/** Same browser client and owned table used by published tier 1 patches. No embed API. */
import { createClient, isPatchyError } from "../../packages/patchy/src/client.js";

const client = createClient({ tables: { rows: {} }, files: {} });
const identity = document.querySelector("#identity")!;
const rows = document.querySelector("#rows")!;
const result = document.querySelector("#result")!;
void client.me().then((me) => {
  identity.textContent = me?.user.name ?? "Public reader";
});
const subscription = client.tables.rows!.list.subscribe({}, (snapshot) => {
  rows.textContent = JSON.stringify(snapshot);
});
document.querySelector("#add")!.addEventListener("click", async () => {
  try {
    await client.tables.rows!.insert({ label: "Added from the host app" });
    result.textContent = "Saved";
  } catch (error) {
    result.textContent = isPatchyError(error) ? error.code : "Failed";
  }
});
addEventListener("pagehide", subscription);
