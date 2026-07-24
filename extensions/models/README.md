# @mgreten/stack-status

`stack-status` fetches the review and CI status of a stack of GitHub pull
requests (the kind you get from Graphite-style stacked branches, or any chain
of PRs where each one's base is the previous one's head) and renders it as a
single self-contained HTML flowchart — one node per PR, connected top-to-bottom,
each showing its approval state, reviewer status, and CI pass/fail/pending
summary. Nothing about it is tied to a specific repo, org, or CI provider:
every field is derived at run time from `gh pr view --json ...` output.

It's built for anyone who wants a quick visual read on "where is this stack
at?" without opening five separate PR tabs.

## Installation

```bash
swamp extension pull @mgreten/stack-status
```

## Setup

Create a model instance, optionally pinning a default repo:

```bash
swamp model create @mgreten/stack-status my-stack \
  --global-argument repo="owner/name"
```

The `repo` global argument is optional — every method also accepts a `repo`
argument that overrides it per call, so a single instance can be reused across
repos.

## Usage

### Fetch status for a stack

```bash
swamp model method run my-stack fetch \
  --input stack="12345,12346,12347" \
  --input repo="owner/name"
```

`stack` accepts anything a Graphite-style workflow would paste in:

- a `gt`-pasteable stack markdown block (lines containing `#12345` refs)
- a single Graphite or GitHub PR URL
- comma/space/newline-separated bare PR numbers or URLs

`fetch` resolves the PR numbers, calls `gh pr view` for each one, orders them
bottom (base of the stack) → top (tip) by chaining `baseRefName` to another
PR's `headRefName` (falling back to input order if the chain can't be
resolved), and writes a `stackStatus` bundle plus one `prStatus` resource per
PR.

### Render the HTML flowchart

```bash
swamp model method run my-stack renderHtml \
  --input stack="12345,12346,12347"
```

`renderHtml` looks up the `stackStatus` bundle written by the matching `fetch`
call (same `stack` input) and renders a single self-contained HTML file — no
external stylesheets, fonts, or scripts, light/dark aware via
`prefers-color-scheme`. You can also pass a bundle directly to skip the lookup:

```bash
swamp model method run my-stack renderHtml \
  --input-file bundle.json   # { "bundle": { ...stackStatus shape... } }
```

The simplest way to get an openable file is the `outFile` argument, which writes
the raw HTML straight to disk (in addition to storing the data resource):

```bash
swamp model method run my-stack renderHtml \
  --input stack="12345,12346,12347" \
  --input outFile="/tmp/stack.html"
open /tmp/stack.html
```

The HTML is also always stored as a `stackHtml` data resource. Note its content
is a JSON envelope — extract the `html` field rather than redirecting the raw
`swamp data get` output (which would save the envelope, not an openable page):

```bash
swamp data get my-stack stack-12345-12346-12347-html --json \
  | jq -r '.content.html' > stack.html
```

## Global Arguments

| Argument | Type | Default | Description |
|---|---|---|---|
| `repo` | string | `""` | Default `owner/name` used when a method call omits `repo`. |

## Method: fetch

| Argument | Type | Required | Description |
|---|---|---|---|
| `stack` | string | yes | gt-pasteable stack block, a Graphite/GitHub PR URL, or comma/space/newline-separated PR numbers or URLs. |
| `repo` | string | no | Overrides the instance's default `repo`. |
| `nowIso` | string | no | ISO timestamp to stamp the bundle with (useful for deterministic tests). |

Emits a `stackStatus` resource (the ordered bundle) and one `prStatus`
resource per PR, each containing:

- identity: `number`, `title`, `headRefName`, `baseRefName`, `url`, `isDraft`, `state`
- `approval`: `reviewDecision` (`APPROVED` / `CHANGES_REQUESTED` / `REVIEW_REQUIRED` / `null`), per-reviewer latest states, and pending reviewer logins
- `ci`: a rollup (`SUCCESS` / `FAILURE` / `PENDING` / `NONE`), pass/fail/pending counts, and the names (never logs) of currently-failing checks

## Method: renderHtml

| Argument | Type | Required | Description |
|---|---|---|---|
| `stack` | string | one of `stack`/`bundle` | Same input as `fetch` — used to look up the matching `stackStatus` resource. |
| `bundle` | object | one of `stack`/`bundle` | A `stackStatus` bundle to render directly, bypassing the data lookup. |
| `outFile` | string | no | Filesystem path to also write the raw HTML document to, ready to open in a browser. |

Emits a `stackHtml` resource containing the rendered `html` string, ready to
write to a file or serve.

## How It Works

`stack-status` shells out to the `gh` CLI (must be authenticated in the
environment already) for a single call per PR: `gh pr view <n> --repo <repo>
--json number,title,headRefName,baseRefName,url,isDraft,state,reviewDecision,
reviewRequests,latestReviews,statusCheckRollup,mergeable,mergeStateStatus`.

CI status is derived from `statusCheckRollup`, which mixes two GitHub shapes
(`StatusContext` and `CheckRun`) — the model normalizes both into a single
pass/fail/pending bucket per check. Approval status comes straight from
`reviewDecision` plus the latest review per reviewer in `latestReviews`, with
`reviewRequests` surfaced as pending reviewers who haven't submitted yet.

The stack ordering walks `baseRefName` → `headRefName` chains within the given
PR set to find a single root (a PR whose base isn't another PR in the set) and
follows children from there; any stack that doesn't form one clean chain falls
back to the order PRs appeared in the input.

The HTML template is a plain TypeScript template string with inline CSS (CSS
custom properties swapped via `prefers-color-scheme`) and inline SVG arrow
connectors between nodes — no CDN, no external assets, no JavaScript.

Only names/states/counts are pulled from CI checks and reviews — never log
content or comment bodies — so the rendered output is safe to share.

## License

MIT — see LICENSE for details.
