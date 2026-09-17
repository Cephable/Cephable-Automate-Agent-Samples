# Contributing

New samples and fixes are welcome.

## The bar for a sample

A sample here is a **demo you can put in front of a customer**, not a snippet. It has to:

1. **Run from a clean clone with one command**, after a documented prerequisite step. If it needs five
   things set up first, those five things belong in a script.
2. **Do something a prospect would recognise as useful.** Not "echoes your prompt" — a real task with
   real data, where you can see why an agent helps.
3. **Discover the endpoint.** Never hardcode `4317`; Cephable moves ports. Copy the sweep from any
   existing sample.
4. **Handle the three things that always go wrong**: `409` (one inference slot, shared with the user's
   own panel), a failed run (`HTTP 500` with `schemaVersion: 1` — check the field, not the status), and
   a run that outlives your client (cancel it, or it holds the slot).
5. **Read the key from the environment.** Never committed, never on a command line, never in a browser
   bundle.
6. **Run against [tools/fake-cephable](tools/fake-cephable)**, so it can be developed and CI-tested
   without a licence. Add a `--script` there if your sample's tools differ from the existing ones.
7. **Be honest in its README** about what it does not do. Every sample here has a "what this does not
   do" section, and they are the most useful paragraphs in the repo.

## README shape

Match the existing ones:

- **What this shows** — bullets, specific
- **Prerequisites** and **Run it** — copy-pasteable
- **Demo script** — numbered, with what to *say*, and what to have ready
- **How it works** — a diagram, a file table, and "N things worth copying"
- **What this does not do** — scope, honestly
- **Troubleshooting** — a table of the real failures

## Code conventions

**Comment the why, not the what.** The code says what it does. A comment earns its place when the
reason is non-obvious — a workaround, an ordering constraint, a rejected alternative, a subtlety someone
would otherwise "fix" back into a bug. Look at `policy.ts` in the gateway sample for the tone.

**Per-language:**

| | |
|---|---|
| Python | 3.10+, standard library where possible. A sample with no dependencies is worth more than a tidy one with five. |
| TypeScript | Strict mode, `npm run typecheck` clean. Node samples run via `--experimental-strip-types`, which **cannot** desugar TypeScript parameter properties — write constructor fields out longhand. |
| C# | Nullable enabled, `dotnet build` with zero warnings. |

**Tests where there is logic worth protecting.** The gateway's policy has 29 tests because each one is a
refusal that must not silently regress. A sample that is mostly wiring does not need that.

**Verify before you claim.** Every API shape in this repo was checked against the real thing — the
Windows AI signatures against the SDK's `.winmd`, the AI SDK's chunk types against its `.d.ts`, the run
contract against a running server. If you are unsure whether a field exists, go and look.

## Before you open a PR

```bash
# python-langchain-tools
python -m unittest test_sample -v

# public-gateway
npm run typecheck && npm test

# nextjs-vercel-ai-ui
npm run build

# winui-windows-ai-agent
dotnet build -c Debug -r win-x64
```

Then run your sample against the fake server end to end, and say in the PR what you verified and what
you did not. "Builds, and I ran it against the fake but not against real Cephable" is a useful thing to
know; silence is not.

## Reporting a problem

Tell us which sample, what you ran, and paste `/health`:

```bash
curl -sS http://127.0.0.1:4317/health -H "Authorization: Bearer $CEPHABLE_AUTOMATE_KEY"
```

It contains no secrets and answers most of the follow-up questions — app version, platform, model,
whether GPU acceleration fell back to CPU, and whether something else was already running.
