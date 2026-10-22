import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as z from "zod/v4";

const exec = promisify(execFile);
export const defaultApiUrl = "https://cloud.patchyhq.com";
export function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Invalid Patchy instance URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use an HTTP(S) Patchy instance URL without credentials, query or fragment.",
    );
  return url.toString().replace(/\/+$/, "");
}
// Validate when used, so --help/--version work even with a broken environment.
export const apiUrl = process.env.PATCHY_API_URL?.trim() || defaultApiUrl;
export const loginCommand = (url: string) =>
  `patchy-mcp login --api-url '${url.replaceAll("'", "'\\''")}' --json`;

export class CloudApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly details?: unknown,
    readonly correlationId?: string,
  ) {
    super(message);
  }
}

export class SignInRequired extends Error {
  readonly status = 401;
  readonly code = "sign_in_required";
  constructor(url: string) {
    super(
      `Sign in to Patchy again: ${loginCommand(url)}. Give the person the verification URL and code, then run the returned next command. Retry this tool after status is logged_in.${process.env.PATCHY_API_TOKEN ? " PATCHY_API_TOKEN overrides saved login; update or unset it first." : ""}`,
    );
  }
}

const credential = z.object({
  version: z.literal(1),
  instanceUrl: z.string(),
  token: z.string().min(1),
});

export async function getToken(url: string): Promise<string> {
  const override = process.env.PATCHY_API_TOKEN;
  if (override) return override;
  let stdout: string;
  try {
    ({ stdout } = await exec(
      "patchy",
      ["auth", "token", "--api-url", url, "--json"],
      {
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
    ));
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: string };
    let code: string | undefined;
    try {
      code = JSON.parse(failure.stderr ?? "{}").code;
    } catch {
      /* An older CLI may print help. */
    }
    if (code === "not_logged_in") throw new SignInRequired(url);
    if (failure.code === "ENOENT")
      throw new Error(
        `Install the Patchy CLI using ${url}/llms.txt, then run ${loginCommand(url)}.`,
      );
    // Never forward process errors: execFile's message may contain secret stdout/stderr.
    throw new Error(
      `Page and Tool reads require a Patchy CLI with 'auth token --json'. Install the CLI supplied by ${url}/llms.txt. For a disposable test, PATCHY_API_TOKEN can supply the instance's machine token directly.`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    throw new Error(
      `Patchy returned an incompatible credential response. Page and Tool reads require 'patchy auth token --json' with a version 1 credential for ${url}. Install the matching CLI using ${url}/llms.txt.`,
    );
  }
  const result = credential.safeParse(body);
  if (!result.success || result.data.instanceUrl !== url) {
    throw new Error(
      `Patchy returned an incompatible credential response. Page and Tool reads require 'patchy auth token --json' with a version 1 credential for ${url}. Install the matching CLI using ${url}/llms.txt.`,
    );
  }
  return result.data.token;
}

const unavailable = (
  url: string,
  status?: number,
  code = "cloud_unavailable",
  details?: unknown,
  correlationId?: string,
) =>
  new CloudApiError(
    `Patchy Cloud is unavailable at ${url}${status ? ` (HTTP ${status})` : ""}. Check that the instance is running and reachable, then retry. No data was returned.`,
    code,
    status,
    details,
    correlationId,
  );

export type PatchyRequest = (
  path: string,
  payload?: unknown,
) => Promise<unknown>;

export async function request(
  path: string,
  payload?: unknown,
  url = apiUrl,
): Promise<unknown> {
  return credentialRequest(url)(path, payload);
}

/** Pin one saved credential for an operation spanning discovery and a write. */
export function credentialRequest(selected = apiUrl): PatchyRequest {
  const url = normalizeUrl(selected);
  let token: Promise<string> | undefined;
  return async (path, payload) => {
    token ??= getToken(url);
    return cloudRequest(
      url,
      await token,
      path,
      payload,
      () => new SignInRequired(url),
    );
  };
}

/** Explicit credentials only: HTTP must never reach saved CLI login or environment tokens. */
export async function cloudRequest(
  url: string,
  token: string,
  path: string,
  payload?: unknown,
  unauthorized = () =>
    new CloudApiError(
      "Patchy authorization expired or was revoked. Reconnect and sign in again.",
      "sign_in_required",
      401,
    ),
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${url}${path}`, {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // A raw fetch exception is usually only "fetch failed" and can contain secrets.
    throw unavailable(url);
  }
  if (response.status === 401) throw unauthorized();
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (response.status >= 500) throw unavailable(url, response.status);
    if (
      error instanceof Error &&
      ["AbortError", "TimeoutError"].includes(error.name)
    )
      throw unavailable(url);
    throw new Error(
      `Patchy Cloud at ${url} returned HTTP ${response.status} without a valid JSON API response. Check the instance URL and whether this instance supports the requested operation.`,
    );
  }
  if (!response.ok) {
    const runtime = z
      .object({
        code: z.string().optional(),
        details: z.json().optional(),
        correlationId: z.string().optional(),
      })
      .safeParse(body);
    const info = runtime.success ? runtime.data : {};
    if (response.status >= 500)
      throw unavailable(
        url,
        response.status,
        info.code,
        info.details,
        info.correlationId,
      );
    const message =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : `Patchy API returned HTTP ${response.status}.`;
    throw new CloudApiError(
      `Patchy Cloud returned HTTP ${response.status}: ${message}`,
      info.code ?? "request_refused",
      response.status,
      info.details,
      info.correlationId,
    );
  }
  return body;
}
