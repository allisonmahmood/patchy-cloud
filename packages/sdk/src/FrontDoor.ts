/**
 * The front door: what an outside agent reads before anything is installed.
 * `/llms.txt` says what Patchy Cloud is and how to get in; `/install.mjs` is
 * the installer it points at, with this instance's address baked in. Both are
 * public: the API guard covers only `/api`, and company handles cannot contain
 * a dot, so these paths never shadow a company.
 */
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { installCommand } from "@patchy/api";

export class InstallerUnavailable extends Schema.TaggedError<InstallerUnavailable>()(
  "InstallerUnavailable",
  { path: Schema.String, cause: Schema.Defect() }
) {
  override get message() {
    return `Cannot read the installer at ${this.path}; build the SDK package before starting the server.`;
  }
}

/**
 * Hosting's hook for a setup line's `?s=`: stamps "picked up" and answers whether the line is live.
 * It gets the fetch's trusted client address to rate-limit by. The SDK knows nothing of setup
 * links; without this service, or when it answers false, llms.txt is the plain page and setup
 * still works, just without the person's panel following along.
 */
export class SetupPickup extends Context.Service<
  SetupPickup,
  {
    readonly pickUp: (
      value: string,
      clientAddress: Option.Option<string>
    ) => Effect.Effect<boolean>;
  }
>()("@patchy/sdk/FrontDoor/SetupPickup") {}

/** A JavaScript string literal, as the installer source writes its base URL. */
const literal = Schema.encodeSync(Schema.fromJsonString(Schema.String));

/** The agent-facing introduction; the installed global skill owns everything after login. */
const llms = (base: string, setup?: string) => {
  const login = `login --api-url '${base}'${setup === undefined ? "" : ` --setup '${setup}'`} --json`;
  return `# Patchy Cloud

> A private cloud for a company's internal tools. People at a company, and their agents, build patches, anything from a static page to a full CRM, and publish them to their company's cloud. Patchy Cloud is in private beta: signing in at ${base} needs an invitation from the person's company or an approved spot on the waitlist.

This page sets up Patchy on this machine for ${base}. After login, the installed \`patchy\` skill covers publishing pages, starting tools and finding what the company already has.

## Requirements

- Node.js 22.22.0 or newer, with npm (\`node --version\`).
- The person you are working for, to sign in at ${base} in their own browser.

## Install and log in

macOS and Linux:

\`\`\`sh
${installCommand(base, "posix")} && patchy ${login}
\`\`\`

Windows PowerShell:

\`\`\`powershell
${installCommand(base, "powershell")}; if ($LASTEXITCODE -eq 0) { patchy.cmd ${login} }
\`\`\`

The installer downloads this instance's \`patchy\` release, checks it against the release's SHA-512 integrity, installs it globally with npm, copies its skill to \`~/.patchy/skills/patchy\` and links that copy as \`~/.agents/skills/patchy\` and \`~/.claude/skills/patchy\`. It prints the paths it used, or what to fix. Run it again to upgrade.

## Browser handoff

Login prints JSON with \`verificationUrl\`, \`userCode\` and \`next\`. Give the person both the URL and the code, and let them open it: never open a browser for them. They sign in, check the code and confirm this machine. Then run \`next\` with \`--json\` added; in PowerShell, call every \`patchy\` command as \`patchy.cmd\`. \`pending\` means they have not confirmed yet: say it is still waiting, and run the same command again when they are ready. Continue once the status is \`logged_in\`.

## Finish setup

Logging in is not the end of setup. Read the installed skill: the \`Skill:\` path the installer printed, also linked at \`~/.agents/skills/patchy/SKILL.md\`. Then follow its onboarding reference, \`references/onboarding.md\`, from where login leaves off. It publishes the person's welcome page in their company's look, unless they said they don't want one, and then has you suggest a first patch from what you know about them, either way. Read the skill before doing anything else with Patchy.
`;
};

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
      .pipe(Effect.mapError((cause) => new InstallerUnavailable({ path: file, cause })));
    const installer = source.replace(literal("__PATCHY_PUBLIC_BASE_URL__"), () => literal(base));
    const intro = llms(base);
    const pickup = yield* Effect.serviceOption(SetupPickup);
    yield* router.add(
      "GET",
      "/llms.txt",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const value = new URL(request.url, base).searchParams.get("s");
        // A live line's value goes into its login command; anything else gets the plain page.
        const live =
          value !== null && Option.isSome(pickup)
            ? yield* pickup.value
                .pickUp(value, request.remoteAddress)
                .pipe(Effect.catchCause(() => Effect.succeed(false)))
            : false;
        return HttpServerResponse.text(live ? llms(base, value!) : intro, {
          contentType: "text/plain; charset=utf-8",
          headers
        });
      })
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
