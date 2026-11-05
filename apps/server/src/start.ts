/**
 * The production entrypoint, which every host runs: the server as `launch.ts` starts it, with
 * production's mail network, which reaches public addresses only. The dev runner has its own
 * entrypoint for its loopback mailboxes; this one never includes them.
 */
import { ImapNetwork } from "@patchy/integrations";
import { launch } from "./launch.js";

launch(ImapNetwork.layer);
