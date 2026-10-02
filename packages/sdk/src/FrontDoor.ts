/**
 * The front door: what an outside agent reads before anything is installed.
 * `/llms.txt` says what Patchy Cloud is and how to get in; `/install.mjs` is
 * the installer it points at, with this instance's address baked in. Both are
 * public: the API guard covers only `/api`, and company handles cannot contain
 * a dot, so these paths never shadow a company.
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { installCommand } from "@patchy/api";

export class FrontDoorUnavailable extends Schema.TaggedError<FrontDoorUnavailable>()(
  "FrontDoorUnavailable",
  {
    path: Schema.String,
    reason: Schema.Literals(["read", "placeholder"]),
    cause: Schema.optionalKey(Schema.Defect())
  }
) {
  override get message() {
    return this.reason === "read"
      ? `Cannot read the installer at ${this.path}; build the SDK package before starting the server.`
      : `The installer at ${this.path} must contain its base URL placeholder exactly once.`;
  }
}

/** A JavaScript string literal, as the installer source writes its base URL. */
const literal = Schema.encodeSync(Schema.fromJsonString(Schema.String));
/** The installer's stand-in for the instance's address. */
const placeholder = literal("__PATCHY_PUBLIC_BASE_URL__");

/** The agent-facing introduction; the installed global skill owns everything after login. */
export const llms = (base: string) => `# Patchy Cloud

> A private cloud for a company's internal tools. People at a company, and their agents, build patches, anything from a static page to a full CRM, and publish them to their company's cloud. Patchy Cloud is in private beta: signing in at ${base} needs an invitation from the person's company or an approved spot on the waitlist.

This page sets up Patchy on this machine for ${base}. After login, the installed \`patchy\` skill covers publishing pages, starting tools and finding what the company already has.

## Requirements

- Node.js 22.22.0 or newer, with npm (\`node --version\`).
- The person you are working for, to sign in at ${base} in their own browser.

## Install and log in

macOS and Linux:

\`\`\`sh
${installCommand(base, "posix")} && patchy login --api-url ${base} --json
\`\`\`

Windows PowerShell:

\`\`\`powershell
${installCommand(base, "powershell")}; if ($LASTEXITCODE -eq 0) { patchy.cmd login --api-url ${base} --json }
\`\`\`

The installer downloads this instance's \`patchy\` release, checks it against the release's SHA-512 integrity, installs it globally with npm and links its skill as \`~/.agents/skills/patchy\` and \`~/.claude/skills/patchy\`. It prints the paths it used, or what to fix. Run it again to upgrade.

## Browser handoff

Login prints JSON with \`verificationUrl\`, \`userCode\` and \`next\`. Give the person both the URL and the code, and let them open it: never open a browser for them. They sign in, check the code and confirm this machine. Then run \`next\` with \`--json\` added. \`pending\` means they have not confirmed yet: say it is still waiting, and run the same command again when they are ready. Continue once the status is \`logged_in\`.

## Next

Read the installed skill before doing anything else with Patchy: the \`Skill:\` path the installer printed, also linked at \`~/.agents/skills/patchy/SKILL.md\`.
`;

const headers = { "cache-control": "no-store" };

/** Served from the configured public base URL, read once at startup. */
export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = (yield* Config.String("PATCHY_PUBLIC_BASE_URL")).replace(/\/+$/, "");
    const file = yield* path.fromFileUrl(new URL("../front-door/install.mjs", import.meta.url));
    const source = yield* fs
      .readFileString(file)
      .pipe(
        Effect.mapError((cause) => new FrontDoorUnavailable({ path: file, reason: "read", cause }))
      );
    const parts = source.split(placeholder);
    if (parts.length !== 2) {
      return yield* new FrontDoorUnavailable({ path: file, reason: "placeholder" });
    }
    const installer = parts.join(literal(base));
    const intro = llms(base);
    yield* router.add(
      "GET",
      "/llms.txt",
      Effect.succeed(
        HttpServerResponse.text(intro, { contentType: "text/plain; charset=utf-8", headers })
      )
    );
    yield* router.add(
      "GET",
      "/install.mjs",
      Effect.succeed(
        HttpServerResponse.text(installer, {
          contentType: "text/javascript; charset=utf-8",
          headers
        })
      )
    );
  })
);
