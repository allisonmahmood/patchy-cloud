import { describe, expect, it } from "vitest";
import { getServerConfig } from "./index.js";

describe("getServerConfig", () => {
  it("defaults to json db when DATABASE_URL is absent", () => {
    const config = getServerConfig({});

    expect(config.dbDriver).toBe("json");
    expect(config.storageDriver).toBe("filesystem");
    expect(config.publicBaseUrl).toBe("http://localhost:3000");
    expect(config.trustProxy).toBe(false);
  });

  it("defaults abuse-protection limits per minute", () => {
    const config = getServerConfig({});

    expect(config.protectedApiRateLimitPerMinute).toBe(60);
    expect(config.authenticatedUploadRateLimitPerMinute).toBe(20);
    expect(config.selfServiceMintRateLimitPerMinute).toBe(5);
    expect(config.draftCreateRateLimitPerMinute).toBe(10);
  });

  it("defaults the live-draft quota to a thousand per token", () => {
    expect(getServerConfig({}).liveDraftsPerToken).toBe(1_000);
    expect(getServerConfig({ PATCHY_LIVE_DRAFTS_PER_TOKEN: "25" }).liveDraftsPerToken).toBe(25);
    expect(getServerConfig({ PATCHY_LIVE_DRAFTS_PER_TOKEN: "1000000" }).liveDraftsPerToken).toBe(
      1_000_000
    );

    for (const value of ["0", "-1", "+1", "01", "1.5", "1e2", "1000001"]) {
      expect(() => getServerConfig({ PATCHY_LIVE_DRAFTS_PER_TOKEN: value })).toThrow(
        /PATCHY_LIVE_DRAFTS_PER_TOKEN/
      );
    }
  });

  it("defaults the self-service mint quota to five per address per day", () => {
    expect(getServerConfig({}).selfServiceMintsPerIpPerDay).toBe(5);
    expect(
      getServerConfig({ PATCHY_SELF_SERVICE_MINTS_PER_IP_PER_DAY: "2" }).selfServiceMintsPerIpPerDay
    ).toBe(2);
    expect(
      getServerConfig({ PATCHY_SELF_SERVICE_MINTS_PER_IP_PER_DAY: "1000000" })
        .selfServiceMintsPerIpPerDay
    ).toBe(1_000_000);

    for (const value of ["0", "-1", "+1", "01", "1.5", "1e2", "1000001"]) {
      expect(() => getServerConfig({ PATCHY_SELF_SERVICE_MINTS_PER_IP_PER_DAY: value })).toThrow(
        /PATCHY_SELF_SERVICE_MINTS_PER_IP_PER_DAY/
      );
    }
  });

  it("requires an explicit true boolean to allow self-service tokens", () => {
    expect(getServerConfig({}).allowSelfServiceTokens).toBe(false);
    expect(
      getServerConfig({ PATCHY_ALLOW_SELF_SERVICE_TOKENS: "false" }).allowSelfServiceTokens
    ).toBe(false);
    expect(
      getServerConfig({ PATCHY_ALLOW_SELF_SERVICE_TOKENS: "true" }).allowSelfServiceTokens
    ).toBe(true);

    for (const value of ["1", "0", "yes", "no", "on", "off", "enabled"]) {
      expect(() => getServerConfig({ PATCHY_ALLOW_SELF_SERVICE_TOKENS: value })).toThrow(
        /PATCHY_ALLOW_SELF_SERVICE_TOKENS/
      );
    }
  });

  it("parses configured abuse-protection limits per minute", () => {
    const config = getServerConfig({
      PATCHY_PROTECTED_API_RATE_LIMIT_PER_MINUTE: "120",
      PATCHY_AUTHENTICATED_UPLOAD_RATE_LIMIT_PER_MINUTE: "40",
      PATCHY_SELF_SERVICE_MINT_RATE_LIMIT_PER_MINUTE: "10",
      PATCHY_DRAFT_CREATE_RATE_LIMIT_PER_MINUTE: "30"
    });

    expect(config.protectedApiRateLimitPerMinute).toBe(120);
    expect(config.authenticatedUploadRateLimitPerMinute).toBe(40);
    expect(config.selfServiceMintRateLimitPerMinute).toBe(10);
    expect(config.draftCreateRateLimitPerMinute).toBe(30);
  });

  it("requires abuse-protection limits to be decimal integers from 1 through 10000", () => {
    const settings = [
      ["PATCHY_PROTECTED_API_RATE_LIMIT_PER_MINUTE", "protectedApiRateLimitPerMinute"],
      [
        "PATCHY_AUTHENTICATED_UPLOAD_RATE_LIMIT_PER_MINUTE",
        "authenticatedUploadRateLimitPerMinute"
      ],
      ["PATCHY_SELF_SERVICE_MINT_RATE_LIMIT_PER_MINUTE", "selfServiceMintRateLimitPerMinute"],
      ["PATCHY_DRAFT_CREATE_RATE_LIMIT_PER_MINUTE", "draftCreateRateLimitPerMinute"]
    ] as const;

    for (const [envName, configName] of settings) {
      expect(getServerConfig({ [envName]: "1" })[configName]).toBe(1);
      expect(getServerConfig({ [envName]: "10000" })[configName]).toBe(10000);

      for (const value of ["0", "-1", "+1", "01", "1.5", "1e2", "10001"]) {
        expect(() => getServerConfig({ [envName]: value })).toThrow(new RegExp(envName));
      }
    }
  });

  it("leaves server-side analytics unconfigured unless a key is set", () => {
    expect(getServerConfig({}).posthogApiKey).toBeNull();
    expect(getServerConfig({ PATCHY_POSTHOG_API_KEY: "   " }).posthogApiKey).toBeNull();
    expect(getServerConfig({ PATCHY_POSTHOG_API_KEY: "phc_key" }).posthogApiKey).toBe("phc_key");
  });

  it("defaults the analytics host and requires a configured one to be an http URL", () => {
    expect(getServerConfig({}).posthogHost).toBe("https://us.i.posthog.com");
    expect(getServerConfig({ PATCHY_POSTHOG_HOST: "https://eu.i.posthog.com" }).posthogHost).toBe(
      "https://eu.i.posthog.com"
    );
    expect(
      getServerConfig({ PATCHY_POSTHOG_HOST: "http://posthog.internal:8000" }).posthogHost
    ).toBe("http://posthog.internal:8000");

    for (const value of ["us.i.posthog.com", "ftp://posthog.example", "javascript:0", "//x"]) {
      expect(() => getServerConfig({ PATCHY_POSTHOG_HOST: value })).toThrow(/PATCHY_POSTHOG_HOST/);
    }
  });

  it("defaults to postgres db when DATABASE_URL is present", () => {
    const config = getServerConfig({ DATABASE_URL: "postgres://example" });

    expect(config.dbDriver).toBe("postgres");
  });

  it.each(["1", "2", "32", "33"])("rejects trusted-proxy hop counts %j", (value) => {
    expect(() => getServerConfig({ PATCHY_TRUST_PROXY: value })).toThrow(
      /Invalid PATCHY_TRUST_PROXY/
    );
  });

  it("parses trusted proxy addresses and CIDR networks as a list", () => {
    const config = getServerConfig({
      PATCHY_TRUST_PROXY: "127.0.0.1, 10.0.0.0/8, 2001:db8::/32"
    });

    expect(config.trustProxy).toEqual(["127.0.0.1", "10.0.0.0/8", "2001:db8::/32"]);
  });

  it.each([
    "0.0.0.0/1",
    "128.0.0.0/1, 192.0.2.0/24",
    "192.0.2.0/24, 198.51.100.0/24, 2001:db8::/32",
    "::1",
    "8000::/1",
    "::/96",
    "0:0:0:0:0:0:c000:200/120"
  ])("parses partial trusted-proxy network sets %j", (value) => {
    expect(getServerConfig({ PATCHY_TRUST_PROXY: value }).trustProxy).toEqual(
      value.split(",").map((entry) => entry.trim())
    );
  });

  it.each([
    "",
    "   ",
    "0",
    "-1",
    "+1",
    "01",
    "1.5",
    "1e2",
    "true",
    "false",
    "all",
    "*",
    ",127.0.0.1",
    "127.0.0.1,",
    "127.0.0.1,,10.0.0.0/8",
    "not-an-ip",
    "fe80::1%eth0",
    "10.0.0.0/33",
    "2001:db8::/129",
    "0.0.0.0/0",
    "::0.0.0.0/96",
    "::192.0.2.10",
    "::192.0.2.0/120",
    "::ffff:0:0/96",
    "::ffff:192.0.2.10",
    "::ffff:10.0.0.0/104",
    "0:0:0:0:0:ffff:a00:0/104",
    "::fffe:0:0/95",
    "::ffff:0:0/95",
    "::/1",
    "2001:db8::192.168.001.001",
    "2001:db8::192.168.001.001/120",
    "::/0"
  ])("rejects an unsafe or malformed trusted-proxy value %j", (value) => {
    expect(() => getServerConfig({ PATCHY_TRUST_PROXY: value })).toThrow(
      /Invalid PATCHY_TRUST_PROXY/
    );
  });

  it.each([
    "0.0.0.0/1,128.0.0.0/1",
    "128.0.0.0/1,0.0.0.0/1",
    "0.0.0.0/2,64.0.0.0/2,128.0.0.0/1",
    "192.0.0.0/2,0.0.0.0/1,128.0.0.0/2",
    "0.0.0.0/2,64.0.0.0/2,128.0.0.0/2,192.0.0.0/2,192.0.2.0/24",
    "::/1,8000::/1",
    "8000::/1,::/2,4000::/2"
  ])("rejects trusted-proxy network sets covering a full address family %j", (value) => {
    expect(() => getServerConfig({ PATCHY_TRUST_PROXY: value })).toThrow(
      /Invalid PATCHY_TRUST_PROXY/
    );
  });
});
