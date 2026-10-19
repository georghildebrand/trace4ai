# Decision Trace v0.5.1b — Pi Extension

Hierarchical activity aggregation for Pi's decision tracing. Groups raw tool events by **decision → activities → raw events** with a responsive TUI overlay showing intention, changes, and outcomes.

## Features

- **Decision‑level timeline** — all operations grouped under their explicit decision, regardless of tool type or temporal adjacency
- **Intention visible** — the rationale you provide to `trace_decision` is shown in the timeline and drill‑down views
- **Activity drill‑down** — within a decision, events grouped by `file_op`, `test`, `git`, `exec`, etc.
- **See actual changes** — press Enter on any event to see its full command and output; press `v` in the event list for an inline preview
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

---

## TUI Walkthrough

### 1. Timeline — decision level

```
╭──────────────────────────────╮
│       Decisions              │
├──────────────────────────────┤
│   🔷 Refactor parser          │
│      The parser is hard to    │
│      2 file(s) · 3 op(s)     │
│      [EDIT, TEST, GIT]        │
│   🔷 Add CLI flags            │
│      1 file(s) · 1 op(s)     │
│      [EDIT]                   │
├──────────────────────────────┤
│  ↑↓=Nav Enter=Open           │
│  c=Comment r=Review f=Filter │
│  Esc=Close                    │
╰──────────────────────────────╯
```

Each decision shows:
- **Title** from your `trace_decision` call
- **Rationale** (dimmed, first 60 chars) — the intention you recorded
- **Stats** — deduplicated file count and operation count
- **Badges** — activity types within: `EDIT`, `TEST`, `GIT`, `EXEC`
- **⚠** — decisions with pending review requests

**Keys:** `↑↓` select · `Enter` open · `c` comment · `r` request review · `f` filter · `Esc` close

---

### 2. Decision Detail — activities within a decision

Press Enter on a decision:

```
╭──────────────────────────────╮
│ 📋 Refactor parser            │
├──────────────────────────────┤
│  The parser is hard to        │
│  maintain, split into         │
│  tokenizer and compiler       │
│  parser.ts, tokenizer.ts      │
│  2 file(s) · 3 op(s)         │
├──────────────────────────────┤
│  📄 2 file(s): parser.ts,..  │
│     parser.ts                │
│  📦 Git: init, commit        │
│  🧪 Tests passed              │
├──────────────────────────────┤
│  ↑↓=Nav Enter=Detail         │
│  Esc=Back c=Comment r=Review │
╰──────────────────────────────╯
```

Shows:
- **Full rationale** (the `trace_decision` `rationale` field)
- **Affected files** and **operation count**
- **Activity groups** — expand each to see individual events

---

### 3. Sub-timeline — raw events

Press Enter on an activity (e.g. the file_op group):

```
╭──────────────────────────────╮
│ 📋 2 file(s): parser.ts,...  │
├──────────────────────────────┤
│▶ 10:01 ✏️  EDIT: parser.ts   │
│     │ --- a/parser.ts        │ ← inline preview (v)
│     │ +++ b/parser.ts        │
│     │ @@ -1,5 +1,7 @@       │
│  10:02 ✏️  EDIT: tokenizer.ts│
├──────────────────────────────┤
│  ↑↓=Nav Enter=Detail         │
│  v=Preview Esc=Back          │
╰──────────────────────────────╯
```

- **`v`** — toggle inline preview of the selected event's command/output (shown with `│` prefix)
- **Enter** — go to full event detail

---

### 4. Event Detail — see the change

Press Enter on an event:

```
╭──────────────────────────────╮
│       Event Detail           │
├──────────────────────────────┤
│  ✏️ EDIT: parser.ts           │
├──────────────────────────────┤
│  ID:     evt_abc123          │
│  Time:  10:01:00             │
│  Cat:   file_modify          │
│  Tool:  edit                 │
│  Files:                      │
│    parser.ts                 │
│                              │
│  Command:                    │
│   │--- a/parser.ts           │
│   │+++ b/parser.ts           │
│   │@@ -1,5 +1,7 @@          │
│   │ const tokenize = ...     │
│   │+  const tokens = [];     │
│   │ ...                      │
│                              │
│  Output:                     │
│   │Successfully replaced 1   │
│   │block(s) in               │
│   │/home/.../parser.ts       │
├──────────────────────────────┤
│          Esc=Back            │
╰──────────────────────────────╯
```

Shows:
- **Command** — the full edit command or bash invocation (up to 1000 chars, split over multiple lines with `│` prefix, capped at 8 lines)
- **Output** — the result output (up to 2000 chars, capped at 6 lines)
- **Metadata** — ID, category, tool name, exit code, outcome, decision link

---

### 5. Comment & Review

Press **`c`** from any decision view to add a comment:

```
╭──────────────────────────────╮
│        Comment               │
├──────────────────────────────┤
│  On: Refactor parser         │
│                              │
│  : nice approach, but we    │
│    should also handle... ▮   │
├──────────────────────────────┤
│    Enter=Save Esc=Cancel     │
╰──────────────────────────────╯
```

Press **`r`** from any decision view to flag it for review. The next agent session will be notified:

```
=== UNRESOLVED REVIEW REQUESTS ===
1 decision(s) have pending feedback:
  Decision: Refactor parser (dec_abc123)
  - "nice approach, but we should also handle edge cases"
=== END REVIEW REQUESTS ===
```

---

### 6. Filter

Press **`f`** to filter the timeline:

```
╭──────────────────────────────╮
│        Filter                │
├──────────────────────────────┤
│  ● All activities            │
│  ○ Decisions only            │
│  ○ Reviews & comments        │
├──────────────────────────────┤
│  a/d/r=Sel Enter=Apply       │
│  Esc=Cancel                  │
╰──────────────────────────────╯
```

- **`a`** — all events
- **`d`** — decisions only
- **`r`** — reviews and comments

---

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

### Key functions

| Function | Purpose |
|---|---|
| `groupEventsByDecision()` | Groups ALL events under their associated decision ID; puts orphan events in `"Unassigned"` |
| `eventFamily()` | Maps a single event's category to an aggregate family (`file_op`, `test`, `git`, `exec`, ...) |
| `summarizeActivity()` | Builds a human-readable title for an activity group |
| `classifyActivity()` | Classifies a tool call into an activity category (from v0.4) |
| `classifyOutcome()` | Classifies a tool result into an outcome (passed/failed/completed) |

## Files

- `decision-trace.ts` — single‑file extension (~1900 lines)
- `README.md` — this file

## Version History

| Version | Highlights |
|---|---|
| v0.4 | Semantic timeline classifiers |
| v0.4.1 | Context‑aware outcome, `cd` prefix fix, compound command parsing |
| v0.5 | Interactive TUI overlay (`/trace ui`) |
| v0.5.1a | Width‑safe rendering, flat activity aggregation |
| **v0.5.1b** | **Hierarchical decision → activities → events, intention/rationale display, file change preview** |

## License

MIT