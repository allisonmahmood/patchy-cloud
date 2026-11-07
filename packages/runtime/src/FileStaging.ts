import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { Upload } from "@patchy/api";
import type { Binding } from "./Binding.js";
import type { RuntimeError } from "./Runtime.js";

/**
 * Bytes the host fetched for a tier 2 call, staged as a page's upload is: an Upload bound to the
 * call's viewer, patch and loaded version, under the same per-viewer and per-company quotas and
 * the same expiry, which an action adopts once with `ctx.files.<store>.put(name, upload)`. Files
 * implements it. An integration that hands an action a file, such as an IMAP attachment, stages
 * through it and passes only the Upload into workerd.
 */
export class FileStaging extends Context.Service<
  FileStaging,
  {
    /**
     * Refuses as staging `bytes` for `binding`'s call would be refused now, reserving nothing:
     * for a caller about to fetch bytes that may not fit. A stage can still be refused if others
     * stage meanwhile.
     */
    readonly admits: (
      binding: Binding["Service"],
      bytes: number
    ) => Effect.Effect<void, RuntimeError>;
    /**
     * Stages `bytes` for `binding`'s call: its viewer, patch and loaded version. `sha256` is the
     * staged bytes' digest in lowercase hex.
     */
    readonly stage: (
      binding: Binding["Service"],
      bytes: Uint8Array,
      contentType: string
    ) => Effect.Effect<{ readonly upload: Upload; readonly sha256: string }, RuntimeError>;
  }
>()("@patchy/runtime/FileStaging") {}
