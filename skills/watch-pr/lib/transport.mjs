import { spawn } from 'node:child_process';

export function commandSpec(executable, args, platform = process.platform) {
  // Azure CLI is commonly az.cmd on Windows. Only the fixed token-exchange
  // arguments use this path; untrusted API paths/bodies never enter a shell.
  if (platform === 'win32' && executable === 'az') {
    if (args.some(arg => !/^[a-zA-Z0-9_.:-]+$/.test(arg))) throw new Error('Unsafe Azure CLI argument.');
    return { executable: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', ['az', ...args].join(' ')] };
  }
  return { executable, args };
}

export function command(executable, args, { input, env = process.env, timeout = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const spec = commandSpec(executable, args);
    const child = spawn(spec.executable, spec.args, { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { child.kill(); finish(Object.assign(new Error('Command timed out.'), { transient: true })); }, timeout);
    child.on('error', () => finish(new Error('Required authenticated CLI is unavailable.')));
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 16 * 1024 * 1024) { child.kill(); finish(new Error('CLI response exceeded limit.')); } });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-65536); });
    child.stdin.on('error', () => {});
    child.on('close', code => code === 0 ? finish(null, { stdout }) : finish(Object.assign(new Error('Provider request failed; check CLI authentication, permissions and API availability.'), {
      notFound: /HTTP 404/.test(stderr), status: Number(stderr.match(/HTTP (\d{3})/)?.[1]) || undefined,
      transient: /rate limit|HTTP (429|5\d\d)|timed? ?out|ECONNRESET|ENOTFOUND/i.test(stderr),
    })));
    child.stdin.end(input);
  });
}

const origins = { github: 'https://api.github.com', gitlab: 'https://gitlab.com/api/v4', bitbucket: 'https://api.bitbucket.org/2.0', azure: 'https://dev.azure.com' };
export function createClient(provider, { execute = command, fetchImpl = fetch, env = process.env, readOnly = false } = {}) {
  const origin = origins[provider];
  if (!origin) throw new Error('Unsupported provider.');
  let azureToken;
  const request = async (method, endpoint, body) => {
    if (readOnly && method !== 'GET') throw new Error('Watcher transport refuses mutations.');
    const url = /^https:/.test(endpoint) ? new URL(endpoint) : new URL(`${origin}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`);
    const base = new URL(origin);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/')) throw new Error('Cross-host or unexpected API path rejected.');
    if (url.username || url.password || url.hash) throw new Error('Credentials/fragments are not allowed in API URLs.');
    if (provider === 'github' || provider === 'gitlab') {
      const apiPath = provider === 'gitlab' ? url.pathname.replace(/^\/api\/v4\//, '') + url.search : url.pathname.slice(1) + url.search;
      const args = ['api', '--hostname', provider === 'github' ? 'github.com' : 'gitlab.com', '-X', method, apiPath, '--include'];
      if (body !== undefined) args.push('--input', '-');
      const result = await execute(provider === 'github' ? 'gh' : 'glab', args, { input: body === undefined ? undefined : JSON.stringify(body),
        env: { ...env, GH_PROMPT_DISABLED: '1', GLAB_PROMPT_DISABLED: '1', GLAB_NO_PROMPT: '1', NO_COLOR: '1' } });
      // --include returns response headers; JSON bodies may contain blank lines.
      const separator = result.stdout.match(/\r?\n\r?\n/);
      if (!separator || !/^HTTP\/[^\r\n]+/.test(result.stdout)) throw new Error('Provider CLI did not return response headers.');
      const headers = Object.fromEntries(result.stdout.slice(0, separator.index).split(/\r?\n/).slice(1).filter(l => l.includes(':')).map(l => {
        const n = l.indexOf(':'); return [l.slice(0, n).toLowerCase(), l.slice(n + 1).trim()];
      }));
      const rawBody = result.stdout.slice(separator.index + separator[0].length);
      const data = rawBody.trim() ? JSON.parse(rawBody) : null;
      if (data?.errors?.length) throw Object.assign(new Error('Provider query failed.'), { transient: data.errors.some(e => /rate.?limit/i.test(`${e.type} ${e.message}`)) });
      return { data, headers };
    }
    let authorization;
    if (provider === 'azure') {
      if (env.AZURE_DEVOPS_EXT_PAT) authorization = `Basic ${Buffer.from(`:${env.AZURE_DEVOPS_EXT_PAT}`).toString('base64')}`;
      else {
        if (!azureToken) azureToken = JSON.parse((await execute('az', ['account', 'get-access-token', '--resource', '499b84ac-1321-427f-aa17-267ca6975798', '-o', 'json'], { env })).stdout).accessToken;
        if (!azureToken) throw new Error('Azure CLI did not provide a DevOps access token.');
        authorization = `Bearer ${azureToken}`;
      }
    } else if (env.BITBUCKET_ACCESS_TOKEN && !env.BITBUCKET_API_TOKEN) authorization = `Bearer ${env.BITBUCKET_ACCESS_TOKEN}`;
    else if (env.BITBUCKET_API_TOKEN && env.BITBUCKET_EMAIL && !env.BITBUCKET_ACCESS_TOKEN) authorization = `Basic ${Buffer.from(`${env.BITBUCKET_EMAIL}:${env.BITBUCKET_API_TOKEN}`).toString('base64')}`;
    else throw new Error('Configure one Bitbucket OAuth token or API token/email binding.');
    const response = await fetchImpl(url, { method, redirect: 'error', signal: AbortSignal.timeout(45000),
      headers: { Authorization: authorization, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw Object.assign(new Error('Provider API request failed; inspect access and rate limits.'), {
      notFound: response.status === 404, status: response.status, transient: response.status === 429 || response.status >= 500,
    });
    const text = await response.text();
    return { data: text ? JSON.parse(text) : null, headers: Object.fromEntries(response.headers.entries()) };
  };
  const protectedRequest = async (...args) => {
    try { return await request(...args); }
    catch (error) {
      const fixed = new Set(['Watcher transport refuses mutations.', 'Cross-host or unexpected API path rejected.',
        'Credentials/fragments are not allowed in API URLs.', 'Configure one Bitbucket OAuth token or API token/email binding.']);
      throw Object.assign(new Error(fixed.has(error.message) ? error.message : 'Provider request failed; check configured access, permissions, response format and API availability.'), {
        notFound: error.notFound === true, status: error.status,
        transient: error.transient === true || ['TimeoutError', 'AbortError'].includes(error.name),
      });
    }
  };
  return {
    async request(method, endpoint, body) { return (await protectedRequest(method, endpoint, body)).data; },
    async pages(endpoint, field) {
      const rows = [], seen = new Set(); let next = endpoint;
      while (next) {
        if (seen.has(next)) throw new Error('Repeated provider pagination cursor.');
        seen.add(next);
        const { data, headers } = await protectedRequest('GET', next);
        const values = field ? data?.[field] : Array.isArray(data) ? data : data?.values ?? data?.value;
        if (!Array.isArray(values)) throw new Error('Incomplete provider page.');
        rows.push(...values);
        if (provider === 'bitbucket') next = data.next ?? null;
        else if (provider === 'azure') {
          const cursor = headers['x-ms-continuationtoken'];
          if (cursor) { const u = new URL(/^https:/.test(endpoint) ? endpoint : origin + endpoint); u.searchParams.set('continuationToken', cursor); next = u.href; } else next = null;
        } else {
          next = headers.link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
          if (!next && provider === 'gitlab' && headers['x-next-page']) {
            const u = new URL(/^https:/.test(endpoint) ? endpoint : origin + endpoint); u.searchParams.set('page', headers['x-next-page']); next = u.href;
          }
        }
      }
      return rows;
    },
  };
}
