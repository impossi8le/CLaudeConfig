---
name: orchestrator
description: Use when the user asks to run a multi-agent workflow, delegate analysis and implementation across roles, use the local orchestrator MCP, or coordinate approvals and verification across Claude Code, Claude Desktop, and DSH.
---

# Orchestrator

Choose the orchestration implementation from the current session context. Do not conflate the text-only Desktop MCP with Claude Code's tool-enabled agents or DSH's agent teams.

## Implementations

| Environment | Mechanism | Actual capability |
|---|---|---|
| Claude Code | Native agents / `Agent` tool | Can inspect or change the current repository according to the tools granted to each agent. |
| Claude Desktop | Local `orchestrator-mcp` | Runs RouterAI text completions, persists role outputs and gates, but has no repository filesystem or terminal execution. Claude Code must perform edits and run checks. |
| DeepSeek Harness (DSH) | `agent_teams_*` | DSH-owned agent-team task management; follow its live tool contract. |

For Claude Desktop MCP work, use the detailed protocol below. Do not describe a model response as a file edit, build, or test run.

## Claude Desktop: `orchestrator-mcp`

### Roles and model defaults

| Role | Purpose | Default model |
|---|---|---|
| `analyst` | Requirements, acceptance criteria, constraints | `openai/openai/gpt-6-luna` |
| `architect` | Architecture, interfaces, data model and risks | `openai/openai/gpt-6-luna` |
| `approver` | Explicit `APPROVED` / `REJECTED` requirements gate | `openai/deepseek/deepseek-v4.1-flash` |
| `developer` | Produces an implementation handoff for Claude Code | `openai/openai/gpt-6-luna` |
| `devops` | Advises on build and test commands; does not run them | `openai/deepseek/deepseek-v4.1-flash` |
| `qa` | Reviews submitted check evidence; does not run tests | `openai/deepseek/deepseek-v4.1-flash` |

The MCP accepts `ORCH_PRO_MODEL` and `ORCH_FLASH_MODEL` overrides. Its requested default IDs are forwarded to RouterAI unchanged. If a model is rejected, report the provider error; do not silently substitute an ID. Availability was not verified with a paid live request.

Auto mode is a length/keyword heuristic, not semantic task understanding: it selects `simple` when the task is at most 90 characters and contains none of its hard-coded multi-scope terms; otherwise it selects `full`. A short broad task can therefore select simple, while a long narrow task can select full. Set `mode` explicitly when that heuristic does not match the task. Explicit nonempty `roles` replace the mode’s default sequence; do not omit analyst/approver unless the user specifically requests a reduced workflow.

### Modes and default sequences

`orchestrate_start` accepts `mode: "auto" | "simple" | "full"` (default `auto`) and optional explicit `roles`.

- `auto` selects `simple` for a short, narrowly scoped request; otherwise it selects `full`.
- `simple`: `analyst → approver → developer → qa`. Skips architecture and runs analysis/approval preparation without an extra `orchestrate_next` call.
- `full`: `analyst + architect` run in parallel from the original task, then `approver → developer → devops → qa`. The current built-in default role list omits `devops`, however; normal `full` mode is therefore `analyst + architect → approver → developer → qa`. Even if manually included, DevOps is an advisory text role and is not an executable build step; standard advancement pauses after developer handoff.

Both default workflows stop at the explicit approval gate. On approval, `orchestrate_next` runs the developer handoff and stops at `waiting-execution`. The MCP has not edited files at this point.

### Correct end-to-end protocol

1. Start a workflow, choosing the scope/mode deliberately:
   `orchestrate_start({ task, mode: "auto" })`.
2. Read the returned `run_id` and approval result. Preparation runs automatically until a gate. Use `orchestrate_status({ run_id })` and `orchestrate_result({ run_id, role })` when details are needed; do not advance through each prep role manually.
3. If approval is `REJECTED`, inspect the reasons and call `orchestrate_resolve({ run_id, action: "retry", target: "analyst", feedback })`, or stop. Do not skip an approval gate unless the user explicitly authorizes it.
4. When approval is `APPROVED`, call `orchestrate_next({ run_id })` to get the implementation handoff. Then Claude Code—not the MCP role—must inspect the repository, implement the change, review the diff, and run the appropriate real checks.
5. If a check fails, fix the implementation and rerun the checks. Submit the fresh results with `orchestrate_submit_qa({ run_id, checks })`, where each check contains `name`, `command`, integer `exitCode`, and concise `output`.
6. The MCP rejects missing/malformed evidence and does not ask the QA model to pass failed checks. For all-zero exit codes it asks QA to assess the evidence; only an explicit `VERDICT: PASSED` completes the run. Ambiguous QA text remains a failure/pending execution, not success.
7. If QA review rejects evidence, use `orchestrate_resolve({ run_id, action: "retry", feedback })`. The old evidence is cleared and a new developer handoff is produced. Claude Code must implement/review/run checks again before resubmitting fresh evidence.

Evidence is supplied by Claude Code and is not independently authenticated by the MCP. Submit only commands actually run and their observed exit codes/output. Never claim `PASSED` based only on QA prose, a proposed command, or a developer handoff.

### MCP tools

- `orchestrate_start({ task, mode?, roles?, cwd?, autoRetry?, maxRetries? })` — create a persisted run; auto-advance preparation to a gate.
- `orchestrate_status({ run_id })` — inspect state.
- `orchestrate_next({ run_id })` — pass an approved gate and receive the developer handoff; normally blocked while waiting for Claude Code execution/evidence. After a failed QA review, prefer `orchestrate_resolve(action: "retry")` to force a new handoff and clear old evidence before resubmitting.
- `orchestrate_submit_qa({ run_id, checks })` — submit the actual local verification results for QA review.
- `orchestrate_resolve({ run_id, action, target?, feedback? })` — retry/skip/stop a waiting gate. Preserve human approval; skip only with explicit authorization.
- `orchestrate_result({ run_id, role })` — read one saved role result.
- `orchestrate_interject({ run_id, role?, message })` — save guidance and rewind that role when its result is already produced.
- `orchestrate_edit({ run_id, role, text })` — replace a stored role result.
- `orchestrate_add_role({ run_id, role, index? })` — insert a supported role in a run.

Run mutation is serialized per run in this MCP process; a busy-run error means retry after the in-flight call finishes. Runs persist under the server's `runs/` directory. Memory is best-effort contextual material, not an authority over current project state.

## Claude Code agents

Use the available native `Agent` tool/subagent types and their granted tools. A Claude Code developer agent may edit files only if its tool permissions allow it; run tests through actual terminal/tool access. Preserve explicit review and verification even when the agent can execute changes.

## DSH agent teams

Use `agent_teams_*` tools only when the session is actually connected to DeepSeek Harness. Follow the live schema/status reported by those tools rather than assuming it matches `orchestrator-mcp`.

## Common mistakes

- Saying the Desktop MCP developer role implemented code: it only returned text.
- Saying DevOps built the project or QA ran tests: both are text-only roles.
- Treating an approval as proof that implementation or tests passed.
- Treating arbitrary QA prose as a passing verdict.
- Passing proposed commands or fabricated output as verification evidence.
- Assuming every implementation has the same role order, concurrency, gates, or model IDs.
