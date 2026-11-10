import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export async function gh(args, execute = exec) {
  try {
    const { stdout } = await execute('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 45000,
      windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
    const value = JSON.parse(stdout);
    if (value.errors?.length) {
      const error = new Error('GitHub GraphQL returned errors.');
      error.transient = value.errors.some(e => e.type === 'RATE_LIMITED' || /rate limit/i.test(e.message ?? ''));
      throw error;
    }
    return value;
  } catch (e) {
    // Do not echo remote content, credentials, or complete CLI stderr.
    const message = String(e.stderr ?? e.message);
    const error = new Error('GitHub request failed; inspect authentication, permissions, or API availability.');
    error.notFound = /HTTP 404/.test(message);
    error.transient = e.transient === true || /rate limit|HTTP (429|5\d\d)|ETIMEDOUT|timed? ?out|ECONNRESET|ENOTFOUND/i.test(message) || e.killed === true;
    throw error;
  }
}

async function pages(api, endpoint, field) {
  const chunks = await api(['api', '--hostname', 'github.com', '--paginate', '--slurp', endpoint]);
  return chunks.flatMap(page => field ? page[field] : page);
}

async function feedback(api, repo, number, field) {
  const selection = field === 'reviewThreads'
    ? 'id isResolved isOutdated comments(last:1){nodes{url updatedAt}}'
    : 'id url updatedAt';
  const [owner, name] = repo.split('/');
  const query = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){${field}(first:100,after:$after){nodes{${selection}} pageInfo{hasNextPage endCursor}}}}}`;
  const result = [];
  let cursor;
  do {
    const args = ['api', '--hostname', 'github.com', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`];
    if (cursor) args.push('-f', `after=${cursor}`);
    const data = await api(args);
    const connection = data.data?.repository?.pullRequest?.[field];
    if (!connection) throw new Error('Incomplete GitHub feedback response.');
    result.push(...connection.nodes);
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    if (connection.pageInfo.hasNextPage && !cursor) throw new Error('Missing GitHub pagination cursor.');
  } while (cursor);
  return result;
}

export async function collectGitHubSnapshot(options, api = gh) {
  const { repo, pr: number, phase } = options;
  const prArgs = ['pr', 'view', String(number), '--repo', `github.com/${repo}`, '--json',
    'url,state,headRefOid,baseRefName,mergeCommit,reviewDecision,mergeStateStatus,isDraft'];
  const pr = await api(prArgs);
  const sha = phase === 'merged' ? pr.mergeCommit?.oid : pr.headRefOid;
  if (phase === 'merged' && (pr.state !== 'MERGED' || !sha)) throw new Error('Merged phase requires a confirmed merge commit.');
  if (!/^[a-f0-9]{40}$/i.test(sha ?? '')) throw new Error('Missing full commit SHA.');
  if (phase === 'open' && pr.state !== 'OPEN') return { ...pr, sha, phase, checks: [], feedback: [], threads: [], expected: [], policyKnown: true };

  let checks, expected = [...options.expected], policyKnown = true;
  let threads = [], notices = [];
  if (phase === 'merged') {
    const runs = await pages(api, `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`, 'workflow_runs');
    // A rebase/fast-forward merge may share the PR head SHA. Exclude PR events.
    const latest = new Map();
    for (const r of runs.filter(r => r.head_sha === sha && r.head_branch === pr.baseRefName &&
      !['pull_request', 'pull_request_target', 'merge_group'].includes(r.event))) {
      const key = r.workflow_id;
      if (!latest.has(key) || r.run_number > latest.get(key).run_number ||
        (r.run_number === latest.get(key).run_number && r.run_attempt > latest.get(key).run_attempt)) latest.set(key, r);
    }
    checks = [...latest.values()].map(r => ({ name: r.name, state: r.status === 'completed' ? r.conclusion : 'pending', url: r.html_url }));
  } else {
    const branch = encodeURIComponent(pr.baseRefName);
    const [runs, statuses, branchInfo] = await Promise.all([
      pages(api, `repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100`, 'check_runs'),
      pages(api, `repos/${repo}/commits/${sha}/statuses?per_page=100`),
      api(['api', '--hostname', 'github.com', `repos/${repo}/branches/${branch}`]),
    ]);
    checks = runs.map(r => ({ name: r.name, appId: r.app?.id, state: r.status === 'completed' ? r.conclusion : 'pending', url: r.html_url }));
    const contexts = new Set();
    for (const s of statuses) {
      if (contexts.has(s.context)) continue; // REST returns newest statuses first.
      contexts.add(s.context); checks.push({ name: s.context, state: s.state, url: s.target_url });
    }
    const rules = await api(['api', '--hostname', 'github.com', '--paginate', '--slurp', `repos/${repo}/rules/branches/${branch}`]);
    expected.push(...rules.flat().filter(r => r.type === 'required_status_checks')
      .flatMap(r => r.parameters.required_status_checks.map(c => ({ name: c.context, appId: c.integration_id }))));
    try {
      const protection = await api(['api', '--hostname', 'github.com', `repos/${repo}/branches/${branch}/protection`]);
      const required = protection.required_status_checks;
      expected.push(...(required?.checks?.length ? required.checks.map(c => ({ name: c.context, appId: c.app_id })) : required?.contexts ?? []));
    } catch (e) {
      if (!e.notFound) throw e;
      // Protected branch plus no visible rules cannot prove a usable policy.
      if (branchInfo.protected && !rules.flat().length) policyKnown = false;
    }
    [threads, ...notices] = await Promise.all([
      feedback(api, repo, number, 'reviewThreads'), feedback(api, repo, number, 'comments'), feedback(api, repo, number, 'reviews'),
    ]);
    notices = notices.flat();
  }
  const current = await api(prArgs);
  if (current.headRefOid !== pr.headRefOid || current.state !== pr.state || current.baseRefName !== pr.baseRefName ||
      current.mergeCommit?.oid !== pr.mergeCommit?.oid) throw new Error('PR moved during observation; take a fresh snapshot.');
  return { ...current, sha, phase, checks, expected, policyKnown, threads, feedback: notices };
}
