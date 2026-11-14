/**
 * The end of a job's log. GitHub answers the log's GET with a redirect to a signed URL on its log
 * store (shown: `productionresultssa<N>.blob.core.windows.net`, a read-only URL good for about ten
 * minutes), which Patchy reads itself and never follows. The store ignores a suffix range and
 * answers the whole log (shown), so Patchy learns the length first with `bytes=0-0`, then asks
 * for the closed range of the last bytes it answers, pinned to the first answer's ETag. Anything
 * else, a whole body in place of a range included, is refused unavailable with its body dropped
 * unread.
 *
 * The signed URL never leaves this module: not in an error, a log line or a wide event. The log's
 * text is untrusted, inert data: Patchy answers it as a string and does nothing else with it.
 */
import { WideEvents } from "@patchy/analytics";
import * as Effect from "effect/Effect";
import * as Source from "./Source.js";
import type { Reading } from "./Access.js";
import { NotFound } from "./Errors.js";

/** The only hosts a log's redirect may point at: a change on GitHub's side fails closed. */
const LOG_HOST = /^productionresultssa[0-9]+\.blob\.core\.windows\.net$/;
const CONTENT_RANGE = /^bytes (?:(\d{1,15})-(\d{1,15})|\*)\/(\d{1,15})$/;
const decoder = new TextDecoder();

/** Where a redirect points when it's somewhere Patchy downloads logs from, else undefined. */
export const logUrl = (location: string | undefined) => {
  if (location === undefined) return undefined;
  const url = URL.parse(location);
  return url !== null &&
    url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    LOG_HOST.test(url.hostname)
    ? url
    : undefined;
};

/** A `Content-Range` header as its parts; undefined when it isn't one. */
const contentRange = (header: string | undefined) => {
  const match = header === undefined ? null : CONTENT_RANGE.exec(header.trim());
  if (match === null) return undefined;
  return {
    start: match[1] === undefined ? undefined : Number(match[1]),
    end: match[2] === undefined ? undefined : Number(match[2]),
    total: Number(match[3])
  };
};

const refused = (stage: "redirect" | "status" | "response", upstreamStatus?: number) =>
  Effect.andThen(
    WideEvents.enrich({ githubLog: "refused" }),
    Effect.fail(
      new Source.Unavailable({
        stage,
        ...(upstreamStatus === undefined ? {} : { upstreamStatus })
      })
    )
  );

/**
 * The text of the last `max` bytes of the job's log, whether its start was cut off, and the whole
 * log's size. A cut start that falls inside a character skips to the next one.
 */
export const read = Effect.fnUntraced(function* (
  reading: Reading,
  repositoryId: number,
  jobId: number,
  max: number
) {
  const located = yield* reading.locate(`/repositories/${repositoryId}/actions/jobs/${jobId}/logs`);
  if (located._tag === "Answer") {
    const { status } = located.answer;
    if (status === 404) return yield* new NotFound({ resource: "job" });
    if (status === 410) return yield* new NotFound({ resource: "log" });
    return yield* refused("status", status);
  }
  const url = logUrl(located.location);
  if (url === undefined) {
    // Logged by what it is, never by the URL, which is a credential.
    const parsed = located.location === undefined ? null : URL.parse(located.location);
    yield* Effect.logWarning(
      "GitHub's job log redirect pointed somewhere Patchy doesn't download logs from; refused."
    ).pipe(
      Effect.annotateLogs({
        protocol: parsed?.protocol ?? "none",
        host: parsed === null ? "unparsed" : parsed.host
      })
    );
    return yield* refused("redirect");
  }

  // The length, and the version the end is then pinned to. Its body is never read.
  const probe = yield* reading.download(url, { range: "bytes=0-0" }, () => undefined);
  const first = contentRange(probe.headers["content-range"]);
  const etag = probe.headers.etag;
  if (probe.status === 416 && first?.start === undefined && first?.total === 0) {
    yield* WideEvents.enrich({ githubLog: "empty" });
    return { text: "", truncated: false, size: 0 };
  }
  if (probe.status !== 206 || first === undefined || first.start !== 0 || first.end !== 0)
    return yield* refused("status", probe.status);
  const total = first.total;
  if (total === 0) {
    yield* WideEvents.enrich({ githubLog: "empty" });
    return { text: "", truncated: false, size: 0 };
  }

  const start = Math.max(0, total - max);
  const end = total - 1;
  const length = end - start + 1;
  const tail = yield* reading
    .download(
      url,
      { range: `bytes=${start}-${end}`, ...(etag === undefined ? {} : { ifMatch: etag }) },
      (head) => {
        const range = contentRange(head.headers["content-range"]);
        return head.status === 206 &&
          range?.start === start &&
          range.end === end &&
          range.total === total
          ? length
          : undefined;
      }
    )
    .pipe(
      // More than the range asked for, as a whole body would be: refused, never decoded.
      Effect.catchTag("GithubOverflow", () => refused("response"))
    );
  if (tail.bytes === undefined || tail.bytes.byteLength !== length)
    return yield* refused("response", tail.status);
  let from = 0;
  // A cut start inside a UTF-8 sequence: skip its continuation bytes, at most three.
  if (start > 0)
    while (from < 3 && from < length && ((tail.bytes[from] ?? 0) & 0xc0) === 0x80) from++;
  yield* WideEvents.enrich({ githubLog: start > 0 ? "end" : "whole" });
  return { text: decoder.decode(tail.bytes.subarray(from)), truncated: start > 0, size: total };
});
