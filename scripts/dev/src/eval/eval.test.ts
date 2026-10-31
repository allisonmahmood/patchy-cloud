import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "vitest";
import { Users } from "@patchy/companies";
import { NodeCryptography } from "@patchy/core";
import * as Testing from "@patchy/sql/testing";
import { loadScenario } from "../scenario.js";
import { makeClaudeTally, makeCodexTally, refusalsIn, unwrapShell } from "./builders.js";
import { namespaceScenario, retireRun, runHandle, seedRun } from "./fixtures.js";
import { pickTarget } from "./grade.js";
import { codexConfig } from "./home.js";
import { metricsOf } from "./metrics.js";
import { bwrapArgs, HOME } from "./sandbox.js";
import { classify } from "./scorecard.js";

const repo = new URL("../../../..", import.meta.url).pathname;
const ended = { exitCode: 0, timedOut: false, seconds: 90, stderr: "" };
const line = (value: unknown) => JSON.stringify(value);

describe("the sandbox", () => {
  const args = bwrapArgs(
    {
      home: "/data/evals/run/home",
      tools: [
        { name: "node", root: "/data/mise/node/24", path: "/opt/node/bin", version: "v24" },
        { name: "git", root: null, path: null, version: "git 2" }
      ],
      env: { PATCHY_API_URL: "http://x.localhost:1" }
    },
    "claude",
    ["-p"]
  );
  const pairs = (flag: string) =>
    args.flatMap((arg, i) => (arg === flag ? [[args[i + 1], args[i + 2]]] : []));

  it("mounts the run's home and the tools, and nothing else of this machine's", () => {
    expect(pairs("--bind")).toEqual([["/data/evals/run/home", HOME]]);
    expect(pairs("--ro-bind")).toEqual([
      ["/usr", "/usr"],
      ["/etc", "/etc"],
      ["/data/mise/node/24", "/opt/node"]
    ]);
    expect(args).toContain("--clearenv");
    expect(args.slice(-3)).toEqual(["--", "claude", "-p"]);
  });

  it("puts the user's own bin and the tools on PATH, and passes the run's variables", () => {
    const env = Object.fromEntries(pairs("--setenv"));
    expect(env.PATH).toBe(`${HOME}/.local/bin:/opt/node/bin:/usr/bin`);
    expect(env.HOME).toBe(HOME);
    expect(env.PATCHY_API_URL).toBe("http://x.localhost:1");
  });
});

describe("the harness logs", () => {
  it("reads Codex's commands, refusals piped past their exit code, answer and usage", () => {
    const tally = makeCodexTally("gpt-6.1-terra");
    const started = {
      id: "item_1",
      type: "command_execution",
      command: "/usr/bin/bash -lc 'pnpm patchy publish --json 2>&1 | tail -3'",
      aggregated_output: "",
      exit_code: null,
      status: "in_progress"
    };
    tally.add(line({ type: "item.started", item: started }));
    const done = tally.add(
      line({
        type: "item.completed",
        item: {
          ...started,
          aggregated_output:
            '{"ok":false,"error":"Generated files are stale.","kind":"local","code":"stale_generated"}\n',
          exit_code: 0,
          status: "completed"
        }
      })
    );
    expect(done).toEqual([
      {
        tool: "Bash",
        input: "pnpm patchy publish --json 2>&1 | tail -3",
        outcome: "ok",
        exitCode: 0,
        error: null,
        refusals: ["stale_generated"]
      }
    ]);
    tally.add(
      line({
        type: "item.completed",
        item: { id: "item_2", type: "agent_message", text: "Published it." }
      })
    );
    tally.add(
      line({
        type: "turn.completed",
        usage: {
          input_tokens: 1000,
          cached_input_tokens: 800,
          output_tokens: 50,
          reasoning_output_tokens: 7
        }
      })
    );
    const log = tally.log(ended);
    expect(log.ending).toBe("finished");
    expect(log.answer).toBe("Published it.");
    expect(log.usage).toEqual({ input: 1000, cachedInput: 800, output: 50, reasoning: 7 });
  });

  it("calls a Codex turn that failed failed, with its reason", () => {
    const tally = makeCodexTally("gpt-6.1-terra");
    tally.add(
      line({ type: "turn.failed", error: { message: "stream disconnected before completion" } })
    );
    expect(tally.log(ended)).toMatchObject({
      ending: "failed",
      detail: "stream disconnected before completion"
    });
  });

  it("reads Claude Code's tool results for refusals and its result for usage", () => {
    const tally = makeClaudeTally("claude-sonnet-5-5");
    tally.add(
      line({ type: "system", subtype: "init", model: "claude-sonnet-5-5", skills: ["patchy"] })
    );
    tally.add(
      line({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Bash",
              input: { command: "pnpm patchy dev stop --json" }
            }
          ]
        }
      })
    );
    tally.add(
      line({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              is_error: true,
              content:
                'Exit code 1\n{"ok":false,"error":"No healthy dev runtime.","kind":"local","code":"not_running"}'
            }
          ]
        }
      })
    );
    tally.add(
      line({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Done.",
        num_turns: 4,
        total_cost_usd: 0.12,
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 90,
          output_tokens: 40
        }
      })
    );
    const log = tally.log(ended);
    expect(log.steps[0]).toMatchObject({
      outcome: "failed",
      exitCode: 1,
      refusals: ["not_running"]
    });
    expect(log.usage).toEqual({ input: 1000, cachedInput: 900, output: 40, reasoning: null });
    expect(log).toMatchObject({ ending: "finished", turns: 4, costUsd: 0.12 });
  });

  it("finds refusals with no code by their kind, and unwraps Codex's shell", () => {
    expect(refusalsIn('noise\n{"ok":false,"error":"x","kind":"rejected"}\n{"ok":true}')).toEqual([
      "rejected"
    ]);
    expect(unwrapShell(`/usr/bin/bash -lc 'echo '\\''hi'\\'''`)).toBe("echo 'hi'");
    expect(unwrapShell('/usr/bin/bash -lc "cat \\"a b\\""')).toBe('cat "a b"');
  });
});

describe("what a run is", () => {
  const log = (overrides: Partial<Parameters<typeof classify>[0]> = {}) => ({
    ending: "finished" as const,
    detail: null,
    answer: "Done.",
    steps: [
      { tool: "Bash", input: "ls", outcome: "ok" as const, exitCode: 0, error: null, refusals: [] }
    ],
    seconds: 60,
    turns: 3,
    usage: { input: null, cachedInput: null, output: null, reasoning: null },
    costUsd: null,
    model: "m",
    ...overrides
  });
  const target = { id: "p1", name: "cheers", address: "http://x/acme/cheers", tier: 1, version: 1 };
  const graded = (published: boolean) => ({
    target: published ? target : null,
    checks: [],
    source: null,
    screenshots: []
  });

  it("classifies by how the builder ended and whether anything was published", () => {
    expect(classify(log(), graded(true)).outcome).toBe("built");
    expect(
      classify(log({ answer: "Which colour should the button be?" }), graded(false)).outcome
    ).toBe("asked");
    expect(classify(log({ answer: "I couldn't publish it." }), graded(false)).outcome).toBe(
      "gave-up"
    );
    expect(classify(log({ ending: "timed-out" }), graded(true)).outcome).toBe("timed-out");
    expect(
      classify(log({ ending: "failed", detail: "API Error: 529 overloaded" }), graded(false))
        .outcome
    ).toBe("infra");
    expect(classify(log({ ending: "no-answer", steps: [] }), graded(false)).outcome).toBe("infra");
  });

  it("grades the most recently published live patch", () => {
    const patch = (id: string, publishedAt: string | null, state = "live") => ({
      id,
      name: id,
      address: `http://x/acme/${id}`,
      tier: 1,
      state,
      currentVersion: publishedAt === null ? null : 1,
      publishedAt
    });
    expect(
      pickTarget({
        patches: [
          patch("old", "2026-11-01T10:00:00Z"),
          patch("new", "2026-11-01T11:00:00Z"),
          patch("retired", "2026-11-01T12:00:00Z", "retired"),
          patch("draft", null)
        ]
      })?.id
    ).toBe("new");
    expect(pickTarget({ patches: [] })).toBeNull();
  });

  it("counts the texts a builder opened, its off-skill lookups and its typechecks", () => {
    const step = (input: string, outcome: "ok" | "failed" = "ok") => ({
      tool: "Bash",
      input,
      outcome,
      exitCode: outcome === "ok" ? 0 : 2,
      error: null,
      refusals: []
    });
    const metrics = metricsOf(
      log({
        steps: [
          { ...step("patchy"), tool: "Skill" },
          step(
            "cat .agents/skills/patchy-loop/SKILL.md .agents/skills/patchy-tables/SKILL.md AGENTS.md"
          ),
          step("grep -rn route node_modules/patchy/dist/client.d.ts"),
          step(
            "cat > src/App.tsx <<'EOF'\nimport { patchy } from \"../patchy/_generated/client.js\";\n// see node_modules/patchy/dist/x.d.ts\nEOF"
          ),
          step("pnpm typecheck", "failed"),
          step("pnpm typecheck && pnpm patchy publish --json")
        ]
      })
    );
    expect(metrics.skillAccesses).toEqual({
      patchy: 1,
      "patchy-loop": 1,
      "patchy-tables": 1,
      "AGENTS.md": 1
    });
    expect(metrics).toMatchObject({
      offSkillLookups: 1,
      typecheckRuns: 2,
      typecheckFailures: 1,
      publishes: 1
    });
  });

  it("keeps the developer's Codex provider and turns its extras off", () => {
    const config = codexConfig(
      'model = "x"\nmodel_provider = "proxy"\n\n[model_providers.proxy]\nbase_url = "https://p.example/v1"\nexperimental_bearer_token = "tok"\n\n[mcp_servers.mine]\nurl = "u"\n'
    );
    expect(config).toContain('model_provider = "proxy"');
    expect(config).toContain('[model_providers.proxy]\nbase_url = "https://p.example/v1"');
    expect(config).toContain("plugins = false");
    expect(config).not.toContain("mcp_servers");
    expect(config.indexOf("model_provider =")).toBeLessThan(config.indexOf("[features]"));
  });
});

const database = Testing.layer().pipe(Layer.provideMerge(NodeCryptography.layer));

it.layer(
  Layer.mergeAll(
    NodeFileSystem.layer,
    NodePath.layer,
    Users.layer.pipe(Layer.provideMerge(database))
  )
)("a run's identities", (it) => {
  it.effect(
    "namespaces every company and email, so two runs of one scenario seed side by side",
    () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const { scenario } = yield* loadScenario(repo, "guests");
        const first = yield* seedRun(scenario, "aaaaa1");
        const second = yield* seedRun(scenario, "bbbbb2");
        expect(first.company.handle).toBe("harbor-aaaaa1");
        expect(second.publisher.email).toMatch(/^[^@+]+\+bbbbb2@/);
        expect(first.token).not.toBe(second.token);
        const jo = namespaceScenario(scenario, "aaaaa1").people.find(
          (person) => person.key === "jo"
        )!;
        expect(jo.company).toBe(runHandle("pine", "aaaaa1"));
        expect(
          (yield* users.list("cmp_env_harbor-aaaaa1")).map((user) => user.name).sort()
        ).toEqual(
          scenario.people
            .filter((person) => person.company === undefined)
            .map((person) => person.name)
            .sort()
        );

        yield* retireRun(scenario, "aaaaa1");
        const retired = yield* users.findByEmail(first.publisher.email);
        expect(retired?.deactivatedAt).not.toBeNull();
        expect((yield* users.findByEmail(second.publisher.email))?.deactivatedAt).toBeFalsy();
      })
  );

  it.effect("keeps a long handle within a handle's 32 characters", () =>
    Effect.sync(() => {
      const handle = runHandle("a-company-with-a-very-long-handle", "zz9zz9");
      expect(handle.length).toBeLessThanOrEqual(32);
      expect(handle).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
    })
  );
});
