import * as Layer from "effect/Layer";
import * as ImapNetwork from "../imap/Network.js";
import * as ImapSource from "../imap/Source.js";

/** The IMAP source over production's network, for suites that reach no mailbox. */
export const offline = ImapSource.layer.pipe(Layer.provide(ImapNetwork.layer));
