/**
 * The stacks as CloudFormation sees them, synthesized offline: no account,
 * credentials or lookups. The snapshot pins every security group and rule,
 * so a change to who can reach what shows up in review; the other cases pin
 * what the server and the fleet rely on.
 */
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { expect, it } from "vitest";
import { AppStack } from "./AppStack.js";
import { BaseStack } from "./BaseStack.js";

const app = new App();
const alertEmails = ["alerts@example.com"];
const baseStack = new BaseStack(app, "base", { environment: "production", alertEmails });
const appStack = new AppStack(app, "app", {
  environment: "production",
  domain: "cloud.example.com",
  certificateArn: "arn:aws:acm:us-east-1:000000000000:certificate/example",
  alertEmails,
  revision: "0123456789abcdef0123456789abcdef01234567",
  imageDigest: `sha256:${"0".repeat(64)}`,
  secretSlot: "b",
  base: baseStack,
  previous: {
    revision: "89abcdef0123456789abcdef0123456789abcdef",
    execTaskDefinition:
      "arn:aws:ecs:us-east-1:000000000000:task-definition/patchy-production-exec:7",
    secretSlot: "a"
  }
});
const base = Template.fromStack(baseStack);
const template = Template.fromStack(appStack);

it("pins every security group and rule, and closes egress everywhere but the hosts", () => {
  const groups = template.findResources("AWS::EC2::SecurityGroup");
  // Without inline egress, AWS gives a group its default allow-all egress.
  for (const [id, group] of Object.entries(groups))
    expect(group.Properties.SecurityGroupEgress, id).toBeDefined();
  expect({
    ...groups,
    ...template.findResources("AWS::EC2::SecurityGroupIngress"),
    ...template.findResources("AWS::EC2::SecurityGroupEgress")
  }).toMatchSnapshot();
});

it("keeps a reader's stream and its subscription requests on one host", () => {
  template.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
    HealthCheckPath: "/healthz",
    TargetGroupAttributes: Match.arrayWith([
      { Key: "deregistration_delay.timeout_seconds", Value: "90" },
      { Key: "stickiness.enabled", Value: "true" },
      { Key: "stickiness.type", Value: "app_cookie" },
      { Key: "stickiness.app_cookie.cookie_name", Value: "patchy_stream_affinity" }
    ])
  });
  template.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
    LoadBalancerAttributes: Match.arrayWith([
      { Key: "routing.http2.enabled", Value: "true" },
      { Key: "idle_timeout.timeout_seconds", Value: "3600" }
    ])
  });
});

it("rolls hosts out beside the promoted release, back if they cannot start, and exec with no AWS identity", () => {
  // Until promotion the new hosts launch and manage the promoted revision's tasks too.
  template.hasResourceProperties("AWS::ECS::TaskDefinition", {
    Family: "patchy-production-host",
    ContainerDefinitions: [
      Match.objectLike({
        Environment: Match.arrayWith([
          {
            Name: "EXECUTION_PREVIOUS_DEPLOYMENT_REVISION",
            Value: "89abcdef0123456789abcdef0123456789abcdef"
          },
          {
            Name: "ECS_EXEC_PREVIOUS_TASK_DEFINITION",
            Value: "arn:aws:ecs:us-east-1:000000000000:task-definition/patchy-production-exec:7"
          }
        ]),
        Secrets: Match.arrayWith([
          {
            Name: "EXECUTION_MANAGEMENT_PREVIOUS_SECRET",
            ValueFrom: { "Fn::Join": ["", [Match.anyValue(), ":a::"]] }
          }
        ])
      })
    ]
  });
  template.hasResourceProperties("AWS::ECS::Service", {
    DesiredCount: 2,
    DeploymentConfiguration: {
      DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      MinimumHealthyPercent: 100,
      MaximumPercent: 200
    }
  });
  template.hasResource("AWS::ECS::TaskDefinition", {
    // Replaced revisions stay runnable for hosts still on the previous release.
    UpdateReplacePolicy: "Retain",
    Properties: {
      Family: "patchy-production-exec",
      TaskRoleArn: Match.absent(),
      ContainerDefinitions: [
        Match.objectLike({
          Name: "exec",
          User: "0",
          Environment: Match.absent(),
          Secrets: Match.absent()
        })
      ]
    }
  });
});

it("leaves the host secret to a person and generates the management secret once", () => {
  base.hasResourceProperties("AWS::SecretsManager::Secret", {
    Name: "patchy/production/host",
    SecretString: Match.absent(),
    GenerateSecretString: Match.absent()
  });
  base.hasResourceProperties("AWS::SecretsManager::Secret", {
    Name: "patchy/production/fleet-management",
    GenerateSecretString: Match.objectLike({ GenerateStringKey: "a" })
  });
});
