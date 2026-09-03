---
name: craft
description: Drive a code change through implement → independent review → fix using the dedicated opus subagents (implementer, reviewer). Use when the user invokes /craft, or asks to implement an OpenSpec change with a subagent and review it with a separate subagent. Never commits or pushes — git stays under the user's explicit control.
---

# /craft — implement → review → fix pipeline

Orchestrate one change through two dedicated subagents with fresh, separate contexts. You are the orchestrator: you do not implement or review anything yourself — the value of the pipeline is the reviewer's independence from the implementer, and yours from both.

## Arguments

`/craft [target] [--cycles N] [--impl-model M] [--review-model M]`

- `target` — an OpenSpec change name (check against `openspec list`) or a free-form task description. If omitted: exactly one active change → use it; several → ask via AskUserQuestion; none → ask the user what to drive.
- `--cycles N` — number of review→fix rounds. Default **2**.
- `--impl-model` / `--review-model` — override the Agent tool's `model` for that role. Default: whatever the agent definitions carry (opus). Reasoning effort is fixed in the definitions (`max`) and is not a flag.

## Pipeline

1. **Implement.** Spawn the `implementer` agent (Agent tool, `subagent_type: implementer`, foreground) with the target. For an OpenSpec change pass the change name — the agent resolves context and tasks itself via `openspec status` / `openspec instructions apply`; for a free-form task pass the description verbatim plus any context the user gave. Keep the returned agent ID — fix rounds continue this same agent via SendMessage so it keeps its context.
2. **Review→fix cycles** (repeat N times):
   a. Spawn a **fresh** `reviewer` agent each round (`subagent_type: reviewer`, foreground) — never reuse a reviewer, its independence is the point. Tell it which change/task the diff is supposed to implement.
   b. `No findings.` → stop cycling early.
   c. Otherwise send the findings verbatim to the existing implementer via SendMessage with the instruction to fix them (it may push back on a finding with an argument — relay unresolved disagreements to the user rather than arbitrating silently).
3. **Gate.** Run `npm run check` from the root yourself. Red gate after the last cycle → one extra SendMessage to the implementer to fix the gate only; still red → report, do not loop further.
4. **Report to the user (in Russian).** What was implemented (requirement IDs), findings per round and their fate (fixed / disputed / left as minor), gate status, `git diff --stat`. Findings from the last round that were fixed without a re-review — say so explicitly.

## Hard limits

- NEVER `git commit` or `git push`, and never instruct a subagent to. The user drives git explicitly and separately.
- Do not summarize the reviewer's findings away — relay them to the implementer verbatim, and to the user in full (translated) in the final report.
- Do not exceed the requested cycle count to chase minor findings; leftover minors go in the report.
