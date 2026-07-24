import { z } from "npm:zod@4";

/**
 * @module stack-status
 *
 * stack-status — fetch a PR stack's review/CI status from GitHub and render it
 * as a self-contained HTML flowchart.
 *
 * Two methods:
 *
 *   fetch      — READ-ONLY. Resolves PR numbers from a pasted gt-pasteable
 *                stack block, a Graphite/GitHub PR URL, or bare numbers (the
 *                same permissive parser pr-feedback-triage and stack-watch
 *                use). For each PR, shells out to `gh pr view` and derives,
 *                generically:
 *                  - identity: number, title, headRefName, baseRefName, url,
 *                    isDraft, state
 *                  - approval status: reviewDecision + per-reviewer latest
 *                    review states
 *                  - CI status: pass/fail/pending counts + failing check
 *                    names, rolled up into a single state
 *                Orders PRs bottom→top of the stack via baseRefName→
 *                headRefName chaining (falls back to input order when the
 *                chain can't be resolved), and emits one prStatus resource
 *                per PR plus a single stackStatus bundle.
 *
 *   renderHtml — Reads the latest stackStatus bundle (or one passed inline)
 *                and renders a single self-contained HTML file (inline CSS,
 *                no external assets, light/dark aware) showing the stack as a
 *                vertical flowchart: one node per PR, base at the bottom,
 *                connected by arrows to the tip. Each node shows the PR
 *                number/title/draft badge, an approval pill, review status,
 *                and a CI pill with pass/fail/pending counts and failing
 *                check names.
 *
 * Fully generic: no hardcoded repo, org, or check names — everything is
 * derived from `gh`'s JSON output at run time.
 */

/** Global configuration shared across methods on an instance of this model. */
const GlobalArgsSchema = z.object({
  /** Default GitHub owner/repo (`owner/name`) used when a method call omits `repo`. */
  repo: z.string().default(""),
});

/** A single reviewer's latest review state on a PR. */
const ReviewerStateSchema = z.object({
  login: z.string(),
  state: z.string(),
});

/** Approval status derived from `reviewDecision` + `latestReviews`. */
const ApprovalStatusSchema = z.object({
  /** GitHub's own rollup: APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED / null. */
  reviewDecision: z.string().nullable(),
  /** Latest review state per reviewer who has submitted a review. */
  reviewers: z.array(ReviewerStateSchema),
  /** Logins still requested to review but who haven't submitted one. */
  pendingReviewers: z.array(z.string()),
});

/** CI status rolled up from `statusCheckRollup`. */
const CiStatusSchema = z.object({
  /** Overall rollup: SUCCESS / FAILURE / PENDING / NONE (no checks reported). */
  rollup: z.enum(["SUCCESS", "FAILURE", "PENDING", "NONE"]),
  passing: z.number(),
  failing: z.number(),
  pending: z.number(),
  /** Names only (never logs/output) of currently-failing checks. */
  failingChecks: z.array(z.string()),
});

/** Full status snapshot for a single PR. */
const PrStatusSchema = z.object({
  number: z.number(),
  title: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  url: z.string(),
  isDraft: z.boolean(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  approval: ApprovalStatusSchema,
  ci: CiStatusSchema,
  mergeable: z.string().nullable(),
  mergeStateStatus: z.string().nullable(),
});

/** Ordered stack bundle: PRs from base (bottom) to tip (top). */
const StackStatusSchema = z.object({
  repo: z.string(),
  fetchedAt: z.string(),
  /** Bottom-to-top: index 0 is the base of the stack, last is the tip. */
  prs: z.array(PrStatusSchema),
});

/** A rendered HTML flowchart, stored as plain text so it can be written straight to a file. */
const StackHtmlSchema = z.object({
  repo: z.string(),
  renderedAt: z.string(),
  prNumbers: z.array(z.number()),
  html: z.string(),
});

type CmdResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  code: number;
};

/** Run a shell command and capture its output without throwing. */
async function runCmd(cmd: string[]): Promise<CmdResult> {
  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  return {
    success: output.success,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    code: output.code,
  };
}

/**
 * Extract PR numbers from input. Accepts:
 *  - a gt-pasteable stack markdown block (many `#12345` refs)
 *  - a single Graphite URL (.../pr/OWNER/REPO/12345)
 *  - a single GitHub PR URL (.../pull/12345)
 *  - comma/space/newline-separated bare numbers
 * Returns numbers in first-seen order, de-duplicated. Mirrors the parser used
 * by pr-feedback-triage and stack-watch so stack input is consistent across
 * all of Mat's PR-stack models.
 */
export function parsePrNumbers(input: string): number[] {
  const seen = new Set<number>();
  const ordered: number[] = [];

  // Graphite / GitHub PR URLs: capture the trailing numeric id specifically so
  // we don't mistake owner/repo path segments for PR numbers.
  const urlRe = /(?:\/pr\/[^/]+\/[^/]+\/|\/pull\/)(\d+)/g;
  for (const m of input.matchAll(urlRe)) {
    const n = Number(m[1]);
    if (!seen.has(n)) {
      seen.add(n);
      ordered.push(n);
    }
  }

  // gt-pasteable blocks lead each line with [#12345 title]. Match #-prefixed
  // numbers anywhere.
  const hashRe = /#(\d{2,})/g;
  for (const m of input.matchAll(hashRe)) {
    const n = Number(m[1]);
    if (!seen.has(n)) {
      seen.add(n);
      ordered.push(n);
    }
  }

  // Bare numbers, comma/space/newline separated — only when nothing else matched.
  if (ordered.length === 0) {
    const bareRe = /\d{1,}/g;
    for (const m of input.matchAll(bareRe)) {
      const n = Number(m[0]);
      if (!seen.has(n)) {
        seen.add(n);
        ordered.push(n);
      }
    }
  }

  return ordered;
}

/**
 * Canonical data-resource key for a set of PR numbers. Sorts numerically so the
 * key is independent of the order the caller listed the PRs in — `fetch` and
 * `renderHtml` (and any later reader) derive the SAME key from the same set,
 * regardless of input order or the stack's base→tip ordering. Stack ordering is
 * preserved inside the bundle payload; only the lookup key is canonicalized.
 */
export function stackKey(prNumbers: number[]): string {
  return `stack-${[...prNumbers].sort((a, b) => a - b).join("-")}`;
}

/**
 * Order PRs bottom (base of stack) → top (tip) by chaining baseRefName to
 * another PR's headRefName. Falls back to the given input order for any PR
 * whose position in the chain can't be resolved (e.g. its base isn't another
 * PR in the set — a stack root — or the set doesn't form a clean chain).
 */
export function orderStack<
  T extends { headRefName: string; baseRefName: string },
>(
  prs: T[],
): T[] {
  if (prs.length <= 1) return [...prs];

  const byHead = new Map<string, T>();
  for (const pr of prs) byHead.set(pr.headRefName, pr);

  const parentOf = new Map<T, T | null>();
  for (const pr of prs) parentOf.set(pr, byHead.get(pr.baseRefName) ?? null);

  const roots = prs.filter((pr) => parentOf.get(pr) == null);
  if (roots.length !== 1) return [...prs]; // ambiguous/no clean single chain — keep input order

  const childOf = new Map<T, T | undefined>();
  for (const pr of prs) {
    const parent = parentOf.get(pr);
    if (parent) childOf.set(parent, pr);
  }

  const ordered: T[] = [];
  let cursor: T | undefined = roots[0];
  const visited = new Set<T>();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    ordered.push(cursor);
    cursor = childOf.get(cursor);
  }

  // If the walk didn't cover every PR (a broken/branching chain), bail to input order.
  if (ordered.length !== prs.length) return [...prs];
  return ordered;
}

/** Raw shape of `gh pr view --json ...` relevant to this model. */
type GhCheckContext = {
  __typename?: string;
  name?: string;
  context?: string;
  state?: string; // StatusContext: SUCCESS/FAILURE/ERROR/PENDING/EXPECTED
  conclusion?: string; // CheckRun: SUCCESS/FAILURE/NEUTRAL/CANCELLED/TIMED_OUT/ACTION_REQUIRED/SKIPPED/null
  status?: string; // CheckRun: COMPLETED/IN_PROGRESS/QUEUED
};

type GhReviewRequest = { login?: string; name?: string };
type GhLatestReview = { author?: { login?: string }; state?: string };

type GhPrView = {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  url: string;
  isDraft: boolean;
  state: string;
  reviewDecision: string | null;
  reviewRequests: GhReviewRequest[] | null;
  latestReviews: GhLatestReview[] | null;
  statusCheckRollup: GhCheckContext[] | null;
  mergeable: string | null;
  mergeStateStatus: string | null;
};

/**
 * Derive a single check's pass/fail/pending bucket. StatusContext and
 * CheckRun shapes both appear in `statusCheckRollup`, so both `state` and
 * `conclusion`/`status` are considered.
 */
export function classifyCheck(
  check: GhCheckContext,
): "pass" | "fail" | "pending" {
  const state = (check.state ?? "").toUpperCase();
  if (state === "SUCCESS" || state === "EXPECTED") return "pass";
  if (state === "FAILURE" || state === "ERROR") return "fail";

  const conclusion = (check.conclusion ?? "").toUpperCase();
  if (
    conclusion === "SUCCESS" || conclusion === "NEUTRAL" ||
    conclusion === "SKIPPED"
  ) return "pass";
  if (
    conclusion === "FAILURE" || conclusion === "CANCELLED" ||
    conclusion === "TIMED_OUT" || conclusion === "ACTION_REQUIRED"
  ) return "fail";

  const status = (check.status ?? "").toUpperCase();
  if (status === "IN_PROGRESS" || status === "QUEUED") return "pending";

  return "pending";
}

/** A check's display name, preferring CheckRun `name` then StatusContext `context`. */
export function checkName(check: GhCheckContext): string {
  return check.name ?? check.context ?? "unknown check";
}

/** Roll a PR's `statusCheckRollup` up into pass/fail/pending counts + a single state. */
export function summarizeCi(
  checks: GhCheckContext[],
): z.infer<typeof CiStatusSchema> {
  let passing = 0, failing = 0, pending = 0;
  const failingChecks: string[] = [];

  for (const check of checks) {
    const bucket = classifyCheck(check);
    if (bucket === "pass") passing++;
    else if (bucket === "fail") {
      failing++;
      failingChecks.push(checkName(check));
    } else pending++;
  }

  let rollup: z.infer<typeof CiStatusSchema>["rollup"];
  if (checks.length === 0) rollup = "NONE";
  else if (failing > 0) rollup = "FAILURE";
  else if (pending > 0) rollup = "PENDING";
  else rollup = "SUCCESS";

  return { rollup, passing, failing, pending, failingChecks };
}

/** Derive approval status from `reviewDecision` + `latestReviews` + `reviewRequests`. */
export function summarizeApproval(
  pr: GhPrView,
): z.infer<typeof ApprovalStatusSchema> {
  const reviewers = (pr.latestReviews ?? [])
    .filter((r) => r.author?.login)
    .map((r) => ({ login: r.author!.login!, state: r.state ?? "UNKNOWN" }));
  const pendingReviewers = (pr.reviewRequests ?? [])
    .map((r) => r.login ?? r.name)
    .filter((n): n is string => !!n);

  return {
    reviewDecision: pr.reviewDecision ?? null,
    reviewers,
    pendingReviewers,
  };
}

/** Convert a raw `gh pr view --json` payload into this model's PrStatus shape. */
export function toPrStatus(pr: GhPrView): z.infer<typeof PrStatusSchema> {
  const state = (pr.state ?? "OPEN").toUpperCase();
  return {
    number: pr.number,
    title: pr.title,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    url: pr.url,
    isDraft: !!pr.isDraft,
    state: state === "MERGED" || state === "CLOSED" ? state : "OPEN",
    approval: summarizeApproval(pr),
    ci: summarizeCi(pr.statusCheckRollup ?? []),
    mergeable: pr.mergeable ?? null,
    mergeStateStatus: pr.mergeStateStatus ?? null,
  };
}

const GH_FIELDS = [
  "number",
  "title",
  "headRefName",
  "baseRefName",
  "url",
  "isDraft",
  "state",
  "reviewDecision",
  "reviewRequests",
  "latestReviews",
  "statusCheckRollup",
  "mergeable",
  "mergeStateStatus",
].join(",");

/** Fetch one PR's raw view via the authenticated `gh` CLI. */
async function ghPrView(repo: string, num: number): Promise<GhPrView> {
  const res = await runCmd([
    "gh",
    "pr",
    "view",
    String(num),
    "--repo",
    repo,
    "--json",
    GH_FIELDS,
  ]);
  if (!res.success) {
    throw new Error(
      `gh pr view ${num} --repo ${repo} failed (exit ${res.code}): ${res.stderr.trim()}`,
    );
  }
  return JSON.parse(res.stdout) as GhPrView;
}

/** Escape a string for safe interpolation into HTML text content or attributes. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Colored-pill classification for a PR's approval state. */
export function approvalPillClass(
  decision: string | null,
): "approved" | "changes" | "review" {
  const d = (decision ?? "").toUpperCase();
  if (d === "APPROVED") return "approved";
  if (d === "CHANGES_REQUESTED") return "changes";
  return "review";
}

/** Human label for an approval pill. */
export function approvalLabel(decision: string | null): string {
  const d = (decision ?? "").toUpperCase();
  if (d === "APPROVED") return "Approved";
  if (d === "CHANGES_REQUESTED") return "Changes requested";
  if (d === "REVIEW_REQUIRED") return "Review required";
  return "No reviews yet";
}

/** Colored-pill classification for a PR's CI rollup. */
export function ciPillClass(
  rollup: z.infer<typeof CiStatusSchema>["rollup"],
): "pass" | "fail" | "pending" | "none" {
  if (rollup === "SUCCESS") return "pass";
  if (rollup === "FAILURE") return "fail";
  if (rollup === "PENDING") return "pending";
  return "none";
}

/** Render one PR's node markup (card body only — caller wraps it in the flow container). */
export function renderPrNode(pr: z.infer<typeof PrStatusSchema>): string {
  const draftBadge = pr.isDraft
    ? `<span class="badge badge-draft">DRAFT</span>`
    : "";
  const stateBadge = pr.state !== "OPEN"
    ? `<span class="badge badge-${pr.state.toLowerCase()}">${pr.state}</span>`
    : "";

  const approvalClass = approvalPillClass(pr.approval.reviewDecision);
  const approvalText = approvalLabel(pr.approval.reviewDecision);

  const reviewerLines = pr.approval.reviewers
    .map((r) => `${escapeHtml(r.login)}: ${escapeHtml(r.state)}`)
    .concat(
      pr.approval.pendingReviewers.map((login) =>
        `${escapeHtml(login)}: pending`
      ),
    )
    .join(", ");
  const reviewStatusText = reviewerLines.length > 0
    ? reviewerLines
    : "No reviewers assigned";

  const ciClass = ciPillClass(pr.ci.rollup);
  const ciCounts =
    `${pr.ci.passing} pass / ${pr.ci.failing} fail / ${pr.ci.pending} pending`;
  const failingList = pr.ci.failingChecks.length > 0
    ? `<div class="failing-checks">${
      pr.ci.failingChecks.map((c) =>
        `<span class="check-name">${escapeHtml(c)}</span>`
      ).join("")
    }</div>`
    : "";

  return `
    <div class="node">
      <div class="node-header">
        <span class="pr-number">#${pr.number}</span>
        <span class="pr-title">${escapeHtml(pr.title)}</span>
        ${draftBadge}${stateBadge}
      </div>
      <div class="node-refs">${
    escapeHtml(pr.headRefName)
  } <span class="ref-arrow">&larr;</span> ${escapeHtml(pr.baseRefName)}</div>
      <div class="node-row">
        <span class="pill pill-${approvalClass}">${approvalText}</span>
        <span class="review-status">${reviewStatusText}</span>
      </div>
      <div class="node-row">
        <span class="pill pill-ci-${ciClass}">CI: ${ciCounts}</span>
      </div>
      ${failingList}
      <a class="pr-link" href="${
    escapeHtml(pr.url)
  }" target="_blank" rel="noopener">View on GitHub &rarr;</a>
    </div>`;
}

/**
 * Render a full self-contained HTML page for a stack: a vertical flowchart,
 * tip at the top, base at the bottom, connected by arrows. Inline CSS only,
 * light/dark aware via prefers-color-scheme. No external assets.
 */
export function renderStackHtml(
  repo: string,
  prs: Array<z.infer<typeof PrStatusSchema>>,
): string {
  // Render tip-first (top of page) down to the base — reverse the bottom→top order.
  const topDown = [...prs].reverse();
  const nodes = topDown.map((pr, i) => {
    const node = renderPrNode(pr);
    const connector = i < topDown.length - 1
      ? `<div class="connector"><svg viewBox="0 0 24 40" width="24" height="40" aria-hidden="true"><path d="M12 0 L12 30 M4 22 L12 32 L20 22" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`
      : "";
    return node + connector;
  }).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stack status — ${escapeHtml(repo)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --fg: #1a1a1a;
    --muted: #6b7280;
    --card-bg: #f8f9fb;
    --card-border: #e2e5eb;
    --link: #2563eb;
    --pill-approved-bg: #dcfce7; --pill-approved-fg: #166534;
    --pill-changes-bg: #fee2e2; --pill-changes-fg: #991b1b;
    --pill-review-bg: #e5e7eb; --pill-review-fg: #374151;
    --pill-ci-pass-bg: #dcfce7; --pill-ci-pass-fg: #166534;
    --pill-ci-fail-bg: #fee2e2; --pill-ci-fail-fg: #991b1b;
    --pill-ci-pending-bg: #fef3c7; --pill-ci-pending-fg: #92400e;
    --pill-ci-none-bg: #e5e7eb; --pill-ci-none-fg: #374151;
    --badge-draft-bg: #e5e7eb; --badge-draft-fg: #374151;
    --check-bg: #fff1f2; --check-fg: #9f1239;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115;
      --fg: #e5e7eb;
      --muted: #9ca3af;
      --card-bg: #1a1d24;
      --card-border: #2a2e37;
      --link: #60a5fa;
      --pill-approved-bg: #14532d; --pill-approved-fg: #bbf7d0;
      --pill-changes-bg: #7f1d1d; --pill-changes-fg: #fecaca;
      --pill-review-bg: #374151; --pill-review-fg: #d1d5db;
      --pill-ci-pass-bg: #14532d; --pill-ci-pass-fg: #bbf7d0;
      --pill-ci-fail-bg: #7f1d1d; --pill-ci-fail-fg: #fecaca;
      --pill-ci-pending-bg: #78350f; --pill-ci-pending-fg: #fde68a;
      --pill-ci-none-bg: #374151; --pill-ci-none-fg: #d1d5db;
      --badge-draft-bg: #374151; --badge-draft-fg: #d1d5db;
      --check-bg: #4c0519; --check-fg: #fda4af;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 2rem 1rem 4rem;
    background: var(--bg);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  h1 {
    text-align: center;
    font-size: 1.25rem;
    font-weight: 600;
    margin: 0 0 0.25rem;
  }
  .subtitle {
    text-align: center;
    color: var(--muted);
    font-size: 0.85rem;
    margin: 0 0 2rem;
  }
  .flow {
    max-width: 560px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    align-items: stretch;
  }
  .node {
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: 10px;
    padding: 1rem 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .node-header {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .pr-number {
    font-weight: 700;
    color: var(--muted);
  }
  .pr-title {
    font-weight: 600;
    flex: 1;
    min-width: 0;
    overflow-wrap: break-word;
  }
  .node-refs {
    font-size: 0.78rem;
    color: var(--muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .ref-arrow { opacity: 0.6; }
  .node-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    font-size: 0.85rem;
  }
  .review-status {
    color: var(--muted);
    font-size: 0.8rem;
  }
  .pill {
    display: inline-block;
    padding: 0.15rem 0.6rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    white-space: nowrap;
  }
  .pill-approved { background: var(--pill-approved-bg); color: var(--pill-approved-fg); }
  .pill-changes { background: var(--pill-changes-bg); color: var(--pill-changes-fg); }
  .pill-review { background: var(--pill-review-bg); color: var(--pill-review-fg); }
  .pill-ci-pass { background: var(--pill-ci-pass-bg); color: var(--pill-ci-pass-fg); }
  .pill-ci-fail { background: var(--pill-ci-fail-bg); color: var(--pill-ci-fail-fg); }
  .pill-ci-pending { background: var(--pill-ci-pending-bg); color: var(--pill-ci-pending-fg); }
  .pill-ci-none { background: var(--pill-ci-none-bg); color: var(--pill-ci-none-fg); }
  .badge {
    display: inline-block;
    padding: 0.1rem 0.5rem;
    border-radius: 4px;
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    background: var(--badge-draft-bg);
    color: var(--badge-draft-fg);
  }
  .failing-checks {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .check-name {
    background: var(--check-bg);
    color: var(--check-fg);
    font-size: 0.72rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    padding: 0.1rem 0.45rem;
    border-radius: 4px;
  }
  .pr-link {
    font-size: 0.78rem;
    color: var(--link);
    text-decoration: none;
    align-self: flex-start;
  }
  .pr-link:hover { text-decoration: underline; }
  .connector {
    display: flex;
    justify-content: center;
    color: var(--muted);
    margin: 0.1rem 0;
  }
</style>
</head>
<body>
  <h1>PR stack status</h1>
  <div class="subtitle">${
    escapeHtml(repo)
  } &middot; tip at top, base at bottom &middot; ${prs.length} PR${
    prs.length === 1 ? "" : "s"
  }</div>
  <div class="flow">
${nodes}
  </div>
</body>
</html>
`;
}

type MethodContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
    error: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  /** Read the latest data for a named resource instance on THIS model instance, if any. */
  readResource?: (name: string) => Promise<Record<string, unknown> | null>;
};

/**
 * The `@mgreten/stack-status` model type: pulls PR-stack review/CI status
 * from GitHub via `gh` and renders it as a self-contained HTML flowchart.
 * Fully generic — works against any repo and any stack.
 */
export const model = {
  type: "@mgreten/stack-status",
  version: "2026.07.24.3",
  globalArguments: GlobalArgsSchema,
  resources: {
    prStatus: {
      description:
        "Single-PR status snapshot: identity, approval status (reviewDecision + " +
        "per-reviewer states), and CI status (pass/fail/pending counts + failing " +
        "check names). Read-only reconnaissance.",
      schema: PrStatusSchema,
      lifetime: "7d" as const,
      garbageCollection: 40,
    },
    stackStatus: {
      description:
        "Ordered bundle of prStatus for a whole stack, base (bottom) to tip (top).",
      schema: StackStatusSchema,
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
    stackHtml: {
      description:
        "Self-contained HTML flowchart rendering of a stackStatus bundle — inline " +
        "CSS, no external assets, light/dark aware.",
      schema: StackHtmlSchema,
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    fetch: {
      description:
        "Resolve PR numbers from a pasted gt stack block, a Graphite/GitHub PR " +
        "URL, or bare numbers; fetch each PR's review/CI status via `gh pr view`; " +
        "order the stack base-to-tip; and emit a stackStatus bundle.",
      arguments: z.object({
        stack: z.string().describe(
          "gt-pasteable stack markdown block, a Graphite/GitHub PR URL, or " +
            "comma/space/newline-separated PR numbers or URLs",
        ),
        repo: z.string().optional().describe(
          "GitHub owner/repo override (defaults to the model's configured repo)",
        ),
        nowIso: z.string().optional().describe(
          "ISO timestamp to stamp the bundle with (for deterministic tests)",
        ),
      }),
      execute: async (
        args: { stack: string; repo?: string; nowIso?: string },
        context: MethodContext,
      ) => {
        const repo = args.repo ?? context.globalArgs.repo;
        if (!repo) {
          throw new Error(
            "No repo configured. Pass `repo` (owner/name) as an argument or set it " +
              "as a global argument on this model instance.",
          );
        }

        const prNumbers = parsePrNumbers(args.stack);
        if (prNumbers.length === 0) {
          throw new Error(
            "No PR numbers found in input. Provide a gt stack block, a PR URL, or bare numbers.",
          );
        }

        context.logger.info("Resolved {count} PR(s): {prs}", {
          count: prNumbers.length,
          prs: prNumbers.join(", "),
        });

        const rawPrs: GhPrView[] = [];
        for (const num of prNumbers) {
          rawPrs.push(await ghPrView(repo, num));
        }

        const statuses = rawPrs.map(toPrStatus);
        const ordered = orderStack(statuses);

        const handles = [];
        for (const pr of ordered) {
          const handle = await context.writeResource(
            "prStatus",
            `pr-${pr.number}`,
            pr as unknown as Record<string, unknown>,
          );
          handles.push(handle);
        }

        const now = args.nowIso ?? new Date().toISOString();
        const bundle = {
          repo,
          fetchedAt: now,
          prs: ordered,
        };
        const bundleHandle = await context.writeResource(
          "stackStatus",
          stackKey(prNumbers),
          bundle as unknown as Record<string, unknown>,
        );

        context.logger.info(
          "Fetched status for {n} PR(s) on {repo}: {approved} approved, {changes} changes requested, {failing} with failing CI",
          {
            n: ordered.length,
            repo,
            approved:
              ordered.filter((p) => p.approval.reviewDecision === "APPROVED")
                .length,
            changes:
              ordered.filter((p) =>
                p.approval.reviewDecision === "CHANGES_REQUESTED"
              ).length,
            failing: ordered.filter((p) => p.ci.rollup === "FAILURE").length,
          },
        );

        return { dataHandles: [bundleHandle, ...handles] };
      },
    },
    renderHtml: {
      description:
        "Render a stackStatus bundle as a self-contained HTML flowchart (inline " +
        "CSS, no external assets, light/dark aware). Reads the latest fetch " +
        "output for the given stack unless a bundle is passed inline.",
      arguments: z.object({
        stack: z.string().optional().describe(
          "Same stack input as `fetch` — used to look up the matching stackStatus " +
            "resource written by a prior fetch call. Required unless `bundle` is given.",
        ),
        bundle: StackStatusSchema.optional().describe(
          "A stackStatus bundle to render directly, bypassing the data lookup.",
        ),
        outFile: z.string().optional().describe(
          "Optional filesystem path to also write the raw HTML document to, ready " +
            "to open in a browser. The HTML is always stored as a data resource; " +
            "this just saves the extra `swamp data get ... | jq -r .content.html` step.",
        ),
      }),
      execute: async (
        args: {
          stack?: string;
          bundle?: z.infer<typeof StackStatusSchema>;
          outFile?: string;
        },
        context: MethodContext,
      ) => {
        let bundle = args.bundle ?? null;

        if (!bundle) {
          if (!args.stack) {
            throw new Error(
              "Provide either `stack` (to look up a prior fetch) or `bundle` directly.",
            );
          }
          const prNumbers = parsePrNumbers(args.stack);
          if (prNumbers.length === 0) {
            throw new Error("No PR numbers found in `stack` input.");
          }
          if (!context.readResource) {
            throw new Error(
              "This runtime does not support reading prior data — pass `bundle` directly.",
            );
          }
          const key = stackKey(prNumbers);
          const found = await context.readResource(key);
          if (!found) {
            throw new Error(
              `No stackStatus data found for stack "${key}". Run fetch first.`,
            );
          }
          bundle = found as unknown as z.infer<typeof StackStatusSchema>;
        }

        const html = renderStackHtml(bundle.repo, bundle.prs);
        const now = new Date().toISOString();
        const prNumbers = bundle.prs.map((p) => p.number);

        const handle = await context.writeResource(
          "stackHtml",
          `${stackKey(prNumbers)}-html`,
          {
            repo: bundle.repo,
            renderedAt: now,
            prNumbers,
            html,
          },
        );

        // The data resource stores the HTML for pipelines, but its content is a
        // JSON envelope — not directly openable. When outFile is given, also drop
        // the raw document to disk so it can be opened in a browser as-is.
        if (args.outFile) {
          await Deno.writeTextFile(args.outFile, html);
          context.logger.info("Wrote HTML to {path}", { path: args.outFile });
        }

        context.logger.info(
          "Rendered stack flowchart for {n} PR(s) on {repo}",
          {
            n: prNumbers.length,
            repo: bundle.repo,
          },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
