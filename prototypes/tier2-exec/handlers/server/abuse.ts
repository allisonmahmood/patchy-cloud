// PROTOTYPE for #311: the bad neighbour.
import { t } from "../patchy.ts";

export const loop = t.query({
  handler: async () => {
    // Tight infinite loop; only the supervisor's watchdog can end this.
    for (;;) {}
  }
});

const held: Uint8Array[] = [];

// Allocates 200 MB, touches every page so it is really resident, and keeps it
// alive in a module global so the isolate holds it after the handler returns.
export const alloc = t.query({
  handler: async () => {
    const buf = new Uint8Array(200 * 1024 * 1024);
    for (let i = 0; i < buf.length; i += 4096) buf[i] = 1;
    held.push(buf);
    return { heldMB: held.length * 200 };
  }
});
