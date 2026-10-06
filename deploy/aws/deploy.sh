#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

REGION="${AWS_REGION:-ap-south-1}"
SERVICE_NAME="${APP_RUNNER_SERVICE_NAME:-prospect-portal}"
ECR_REPO="${ECR_REPO_NAME:-prospect-portal}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
ACCESS_ROLE_NAME="${APP_RUNNER_ACCESS_ROLE:-AppRunnerECRAccessRole}"

if [[ ! -f server/.env ]]; then
  echo "Missing server/.env — copy server/.env.example and fill secrets before deploying."
  exit 1
fi
if [[ ! -f client/.env ]]; then
  echo "Missing client/.env — needed for Vite Supabase public keys at image build time."
  exit 1
fi

# shellcheck disable=SC1091
set -a && source client/.env && set +a

echo "==> Ensuring ECR repository ${ECR_REPO}"
aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$ECR_REPO" --region "$REGION" --image-scanning-configuration scanOnPush=true

echo "==> Docker login to ECR"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

echo "==> Building image (linux/amd64)"
docker build --platform linux/amd64 \
  --build-arg "VITE_SUPABASE_URL=${VITE_SUPABASE_URL}" \
  --build-arg "VITE_SUPABASE_ANON_KEY=${VITE_SUPABASE_ANON_KEY}" \
  --build-arg "VITE_API_URL=" \
  -t "${ECR_REPO}:${IMAGE_TAG}" .

docker tag "${ECR_REPO}:${IMAGE_TAG}" "${ECR_URI}:${IMAGE_TAG}"
docker push "${ECR_URI}:${IMAGE_TAG}"

echo "==> Ensuring App Runner ECR access role"
if ! aws iam get-role --role-name "$ACCESS_ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ACCESS_ROLE_NAME" --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": { "Service": "build.apprunner.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }]
  }' >/dev/null
  aws iam attach-role-policy --role-name "$ACCESS_ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess
fi
ACCESS_ROLE_ARN="$(aws iam get-role --role-name "$ACCESS_ROLE_NAME" --query Role.Arn --output text)"

export SERVER_ENV_FILE="$ROOT/server/.env"
RUNTIME_ENV_JSON="$(python3 <<'PY'
import json, os, pathlib
path = pathlib.Path(os.environ["SERVER_ENV_FILE"])
vars = {}
for line in path.read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    vars[k] = v
vars["HOST"] = "0.0.0.0"
vars["PORT"] = "8080"
vars["SERVE_STATIC"] = "true"
vars["CLIENT_URL"] = os.environ.get("CLIENT_URL_OVERRIDE", vars.get("CLIENT_URL", "http://localhost:5173"))
print(json.dumps(vars))
PY
)"

SERVICE_ARN="$(aws apprunner list-services --region "$REGION" --query "ServiceSummaryList[?ServiceName=='${SERVICE_NAME}'].ServiceArn | [0]" --output text)"
IMAGE_IDENTIFIER="${ECR_URI}:${IMAGE_TAG}"

source_config() {
  cat <<EOF
{
  "AuthenticationConfiguration": {"AccessRoleArn": "${ACCESS_ROLE_ARN}"},
  "AutoDeploymentsEnabled": false,
  "ImageRepository": {
    "ImageIdentifier": "${IMAGE_IDENTIFIER}",
    "ImageRepositoryType": "ECR",
    "ImageConfiguration": {
      "Port": "8080",
      "RuntimeEnvironmentVariables": ${RUNTIME_ENV_JSON}
    }
  }
}
EOF
}

if [[ "$SERVICE_ARN" == "None" || -z "$SERVICE_ARN" ]]; then
  echo "==> Creating App Runner service ${SERVICE_NAME}"
  SERVICE_ARN="$(aws apprunner create-service --region "$REGION" --service-name "$SERVICE_NAME" \
    --source-configuration "$(source_config)" \
    --instance-configuration '{"Cpu":"1 vCPU","Memory":"2 GB"}' \
    --health-check-configuration '{"Protocol":"HTTP","Path":"/api/health","Interval":10,"Timeout":5,"HealthyThreshold":1,"UnhealthyThreshold":5}' \
    --query Service.ServiceArn --output text)"
else
  echo "==> Updating App Runner service ${SERVICE_NAME}"
  aws apprunner update-service --region "$REGION" --service-arn "$SERVICE_ARN" \
    --source-configuration "$(source_config)" >/dev/null
fi

wait_running() {
  for _ in $(seq 1 60); do
    STATUS="$(aws apprunner describe-service --region "$REGION" --service-arn "$SERVICE_ARN" --query 'Service.Status' --output text)"
    [[ "$STATUS" == "RUNNING" ]] && return 0
    [[ "$STATUS" == "CREATE_FAILED" || "$STATUS" == "UPDATE_FAILED" ]] && {
      aws apprunner describe-service --region "$REGION" --service-arn "$SERVICE_ARN" --output json
      return 1
    }
    sleep 10
  done
  return 1
}

echo "==> Waiting for service to reach RUNNING"
wait_running

SERVICE_URL="$(aws apprunner describe-service --region "$REGION" --service-arn "$SERVICE_ARN" --query 'Service.ServiceUrl' --output text)"
PUBLIC_URL="https://${SERVICE_URL}"

echo "==> Setting CLIENT_URL to ${PUBLIC_URL}"
export CLIENT_URL_OVERRIDE="$PUBLIC_URL"
RUNTIME_ENV_JSON="$(python3 <<'PY'
import json, os, pathlib
path = pathlib.Path(os.environ["SERVER_ENV_FILE"])
vars = {}
for line in path.read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    vars[k] = v
vars["HOST"] = "0.0.0.0"
vars["PORT"] = "8080"
vars["SERVE_STATIC"] = "true"
vars["CLIENT_URL"] = os.environ["CLIENT_URL_OVERRIDE"]
print(json.dumps(vars))
PY
)"

aws apprunner update-service --region "$REGION" --service-arn "$SERVICE_ARN" \
  --source-configuration "$(source_config)" >/dev/null

wait_running

mkdir -p deploy/aws
cat > deploy/aws/deployment-urls.txt <<EOF
Portal (HTTPS): ${PUBLIC_URL}
API health:     ${PUBLIC_URL}/api/health
Stripe webhook: ${PUBLIC_URL}/api/webhooks/stripe
Region:         ${REGION}
Service:        ${SERVICE_NAME}
EOF

echo ""
cat deploy/aws/deployment-urls.txt
echo ""
echo "Post-deploy: add ${PUBLIC_URL} to Supabase Auth Site URL + redirect URLs."
echo "Post-deploy: create Stripe webhook endpoint -> ${PUBLIC_URL}/api/webhooks/stripe"
