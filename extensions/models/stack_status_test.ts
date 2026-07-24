import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  approvalLabel,
  approvalPillClass,
  ciPillClass,
  classifyCheck,
  escapeHtml,
  orderStack,
  parsePrNumbers,
  renderPrNode,
  renderStackHtml,
  summarizeApproval,
  summarizeCi,
  toPrStatus,
} from "./stack_status.ts";

// ── parsePrNumbers ───────────────────────────────────────────────────────────

Deno.test("parsePrNumbers: extracts PR numbers from a GitHub pull URL", () => {
  assertEquals(parsePrNumbers("https://github.com/owner/repo/pull/12345"), [12345]);
});

Deno.test("parsePrNumbers: extracts PR numbers from a Graphite PR URL", () => {
  assertEquals(parsePrNumbers("https://app.graphite.dev/github/pr/owner/repo/12345/some-title"), [12345]);
});

Deno.test("parsePrNumbers: extracts #-refs from a gt-pasteable stack block, de-duplicated, first-seen order", () => {
  const block = "- #100 Some title\n- #200 Another title\n- #100 duplicate ref\n";
  assertEquals(parsePrNumbers(block), [100, 200]);
});

Deno.test("parsePrNumbers: falls back to bare comma/space/newline separated numbers", () => {
  assertEquals(parsePrNumbers("100, 200 300\n400"), [100, 200, 300, 400]);
});

Deno.test("parsePrNumbers: empty/garbage input yields no numbers", () => {
  assertEquals(parsePrNumbers("no numbers here"), []);
  assertEquals(parsePrNumbers(""), []);
});

// ── orderStack ────────────────────────────────────────────────────────────────

type MiniPr = { headRefName: string; baseRefName: string; n: number };
function mini(n: number, head: string, base: string): MiniPr {
  return { n, headRefName: head, baseRefName: base };
}

Deno.test("orderStack: chains base->head into a bottom-to-top order regardless of input order", () => {
  const prs = [
    mini(3, "c", "b"),
    mini(1, "a", "main"),
    mini(2, "b", "a"),
  ];
  const ordered = orderStack(prs).map((p) => p.n);
  assertEquals(ordered, [1, 2, 3]);
});

Deno.test("orderStack: single PR returns as-is", () => {
  const prs = [mini(1, "a", "main")];
  assertEquals(orderStack(prs).map((p) => p.n), [1]);
});

Deno.test("orderStack: ambiguous chain (two roots) falls back to input order", () => {
  const prs = [
    mini(1, "a", "main"),
    mini(2, "b", "main"), // second root — base isn't another PR's head
  ];
  assertEquals(orderStack(prs).map((p) => p.n), [1, 2]);
});

Deno.test("orderStack: broken chain (fan-out) falls back to input order", () => {
  const prs = [
    mini(1, "a", "main"),
    mini(2, "b", "a"),
    mini(3, "c", "a"), // both 2 and 3 stack on 1 — not a single chain
  ];
  assertEquals(orderStack(prs).map((p) => p.n), [1, 2, 3]);
});

// ── classifyCheck / summarizeCi ─────────────────────────────────────────────

Deno.test("classifyCheck: StatusContext SUCCESS/FAILURE/PENDING", () => {
  assertEquals(classifyCheck({ state: "SUCCESS" }), "pass");
  assertEquals(classifyCheck({ state: "FAILURE" }), "fail");
  assertEquals(classifyCheck({ state: "ERROR" }), "fail");
  assertEquals(classifyCheck({ state: "PENDING" }), "pending");
});

Deno.test("classifyCheck: CheckRun conclusion/status shapes", () => {
  assertEquals(classifyCheck({ conclusion: "SUCCESS" }), "pass");
  assertEquals(classifyCheck({ conclusion: "NEUTRAL" }), "pass");
  assertEquals(classifyCheck({ conclusion: "FAILURE" }), "fail");
  assertEquals(classifyCheck({ conclusion: "CANCELLED" }), "fail");
  assertEquals(classifyCheck({ status: "IN_PROGRESS" }), "pending");
  assertEquals(classifyCheck({ status: "QUEUED" }), "pending");
});

Deno.test("classifyCheck: unknown/empty shape defaults to pending", () => {
  assertEquals(classifyCheck({}), "pending");
});

Deno.test("summarizeCi: rolls up counts and failing check names, empty set is NONE", () => {
  assertEquals(summarizeCi([]), { rollup: "NONE", passing: 0, failing: 0, pending: 0, failingChecks: [] });

  const checks = [
    { name: "rspec", state: "SUCCESS" },
    { name: "tsc", state: "FAILURE" },
    { context: "circleci/build", state: "PENDING" },
  ];
  const summary = summarizeCi(checks);
  assertEquals(summary.rollup, "FAILURE");
  assertEquals(summary.passing, 1);
  assertEquals(summary.failing, 1);
  assertEquals(summary.pending, 1);
  assertEquals(summary.failingChecks, ["tsc"]);
});

Deno.test("summarizeCi: all passing -> SUCCESS; any pending with no failures -> PENDING", () => {
  assertEquals(summarizeCi([{ name: "a", state: "SUCCESS" }]).rollup, "SUCCESS");
  assertEquals(
    summarizeCi([{ name: "a", state: "SUCCESS" }, { name: "b", state: "PENDING" }]).rollup,
    "PENDING",
  );
});

// ── summarizeApproval ────────────────────────────────────────────────────────

Deno.test("summarizeApproval: maps reviewDecision, latestReviews, and pending reviewRequests", () => {
  const approval = summarizeApproval({
    number: 1,
    title: "t",
    headRefName: "h",
    baseRefName: "b",
    url: "u",
    isDraft: false,
    state: "OPEN",
    reviewDecision: "CHANGES_REQUESTED",
    reviewRequests: [{ login: "bob" }],
    latestReviews: [{ author: { login: "alice" }, state: "CHANGES_REQUESTED" }],
    statusCheckRollup: [],
    mergeable: "MERGEABLE",
    mergeStateStatus: "BEHIND",
  });
  assertEquals(approval.reviewDecision, "CHANGES_REQUESTED");
  assertEquals(approval.reviewers, [{ login: "alice", state: "CHANGES_REQUESTED" }]);
  assertEquals(approval.pendingReviewers, ["bob"]);
});

Deno.test("toPrStatus: normalizes state to the OPEN/MERGED/CLOSED enum", () => {
  const base = {
    number: 1,
    title: "t",
    headRefName: "h",
    baseRefName: "b",
    url: "u",
    isDraft: true,
    reviewDecision: null,
    reviewRequests: null,
    latestReviews: null,
    statusCheckRollup: null,
    mergeable: null,
    mergeStateStatus: null,
  };
  assertEquals(toPrStatus({ ...base, state: "OPEN" }).state, "OPEN");
  assertEquals(toPrStatus({ ...base, state: "MERGED" }).state, "MERGED");
  assertEquals(toPrStatus({ ...base, state: "weird" }).state, "OPEN");
  assertEquals(toPrStatus({ ...base, state: "OPEN" }).isDraft, true);
});

// ── pill classification / labels ────────────────────────────────────────────

Deno.test("approvalPillClass and approvalLabel cover all decisions", () => {
  assertEquals(approvalPillClass("APPROVED"), "approved");
  assertEquals(approvalPillClass("CHANGES_REQUESTED"), "changes");
  assertEquals(approvalPillClass("REVIEW_REQUIRED"), "review");
  assertEquals(approvalPillClass(null), "review");

  assertEquals(approvalLabel("APPROVED"), "Approved");
  assertEquals(approvalLabel("CHANGES_REQUESTED"), "Changes requested");
  assertEquals(approvalLabel("REVIEW_REQUIRED"), "Review required");
  assertEquals(approvalLabel(null), "No reviews yet");
});

Deno.test("ciPillClass maps every rollup state", () => {
  assertEquals(ciPillClass("SUCCESS"), "pass");
  assertEquals(ciPillClass("FAILURE"), "fail");
  assertEquals(ciPillClass("PENDING"), "pending");
  assertEquals(ciPillClass("NONE"), "none");
});

// ── HTML rendering ───────────────────────────────────────────────────────────

Deno.test("escapeHtml escapes all five special characters", () => {
  assertEquals(escapeHtml(`<a href="x">it's & "quoted"</a>`), "&lt;a href=&quot;x&quot;&gt;it&#39;s &amp; &quot;quoted&quot;&lt;/a&gt;");
});

const SAMPLE_PR = {
  number: 42,
  title: "<script>alert(1)</script> feature",
  headRefName: "feature/x",
  baseRefName: "main",
  url: "https://github.com/owner/repo/pull/42",
  isDraft: true,
  state: "OPEN" as const,
  approval: {
    reviewDecision: "CHANGES_REQUESTED" as const,
    reviewers: [{ login: "alice", state: "CHANGES_REQUESTED" }],
    pendingReviewers: ["bob"],
  },
  ci: {
    rollup: "FAILURE" as const,
    passing: 2,
    failing: 1,
    pending: 0,
    failingChecks: ["rspec"],
  },
  mergeable: "MERGEABLE",
  mergeStateStatus: "BEHIND",
};

Deno.test("renderPrNode: escapes untrusted title text and includes key status markers", () => {
  const node = renderPrNode(SAMPLE_PR);
  assertStringIncludes(node, "#42");
  assertStringIncludes(node, "&lt;script&gt;alert(1)&lt;/script&gt;");
  assertStringIncludes(node, "DRAFT");
  assertStringIncludes(node, "pill-changes");
  assertStringIncludes(node, "pill-ci-fail");
  assertStringIncludes(node, "rspec");
  assertStringIncludes(node, SAMPLE_PR.url);
});

Deno.test("renderStackHtml: produces a well-formed, self-contained, theme-aware document", () => {
  const html = renderStackHtml("owner/repo", [SAMPLE_PR]);
  assertStringIncludes(html, "<!doctype html>");
  assertStringIncludes(html, "</html>");
  assertStringIncludes(html, "prefers-color-scheme: dark");
  assertStringIncludes(html, "owner/repo");
  // No external assets, and the PR title's script tag is escaped, not raw.
  assertEquals(html.includes("https://cdn"), false);
  assertEquals(html.includes("<script>"), false);
  assertStringIncludes(html, "&lt;script&gt;");
});

Deno.test("renderStackHtml: multiple PRs get a connector between them and tip renders first (top)", () => {
  const base = { ...SAMPLE_PR, number: 1, headRefName: "a", baseRefName: "main" };
  const tip = { ...SAMPLE_PR, number: 2, headRefName: "b", baseRefName: "a" };
  const html = renderStackHtml("owner/repo", [base, tip]);
  assertStringIncludes(html, "connector");
  // Tip (#2) should appear before base (#1) in the top-down rendering. Search
  // for the pr-number marker specifically — bare "#1"/"#2" also match CSS hex
  // color codes in the <style> block.
  const idx2 = html.indexOf(`class="pr-number">#2`);
  const idx1 = html.indexOf(`class="pr-number">#1`);
  assertEquals(idx2 > 0 && idx1 > 0 && idx2 < idx1, true);
});
