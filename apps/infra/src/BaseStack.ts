/**
 * What outlives a release: the image registry, the identity GitHub deploys
 * with, the spend alert and the two host secrets. It deploys before the app
 * stack, because the image has to be in ECR, and the host secret filled in,
 * before a host can start.
 *
 * One AWS account holds every environment, so the account-wide pieces, the
 * GitHub OIDC provider and the budget, belong to production's base stack
 * alone; another environment's base stack refers to production's provider.
 */
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import { githubSubjectRepo, names, region } from "./names.js";

/**
 * The host settings a person fills into the host secret, by key. A deploy
 * never writes them; each key becomes the host environment variable it names.
 */
export const hostSecretKeys = [
  "DATABASE_URL",
  "PATCHY_COMPANY_DB_ADMIN_URL",
  "PATCHY_COMPANY_DB_URL",
  "CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "PATCHY_S3_BUCKET",
  "PATCHY_S3_ENDPOINT",
  "PATCHY_S3_REGION",
  "PATCHY_S3_ACCESS_KEY_ID",
  "PATCHY_S3_SECRET_ACCESS_KEY",
  "PATCHY_CREDENTIAL_KEYS",
  "PATCHY_POSTHOG_API_KEY"
] as const;

const githubTokens = "token.actions.githubusercontent.com";

export interface BaseStackProps extends StackProps {
  /** The deployment's name: `production`, or later `staging`. */
  readonly environment: string;
  /** Who hears about forecast spend. */
  readonly alertEmails: readonly string[];
}

export class BaseStack extends Stack {
  readonly repository: ecr.Repository;
  /** One JSON secret of `hostSecretKeys`, filled in by a person. */
  readonly hostSecret: secretsmanager.ISecret;
  /**
   * The fleet management secret as JSON with two slots, `a` and `b`. Each
   * release reads one; a rotation writes the new secret into the other, so a
   * running host never sees its slot change. Slot `a` is generated once.
   * Exec tasks receive the secret from their host at launch.
   */
  readonly managementSecret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: BaseStackProps) {
    super(scope, id, { ...props, env: { region } });
    const name = names(props.environment);
    const production = props.environment === "production";

    // Immutable tags: a git sha always names the same image, so a rollback
    // redeploys exactly what ran before.
    this.repository = new ecr.Repository(this, "Images", {
      repositoryName: name.repository,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      lifecycleRules: [
        { description: "Keep the last 30 releases to roll back to", maxImageCount: 30 }
      ]
    });

    // Declared without a value: a person fills it in, and a deploy never touches it.
    const hostSecret = new secretsmanager.CfnSecret(this, "HostSecret", {
      name: name.hostSecret,
      description: `Patchy ${props.environment} host settings, filled in by hand: ${hostSecretKeys.join(", ")}`
    });
    hostSecret.applyRemovalPolicy(RemovalPolicy.RETAIN);
    this.hostSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      "HostSecretRef",
      hostSecret.ref
    );

    // Generated once. A later deploy leaves it alone unless this generator
    // changes, so rotating is the runbook in docs/OPERATIONS.md, never a deploy.
    // Slot `b` stays empty until the first rotation.
    const managementSecret = new secretsmanager.CfnSecret(this, "ManagementSecret", {
      name: name.managementSecret,
      description: `Patchy ${props.environment} fleet management secret`,
      generateSecretString: {
        secretStringTemplate: "{}",
        generateStringKey: "a",
        passwordLength: 64,
        excludePunctuation: true
      }
    });
    managementSecret.applyRemovalPolicy(RemovalPolicy.RETAIN);
    this.managementSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      "ManagementSecretRef",
      managementSecret.ref
    );

    const provider = production
      ? new iam.OidcProviderNative(this, "GitHubOidc", {
          url: `https://${githubTokens}`,
          clientIds: ["sts.amazonaws.com"]
        })
      : iam.OidcProviderNative.fromOidcProviderArn(
          this,
          "GitHubOidc",
          this.formatArn({
            service: "iam",
            region: "",
            resource: "oidc-provider",
            resourceName: githubTokens
          })
        );

    // Trusted only for this repository's GitHub environment of the same name,
    // which a person approves before every deploy. The subject is GitHub's
    // immutable form: the repo segment, then the job's environment.
    const deployRole = new iam.Role(this, "DeployRole", {
      roleName: name.deployRole,
      maxSessionDuration: Duration.hours(2),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          [`${githubTokens}:aud`]: "sts.amazonaws.com",
          [`${githubTokens}:sub`]: `${githubSubjectRepo}:environment:${props.environment}`
        }
      })
    });
    // `cdk deploy` works through the bootstrap roles.
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [
          this.formatArn({ service: "iam", region: "", resource: "role", resourceName: "cdk-*" })
        ]
      })
    );
    this.repository.grantPullPush(deployRole);
    this.repository.grant(deployRole, "ecr:DescribeImages");
    // The promote step runs once as a host task; confirming reads the service.
    const cluster = this.formatArn({
      service: "ecs",
      resource: "cluster",
      resourceName: name.cluster
    });
    const onCluster = { ArnEquals: { "ecs:cluster": cluster } };
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:RunTask"],
        resources: [
          this.formatArn({
            service: "ecs",
            resource: "task-definition",
            resourceName: `${name.hostFamily}:*`
          })
        ],
        conditions: onCluster
      })
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:DescribeTasks"],
        resources: [
          this.formatArn({ service: "ecs", resource: "task", resourceName: `${name.cluster}/*` })
        ],
        conditions: onCluster
      })
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:DescribeServices"],
        resources: [
          this.formatArn({ service: "ecs", resource: "service", resourceName: `${name.cluster}/*` })
        ]
      })
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [name.hostTaskRole, name.hostExecutionRole].map((role) =>
          this.formatArn({ service: "iam", region: "", resource: "role", resourceName: role })
        ),
        conditions: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } }
      })
    );
    // A run first stops promote tasks an earlier, cancelled run left behind.
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:ListTasks"],
        resources: ["*"],
        conditions: onCluster
      })
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:StopTask"],
        resources: [
          this.formatArn({ service: "ecs", resource: "task", resourceName: `${name.cluster}/*` })
        ],
        conditions: onCluster
      })
    );
    // The deploy workflow's record of the promoted release, and of one being
    // promoted, from which each release takes its previous settings. The
    // workflow owns this parameter, not CloudFormation, so no stack update can
    // reset it.
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:PutParameter"],
        resources: [
          this.formatArn({
            service: "ssm",
            resource: "parameter",
            resourceName: name.promotedRelease.slice(1)
          })
        ]
      })
    );

    new CfnOutput(this, "RepositoryUri", {
      value: this.repository.repositoryUri,
      description: "Where the deploy workflow pushes release images"
    });

    if (production)
      new budgets.CfnBudget(this, "Spend", {
        budget: {
          budgetName: "patchy-monthly",
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: { amount: 300, unit: "USD" }
        },
        notificationsWithSubscribers: [
          {
            notification: {
              notificationType: "FORECASTED",
              comparisonOperator: "GREATER_THAN",
              threshold: 100,
              thresholdType: "PERCENTAGE"
            },
            subscribers: props.alertEmails.map((address) => ({
              subscriptionType: "EMAIL",
              address
            }))
          }
        ]
      });
  }
}
