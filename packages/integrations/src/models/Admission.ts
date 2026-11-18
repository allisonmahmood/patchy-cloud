/**
 * How this server process admits model calls, shared by published actions and the dev door: one
 * fair gate per provider connection (CallGate), and how many calls `patchy dev` may make per
 * person per UTC day. A dev instance may override either for a test (`PATCHY_DEV_MODEL_GATE`,
 * `PATCHY_DEV_MODEL_DAILY`); production refuses to start with one set. PROTOTYPE.
 */
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as CallGate from "../CallGate.js";

/**
 * The gate's starting numbers, per provider connection in each replica. 16 running keeps one
 * company's calls a small share of a process's outbound requests while leaving a provider's usual
 * request rate far off (16 calls of 20 s are under 50 a minute); 4 per person lets a page's few
 * calls run together and stops one agent's burst taking the connection; 32 waiting, 4 of them a
 * person's, bounds a queue whose tail would mostly wait out its cut-off anyway (the slot load
 * test saw a person's fifth to eighth waiters time out rather than run).
 */
export const GATE: CallGate.Limits = {
  concurrent: 16,
  perPerson: 4,
  waiting: 32,
  perPersonWaiting: 4
};

/**
 * Model calls one person may make through `patchy dev` per UTC day, across every repo and role:
 * a day of building and trying a tool, a few dollars on a mid-sized model, and a stop for a page
 * or agent that calls in a loop. Published patches aren't counted.
 */
export const DEV_DAILY = 200;

export class ConfigRefused extends Schema.TaggedError<ConfigRefused>()("ModelsConfigRefused", {
  name: Schema.Literals(["PATCHY_DEV_MODEL_GATE", "PATCHY_DEV_MODEL_DAILY"]),
  value: Schema.String
}) {
  override get message() {
    return this.name === "PATCHY_DEV_MODEL_GATE"
      ? `PATCHY_DEV_MODEL_GATE=${this.value} is honoured only with NODE_ENV=development or test, as names concurrent, perPerson, waiting and perPersonWaiting with whole numbers.`
      : `PATCHY_DEV_MODEL_DAILY=${this.value} is honoured only with NODE_ENV=development or test, as a whole number of calls.`;
  }
}

export class Admission extends Context.Service<
  Admission,
  {
    /** Every model call to a provider connection in this process passes it. */
    readonly gate: CallGate.Gate;
    /** `patchy dev`'s model calls per person per UTC day. */
    readonly devDaily: number;
  }
>()("@patchy/integrations/models/Admission") {}

/** A dev override, honoured only in development or test; unset is the starting number. */
const override = <A>(
  name: ConfigRefused["name"],
  parse: (text: string) => A | undefined,
  fallback: A
) =>
  Effect.gen(function* () {
    const value = yield* Config.option(Config.String(name));
    if (Option.isNone(value)) return fallback;
    const environment = yield* Config.String("NODE_ENV").pipe(Config.withDefault("production"));
    const parsed = parse(value.value);
    if ((environment !== "development" && environment !== "test") || parsed === undefined)
      return yield* new ConfigRefused({ name, value: value.value });
    return parsed;
  });

export const make = Effect.gen(function* () {
  const limits = yield* override(
    "PATCHY_DEV_MODEL_GATE",
    (text) => CallGate.parseLimits(text, GATE),
    GATE
  );
  const devDaily = yield* override(
    "PATCHY_DEV_MODEL_DAILY",
    (text) => (/^\d{1,6}$/.test(text) ? Number(text) : undefined),
    DEV_DAILY
  );
  return Admission.of({ gate: CallGate.make(limits), devDaily });
});

export const layer = Layer.effect(Admission, make);
