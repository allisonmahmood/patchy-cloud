/**
 * One environment's running system: the network, the load balancer, two
 * hosts, the exec task definition the fleet launches every exec task from,
 * and the uptime alert. Each release redeploys it pinned to one image digest.
 * CloudFormation waits for ECS to settle; a host that cannot start trips the
 * circuit breaker, which rolls the service back and fails the update.
 */
import {
  CfnOutput,
  CfnResource,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps
} from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";
import { hostSecretKeys, type BaseStack } from "./BaseStack.js";
import { names, region } from "./names.js";

/** AWS's managed prefix list for S3 in us-east-1; exec tasks pull image layers from S3. */
const s3PrefixList = "pl-63a5400a";

const port = { host: 8080, management: 8788, callback: 8789 } as const;

/** The load balancer keeps a reader's stream and its subscription POSTs on one host (ADR-0010). */
const streamAffinityCookie = "patchy_stream_affinity";

/** The exec supervisor runs as root to give each workerd child its own uid, and needs none of these. */
const execDroppedCapabilities = [
  "NET_RAW",
  "NET_BIND_SERVICE",
  "SYS_CHROOT",
  "MKNOD",
  "SETFCAP",
  "SETPCAP",
  "AUDIT_WRITE",
  "FSETID"
];

/** The two slots of the management secret; see `BaseStack.managementSecret`. */
export type SecretSlot = "a" | "b";

export interface AppStackProps extends StackProps {
  readonly environment: string;
  /** The public host, such as `cloud.patchyhq.com`. */
  readonly domain: string;
  /** An issued ACM certificate for `domain`, in this region. */
  readonly certificateArn: string;
  readonly alertEmails: readonly string[];
  /** The deployment revision: the released commit, suffixed for a rotation step. */
  readonly revision: string;
  /** The release image's digest in the base stack's repository, `sha256:…`. */
  readonly imageDigest: string;
  /**
   * The release the fleet is promoted to; absent only on the first deploy.
   * Until this release is promoted, the fleet still replenishes the promoted
   * revision's spares, so these hosts must launch and manage its tasks: from
   * its exec task definition, with the management secret slot it reads.
   */
  readonly previous?: {
    readonly revision: string;
    readonly execTaskDefinition: string;
    readonly secretSlot: SecretSlot;
  };
  /** The management secret slot this release reads (docs/OPERATIONS.md, rotation). */
  readonly secretSlot: SecretSlot;
  readonly base: BaseStack;
}

export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, { ...props, env: { region } });
    const name = names(props.environment);
    const origin = `https://${props.domain}`;
    const { base, previous } = props;

    // Public subnets carry the load balancer and the hosts, with public IPs
    // and no NAT gateway. Exec tasks use the first isolated subnet, which has
    // no route out: only the endpoints below.
    const vpc = new ec2.Vpc(this, "Network", {
      ipAddresses: ec2.IpAddresses.cidr("10.40.0.0/16"),
      // Named, not counted: a count would look the zones up in the account.
      availabilityZones: [`${region}a`, `${region}b`],
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "exec", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }
      ],
      gatewayEndpoints: {
        s3: {
          service: ec2.GatewayVpcEndpointAwsService.S3,
          subnets: [{ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }]
        }
      }
    });
    const execSubnet = vpc.isolatedSubnets[0]!;

    const group = (id: string, description: string, allowAllOutbound = false) =>
      new ec2.SecurityGroup(this, id, { vpc, description, allowAllOutbound });
    const albGroup = group("AlbGroup", "Patchy load balancer: public HTTP(S) in, hosts out");
    const hostGroup = group(
      "HostGroup",
      "Patchy hosts: the load balancer and exec callbacks in; Clerk, Neon, AWS and PostHog out",
      true
    );
    const execBootstrap = group(
      "ExecBootstrapGroup",
      "Patchy exec: host management in; endpoints, S3 image layers and host callbacks out"
    );
    const execSealed = group(
      "ExecSealedGroup",
      "Patchy exec, sealed: host management in, nothing out"
    );
    const endpointGroup = group(
      "EndpointGroup",
      "Patchy interface endpoints: HTTPS from exec and hosts"
    );

    albGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "Public HTTPS");
    albGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "Public HTTP, redirected");
    hostGroup.addIngressRule(execBootstrap, ec2.Port.tcp(port.callback), "Exec callbacks");
    for (const exec of [execBootstrap, execSealed])
      exec.addIngressRule(hostGroup, ec2.Port.tcp(port.management), "Host management");
    execBootstrap.addEgressRule(endpointGroup, ec2.Port.tcp(443), "ECR and logs endpoints");
    execBootstrap.addEgressRule(
      ec2.Peer.prefixList(s3PrefixList),
      ec2.Port.tcp(443),
      "ECR image layers in S3"
    );
    execBootstrap.addEgressRule(hostGroup, ec2.Port.tcp(port.callback), "Host callbacks");
    endpointGroup.addIngressRule(execBootstrap, ec2.Port.tcp(443), "From exec");
    // The endpoints' private DNS covers the whole VPC, so hosts reach ECR and
    // CloudWatch Logs through them too. Without this, new hosts cannot create
    // their log stream once private DNS propagates.
    endpointGroup.addIngressRule(hostGroup, ec2.Port.tcp(443), "From hosts");
    // CloudFormation drops AWS's default allow-all egress only from a group
    // that declares egress inline. CDK writes rules naming another group as
    // separate resources and removes its inline "no traffic" placeholder, so a
    // group with only such rules would keep allow-all. Put the placeholder back.
    for (const closed of [albGroup, execBootstrap]) {
      const resource = closed.node.defaultChild;
      if (CfnResource.isCfnResource(resource))
        resource.addPropertyOverride("SecurityGroupEgress", [
          {
            CidrIp: "255.255.255.255/32",
            Description: "Disallow all traffic",
            IpProtocol: "icmp",
            FromPort: 252,
            ToPort: 86
          }
        ]);
    }

    for (const [id, service] of [
      ["EcrApi", ec2.InterfaceVpcEndpointAwsService.ECR],
      ["EcrDocker", ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER],
      ["Logs", ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS]
    ] as const)
      vpc.addInterfaceEndpoint(id, {
        service,
        subnets: { subnets: [execSubnet] },
        securityGroups: [endpointGroup],
        open: false,
        privateDnsEnabled: true
      });

    const cluster = new ecs.Cluster(this, "Cluster", { vpc, clusterName: name.cluster });
    const logGroup = (id: string, logGroupName: string) =>
      new logs.LogGroup(this, id, {
        logGroupName,
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: RemovalPolicy.RETAIN
      });
    const hostLogs = logGroup("HostLogs", name.hostLogs);
    const execLogs = logGroup("ExecLogs", name.execLogs);
    const image = base.repository.repositoryUriForDigest(props.imageDigest);

    // Exec tasks hold no AWS identity: no task role, and an execution role
    // that only pulls the image and ships logs.
    const execExecutionRole = new iam.Role(this, "ExecExecutionRole", {
      roleName: name.execExecutionRole,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com")
    });
    base.repository.grantPull(execExecutionRole);
    execLogs.grantWrite(execExecutionRole);

    // CfnTaskDefinition, because the L2 always adds a task role. The host
    // launches each task with its identity and secrets as overrides.
    const execDefinition = new ecs.CfnTaskDefinition(this, "ExecDefinition", {
      family: name.execFamily,
      cpu: "512",
      memory: "2048",
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      runtimePlatform: { cpuArchitecture: "X86_64", operatingSystemFamily: "LINUX" },
      executionRoleArn: execExecutionRole.roleArn,
      containerDefinitions: [
        {
          name: "exec",
          image,
          essential: true,
          user: "0",
          command: ["node", "dist/exec.js"],
          linuxParameters: { capabilities: { drop: execDroppedCapabilities } },
          portMappings: [{ containerPort: port.management, protocol: "tcp" }],
          stopTimeout: 120,
          logConfiguration: {
            logDriver: "awslogs",
            options: {
              "awslogs-group": execLogs.logGroupName,
              "awslogs-region": region,
              "awslogs-stream-prefix": "exec"
            }
          }
        }
      ]
    });
    // Replaced revisions stay registered, so the next release's hosts can
    // still launch the promoted revision's spares until their own promotion.
    execDefinition.applyRemovalPolicy(RemovalPolicy.RETAIN);

    // The fleet policy in docs/OPERATIONS.md: ECS actions on this cluster and
    // the exec family only, tags on create, and passing the exec execution role.
    const hostTaskRole = new iam.Role(this, "HostTaskRole", {
      roleName: name.hostTaskRole,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com").withConditions({
        StringEquals: { "aws:SourceAccount": this.account },
        ArnLike: { "aws:SourceArn": this.formatArn({ service: "ecs", resource: "*" }) }
      })
    });
    const tasks = this.formatArn({
      service: "ecs",
      resource: "task",
      resourceName: `${name.cluster}/*`
    });
    const onCluster = { ArnEquals: { "ecs:cluster": cluster.clusterArn } };
    const allow = (
      actions: string[],
      resources: string[],
      conditions: {
        readonly ArnEquals?: Record<string, string>;
        readonly StringEquals?: Record<string, string>;
      } = {}
    ) =>
      hostTaskRole.addToPolicy(
        new iam.PolicyStatement({
          actions,
          resources,
          conditions: {
            ...conditions,
            StringEquals: { ...conditions.StringEquals, "aws:RequestedRegion": region }
          }
        })
      );
    // AWS has no resource-level permission for describing task definitions.
    allow(["ecs:DescribeTaskDefinition"], ["*"]);
    allow(["ecs:ListTasks"], ["*"], onCluster);
    allow(["ecs:DescribeTasks"], [tasks], onCluster);
    allow(
      ["ecs:RunTask"],
      [
        this.formatArn({
          service: "ecs",
          resource: "task-definition",
          resourceName: `${name.execFamily}:*`
        })
      ],
      { ...onCluster, StringEquals: { "aws:RequestTag/patchy:role": "exec" } }
    );
    allow(["ecs:StopTask"], [tasks], {
      ...onCluster,
      StringEquals: { "aws:ResourceTag/patchy:role": "exec" }
    });
    allow(["ecs:TagResource"], [tasks], { StringEquals: { "ecs:CreateAction": "RunTask" } });
    hostTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [execExecutionRole.roleArn],
        conditions: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } }
      })
    );

    const hostDefinition = new ecs.FargateTaskDefinition(this, "HostDefinition", {
      family: name.hostFamily,
      cpu: 512,
      memoryLimitMiB: 2048,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX
      },
      taskRole: hostTaskRole,
      executionRole: new iam.Role(this, "HostExecutionRole", {
        roleName: name.hostExecutionRole,
        assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com")
      })
    });
    const management = (slot: SecretSlot) =>
      ecs.Secret.fromSecretsManager(base.managementSecret, slot);
    hostDefinition.addContainer("host", {
      containerName: "host",
      image: ecs.ContainerImage.fromEcrRepository(base.repository, props.imageDigest),
      user: "1000",
      command: ["node", "dist/start.js"],
      stopTimeout: Duration.seconds(120),
      portMappings: [{ containerPort: port.host }, { containerPort: port.callback }],
      environment: {
        NODE_ENV: "production",
        PORT: String(port.host),
        PATCHY_ENVIRONMENT: props.environment,
        PATCHY_PUBLIC_BASE_URL: origin,
        CLERK_AUTHORIZED_PARTIES: origin,
        PATCHY_TRUST_PROXY: vpc.vpcCidrBlock,
        PATCHY_LIMITS_JSON: this.toJsonString({ "execution.fleet.budget": 15 }),
        PATCHY_DEPLOYMENT_REVISION: props.revision,
        EXECUTION_PROVIDER: "ecs",
        EXECUTION_DEPLOYMENT_REVISION: props.revision,
        EXECUTION_FLEET_ID: name.fleetId,
        EXECUTION_CALLBACK_URLS: "[]",
        EXECUTION_CALLBACK_PORT: String(port.callback),
        EXECUTION_CALLBACK_HOST: "auto",
        EXECUTION_CALLBACK_PRIVATE_INTERFACE: "true",
        ECS_REGION: region,
        ECS_CLUSTER: cluster.clusterName,
        ECS_EXEC_SUBNET_IDS: this.toJsonString([execSubnet.subnetId]),
        ECS_EXEC_BOOTSTRAP_SECURITY_GROUP_ID: execBootstrap.securityGroupId,
        ECS_EXEC_TASK_DEFINITION: execDefinition.ref,
        ...(previous && {
          EXECUTION_PREVIOUS_DEPLOYMENT_REVISION: previous.revision,
          ECS_EXEC_PREVIOUS_TASK_DEFINITION: previous.execTaskDefinition
        })
      },
      secrets: {
        ...Object.fromEntries(
          hostSecretKeys.map((key) => [key, ecs.Secret.fromSecretsManager(base.hostSecret, key)])
        ),
        EXECUTION_MANAGEMENT_SECRET: management(props.secretSlot),
        ...(previous && { EXECUTION_MANAGEMENT_PREVIOUS_SECRET: management(previous.secretSlot) })
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: hostLogs, streamPrefix: "host" })
    });

    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, "LoadBalancer", {
      vpc,
      internetFacing: true,
      securityGroup: albGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      http2Enabled: true,
      // Document streams stay open; the server ends them, not the load balancer.
      idleTimeout: Duration.seconds(3600)
    });
    loadBalancer.addListener("Http", {
      port: 80,
      open: false,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: "HTTPS",
        port: "443",
        permanent: true
      })
    });
    const https = loadBalancer.addListener("Https", {
      port: 443,
      open: false,
      certificates: [elbv2.ListenerCertificate.fromArn(props.certificateArn)],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS
    });
    const hostTargets = new elbv2.ApplicationTargetGroup(this, "Hosts", {
      vpc,
      port: port.host,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      // Matches the server's stream drain: readers reconnect to another host at EOF.
      deregistrationDelay: Duration.seconds(90),
      // The server issues the cookie; the load balancer only keys on it.
      stickinessCookieName: streamAffinityCookie,
      stickinessCookieDuration: Duration.days(1),
      // Shallow on purpose: a database blip must not make ECS replace every host.
      healthCheck: {
        path: "/healthz",
        interval: Duration.seconds(15),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3
      }
    });
    https.addTargetGroups("Hosts", { targetGroups: [hostTargets] });

    const service = new ecs.FargateService(this, "HostService", {
      cluster,
      serviceName: name.hostService,
      taskDefinition: hostDefinition,
      desiredCount: 2,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      // CDK's default is no rollback.
      circuitBreaker: { enable: true, rollback: true },
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [hostGroup],
      healthCheckGracePeriod: Duration.seconds(60)
    });
    hostTargets.addTarget(
      service.loadBalancerTarget({ containerName: "host", containerPort: port.host })
    );

    // The uptime check reads the deep path through the public name, so it
    // covers DNS, TLS, the load balancer, a host and the platform database.
    const uptime = new route53.CfnHealthCheck(this, "Uptime", {
      healthCheckConfig: {
        type: "HTTPS",
        fullyQualifiedDomainName: props.domain,
        port: 443,
        resourcePath: "/healthz/deep",
        enableSni: true,
        requestInterval: 30,
        failureThreshold: 3,
        regions: ["us-east-1", "us-west-2", "eu-west-1"]
      },
      healthCheckTags: [{ key: "Name", value: `${origin}/healthz/deep` }]
    });
    // Email only: US SMS needs a registered sender number.
    const alerts = new sns.Topic(this, "Alerts", { topicName: `${name.cluster}-alerts` });
    for (const email of props.alertEmails)
      alerts.addSubscription(new snsSubscriptions.EmailSubscription(email));
    const down = new cloudwatch.Alarm(this, "Down", {
      alarmName: `${name.cluster}-down`,
      alarmDescription: `${origin}/healthz/deep is failing from Route 53's checkers.`,
      metric: new cloudwatch.Metric({
        namespace: "AWS/Route53",
        metricName: "HealthCheckStatus",
        dimensionsMap: { HealthCheckId: uptime.attrHealthCheckId },
        statistic: cloudwatch.Stats.MINIMUM,
        period: Duration.minutes(1)
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING
    });
    down.addAlarmAction(new cloudwatchActions.SnsAction(alerts));
    down.addOkAction(new cloudwatchActions.SnsAction(alerts));

    // What the deploy workflow and an operator read back.
    for (const [id, value, description] of [
      [
        "LoadBalancerDnsName",
        loadBalancer.loadBalancerDnsName,
        `The CNAME target for ${props.domain}`
      ],
      ["DeploymentRevision", props.revision, "The deployment revision these hosts run"],
      ["ClusterName", cluster.clusterName, "The ECS cluster"],
      ["HostServiceName", service.serviceName, "The host service"],
      [
        "HostTaskDefinitionArn",
        hostDefinition.taskDefinitionArn,
        "This release's host task definition"
      ],
      ["ExecTaskDefinitionArn", execDefinition.ref, "This release's exec task definition"],
      [
        "HostSubnetIds",
        vpc.publicSubnets.map((subnet) => subnet.subnetId).join(","),
        "Where one-off host tasks run"
      ],
      ["HostSecurityGroupId", hostGroup.securityGroupId, "The host security group"]
    ] as const)
      new CfnOutput(this, id, { value, description });
  }
}
