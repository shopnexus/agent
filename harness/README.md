# Harness demo (standalone)

A minimal, self-contained example of **AgentCore Harness** — separate from the
main Strands app. It shows the other way to run an agent: **AWS runs the loop**,
you just call `InvokeHarness` and handle client-side tools.

## App (Strands) vs this (Harness)

| | Main app (`../src`) | This demo |
|---|---|---|
| Who runs the loop | your process (Strands) | AWS (Harness) |
| You call | `agent.invoke/stream` locally | `InvokeHarness` (AWS SDK) |
| Tools | local `tool()` objects | inline JSON schema; AWS calls back to you |
| Custom mid-loop logic | yes (output-cap, grounding, ...) | no — you only configure + handle tools |

## How it works

1. `InvokeHarness(harnessArn, runtimeSessionId, messages, tools)` — AWS runs the
   reason→tool loop and **streams** events back.
2. When the model calls an `inline_function` tool, the stream carries a
   `tool_use` (name + accumulated JSON input); the loop **pauses**.
3. This demo executes the tool **locally** (`LOCAL_TOOLS`) and calls
   `InvokeHarness` again with the same `runtimeSessionId`, sending a `toolResult`
   content block. The Harness continues until it answers.

Two example client-side tools are included: `add` and `get_current_time`.

## Run

```bash
# Needs a harness resource in YOUR account (created in the console / CreateHarness)
# with a model + system prompt configured.
HARNESS_ARN=arn:aws:bedrock-agentcore:ap-southeast-1:<acct>:harness/<id> \
AWS_REGION=ap-southeast-1 \
npx ts-node --transpile-only harness/harness-demo.ts "what is 21 + 21, and the time?"
```

Or via npm: `HARNESS_ARN=... npm run harness -- "your question"`.

## Notes / caveats

- Reuses the root project's dependencies (`@aws-sdk/client-bedrock-agentcore`);
  no separate `npm install`.
- The `InvokeHarness` request uses one `as any` cast — the Harness request
  unions are broad; field shapes follow the AWS API reference.
- The tool-resume path (sending `toolResult` back on the same session) follows
  the standard tool-use pattern; **not yet validated end-to-end against a live
  harness** — you need a harness resource in your account to try it.
