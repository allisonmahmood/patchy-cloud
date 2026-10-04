/**
 * The CDK app: one base stack and one app stack per environment. Every input
 * comes from CDK context (`-c key=value`), so nothing account-specific is in
 * the tree; the deploy workflow passes them from its repository variables.
 *
 *   environment    production, or later staging
 *   alertEmails    comma-separated; budget and uptime alerts
 *
 * The app stack is a release, so it is synthesized only when one is named:
 *
 *   revision       the deployment revision: the commit, suffixed for a rotation step
 *   imageDigest    that build's image digest, sha256:…
 *   domain         the public host, such as cloud.patchyhq.com
 *   certificateArn the issued ACM certificate for domain
 *   secretSlot     the management secret slot its hosts read, a or b
 *
 * And, on every release but the first, the release the fleet is promoted to:
 *
 *   previousRevision, previousExecTaskDefinition, previousSecretSlot
 */
import { App } from "aws-cdk-lib";
import { AppStack } from "./AppStack.js";
import { BaseStack } from "./BaseStack.js";
import { names } from "./names.js";

const app = new App();

const formats: Record<string, RegExp> = {
  environment: /^[a-z][a-z0-9-]{0,20}$/,
  domain: /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/,
  certificateArn: /^arn:aws:acm:us-east-1:\d{12}:certificate\/[0-9a-f-]+$/,
  alertEmails: /^[^\s,@]+@[^\s,@]+(?:,[^\s,@]+@[^\s,@]+)*$/,
  revision: /^[0-9a-f]{7,40}(?:-[a-z0-9-]{1,40})?$/,
  imageDigest: /^sha256:[0-9a-f]{64}$/,
  previousRevision: /^[0-9a-f]{7,40}(?:-[a-z0-9-]{1,40})?$/,
  previousExecTaskDefinition: /^arn:aws:ecs:us-east-1:\d{12}:task-definition\/[\w-]+:\d+$/,
  secretSlot: /^[ab]$/,
  previousSecretSlot: /^[ab]$/
};

/** A context value, checked against its format; absent only where that is allowed. */
function context(key: string): string;
function context(key: string, optional: true): string | undefined;
function context(key: string, optional = false) {
  const value: unknown = app.node.tryGetContext(key);
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !formats[key]!.test(value))
    throw new Error(`Context ${key} is missing or malformed; pass -c ${key}=<value>.`);
  return value;
}

const environment = context("environment");
const alertEmails = context("alertEmails").split(",");
const name = names(environment);
const base = new BaseStack(app, name.baseStack, { environment, alertEmails });

const revision = context("revision", true);
if (revision !== undefined) {
  const previous = [
    context("previousRevision", true),
    context("previousExecTaskDefinition", true),
    context("previousSecretSlot", true)
  ] as const;
  const named = previous.filter((value) => value !== undefined).length;
  if (named !== 0 && named !== previous.length)
    throw new Error(
      "Pass previousRevision, previousExecTaskDefinition and previousSecretSlot together."
    );
  const [previousRevision, previousExecTaskDefinition, previousSecretSlot] = previous;
  new AppStack(app, name.appStack, {
    environment,
    domain: context("domain"),
    certificateArn: context("certificateArn"),
    alertEmails,
    revision,
    imageDigest: context("imageDigest"),
    secretSlot: context("secretSlot") === "b" ? "b" : "a",
    base,
    ...(previousRevision !== undefined &&
      previousExecTaskDefinition !== undefined &&
      previousSecretSlot !== undefined && {
        previous: {
          revision: previousRevision,
          execTaskDefinition: previousExecTaskDefinition,
          secretSlot: previousSecretSlot === "b" ? "b" : "a"
        }
      })
  });
}
