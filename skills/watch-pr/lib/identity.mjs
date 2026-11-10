import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const positiveId = value => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));

export function parseRepository(value, { requireRequest = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A canonical cloud repository or request URL is required.');
  let raw = value.trim();
  if (!raw.includes('://') && /^(?:[^@\s]+@)?[^:/\s]+:.+/.test(raw)) raw = `ssh://${raw.replace(':', '/')}`;
  let u;
  try { u = new URL(raw); } catch { throw new Error('Unrecognized repository URL; resolve SSH aliases explicitly.'); }
  if (!['https:', 'ssh:'].includes(u.protocol) || (u.port && !['443', '22'].includes(u.port))) throw new Error('Unsupported repository protocol or port.');
  let segments;
  try { segments = u.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { throw new Error('Invalid repository URL encoding.'); }
  if (segments.some(s => ['.', '..'].includes(s) || /[/\\\0-\x1f]/.test(s))) throw new Error('Invalid repository path.');
  const hostname = u.hostname.toLowerCase();
  let provider, host = hostname, repo, requestId;
  if (hostname === 'github.com' || hostname === 'bitbucket.org') {
    provider = hostname === 'github.com' ? 'github' : 'bitbucket';
    const marker = provider === 'github' ? 'pull' : 'pull-requests';
    if (segments.length === 4 && segments[2] === marker && positiveId(segments[3])) requestId = Number(segments[3]);
    else if (segments.length !== 2) throw new Error('Invalid cloud repository/request path.');
    repo = segments.slice(0, 2).join('/');
  } else if (hostname === 'gitlab.com') {
    provider = 'gitlab'; const index = segments.indexOf('-');
    if (index >= 0) {
      if (index < 2 || segments.length !== index + 3 || segments[index + 1] !== 'merge_requests' || !positiveId(segments[index + 2])) throw new Error('Invalid GitLab merge-request URL.');
      requestId = Number(segments[index + 2]); segments = segments.slice(0, index);
    }
    if (segments.length < 2) throw new Error('GitLab needs a namespace and project.');
    repo = segments.join('/');
  } else if (hostname === 'dev.azure.com' || hostname === 'ssh.dev.azure.com' || /^[a-z0-9-]+\.visualstudio\.com$/.test(hostname)) {
    provider = 'azure'; host = 'dev.azure.com';
    if (hostname === 'ssh.dev.azure.com') {
      if (segments[0] !== 'v3' || segments.length !== 4) throw new Error('Invalid Azure SSH URL.');
      segments = [segments[1], segments[2], '_git', segments[3]];
    } else if (hostname.endsWith('.visualstudio.com')) {
      if (segments[0]?.toLowerCase() === 'defaultcollection') segments.shift();
      segments.unshift(hostname.split('.')[0]);
    }
    if (segments[2] !== '_git' || ![4, 6].includes(segments.length)) throw new Error('Invalid Azure cloud repository URL.');
    if (segments.length === 6) {
      if (segments[4].toLowerCase() !== 'pullrequest' || !positiveId(segments[5])) throw new Error('Invalid Azure pull-request URL.');
      requestId = Number(segments[5]);
    }
    repo = [segments[0], segments[1], segments[3]].join('/');
  } else throw new Error('Unsupported host or unresolved SSH alias; cloud GitHub, GitLab, Bitbucket and Azure DevOps are supported.');
  repo = repo.replace(/\.git$/, '');
  if (repo.split('/').some(s => !s || ['.', '..'].includes(s))) throw new Error('Invalid repository path.');
  if (requireRequest && !requestId) throw new Error('A PR or MR URL with a numeric request ID is required.');
  const parts = repo.split('/');
  const url = provider === 'azure' ? `https://${host}/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/_git/${encodeURIComponent(parts[2])}`
    : `https://${host}/${parts.map(encodeURIComponent).join('/')}`;
  return { provider, host, repo, url, ...(requestId ? { requestId } : {}),
    ...(provider === 'azure' ? { organization: parts[0], project: parts[1], repoName: parts[2] } : {}) };
}

export async function discoverRepository({ cwd, explicitUrl, remoteName, baseBranch, target = false }, execute = exec) {
  if (explicitUrl) return parseRepository(explicitUrl);
  const git = async args => (await execute('git', args, { cwd, encoding: 'utf8', windowsHide: true })).stdout.trim();
  const config = async name => { try { return await git(['config', '--get', name]); } catch { return null; } };
  const branch = baseBranch ?? await git(['branch', '--show-current']);
  const remote = remoteName ?? (target ? await config(`branch.${branch}.remote`)
    : await config(`branch.${branch}.pushRemote`) ?? await config('remote.pushDefault') ?? await config(`branch.${branch}.remote`)) ?? 'origin';
  if (remote === '.') throw new Error('A local upstream does not identify a cloud target repository.');
  try { return parseRepository(await git(['remote', 'get-url', ...(target ? [] : ['--push']), remote])); }
  catch { throw new Error('Cannot resolve cloud repository; provide the intended canonical repository URL or remote.'); }
}

export function requestKey(identity) {
  if (!identity.repositoryId || !positiveId(identity.requestId)) throw new Error('Authoritative repository ID and request ID are required.');
  return { provider: identity.provider, host: identity.host, repositoryId: String(identity.repositoryId), requestId: Number(identity.requestId),
    ...(identity.provider === 'azure' ? { organization: String(identity.organization ?? identity.repo?.split('/')[0] ?? '').toLowerCase() } : {}) };
}

export function requestUrl(repository, requestId = repository.requestId) {
  if (!positiveId(requestId)) throw new Error('A positive request ID is required.');
  const suffix = { github: '/pull/', gitlab: '/-/merge_requests/', bitbucket: '/pull-requests/', azure: '/pullrequest/' }[repository.provider];
  return `${repository.url}${suffix}${requestId}`;
}

export function monitoringMode({ nativeSupported = false, portableAllowed = false, canResumeAgent = false } = {}) {
  return nativeSupported ? 'native' : portableAllowed && canResumeAgent ? 'portable' : 'manual_resume';
}
