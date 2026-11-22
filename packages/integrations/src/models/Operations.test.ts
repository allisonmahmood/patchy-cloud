// @effect-diagnostics nodeBuiltinImport:off -- a closed local port shows what the real fetch transport reports when refused.
import { createServer as createNetServer } from "node:net";
import { assert, describe, it } from "@effect/vitest";
import { CURRENT_RELEASE, RuntimeFailure, WIRE_VERSION } from "@patchy/api";
import * as GuestProtocol from "@patchy/api/guest";
import { DEV_SEED } from "@patchy/auth/seed";
import * as WideEvents from "@patchy/analytics/wide-events";
import { Binding, Runtime } from "@patchy/runtime/core";
import { ActionSlots, CallbackGateway, InvocationCapabilities, RuntimeLog } from "@patchy/runtime";
import { OperatingLimits } from "@patchy/limits";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as SqlClient from "effect/sql/SqlClient";
import * as ConnectionStore from "../ConnectionStore.js";
import * as PidgeonSource from "../pidgeon/Source.js";
import * as Pages from "../test/pages.js";
import * as Admission from "./Admission.js";
import * as Errors from "./Errors.js";
import * as Operations from "./Operations.js";
import * as Source from "./Source.js";

/**
 * The two model calls as a published action's callbacks reach them, over the real store and the
 * host's admission queue, against a scripted provider: who may call, both checks and what changes
 * between them, the queue's refusals, the attempt record, and what never leaves or is kept.
 */

const KEY = "sk-operations-key-marker";
const INPUT = "INPUT-MARKER-91d2";
const events: WideEvents.WideEvent[] = [];
const recording = WideEvents.layerWithSink.pipe(
  Layer.provide(
    Layer.succeed(WideEvents.Sink, { write: (event) => Effect.sync(() => void events.push(event)) })
  )
);
// One provider request at a time and one waiter, so a test can hold a call in the queue.
const admission = Admission.layer.pipe(
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        PATCHY_LIMITS_JSON: JSON.stringify({
          "models.outbound.provider": 1,
          "models.queue.waiting": 1
        })
      })
    )
  )
);
const layer = Layer.mergeAll(recording, admission).pipe(
  Layer.provideMerge(Pages.services(PidgeonSource.layer))
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const text = (value: string) =>
  json({
    id: "resp_1",
    object: "response",
    created_at: 1,
    model: "gpt-test",
    status: "completed",
    output: [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: value, annotations: [] }]
      }
    ],
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 }
  });
const decided = json({
  answers: [
    {
      type: "choice",
      name: "team",
      choice: "billing",
      confidence: 0.9,
      probabilities: [
        { value: "billing", probability: 0.9 },
        { value: "technical", probability: 0.1 }
      ]
    }
  ],
  usage: { input_tokens: 9, output_tokens: 0 }
});

/** A scripted provider: answers by path, holds a call whose input says `hold`. */
/** A scripted provider: answers by path, holds a call, or drops the connection once it is sent. */
const scripted = (
  answer: (path: string, body: Record<string, unknown>) => Response | "hang" | "reset"
) => {
  const sent: Array<{ readonly path: string; readonly authorization: string | undefined }> = [];
  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const body = JSON.parse(
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}"
      ) as Record<string, unknown>;
      sent.push({ path: url.pathname, authorization: request.headers["authorization"] });
      const reply = answer(url.pathname, body);
      if (reply === "hang") return yield* Effect.never;
      if (reply === "reset")
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "socket hang up" })
        });
      return HttpClientResponse.fromWeb(request, reply);
    })
  );
  return { sent, source: Source.make.pipe(Effect.provideService(HttpClient.HttpClient, client)) };
};
const held = (body: Record<string, unknown>) => JSON.stringify(body).includes("hold");
const ordinary = scripted((path, body) =>
  held(body) ? "hang" : path.endsWith("/decisions") ? decided : text("A short answer.")
);

let companies = 0;
/** A company with an OpenAI key, a decision role and a text role, and a patch declaring both. */
const setup = Effect.fn(function* () {
  const owner = yield* Pages.createCompany(`models-ops-${++companies}`);
  const store = yield* ConnectionStore.ConnectionStore;
  const sql = yield* SqlClient.SqlClient;
  const who = { companyId: owner.company.id, userId: owner.user.id };
  const provider = yield* store.connectProvider({
    ...who,
    provider: "openai",
    credentials: Redacted.make(KEY)
  });
  const role = (handle: string, kind: "decision" | "text") =>
    store.createRole({
      ...who,
      handle,
      kind,
      description: handle,
      providerId: provider.id,
      model: kind === "decision" ? "gpt-6-luna" : "gpt-test"
    });
  const triage = yield* role("triage", "decision");
  const writer = yield* role("writer", "text");
  const uses = {
    triage: { kind: "models", handle: "triage", id: triage.id, revision: triage.metadataRevision },
    writer: { kind: "models", handle: "writer", id: writer.id, revision: writer.metadataRevision }
  } as const;
  const patchId = `${owner.company.handle}-desk`;
  const versionId = `${patchId}-v1`;
  yield* sql`INSERT INTO patches (id, company_id, owner_user_id, title, name)
    VALUES (${patchId}, ${owner.company.id}, ${owner.user.id}, 'Desk', 'desk')`;
  yield* sql`INSERT INTO patch_versions (id, patch_id, version_number, object_key,
    content_hash, file_size, created_by_machine_token_id, owner_user_id, tier, release,
    manifest_version, wire_version, schema_revision, manifest, publish_key, payload_digest,
    publish_response, publish_status)
    VALUES (${versionId}, ${patchId}, 1, ${`models/${versionId}.html`}, 'test', 1,
      ${DEV_SEED.tokenId}, ${owner.user.id}, 2, 'test', 1, 1, 0, ${JSON.stringify({ uses })}::jsonb,
      ${versionId}, 'test', '{}'::jsonb, 201)`;
  yield* sql`UPDATE patches SET current_version_id = ${versionId} WHERE id = ${patchId}`;
  const viewer = {
    user: { id: owner.user.id, name: owner.user.name, email: owner.user.email },
    company: { id: owner.company.id, name: owner.company.name, handle: owner.company.handle },
    admin: true
  };
  /** The action's binding as the gateway hands a model call it, until `deadlineMs` from now. */
  const binding = (
    options: {
      readonly deadlineMs?: number;
      readonly reauthorize?: Binding.Binding["Service"]["reauthorize"];
      readonly guest?: boolean;
      readonly modelPool?: Binding.Binding["Service"]["modelPool"];
    } = {}
  ) =>
    Binding.Binding.of({
      companyId: owner.company.id,
      patchId,
      versionId,
      wireVersion: WIRE_VERSION,
      scope: "company",
      correlationId: "models-test",
      principal: { userId: owner.user.id },
      identity: options.guest === true ? { ...viewer, guest: true } : viewer,
      reauthorize: options.reauthorize ?? Effect.succeed(viewer),
      deadline: Date.now() + (options.deadlineMs ?? 60_000),
      ...(options.modelPool === undefined ? {} : { modelPool: options.modelPool }),
      manifest: {
        manifestVersion: 1,
        release: CURRENT_RELEASE,
        tier: 2,
        tables: {},
        files: {},
        uses
      }
    });
  return { owner, store, who, provider, triage, writer, binding };
});
type Scene = Effect.Success<ReturnType<typeof setup>>;

const decideArgs = {
  connection: "triage",
  input: INPUT,
  questions: {
    team: {
      type: "choice",
      instructions: "Which team?",
      options: { billing: "Charges", technical: "Bugs" }
    }
  }
};
const generateArgs = (input: string = INPUT) => ({
  connection: "writer",
  instructions: "Answer briefly.",
  input,
  maxOutputTokens: 64
});

/** The handlers over `provider`, as the host composes them. */
const handlers = (provider: ReturnType<typeof scripted>) =>
  Effect.flatMap(provider.source, (source) =>
    Operations.makeHandlers.pipe(Effect.provideService(Source.Source, source))
  );
const call = (
  made: Effect.Success<ReturnType<typeof handlers>>,
  op: "models.decide" | "models.generate",
  args: unknown,
  binding: Binding.Binding["Service"]
) => made[op].run(args).pipe(Effect.provideService(Binding.Binding, binding));
/** The refusal a call ended with, as the page reads it. */
const refusal = <A>(exit: Exit.Exit<A, Runtime.RuntimeError>) => {
  if (Exit.isSuccess(exit)) return assert.fail("expected a refusal");
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  if (error?._tag !== "Fail") return assert.fail("expected a typed refusal");
  return Runtime.toFailure(error.error);
};
const modelEvents = () =>
  events.filter((event): event is WideEvents.ModelEvent => event.type === "model");
const settled = Effect.yieldNow;

it.layer(layer, { excludeTestServices: true, timeout: 60_000 })("model calls", (it) => {
  it.effect("answer a decision and a text through a role, recorded without what was said", () =>
    Effect.gen(function* () {
      events.length = 0;
      const scene = yield* setup();
      const made = yield* handlers(ordinary);
      const decision = yield* call(made, "models.decide", decideArgs, scene.binding());
      assert.deepStrictEqual(decision, {
        answers: { team: { choice: "billing", probabilities: { billing: 0.9, technical: 0.1 } } },
        usage: { inputTokens: 9, outputTokens: 0 }
      });
      const written = yield* call(made, "models.generate", generateArgs(), scene.binding());
      assert.deepStrictEqual(written, {
        text: "A short answer.",
        usage: { inputTokens: 5, outputTokens: 3 }
      });
      yield* settled;
      const recorded = modelEvents();
      assert.strictEqual(recorded.length, 2);
      assert.deepInclude(recorded[0], {
        companyId: scene.owner.company.id,
        roleId: scene.triage.id,
        providerId: scene.provider.id,
        provider: "openai",
        model: "gpt-6-luna",
        modelKind: "decision",
        door: "published",
        sent: true,
        outcome: "success",
        inputTokens: 9,
        outputTokens: 0
      });
      assert.deepInclude(recorded[1], { roleId: scene.writer.id, modelKind: "text", sent: true });
      for (const event of recorded) assert.notInclude(JSON.stringify(event), INPUT);
    })
  );

  it.effect(
    "refuse an undeclared alias, the other kind, a blocked guest and a bad output, sending nothing",
    () =>
      Effect.gen(function* () {
        events.length = 0;
        const scene = yield* setup();
        const provider = scripted(() => text("never"));
        const made = yield* handlers(provider);
        const undeclared = refusal(
          yield* Effect.exit(
            call(made, "models.decide", { ...decideArgs, connection: "nope" }, scene.binding())
          )
        );
        assert.strictEqual(undeclared.code, "connection_not_declared");
        const otherKind = refusal(
          yield* Effect.exit(
            call(made, "models.decide", { ...decideArgs, connection: "writer" }, scene.binding())
          )
        );
        assert.strictEqual(otherKind.code, "invalid_request");
        assert.deepStrictEqual(otherKind.details, { sent: false, reason: "kind", kind: "text" });
        yield* scene.store.blockGuests({ ...scene.who, id: scene.writer.id, block: true });
        const guest = refusal(
          yield* Effect.exit(
            call(made, "models.generate", generateArgs(), scene.binding({ guest: true }))
          )
        );
        assert.strictEqual(guest.code, "access_denied");
        const badOutput = refusal(
          yield* Effect.exit(
            call(
              made,
              "models.generate",
              {
                ...generateArgs(),
                output: { kind: "object", fields: { at: { kind: "timestamp" } } }
              },
              scene.binding()
            )
          )
        );
        assert.strictEqual(badOutput.code, "invalid_request");
        assert.strictEqual(provider.sent.length, 0);
        yield* settled;
        assert.deepStrictEqual(
          modelEvents().map((event) => [event.code, event.sent, event.outcome]),
          [
            ["connection_not_declared", false, "failure"],
            ["invalid_request", false, "failure"],
            ["access_denied", false, "failure"],
            ["invalid_request", false, "failure"]
          ]
        );
      })
  );

  it.effect("refuse busy, sending nothing, when the action can't enter the model pool", () =>
    Effect.gen(function* () {
      const scene = yield* setup();
      const provider = scripted(() => text("never"));
      const made = yield* handlers(provider);
      const pool = refusal(
        yield* Effect.exit(
          call(
            made,
            "models.generate",
            generateArgs(),
            scene.binding({
              modelPool: Effect.fail(
                new ActionSlots.ModelPoolBusy({ limitId: "tier2.models.viewer", value: 4 })
              )
            })
          )
        )
      );
      assert.deepInclude(pool, { code: "busy", limitId: "tier2.models.viewer", retryAfter: 1 });
      assert.deepStrictEqual(pool.details, { sent: false });
      assert.strictEqual(provider.sent.length, 0);
    })
  );

  /** Holds one call at the provider, starts another that waits in the queue, and changes things. */
  const whileWaiting = (
    change: (scene: Scene) => Effect.Effect<unknown, unknown, ConnectionStore.ConnectionStore>,
    options: {
      readonly reauthorize?: (scene: Scene) => Binding.Binding["Service"]["reauthorize"];
    } = {}
  ) =>
    Effect.gen(function* () {
      const scene = yield* setup();
      const provider = scripted((_, body) => (held(body) ? "hang" : text("answered")));
      const made = yield* handlers(provider);
      const first = yield* Effect.forkChild(
        call(made, "models.generate", generateArgs("hold"), scene.binding())
      );
      while (provider.sent.length === 0) yield* Effect.sleep("5 millis");
      const waiting = yield* Effect.forkChild(
        Effect.exit(
          call(
            made,
            "models.generate",
            generateArgs(),
            scene.binding(
              options.reauthorize === undefined ? {} : { reauthorize: options.reauthorize(scene) }
            )
          )
        )
      );
      yield* Effect.sleep("50 millis");
      yield* change(scene);
      yield* Fiber.interrupt(first);
      const outcome = yield* Fiber.join(waiting);
      return { outcome, sent: provider.sent.length };
    });

  it.effect("answer connection_changed when a role is remapped while its call waits", () =>
    Effect.gen(function* () {
      const { outcome, sent } = yield* whileWaiting((scene) =>
        scene.store.changeModels({
          ...scene.who,
          id: scene.writer.id,
          change: { kind: "remap", providerId: scene.provider.id, model: "gpt-other" }
        })
      );
      const failure = refusal(outcome);
      assert.strictEqual(failure.code, "source_unavailable");
      assert.deepStrictEqual(failure.details, { sent: false, reason: "connection_changed" });
      assert.strictEqual(sent, 1, "only the held call reached the provider");
    })
  );

  it.effect(
    "answer connection_changed when the provider's key is replaced while a call waits",
    () =>
      Effect.gen(function* () {
        const { outcome, sent } = yield* whileWaiting((scene) =>
          scene.store.changeModels({
            ...scene.who,
            id: scene.provider.id,
            change: { kind: "replaceKey", credentials: Redacted.make("sk-replaced") }
          })
        );
        assert.deepStrictEqual(refusal(outcome).details, {
          sent: false,
          reason: "connection_changed"
        });
        assert.strictEqual(sent, 1);
      })
  );

  it.effect("refuse when the provider or the role is paused while a call waits", () =>
    Effect.gen(function* () {
      for (const target of ["provider", "writer"] as const) {
        const { outcome, sent } = yield* whileWaiting((scene) =>
          scene.store.changeModels({
            ...scene.who,
            id: target === "provider" ? scene.provider.id : scene.writer.id,
            change: { kind: "pause" }
          })
        );
        assert.strictEqual(refusal(outcome).code, "access_denied", target);
        assert.strictEqual(sent, 1, target);
      }
    })
  );

  it.effect("refuse when the viewer loses access while the call waits", () =>
    Effect.gen(function* () {
      let allowed = true;
      const { outcome, sent } = yield* whileWaiting(
        () =>
          Effect.sync(() => {
            allowed = false;
          }),
        {
          reauthorize: (scene) =>
            Effect.suspend(() =>
              allowed
                ? Effect.succeed(scene.binding().identity!)
                : Effect.fail(new Runtime.SessionExpired({}))
            )
        }
      );
      assert.strictEqual(refusal(outcome).code, "session_expired");
      assert.strictEqual(sent, 1);
    })
  );

  it.effect("refuse busy at the queue's bound, and after waiting out the time left", () =>
    Effect.gen(function* () {
      const scene = yield* setup();
      const provider = scripted((_, body) => (held(body) ? "hang" : text("answered")));
      const made = yield* handlers(provider);
      const first = yield* Effect.forkChild(
        call(made, "models.generate", generateArgs("hold"), scene.binding())
      );
      while (provider.sent.length === 0) yield* Effect.sleep("5 millis");
      // Waits until two seconds before its deadline, then gives up: nothing sent.
      const short = yield* Effect.forkChild(
        Effect.exit(
          call(made, "models.generate", generateArgs(), scene.binding({ deadlineMs: 2_300 }))
        )
      );
      yield* Effect.sleep("50 millis");
      const full = refusal(
        yield* Effect.exit(call(made, "models.generate", generateArgs(), scene.binding()))
      );
      assert.deepInclude(full, { code: "busy", limitId: "models.queue.waiting", retryAfter: 1 });
      const waited = refusal(yield* Fiber.join(short));
      assert.deepInclude(waited, { code: "busy", limitId: "models.outbound.provider" });
      assert.isUndefined(waited.retryAfter);
      assert.deepStrictEqual(waited.details, { sent: false });
      yield* Fiber.interrupt(first);
      assert.strictEqual(provider.sent.length, 1);
    })
  );

  it.effect("keep the key and the input out of events, logs, spans and every refusal", () =>
    Effect.gen(function* () {
      events.length = 0;
      const scene = yield* setup();
      const logs: string[] = [];
      const spans: Tracer.NativeSpan[] = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        }
      });
      const echoing = scripted((_, body) =>
        json(
          {
            error: {
              type: "invalid_request_error",
              message: `Incorrect API key provided: ${KEY}. You sent: ${JSON.stringify(body)}`
            }
          },
          401
        )
      );
      const made = yield* handlers(echoing);
      const failure = refusal(
        yield* Effect.exit(
          call(made, "models.generate", generateArgs(), scene.binding()).pipe(
            Effect.withTracer(tracer),
            Effect.provide(
              Logger.layer(
                [Logger.make((event) => void logs.push(JSON.stringify(event.message)))],
                {
                  mergeWithExisting: true
                }
              )
            )
          )
        )
      );
      assert.strictEqual(failure.code, "source_unavailable");
      assert.deepStrictEqual(failure.details, { sent: true, reason: "key", upstreamStatus: 401 });
      assert.strictEqual(echoing.sent[0]?.authorization, `Bearer ${KEY}`);
      yield* settled;
      const said = [
        JSON.stringify(failure),
        ...modelEvents().map((event) => JSON.stringify(event)),
        ...logs,
        ...spans.map((span) =>
          JSON.stringify({
            name: span.name,
            attributes: [...span.attributes],
            events: span.events,
            status: span.status._tag === "Ended" ? String(span.status.exit) : "open"
          })
        )
      ];
      assert.isAbove(said.length, 1);
      for (const line of said) {
        assert.notInclude(line, KEY);
        assert.notInclude(line, INPUT);
      }
    })
  );

  /** A final check whose authorization lands `change` while it runs, then approves the viewer. */
  const landing = (
    scene: Scene,
    change: (scene: Scene) => Effect.Effect<unknown, unknown>,
    viewer: Partial<NonNullable<Binding.Binding["Service"]["identity"]>> = {}
  ) =>
    Effect.suspend(() => change(scene)).pipe(
      Effect.orDie,
      Effect.as({ ...scene.binding().identity!, ...viewer })
    );

  it.effect("send nothing when a change lands while the final check authorizes", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<
        readonly [
          string,
          (scene: Scene) => Effect.Effect<unknown, unknown>,
          Record<string, unknown>,
          Partial<NonNullable<Binding.Binding["Service"]["identity"]>>?
        ]
      > = [
        [
          "remap",
          (scene) =>
            scene.store.changeModels({
              ...scene.who,
              id: scene.writer.id,
              change: { kind: "remap", providerId: scene.provider.id, model: "gpt-other" }
            }),
          { code: "source_unavailable", details: { sent: false, reason: "connection_changed" } }
        ],
        [
          "key replaced",
          (scene) =>
            scene.store.changeModels({
              ...scene.who,
              id: scene.provider.id,
              change: { kind: "replaceKey", credentials: Redacted.make("sk-replaced") }
            }),
          { code: "source_unavailable", details: { sent: false, reason: "connection_changed" } }
        ],
        [
          "role paused",
          (scene) =>
            scene.store.changeModels({
              ...scene.who,
              id: scene.writer.id,
              change: { kind: "pause" }
            }),
          { code: "access_denied", details: { sent: false } }
        ],
        [
          "provider paused",
          (scene) =>
            scene.store.changeModels({
              ...scene.who,
              id: scene.provider.id,
              change: { kind: "pause" }
            }),
          { code: "access_denied", details: { sent: false } }
        ],
        [
          "guests blocked, the viewer now a guest",
          (scene) => scene.store.blockGuests({ ...scene.who, id: scene.writer.id, block: true }),
          { code: "access_denied", details: { sent: false } },
          { guest: true }
        ]
      ];
      for (const [name, change, expected, viewer] of cases) {
        const scene = yield* setup();
        const provider = scripted(() => text("sent anyway"));
        const made = yield* handlers(provider);
        const failure = refusal(
          yield* Effect.exit(
            call(
              made,
              "models.generate",
              generateArgs(),
              scene.binding({ reauthorize: landing(scene, change, viewer) })
            )
          )
        );
        assert.deepInclude(failure, expected, name);
        assert.strictEqual(provider.sent.length, 0, `${name}: nothing sent`);
      }
    })
  );

  it.effect("say whether anything was sent on every refusal a handler gives", () =>
    Effect.gen(function* () {
      const scene = yield* setup();
      const made = yield* handlers(scripted(() => text("never")));
      yield* scene.store.changeModels({
        ...scene.who,
        id: scene.writer.id,
        change: { kind: "pause" }
      });
      const paused = refusal(
        yield* Effect.exit(call(made, "models.generate", generateArgs(), scene.binding()))
      );
      assert.deepInclude(paused, { code: "access_denied", details: { sent: false } });
      const malformed = refusal(
        yield* Effect.exit(
          call(made, "models.generate", { ...generateArgs(), maxOutputTokens: 1 }, scene.binding())
        )
      );
      assert.deepInclude(malformed, { code: "invalid_request", details: { sent: false } });
      const undeclared = refusal(
        yield* Effect.exit(
          call(made, "models.generate", { ...generateArgs(), connection: "nope" }, scene.binding())
        )
      );
      assert.deepInclude(undeclared, { code: "connection_not_declared", details: { sent: false } });
    })
  );

  /** A role's call through the real callback gateway, as an action's guest makes it. */
  const relay = Effect.fn(function* (
    scene: Scene,
    provider: ReturnType<typeof scripted>,
    options: {
      readonly kind?: "query" | "mutation" | "action";
      readonly deadlineMs?: number;
      readonly treeBytes?: number;
      readonly modelPool?: Binding.Binding["Service"]["modelPool"];
      readonly reauthorize?: Binding.Binding["Service"]["reauthorize"];
      /** How long the callback journal takes to open each call's row. */
      readonly journalMs?: number;
      readonly store?: (
        store: ConnectionStore.ConnectionStore["Service"]
      ) => ConnectionStore.ConnectionStore["Service"];
    } = {}
  ) {
    const store = yield* ConnectionStore.ConnectionStore;
    const made = yield* handlers(provider).pipe(
      Effect.provideService(ConnectionStore.ConnectionStore, options.store?.(store) ?? store)
    );
    const capabilities = yield* InvocationCapabilities.make;
    const journal = yield* RuntimeLog.RuntimeLog;
    const gateway = yield* CallbackGateway.make(made).pipe(
      Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities),
      Effect.provideService(RuntimeLog.RuntimeLog, {
        ...journal,
        begin: (input) =>
          Effect.sleep(options.journalMs ?? 0).pipe(Effect.andThen(journal.begin(input)))
      })
    );
    const capability = yield* capabilities.issue({
      binding: {
        ...scene.binding(
          options.reauthorize === undefined ? {} : { reauthorize: options.reauthorize }
        ),
        invocationId: "inv_models",
        effectivePrincipal: "patch"
      },
      attempt: {
        invocationId: "inv_models",
        attemptId: "attempt_models",
        processGeneration: 1,
        deadline: Date.now() + (options.deadlineMs ?? 60_000)
      },
      kind: options.kind ?? "action",
      readOnly: false,
      ...(options.treeBytes === undefined ? {} : { tree: { bytes: options.treeBytes } }),
      ...(options.modelPool === undefined ? {} : { modelPool: options.modelPool })
    });
    return {
      capability,
      /** Ends the action, as its deadline or its return would. */
      end: capabilities.end(capability.token, "returned"),
      send: (op: string, args: Record<string, unknown>, body?: GuestProtocol.Callback["body"]) =>
        gateway.callback(capability.token, capability.attempt, {
          op,
          args: args as Record<string, typeof Schema.Json.Type>,
          ...(body === undefined ? {} : { body })
        })
    };
  });

  it.effect(
    "say nothing was sent when the door refuses and the reply can't fit the call tree",
    () =>
      Effect.gen(function* () {
        const scene = yield* setup();
        const limit = 64 * 1024 * 1024;
        const args = generateArgs();
        const requestBytes = new TextEncoder().encode(
          JSON.stringify({ op: "models.generate", args })
        ).byteLength;
        const tight = yield* relay(
          scene,
          scripted(() => text("never")),
          {
            treeBytes: limit - requestBytes - 40,
            reauthorize: Effect.fail(new Runtime.SessionExpired({}))
          }
        );
        assert.deepInclude(yield* tight.send("models.generate", args), {
          ok: false,
          details: { sent: false }
        });
      }).pipe(Effect.scoped)
  );

  it.effect("record a model call refused for its file body before the handler runs", () =>
    Effect.gen(function* () {
      events.length = 0;
      const scene = yield* setup();
      const action = yield* relay(
        scene,
        scripted(() => text("never"))
      );
      const reply = yield* action.send("models.generate", generateArgs(), {
        bytes: new Uint8Array([1, 2, 3]),
        contentType: "application/octet-stream"
      });
      assert.deepInclude(reply, { ok: false, code: "invalid_request", details: { sent: false } });
      yield* settled;
      assert.deepInclude(
        modelEvents().map((event) => [event.code, event.sent]),
        ["invalid_request", false]
      );
    }).pipe(Effect.scoped)
  );

  it.effect("time a slow door from its own start, and journal it as a failure, nothing sent", () =>
    Effect.gen(function* () {
      const scene = yield* setup();
      const sql = yield* SqlClient.SqlClient;
      // 2.6 s left, 800 ms of it spent opening the journal row: the door has until 1.6 s.
      const slow = yield* relay(
        scene,
        scripted(() => text("never")),
        {
          deadlineMs: 2_600,
          journalMs: 800,
          reauthorize: Effect.sleep("3 seconds").pipe(Effect.as(scene.binding().identity!))
        }
      );
      const started = Date.now();
      const reply = yield* slow.send("models.generate", generateArgs());
      const elapsed = Date.now() - started;
      assert.deepInclude(reply, { ok: false, code: "timeout", details: { sent: false } });
      assert.isAbove(elapsed, 1_400);
      assert.isBelow(elapsed, 1_900, "the cut-off, not the cut-off plus the journal write");
      const [row] = yield* sql<{ readonly outcome: string; readonly outcome_code: string }>`
        SELECT outcome, outcome_code FROM runtime_calls
        WHERE company_id = ${scene.owner.company.id} AND op = 'models.generate'`;
      assert.deepStrictEqual(row, { outcome: "failure", outcome_code: "timeout" });
    }).pipe(Effect.scoped)
  );

  it.effect("journal what the caller was told when the action ends at a stalled door", () =>
    Effect.gen(function* () {
      const scene = yield* setup();
      const sql = yield* SqlClient.SqlClient;
      const stalled = yield* relay(
        scene,
        scripted(() => text("never")),
        {
          reauthorize: Effect.never
        }
      );
      const waiting = yield* Effect.forkChild(stalled.send("models.generate", generateArgs()));
      yield* Effect.sleep("200 millis");
      yield* stalled.end;
      const reply = yield* Fiber.join(waiting);
      assert.deepInclude(reply, { ok: false, code: "access_denied", details: { sent: false } });
      yield* Effect.sleep("100 millis");
      const [row] = yield* sql<{ readonly outcome: string; readonly outcome_code: string }>`
        SELECT outcome, outcome_code FROM runtime_calls
        WHERE company_id = ${scene.owner.company.id} AND op = 'models.generate'`;
      assert.deepStrictEqual(row, { outcome: "failure", outcome_code: "access_denied" });
    }).pipe(Effect.scoped)
  );

  it.effect("journal a refused connection as a failure, nothing sent", () =>
    Effect.gen(function* () {
      const scene = yield* setup();
      const sql = yield* SqlClient.SqlClient;
      const port = yield* Effect.callback<number>((resume) => {
        const probe = createNetServer();
        probe.listen(0, "127.0.0.1", () => {
          const address = probe.address();
          probe.close(() =>
            resume(
              Effect.succeed(typeof address === "object" && address !== null ? address.port : 0)
            )
          );
        });
      });
      // The real fetch, at a port nobody listens on.
      const refused = yield* relay(scene, {
        sent: [],
        source: Source.makeAt(`http://127.0.0.1:${port}/v1`).pipe(
          Effect.provide(FetchHttpClient.layer)
        )
      });
      const reply = yield* refused.send("models.generate", generateArgs());
      assert.deepInclude(reply, {
        ok: false,
        code: "source_unavailable",
        details: { sent: false, reason: "unreachable" }
      });
      yield* Effect.sleep("100 millis");
      const [row] = yield* sql<{ readonly outcome: string; readonly outcome_code: string }>`
        SELECT outcome, outcome_code FROM runtime_calls
        WHERE company_id = ${scene.owner.company.id} AND op = 'models.generate'`;
      assert.deepStrictEqual(row, { outcome: "failure", outcome_code: "source_unavailable" });
    }).pipe(Effect.scoped)
  );

  it.effect("journal a connection dropped after dispatch as unknown, the refusal saying sent", () =>
    Effect.gen(function* () {
      const scene = yield* setup();
      const sql = yield* SqlClient.SqlClient;
      const dropped = yield* relay(
        scene,
        scripted(() => "reset")
      );
      const reply = yield* dropped.send("models.generate", generateArgs());
      assert.deepInclude(reply, {
        ok: false,
        code: "source_unavailable",
        details: { sent: true, reason: "unreachable" }
      });
      yield* Effect.sleep("100 millis");
      const [row] = yield* sql<{ readonly outcome: string; readonly outcome_code: string }>`
        SELECT outcome, outcome_code FROM runtime_calls
        WHERE company_id = ${scene.owner.company.id} AND op = 'models.generate'`;
      assert.deepStrictEqual(row, { outcome: "unknown", outcome_code: "unknown_outcome" });
    }).pipe(Effect.scoped)
  );

  it.effect("end a model call whose door is slow at its cut-off, nothing sent", () =>
    Effect.gen(function* () {
      const scene = yield* setup();
      const slow = yield* relay(
        scene,
        scripted(() => text("never")),
        {
          deadlineMs: 2_600,
          reauthorize: Effect.sleep("3 seconds").pipe(Effect.as(scene.binding().identity!))
        }
      );
      const started = Date.now();
      const reply = yield* slow.send("models.generate", generateArgs());
      assert.deepInclude(reply, {
        ok: false,
        code: "timeout",
        limitId: "models.cutoff",
        details: { sent: false }
      });
      assert.isBelow(Date.now() - started, 2_200, "answered at the cut-off, not the deadline");
    }).pipe(Effect.scoped)
  );

  it.effect(
    "relay through the gateway whether anything was sent, early refusals and slow lookups included",
    () =>
      Effect.gen(function* () {
        events.length = 0;
        const scene = yield* setup();
        const query = yield* relay(
          scene,
          scripted(() => text("never")),
          { kind: "query" }
        );
        assert.deepInclude(yield* query.send("models.generate", generateArgs()), {
          ok: false,
          code: "access_denied",
          details: { sent: false }
        });
        const slow = yield* relay(
          scene,
          scripted(() => text("never")),
          {
            deadlineMs: 2_600,
            // The final read, the one that loads the key, takes longer than the action has left.
            store: (store) => ({
              ...store,
              modelCall: (input) =>
                input.key
                  ? Effect.sleep("3 seconds").pipe(Effect.andThen(store.modelCall(input)))
                  : store.modelCall(input)
            })
          }
        );
        assert.deepInclude(yield* slow.send("models.generate", generateArgs()), {
          ok: false,
          code: "timeout",
          details: { sent: false }
        });
        const refused = yield* relay(
          scene,
          scripted(() =>
            json({ error: { type: "invalid_request_error", code: "invalid_api_key" } }, 401)
          )
        );
        assert.deepInclude(yield* refused.send("models.generate", generateArgs()), {
          ok: false,
          code: "source_unavailable",
          details: { sent: true, reason: "key", upstreamStatus: 401 }
        });
        yield* settled;
        // The query's refusal is an attempt the host saw, with its own event.
        assert.deepInclude(
          modelEvents().map((event) => [event.code, event.sent, event.modelKind]),
          ["access_denied", false, "text"]
        );
      }).pipe(Effect.scoped)
  );

  it.effect("keep a model's answer when the call tree's bytes run out after it was sent", () =>
    Effect.gen(function* () {
      const scene = yield* setup();
      const limit = 64 * 1024 * 1024;
      const tight = yield* relay(
        scene,
        scripted(() => text("x".repeat(4_000))),
        {
          treeBytes: limit - 1_000
        }
      );
      const reply = yield* tight.send("models.generate", generateArgs("short"));
      assert.isTrue(reply.ok, JSON.stringify(reply).slice(0, 200));
    }).pipe(Effect.scoped)
  );

  it.effect("give a refused fifth call an attempt event of its own", () =>
    Effect.gen(function* () {
      events.length = 0;
      const scene = yield* setup();
      // Four calls held at the pool step, inside the handler, each counted as running.
      const action = yield* relay(
        scene,
        scripted(() => "hang"),
        { modelPool: Effect.never }
      );
      const running = yield* Effect.forEach([1, 2, 3, 4], () =>
        Effect.forkChild(action.send("models.generate", generateArgs()))
      );
      yield* Effect.sleep("100 millis");
      assert.deepInclude(yield* action.send("models.generate", generateArgs()), {
        ok: false,
        code: "busy",
        limitId: "models.calls.inFlight"
      });
      yield* settled;
      assert.deepInclude(
        modelEvents().map((event) => [event.code, event.sent]),
        ["busy", false]
      );
      yield* Fiber.interruptAll(running);
    }).pipe(Effect.scoped)
  );

  it.effect("record a call its action left open after sending it as sent and unanswered", () =>
    Effect.gen(function* () {
      events.length = 0;
      const scene = yield* setup();
      const provider = scripted(() => "hang");
      const made = yield* handlers(provider);
      // The action ends while the provider still holds the request: its work is interrupted.
      const open = yield* Effect.forkChild(
        call(made, "models.generate", generateArgs(), scene.binding())
      );
      while (provider.sent.length === 0) yield* Effect.sleep(10);
      yield* Fiber.interrupt(open);
      yield* settled;
      assert.deepStrictEqual(
        modelEvents().map((event) => [event.code, event.sent, event.outcome]),
        [[undefined, true, "interrupted"]]
      );
    }).pipe(Effect.scoped)
  );
  it.effect("record the pool move's peaks on the action's event, not the attempt's", () =>
    Effect.gen(function* () {
      events.length = 0;
      const scene = yield* setup();
      const wide = yield* WideEvents.WideEvents;
      const limit = (limitId: string, value: number) =>
        new OperatingLimits.EffectiveLimit({
          companyId: scene.owner.company.id,
          limitId,
          value,
          overrideValue: null,
          configRevision: new OperatingLimits.ConfigRevision({
            deploymentRevision: "test",
            overrideRevision: "0"
          })
        });
      const slots = ActionSlots.make({ replica: 64, deploymentRevision: "test" });
      const slot = yield* slots.admit(
        {
          companyId: scene.owner.company.id,
          patchId: "desk",
          userId: scene.owner.user.id,
          caller: "page"
        },
        { company: limit("tier2.actions.company", 8), viewer: limit("tier2.actions.viewer", 2) }
      );
      yield* wide.withEvent(
        { type: "request" },
        Effect.gen(function* () {
          const action = yield* relay(scene, ordinary, {
            modelPool: slot
              .transfer({
                company: limit("tier2.models.company", 24),
                viewer: limit("tier2.models.viewer", 4)
              })
              .pipe(
                Effect.catchTags({
                  SlotReleased: (cause) => Effect.fail(new Runtime.AccessDenied({ cause }))
                })
              )
          });
          assert.isTrue((yield* action.send("models.generate", generateArgs())).ok);
        }).pipe(Effect.scoped)
      );
      yield* settled;
      const pool = (event: WideEvents.WideEvent) =>
        (event.limits ?? []).filter((entry) => entry.limitId.startsWith("tier2.models.")).length;
      const request = events.find((event) => event.type === "request");
      assert.strictEqual(pool(request!), 3, "the action's event has the pool's three limits");
      for (const event of modelEvents()) assert.strictEqual(pool(event), 0);
    })
  );

  it.effect(
    "keep markers in a successful and a refused answer out of the journal and the record",
    () =>
      Effect.gen(function* () {
        events.length = 0;
        const scene = yield* setup();
        const sql = yield* SqlClient.SqlClient;
        const answerMarker = "ANSWER-MARKER-5b0e";
        const refusalMarker = "REFUSAL-MARKER-c71a";
        const answered = yield* relay(
          scene,
          scripted(() => text(answerMarker))
        );
        const ok = yield* answered.send("models.generate", generateArgs());
        assert.include(JSON.stringify(ok), answerMarker, "the patch gets its answer");
        const declined = yield* relay(
          scene,
          scripted(() =>
            json({
              id: "resp_2",
              object: "response",
              created_at: 1,
              model: "gpt-test",
              status: "completed",
              output: [
                {
                  type: "message",
                  id: "msg_2",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "refusal", refusal: `I won't: ${refusalMarker} ${INPUT}` }]
                }
              ],
              usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 }
            })
          )
        );
        const refusedReply = yield* declined.send("models.generate", generateArgs());
        assert.deepInclude(refusedReply, { ok: false, code: "model_refused" });
        yield* settled;
        const journal =
          yield* sql`SELECT * FROM runtime_calls WHERE company_id = ${scene.owner.company.id}`;
        assert.isAbove(journal.length, 1);
        for (const line of [
          JSON.stringify(refusedReply),
          JSON.stringify(journal),
          ...modelEvents().map((event) => JSON.stringify(event))
        ]) {
          for (const marker of [answerMarker, refusalMarker, INPUT, KEY])
            assert.notInclude(line, marker);
        }
      }).pipe(Effect.scoped)
  );
});

describe("model refusals on the wire", () => {
  it("carry their code, limit, retry and whether anything was sent through the guest's codec", () => {
    const decodeReply = Schema.decodeUnknownSync(GuestProtocol.CallbackReply, {
      onExcessProperty: "error"
    });
    const decodeFailure = Schema.decodeUnknownSync(RuntimeFailure, { onExcessProperty: "error" });
    const cases: ReadonlyArray<readonly [Runtime.RuntimeError, Record<string, unknown>]> = [
      [
        new Errors.Timeout({ sent: false, milliseconds: 1_500 }),
        { code: "timeout", limitId: "models.send.floor", details: { sent: false } }
      ],
      [
        new Errors.Timeout({ sent: true, milliseconds: 58_000 }),
        { code: "timeout", limitId: "models.cutoff", details: { sent: true } }
      ],
      [
        new Errors.RateLimited({ limit: "requests", retryAfterSeconds: 7 }),
        { code: "source_rate_limited", retryAfter: 7, details: { sent: true, limit: "requests" } }
      ],
      [new Errors.Refused({}), { code: "model_refused", details: { sent: true } }],
      [
        new Errors.OutputTruncated({ maxOutputTokens: 64 }),
        { code: "output_truncated", details: { sent: true, maxOutputTokens: 64 } }
      ],
      [new Errors.ShapeMismatch({}), { code: "shape_mismatch", details: { sent: true } }],
      [
        new Errors.Unavailable({ reason: "provider", sent: true, upstreamStatus: 500 }),
        {
          code: "source_unavailable",
          details: { sent: true, reason: "provider", upstreamStatus: 500 }
        }
      ],
      [
        new Errors.TooLarge({ limitId: "models.answer.bytes" }),
        { code: "too_large", limitId: "models.answer.bytes", details: { sent: true } }
      ],
      [
        new Errors.InvalidRequest({ reason: "provider", sent: true, upstreamStatus: 400 }),
        {
          code: "invalid_request",
          details: { sent: true, reason: "provider", upstreamStatus: 400 }
        }
      ],
      [
        new Errors.Busy({ limitId: "models.outbound.host", value: 64, waitedMs: 0 }),
        { code: "busy", limitId: "models.outbound.host", retryAfter: 1, details: { sent: false } }
      ]
    ];
    for (const [error, expected] of cases) {
      const failure = Runtime.toFailure(error);
      assert.deepInclude(decodeFailure(failure), expected);
      assert.deepInclude(decodeReply(failure), expected);
    }
  });
});
