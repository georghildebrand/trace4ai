# Decision Trace v0.5.1b — Pi Extension

Hierarchical activity aggregation for Pi's decision tracing. Groups raw tool events by **decision → activities → raw events**, with a responsive TUI overlay.

## Features

- **Decision‑level timeline** — all operations grouped under their explicit decision, regardless of tool type or temporal adjacency
- **Activity drill‑down** — within a decision, events grouped by `file_op`, `test`, `git`, `exec`, etc.
- **Raw event access** — expand any activity to see every underlying tool call + result
- **Review & comment** — request review or add comments from any level
- **Narrow‑terminal safe** — 40–80 column support with `truncateToWidth`, Unicode/emoji width handling
- **Append‑only JSONL** — never mutates historical events
- **Deterministic** — no LLM, no observer agent

## Install

1. **Back up your existing extension** (if any):

   ```bash
   cp ~/.pi/agent/extensions/decision-trace.ts ~/decision-trace.ts.backup
   ```

2. **Copy the extension into Pi's agent directory:**

   ```bash
   cp decision-trace.ts ~/.pi/agent/extensions/decision-trace.ts
   ```

3. **Reload Pi** in your Termux session:

   ```
   /reload
   ```

4. **Verify the extension loaded** (you should see a notification):

   ```bash
   /trace help
   /trace timeline
   ```

## Usage

| Command | Description |
|---|---|
| `/trace ui` | Open interactive TUI overlay (keyboard driven) |
| `/trace timeline` | Plain‑text timeline of last 20 events |
| `/trace detail <id>` | Show full event detail |
| `/trace comment <id> <text>` | Add a comment to a decision |
| `/trace invalidate <id>` | Mark a decision invalidated |
| `/trace strict on/off` | Toggle strict file‑permission mode |
| `/trace help` | Show command list |

### TUI Navigation

```
Timeline (decisions)
  ├─ Enter → Decision Detail (activities)
  │    ├─ Enter → Sub‑timeline (raw events)
  │    │    └─ Enter → Event Detail
  │    └─ Esc   → back to Timeline
  └─ Esc → close overlay
```

**Keys:** `↑↓` navigate · `Enter` open · `c` comment · `r` request review · `f` filter · `Esc` back/close

## Architecture

```
EventStore (JSONL) ──→ groupEventsByDecision() ──→ DecisionGroup[]
                                                        │
                                           DecisionGroup.activities[]
                                                        │
                                              AggregatedActivity.events[]
                                                        │
                                                TraceEvent (raw)
```

All aggregation is a **derived projection** — the append‑only JSONL history is never modified.

## Files

- `decision-trace.ts` — single‑file extension (1834 lines)
- `README.md` — this file

## Version History

| Version | Highlights |
|---|---|
| v0.4 | Semantic timeline classifiers |
| v0.4.1 | Context‑aware outcome, `cd` prefix fix, compound command parsing |
| v0.5 | Interactive TUI overlay (`/trace ui`) |
| v0.5.1a | Width‑safe rendering, flat activity aggregation |
| **v0.5.1b** | **Hierarchical decision → activities → events** |

## License

MIT