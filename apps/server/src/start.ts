/**
 * The production entrypoint, which every host runs: the server as `launch.ts` starts it, with
 * production's mail network, which reaches public addresses only, and OpenAI at its one address.
 * The dev runner has its own entrypoint for its loopback mailboxes and fake model provider; this
 * one never includes them.
 */
import { ImapNetwork, ModelsSource } from "@patchy/integrations";
import { launch } from "./launch.js";

launch(ImapNetwork.layer, ModelsSource.layer);
