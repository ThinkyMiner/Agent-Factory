// GitHub through the gh CLI: one paginated GraphQL query each for issues and pull requests,
// normalised to the shape in core/types.ts. execFile with argv only, never a shell.
import { execFile } from 'node:child_process'
import { GitHubDataSchema, type GitHubData, type Issue, type Pull } from '../core/types.ts'

export function gh(args: string[], cwd: string, timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, timeout: timeoutMs, maxBuffer: 128 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as { code?: unknown }).code
        reject(new Error(code === 'ENOENT' ? 'gh is not installed' : (stderr || err.message).trim().split('\n')[0]))
      } else resolve(stdout)
    })
  })
}

const LABELS = 'labels(first: 30) { nodes { name } }'
export const ISSUES = `query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 50, after: $endCursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title state stateReason createdAt closedAt url body ${LABELS}
        timelineItems(first: 50, itemTypes: [LABELED_EVENT, UNLABELED_EVENT]) {
          nodes { __typename ... on LabeledEvent { createdAt label { name } } ... on UnlabeledEvent { createdAt label { name } } }
        }
      }
    }
  }
}`
export const PULLS = `query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 30, after: $endCursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title state isDraft headRefName headRefOid createdAt mergedAt closedAt url body ${LABELS}
        autoMergeRequest { enabledAt }
        files(first: 100) { nodes { path additions deletions } }
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 50) { nodes {
          __typename ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state targetUrl }
        } } } } } }
        timelineItems(first: 50, itemTypes: [LABELED_EVENT, UNLABELED_EVENT, AUTO_MERGE_ENABLED_EVENT, AUTO_MERGE_DISABLED_EVENT, MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT]) {
          nodes {
            __typename
            ... on LabeledEvent { createdAt label { name } } ... on UnlabeledEvent { createdAt label { name } }
            ... on AutoMergeEnabledEvent { createdAt } ... on AutoMergeDisabledEvent { createdAt }
            ... on MergedEvent { createdAt } ... on ClosedEvent { createdAt } ... on ReopenedEvent { createdAt }
          }
        }
      }
    }
  }
}`

type Node = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any -- validated by zod after normalising
const TIMELINE: Record<string, string> = {
  LabeledEvent: 'labeled', UnlabeledEvent: 'unlabeled', AutoMergeEnabledEvent: 'auto_merge_enabled', AutoMergeDisabledEvent: 'auto_merge_disabled',
  MergedEvent: 'merged', ClosedEvent: 'closed', ReopenedEvent: 'reopened',
}

async function pages(query: string, owner: string, name: string, cwd: string, key: 'issues' | 'pullRequests', maxPages: number): Promise<Node[]> {
  // --paginate --slurp returns an array of page responses; gh follows $endCursor itself
  const out = await gh(['api', 'graphql', '--paginate', '--slurp', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`], cwd, 60000)
  const parsed = JSON.parse(out) as Node[]
  return parsed.slice(0, maxPages).flatMap((p) => p.data?.repository?.[key]?.nodes ?? [])
}

export function normaliseIssue(n: Node): Issue {
  return {
    number: n.number, title: n.title, state: n.state, stateReason: n.stateReason ?? undefined, labels: (n.labels?.nodes ?? []).map((l: Node) => l.name),
    createdAt: n.createdAt, closedAt: n.closedAt ?? undefined, url: n.url, body: n.body ?? '',
    labelEvents: (n.timelineItems?.nodes ?? [])
      .filter((t: Node) => t?.label)
      .map((t: Node) => ({ label: t.label.name, action: t.__typename === 'LabeledEvent' ? 'added' : 'removed', at: t.createdAt })),
  }
}

export function normalisePull(n: Node): Pull {
  const contexts: Node[] = n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []
  return {
    number: n.number, title: n.title, state: n.state, isDraft: !!n.isDraft, headRefName: n.headRefName, headSha: n.headRefOid ?? '',
    labels: (n.labels?.nodes ?? []).map((l: Node) => l.name), createdAt: n.createdAt, mergedAt: n.mergedAt ?? undefined, closedAt: n.closedAt ?? undefined,
    url: n.url, body: n.body ?? '', autoMerge: !!n.autoMergeRequest,
    files: (n.files?.nodes ?? []).map((f: Node) => ({ path: f.path, additions: f.additions ?? 0, deletions: f.deletions ?? 0 })),
    checks: contexts.map((c) =>
      c.__typename === 'StatusContext'
        ? { name: c.context, status: c.state === 'PENDING' || c.state === 'EXPECTED' ? 'IN_PROGRESS' : 'COMPLETED', conclusion: c.state === 'ERROR' ? 'FAILURE' : c.state, url: c.targetUrl ?? undefined }
        : { name: c.name, status: c.status, conclusion: c.conclusion ?? undefined, url: c.detailsUrl ?? undefined },
    ),
    timeline: (n.timelineItems?.nodes ?? [])
      .filter((t: Node) => t && TIMELINE[t.__typename])
      .map((t: Node) => ({ type: TIMELINE[t.__typename]!, label: t.label?.name, at: t.createdAt })),
  }
}

/** The GitHub repository for a local checkout, from its remote ("owner/name"). */
export async function repoSlug(cwd: string): Promise<string> {
  const out = await gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], cwd)
  const slug = out.trim()
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) throw new Error(`unexpected repository name "${slug}"`)
  return slug
}

export async function fetchGitHub(cwd: string, slug: string, maxPages = 10): Promise<GitHubData> {
  const [owner, name] = slug.split('/') as [string, string]
  const [issues, pulls] = await Promise.all([
    pages(ISSUES, owner, name, cwd, 'issues', maxPages),
    pages(PULLS, owner, name, cwd, 'pullRequests', maxPages),
  ])
  // GitHub's data is input like any other: validate it
  return GitHubDataSchema.parse({ repo: slug, issues: issues.map(normaliseIssue), pulls: pulls.map(normalisePull) })
}
