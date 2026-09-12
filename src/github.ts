import { z } from 'zod';
import { PublicError } from './config.js';

const number = z.number().int().positive();
const title = z.string().min(1).max(256);
const body = z.string().max(20000);
const names = z.array(z.string().min(1).max(100)).max(30);
const base = { repository: z.string().min(3) };
const issueFields = { title: title.optional(), body: body.optional(), state: z.enum(['open', 'closed']).optional(), labels: names.optional(), assignees: names.optional(), milestone: number.nullable().optional() };
const milestoneFields = { title: title.optional(), description: body.optional(), state: z.enum(['open', 'closed']).optional(), due_on: z.iso.datetime().nullable().optional() };
export const changeSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...base, operation: z.literal('create_issue'), title, body, labels: names.optional(), assignees: names.optional(), milestone: number.nullable().optional() }),
  z.strictObject({ ...base, operation: z.literal('update_issue'), number, ...issueFields }),
  z.strictObject({ ...base, operation: z.literal('comment'), number, body: body.min(1) }),
  z.strictObject({ ...base, operation: z.literal('create_milestone'), ...milestoneFields, title }),
  z.strictObject({ ...base, operation: z.literal('update_milestone'), number, ...milestoneFields }),
  z.strictObject({ ...base, operation: z.literal('create_pull_request'), title, body, head: z.string().min(1).max(200), base: z.string().min(1).max(200), draft: z.boolean() }),
  z.strictObject({ ...base, operation: z.literal('update_pull_request'), number, title: title.optional(), body: body.optional(), state: z.enum(['open', 'closed']).optional(), base: z.string().min(1).max(200).optional() }),
  z.strictObject({ ...base, operation: z.literal('request_review'), number, reviewers: names.min(1) }),
  z.strictObject({ ...base, operation: z.literal('merge_pull_request'), number, sha: z.string().regex(/^[a-f0-9]{40}$/), merge_method: z.enum(['merge', 'squash', 'rebase']) }),
  z.strictObject({ ...base, operation: z.literal('delete_milestone'), number }),
  z.strictObject({ ...base, operation: z.literal('delete_issue'), number }),
]);
export const bulkIssueUpdateSchema = z.strictObject({
  repository: base.repository,
  updates: z.array(z.strictObject({ number, ...issueFields })).min(1).max(50),
}).superRefine((batch, ctx) => {
  const seen = new Set<number>();
  batch.updates.forEach((update, index) => {
    if (seen.has(update.number)) ctx.addIssue({ code: 'custom', path: ['updates', index, 'number'], message: 'An issue may appear only once per batch.' });
    if (Object.keys(update).length === 1) ctx.addIssue({ code: 'custom', path: ['updates', index], message: 'At least one update field is required.' });
    seen.add(update.number);
  });
});
export type Change = z.infer<typeof changeSchema>;
export const querySchema = z.strictObject({
  repository: z.string(),
  resource: z.enum(['search', 'issues', 'issue', 'issue_fields', 'comments', 'milestones', 'milestone', 'pull_requests', 'pull_request', 'pr_files', 'pr_reviews', 'pr_checks', 'labels', 'branches', 'file']),
  text: z.string().min(1).max(200).optional(), kind: z.enum(['issue', 'pr']).optional(),
  number: number.optional(), state: z.enum(['open', 'closed', 'all']).optional(),
  labels: z.string().max(200).optional(), milestone: z.union([number, z.literal('*'), z.literal('none')]).optional(),
  assignee: z.string().max(100).optional(), page: number.max(100).optional(),
  path: z.string().max(500).optional(), ref: z.string().max(200).optional(),
});
export type Query = z.infer<typeof querySchema>;
export class GitHubError extends PublicError {
  constructor(public status: number) { super(`GitHub rejected the request (HTTP ${status}). Check repository access and the requested fields.`); }
}
export class GitHub {
  constructor(private token: string | (() => Promise<string>), public repositories: string[], private request: typeof fetch = fetch) {}
  private async headers() { return { Authorization: `Bearer ${typeof this.token === 'string' ? this.token : await this.token()}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Erga-Hegemonia', 'Content-Type': 'application/json' }; }
  repo(value: string) {
    const matched = this.repositories.find(r => r.toLowerCase() === value.toLowerCase());
    if (!matched) throw new PublicError('That repository is outside Erga’s configured repository list.');
    return matched;
  }
  async api(repository: string, path: string, method = 'GET', data?: unknown) {
    const repo = this.repo(repository);
    const response = await this.request(`https://api.github.com/repos/${repo}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: await this.headers(),
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    if (!response.ok) throw new GitHubError(response.status);
    return response.status === 204 ? {} : response.json();
  }
  async query(raw: unknown): Promise<unknown> {
    const q = querySchema.parse(raw);
    const repo = this.repo(q.repository);
    const n = () => { if (!q.number) throw new PublicError('An issue, milestone, or pull request number is required.'); return q.number; };
    let path: string;
    switch (q.resource) {
      case 'search': {
        if (!q.text || /[:"\\()]/.test(q.text)) throw new PublicError('Search text must be plain words without GitHub qualifiers, quotes, or parentheses.');
        const terms = q.text.split(/\s+/).filter(Boolean).map(t => `"${t}"`).join(' ');
        const query = [`repo:${repo}`, terms, q.kind ? `is:${q.kind}` : '', q.state && q.state !== 'all' ? `is:${q.state}` : ''].filter(Boolean).join(' ');
        const params = new URLSearchParams({ q: query, per_page: '30', page: String(q.page ?? 1) });
        const response = await this.request(`https://api.github.com/search/issues?${params}`, { headers: await this.headers(), redirect: 'error', signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new GitHubError(response.status);
        const data = await response.json() as { total_count: number; incomplete_results: boolean; items: any[] };
        // Defense in depth: even unexpected search results never cross the repository boundary.
        const items = data.items.filter(i => i.repository_url?.toLowerCase() === `https://api.github.com/repos/${repo}`.toLowerCase());
        return { total_count: data.total_count, incomplete_results: data.incomplete_results, page: q.page ?? 1, possibly_more: data.items.length === 30, data: compact(items) };
      }
      case 'issue': path = `/issues/${n()}`; break;
      case 'issue_fields': path = `/issues/${n()}/issue-field-values`; break;
      case 'comments': path = `/issues/${n()}/comments`; break;
      case 'milestone': path = `/milestones/${n()}`; break;
      case 'pull_request': path = `/pulls/${n()}`; break;
      case 'pr_files': path = `/pulls/${n()}/files`; break;
      case 'pr_reviews': path = `/pulls/${n()}/reviews`; break;
      case 'pr_checks': {
        const pr = await this.api(repo, `/pulls/${n()}`);
        const sha = encodeURIComponent(pr.head.sha);
        return { checks: compact(await this.api(repo, `/commits/${sha}/check-runs?per_page=100&page=${q.page ?? 1}`)), status: compact(await this.api(repo, `/commits/${sha}/status`)) };
      }
      case 'file': {
        if (!q.path || q.path.split('/').some(p => p === '..' || p === '.')) throw new PublicError('Provide a repository-relative file path without traversal.');
        const file = await this.api(repo, `/contents/${q.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(q.ref || 'HEAD')}`);
        if (Array.isArray(file)) return compact(file);
        if (file.encoding !== 'base64' || file.size > 100_000) throw new PublicError('Choose a text file smaller than 100 KB.');
        return { path: file.path, url: file.html_url, sha: file.sha, content: Buffer.from(file.content, 'base64').toString('utf8') };
      }
      default: path = '/' + ({ issues: 'issues', milestones: 'milestones', pull_requests: 'pulls', labels: 'labels', branches: 'branches' }[q.resource]);
    }
    const params = new URLSearchParams({ per_page: '30', page: String(q.page ?? 1) });
    if (['issues', 'milestones', 'pull_requests'].includes(q.resource)) params.set('state', q.state ?? 'open');
    if (q.resource === 'issues') for (const key of ['labels', 'milestone', 'assignee'] as const) if (q[key] !== undefined) params.set(key, String(q[key]));
    const data = await this.api(repo, `${path}?${params}`);
    return { repository: repo, page: q.page ?? 1, possibly_more: Array.isArray(data) && data.length === 30, data: compact(data) };
  }
  async change(raw: unknown) {
    const c = changeSchema.parse(raw);
    const { repository, operation, ...payload } = c;
    const data: Record<string, unknown> = { ...payload };
    const num = 'number' in c ? c.number : undefined;
    delete data.number;
    let path: string, method: string;
    switch (operation) {
      case 'delete_issue': {
        const issue = await this.api(repository, `/issues/${num}`);
        if (issue.pull_request) throw new PublicError('Pull requests cannot be deleted with this operation.');
        const response = await this.request('https://api.github.com/graphql', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000), headers: await this.headers(),
          body: JSON.stringify({ query: 'mutation($id: ID!) { deleteIssue(input: {issueId: $id}) { clientMutationId } }', variables: { id: issue.node_id } }),
        });
        if (!response.ok) throw new GitHubError(response.status);
        const result = await response.json() as { errors?: unknown[]; data?: { deleteIssue?: unknown } };
        if (result.errors?.length || !result.data?.deleteIssue) throw new PublicError('GitHub did not confirm deletion. Check the issue and App permissions before trying again.');
        return { deleted: true, number: num, repository };
      }
      case 'delete_milestone': path = `/milestones/${num}`; method = 'DELETE'; break;
      case 'create_issue': path = '/issues'; method = 'POST'; break;
      case 'update_issue': path = `/issues/${num}`; method = 'PATCH'; break;
      case 'comment': path = `/issues/${num}/comments`; method = 'POST'; break;
      case 'create_milestone': path = '/milestones'; method = 'POST'; break;
      case 'update_milestone': path = `/milestones/${num}`; method = 'PATCH'; break;
      case 'create_pull_request': path = '/pulls'; method = 'POST'; break;
      case 'update_pull_request': path = `/pulls/${num}`; method = 'PATCH'; break;
      case 'request_review': path = `/pulls/${num}/requested_reviewers`; method = 'POST'; break;
      case 'merge_pull_request': path = `/pulls/${num}/merge`; method = 'PUT'; break;
    }
    return compact(await this.api(repository, path, method, data));
  }
}

// Exclude large nested repository/user objects and credentials from tool results.
const fields = new Set('number title body state html_url url name login description color due_on open_issues closed_issues milestone labels assignees user pull_request draft merged merged_at mergeable mergeable_state head base ref sha requested_reviewers updated_at created_at filename status conclusion patch additions deletions changes commit_id submitted_at event check_runs total_count statuses context target_url details_url path type size default_branch full_name message issue_field_values issue_field_id issue_field_name data_type value single_select_option multi_select_options'.split(' '));
export function compact(value: any, depth = 0): any {
  if (typeof value === 'string') return value.length > 12_000 ? value.slice(0, 12_000) + '\n[truncated]' : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth > 5) return undefined;
  if (Array.isArray(value)) return value.slice(0, 100).map(v => compact(v, depth + 1));
  return Object.fromEntries(Object.entries(value).filter(([k]) => fields.has(k)).map(([k, v]) => [k, compact(v, depth + 1)]));
}
