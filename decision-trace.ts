/**
 * Decision Trace v0.5.1 – Responsive UI + Activity Aggregation
 *
 * Transforms raw tool events into human-readable activities with
 * separate activity (call) and outcome (result) classification.
 *
 * Architecture:
 *  - ActivityClassifier: command/tool → activity (FILE, TEST, GIT, EXEC)
 *  - OutcomeClassifier: result + activity context → outcome (passed/failed/completed)
 *  - ActivityAggregator: groups related events into aggregated activities
 *  - EventStore: append-only JSONL with correlation IDs
 *  - Interactive timeline with drill-down
 *
 * Preserves legacy JSONL format and adds semantic fields.
 */

import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

import {
  mkdirSync,
  appendFileSync,
  readFileSync,
  existsSync,
} from "node:fs";

import { join, resolve, relative } from "node:path";
import { matchesKey, visibleWidth, CURSOR_MARKER, truncateToWidth } from "@earendil-works/pi-tui";

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export type ActivityCategory =
  | "decision"
  | "file_create"
  | "file_modify"
  | "file_read"
  | "test_exec"
  | "git_init"
  | "git_add"
  | "git_commit"
  | "git_config"
  | "git_status"
  | "git_other"
  | "exec"
  | "compound"
  | "blocked"
  | "comment"
  | "invalidate"
  | "review"
  | "unknown";

export type Outcome = "passed" | "failed" | "completed" | "error";

/** An aggregated activity grouping related events in the timeline. */
export interface AggregatedActivity {
  type: "file_op" | "test" | "git" | "exec" | "comment" | "review" | "other" | "unassigned";
  title: string;
  summary: string;
  events: TraceEvent[];
  decisionId?: string;
  count: number;
  files?: string[];
  outcome?: Outcome;
  timestamp: string;
  needsReview?: boolean;
}

/** Top-level grouping by decision or work objective. */
export interface DecisionGroup {
  /** Decision ID (empty string for unassigned events) */
  id: string;
  title: string;
  timestamp: string;
  needsReview: boolean;
  /** Deduplicated file paths */
  files: string[];
  /** Unique tool operation count (unique toolCallIds) */
  opCount: number;
  /** File change count (edits + creates) */
  fileChangeCount: number;
  /** Activities within this decision */
  activities: AggregatedActivity[];
}

export type ReviewStatus = "none" | "pending" | "acknowledged" | "resolved";

export interface TraceEvent {
  /** Stable event ID (timestamp-random) */
  id: string;
  /** ISO timestamp */
  at: string;
  /** Semantic activity category */
  category: ActivityCategory;
  /** Outcome (only set on tool-result events) */
  outcome?: Outcome;
  /** One-line summary */
  title: string;
  /** Optional command or detail text (trimmed) */
  detail?: string;
  /** Exit code for bash commands */
  exitCode?: number;
  /** Whether the operation errored */
  isError?: boolean;
  /** Original tool name for traceability */
  toolName?: string;
  /** toolCallId for correlating call↔result */
  toolCallId?: string;
  /** Linked decision ID */
  decision?: string;
  /** Affected file paths */
  files?: string[];
  /** IDs of events this depends on */
  depends_on?: string[];
  /** Review status (for decisions with comments) */
  reviewStatus?: ReviewStatus;
  /** Whether this event has unresolved comments requiring review */
  needsReview?: boolean;
  /** Raw command text for detail view */
  rawCommand?: string;
  /** Raw output summary for detail view */
  rawOutput?: string;
  /** Whether this is an inferred (Observer) interpretation */
  inferred?: boolean;
}

interface CorrelatedCall {
  toolCallId: string;
  toolName: string;
  category: ActivityCategory;
  title: string;
  detail?: string;
  files?: string[];
  rawCommand?: string;
  decision?: string;
  /** Git subcommands found in a compound command */
  gitOps?: string[];
}

// ────────────────────────────────────────────────────────────
// Activity & Outcome Classifiers
// ────────────────────────────────────────────────────────────

const GIT_COMMANDS: Record<string, ActivityCategory> = {
  init: "git_init",
  add: "git_add",
  commit: "git_commit",
  config: "git_config",
  status: "git_status",
};

const GIT_LABELS: Record<string, string> = {
  init: "Initializing repository",
  add: "Staging files",
  commit: "Committing changes",
  config: "Configuring repository",
  status: "Checking status",
};

/**
 * Split a shell command into &&-delimited segments, respecting quotes.
 */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }

    if (!inSingle && !inDouble && ch === "&" && command[i + 1] === "&") {
      segments.push(current.trim());
      current = "";
      i++; // skip next &
      continue;
    }

    current += ch;
  }

  const last = current.trim();
  if (last) segments.push(last);
  return segments;
}

/**
 * Strip shell prefixes like "cd <dir> &&" to get the meaningful command.
 */
function stripCdPrefix(command: string): string {
  let cmd = command.trim();
  // Remove leading cd <path> && (path may contain spaces, quotes, etc.)
  cmd = cmd.replace(/^cd\s+\S[^&&]*&&\s*/, "");
  return cmd.trim();
}

/**
 * Find all git subcommands in a list of command segments.
 */
function findGitOps(segments: string[]): string[] {
  return segments
    .map((s) => s.match(/^git\s+(\S+)/)?.[1])
    .filter((x): x is string => !!x);
}

/**
 * Determine if a command is a test execution.
 * Checks for explicit test runners and test-file patterns.
 * Does NOT use generic keyword fallbacks (no \btest\b, no isolated keyword search).
 */
function isTestExecution(segments: string[]): boolean {
  for (const seg of segments) {
    const s = seg.trim();

    // Explicit test runners (with or without arguments)
    if (/^(npx\s+)?(vitest|jest|mocha|ava|tape|pytest)(?:\s|$)/.test(s)) return true;
    if (/^npm\s+(test|run\s+test[\w:-]*)(?:\s|$)/.test(s)) return true;

    // Running a file whose name follows test-file conventions
    const fileRun = s.match(/^(npx\s+)?(tsx|node|bun|deno|python3?)\s+(\S+)/);
    if (fileRun) {
      const file = fileRun[3];
      // Matches: test.ts, spec.js, foo.test.ts, bar.spec.tsx
      if (/\.(test|spec)\./i.test(file)) return true;
      if (/^(test|spec)\.\w+$/i.test(file)) return true;
    }
  }
  return false;
}

/**
 * Extract file path from a write/edit tool call input.
 */
function getFilePath(input: any): string | undefined {
  if (typeof input?.path === "string") return input.path;
  if (typeof input?.file === "string") return input.file;
  return undefined;
}

/**
 * Classify a tool call into an ActivityCategory.
 *
 * Deterministic, no keyword-based fallbacks, handles:
 *   cd <dir> && <command>
 *   <cmd> && <cmd> && ... (compound)
 *   quoted arguments
 */
function classifyActivity(
  toolName: string,
  input: any,
): { category: ActivityCategory; title: string; detail?: string; files?: string[]; gitOps?: string[] } {
  // ── File tools ──
  if (toolName === "write" || toolName === "edit") {
    const path = getFilePath(input);
    const label = toolName === "write" ? "Created" : "Modified";
    const title = path ? `${label} ${path}` : `${label} file`;
    return {
      category: toolName === "write" ? "file_create" : "file_modify",
      title,
      detail: path || undefined,
      files: path ? [path] : [],
    };
  }

  if (toolName === "read") {
    const path = getFilePath(input);
    return {
      category: "file_read",
      title: path ? `Read ${path}` : "Read file",
      files: path ? [path] : [],
    };
  }

  // ── Bash commands ──
  if (toolName === "bash") {
    const command = (input?.command as string) || "";
    const segments = splitSegments(stripCdPrefix(command));
    const gitOps = findGitOps(segments);

    // Git commands
    if (gitOps.length === 1) {
      const sub = gitOps[0];
      const cat = GIT_COMMANDS[sub] || "git_other";
      const label = GIT_LABELS[sub] || sub;
      return {
        category: cat,
        title: `GIT: ${label}`,
        detail: command.slice(0, 200),
      };
    }

    // Compound git (multiple git operations in one command)
    if (gitOps.length > 1) {
      return {
        category: "compound",
        title: `GIT: ${gitOps.length} operations (${gitOps.join(", ")})`,
        detail: command.slice(0, 200),
        gitOps,
      };
    }

    // Test execution
    if (isTestExecution(segments)) {
      return {
        category: "test_exec",
        title: "TEST: " + segments[0]?.slice(0, 80) || command.slice(0, 80),
        detail: command.slice(0, 200),
      };
    }

    // Generic execution
    return {
      category: "exec",
      title: "EXEC: " + (segments[0] || command).slice(0, 80),
      detail: command.slice(0, 200),
    };
  }

  // ── Custom tools (trace_decision etc.) – not manually classified ──
  return {
    category: "exec",
    title: `${toolName} called`,
  };
}

/**
 * Classify a tool result outcome.
 *
 * Uses the *activity category* from the corresponding call to decide
 * what patterns to look for. Test-result parsing only runs when the
 * activity was classified as "test_exec".
 */
function classifyOutcome(
  toolName: string,
  isError: boolean,
  content: any[],
  details: any,
  activityCategory: ActivityCategory,
): { outcome: Outcome; title: string; exitCode?: number; isError: boolean; testSummary?: string } {
  if (toolName === "bash") {
    const exitCode = details?.exitCode ?? (isError ? 1 : 0);

    // Only parse test results when the activity was identified as a test
    if (activityCategory === "test_exec") {
      const textContent = content
        ?.map((c: any) => (c?.type === "text" ? c.text : ""))
        .join("\n") || "";

      const passMatch = textContent.match(/(\d+)\s*\/\s*(\d+)\s+tests?\s+passed/i);
      const allPassed = textContent.includes("Tests passed") && !textContent.includes("FAIL");

      if (passMatch && passMatch[1] === passMatch[2]) {
        return {
          outcome: "passed",
          title: `PASS: ${passMatch[0].trim()}`,
          exitCode,
          isError: false,
          testSummary: passMatch[0].trim(),
        };
      }

      if (passMatch && passMatch[1] !== passMatch[2]) {
        return {
          outcome: "failed",
          title: `FAIL: ${passMatch[0].trim()}`,
          exitCode: exitCode || 1,
          isError: true,
          testSummary: passMatch[0].trim(),
        };
      }

      if (allPassed) {
        return {
          outcome: "passed",
          title: "PASS: All tests passed",
          exitCode: 0,
          isError: false,
          testSummary: "All tests passed",
        };
      }
    }

    // Generic bash outcome (no test-parsing for non-test activities)
    if (isError || exitCode !== 0) {
      return { outcome: "error", title: "Command failed", exitCode, isError: true };
    }

    return { outcome: "completed", title: "Command completed", exitCode: 0, isError: false };
  }

  if (toolName === "write" || toolName === "edit") {
    return {
      outcome: isError ? "error" : "completed",
      title: isError ? "Write failed" : "Write completed",
      isError,
    };
  }

  return {
    outcome: isError ? "error" : "completed",
    title: isError ? "Error" : "Completed",
    isError,
  };
}

// ────────────────────────────────────────────────────────────
// Event Store (append-only JSONL)
// ────────────────────────────────────────────────────────────

class EventStore {
  private root: string;
  private events: TraceEvent[] = [];

  constructor(root: string) {
    this.root = root;
  }

  private location(): string {
    return join(this.root, ".pi", "decision-trace", "events.jsonl");
  }

  private dir(): string {
    return join(this.root, ".pi", "decision-trace");
  }

  generateId(): string {
    return (
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 7)
    );
  }

  load(): void {
    this.events = [];
    const loc = this.location();
    if (!existsSync(loc)) return;

    for (const line of readFileSync(loc, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        this.events.push(JSON.parse(line));
      } catch {
        /* skip malformed */
      }
    }
  }

  record(data: Omit<TraceEvent, "id" | "at">): TraceEvent {
    const event: TraceEvent = {
      id: this.generateId(),
      at: new Date().toISOString(),
      ...data,
    };

    mkdirSync(this.dir(), { recursive: true });
    appendFileSync(this.location(), JSON.stringify(event) + "\n");
    this.events.push(event);
    return event;
  }

  getAll(): readonly TraceEvent[] {
    return this.events;
  }

  getLast(n: number): TraceEvent[] {
    return this.events.slice(-n);
  }

  getById(id: string): TraceEvent | undefined {
    return this.events.find((e) => e.id === id);
  }

  /** Find the most recent active (non-invalidated) decision. */
  getActiveDecision(): TraceEvent | undefined {
    const decisions = this.events.filter((e) => e.category === "decision");
    for (let i = decisions.length - 1; i >= 0; i--) {
      const d = decisions[i];
      const invalidated = this.events.some(
        (e) => e.category === "invalidate" && e.decision === d.id,
      );
      if (!invalidated) return d;
    }
    return undefined;
  }

  /** Find events dependent on a given decision ID. */
  getDependents(decisionId: string): TraceEvent[] {
    const dependents: TraceEvent[] = [];
    const visited = new Set<string>();

    function walk(store: EventStore, parentId: string) {
      for (const e of store.events) {
        if (visited.has(e.id)) continue;
        if (e.decision === parentId || e.depends_on?.includes(parentId)) {
          visited.add(e.id);
          dependents.push(e);
          walk(store, e.id);
        }
      }
    }

    walk(this, decisionId);
    return dependents;
  }

  /** Get all unique files across events. */
  getFiles(): string[] {
    return [
      ...new Set(this.events.flatMap((e) => e.files || [])),
    ];
  }

  /** Add a comment and mark decision for review. */
  addComment(decisionId: string, text: string): TraceEvent | undefined {
    const decision = this.getById(decisionId);
    if (!decision) return undefined;

    // Record comment event
    const comment = this.record({
      category: "comment",
      title: "User comment",
      decision: decisionId,
      detail: text.slice(0, 1000),
    });

    // Mark the decision as needing review (update in-memory only; JSONL is append-only)
    decision.needsReview = true;
    decision.reviewStatus = "pending";

    // Also record a review marker event
    this.record({
      category: "review",
      title: `REVIEW: Decision "${decision.title}" has feedback`,
      decision: decisionId,
      detail: text.slice(0, 200),
      depends_on: [decisionId],
    });

    // Find dependent decisions and mark those too
    const dependents = this.getDependents(decisionId);
    for (const dep of dependents) {
      if (dep.category === "decision") {
        dep.needsReview = true;
        dep.reviewStatus = "pending";
      }
    }

    return comment;
  }

  /** Get all decisions with unresolved reviews. */
  getUnresolvedReviews(): TraceEvent[] {
    return this.events.filter(
      (e) =>
        e.category === "review" &&
        e.reviewStatus !== "resolved" &&
        e.reviewStatus !== "acknowledged",
    );
  }

  /** Get comments attached to a specific decision. */
  getComments(decisionId: string): TraceEvent[] {
    return this.events.filter(
      (e) => e.category === "comment" && e.decision === decisionId,
    );
  }

  /** Get the review chain for a decision (comments + review markers). */
  getReviewChain(decisionId: string): TraceEvent[] {
    return this.events.filter(
      (e) =>
        (e.category === "comment" || e.category === "review") &&
        e.decision === decisionId,
    );
  }

  /** Check if a decision has any unreviewed comments. */
  hasUnreviewedFeedback(decisionId: string): boolean {
    return this.events.some(
      (e) =>
        e.category === "review" &&
        e.decision === decisionId &&
        e.reviewStatus !== "resolved",
    );
  }
}

// ────────────────────────────────────────────────────────────
// Timeline Formatter
// ────────────────────────────────────────────────────────────

const CATEGORY_ICONS: Record<ActivityCategory, string> = {
  decision: "🔷",
  file_create: "📄",
  file_modify: "✏️",
  file_read: "👁️",
  test_exec: "🧪",
  git_init: "📦",
  git_add: "📦",
  git_commit: "📦",
  git_config: "📦",
  git_status: "📦",
  git_other: "📦",
  exec: "⚙️",
  compound: "🔗",
  blocked: "🚫",
  comment: "💬",
  invalidate: "🗑️",
  review: "🔍",
  unknown: "❓",
};

const OUTCOME_ICONS: Record<Outcome, string> = {
  passed: "✅",
  failed: "❌",
  completed: "✓",
  error: "⚠️",
};

const CATEGORY_LABELS: Record<ActivityCategory, string> = {
  decision: "DECISION",
  file_create: "FILE",
  file_modify: "FILE",
  file_read: "READ",
  test_exec: "TEST",
  git_init: "GIT",
  git_add: "GIT",
  git_commit: "COMMIT",
  git_config: "GIT",
  git_status: "GIT",
  git_other: "GIT",
  exec: "EXEC",
  compound: "COMPOUND",
  blocked: "BLOCKED",
  comment: "COMMENT",
  invalidate: "INVALIDATE",
  review: "REVIEW",
  unknown: "UNKNOWN",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatTimelineEntry(e: TraceEvent, showId?: boolean): string {
  // Outcome icon overrides activity icon when present
  const icon =
    e.outcome && OUTCOME_ICONS[e.outcome]
      ? OUTCOME_ICONS[e.outcome]
      : CATEGORY_ICONS[e.category] || "•";

  // Label: "TEST PASS", "FILE CREATE", "GIT COMPLETED", etc.
  const activityLabel = CATEGORY_LABELS[e.category] || e.category;
  const outcomeLabel = e.outcome ? e.outcome.toUpperCase() : "";
  const label = outcomeLabel ? `${activityLabel} ${outcomeLabel}` : activityLabel;

  const time = formatTime(e.at);
  const idStr = showId ? ` ${e.id}` : "";
  const inferredStr = e.inferred ? " [inf]" : "";
  return `  ${time} ${icon} ${label}${idStr} ${e.title}${inferredStr}`;
}

function formatDetailEntry(e: TraceEvent): string[] {
  const lines: string[] = [];
  const time = formatTime(e.at);
  const icon = CATEGORY_ICONS[e.category] || "•";
  const label = CATEGORY_LABELS[e.category] || e.category;

  lines.push(`── ${time} ${icon} ${label} ${e.title}`);
  lines.push(`   ID:       ${e.id}`);
  lines.push(`   Category: ${e.category}`);

  if (e.toolName) lines.push(`   Tool:     ${e.toolName}`);
  if (e.toolCallId) lines.push(`   Call ID:  ${e.toolCallId}`);
  if (e.decision) lines.push(`   Decision: ${e.decision}`);
  if (e.outcome) lines.push(`   Outcome:  ${e.outcome}`);
  if (e.exitCode !== undefined) lines.push(`   Exit:     ${e.exitCode}`);
  if (e.isError !== undefined) lines.push(`   Error:    ${e.isError}`);
  if (e.files?.length) lines.push(`   Files:    ${e.files.join(", ")}`);
  if (e.depends_on?.length) lines.push(`   Depends:  ${e.depends_on.join(", ")}`);
  if (e.inferred) lines.push(`   Note:     Inferred by Observer`);

  if (e.rawCommand) {
    lines.push(`   Command:`);
    for (const line of e.rawCommand.split("\n")) {
      lines.push(`     │ ${line}`);
    }
  }

  if (e.rawOutput) {
    lines.push(`   Output:`);
    const truncated = e.rawOutput.length > 500
      ? e.rawOutput.slice(0, 500) + "\n   … (truncated)"
      : e.rawOutput;
    for (const line of truncated.split("\n")) {
      lines.push(`     │ ${line}`);
    }
  }

  if (e.detail && !e.rawCommand) {
    lines.push(`   Detail:   ${e.detail}`);
  }

  return lines;
}

// ────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────
// Activity Aggregation (derived projection, no storage changes)
// ────────────────────────────────────────────────────────────

const FILE_OPS = new Set(["file_create", "file_modify", "file_read"]);
const GIT_OPS = new Set(["git_init", "git_add", "git_commit", "git_config", "git_status", "git_other", "compound"]);

/**
 * Map a single event to its aggregate type family.
 */
function eventFamily(e: TraceEvent): string {
  if (FILE_OPS.has(e.category)) return "file_op";
  if (e.category === "test_exec") return "test";
  if (GIT_OPS.has(e.category)) return "git";
  if (e.category === "comment") return "comment";
  if (e.category === "review") return "review";
  if (e.category === "decision") return "decision";
  return "exec";
}

/**
 * Build a summary title for an aggregated activity group.
 */
function summarizeActivity(type: string, events: TraceEvent[], count: number): string {
  const files = [...new Set(events.flatMap((e) => e.files || []).filter(Boolean))];
  if (type === "file_op") {
    const fileSummary = files.length <= 3
      ? files.join(", ")
      : files.slice(0, 2).join(", ") + " +" + (files.length - 2);
    return count + " file(s): " + fileSummary;
  }
  if (type === "test") {
    const result = events.find((e) => e.outcome === "passed" || e.outcome === "failed");
    if (result?.outcome === "passed") return "Tests passed";
    if (result?.outcome === "failed") return "Tests failed";
    return "Test execution (" + count + " step(s))";
  }
  if (type === "git") {
    const ops = events.map((e) => e.category.replace("git_", "")).filter(Boolean);
    const uniqueOps = [...new Set(ops)];
    return uniqueOps.length <= 2 ? uniqueOps.join(", ") : uniqueOps.length + " operations";
  }
  if (type === "comment") {
    const first = events[0];
    return "Comment" + (first?.detail ? ": " + first.detail.slice(0, 40) : "");
  }
  if (type === "review") {
    const first = events[0];
    return "Review: " + (first?.title || "").replace("REVIEW: ", "");
  }
  if (type === "decision") {
    return events[0]?.title || "Decision";
  }
  return count + " operation(s)";
}

/**
 * Group events by decision, then by activity family within each decision.
 * Returns hierarchical DecisionGroup[] for the top-level timeline.
 * Events without a decision go into an "unassigned" group.
 */
function groupEventsByDecision(events: TraceEvent[]): DecisionGroup[] {
  // Phase 1: collect all events per decision ID
  const byDecision = new Map<string, TraceEvent[]>();
  const unassigned: TraceEvent[] = [];

  for (const e of events) {
    if (e.decision && e.category !== "decision") {
      const arr = byDecision.get(e.decision);
      if (arr) arr.push(e);
      else byDecision.set(e.decision, [e]);
    } else if (e.category === "decision") {
      // Decision event keys its group
      const arr = byDecision.get(e.id);
      if (arr) arr.push(e);
      else byDecision.set(e.id, [e]);
    } else {
      unassigned.push(e);
    }
  }

  // Phase 2: for each decision, build inner activity groups
  const groups: DecisionGroup[] = [];

  function buildGroup(decId: string, decEv: TraceEvent | undefined, evs: TraceEvent[]): void {
    // Separate decision event from the rest
    const decisionEvent = decEv ? [decEv] : evs.filter((e) => e.category === "decision");
    const rest = evs.filter((e) => e.category !== "decision");

    // Group rest by activity family
    const byFamily = new Map<string, TraceEvent[]>();
    for (const e of rest) {
      const fam = eventFamily(e);
      const arr = byFamily.get(fam);
      if (arr) arr.push(e);
      else byFamily.set(fam, [e]);
    }

    // Build activity objects
    const activities: AggregatedActivity[] = [];
    for (const [fam, famEvents] of byFamily) {
      const typed = fam as AggregatedActivity["type"];
      const result = famEvents.find((ee) => ee.outcome);
      const files = [...new Set(famEvents.flatMap((ee) => ee.files || []).filter(Boolean))];
      // Count unique operations via toolCallId (avoid counting both call+result)
      const uniqueCallIds = new Set(famEvents.map((ee) => ee.toolCallId).filter(Boolean));
      const opCount = uniqueCallIds.size || famEvents.length;
      activities.push({
        type: typed,
        title: summarizeActivity(typed, famEvents, opCount),
        summary: summarizeActivity(typed, famEvents, opCount),
        events: [...famEvents],
        count: opCount,
        files: files.length > 0 ? files : undefined,
        outcome: result?.outcome as Outcome | undefined,
        timestamp: famEvents[0]?.at || "",
        needsReview: famEvents.some((ee) => ee.needsReview),
      });
    }

    // Sort activities by timestamp of first event
    activities.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    // Compute decision-level stats
    const allDecFiles = [...new Set(rest.flatMap((ee) => ee.files || []).filter(Boolean))];
    const fileChanges = rest.filter((ee) => ee.category === "file_create" || ee.category === "file_modify");
    const allUniqueCallIds = new Set(rest.map((ee) => ee.toolCallId).filter(Boolean));
    const totalOps = allUniqueCallIds.size || rest.length;
    const fileChangeDedup = [...new Set(fileChanges.flatMap((ee) => ee.files || []).filter(Boolean))];

    const title = decisionEvent.length > 0
      ? (decisionEvent[0]?.title || "Decision")
      : (decId || "Unassigned");

    groups.push({
      id: decId,
      title,
      timestamp: decisionEvent.length > 0 ? decisionEvent[0]?.at || "" : (evs[0]?.at || ""),
      needsReview: evs.some((ee) => ee.needsReview),
      files: allDecFiles,
      opCount: totalOps,
      fileChangeCount: fileChangeDedup.length,
      activities,
    });
  }

  // Process decisions with explicit mapping
  const processedDecIds = new Set<string>();
  for (const [decId, evs] of byDecision) {
    processedDecIds.add(decId);
    const decEvent = evs.find((e) => e.category === "decision" && e.id === decId);
    const rest = evs.filter((e) => !(e.category === "decision" && e.id === decId));
    // Include the decision event if it's the key
    const allEvs = decEvent ? [decEvent, ...rest] : rest;
    buildGroup(decId, decEvent, allEvs);
  }

  // Add unassigned group if there are events
  if (unassigned.length > 0) {
    buildGroup("", undefined, unassigned);
  }

  // Sort groups by timestamp (newest first)
  groups.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return groups;
}

// ────────────────────────────────────────────────────────────
// Trace UI Component (/trace ui)
// ────────────────────────────────────────────────────────────

type UIView = "timeline" | "decision_detail" | "detail" | "sub_timeline" | "comment_input" | "filter_prompt";

class TraceUIComponent {
  private store: EventStore;
  private theme: any;
  private done: (result: string | undefined) => void;
  private view: UIView = "timeline";
  private selectedIndex = 0;
  /** Decision-level groups for timeline */
  private decisionGroups: DecisionGroup[] = [];
  /** Activities within the selected decision */
  private decisionActivities: AggregatedActivity[] = [];
  private decisionTitle = "";
  /** Raw events within the selected activity (sub-timeline) */
  private subEvents: TraceEvent[] = [];
  private subActivity: AggregatedActivity | null = null;
  private detailEvent: TraceEvent | null = null;
  private filterText = "";
  private filterMode: "all" | "decision" | "review" = "all";
  private commentText = "";
  private commentCursor = 0;
  private statusMessage = "";
  private statusTimeout: ReturnType<typeof setTimeout> | null = null;
  /** View to restore after comment_input exits */
  private previousView: UIView = "timeline";
  focused = false;

  constructor(
    store: EventStore,
    theme: any,
    done: (result: string | undefined) => void,
  ) {
    this.store = store;
    this.theme = theme;
    this.done = done;
    this.refreshGroups();
  }

  invalidate(): void { /* no cache */ }

  // ── Core helpers ──

  private refreshGroups(): void {
    const all = [...this.store.getAll()];
    let filtered: TraceEvent[];
    if (this.filterMode === "decision") {
      filtered = all.filter((e) => e.category === "decision" || e.decision);
    } else if (this.filterMode === "review") {
      filtered = all.filter((e) => e.needsReview || e.category === "review" || e.category === "comment");
    } else {
      filtered = all;
    }
    this.decisionGroups = groupEventsByDecision(filtered.reverse());
    if (this.selectedIndex >= this.decisionGroups.length) {
      this.selectedIndex = Math.max(0, this.decisionGroups.length - 1);
    }
  }

  private refreshActivities(): void {
    this.refreshGroups();
  }

  private setStatus(msg: string): void {
    this.statusMessage = msg;
    if (this.statusTimeout) clearTimeout(this.statusTimeout);
    this.statusTimeout = setTimeout(() => { this.statusMessage = ""; }, 5000);
  }

  private timeStr(iso: string): string {
    if (!iso) return "";
    const d = new Date(iso);
    return String(d.getHours()).padStart(2, "0") + ":" +
           String(d.getMinutes()).padStart(2, "0") + ":" +
           String(d.getSeconds()).padStart(2, "0");
  }

  /**
   * Safely build a padded row inside the box.
   */
  private makeRow(th: any, innerW: number) {
    const border = (s: string) => th.fg("border", s);
    const row = (content: string) => {
      const stripped = content.replace(/\x1b\[[0-9;]*m/g, "");
      const vis = visibleWidth(stripped);
      if (vis <= innerW) {
        return border("│") + content + " ".repeat(innerW - vis) + border("│");
      }
      return border("│") + truncateToWidth(content, innerW) + border("│");
    };
    const title = (text: string) => {
      const s = " " + th.fg("accent", text) + " ";
      const vis = visibleWidth(s);
      return row(s + " ".repeat(Math.max(0, innerW - vis)));
    };
    const sep = () => row(th.fg("border", "─".repeat(innerW)));
    const empty = () => row("");
    const top = () => border("╭" + th.fg("border", "─".repeat(innerW)) + "╮");
    const bottom = () => {
      const cs = (this.selectedIndex + 1) + "/" + this.decisionGroups.length;
      const right = " " + cs + " ───";
      const availRight = innerW - visibleWidth(right);
      return border("╰" + truncateToWidth(
        th.fg("border", "─".repeat(Math.max(1, availRight)) + right), innerW
      ) + "╯");
    };
    return { border, row, title, sep, empty, top, bottom };
  }

  // ── Render ──

  render(width: number): string[] {
    const availW = Math.max(20, width);
    const innerW = Math.max(16, availW - 2);
    const th = this.theme;
    const r = this.makeRow(th, innerW);

    if (this.view === "timeline") return this.renderDecisionTimeline(th, innerW, r);
    if (this.view === "decision_detail") return this.renderDecisionDetail(th, innerW, r);
    if (this.view === "sub_timeline") return this.renderSubTimeline(th, innerW, r);
    if (this.view === "detail") return this.renderRawDetail(th, innerW, r);
    if (this.view === "comment_input") return this.renderCommentInput(th, innerW, r);
    if (this.view === "filter_prompt") return this.renderFilterPrompt(th, innerW, r);
    return [];
  }

  /** Top-level timeline: decision groups */
  private renderDecisionTimeline(th: any, innerW: number, r: any): string[] {
    const lines: string[] = [];
    lines.push(r.top());
    lines.push(r.title("Decisions"));
    lines.push(r.sep());

    const fl = this.filterMode === "all" ? "All" : this.filterMode === "decision" ? "Decisions" : "Reviews";
    lines.push(r.row(" " + th.fg("dim", fl)));
    lines.push(r.sep());

    if (this.decisionGroups.length === 0) {
      lines.push(r.row(" " + th.fg("dim", "(no decisions)")));
    } else {
      const maxRows = Math.min(this.decisionGroups.length, 10);
      const start = Math.max(0, this.selectedIndex - 5);
      const end = Math.min(this.decisionGroups.length, start + maxRows);

      for (let i = start; i < end; i++) {
        const g = this.decisionGroups[i];
        const sel = i === this.selectedIndex;
        const marker = sel ? th.fg("accent", "▶") : " ";

        // Icon: decision or unassigned
        const icon = g.id ? "🔷" : "📋";

        // Title line
        const titleW = innerW - 6;
        const titleLine = truncateToWidth(g.title || "(untitled)", titleW);
        const rm = g.needsReview ? th.fg("warning", "⚠") : "";
        const line1 = sel
          ? " " + marker + " " + th.fg("accent", icon + " " + titleLine) + " " + rm
          : "  " + icon + " " + th.fg("text", titleLine) + " " + rm;
        lines.push(r.row(truncateToWidth(line1, innerW)));

        // Stats line: files modified · operations
        if (g.fileChangeCount > 0 || g.opCount > 0) {
          const parts: string[] = [];
          if (g.fileChangeCount > 0) parts.push(g.fileChangeCount + " file(s) modified");
          if (g.opCount > 0) parts.push(g.opCount + " operation(s)");
          const statsStr = th.fg("dim", parts.join(" · "));
          const statsW = innerW - 4;
          lines.push(r.row("   " + truncateToWidth(statsStr, statsW)));
        }

        // Activity summary badges
        if (g.activities.length > 0) {
          const badges: string[] = [];
          for (const a of g.activities) {
            const label = a.type === "file_op" ? "EDIT" : a.type === "test" ? "TEST" : a.type === "git" ? "GIT" : a.type === "exec" ? "EXEC" : "";
            if (label) badges.push(label);
          }
          const b = badges.slice(0, 4).join(", ");
          if (b) {
            const badgeStr = th.fg("dim", "[" + b + "]");
            lines.push(r.row("   " + truncateToWidth(badgeStr, innerW - 4)));
          }
        }
      }
    }

    if (this.statusMessage) {
      lines.push(r.sep());
      lines.push(r.row(" " + th.fg("success", truncateToWidth(this.statusMessage, innerW - 2))));
    }

    lines.push(r.sep());
    const footer = truncateToWidth("↑↓=Nav Enter=Open c=Comment r=Review f=Filter Esc=Close", innerW);
    lines.push(r.row(" " + th.fg("dim", footer)));
    lines.push(r.bottom());
    if (this.focused) lines.push(CURSOR_MARKER);
    return lines;
  }

  /** Drill-down: activities within a decision */
  private renderDecisionDetail(th: any, innerW: number, r: any): string[] {
    const lines: string[] = [];
    lines.push(r.top());
    lines.push(r.title("📋 " + truncateToWidth(this.decisionTitle, innerW - 6)));
    lines.push(r.sep());

    // Decision stats
    const g = this.decisionGroups.length > 0 ? this.decisionGroups[this.selectedIndex] : null;
    if (g) {
      const parts: string[] = [];
      if (g.fileChangeCount > 0) parts.push(g.fileChangeCount + " file(s)");
      if (g.opCount > 0) parts.push(g.opCount + " op(s)");
      if (g.files && g.files.length > 0) {
        const f = truncateToWidth(g.files.slice(0, 2).join(", "), innerW - 6);
        lines.push(r.row(" " + th.fg("dim", f)));
      }
      lines.push(r.sep());
    }

    // Activities
    for (let i = 0; i < this.decisionActivities.length; i++) {
      const a = this.decisionActivities[i];
      const sel = i === this.selectedIndex;
      const marker = sel ? th.fg("accent", "▶") : " ";

      // Activity icon + title
      let icon = "•";
      let label = "";
      if (a.outcome === "passed") icon = "✅";
      else if (a.outcome === "failed") icon = "❌";
      else if (a.type === "file_op") icon = "📄";
      else if (a.type === "test") icon = "🧪";
      else if (a.type === "git") icon = "📦";
      else if (a.type === "exec") icon = "⚙️";
      else if (a.type === "comment") icon = "💬";

      const titleStr = truncateToWidth(a.title, innerW - 10);
      const badge = a.count > 1 ? " " + th.fg("dim", "(" + a.count + ")") : "";
      const line1 = sel
        ? " " + marker + " " + th.fg("accent", icon + " " + titleStr) + badge
        : "  " + icon + " " + th.fg("text", titleStr) + badge;
      lines.push(r.row(truncateToWidth(line1, innerW)));

      // Summary line for activities with files
      if (a.files && a.files.length > 0 && a.type === "file_op") {
        const fs = truncateToWidth(a.files.slice(0, 2).join(", "), innerW - 6);
        lines.push(r.row("   " + th.fg("dim", fs)));
      }
    }

    lines.push(r.sep());
    const footer = truncateToWidth("↑↓=Nav Enter=Detail Esc=Back c=Comment r=Review", innerW);
    lines.push(r.row(" " + th.fg("dim", footer)));
    lines.push(r.bottom());
    if (this.focused) lines.push(CURSOR_MARKER);
    return lines;
  }

  /** Individual raw events within an activity (sub-timeline) */
  private renderSubTimeline(th: any, innerW: number, r: any): string[] {
    const lines: string[] = [];
    lines.push(r.top());
    lines.push(r.title("📋 " + (this.subActivity ? truncateToWidth(this.subActivity.title, innerW - 6) : "Events")));
    lines.push(r.sep());

    for (let i = 0; i < this.subEvents.length; i++) {
      const e = this.subEvents[i];
      const sel = i === this.selectedIndex;
      const icon = this.activityIcon(e);
      const tp = this.timeStr(e.at);
      const tl = truncateToWidth(e.title, innerW - 16);
      const mk = sel ? th.fg("accent", "▶") : " ";
      const timeStr = th.fg("dim", tp);
      const line = sel
        ? " " + mk + " " + th.fg("accent", timeStr) + " " + icon + " " + th.fg("accent", tl)
        : "  " + timeStr + " " + icon + " " + th.fg("dim", tl);
      lines.push(r.row(truncateToWidth(line, innerW)));
    }

    lines.push(r.sep());
    lines.push(r.row(" " + th.fg("dim", "Enter=Detail Esc=Back")));
    lines.push(r.bottom());
    if (this.focused) lines.push(CURSOR_MARKER);
    return lines;
  }

  private activityIcon(e: TraceEvent): string {
    if (e.outcome === "passed") return "✅";
    if (e.outcome === "failed") return "❌";
    const icons: Record<string, string> = {
      decision: "🔷", file_create: "📄", file_modify: "✏️", file_read: "👁️",
      test_exec: "🧪", git_init: "📦", git_add: "📦", git_commit: "📦",
      git_config: "📦", git_status: "📦", git_other: "📦", exec: "⚙️",
      compound: "🔗", blocked: "🚫", comment: "💬", invalidate: "🗑️",
      review: "🔍", unknown: "❓",
    };
    return icons[e.category] || "•";
  }

  private renderRawDetail(th: any, innerW: number, r: any): string[] {
    const e = this.detailEvent;
    const lines: string[] = [];
    lines.push(r.top());
    lines.push(r.title("Event Detail"));
    lines.push(r.sep());
    if (!e) { lines.push(r.row(" " + th.fg("dim", "(no event)"))); }
    else {
      lines.push(r.row(" " + this.activityIcon(e) + " " + th.fg("accent", truncateToWidth(e.title, innerW - 6))));
      lines.push(r.empty());
      lines.push(r.row(" " + th.fg("dim", "ID:") + " " + e.id));
      lines.push(r.row(" " + th.fg("dim", "Time:") + " " + this.timeStr(e.at)));
      lines.push(r.row(" " + th.fg("dim", "Cat:") + "  " + e.category));
      if (e.outcome) lines.push(r.row(" " + th.fg("dim", "Res:") + "  " + e.outcome));
      if (e.toolName) lines.push(r.row(" " + th.fg("dim", "Tool:") + " " + e.toolName));
      if (e.decision) lines.push(r.row(" " + th.fg("dim", "Dec:") + "  " + truncateToWidth(e.decision, innerW - 12)));
      if (e.exitCode !== undefined) lines.push(r.row(" " + th.fg("dim", "Exit:") + " " + e.exitCode));
      if (e.needsReview) lines.push(r.row(" " + th.fg("warning", " ⚠ Review")));
      if (e.files && e.files.length > 0) {
        lines.push(r.empty());
        lines.push(r.row(" " + th.fg("dim", "Files:")));
        for (const f of e.files.slice(0, 4)) lines.push(r.row(" " + truncateToWidth(f, innerW - 3)));
      }
      if (e.detail) {
        lines.push(r.empty());
        lines.push(r.row(" " + th.fg("dim", "Info:")));
        lines.push(r.row(" " + truncateToWidth(e.detail, innerW - 2)));
      }
    }
    lines.push(r.sep());
    lines.push(r.row(" " + th.fg("dim", "Enter/Esc=Back")));
    lines.push(r.bottom());
    if (this.focused) lines.push(CURSOR_MARKER);
    return lines;
  }

  private renderCommentInput(th: any, innerW: number, r: any): string[] {
    const lines: string[] = [];
    const target = this.detailEvent;
    lines.push(r.top());
    lines.push(r.title("Comment"));
    lines.push(r.sep());
    if (target) {
      lines.push(r.row(" " + th.fg("dim", "On:") + " " + truncateToWidth(target.title, innerW - 10)));
      lines.push(r.empty());
    }
    const inputLabel = " " + th.fg("accent", ":") + " ";
    let display = this.commentText || th.fg("dim", "(type)");
    if (this.focused && this.commentText.length > 0) {
      const before = this.commentText.slice(0, this.commentCursor);
      const cc = this.commentCursor < this.commentText.length ? this.commentText[this.commentCursor] : " ";
      const after = this.commentText.slice(this.commentCursor + 1);
      display = before + CURSOR_MARKER + "\x1b[7m" + cc + "\x1b[27m" + after;
    }
    lines.push(r.row(inputLabel + truncateToWidth(display, innerW - 4)));
    lines.push(r.sep());
    lines.push(r.row(" " + th.fg("dim", "Enter=Save Esc=Cancel")));
    lines.push(r.bottom());
    if (this.focused) lines.push(CURSOR_MARKER);
    return lines;
  }

  private renderFilterPrompt(th: any, innerW: number, r: any): string[] {
    const lines: string[] = [];
    lines.push(r.top());
    lines.push(r.title("Filter"));
    lines.push(r.sep());
    const modes = [
      { key: "a", label: "All activities", value: "all" },
      { key: "d", label: "Decisions only", value: "decision" },
      { key: "r", label: "Reviews & comments", value: "review" },
    ];
    for (const m of modes) {
      const s = this.filterMode === m.value;
      const prefix = s ? th.fg("accent", " ● ") : " ○ ";
      const text = s ? th.fg("accent", m.label) : th.fg("text", m.label);
      lines.push(r.row(prefix + text));
    }
    lines.push(r.sep());
    lines.push(r.row(" " + th.fg("dim", "a/d/r=Sel Enter=Apply Esc=Cancel")));
    lines.push(r.bottom());
    return lines;
  }

  handleInput(data: string): void {
    if (this.view === "timeline") this.handleTimelineInput(data);
    else if (this.view === "decision_detail") this.handleDecisionDetailInput(data);
    else if (this.view === "sub_timeline") this.handleSubTimelineInput(data);
    else if (this.view === "detail") this.handleDetailInput(data);
    else if (this.view === "comment_input") this.handleCommentInput(data);
    else if (this.view === "filter_prompt") this.handleFilterInput(data);
  }

  /**
   * Find the decision ID associated with current context.
   */
  private currentDecisionId(): string | undefined {
    if (this.view === "timeline") {
      const g = this.decisionGroups[this.selectedIndex];
      return g?.id || undefined;
    }
    if (this.view === "decision_detail") {
      const g = this.decisionGroups.length > 0 ? this.decisionGroups[this.selectedIndex] : null;
      return g?.id || this.detailEvent?.decision || undefined;
    }
    if (this.view === "sub_timeline") {
      return this.subActivity?.decisionId || this.detailEvent?.decision || undefined;
    }
    if (this.view === "detail") {
      const e = this.detailEvent;
      return e?.decision || (e?.category === "decision" ? e.id : undefined);
    }
    return undefined;
  }

  // ── Timeline (decision-level) input ──
  private handleTimelineInput(data: string): void {
    if (matchesKey(data, "up")) { if (this.selectedIndex > 0) this.selectedIndex--; }
    else if (matchesKey(data, "down")) { if (this.selectedIndex < this.decisionGroups.length - 1) this.selectedIndex++; }
    else if (matchesKey(data, "return")) {
      const g = this.decisionGroups[this.selectedIndex];
      if (!g) return;
      this.decisionActivities = g.activities;
      this.decisionTitle = g.title;
      this.selectedIndex = 0;
      this.view = "decision_detail";
    }
    else if (matchesKey(data, "escape")) { this.done(undefined); }
    else if (data === "c" || data === "C") {
      const did = this.currentDecisionId();
      if (did) {
        this.detailEvent = this.store.getById(did) || null;
        this.commentText = ""; this.commentCursor = 0;
        this.previousView = this.view;
        this.view = "comment_input";
      }
    }
    else if (data === "r" || data === "R") {
      const g = this.decisionGroups[this.selectedIndex];
      if (!g || !g.id) return;
      const dec = this.store.getById(g.id);
      this.store.record({ category: "review", title: "REVIEW: " + g.title, decision: g.id });
      if (dec) dec.needsReview = true;
      this.setStatus("Review requested");
    }
    else if (data === "f" || data === "F") { this.view = "filter_prompt"; }
    else if (data === "g" || data === "G") { this.selectedIndex = 0; }
  }

  // ── Decision detail (activities within decision) input ──
  private handleDecisionDetailInput(data: string): void {
    if (matchesKey(data, "up")) { if (this.selectedIndex > 0) this.selectedIndex--; }
    else if (matchesKey(data, "down")) { if (this.selectedIndex < this.decisionActivities.length - 1) this.selectedIndex++; }
    else if (matchesKey(data, "return")) {
      const a = this.decisionActivities[this.selectedIndex];
      if (!a) return;
      if (a.events.length === 1) {
        this.detailEvent = a.events[0];
        this.view = "detail";
      } else {
        this.subActivity = a;
        this.subEvents = [...a.events];
        this.selectedIndex = 0;
        this.view = "sub_timeline";
      }
    }
    else if (matchesKey(data, "escape")) {
      this.view = "timeline";
      this.decisionActivities = [];
      this.decisionTitle = "";
      this.selectedIndex = 0;
      this.refreshGroups();
    }
    else if (data === "c" || data === "C") {
      const did = this.currentDecisionId();
      if (did) {
        this.detailEvent = this.store.getById(did) || null;
        this.commentText = ""; this.commentCursor = 0;
        this.previousView = this.view;
        this.view = "comment_input";
      }
    }
    else if (data === "r" || data === "R") {
      const matchingGroup = this.decisionGroups.find((dg) => dg.title === this.decisionTitle) ||
                           (this.decisionGroups.length > 0 ? this.decisionGroups[0] : null);
      if (matchingGroup && matchingGroup.id) {
        const dec = this.store.getById(matchingGroup.id);
        this.store.record({ category: "review", title: "REVIEW: " + this.decisionTitle, decision: matchingGroup.id });
        if (dec) dec.needsReview = true;
        this.setStatus("Review requested");
      }
    }
  }

  // ── Sub-timeline (events within activity) input ──
  private handleSubTimelineInput(data: string): void {
    if (matchesKey(data, "up")) { if (this.selectedIndex > 0) this.selectedIndex--; }
    else if (matchesKey(data, "down")) { if (this.selectedIndex < this.subEvents.length - 1) this.selectedIndex++; }
    else if (matchesKey(data, "return")) {
      const e = this.subEvents[this.selectedIndex];
      if (e) { this.detailEvent = e; this.view = "detail"; }
    }
    else if (matchesKey(data, "escape")) {
      this.view = "decision_detail";
      this.subActivity = null;
      this.subEvents = [];
      this.selectedIndex = 0;
    }
  }

  // ── Detail (single event) input ──
  private handleDetailInput(data: string): void {
    if (matchesKey(data, "return") || matchesKey(data, "escape")) {
      this.view = "sub_timeline";
      this.detailEvent = null;
    }
  }

  // ── Comment input ──
  private handleCommentInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.view = this.previousView;
      this.commentText = "";
      this.detailEvent = null;
      return;
    }
    if (matchesKey(data, "return")) {
      const did = this.currentDecisionId();
      if (did && this.commentText.trim()) {
        this.store.addComment(did, this.commentText.trim());
        this.setStatus("Comment saved");
      }
      this.commentText = ""; this.commentCursor = 0;
      this.view = this.previousView;
      this.detailEvent = null;
      this.refreshActivities();
      return;
    }
    if (matchesKey(data, "backspace")) {
      if (this.commentCursor > 0) {
        this.commentText = this.commentText.slice(0, this.commentCursor - 1) + this.commentText.slice(this.commentCursor);
        this.commentCursor--;
      }
    } else if (matchesKey(data, "left")) { this.commentCursor = Math.max(0, this.commentCursor - 1); }
    else if (matchesKey(data, "right")) { this.commentCursor = Math.min(this.commentText.length, this.commentCursor + 1); }
    else if (matchesKey(data, "home")) { this.commentCursor = 0; }
    else if (matchesKey(data, "end")) { this.commentCursor = this.commentText.length; }
    else if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.commentText = this.commentText.slice(0, this.commentCursor) + data + this.commentText.slice(this.commentCursor);
      this.commentCursor++;
    }
  }

  // ── Filter input ──
  private handleFilterInput(data: string): void {
    if (matchesKey(data, "escape")) { this.view = "timeline"; return; }
    if (matchesKey(data, "return")) { this.refreshActivities(); this.selectedIndex = 0; this.view = "timeline"; return; }
    if (data === "a" || data === "A") this.filterMode = "all";
    else if (data === "d" || data === "D") this.filterMode = "decision";
    else if (data === "r" || data === "R") this.filterMode = "review";
  }
}

export default function (pi: ExtensionAPI) {
  const store = new EventStore(process.cwd());
  let strict = false;

  /** Map of toolCallId → call info for correlating with results. */
  const pendingCalls = new Map<string, CorrelatedCall>();

  // ── Load existing events ──
  store.load();

  // ── Notify on start ──
  pi.on("session_start", async (_event, ctx) => {
    store.load();
    ctx.ui.notify("Decision Trace v0.4.1 loaded. /trace help", "info");
  });

  // ── Before agent start: remind to trace decisions + report reviews ──
  pi.on("before_agent_start", async () => {
    const reviews = store.getUnresolvedReviews();
    let reviewMsg = "";
    if (reviews.length > 0) {
      const uniqueDecisions = [...new Set(reviews.map((r) => r.decision || ""))].filter(Boolean);
      reviewMsg =
        "\n\n=== UNRESOLVED REVIEW REQUESTS ===\n" +
        `${uniqueDecisions.length} decision(s) have pending feedback:\n` +
        uniqueDecisions
          .map((did) => {
            const d = store.getById(did);
            const comments = store.getComments(did);
            const commentTexts = comments
              .map((c) => "  - \"" + (c.detail || "").slice(0, 200) + "\"")
              .join("\n");
            return (
              `  Decision: ${d?.title || did} (${did})` +
              (commentTexts ? "\n" + commentTexts : "")
            );
          })
          .join("\n\n") +
        "\n\nAcknowledge these comments and either adjust your approach or explain why the current approach is still correct. Do not silently mark feedback as resolved without addressing it.\n=== END REVIEW REQUESTS ===\n";
    }

    return {
      message:
        "Before substantial code changes, call " +
        "trace_decision. Document your intended " +
        "approach, rationale, affected files and " +
        "dependencies before implementation. " +
        "This is an explicit planning record, " +
        "not hidden chain-of-thought." +
        reviewMsg,
    };
  });

  // ── Register trace_decision tool ──
  pi.registerTool({
    name: "trace_decision",
    label: "Trace decision",
    description:
      "Record a decision BEFORE implementing it.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        rationale: { type: "string" },
        files: {
          type: "array",
          items: { type: "string" },
        },
        depends_on: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["title", "rationale", "files"],
    },

    async execute(_id, params: any) {
      const event = store.record({
        category: "decision",
        title: params.title,
        detail: params.rationale?.slice(0, 1000),
        files: params.files || [],
        depends_on: params.depends_on || [],
      });

      return {
        content: [
          {
            type: "text",
            text: "Decision recorded: " + event.id,
          },
        ],
        details: { id: event.id },
      };
    },
  } as any);

  // ── Tool call handler: classify and record ──
  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    const { toolName, input, toolCallId } = event;

    // Skip trace_decision – its dedicated execute handler already records the decision event
    if (toolName === "trace_decision") return;

    // Classify the activity (what is the tool doing?)
    const classified = classifyActivity(toolName, input);
    const activeDecision = store.getActiveDecision();

    const traceEvent = store.record({
      category: classified.category,
      title: classified.title,
      detail: classified.detail,
      files: classified.files,
      toolName,
      toolCallId,
      decision: activeDecision?.id,
      rawCommand: toolName === "bash"
        ? (input as any).command?.slice(0, 1000)
        : undefined,
    });

    // Store for correlation with result (includes activity info, not outcome)
    pendingCalls.set(toolCallId, {
      toolCallId,
      toolName,
      category: classified.category,
      title: classified.title,
      detail: classified.detail,
      files: classified.files,
      rawCommand: traceEvent.rawCommand,
      decision: activeDecision?.id,
      gitOps: classified.gitOps,
    });

    // Strict mode enforcement
    if (strict && (toolName === "write" || toolName === "edit")) {
      const path = getFilePath(input);
      const target = path ? resolve(ctx.cwd, path) : "";

      const active = store.getActiveDecision();
      const permitted =
        !active ||
        (active.files || []).some((f) => resolve(ctx.cwd, f) === target);

      if (!permitted && target) {
        store.record({
          category: "blocked",
          title: `Blocked ${toolName} on ${path}`,
          detail: "No matching active decision permits this file",
          files: path ? [path] : [],
          toolName,
          toolCallId,
          decision: active?.id,
        });

        return {
          block: true,
          reason:
            "Decision Trace: call trace_decision " +
            "listing this file before modifying it.",
        };
      }
    }

    return undefined;
  });

  // ── Tool result handler: capture outcomes ──
  pi.on("tool_result", async (event: ToolResultEvent) => {
    const { toolName, toolCallId, isError, content, details } = event;

    if (!["write", "edit", "bash"].includes(toolName)) return;

    const pending = pendingCalls.get(toolCallId);

    // Determine the activity context for outcome classification
    // Default: use the pending call's category, or infer from toolName
    const activityCategory = pending?.category ??
      (toolName === "write" ? "file_create" :
       toolName === "edit" ? "file_modify" : "exec");

    // Classify outcome using the activity for context
    const outcome = classifyOutcome(toolName, isError, content, details, activityCategory);

    // Extract output text for detail view
    const textContent = content
      ?.map((c: any) => (c?.type === "text" ? c.text : ""))
      .join("\n")
      .trim();

    // Capture raw output (truncated) for detail view
    const rawOutput = textContent ? textContent.slice(0, 2000) : undefined;

    store.record({
      category: activityCategory,
      outcome: outcome.outcome,
      title: outcome.title || pending?.title || `${toolName} completed`,
      detail: textContent?.slice(0, 200),
      exitCode: outcome.exitCode,
      isError: outcome.isError,
      toolName,
      toolCallId,
      decision: pending?.decision,
      files: pending?.files,
      rawCommand: pending?.rawCommand,
      rawOutput,
    });

    // Clean up pending map
    pendingCalls.delete(toolCallId);
  });

  // ── Optional: mark all dependents for review when a decision is invalidated ──
  function markDependentsForReview(decisionId: string) {
    const dependents = store.getDependents(decisionId);
    for (const dep of dependents) {
      store.record({
        category: "review",
        title: `REVIEW: "${dep.title}" depends on invalidated decision`,
        detail: `Event ${dep.id} (${dep.category}) depends on decision ${decisionId}`,
        decision: decisionId,
        files: dep.files,
        depends_on: [dep.id],
      });
    }
  }

  // ── Register /trace command ──
  pi.registerCommand("trace", {
    description:
      "Decision timeline, files and comments",

    handler: async (args, ctx) => {
      const [cmd, ...rest] = (args || "help").trim().split(/\s+/);

      if (cmd === "help") {
        return ctx.ui.notify(
          "/trace [help|timeline|detail ID|files|git|strict on|off|comment ID text|invalidate ID]",
          "info",
        );
      }

      // ── timeline ──
      if (cmd === "timeline") {
        const events = store.getLast(20);
        if (events.length === 0) {
          return ctx.ui.notify("No events recorded yet.", "info");
        }

        const lines = events.reverse().map((e) => formatTimelineEntry(e));
        ctx.ui.notify("\n" + lines.join("\n"), "info");
        return;
      }

      // ── detail ID ──
      if (cmd === "detail") {
        const id = rest[0];
        if (!id) return ctx.ui.notify("Usage: /trace detail ID", "info");

        const event = store.getById(id);
        if (!event) return ctx.ui.notify("Event not found: " + id, "warning");

        const lines = formatDetailEntry(event);
        ctx.ui.notify("\n" + lines.join("\n"), "info");
        return;
      }

      // ── files ──
      if (cmd === "files") {
        const files = store.getFiles();
        return ctx.ui.notify(
          files.length ? files.join("\n") : "No files recorded",
          "info",
        );
      }

      // ── strict ──
      if (cmd === "strict") {
        strict = rest[0] === "on";
        return ctx.ui.notify(
          "Strict mode: " + (strict ? "ON" : "OFF"),
          "info",
        );
      }

      // ── comment ──
      if (cmd === "comment") {
        const [id, ...words] = rest;
        if (!store.getById(id) || !words.length) {
          return ctx.ui.notify("Usage: /trace comment ID text", "info");
        }

        store.record({
          category: "comment",
          title: "User comment",
          decision: id,
          detail: words.join(" "),
        });

        return ctx.ui.notify("Comment saved", "info");
      }

      // ── invalidate ──
      if (cmd === "invalidate") {
        const id = rest[0];
        const event = store.getById(id);
        if (!event) return ctx.ui.notify("Unknown ID", "warning");

        store.record({
          category: "invalidate",
          title: "Decision invalidated: " + (event.title || id),
          decision: id,
        });

        // Mark dependents for review
        markDependentsForReview(id);

        return ctx.ui.notify(
          "Invalidated: " + id + ". Dependents marked for review.",
          "info",
        );
      }

      // ── git ──
      if (cmd === "git") {
        const { execFileSync } = await import("node:child_process");
        try {
          const output = execFileSync("git", ["log", "--oneline", "-10"], {
            cwd: ctx.cwd,
            encoding: "utf8",
          });
          return ctx.ui.notify(
            output.slice(0, 3000) || "No commits",
            "info",
          );
        } catch {
          return ctx.ui.notify("Not a git repository", "info");
        }
      }

      // ── active ──
      if (cmd === "active") {
        const active = store.getActiveDecision();
        if (!active) return ctx.ui.notify("No active decision", "info");
        return ctx.ui.notify(
          `Active: ${active.id} ${active.title}`,
          "info",
        );
      }

      // ── ui (interactive terminal UI) ──
      if (cmd === "ui") {
        if (!ctx.hasUI) {
          return ctx.ui.notify("/trace ui requires interactive terminal", "warning");
        }

        try {
          const result = await ctx.ui.custom<string | undefined>(
            (tui, theme, _kb, done) =>
              new TraceUIComponent(store, theme, done),
            {
              overlay: true,
              overlayOptions: {
                anchor: "center",
                width: "80%",
                maxHeight: "80%",
              },
            },
          );

          if (result) {
            ctx.ui.notify(result, "info");
          }
        } catch (err) {
          ctx.ui.notify("Trace UI error: " + String(err), "error");
        }
        return;
      }

      return ctx.ui.notify("Unknown command", "info");
    },
  });
}