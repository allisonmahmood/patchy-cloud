import { describe, expect, it } from "vitest";
import * as Api from "./Api.js";

const refusal = (status: number, fields: Omit<Api.Refusal, "ok" | "status"> = {}): Api.Refusal => ({
  ok: false,
  error: "Refused.",
  ...fields,
  status
});

interface Case {
  readonly refusal: Api.Refusal;
  /** Whether the saved request updates an existing patch. */
  readonly update?: boolean;
}

// ADR-0004 "Definitive publish refusals": exactly these clear the attempt.
describe("isDefinitivePublishRefusal", () => {
  it.each<Case>([
    { refusal: refusal(413) },
    { refusal: refusal(413, { code: "rate_limited" }) },
    ...(
      [
        "release_mismatch",
        "invalid_manifest",
        "tier_mismatch",
        "has_primitives",
        "patch_not_openable",
        "connection_not_connected",
        "stale_generated",
        "not_additive",
        "reserved_name",
        "invalid_description",
        "tier2_not_public"
      ] as const
    ).map((code) => ({ refusal: refusal(422, { code }) })),
    { refusal: refusal(422, { errors: ["Blocked <script> tag found."] }) },
    ...(
      [
        "publish_key_conflict",
        "name_taken",
        "has_dependants",
        "patch_retired",
        "patch_deleted"
      ] as const
    ).map((code) => ({ refusal: refusal(409, { code }) })),
    { refusal: refusal(403, { code: "not_owner" }) },
    { refusal: refusal(404, { error: Api.PATCH_NOT_FOUND }), update: true }
  ])("clears $refusal.status $refusal.code", ({ refusal, update = false }) => {
    expect(Api.isDefinitivePublishRefusal(refusal, update)).toBe(true);
  });

  it.each<Case>([
    // Admission refusals cannot say whether an earlier send committed.
    { refusal: refusal(401, { error: "Missing or invalid API token." }) },
    { refusal: refusal(429, { code: "rate_limited" }) },
    { refusal: refusal(403, { code: "live_patch_quota_exceeded" }) },
    { refusal: refusal(400) },
    { refusal: refusal(503, { code: "busy" }) },
    // A definitive code only counts with its own status.
    { refusal: refusal(422) },
    { refusal: refusal(422, { code: "version_unavailable" }) },
    { refusal: refusal(422, { code: "name_taken" }) },
    { refusal: refusal(409, { code: "release_mismatch" }) },
    { refusal: refusal(409, { code: "wrong_state" }) },
    { refusal: refusal(403, { code: "patch_deleted" }) },
    { refusal: refusal(400, { code: "invalid_manifest" }) },
    // A missing patch is definitive only for an update.
    { refusal: refusal(404, { error: Api.PATCH_NOT_FOUND }), update: false },
    { refusal: refusal(404, { error: "Not found." }), update: true },
    // A refusal decoded without its observed status is never definitive.
    { refusal: { ok: false, error: "Refused.", code: "name_taken" } }
  ])("keeps $refusal.status $refusal.code", ({ refusal, update = true }) => {
    expect(Api.isDefinitivePublishRefusal(refusal, update)).toBe(false);
  });
});
