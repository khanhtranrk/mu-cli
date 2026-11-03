# Contribution workflow (all humans and automated agents)

This policy applies equally to all contributors, regardless of tool or model.

## Work lifecycle
1. Create or identify an Issue in the repository owning the change. Include scope, acceptance criteria, constraints and dependencies. Cross-repository work uses a tracking Issue in mu plus linked implementation Issues.
2. Read AGENTS.md, project documentation and relevant source; inspect git status, remote and base before editing.
3. Keep master as the integration branch. Create a topic branch from master: feat/<issue>-topic, fix/<issue>-topic, refactor/<issue>-topic or docs/<issue>-topic. Never assume main or push ordinary changes directly to master.
4. Implement the smallest coherent change. Do not add unrelated refactors or alter contracts silently.
5. Run focused checks and tests; report exact results and checks not run. Avoid unnecessary GPU downloads and costly integration jobs.
6. Open a Draft PR for substantial work; link the Issue, explain the diff, tests, risks, compatibility and outstanding questions. Mark ready when acceptance criteria are satisfied.
7. Respond to review on the same PR. Merge only with authorized approval and required checks; prefer squash merge. Close the Issue after acceptance.

## Decision boundaries
Implementation details within scope may be chosen independently. Obtain explicit approval before changing database schemas, external API contracts, Spec/CEL semantics, authentication, permissions, storage ownership, destructive behavior or cross-project architecture unless the Issue already authorizes the decision. Never force-push, expose secrets, deploy to production, delete production data or merge without authorization.

## Multi-repository coordination
Each submodule owns its own Issue, branch, PR and validation. Merge compatible reviewed submodule PRs first; then propose a separate PR in mu to update the exact gitlink pins and integration documentation. Never advance unrelated submodules. mu-cli-legacy is read-only migration reference by default.

## Review checklist
- Acceptance criteria met, focused diff, correct repository ownership.
- Security, least privilege, secrets, data lifecycle and backward compatibility preserved.
- Errors, recovery and regression tests addressed proportionately.
- Documentation reflects changed behavior; test evidence and limitations disclosed.

## Pull request description
### Issue
Closes #<number> (or link to another repository).

### Summary
What changed and why.

### Verification
Commands, results and checks not run.

### Compatibility and risk
API/schema/security impacts, migration and rollback.

### Review notes
Decisions needed and areas requiring attention.
