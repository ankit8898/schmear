---
name: schmear
description: Hands self-contained coding subtasks to other AI coding agents (Claude Code, Codex, Grok, Antigravity, OpenCode) through the schmear MCP server's `delegate` tool, which runs each task on whichever of the user's subscriptions would otherwise waste the most quota. Use when the user asks to delegate, hand off, fan out, use another agent or model, or spread usage across their subscriptions, and when schmear's `delegate` tool is available and a self-contained subtask (tests for a module, a code review, codebase research, a scoped change, a bug investigation) would otherwise go to a built-in subagent.
---

# Delegating with schmear

Treat `delegate` like a subagent that runs on another agent's CLI. schmear only picks the subscription; you still own the plan, the directories, commits, merging and the final answer.

## When to delegate

Delegate self-contained work with a clear deliverable: tests for a module, a review of a diff, a question about the codebase, a change confined to named files, or several independent changes that can run at once.

Do it yourself when the task is a few lines, when it depends on context from this conversation you cannot write down, when each step needs the previous step's result, or when it needs the user to answer questions as it goes. A worker starts cold, so a task that takes longer to explain than to do is not worth handing off.

## Write the prompt

The worker sees only your `prompt` and its `cwd`. Your conversation, your plan and the files you have read are invisible to it. Write the prompt so a capable engineer new to the repo could finish without asking anything:

```
Goal: <the outcome, in one or two sentences>
Context: <files and symbols involved, relevant facts you already know>
Constraints: <conventions to follow, files not to touch, no commits>
Done when: <the exact command that must pass, or the observable result>
Report: what you changed, the verification output, and anything left open.
```

Workers cannot delegate further, so never ask one to split its task across other agents. Set `description` to a short label; it names the task in permission prompts and results.

## Give writing tasks their own directory

Tasks given the same `cwd` share that directory, and schmear runs no git commands. Read-only tasks can share one. Give each task that edits files its own git worktree, created before the call, so parallel workers cannot overwrite each other, and pass its absolute path as `cwd`:

```sh
git worktree add ../wt-parse-tests -b parse-tests   # then cwd: "/abs/path/wt-parse-tests"
```

Review and merge the result yourself, then remove the worktree.

A worker runs under its own CLI's permission mode and sandbox, not yours, and can use the MCP servers its CLI loads. Only delegate in a directory you would let that agent work in. A Codex worker trusts its working directory's `.codex/config.toml`, so for a checkout you do not trust, pass `agents` as `["claude", "grok", "agy"]`.

## Choose the tier

Pick the lowest `tier` that will do the job well. Every tier above that shuts out subscriptions that could have run the task, and their unused quota is what schmear exists to spend.

- 1: mechanical work with an exact spec, such as a rename, formatting, or simple tests.
- 2: typical feature work, tests, reviews and research.
- 3: hard debugging, subtle concurrency, design decisions.
- 4 (the default list's top): the hardest problems.

Independent tasks belong in one call: they run in parallel. Claude Code, Codex and Antigravity run separate `delegate` calls one at a time.

## Pinning a model (rare)

Normal use is `tier` only. `model` (`model@effort`, such as `gemini-4-neon@high`) is an optional manual override: pin one only when the task needs that exact model, because a pin shuts out every other subscription. schmear still picks the account; `no_quota` then means no account offering that model has quota. An OpenCode Go model is pinned by its full name, such as `opencode-go/grok-4.7@medium`.

## Use the results

Each result has a `status`, the `provider`, `account` (which of your logins for that provider, such as `default` or `work`) and `model` that ran it, a `session`, `notes` (reroutes, declined permission requests), and the worker's reply.

- `done`: the reply is the worker's claim, not proof. Check the diff or run the verification command before you tell the user it worked. Claude and Antigravity workers ask before editing by default, and a request nobody answers is declined while the worker carries on, so `done` can mean nothing was written.
- `failed`: read `error`, or `notes` when there is no `error` (a worker that hit its token or turn limit says so there). Retry once with a clearer prompt if the prompt was the problem; otherwise do the task yourself.
- `no_quota`: no subscription has quota left for that tier. Do the task yourself. For a task sent with `session`, it means that session's account is out: resend without `session` to let schmear route it elsewhere (the new worker starts without that context).
- `cancelled`: the worker stopped early. Its directory may hold partial edits; inspect them before running the task again.

To follow up with the same worker, which keeps its context, call `delegate` again with that result's `session`, the same `cwd`, a tier no higher than it ran at, and a new prompt. Each session can be resumed by only one task per call.

If this skill is loaded but no `delegate` tool is available, schmear is not connected to this agent: tell the user to run `schmear init --yes` and restart the agent.
