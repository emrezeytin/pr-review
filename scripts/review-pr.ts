import { Agent, Box, BoxApiKey, ClaudeCode } from "@upstash/box";
import { z } from "zod";

// ── Env validation ──────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`❌ Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const ENV = {
  prUrl: requireEnv("PR_URL"),
  githubToken: requireEnv("GITHUB_TOKEN"),
  upstashBoxApiKey: requireEnv("UPSTASH_BOX_API_KEY"),
};

// ── Structured output schema ────────────────────────────────────────

const findingSchema = z.object({
  severity: z.enum(["high", "medium", "low"]),
  file: z.string(),
  line: z.number().nullable(),
  issue: z.string(),
  suggestion: z.string(),
});

const reviewSchema = z.object({
  verdict: z.enum(["approved", "changes_requested"]),
  summary: z.string(),
  findings: z.array(findingSchema),
});

type ReviewResult = z.infer<typeof reviewSchema>;

// ── Config ──────────────────────────────────────────────────────────

const SKIP_AUTHORS = [
  "dependabot[bot]",
  "renovate[bot]",
  "github-actions[bot]",
];

const SKIP_EXTENSIONS = new Set([
  ".md", ".mdx", ".txt", ".rst",
  ".yml", ".yaml",
  ".json",
  ".lock", ".toml",
  ".env.example", ".gitignore", ".editorconfig",
  ".prettierrc", ".prettierignore",
  ".eslintignore", ".eslintrc",
  ".npmrc", ".nvmrc", ".node-version",
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".avif",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".map",
]);

const SKIP_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
  "Cargo.lock",
  "poetry.lock",
  "shrinkwrap.json",
  ".DS_Store",
  "Thumbs.db",
]);

const SKIP_DIRECTORIES = [
  "dist/", "build/", "out/", ".next/",
  "node_modules/", "vendor/",
  "__generated__/", "generated/",
  ".git/",
];

const THRESHOLDS = {
  minLines: 5,
  quickReviewMaxLines: 80,
  standardReviewMaxLines: 300,
};

// ── GitHub API helpers ──────────────────────────────────────────────

async function githubApi<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `token ${ENV.githubToken}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "pr-review-bot",
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status} on ${path}: ${body}`);
  }

  return res.json() as Promise<T>;
}

async function fetchAllChangedFiles(
  owner: string,
  repo: string,
  prNumber: number
): Promise<Array<{ filename: string; additions: number; deletions: number; status: string }>> {
  const files: Array<{ filename: string; additions: number; deletions: number; status: string }> = [];
  let page = 1;

  while (true) {
    const batch = await githubApi<Array<{
      filename: string;
      additions: number;
      deletions: number;
      status: string;
    }>>(`/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`);

    files.push(...batch);
    if (batch.length < 100) break;
    page++;
  }

  return files;
}

// ── Helpers ─────────────────────────────────────────────────────────

function shouldSkipFile(filename: string): boolean {
  const basename = filename.split("/").pop()!;
  if (SKIP_FILES.has(basename)) return true;
  if (SKIP_DIRECTORIES.some((dir) => filename.includes(dir))) return true;
  const ext = filename.slice(filename.lastIndexOf("."));
  return SKIP_EXTENSIONS.has(ext);
}

function getRepoDir(repo: string): string {
  return repo.replace(/\.git$/, "");
}

interface PRInfo {
  owner: string;
  repo: string;
  fullName: string;
  number: number;
  base: string;
  head: string;
  author: string;
  isDraft: boolean;
  allFiles: Array<{ filename: string; additions: number; deletions: number; status: string }>;
  reviewableFiles: Array<{ filename: string; additions: number; deletions: number; status: string }>;
  reviewableAdditions: number;
  reviewableDeletions: number;
}

async function getPRInfo(): Promise<PRInfo> {
  const match = ENV.prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) throw new Error(`Invalid PR URL: ${ENV.prUrl}`);

  const [, owner, repo, numberStr] = match;
  const number = parseInt(numberStr, 10);

  const pr = await githubApi<{
    base: { ref: string };
    head: { ref: string };
    user: { login: string };
    draft: boolean;
    additions: number;
    deletions: number;
  }>(`/repos/${owner}/${repo}/pulls/${number}`);

  const allFiles = await fetchAllChangedFiles(owner, repo, number);
  const reviewableFiles = allFiles.filter((f) => !shouldSkipFile(f.filename));

  return {
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    number,
    base: pr.base.ref,
    head: pr.head.ref,
    author: pr.user.login,
    isDraft: pr.draft,
    allFiles,
    reviewableFiles,
    reviewableAdditions: reviewableFiles.reduce((sum, f) => sum + f.additions, 0),
    reviewableDeletions: reviewableFiles.reduce((sum, f) => sum + f.deletions, 0),
  };
}

async function postReview(pr: PRInfo, result: ReviewResult): Promise<void> {
  const header = result.verdict === "approved"
    ? "✅ Approved"
    : "⚠️ Changes Requested";

  let body = `## ${header}\n\n${result.summary}\n`;

  if (result.findings.length > 0) {
    body += "\n### Findings\n\n";
    for (const f of result.findings) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      const icon = f.severity === "high" ? "🔴" : f.severity === "medium" ? "🟡" : "🔵";
      body += `${icon} **[${f.severity.toUpperCase()}]** \`${loc}\`\n`;
      body += `> ${f.issue}\n`;
      body += `> 💡 ${f.suggestion}\n\n`;
    }
  }

  const event = result.verdict === "approved" ? "APPROVE" : "COMMENT";

  await githubApi(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`, {
    method: "POST",
    body: JSON.stringify({ body, event }),
  });
}

// ── Box helpers ─────────────────────────────────────────────────────

async function createBox(): Promise<InstanceType<typeof Box>> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await Box.create({
        runtime: "node",
        agent: {
          provider: Agent.ClaudeCode,
          model: ClaudeCode.Sonnet_4_5,
          apiKey: BoxApiKey.UpstashKey,
        },
        git: { token: ENV.githubToken },
      });
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const delay = attempt * 2000;
      console.warn(`  ⚠ Box creation failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw new Error("Unreachable");
}

async function safeDeleteBox(box: InstanceType<typeof Box>): Promise<void> {
  try {
    await box.delete();
  } catch (err) {
    console.warn(`  ⚠ Failed to delete box: ${err}`);
  }
}

// ── Review prompts ──────────────────────────────────────────────────

const QUICK_PROMPT = (repoDir: string, base: string) => `
Repository path: /work/${repoDir}
Base branch: ${base}

Fetch origin, check out HEAD, and review only the diff from origin/${base}...HEAD.
This is a small PR — keep the review brief and focused.

Flag only: correctness bugs, security issues, obvious performance problems.
Skip: style, formatting, naming, minor improvements.

If everything looks fine, return verdict "approved" with empty findings.
Set "changes_requested" only for genuine bugs or security issues.
`.trim();

const STANDARD_PROMPT = (repoDir: string, base: string) => `
Repository path: /work/${repoDir}
Base branch: ${base}

Fetch both branches from origin, check out the head branch, and review only the code
changed in origin/${base}...HEAD.

Focus on:
- Correctness bugs and logic errors
- Security vulnerabilities (injection, auth bypass, data exposure)
- Performance regressions (N+1 queries, unnecessary re-renders, memory leaks)
- Missing error handling and edge cases

Rules:
- Ignore style-only, formatting, or naming feedback.
- Report only issues caused by changed code, not pre-existing problems.
- Keep each finding concrete and actionable.
- Set verdict to "changes_requested" if there is at least one high severity issue.
- If there are no meaningful issues, return verdict "approved" with empty findings.
`.trim();

const ROLE_PROMPTS = {
  security: (repoDir: string, base: string) => `
Repository path: /work/${repoDir}
Base branch: ${base}

You are a security reviewer. Fetch origin, check out HEAD, and review only the diff
from origin/${base}...HEAD.

Focus exclusively on:
- Injection vulnerabilities (SQL, XSS, command injection)
- Authentication and authorization flaws
- Sensitive data exposure (secrets, tokens, PII in logs)
- Insecure dependencies or configurations
- CSRF, SSRF, path traversal

Ignore all non-security concerns. If the changes are security-clean, return
verdict "approved" with empty findings. Set "changes_requested" only for
genuine security vulnerabilities.
`.trim(),

  logic: (repoDir: string, base: string) => `
Repository path: /work/${repoDir}
Base branch: ${base}

You are a code quality reviewer. Fetch origin, check out HEAD, and review only the
diff from origin/${base}...HEAD.

Focus exclusively on:
- Correctness bugs and logic errors
- Missing error handling and edge cases
- Race conditions and concurrency issues
- Performance regressions (N+1 queries, memory leaks, unnecessary work)
- Broken contracts (API changes without updating callers)

Ignore: style, formatting, naming, documentation. If the code is solid, return
verdict "approved" with empty findings. Set "changes_requested" only for real bugs.
`.trim(),
};

// ── Review strategies ───────────────────────────────────────────────

async function runReview(
  pr: PRInfo,
  prompt: string,
  label: string,
  timeoutMs: number
): Promise<ReviewResult> {
  const box = await createBox();

  try {
    await box.git.clone({
      repo: `https://github.com/${pr.fullName}.git`,
      branch: pr.head,
    });

    const run = await box.agent.run({
      responseSchema: reviewSchema,
      prompt,
      timeout: timeoutMs,
    });

    console.log(`  [${label}] Cost: $${run.cost.totalUsd.toFixed(4)}`);
    return run.result;
  } finally {
    await safeDeleteBox(box);
  }
}

async function quickReview(pr: PRInfo): Promise<ReviewResult> {
  console.log("⚡ Quick review (small PR)");
  const repoDir = getRepoDir(pr.repo);
  return runReview(pr, QUICK_PROMPT(repoDir, pr.base), "quick", 120_000);
}

async function standardReview(pr: PRInfo): Promise<ReviewResult> {
  console.log("🔍 Standard review");
  const repoDir = getRepoDir(pr.repo);
  return runReview(pr, STANDARD_PROMPT(repoDir, pr.base), "standard", 300_000);
}

async function multiAgentReview(pr: PRInfo): Promise<ReviewResult> {
  console.log("🔎 Multi-agent review (large PR)");
  const repoDir = getRepoDir(pr.repo);

  const roles = Object.keys(ROLE_PROMPTS) as Array<keyof typeof ROLE_PROMPTS>;

  const results = await Promise.allSettled(
    roles.map((role) =>
      runReview(pr, ROLE_PROMPTS[role](repoDir, pr.base), role, 300_000)
    )
  );

  // Collect successful results, log failures
  const reviews: ReviewResult[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      reviews.push(result.value);
    } else {
      console.warn(`  ⚠ [${roles[i]}] agent failed: ${result.reason}`);
    }
  }

  if (reviews.length === 0) {
    throw new Error("All review agents failed");
  }

  // Merge findings, deduplicate by file+line+issue
  const allFindings = reviews.flatMap((r) => r.findings);
  const seen = new Set<string>();
  const deduped = allFindings.filter((f) => {
    const key = `${f.file}:${f.line}:${f.issue.slice(0, 50)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const hasHigh = deduped.some((f) => f.severity === "high");

  return {
    verdict: hasHigh ? "changes_requested" : "approved",
    summary: reviews.map((r) => r.summary).filter(Boolean).join("\n\n"),
    findings: deduped,
  };
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const pr = await getPRInfo();

  // Gate 1: Skip bot PRs
  if (SKIP_AUTHORS.includes(pr.author)) {
    console.log(`⏭️  Skipping bot PR by ${pr.author}`);
    return;
  }

  // Gate 2: Skip draft PRs
  if (pr.isDraft) {
    console.log("⏭️  Skipping draft PR");
    return;
  }

  // Gate 3: Skip if no reviewable files
  if (pr.reviewableFiles.length === 0) {
    console.log("⏭️  No reviewable files (only docs, config, or assets)");
    return;
  }

  // Gate 4: Skip trivial PRs
  const reviewableLines = pr.reviewableAdditions + pr.reviewableDeletions;

  if (reviewableLines < THRESHOLDS.minLines) {
    console.log(`⏭️  Trivial PR (${reviewableLines} reviewable lines changed)`);
    return;
  }

  console.log(`📋 PR #${pr.number} by ${pr.author}`);
  console.log(`   ${pr.reviewableFiles.length} reviewable files, ~${reviewableLines} lines changed`);
  console.log(`   (${pr.allFiles.length} total files, ${pr.allFiles.length - pr.reviewableFiles.length} skipped)`);

  // Gate 5: Pick review strategy based on size
  let result: ReviewResult;

  if (reviewableLines <= THRESHOLDS.quickReviewMaxLines) {
    result = await quickReview(pr);
  } else if (reviewableLines <= THRESHOLDS.standardReviewMaxLines) {
    result = await standardReview(pr);
  } else {
    result = await multiAgentReview(pr);
  }

  // Post review to GitHub
  await postReview(pr, result);

  console.log(`\n✅ Review posted: ${result.verdict}`);
  console.log(`   ${result.findings.length} finding(s)`);
}

main().catch((err) => {
  console.error("❌ Review failed:", err);
  process.exit(1);
});
