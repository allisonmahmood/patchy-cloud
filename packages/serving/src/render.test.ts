import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { Patches } from "@patchy/patches";
import { escapeHtml, renderPatchWrapper, renderHome } from "./render.js";

const configuredUrl = "https://origin.example.test/base?tenant=O'Reilly&mode=review";
const setupToken = "render-setup-sentinel";
const inheritedOrigin = "https://hostile-inherited.example.test";
const inheritedApiToken = "hostile-inherited-api-token";
const inheritedToken = "hostile-inherited-token";

describe("renderHome", () => {
  it("renders a pinned, fail-closed quick start for the configured origin", () => {
    const html = renderHome({ publicBaseUrl: configuredUrl });
    const commands = extractQuickStart(html);

    expect(html).toContain(`Endpoint: <code>${escapeHtml(configuredUrl)}</code>`);
    // The page pins the configured origin and nothing else: no instance URL is
    // baked into the rendered quick start.
    expect(html).not.toContain("patchyhq.com");
    expect(html.indexOf("Requires the <code>patchy</code> CLI")).toBeLessThan(
      html.indexOf("data-patchy-quick-start")
    );
    expect(commands).toContain('patchy auth set --token-stdin --api-url "$PATCHY_API_URL"');
    expect(commandNames(commands)).toEqual(["auth", "whoami", "validate", "upload"]);

    const syntax = spawnSync("sh", ["-n"], { input: commands, encoding: "utf8" });
    expect(syntax.status, syntax.stderr).toBe(0);

    const success = runWithStubCli(commands);
    expect(success.status, success.stderr).toBe(0);
    expect(observedCommands(success.stdout)).toEqual(["auth", "whoami", "validate", "upload"]);
    expect(success.stdout).toContain(
      `PATCHY_PROBE:auth|set|--token-stdin|--api-url|${configuredUrl}`
    );
    expect(success.stdout).toContain(
      `PATCHY_ENV:auth|url=${configuredUrl}|api=unset|token=unset|setup=set`
    );
    expect(success.stdout).toContain(
      `PATCHY_ENV:whoami|url=${configuredUrl}|api=unset|token=unset|setup=unset`
    );
    expect(success.stderr).not.toContain(setupToken);
    expect(success.stderr).not.toContain(inheritedApiToken);
    expect(success.stderr).not.toContain(inheritedToken);
  });

  it.each(["auth", "whoami", "validate"] as const)(
    "stops dependent quick-start commands when %s fails",
    (failedCommand) => {
      const commands = extractQuickStart(renderHome({ publicBaseUrl: configuredUrl }));
      const result = runWithStubCli(commands, failedCommand);
      const orderedCommands = ["auth", "whoami", "validate", "upload"];
      const expected = orderedCommands.slice(0, orderedCommands.indexOf(failedCommand) + 1);

      expect(result.status).not.toBe(0);
      expect(observedCommands(result.stdout)).toEqual(expected);
    }
  );
});

describe("renderPatchWrapper", () => {
  const patch: Patches.Patch = {
    id: "patch12345ab",
    accountId: "acct_1",
    title: "",
    currentVersionId: "ver_1",
    repoOrg: null,
    repoName: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-04-01T00:00:00.000Z",
    pinnedAt: null,
    deletedAt: null,
    disabledAt: null,
    disabledReason: null
  };
  const version: Patches.PatchVersion = {
    id: "ver_1",
    patchId: patch.id,
    versionNumber: 2,
    objectKey: "patches/patch12345ab/2.html",
    contentHash: "hash",
    fileSize: 12,
    createdByApiTokenId: "tok_1",
    sourceIp: null,
    userAgent: null,
    cliVersion: null,
    gitBranch: null,
    gitCommitSha: null,
    originalFilename: null,
    createdAt: "2026-01-01T00:00:00.000Z"
  };

  it("is the sandboxed frame and nothing else", () => {
    const html = renderPatchWrapper({
      patch,
      version,
      html: '<p title="a&b">hi</p><script>alert(1)</script>'
    });

    // The document reaches the frame through the escaped attribute, never raw.
    expect(html).toContain('sandbox=""');
    expect(html).toContain('referrerpolicy="no-referrer"');
    expect(html).toContain('srcdoc="&lt;p title=&quot;a&amp;b&quot;&gt;hi&lt;/p&gt;');
    expect(html).not.toContain("<script>alert");

    // No chrome around it: no footer, no link out, no form, no script of its own.
    expect(html).not.toContain("<footer");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<script");

    // An untitled patch still gets a title on the document and on the frame.
    expect(html).toContain("<title>Patchy patch</title>");
    expect(html).toContain('title="Patchy patch"');
    expect(html).toContain(`<!-- patch:${patch.id} version:2 -->`);
  });

  it("escapes the patch title into both the document and the frame", () => {
    const html = renderPatchWrapper({
      patch: { ...patch, title: "<b>Q3</b> & beyond" },
      version,
      html: "<p>hi</p>"
    });

    expect(html).toContain("<title>&lt;b&gt;Q3&lt;/b&gt; &amp; beyond</title>");
    expect(html).toContain('title="&lt;b&gt;Q3&lt;/b&gt; &amp; beyond"');
    expect(html).not.toContain("<b>Q3</b>");
  });
});

function extractQuickStart(html: string): string {
  const matches = [
    ...html.matchAll(/<pre><code data-patchy-quick-start>([\s\S]*?)<\/code><\/pre>/g)
  ];
  expect(matches).toHaveLength(1);
  return decodeHtml(matches[0][1]);
}

function decodeHtml(source: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"'
  };
  return source.replace(/&(#(?:x[0-9a-f]+|\d+)|amp|apos|gt|lt|quot);/gi, (_entity, name) => {
    if (!name.startsWith("#")) return namedEntities[name.toLowerCase()];
    const hexadecimal = name[1].toLowerCase() === "x";
    const codePoint = Number.parseInt(name.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    return String.fromCodePoint(codePoint);
  });
}

type QuickStartCommand = "auth" | "whoami" | "validate" | "upload";

function commandNames(commands: string): QuickStartCommand[] {
  return [...commands.matchAll(/\bpatchy (auth|whoami|validate|upload)\b/g)].map(
    (match) => match[1] as QuickStartCommand
  );
}

function runWithStubCli(commands: string, failOn: QuickStartCommand | "" = "") {
  const stub = `
patchy() {
  command_name=$1

  if [ "\${PATCHY_API_URL-}" != "$PATCHY_EXPECTED_URL" ]; then
    return 92
  fi
  if [ "\${PATCHY_API_TOKEN+x}" = x ] || [ "\${TOKEN+x}" = x ]; then
    return 93
  fi

  setup_state=unset
  if [ "\${PATCHY_SETUP_TOKEN+x}" = x ]; then
    setup_state=set
  fi
  if [ "$command_name" = auth ]; then
    token_input=$(cat)
    if [ "$token_input" != "$PATCHY_EXPECTED_SETUP_TOKEN" ]; then
      return 94
    fi
  elif [ "$setup_state" != unset ]; then
    return 95
  fi

  printf 'PATCHY_ENV:%s|url=%s|api=unset|token=unset|setup=%s\\n' \\
    "$command_name" "$PATCHY_API_URL" "$setup_state"
  printf 'PATCHY_PROBE:%s' "$command_name"
  shift
  for argument do
    printf '|%s' "$argument"
  done
  printf '\\n'
  if [ "$command_name" = "$PATCHY_FAIL_ON" ]; then
    return 97
  fi
}
`;
  return spawnSync("sh", ["-eux", "-c", `${stub}\n${commands}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATCHY_API_TOKEN: inheritedApiToken,
      PATCHY_API_URL: inheritedOrigin,
      PATCHY_EXPECTED_SETUP_TOKEN: setupToken,
      PATCHY_EXPECTED_URL: configuredUrl,
      PATCHY_FAIL_ON: failOn,
      PATCHY_SETUP_TOKEN: setupToken,
      TOKEN: inheritedToken
    }
  });
}

function observedCommands(output: string): QuickStartCommand[] {
  return [...output.matchAll(/^PATCHY_PROBE:(auth|whoami|validate|upload)(?:\||$)/gm)].map(
    (match) => match[1] as QuickStartCommand
  );
}
