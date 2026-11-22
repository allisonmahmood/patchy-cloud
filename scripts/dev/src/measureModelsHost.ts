// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalTimersInEffect:off globalFetch:off globalJsonInEffect:off globalConsole:off globalConsoleInEffect:off -- a measurement entrypoint: wall-clock timing and the process's own fetch pool are what it measures.
/**
 * Measures what model calls in flight to the provider cost a host process, to size
 * `models.outbound.host`. Run it under Bun, as production runs hosts:
 *
 *   bun --conditions=development scripts/dev/src/measureModelsHost.ts --calls 64 --body 1000000
 *
 * It sends `--calls` text calls at once through the host's own model source to the fake provider,
 * which holds each answer, and prints the process's RSS and TCP sockets with every call open, then
 * once they are all answered. The fake runs in this process and keeps each request's body while it
 * holds it, so `perCallMiB` subtracts those bodies. Nothing leaves loopback.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ModelsSource } from "@patchy/integrations";
import * as FakeModels from "@patchy/integrations/models-fake";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

const flag = (name: string, fallback: number) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
};
const calls = flag("calls", 64);
const body = flag("body", 1_000_000);
const holdMs = flag("hold", 4_000);
const run = promisify(execFile);
const sockets = async () => {
  const { stdout } = await run("lsof", ["-nP", "-a", "-p", String(process.pid), "-iTCP"]).catch(
    () => ({ stdout: "" })
  );
  return Math.max(0, stdout.trim().split("\n").length - 1);
};
const mib = (bytes: number) => Math.round((bytes / 2 ** 20) * 10) / 10;
const collect = () => {
  const bun: unknown = Reflect.get(globalThis, "Bun");
  const gc: unknown = typeof bun === "object" && bun !== null ? Reflect.get(bun, "gc") : undefined;
  if (typeof gc === "function") gc.call(bun, true);
};

await Effect.runPromise(
  Effect.gen(function* () {
    const maxHttpRequests = Option.getOrElse(
      yield* Config.option(Config.String("BUN_CONFIG_MAX_HTTP_REQUESTS")),
      () => "default"
    );
    const fake = yield* FakeModels.start();
    const sourceOf = yield* ModelsSource.makeAt(fake.url).pipe(
      Effect.provide(FetchHttpClient.layer)
    );
    collect();
    const baseline = process.memoryUsage.rss();
    const input = `[fake:delay=${holdMs}] ${"y".repeat(body)}`;
    const started = performance.now();
    const pending = Effect.runPromise(
      Effect.forEach(
        Array.from({ length: calls }, (_, index) => index),
        () =>
          Effect.exit(
            sourceOf.generate(
              { model: "gpt-5-mini" },
              { instructions: "Measure.", input, maxOutputTokens: 4000 },
              {
                deadline: Date.now() + 60_000,
                attempt: { sent: false },
                beforeSend: Effect.succeed(Redacted.make("sk-measure"))
              }
            )
          ),
        { concurrency: "unbounded" }
      )
    );
    yield* Effect.promise(async () => {
      while (fake.open() < calls && performance.now() - started < holdMs - 500)
        await new Promise((done) => setTimeout(done, 10));
      // Sampled only while every open call stays open: a count that moved fails the run.
      const open = fake.open();
      const held = process.memoryUsage.rss();
      const tcp = await sockets();
      if (fake.open() !== open)
        throw new Error(`The open calls moved from ${open} to ${fake.open()} while sampled`);
      const exits = await pending;
      collect();
      process.stdout.write(
        `${JSON.stringify({
          calls,
          bodyBytes: body,
          maxHttpRequests,
          openAtProvider: open,
          baselineRssMiB: mib(baseline),
          heldRssMiB: mib(held),
          perCallMiB:
            Math.round(((held - baseline - open * body) / 2 ** 20 / Math.max(1, open)) * 100) / 100,
          sockets: tcp,
          answered: exits.filter((exit) => exit._tag === "Success").length,
          firstFailure: exits
            .find((exit) => exit._tag === "Failure")
            ?.cause.toString()
            .slice(0, 300),
          afterRssMiB: mib(process.memoryUsage.rss())
        })}\n`
      );
    });
  }).pipe(Effect.scoped)
);
process.exit(0);
