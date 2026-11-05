import { assert, it } from "@effect/vitest";
import { isPublicAddress } from "@patchy/core";
import { ContractLimits } from "@patchy/limits";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as ImapTest from "../test/imap.js";
import * as Network from "./Network.js";
import * as Source from "./Source.js";

/**
 * The IMAP source offline, through the network seam and a scripted server on loopback: every
 * refusal names its requirement, and nothing reaches the server before the checks that guard it.
 */

const host = "mail.example.test";
class Certs extends Context.Service<
  Certs,
  { readonly mail: ImapTest.Certificates; readonly other: ImapTest.Certificates }
>()("test/imap/Certs") {}
const certs = Layer.effect(
  Certs,
  Effect.all({
    mail: ImapTest.certificates([host]),
    other: ImapTest.certificates(["imap.provider.test", "*.provider.test"])
  })
);

const settings = (over: Partial<Source.Settings> = {}): Source.Settings => ({
  host,
  port: 993,
  security: "tls",
  username: "invoices@example.test",
  password: Redacted.make("the-right-password"),
  ...over
});
/** One Test through `network`, as the store runs it. */
const inspect = (network: Layer.Layer<Network.Network>, over?: Partial<Source.Settings>) =>
  Effect.gen(function* () {
    const source = yield* Source.Source;
    return yield* source.inspect(settings(over));
  }).pipe(Effect.provide(Source.layer.pipe(Layer.provide(network))));
/** A scripted server and a Test against it, failing with what Test refused. */
const against = (
  script: ImapTest.Script,
  over?: Partial<Source.Settings>,
  presenting: "mail" | "other" = "mail"
) =>
  Effect.gen(function* () {
    const mail = (yield* Certs)[presenting];
    const served = yield* ImapTest.serve(mail, script);
    const result = yield* inspect(ImapTest.network(served, mail), over).pipe(Effect.result);
    return { served, result };
  });
const refusal = <A, E>(result: Result.Result<A, E>) =>
  Result.isFailure(result) ? result.failure : assert.fail("Test was expected to refuse");
const logins = (served: ImapTest.Served) =>
  served.commands.filter((command) => command === "LOGIN" || command.startsWith("AUTHENTICATE"))
    .length;

it.layer(certs)("IMAP source", (it) => {
  it.effect("logs in on 993 with TLS and on 143 with STARTTLS, sending only reads", () =>
    Effect.gen(function* () {
      const { mail } = yield* Certs;
      const served = yield* ImapTest.serve(mail, {
        folders: [
          { path: "INBOX" },
          { path: "Sent", flags: "\\HasNoChildren \\Sent" },
          { path: "Archive/2026", flags: "\\HasNoChildren \\Archive" },
          { path: "Archive", flags: "\\Noselect \\HasChildren" }
        ]
      });
      const network = ImapTest.network(served, mail);
      const implicit = yield* inspect(network);
      assert.deepStrictEqual(
        implicit.folders.map((folder) => [folder.path, folder.specialUse, folder.selectable]),
        [
          ["INBOX", [], true],
          ["Sent", ["\\Sent"], true],
          ["Archive/2026", ["\\Archive"], true],
          ["Archive", [], false]
        ]
      );
      assert.deepInclude(implicit, { host, port: 993, security: "tls", truncated: false });
      const upgraded = yield* inspect(network, { port: 143, security: "starttls" });
      assert.strictEqual(upgraded.security, "starttls");
      const sent = served.commands.map((command) => command.split(" ")[0]);
      // STARTTLS comes before any login, and nothing but reads is ever sent.
      assert.isBelow(sent.indexOf("STARTTLS"), sent.lastIndexOf("AUTHENTICATE"));
      assert.includeMembers(sent, ["EXAMINE", "LIST", "LOGOUT"]);
      for (const write of ["SELECT", "STORE", "COPY", "MOVE", "EXPUNGE", "APPEND", "CREATE"])
        assert.notInclude(sent, write);
      assert.notInclude(served.commands.join("\n"), "the-right-password");
    })
  );

  it.effect(
    "refuses a name that doesn't resolve, a private address and a port pairing, connecting to nothing",
    () =>
      Effect.gen(function* () {
        const { mail } = yield* Certs;
        const served = yield* ImapTest.serve(mail);
        const resolving = (answer: Effect.Effect<ReadonlyArray<string>, Network.LookupFailed>) =>
          Layer.succeed(
            Network.Network,
            Network.Network.of({
              resolve: () => answer,
              admits: (_host, address) => isPublicAddress(address),
              destination: () => ({ address: "127.0.0.1", port: served.tls }),
              ca: () => [mail.ca]
            })
          );
        const missing = yield* inspect(
          resolving(Effect.fail(new Network.LookupFailed({ host, reason: "ENOTFOUND" })))
        ).pipe(Effect.flip);
        assert.instanceOf(missing, Source.HostNotFound);
        const internal = yield* inspect(
          resolving(Effect.succeed(["93.184.216.34", "10.1.2.3"]))
        ).pipe(Effect.flip);
        assert.instanceOf(internal, Source.PrivateAddress);
        assert.include(internal.message, "10.1.2.3");
        const paired = yield* inspect(ImapTest.network(served, mail), {
          port: 143,
          security: "tls"
        }).pipe(Effect.flip);
        assert.instanceOf(paired, Source.PortNotAllowed);
        assert.strictEqual(served.connections(), 0);
      })
  );

  it.effect(
    "dials only the address it checked, and resolves and checks again for each session",
    () =>
      Effect.gen(function* () {
        const { mail } = yield* Certs;
        const served = yield* ImapTest.serve(mail);
        // A rebinding name: public at the first lookup, loopback at every one after.
        const answers: Array<ReadonlyArray<string>> = [["93.184.216.34"]];
        const dialed: string[] = [];
        let lookups = 0;
        const rebinding = Layer.succeed(
          Network.Network,
          Network.Network.of({
            resolve: () =>
              Effect.sync(() => {
                lookups += 1;
                return answers.shift() ?? ["127.0.0.1"];
              }),
            admits: (_host, address) => isPublicAddress(address),
            destination: ({ address }) => {
              dialed.push(address);
              return { address: "127.0.0.1", port: served.tls };
            },
            ca: () => [mail.ca]
          })
        );
        yield* inspect(rebinding);
        assert.deepStrictEqual([lookups, dialed], [1, ["93.184.216.34"]]);
        const second = yield* inspect(rebinding).pipe(Effect.flip);
        assert.instanceOf(second, Source.PrivateAddress);
        assert.deepStrictEqual([lookups, dialed, served.connections()], [2, ["93.184.216.34"], 1]);
      })
  );

  it.effect("refuses a certificate for another name, naming the names it carries", () =>
    Effect.gen(function* () {
      // The server presents the provider's certificate, which the network trusts.
      const { result, served } = yield* against({}, {}, "other");
      const mismatch = refusal(result);
      assert.instanceOf(mismatch, Source.CertificateMismatch);
      if (mismatch instanceof Source.CertificateMismatch)
        assert.deepStrictEqual(mismatch.names, ["imap.provider.test", "*.provider.test"]);
      assert.include(mismatch.message, "imap.provider.test");
      assert.deepStrictEqual(served.commands, []);
    })
  );

  it.effect("refuses a certificate no trusted authority signed", () =>
    Effect.gen(function* () {
      const { mail, other } = yield* Certs;
      const served = yield* ImapTest.serve(mail);
      // The network trusts another CA than the one that signed the server's certificate.
      const network = ImapNetwork(served, other.ca);
      const untrusted = yield* inspect(network).pipe(Effect.flip);
      assert.instanceOf(untrusted, Source.CertificateUntrusted);
      assert.deepStrictEqual(served.commands, []);
    })
  );

  it.effect("refuses a server that offers nothing from TLS 1.2 up", () =>
    Effect.gen(function* () {
      const { result, served } = yield* against({
        tls: { minVersion: "TLSv1", maxVersion: "TLSv1.1" }
      });
      assert.instanceOf(refusal(result), Source.TlsFailed);
      assert.deepStrictEqual(served.commands, []);
    })
  );

  it.effect("refuses 143 without STARTTLS, and never sends the password unencrypted", () =>
    Effect.gen(function* () {
      const { result, served } = yield* against(
        { starttls: false },
        { port: 143, security: "starttls" }
      );
      assert.instanceOf(refusal(result), Source.StartTlsUnavailable);
      assert.strictEqual(logins(served), 0);
    })
  );

  it.effect(
    "refuses a server without IMAP4rev1 or IMAP4rev2, or without password login, before the password",
    () =>
      Effect.gen(function* () {
        const old = yield* against({ capabilities: ["AUTH=PLAIN", "ID"] });
        assert.instanceOf(refusal(old.result), Source.NotImap4);
        assert.strictEqual(logins(old.served), 0);
        const disabled = yield* against({ capabilities: ["IMAP4rev1", "LOGINDISABLED"] });
        assert.instanceOf(refusal(disabled.result), Source.LoginDisabled);
        assert.strictEqual(logins(disabled.served), 0);
      })
  );

  it.effect(
    "names a refused login by AUTHENTICATE PLAIN and by LOGIN, with or without a code",
    () =>
      Effect.gen(function* () {
        for (const [capabilities, method] of [
          [["IMAP4rev1", "AUTH=PLAIN"], "AUTHENTICATE PLAIN"],
          [["IMAP4rev1"], "LOGIN"]
        ] as const)
          for (const [reply, code] of [
            ["NO [AUTHENTICATIONFAILED] Authentication failed.", "AUTHENTICATIONFAILED"],
            ["NO Login failed.", null],
            ["NO [EXPIRED] Password expired.", "EXPIRED"]
          ] as const) {
            const { result, served } = yield* against({ capabilities, login: () => reply });
            const refused = refusal(result);
            assert.instanceOf(refused, Source.LoginRefused, `${method}: ${reply}`);
            if (refused instanceof Source.LoginRefused) assert.strictEqual(refused.reply, code);
            assert.strictEqual(refused.code, "auth_failed");
            assert.include(served.commands, method === "LOGIN" ? "LOGIN" : "AUTHENTICATE PLAIN");
          }
      })
  );

  it.effect(
    "tells a refusal of the password from UNAVAILABLE, a referral, BAD and a throttle",
    () =>
      Effect.gen(function* () {
        for (const [reply, expected] of [
          ["NO [UNAVAILABLE] Try again later.", "UNAVAILABLE"],
          ["NO [REFERRAL imap://invoices@other.example.test/] Go elsewhere.", "REFERRAL"],
          ["NO [LIMIT] Too many sessions.", "LIMIT"],
          ["BAD Malformed login.", "BAD"]
        ] as const) {
          const { result, served } = yield* against({ login: () => reply });
          const refused = refusal(result);
          assert.instanceOf(refused, Source.Unavailable, reply);
          if (refused instanceof Source.Unavailable) assert.strictEqual(refused.reply, expected);
          // A referral is never followed: the one connection is the typed host's.
          assert.strictEqual(served.connections(), 1);
        }
        const throttled = yield* against({
          login: () => "BAD Request is throttled. Suggested Backoff Time: 20 milliseconds"
        });
        assert.instanceOf(refusal(throttled.result), Source.Throttled);
        // A referral on a login that worked is ignored too.
        const referred = yield* against({
          login: () => "OK [REFERRAL imap://invoices@other.example.test/] Logged in."
        });
        assert.strictEqual(referred.result._tag, "Success");
        assert.strictEqual(referred.served.connections(), 1);
      })
  );

  it.effect(
    "pauses only on a NO to the login coded AUTHENTICATIONFAILED, AUTHORIZATIONFAILED, EXPIRED or uncoded",
    () =>
      Effect.sync(() => {
        const failure = (fields: Record<string, string>) =>
          Object.assign(new Error("Command failed"), fields);
        const cases: ReadonlyArray<
          readonly [Error | undefined, ReturnType<typeof Source.pausingReply>]
        > = [
          [
            failure({ responseStatus: "NO", serverResponseCode: "AUTHENTICATIONFAILED" }),
            { reply: "AUTHENTICATIONFAILED" }
          ],
          [
            failure({ responseStatus: "NO", serverResponseCode: "AUTHORIZATIONFAILED" }),
            { reply: "AUTHORIZATIONFAILED" }
          ],
          [failure({ responseStatus: "NO", serverResponseCode: "EXPIRED" }), { reply: "EXPIRED" }],
          [failure({ responseStatus: "NO" }), { reply: null }],
          [failure({ responseStatus: "NO", serverResponseCode: "UNAVAILABLE" }), undefined],
          [failure({ responseStatus: "NO", serverResponseCode: "REFERRAL" }), undefined],
          [failure({ responseStatus: "NO", serverResponseCode: "LIMIT" }), undefined],
          [failure({ responseStatus: "NO", code: "ETHROTTLE" }), undefined],
          [failure({ responseStatus: "BAD" }), undefined],
          // ImapFlow marks a local refusal and a lost connection `authenticationFailed` too.
          [failure({ code: "ECONNRESET" }), undefined],
          [
            Object.assign(new Error("Login is disabled"), { authenticationFailed: true }),
            undefined
          ],
          [undefined, undefined]
        ];
        for (const [error, expected] of cases)
          assert.deepStrictEqual(Source.pausingReply(error), expected, String(error?.message));
      })
  );

  it.effect("refuses a mailbox without an INBOX it can examine", () =>
    Effect.gen(function* () {
      const { result } = yield* against({ inbox: false });
      assert.instanceOf(refusal(result), Source.NoInbox);
    })
  );

  it.effect("destroys a session that passes a parser or byte bound", () =>
    Effect.gen(function* () {
      const long = { folders: [{ path: `Projects/${"x".repeat(2_000)}` }] };
      const line = yield* against(long).pipe(
        Effect.provideService(ContractLimits.overrides, { "imap.parser.line": 1_024 })
      );
      const overflow = refusal(line.result);
      assert.instanceOf(overflow, Source.Overflow);
      if (overflow instanceof Source.Overflow)
        assert.strictEqual(overflow.limitId, "imap.parser.line");
      const budget = yield* against(long).pipe(
        Effect.provideService(ContractLimits.overrides, { "imap.session.bytes": 1_500 })
      );
      const spent = refusal(budget.result);
      assert.instanceOf(spent, Source.Overflow);
      if (spent instanceof Source.Overflow) assert.strictEqual(spent.limitId, "imap.session.bytes");
    })
  );
});

/** The scripted server's ports for `host`, trusting `ca` only. */
const ImapNetwork = (served: ImapTest.Served, ca: string) =>
  Network.loopback(() => [{ host, ports: { 993: served.tls, 143: served.plain }, ca }]);
