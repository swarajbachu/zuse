#!/usr/bin/env bash
set -euo pipefail
exec /opt/zuse/node/bin/node --input-type=module - <<'JS'
import { readdir, realpath, readFile, writeFile, rename, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { spawnSync } from 'node:child_process';

const output = process.env.ZUSE_SNAPSHOT_RESULT;
const result = { repositories: [], agents: [], truncated: false };
const git = (path, args, timeout = 3000) => spawnSync('git', ['-C', path, ...args], {
  encoding: 'utf8', timeout, maxBuffer: 16384,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never' },
});
try {
  const manifest = JSON.parse(await readFile('/etc/zuse/snapshot.json', 'utf8'));
  const user = userInfo();
  if (manifest.schemaVersion !== 1 || manifest.runtimeUser !== user.username) throw new Error('snapshot-runtime-user-mismatch');
  await access('/opt/zuse/current/bin.mjs', constants.R_OK);
  const metadata = JSON.parse(await readFile('/opt/zuse/current/runtime-metadata.json', 'utf8'));
  if (metadata.snapshotSupportVersion !== 1) throw new Error('snapshot-runtime-update-required');
  result.runtimeHome = user.homedir;
  result.wireProtocolVersion = metadata.wireProtocolVersion;
  const requested = JSON.parse(process.env.ZUSE_SNAPSHOT_PATHS || '[]');
  const candidates = new Set();
  const ignored = new Set(['node_modules', '.git', '.cache', '.npm', '.cargo', '.rustup', '.local', 'proc', 'sys', 'dev']);
  const deadline = Date.now() + 15000;
  let visited = 0;
  async function scan(path, depth) {
    if (depth > 6 || candidates.size >= 32 || ++visited > 20000 || Date.now() > deadline) { result.truncated = true; return; }
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    if (entries.some(entry => entry.name === '.git')) { candidates.add(path); return; }
    for (const entry of entries) if (entry.isDirectory() && !ignored.has(entry.name)) await scan(join(path, entry.name), depth + 1);
  }
  if (requested.length) {
    for (const path of requested) candidates.add(path);
  } else {
    for (const root of [user.homedir, '/workspace', '/workspaces', '/home', '/app', '/srv']) await scan(root, 0);
  }
  const seen = new Set();
  for (const candidate of candidates) {
    const path = await realpath(candidate).catch(() => null);
    if (!path) { if (requested.length) throw new Error('snapshot-repository-invalid'); continue; }
    if (seen.has(path)) continue;
    seen.add(path);
    const usable = await access(path, constants.R_OK | constants.W_OK | constants.X_OK).then(() => true, () => false);
    if (!usable) { if (requested.length) throw new Error('snapshot-repository-not-writable'); continue; }
    const top = git(path, ['rev-parse', '--show-toplevel']);
    if (top.status !== 0 || top.stdout.trim() !== path) { if (requested.length) throw new Error('snapshot-repository-invalid'); continue; }
    const raw = git(path, ['remote', 'get-url', 'origin']).stdout?.trim() ?? '';
    // Return only canonical identity, never userinfo or credential-bearing remotes.
    const match = /^(?:git@github\.com:|https:\/\/(?:[^/@]+@)?github\.com\/|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(raw);
    if (!match) { if (requested.length) throw new Error('snapshot-repository-origin-unsupported'); continue; }
    const identity = `github.com/${match[1].toLowerCase()}/${match[2].toLowerCase()}`;
    if (result.repositories.some(repository => repository.identity === identity)) throw new Error('snapshot-repository-ambiguous');
    const head = git(path, ['rev-parse', '--verify', 'HEAD']).stdout?.trim();
    if (!head) throw new Error('snapshot-repository-empty');
    const remote = git(path, ['ls-remote', 'origin', 'HEAD'], 8000);
    const authFailure = /Authentication failed|could not read Username|Permission denied \(publickey\)|terminal prompts disabled/i.test(remote.stderr ?? '');
    result.repositories.push({ path, identity, url: `https://${identity}.git`, defaultBranch: git(path, ['branch', '--show-current']).stdout?.trim() || 'main', sourceCommit: head, gitAccess: remote.status === 0 ? 'readable' : authFailure ? 'authentication-required' : 'unavailable' });
  }
  // Labels are display-only and bounded; tokens never leave the machine.
  const label = value => typeof value === 'string' && /^[^\0\r\n]{1,120}$/.test(value.trim()) ? value.trim() : undefined;
  const accountOf = (providerId, check) => {
    if (check.status !== 0) return undefined;
    if (providerId === 'claude') {
      try { const status = JSON.parse(check.stdout); return label(status.email ?? status.account?.email ?? status.authMethod); } catch { return undefined; }
    }
    return label(/logged in using (.+)$/im.exec(`${check.stdout}\n${check.stderr}`)?.[1]);
  };
  for (const [providerId, args] of [['claude', ['auth', 'status', '--json']], ['codex', ['login', 'status']]]) {
    const check = spawnSync(providerId, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 16384 });
    // CLI status establishes local configuration, not remote token validity.
    result.agents.push({ providerId, state: check.error?.code === 'ENOENT' ? 'missing-tool' : check.status === 0 ? 'detected' : check.error ? 'unavailable' : 'authentication-required', account: accountOf(providerId, check) });
  }
  const gh = spawnSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8', timeout: 8000, maxBuffer: 16384, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
  const login = gh.stdout?.trim();
  result.github = gh.error?.code === 'ENOENT' ? { state: 'missing-tool' }
    : gh.status === 0 && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login) ? { state: 'authenticated', login }
    : gh.error ? { state: 'unavailable' }
    : { state: /auth|login|401|credentials/i.test(gh.stderr ?? '') ? 'authentication-required' : 'unavailable' };
} catch (error) {
  result.error = /^snapshot-[a-z-]+$/.test(error.message) ? error.message : 'snapshot-inspection-failed';
}
await writeFile(output + '.next', JSON.stringify(result), { mode: 0o600 });
await rename(output + '.next', output);
JS
