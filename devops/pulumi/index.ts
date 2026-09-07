import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export interface SorokeepDaemonArgs {
    amiId: pulumi.Input<string>;
    instanceType?: pulumi.Input<string>;
    network?: pulumi.Input<string>;
    rpcUrl?: pulumi.Input<string>;
    pollInterval?: pulumi.Input<number>;
    secretKeyEnv?: pulumi.Input<string>;
    awsSecretsManagerArn?: pulumi.Input<string>;
}

export class SorokeepDaemon extends pulumi.ComponentResource {
    public readonly instanceId: pulumi.Output<string>;
    public readonly publicIp: pulumi.Output<string>;

    constructor(name: string, args: SorokeepDaemonArgs, opts?: pulumi.ComponentResourceOptions) {
        super("pkg:index:SorokeepDaemon", name, {}, opts);

        const instanceType = args.instanceType || "t3.micro";
        const network = args.network || "testnet";
        const pollInterval = args.pollInterval || 300000;
        const secretKeyEnv = args.secretKeyEnv || "STELLAR_SECRET_KEY";

        // Security Group
        const sg = new aws.ec2.SecurityGroup(`${name}-sg`, {
            description: "Security group for Sorokeep daemon",
            egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
            ingress: [{ protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: ["0.0.0.0/0"] }],
        }, { parent: this });

        let instanceProfileName: pulumi.Output<string> | undefined = undefined;

        if (args.awsSecretsManagerArn) {
            const role = new aws.iam.Role(`${name}-role`, {
                assumeRolePolicy: JSON.stringify({
                    Version: "2012-10-17",
                    Statement: [{
                        Action: "sts:AssumeRole",
                        Effect: "Allow",
                        Principal: { Service: "ec2.amazonaws.com" },
                    }],
                }),
            }, { parent: this });

            new aws.iam.RolePolicy(`${name}-policy`, {
                role: role.id,
                policy: pulumi.all([args.awsSecretsManagerArn]).apply(([arn]) => JSON.stringify({
                    Version: "2012-10-17",
                    Statement: [{
                        Effect: "Allow",
                        Action: "secretsmanager:GetSecretValue",
                        Resource: arn,
                    }],
                })),
            }, { parent: this });

            const profile = new aws.iam.InstanceProfile(`${name}-profile`, { role: role.name }, { parent: this });
            instanceProfileName = profile.name;
        }

        // User data script template matching Terraform module shape
        const userData = pulumi.all([
            network,
            args.rpcUrl || "",
            pollInterval,
            secretKeyEnv,
            args.awsSecretsManagerArn || ""
        ]).apply(([net, rpc, interval, secEnv, smArn]) => `#!/bin/bash
set -e
apt-get update -y
apt-get install -y docker.io git curl jq unzip awscli

cd /opt
git clone https://github.com/Code-Paragon/sorokeep.git
cd sorokeep

SECRET_ENV_VAL=""
if [ -n "${smArn}" ]; then
  sleep 15
  SECRET_ENV_VAL=$(aws secretsmanager get-secret-value --region us-east-1 --secret-id "${smArn}" --query SecretString --output text)
fi

ENV_FILE=".env"
cat <<ENV_EOF > $ENV_FILE
NETWORK=${net}
POLL_INTERVAL=${interval}
ENV_EOF

if [ -n "${rpc}" ]; then
  echo "RPC_URL=${rpc}" >> $ENV_FILE
fi

if [ -n "$SECRET_ENV_VAL" ]; then
  echo "${secEnv}=$SECRET_ENV_VAL" >> $ENV_FILE
fi

docker build -t sorokeep-daemon .
chmod +x systemd/install-service.sh
./systemd/install-service.sh
`);

        const instance = new aws.ec2.Instance(`${name}-instance`, {
            ami: args.amiId,
            instanceType: instanceType,
            vpcSecurityGroupIds: [sg.id],
            iamInstanceProfile: instanceProfileName,
            userData: userData,
            tags: { Name: "sorokeep-daemon-pulumi" },
        }, { parent: this });

        this.instanceId = instance.id;
        this.publicIp = instance.publicIp;

        this.registerOutputs({
            instanceId: this.instanceId,
            publicIp: this.publicIp,
        });
    }
}
