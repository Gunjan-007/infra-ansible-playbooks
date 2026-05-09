# Server Lifecycle Management & Automation Platform

> End-to-End CI/CD Architecture & Operations Guide  
> **Stack:** Terraform · Ansible · Jenkins · AWS · GitHub · Packer · HashiCorp Vault · AWS Systems Manager

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Architecture Summary](#architecture-summary)
3. [Technology Stack](#technology-stack)
4. [Repository Structure](#repository-structure)
5. [Prerequisites](#prerequisites)
6. [Infrastructure Setup (PoC)](#infrastructure-setup-poc)
7. [Pipelines](#pipelines)
8. [Deployment Runbook](#deployment-runbook)
9. [Validation & Testing](#validation--testing)
10. [Zero-Downtime Updates](#zero-downtime-updates)
11. [Observability & Monitoring](#observability--monitoring)
12. [Security & Compliance](#security--compliance)
13. [Terraform State Management](#terraform-state-management)
14. [Troubleshooting](#troubleshooting)
15. [Cleanup](#cleanup)
16. [Quick Reference](#quick-reference)

---

## Project Overview

This platform automates every phase of a server's lifecycle across a multi-OS AWS enterprise estate — from golden image creation and monthly refresh, through deployment and configuration, to resource scaling, OS upgrades, patching, and controlled decommissioning.

The included PoC deploys a Node.js REST API (**SysMon**) that reports live EC2 hardware metrics, provisioned entirely via Terraform + Ansible with no manual configuration.

| Field | Value |
|---|---|
| **Project** | terraform-automation |
| **Region** | ap-south-1 (Mumbai) |
| **VPC** | vpc-04acd3dfb6b9ac682 |
| **Application** | SysMon REST API (Node.js) |
| **GitHub Repo** | Gunjan-007/infra-ansible-playbooks |

### Platform Objectives

- Eliminate manual, error-prone server build processes through fully automated golden image pipelines
- Maintain consistent, security-hardened base images updated monthly across Debian/Ubuntu, RHEL/CentOS, and Windows Server
- Enforce infrastructure-as-code discipline — every configuration lives in version-controlled Git repositories
- Enable zero-downtime deployments and in-place OS upgrades with automated rollback
- Provide self-service provisioning with policy guardrails via Jenkins pipeline approvals
- Deliver full audit trails for compliance (SOC 2, ISO 27001, CIS Benchmarks)

---

## Architecture Summary

The platform is organized into six automation domains, each with its own Jenkins pipeline, Terraform module, and Ansible playbook collection.

| Domain | Primary Tooling | Outcome |
|---|---|---|
| 1. Golden Image Factory | Packer + Ansible + EC2 Image Builder | Monthly AMIs per OS type/version |
| 2. Server Provisioning | Terraform + Ansible + Jenkins | Servers deployed from approved AMIs |
| 3. Patch Management | AWS SSM + Ansible + Jenkins | Monthly OS/app patches, zero-downtime |
| 4. OS In-Place Upgrade | Ansible + Jenkins + ASG Rolling | WS2022→WS2025, RHEL 8→RHEL 9 |
| 5. Resource Scaling | Terraform + AWS APIs + Jenkins | CPU, RAM, EBS expand with no rebuild |
| 6. Decommissioning | Terraform destroy + Ansible cleanup | Safe removal with backup verification |

### PoC Infrastructure Components

| Component | Description |
|---|---|
| **Master EC2** | Control plane — runs Terraform and triggers deployments |
| **ALB** | Application Load Balancer — routes HTTP traffic to healthy instances |
| **ASG** | Auto Scaling Group — min 1, max 3 instances, CPU-based scaling |
| **Launch Template** | Defines EC2 config; userdata pulls Ansible from GitHub on boot |
| **S3 Backend** | Stores `terraform.tfstate` with versioning enabled |
| **DynamoDB / Lock** | State locking via `use_lockfile` (Terraform 6.x) |
| **CloudWatch** | Log groups for app/nginx/userdata + CPU and ALB alarms |
| **GitHub** | Single source of truth for all Ansible playbooks |

### Key Design Principles

- **Stateful Backend** — S3 stores state; concurrent runs are blocked by lockfile
- **Stateless Compute** — instances are cattle, not pets; they self-configure from GitHub at boot
- **Observability** — CloudWatch collects logs, custom metrics (memory/disk), and fires alarms
- **Zero-downtime updates** — rolling instance refresh via ASG replaces instances without downtime
- **No local tooling** — Terraform and Ansible run entirely from the Master EC2

---

## Technology Stack

| Tool | Version | Role |
|---|---|---|
| HashiCorp Terraform | ≥ 1.7 | Infrastructure provisioning — EC2, VPC, ALB, ASG, IAM, S3 backend |
| HashiCorp Packer | ≥ 1.10 | Golden AMI construction |
| Red Hat Ansible | ≥ 2.16 | Configuration management — hardening, patching, upgrade orchestration |
| Ansible AWX / AAP | Latest stable | Enterprise Ansible control plane with RBAC and audit logging |
| Jenkins | LTS + Pipeline | CI/CD orchestration — integrates GitHub, Terraform, Ansible, AWS CLI |
| GitHub / GitHub Actions | Cloud or GHES | Source of truth for all IaC, playbooks, and Packer templates |
| AWS SSM | Managed service | Patch Manager, Run Command, Session Manager, Parameter Store |
| AWS S3 + DynamoDB | Managed service | Terraform remote state backend with state locking |
| AWS CloudWatch | Managed service | Metrics, logs, and alarms for pipelines and managed servers |
| HashiCorp Vault | ≥ 1.16 | Secrets management — SSH keys, passwords, API tokens |
| InSpec / Lynis | Latest | Post-build CIS benchmark compliance scanning |

---

## Repository Structure

All infrastructure code lives in the `corp-infra` GitHub Organization with branch protection on `main` (1+ reviewer required, CI checks must pass, no force pushes).

```
corp-infra/
├── server-templates/          # Packer HCL templates per OS family
│   ├── debian-12/
│   ├── rhel-9/
│   ├── windows-2022/
│   └── windows-2025/
├── ansible-playbooks/         # All Ansible roles and playbooks
│   ├── roles/
│   ├── playbooks/             # bootstrap, patch, upgrade, decommission
│   └── inventory/
├── terraform-modules/         # Reusable modules: ec2-instance, asg, alb, iam-role, ebs-volume
├── terraform-environments/    # Environment root configs: prod, staging, dev
├── jenkins-pipelines/         # Declarative Jenkinsfiles per domain
├── compliance-policies/       # Sentinel/OPA policies, InSpec profiles, CIS configs
└── runbooks/                  # Markdown operational runbooks + ADRs (GitHub Pages)
```

### PoC Terraform Directory

```
~/infra/terraform/
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

### Ansible Playbooks Structure

```
infra-ansible-playbooks/
├── site.yml
├── inventory/
│   └── hosts
└── roles/
    └── app/
        ├── tasks/main.yml
        ├── handlers/main.yml       # handlers MUST be here, not in tasks/
        ├── templates/
        │   ├── nginx.conf.j2
        │   └── app.service.j2
        └── files/
            └── app.js
```

### Branch Strategy

| Branch | Purpose |
|---|---|
| `main` | Production-ready code only. Protected. All merges via PR. |
| `develop` | Integration branch. CI runs on every push. |
| `feature/<ticket-id>-description` | Short-lived branches per change |
| `release/<version>` | Release candidate branch |
| `hotfix/<ticket-id>` | Emergency patches — merge to both `main` and `develop` |

---

## Prerequisites

The following must be completed manually before running any Terraform commands.

### 1. IAM User for Terraform

```
IAM → Users → Create user → Name: terraform-admin
Attach policy: AdministratorAccess (PoC only — scope down in production)
Security credentials → Create access key → CLI → Save Access Key ID and Secret
```

> ⚠️ Store the access key securely. It is shown only once.

### 2. EC2 Key Pair

```
EC2 → Key Pairs → Create key pair → Name: infra-key → Type: RSA → Format: .pem
```

```bash
chmod 400 infra-key.pem
```

### 3. S3 Bucket for Terraform State

```
S3 → Create bucket → Name: <your-unique-name>-terraform-state
Region: ap-south-1 | Block all public access: ON | Versioning: Enable
```

> ⚠️ The bucket name must be globally unique. Use your name or account ID as a prefix.

### 4. GitHub Repository

Create a public repository `infra-ansible-playbooks` and push all Ansible files (see [Ansible Configuration](#ansible-playbooks-structure)).

---

## Infrastructure Setup (PoC)

### Launch Master EC2

| Setting | Value |
|---|---|
| Name | terraform-master |
| AMI | Amazon Linux 2023 |
| Instance type | t3.micro |
| Key pair | infra-key |
| Auto-assign Public IP | Enable |
| Security group inbound | SSH port 22 from My IP only |

Attach IAM role `terraform-master-role` (AdministratorAccess) to the instance after launch.

### Install Tools on Master

```bash
ssh -i infra-key.pem ec2-user@<MASTER_PUBLIC_IP>

# Terraform
sudo yum install -y yum-utils
sudo yum-config-manager --add-repo https://rpm.releases.hashicorp.com/AmazonLinux/hashicorp.repo
sudo yum install -y terraform

# Ansible
pip3 install ansible --user
echo 'export PATH=$PATH:~/.local/bin' >> ~/.bashrc && source ~/.bashrc

# Git
sudo yum install -y git

# Verify AWS access
aws sts get-caller-identity
```

### Terraform Infrastructure Values

| Variable | Value |
|---|---|
| `aws_region` | ap-south-1 |
| `project_name` | terraform-automation |
| `vpc_id` | vpc-04acd3dfb6b9ac682 |
| `ami_id` | ami-0e12ffc2dd465f6e4 (Amazon Linux 2023) |
| `instance_type` | t3.micro |
| `key_name` | infra-key |
| `min_size / max_size` | 1 / 3 |

### Important: backend.tf (Terraform 6.x)

Terraform AWS provider 6.x deprecates `dynamodb_table`. Use `use_lockfile` instead:

```hcl
backend "s3" {
  bucket       = "your-bucket-name"
  key          = "terraform-automation/terraform.tfstate"
  region       = "ap-south-1"
  use_lockfile = true   # replaces dynamodb_table
  encrypt      = true
}
```

---

## Pipelines

### Pipeline 1 — Golden Image Factory

Builds security-hardened AMIs for all supported OS types, refreshed monthly.

**Supported OS Matrix**

| OS | AMI Naming Convention |
|---|---|
| Debian 12 | `corp-debian-12-YYYY.MM.v#` |
| Ubuntu 22.04 LTS | `corp-ubuntu-2204-YYYY.MM.v#` |
| Ubuntu 24.04 LTS | `corp-ubuntu-2404-YYYY.MM.v#` |
| RHEL 8.x | `corp-rhel-8-YYYY.MM.v#` |
| RHEL 9.x | `corp-rhel-9-YYYY.MM.v#` |
| Windows Server 2022 | `corp-ws2022-YYYY.MM.v#` |
| Windows Server 2025 | `corp-ws2025-YYYY.MM.v#` |

**Stages:** Source & Validation → Packer Build → Ansible Hardening → Security Scan (Inspector + InSpec) → Publish & Tag → AMI Catalog Update

**AMI Retention Policy**

| State | Retention |
|---|---|
| CURRENT | Retained until next successful build |
| PREVIOUS | 90 days, then auto-deregistered |
| DEPRECATED | 30-day warning, then deregistered after all instances migrate |
| EMERGENCY | 120 days, manual review required |

### Pipeline 2 — Server Provisioning

Deploys servers from approved golden AMIs with full stack automation: network, security groups, IAM, storage, Ansible Day-1 config, and CMDB registration.

**Server Naming Convention:** `<env>-<region>-<os>-<role>-<seq>` (e.g., `prod-use1-rhel9-web-001`)

### Pipeline 3 — Patch Management

Ring-based deployment model: patches applied to lower environments first, validated, then progressively rolled to production.

| Ring | Targets | Schedule | Auto-Approve? |
|---|---|---|---|
| Ring 0 | Build/Test servers | Patch Tuesday +1 | Yes |
| Ring 1 | Dev | +3 days | Yes (24h bake) |
| Ring 2 | Staging | +7 days | Semi (CAB review) |
| Ring 3 | Prod non-critical | +10 days | No — explicit approval |
| Ring 4 | Prod critical/DB | +14 days | No — change window |
| Emergency | All rings | Within 24-72h of CVE | Security override |

### Pipeline 4 — In-Place OS Version Upgrade

| From | To | Tool | Duration |
|---|---|---|---|
| Windows Server 2022 | Windows Server 2025 | Windows Setup /auto upgrade | 2-3 hours |
| RHEL 8.x | RHEL 9.x | Leapp (ELevate) | 60-90 min |
| Ubuntu 22.04 LTS | Ubuntu 24.04 LTS | do-release-upgrade | 45-90 min |
| Debian 11 | Debian 12 | apt dist-upgrade | 30-60 min |

### Pipeline 5 — Resource Scaling

- **Storage expansion** — online, zero-downtime via EBS Modify + OS filesystem resize
- **CPU/Memory scaling** — instance type change with stop/start cycle and ALB drain
- **ASG fleets** — blue/green launch template with `start-instance-refresh`

### Pipeline 6 — Server Decommissioning

Multi-stage, approval-gated process: workload migration verification → final EBS snapshot → data sanitization → 72-hour quarantine → Terraform destroy → CMDB/DNS cleanup.

---

## Deployment Runbook

```bash
cd ~/infra/terraform

# 1. Initialize
terraform init

# 2. Validate and plan
terraform validate
terraform fmt
terraform plan -out=tfplan 2>&1 | tee plan.log

# 3. Apply (~3-4 minutes, ~21 resources)
terraform apply tfplan

# 4. Get ALB DNS
terraform output alb_dns_name
```

> ⚠️ Always generate a fresh plan before applying. Never reuse an old `tfplan` file.

After apply, wait approximately **7-10 minutes** for the ASG instance to boot, run Ansible, install Node.js/Nginx, and pass ALB health checks.

---

## Validation & Testing

```bash
# Check target group health
aws elbv2 describe-target-health \
  --target-group-arn $(terraform output -raw target_group_arn) \
  --region ap-south-1

# Run API tests
ALB=$(terraform output -raw alb_dns_name)
curl -s http://$ALB/health | python3 -m json.tool
curl -s http://$ALB/api/dashboard | python3 -m json.tool

# Round-robin test (hostname rotates as ASG scales)
for i in {1..5}; do
  curl -s http://$ALB/health | python3 -c \
    "import sys,json; print(json.load(sys.stdin)['hostname'])"
  sleep 1
done
```

### SysMon API Endpoints

| Endpoint | Returns |
|---|---|
| `GET /health` | Status, hostname, uptime (ALB health check target) |
| `GET /api/dashboard` | Combined CPU, memory %, disk %, network throughput |
| `GET /api/cpu` | Per-core load percentages, temperature |
| `GET /api/memory` | RAM and swap breakdown |
| `GET /api/disk` | All mounted filesystems with used/free/percent |
| `GET /api/network` | Interfaces and live Rx/Tx bytes/sec |
| `GET /api/processes` | Top 10 processes by CPU usage |

### CloudWatch Log Validation

| Log Group | What to Look For |
|---|---|
| `/aws/ec2/terraform-automation/userdata` | Last line: `Userdata complete` |
| `/aws/ec2/terraform-automation/app` | `sysmon listening on 127.0.0.1:3000` |
| `/aws/ec2/terraform-automation/nginx` | `GET /health 200` |

---

## Zero-Downtime Updates

Instances are stateless and pull config from GitHub at boot.

```bash
# 1. Push changes to GitHub
git add . && git commit -m "Update app or playbook" && git push origin main

# 2. Trigger rolling instance refresh
aws autoscaling start-instance-refresh \
  --auto-scaling-group-name terraform-automation-asg \
  --region ap-south-1 \
  --preferences 'MinHealthyPercentage=50,InstanceWarmup=300'

# 3. Monitor progress
aws autoscaling describe-instance-refreshes \
  --auto-scaling-group-name terraform-automation-asg \
  --region ap-south-1 \
  --query 'InstanceRefreshes[0].{Status:Status,Percentage:PercentageComplete}'
```

---

## Observability & Monitoring

### Platform-Level Monitoring

| What to Monitor | Tool | Alert Destination |
|---|---|---|
| Jenkins pipeline failures | Jenkins + CloudWatch Logs | SNS → PagerDuty / Email |
| AMI build failures | CloudWatch Events + Lambda | SNS → Infra Team Slack |
| Patch compliance drift | SSM Compliance + CloudWatch | Weekly email + Dashboard |
| AMI age > 45 days | Lambda + DynamoDB catalog | SNS → Admin team warning |
| Inspector CRITICAL findings | AWS Security Hub | SNS → Security + PagerDuty |

### CloudWatch Alarms

| Alarm | Threshold | Action |
|---|---|---|
| CPU High | ≥ 70% for 2 min | Scale out |
| CPU Low | ≤ 30% for 5 min | Scale in |
| CPU WARNING | > 85% for 10 min | Alert |
| CPU CRITICAL | > 95% for 5 min | PagerDuty |
| Disk WARNING | > 80% | Alert |
| Disk CRITICAL | > 90% | PagerDuty |
| StatusCheckFailed | Any | PagerDuty |

---

## Security & Compliance

### IAM Role Architecture (Least Privilege)

| IAM Role | Assumed By | Permissions Summary |
|---|---|---|
| `JenkinsBuildRole` | Jenkins EC2 | EC2:Describe*, SSM:*, S3 (state bucket), STS:AssumeRole |
| `TerraformDeployRole` | Jenkins (assumed) | EC2:*, IAM:PassRole (limited), Route53:*, S3/DynamoDB (state) |
| `PackerBuildRole` | Packer EC2 builder | EC2:CreateImage, EC2:Describe*, SSM:* |
| `EC2InstanceProfile` | All managed EC2 | SSM:*, CloudWatch:PutMetricData/PutLogEvents |
| `AnsibleAWXRole` | Ansible AWX EC2 | EC2:Describe* (dynamic inventory), SSM:SendCommand |

### Network Security Controls

| Control | Mechanism |
|---|---|
| No direct SSH/RDP | SSM Session Manager only — ports 22/3389 never open |
| IMDSv2 required | Enforced in Terraform launch template + SCP |
| EBS encryption | All volumes encrypted with KMS CMK per environment |
| VPC flow logs | Enabled on all VPCs, shipped to S3 + Athena |
| GuardDuty | Threat detection across all accounts via AWS Organizations |

### Compliance Coverage

| Area | Mechanism | Evidence |
|---|---|---|
| CIS Benchmarks | InSpec on every AMI build + weekly on running servers | S3 scan reports |
| Change Management | JIRA ticket required for every change; Terraform plan diffs attached | JIRA + Jenkins logs |
| Patch Compliance | SSM Patch Manager + monthly ring-based reports | SSM Console + S3 |
| Access Logging | CloudTrail, VPC Flow Logs, SSM Session logs, Vault audit logs | S3 (7-year retention) |
| Secrets Rotation | Vault dynamic secrets with short TTLs; STS 1-hour expiry | Vault audit log |

---

## Terraform State Management

- **S3 Bucket:** `corp-terraform-state-<account-id>` — versioning enabled, KMS encryption, MFA Delete
- **State locking:** `use_lockfile = true` in `backend.tf` (Terraform 6.x) — no DynamoDB table needed
- **State organization:** separate state file paths per environment (not workspaces)
- **Drift detection:** weekly Jenkins job runs `terraform plan` across all environments; non-empty plans trigger SNS alert

> ⚠️ Never commit state files to Git. `.gitignore` enforces this in all Terraform repos.

---

## Troubleshooting

| Symptom | Steps to Diagnose and Fix |
|---|---|
| **502 Bad Gateway from ALB** | Check target group health → SSH in → `sudo tail -100 /var/log/userdata.log` → `sudo systemctl status sysmon` |
| **Target shows unhealthy** | Wait 5 more minutes (Ansible may still be running). If still failing, check `/var/log/ansible-run.log` |
| **Stale plan error on apply** | Always re-run `terraform plan -out=tfplan` before `terraform apply`. Never reuse old plan files. |
| **`dynamodb_table` warning** | Replace `dynamodb_table` in `backend.tf` with `use_lockfile = true` |
| **curl conflicts on AL2023** | Remove `curl` from dnf package list — `curl-minimal` is pre-installed and works for NVM |
| **Handlers in wrong file** | Ansible handlers must be in `roles/app/handlers/main.yml`, not at the bottom of `tasks/main.yml` |
| **CloudWatch agent schema error** | `metrics` block must be top-level in the JSON config, not nested inside `logs` |
| **sysmon service not found** | Ansible didn't run — check `/var/log/userdata.log` for the stopping error |
| **Instance refresh stuck** | If existing instance is unhealthy, use `MinHealthyPercentage=0` to force replacement |
| **Terraform state lock stuck** | Check DynamoDB lock table → verify no active apply → run `terraform force-unlock <lock-id>` |
| **Server won't boot post-upgrade** | Stop instance → detach volumes → restore from pre-upgrade EBS snapshots → reattach → start |

---

## Cleanup

```bash
# 1. Destroy all Terraform-managed resources
cd ~/infra/terraform
terraform destroy

# 2. Manual cleanup in AWS Console (run AFTER terraform destroy)
# - S3: empty and delete state bucket
# - EC2: terminate terraform-master instance
# - EC2: delete infra-key key pair
# - IAM: delete terraform-admin user
```

> ⚠️ Always run `terraform destroy` **before** deleting the S3 bucket. Deleting the bucket first removes the state file and Terraform loses track of all resources.

---

## Quick Reference

### Useful Commands

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

### Key AWS Resources Created

| Resource | Name |
|---|---|
| ALB | `terraform-automation-alb` |
| Target Group | `terraform-automation-tg` (health: `GET /health` every 30s) |
| ASG | `terraform-automation-asg` |
| Launch Template | `terraform-automation-lt-*` |
| App SG | `terraform-automation-app-sg` |
| ALB SG | `terraform-automation-alb-sg` |
| IAM Role | `terraform-automation-app-instance-role` |
| CW Log (App) | `/aws/ec2/terraform-automation/app` |
| CW Log (Nginx) | `/aws/ec2/terraform-automation/nginx` |
| CW Log (Userdata) | `/aws/ec2/terraform-automation/userdata` |
| CW Alarm (scale out) | `terraform-automation-cpu-high` (≥70% for 2 min) |
| CW Alarm (scale in) | `terraform-automation-cpu-low` (≤30% for 5 min) |
| SSM Parameter | `/terraform-automation/github_repo_url` |

### Architecture Decision Records

| ADR | Decision |
|---|---|
| ADR-001 | All servers must be deployed from approved AMIs — no manual OS installation |
| ADR-002 | No long-lived SSH keys. All access via SSM Session Manager |
| ADR-003 | Terraform remote state in S3 with locking. Never use local state in pipelines |
| ADR-004 | Every production change requires a JIRA ticket and at least one approver who did not initiate it |
| ADR-005 | Packer AMI builds run in an isolated VPC with no internet egress — all packages via VPC endpoints |
| ADR-006 | AMIs older than 90 days in PREVIOUS state are deregistered automatically |
| ADR-007 | All EBS volumes encrypted with AWS KMS Customer Managed Keys at all times |

---

*Server Lifecycle Management & Automation Platform · Terraform · Ansible · AWS · Last Updated: May 2026*
