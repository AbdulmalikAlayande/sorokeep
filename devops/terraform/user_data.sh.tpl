#!/bin/bash
set -e

apt-get update -y
apt-get install -y docker.io git curl jq unzip awscli

cd /opt
git clone https://github.com/Code-Paragon/sorokeep.git
cd sorokeep

SECRET_ENV_VAL=""
if [ -n "${aws_secrets_manager_arn}" ]; then
  sleep 15
  SECRET_ENV_VAL=$(aws secretsmanager get-secret-value --region us-east-1 --secret-id "${aws_secrets_manager_arn}" --query SecretString --output text)
fi

ENV_FILE=".env"
cat <<ENV_EOF > $ENV_FILE
NETWORK=${network}
POLL_INTERVAL=${poll_interval}
ENV_EOF

if [ -n "${rpc_url}" ]; then
  echo "RPC_URL=${rpc_url}" >> $ENV_FILE
fi

if [ -n "$SECRET_ENV_VAL" ]; then
  echo "${secret_key_env}=$SECRET_ENV_VAL" >> $ENV_FILE
fi

docker build -t sorokeep-daemon .
chmod +x systemd/install-service.sh
./systemd/install-service.sh
