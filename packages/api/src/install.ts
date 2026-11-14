/**
 * A single-quoted word in each shell, whatever the text holds: POSIX ends the quote, escapes the
 * `'` and reopens it, as login's `next` does; PowerShell doubles each single quote, including the
 * typographic ones it also treats as quotes. Nothing inside expands or globs.
 */
const quoted = {
  posix: (text: string) => `'${text.replaceAll("'", "'\\''")}'`,
  powershell: (text: string) => `'${text.replace(/['\u{2018}\u{2019}\u{201A}\u{201B}]/gu, "$&$&")}'`
};

/**
 * The line that installs an instance's `patchy` CLI through its `/install.mjs`.
 * `/llms.txt` serves it and a stale global CLI names it: rerunning it is the
 * upgrade path. The URL is one quoted word for any instance address, so a
 * pasted line never runs part of it, and an IPv6 host's brackets never glob.
 * PowerShell 5.1 has no `&&`, so its form stops on failure instead.
 */
export const installCommand = (base: string, shell: "posix" | "powershell"): string => {
  const url = quoted[shell](`${base}/install.mjs`);
  return shell === "posix"
    ? `work=$(mktemp -d) && curl -fsS ${url} -o "$work/install.mjs" && node "$work/install.mjs"`
    : `$ErrorActionPreference = 'Stop'; $work = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid()); New-Item -ItemType Directory $work | Out-Null; Invoke-WebRequest -UseBasicParsing ${url} -OutFile "$work\\install.mjs"; node "$work\\install.mjs"`;
};
