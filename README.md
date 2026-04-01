# PR Review

Automated AI code review using [Upstash Box](https://upstash.com/docs/box/overall/quickstart) agents. Runs as a GitHub Action across all your repos via a reusable workflow.

## How it works

When a PR is opened, updated, or manually retriggered with a comment:

1. **Skip bots** — Dependabot, Renovate, github-actions are ignored
2. **Skip drafts** — Draft PRs are not reviewed
3. **Filter files** — Lockfiles, images, docs, config, generated files, build output are excluded
4. **Size-based strategy** (based on reviewable lines only):
   - `< 5 lines` → skipped entirely
   - `5–80 lines` → quick single-pass review (Sonnet, 2 min timeout)
   - `80–300 lines` → thorough single-agent review (Sonnet, 5 min timeout)
   - `300+ lines` → parallel multi-agent review: security + logic (Sonnet, 5 min each)
5. **Manual retrigger** — Comment `/review` on the PR to run it again on demand
6. **Post review** — Findings are posted as a GitHub PR review with severity icons

## Setup

### 1. Create a private repo

```bash
git clone <this-repo>
cd pr-review
# Replace emrezeytin in these files:
#   .github/workflows/pr-review.yml
#   caller-workflow.yml
git remote set-url origin git@github.com:emrezeytin/pr-review.git
git push -u origin master
```

### 2. Set org-level secret

Go to your GitHub org Settings → Secrets and variables → Actions → New organization secret:

- Name: `UPSTASH_BOX_API_KEY`
- Value: your key from [Upstash Console](https://console.upstash.com)
- Access: all repos (or selected repos)

`GITHUB_TOKEN` is provided automatically by GitHub Actions.

If the repos being reviewed live in a GitHub organization but `pr-review` lives in a personal account, the reusable workflow repo should be public. A private repo on a personal account is not a good fit for org-owned callers. The org also needs to allow public actions and reusable workflows.

### 3. Add to any repo

Copy `caller-workflow.yml` into the target repo as `.github/workflows/pr-review.yml`.
The reusable workflow reads secrets from the caller repository or org, not from this `pr-review` repo.

```bash
# From the target repo
mkdir -p .github/workflows
curl -o .github/workflows/pr-review.yml \
  https://raw.githubusercontent.com/emrezeytin/pr-review/master/caller-workflow.yml
```

To rerun the review manually on any PR, add a comment containing:

```text
/review
```

To use a different trigger phrase, change the `contains(github.event.comment.body, '/review')` check in `caller-workflow.yml`.

The caller workflow must grant the permissions required by the reusable workflow:

```yml
permissions:
  contents: read
  pull-requests: write
```

It must also pass `pr_url`, which the reusable workflow requires.

The provided caller workflow uses `pull_request_target` instead of `pull_request`. This is required if you want secrets like `UPSTASH_BOX_API_KEY` to be available for forked PRs. GitHub does not pass repository secrets to workflows triggered by `pull_request` from forks.

Pass `UPSTASH_BOX_API_KEY` explicitly in the caller workflow:

```yml
secrets:
  UPSTASH_BOX_API_KEY: ${{ secrets.UPSTASH_BOX_API_KEY }}
```

Do not use `secrets: inherit` for this setup. GitHub only supports `inherit` when the caller and called workflow are in the same organization or enterprise. If you see `Secret UPSTASH_BOX_API_KEY is required, but not provided while calling`, the caller repo either does not have that secret or the workflow is relying on `inherit` across an org/user boundary.

## Cost controls

- **Sonnet, not Opus** — cheaper and fast enough for review
- **Skips** bots, drafts, lockfiles, docs, images, config, generated/build output
- **Trivial PRs** (< 5 lines) skipped entirely
- **Small PRs** get a quick pass, not a deep dive
- **Multi-agent** only for large PRs (300+ lines)
- **Boxes are ephemeral** — created, used, deleted immediately with retry + safe cleanup
- **Line counting is accurate** — only counts additions/deletions in reviewable files

## Customization

Edit `scripts/review-pr.ts`:

- `THRESHOLDS` — adjust line count boundaries for each tier
- `SKIP_EXTENSIONS`, `SKIP_FILES`, `SKIP_DIRECTORIES` — control what gets filtered
- `SKIP_AUTHORS` — add more bot accounts to ignore
- `ROLE_PROMPTS` — add/edit agent roles for multi-agent review
- `ClaudeCode.Sonnet_4_6` — swap model (e.g. `ClaudeCode.Opus_4_6` for deeper reviews)

## Local testing

```bash
export PR_URL=https://github.com/org/repo/pull/42
export GITHUB_TOKEN=ghp_xxx
export UPSTASH_BOX_API_KEY=abx_xxx

npm install
npm run review
```

## Project structure

```
pr-review/
├── .github/workflows/
│   └── pr-review.yml        # Reusable workflow (lives in this repo)
├── scripts/
│   └── review-pr.ts         # Review logic
├── caller-workflow.yml       # Copy this into target repos
├── package.json
├── tsconfig.json
├── .env.example
└── .gitignore
```
