# Terraform + Ansible — AWS Infrastructure Automation

> **Complete PoC Guide & Runbook** for provisioning a production-grade AWS infrastructure using Terraform (IaC) and Ansible (configuration management).

| Field | Value |
|---|---|
| **Project** | terraform-automation |
| **Region** | ap-south-1 (Mumbai) |
| **Application** | SysMon REST API (Node.js) |
| **GitHub Repo** | [Gunjan-007/infra-ansible-playbooks](https://github.com/Gunjan-007/infra-ansible-playbooks) |

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Prerequisites (Manual Steps)](#2-prerequisites-manual-steps)
3. [Master EC2 Setup](#3-master-ec2-setup)
4. [Terraform Configuration](#4-terraform-configuration)
5. [Ansible Configuration](#5-ansible-configuration)
6. [Deployment Runbook](#6-deployment-runbook)
7. [Validation & Testing](#7-validation--testing)
8. [Deploying Updates (Zero Downtime)](#8-deploying-updates-zero-downtime)
9. [Troubleshooting Guide](#9-troubleshooting-guide)
10. [Cleanup](#10-cleanup)
11. [Reference](#11-reference)

---

## 1. Project Overview

This project describes the end-to-end process to provision a production-grade AWS infrastructure using **Terraform** for infrastructure-as-code and **Ansible** for configuration management. The application is a Node.js REST API (**SysMon**) that reports live hardware statistics from EC2 instances.

### 1.1 Architecture Summary

| Component | Description |
|---|---|
| **Master EC2** | Control plane — runs Terraform and triggers deployments |
| **ALB** | Application Load Balancer — receives HTTP traffic, routes to healthy instances |
| **ASG** | Auto Scaling Group — min 1, max 3 instances, CPU-based scaling |
| **Launch Template** | Defines EC2 config; userdata pulls Ansible from GitHub on boot |
| **S3 Backend** | Stores `terraform.tfstate` with versioning enabled |
| **DynamoDB / Lock** | State locking via `use_lockfile` (Terraform 6.x) |
| **CloudWatch** | Log groups for app/nginx/userdata + CPU and ALB alarms |
| **GitHub** | Single source of truth for all Ansible playbooks |

### 1.2 Key Design Principles

- **Stateful Backend** — S3 stores state; concurrent runs are blocked by lockfile
- **Stateless Compute** — instances are cattle, not pets; they self-configure from GitHub at boot
- **Observability** — CloudWatch collects logs, custom metrics (memory/disk), and fires alarms
- **Zero-downtime updates** — rolling instance refresh via ASG replaces instances without downtime
- **No local tooling** — Terraform and Ansible run entirely from the Master EC2

### 1.3 Infrastructure Values

| Variable | Value |
|---|---|
| **aws_region** | ap-south-1 |
| **project_name** | terraform-automation |
| **vpc_id** | vpc-04acd3dfb6b9ac682 |
| **subnet_ids** | subnet-07ed60fc2eca712d7, subnet-0953ac8d89bb32b48, subnet-0b62a87e09ba3afe6 |
| **ami_id** | ami-0e12ffc2dd465f6e4 (Amazon Linux 2023) |
| **instance_type** | t3.micro |
| **key_name** | infra-key |
| **github_repo_url** | https://github.com/Gunjan-007/infra-ansible-playbooks.git |
| **min_size / max_size** | 1 / 3 |

---

## 2. Prerequisites (Manual Steps)

These steps must be completed manually in the AWS Console before running any Terraform commands. They either require human decisions or produce credentials needed by subsequent steps.

### 2.1 IAM User for Terraform

1. Go to **IAM → Users → Create user** → Name: `terraform-admin`
2. Attach policy: `AdministratorAccess` *(PoC only — scope down in production)*
3. **Security credentials → Create access key → CLI** → Save Access Key ID and Secret

> ⚠️ Store the access key securely. It is shown only once.

### 2.2 EC2 Key Pair

1. **EC2 → Key Pairs → Create key pair** → Name: `infra-key`
2. Type: RSA, Format: `.pem` → Download and save locally
3. Set permissions:

```bash
chmod 400 infra-key.pem
```

### 2.3 S3 Bucket for Terraform State

1. **S3 → Create bucket** → Name: `<your-unique-name>-terraform-state`
2. Region: `ap-south-1`
3. Block all public access: **ON**
4. Versioning: **Enable**

> ⚠️ The bucket name must be globally unique. Use your name or account ID as a prefix.

### 2.4 GitHub Repository

1. Create a new **public** repository: `infra-ansible-playbooks`
2. URL: `https://github.com/Gunjan-007/infra-ansible-playbooks.git`
3. Push all Ansible files (see [Section 5](#5-ansible-configuration))

> ✅ Keep the repo public so EC2 instances can clone it without authentication tokens.

---

## 3. Master EC2 Setup

The Master EC2 is your control plane. All Terraform commands and instance refreshes are triggered from here. It never runs the application itself.

### 3.1 Launch the Master Instance

| Setting | Value |
|---|---|
| **Name** | terraform-master |
| **AMI** | Amazon Linux 2023 |
| **Instance type** | t3.micro (free tier eligible) |
| **Key pair** | infra-key |
| **VPC / Subnet** | Default VPC, any public subnet |
| **Auto-assign Public IP** | Enable |
| **Security group inbound** | SSH port 22 from My IP only |
| **Storage** | 8 GB gp3 (default) |

### 3.2 Attach IAM Role

1. **IAM → Roles → Create role → AWS service → EC2**
2. Attach: `AdministratorAccess` → Name: `terraform-master-role` → Create
3. **EC2 → Instances → terraform-master → Actions → Security → Modify IAM role**
4. Select `terraform-master-role` → Update

### 3.3 Install Tools on Master

SSH into the master:

```bash
ssh -i infra-key.pem ec2-user@<MASTER_PUBLIC_IP>
```

Then run the bootstrap script:

```bash
# Install Terraform
sudo yum install -y yum-utils
sudo yum-config-manager --add-repo https://rpm.releases.hashicorp.com/AmazonLinux/hashicorp.repo
sudo yum install -y terraform
terraform version

# Install Ansible
pip3 install ansible --user
echo 'export PATH=$PATH:~/.local/bin' >> ~/.bashrc
source ~/.bashrc
ansible --version

# Install Git
sudo yum install -y git

# Verify AWS access via IAM Role
aws sts get-caller-identity
```

---

## 4. Terraform Configuration

### 4.1 Directory Structure

```
~/infra/
└── terraform/
    ├── backend.tf
    ├── main.tf
    ├── variables.tf
    ├── terraform.tfvars
    ├── security_groups.tf
    ├── iam.tf
    ├── alb.tf
    ├── asg.tf
    ├── cloudwatch.tf
    ├── outputs.tf
    └── templates/
        └── userdata.sh.tpl
```

### 4.2 File Descriptions

| File | Purpose |
|---|---|
| **backend.tf** | S3 backend config + provider version (`~> 6.0`). Uses `use_lockfile=true` instead of deprecated `dynamodb_table`. |
| **variables.tf** | Declares all input variables with types and defaults |
| **terraform.tfvars** | Actual values — VPC, subnets, AMI, GitHub URL etc. |
| **main.tf** | VPC data source + SSM parameter for GitHub URL |
| **security_groups.tf** | ALB SG (HTTP from internet) and App SG (HTTP from ALB only, SSH) |
| **iam.tf** | EC2 instance role with `CloudWatchAgentServerPolicy` and `SSMReadOnlyAccess` |
| **alb.tf** | ALB, target group (health check `/health`), HTTP listener |
| **asg.tf** | Launch template, ASG, scale-out/in policies, CPU alarms |
| **cloudwatch.tf** | Log groups for app/nginx/userdata + ALB 5xx and unhealthy host alarms |
| **outputs.tf** | Prints ALB DNS, ASG name, log group names after apply |
| **userdata.sh.tpl** | Boot script — installs Ansible, clones GitHub, runs playbook, starts CW agent |

### 4.3 Important Notes on `backend.tf`

Terraform AWS provider 6.x deprecates the `dynamodb_table` parameter for state locking. Use the following instead:

```hcl
backend "s3" {
  bucket       = "your-bucket-name"
  key          = "terraform-automation/terraform.tfstate"
  region       = "ap-south-1"
  use_lockfile = true   # replaces dynamodb_table
  encrypt      = true
}
```

> ⚠️ With `use_lockfile = true`, Terraform writes a `.tflock` file directly to S3. The DynamoDB table is no longer needed.

### 4.4 CloudWatch Agent JSON Schema Fix

The `metrics` block must be a **top-level key** in the CloudWatch agent config, not nested inside `logs`. Incorrect nesting causes the agent to fail silently and block Ansible from running.

**Correct structure:**

```json
{
  "agent": { ... },
  "logs": {
    "logs_collected": { ... }
  },
  "metrics": {
    "metrics_collected": { ... }
  }
}
```

> ⚠️ Always add `|| true` after the `cloudwatch-agent-ctl` command in userdata so a CW failure never prevents Ansible from running.

---

## 5. Ansible Configuration

### 5.1 Repository Structure

```
infra-ansible-playbooks/
├── site.yml
├── inventory/
│   └── hosts
└── roles/
    └── app/
        ├── tasks/
        │   └── main.yml
        ├── handlers/
        │   └── main.yml       # handlers MUST be here, not in tasks
        ├── templates/
        │   ├── nginx.conf.j2
        │   └── app.service.j2
        └── files/
            └── app.js
```

### 5.2 Bugs Fixed During PoC

| Bug | Fix Applied |
|---|---|
| **handlers block in tasks/main.yml** | Moved to `roles/app/handlers/main.yml` — Ansible requires this separation |
| **curl conflicts with curl-minimal on AL2023** | Removed `curl` from dnf package list — `curl-minimal` is pre-installed and works fine for NVM |
| **CloudWatch agent schema error** | Moved `metrics` block to top level in the JSON config (was incorrectly nested inside `logs`) |
| **CW failure blocking Ansible** | Added `\|\| true` to `cloudwatch-agent-ctl` command so failures are non-fatal |

### 5.3 How Ansible Gets Invoked

On every new EC2 boot, the Launch Template userdata script runs the following sequence:

1. Install `git`, `python3`, `pip3`, `ansible` via dnf/pip
2. Install and configure the CloudWatch agent
3. `git clone https://github.com/Gunjan-007/infra-ansible-playbooks.git /tmp/playbooks`
4. `ansible-playbook -i inventory/hosts site.yml --connection=local`
5. Ansible installs: Node.js (via NVM), npm dependencies, systemd service, Nginx

> ✅ Because the playbook is pulled from GitHub every boot, pushing a fix to GitHub and triggering an instance refresh automatically deploys the fix to all new instances.

### 5.4 Application — SysMon REST API

The Node.js application (`app.js`) uses the `systeminformation` library to expose live hardware metrics as JSON endpoints:

| Endpoint | Returns |
|---|---|
| `GET /health` | Status ok + hostname + uptime — ALB health check target |
| `GET /api/dashboard` | Combined CPU load, memory %, disk %, network throughput |
| `GET /api/system` | OS info, CPU specs, memory summary |
| `GET /api/cpu` | Per-core load percentages, temperature |
| `GET /api/memory` | RAM and swap breakdown |
| `GET /api/disk` | All mounted filesystems with used/free/percent |
| `GET /api/network` | Network interfaces and live Rx/Tx bytes/sec |
| `GET /api/processes` | Top 10 processes by CPU usage |

---

## 6. Deployment Runbook

### 6.1 Initialize Terraform

```bash
cd ~/infra/terraform

# Connect to S3 backend and download provider plugins
terraform init

# Expected output:
# Initializing the backend...
# Successfully configured the backend "s3"!
# Terraform has been successfully initialized!
```

> ⚠️ If init fails with `NoSuchBucket`, verify the bucket name in `backend.tf` matches exactly what you created in `ap-south-1`.

### 6.2 Validate and Plan

```bash
# Validate HCL syntax
terraform validate
# Expected: Success! The configuration is valid.

# Format check
terraform fmt

# Generate plan
terraform plan -out=tfplan 2>&1 | tee plan.log
# Review plan.log — expect ~21 resources to be added
```

### 6.3 Apply

```bash
terraform apply tfplan
# Duration: ~3-4 minutes
# At completion:
# Apply complete! Resources: 21 added, 0 changed, 0 destroyed.

# Save the ALB DNS name from outputs:
terraform output alb_dns_name
```

### 6.4 Wait for Instance Bootstrap

After apply completes, the ASG launches an EC2 instance. The instance must:

| Step | Duration |
|---|---|
| Boot and run userdata | ~2 min |
| Install Ansible and clone GitHub repo | ~2 min |
| Run the Ansible playbook (Node.js, npm, Nginx) | ~3 min |
| Pass 2 consecutive ALB health checks on `/health` | ~1 min |

**Total wait: approximately 7–10 minutes after apply.**

### 6.5 Standard Deploy Sequence

Always generate a fresh plan before applying. Never reuse an old `tfplan` file:

```bash
terraform plan -out=tfplan
terraform apply tfplan
```

---

## 7. Validation & Testing

### 7.1 Check Target Group Health

```bash
aws elbv2 describe-target-health \
  --target-group-arn $(terraform output -raw target_group_arn) \
  --region ap-south-1 \
  --query 'TargetHealthDescriptions[*].{ID:Target.Id,State:TargetHealth.State}'

# Expected: State = healthy
```

### 7.2 API Tests

```bash
ALB=$(terraform output -raw alb_dns_name)

# Health check
curl -s http://$ALB/health | python3 -m json.tool

# Dashboard — all metrics in one call
curl -s http://$ALB/api/dashboard | python3 -m json.tool

# Round-robin test — hostname rotates as ASG adds instances
for i in {1..5}; do
  curl -s http://$ALB/health | python3 -c \
    "import sys,json; print(json.load(sys.stdin)['hostname'])"
  sleep 1
done
```

### 7.3 CloudWatch Log Validation

| Log Group | What to Look For |
|---|---|
| `/aws/ec2/terraform-automation/userdata` | Last line: `Userdata complete` — confirms Ansible finished |
| `/aws/ec2/terraform-automation/app` | `sysmon listening on 127.0.0.1:3000` |
| `/aws/ec2/terraform-automation/nginx` | `GET /health 200` — confirms ALB health checks are passing |

### 7.4 Auto Scaling Test

```bash
# SSH into an app instance
ssh -i ~/infra-key.pem ec2-user@<INSTANCE_IP>

# Install and run stress
sudo dnf install -y stress-ng
stress-ng --cpu 1 --cpu-load 80 --timeout 180s

# In another terminal — watch the alarm:
# CloudWatch → Alarms → terraform-automation-cpu-high
# Fires after 2 minutes → new instance launches
```

---

## 8. Deploying Updates (Zero Downtime)

Because instances are stateless and pull their config from GitHub at boot, updating the application is a two-step process:

### 8.1 Push Changes to GitHub

```bash
git add .
git commit -m "Update app.js or playbook"
git push origin main
```

### 8.2 Trigger Rolling Instance Refresh

```bash
aws autoscaling start-instance-refresh \
  --auto-scaling-group-name terraform-automation-asg \
  --region ap-south-1 \
  --preferences 'MinHealthyPercentage=50,InstanceWarmup=300'

# Monitor progress
aws autoscaling describe-instance-refreshes \
  --auto-scaling-group-name terraform-automation-asg \
  --region ap-south-1 \
  --query 'InstanceRefreshes[0].{Status:Status,Percentage:PercentageComplete}'
```

New instances launch, pull the latest playbook from GitHub, pass the health check, then old instances are terminated. The ALB routes traffic only to healthy instances throughout.

---

## 9. Troubleshooting Guide

| Symptom | Steps to Diagnose and Fix |
|---|---|
| **502 Bad Gateway from ALB** | 1. Check target group health (Section 7.1) 2. SSH into instance 3. Check `sudo tail -100 /var/log/userdata.log` 4. Check `sudo systemctl status sysmon` 5. Check `curl http://localhost/health` |
| **Target shows unhealthy** | Ansible may not have finished. Wait 5 more minutes then re-check. If still failing: SSH in and check `/var/log/ansible-run.log` |
| **Stale plan error on apply** | Always re-run `terraform plan -out=tfplan` before `terraform apply`. Never reuse an old plan file. |
| **dynamodb_table warning** | Replace `dynamodb_table` line in `backend.tf` with `use_lockfile = true` |
| **curl conflicts on AL2023** | Remove `curl` from dnf package list. `curl-minimal` is pre-installed and works for NVM. |
| **handlers in wrong file** | Ansible handlers must be in `roles/app/handlers/main.yml` not at the bottom of `tasks/main.yml` |
| **CloudWatch agent schema error** | `metrics` block must be top-level in the JSON, not nested inside `logs` |
| **sysmon service not found** | Ansible didn't run. Check `/var/log/userdata.log` for the error that stopped execution. |
| **Instance refresh stuck** | If existing instance is unhealthy, use `MinHealthyPercentage=0` to force replacement |

---

## 10. Cleanup

### 10.1 Terraform Destroy

```bash
cd ~/infra/terraform
terraform destroy
# Type 'yes' when prompted
# Destroys: ASG, EC2 instances, ALB, TG, SGs, IAM role, CW log groups, SSM param
```

### 10.2 Manual Cleanup (Console)

1. **S3** → your-bucket → Empty all objects → Delete bucket
2. **DynamoDB** → `terraform-state-lock` → Delete table *(if created)*
3. **EC2 → Instances** → `terraform-master` → Terminate
4. **EC2 → Key Pairs** → `infra-key` → Delete
5. **IAM → Users** → `terraform-admin` → Delete

> ⚠️ Always run `terraform destroy` **BEFORE** deleting the S3 bucket, otherwise the state file is gone and Terraform cannot track what to clean up.

---

## 11. Reference

### 11.1 Key AWS Resources Created

| Resource | Name / ARN Pattern |
|---|---|
| **ALB** | terraform-automation-alb |
| **Target Group** | terraform-automation-tg (health check: `GET /health` every 30s) |
| **ASG** | terraform-automation-asg |
| **Launch Template** | terraform-automation-lt-* |
| **App Security Group** | terraform-automation-app-sg |
| **ALB Security Group** | terraform-automation-alb-sg |
| **IAM Role** | terraform-automation-app-instance-role |
| **CW Log Group (App)** | /aws/ec2/terraform-automation/app |
| **CW Log Group (Nginx)** | /aws/ec2/terraform-automation/nginx |
| **CW Log Group (Userdata)** | /aws/ec2/terraform-automation/userdata |
| **CW Alarm (scale out)** | terraform-automation-cpu-high (>= 70% for 2 min) |
| **CW Alarm (scale in)** | terraform-automation-cpu-low (<= 30% for 5 min) |
| **SSM Parameter** | /terraform-automation/github_repo_url |

### 11.2 Useful Commands Quick Reference

```bash
# Get ALB URL
terraform output alb_dns_name

# Check target health
aws elbv2 describe-target-health \
  --target-group-arn $(terraform output -raw target_group_arn) \
  --region ap-south-1

# List running app instances
aws ec2 describe-instances \
  --region ap-south-1 \
  --filters "Name=tag:Project,Values=terraform-automation" "Name=instance-state-name,Values=running" \
  --query 'Reservations[*].Instances[*].{ID:InstanceId,IP:PublicIpAddress}' \
  --output table

# Trigger instance refresh
aws autoscaling start-instance-refresh \
  --auto-scaling-group-name terraform-automation-asg \
  --region ap-south-1 \
  --preferences 'MinHealthyPercentage=50,InstanceWarmup=300'

# Watch refresh status
aws autoscaling describe-instance-refreshes \
  --auto-scaling-group-name terraform-automation-asg \
  --region ap-south-1 \
  --query 'InstanceRefreshes[0].{Status:Status,Percentage:PercentageComplete}'
```

---

*Terraform + Ansible AWS PoC — Gunjan-007*
