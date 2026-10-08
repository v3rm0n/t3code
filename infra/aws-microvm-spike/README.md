# Thread VMs on Lambda MicroVMs: spike

Runs T3 threads in Lambda MicroVMs from a T3 server on Fargate, in two stages.
Stage 1 needs no T3 changes and proves the riskiest parts:

- a MicroVM mounts the tenant's EFS access point with IAM over its VPC egress connector
- Docker runs inside the VM
- the runner's processes and PTYs work and survive a dropped connection and a suspend
- the VM reaches the tenant server's port (for `/mcp`) and the internet
- how fast EFS is for git and small files, and how long launch, suspend, and resume take

The stack creates one tenant: an EFS file system with `state` and `work` access points, a
Fargate task that mounts both (a placeholder answering HTTP on 3773 until stage 2), the IAM
roles, an S3 bucket for image artifacts, and a `lambda-microvm` interface endpoint. It uses an
existing VPC. The MicroVM image and the egress connector are created by scripts because the AWS
provider does not support them yet.

## Prerequisites

- A VPC with DNS hostnames and DNS support enabled, and at least two private subnets in
  different AZs with NAT egress. In the sandbox account that is the `sandbox/network` VPC.
- AWS CLI 2.37 or later (it has the `lambda-microvms` and `lambda-core` commands), OpenTofu 1.8
  or later, and `pnpm install` run in this repository.
- Credentials for the target account, for example `export AWS_PROFILE=sandbox`.

## Run it

```sh
cd infra/aws-microvm-spike
tofu init
tofu apply -var vpc_id=vpc-... -var 'private_subnet_ids=["subnet-...","subnet-..."]'

scripts/create-network-connector.sh   # up to 10 minutes
scripts/build-thread-image.sh         # builds, snapshots, and validates; 10 to 20 minutes

cd ../..
node apps/thread-runner/scripts/spike-check.ts
```

`spike-check` launches a VM, runs every check, suspends and resumes it, terminates it, and writes
`infra/aws-microvm-spike/.spike/spike-report-<vm-id>.json`. Pass `--keep` to leave the VM running,
`--skip-suspend` to skip the suspend check, and `--mount-by-ip` if the VM cannot resolve the file
system's DNS name.

To confirm the server sees what the VM wrote, open a shell in the task (the command is printed at
the end of the run):

```sh
aws ecs execute-command --cluster t3-spike --task <task-id> --container server \
  --interactive --command "ls -la /t3/work/spike"
```

## Stage 2: T3 on Fargate

Stage 2 swaps the placeholder for this fork's server. Threads, their terminals, and their
setup scripts then run in one MicroVM per thread, and git, checkpoints, and diffs stay on the
server.

Build the server image from the repository root and push it to the stack's repository:

```sh
REPO="$(tofu -chdir=infra/aws-microvm-spike output -raw ecr_repository_url)"
aws ecr get-login-password | docker login --username AWS --password-stdin "${REPO%%/*}"
docker build --platform linux/arm64 -f infra/aws-microvm-spike/server-image/Dockerfile -t "$REPO:spike" .
docker push "$REPO:spike"

cd infra/aws-microvm-spike
tofu apply -var vpc_id=vpc-... -var 'private_subnet_ids=["subnet-...","subnet-..."]' \
  -var server_image="$REPO:spike" \
  -var egress_connector_arn="$(cat .spike/network-connector-arn)"
```

The server has no load balancer in the spike. Forward its port through ECS Exec, then create a
pairing link inside the task:

```sh
TASK="$(aws ecs list-tasks --cluster t3-spike --service-name t3-spike-server --query 'taskArns[0]' --output text)"
RUNTIME_ID="$(aws ecs describe-tasks --cluster t3-spike --tasks "$TASK" --query 'tasks[0].containers[0].runtimeId' --output text)"
aws ssm start-session --target "ecs:t3-spike_${TASK##*/}_${RUNTIME_ID}" \
  --document-name AWS-StartPortForwardingSession --parameters portNumber=3773,localPortNumber=3773

aws ecs execute-command --cluster t3-spike --task "$TASK" --container server --interactive \
  --command "node /opt/t3code/apps/server/src/bin.ts auth pairing create --base-url http://localhost:3773"
```

Open the link in the desktop app or a browser. Then:

1. Sign in to Claude and Codex under Settings, or give their provider instances API keys. Logins
   land in `/t3/work/home`, which the thread VMs share.
2. Create or clone a project under `/t3/work`. Threads whose folder is elsewhere fail to start,
   because their VMs cannot see it.
3. Start a Claude thread and a Codex thread, open a terminal in each, and run a `t3.json` setup
   script. The server log shows each VM launch (`thread VM launched`).

The server finds its VMs again only while it runs. After a restart, VMs from before it are left
alone; Lambda suspends them after 5 idle minutes and terminates them an hour later.

## Local development

The same remote path runs against a runner container on your machine, with no AWS:

```sh
SHARED="$PWD/.t3/shared"; SECRET="local-runner-secret-0123456789abcdef"
mkdir -p "$SHARED/home"
node apps/thread-runner/scripts/build-image-artifact.ts
docker build --platform linux/arm64 -t t3-thread-runner apps/thread-runner/.artifact/image
docker run --rm -p 127.0.0.1:28080:8080 -v "$SHARED:$SHARED" \
  -e T3_RUNNER_DEV_PAYLOAD="{\"version\":1,\"runnerSecret\":\"$SECRET\",\"home\":\"$SHARED/home\",\"docker\":false}" \
  t3-thread-runner

T3CODE_THREAD_HOST=runner T3CODE_SHARED_DIR="$SHARED" \
  T3CODE_THREAD_RUNNER_URL=ws://127.0.0.1:28080 T3CODE_THREAD_RUNNER_SECRET="$SECRET" vp run dev
```

## When something fails

Runner and build logs go to the `/t3-spike/microvm` log group:

```sh
aws logs tail /t3-spike/microvm --since 1h --follow
```

- **The connector never becomes ACTIVE, or the operator role cannot be assumed.** The MicroVM
  docs do not name the service principal that assumes the operator role. Set
  `network_connector_trust_services` to the principal from the error and apply again.
- **`RunMicrovm` is denied.** Look for the missing action in CloudTrail and add it to the
  `ThreadVms` statement in `iam.tf`. Using a network connector may need its own permission.
- **`workspace failed` in `runner-status`.** The mount error is in the detail. A DNS failure
  means the VM does not use the VPC resolver; rerun with `--mount-by-ip`. An access-denied
  error points at the file system policy in `efs.tf`.
- **`docker-daemon` failed.** The detail holds the daemon's last output. The start script falls
  back from a loop-mounted ext4 data root to the vfs driver, and the runner then retries without
  iptables.
- **The VM terminates right after launch.** `/run` must answer within 60 seconds, including the
  EFS mount. The logs show how long the mount took.

## Clean up

```sh
aws lambda-microvms list-microvms --query 'items[].microvmId'   # terminate any left running
aws lambda-microvms delete-microvm-image --image-identifier t3-spike-thread
aws lambda-core delete-network-connector --identifier "$(cat .spike/network-connector-arn)"
tofu destroy -var vpc_id=vpc-... -var 'private_subnet_ids=["subnet-...","subnet-..."]'
```

Delete the connector only after every VM using it has terminated.
