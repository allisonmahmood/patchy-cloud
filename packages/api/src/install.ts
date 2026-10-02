/**
 * The line that installs an instance's `patchy` CLI through its `/install.mjs`.
 * `/llms.txt` serves it and a stale global CLI names it: rerunning it is the
 * upgrade path. URLs are single-quoted, as login's `next` quotes them, so an
 * IPv6 host's brackets never glob. PowerShell 5.1 has no `&&`, so its form
 * stops on failure instead.
 */
export const installCommand = (base: string, shell: "posix" | "powershell"): string =>
  shell === "posix"
    ? `work=$(mktemp -d) && curl -fsS '${base}/install.mjs' -o "$work/install.mjs" && node "$work/install.mjs"`
    : `$ErrorActionPreference = 'Stop'; $work = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid()); New-Item -ItemType Directory $work | Out-Null; Invoke-WebRequest -UseBasicParsing '${base}/install.mjs' -OutFile "$work\\install.mjs"; node "$work\\install.mjs"`;
