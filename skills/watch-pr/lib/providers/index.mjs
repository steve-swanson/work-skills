import { createClient } from '../transport.mjs';
import { createGitHub } from './github.mjs';
import { createGitLab } from './gitlab.mjs';
import { createBitbucket } from './bitbucket.mjs';
import { createAzure } from './azure.mjs';

export function getAdapter(repository, options = {}) {
  const factory = { github: createGitHub, gitlab: createGitLab, bitbucket: createBitbucket, azure: createAzure }[repository.provider];
  if (!factory) throw new Error('Unsupported cloud provider.');
  return factory({ repository, client: options.client ?? createClient(repository.provider, options), ...options });
}
