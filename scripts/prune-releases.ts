import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { isRecord } from '../src/core/values.ts';

const apply = process.argv.slice(2).includes('--apply');
assert(process.argv.slice(2).every(arg => arg === '--apply'));
const gh = (...args: string[]) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const repo = process.env.GITHUB_REPOSITORY ?? gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner').trim();
assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo));
const latest: unknown = JSON.parse(gh('api', `repos/${repo}/releases/latest`));
assert(isRecord(latest) && latest.draft === false && latest.prerelease === false && typeof latest.tag_name === 'string'
  && /^v\d+\.\d+\.\d+$/.test(latest.tag_name) && typeof latest.id === 'number' && Array.isArray(latest.assets));
const version = latest.tag_name.slice(1);
const names = [`qq-bridge-framework-sdk-${version}.tgz`, `qq-bridge-framework-dsh-bridge-plugin-${version}.tgz`];
for (const name of [...names, 'SHA256SUMS']) assert(latest.assets.some(asset => isRecord(asset) && asset.name === name && asset.state === 'uploaded' && Number(asset.size) > 0));
// Verify the remaining release's actual downloads before deleting any prior release.
const temporary = await mkdtemp(join(tmpdir(), 'qqbridge-release-retention-'));
try {
  gh('release', 'download', latest.tag_name, '--repo', repo, '--dir', temporary, '--pattern', '*.tgz', '--pattern', 'SHA256SUMS');
  const sums = (await readFile(join(temporary, 'SHA256SUMS'), 'utf8')).trim().split('\n');
  for (const name of names) {
    const hash = createHash('sha256').update(await readFile(join(temporary, name))).digest('hex');
    assert(sums.includes(`${hash}  ${name}`), 'Latest release checksum mismatch');
  }
  const pages: unknown = JSON.parse(gh('api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`));
  assert(Array.isArray(pages) && pages.every(Array.isArray));
  const old = pages.flat().filter((release: unknown) => isRecord(release) && release.id !== latest.id && release.draft === false);
  for (const release of old) {
    assert(isRecord(release) && typeof release.id === 'number' && typeof release.tag_name === 'string');
    // Recheck the authoritative latest pointer before each destructive operation.
    assert(Number(gh('api', `repos/${repo}/releases/latest`, '--jq', '.id').trim()) === latest.id, 'Latest release changed');
    console.log(`${apply ? 'Removing' : 'Would remove'} release ${release.tag_name}`);
    if (apply) gh('api', '--method', 'DELETE', `repos/${repo}/releases/${release.id}`);
  }
  console.log(`Keep ${latest.tag_name}; ${old.length} older releases${apply ? ' removed' : ' eligible'}. Git tags are retained.`);
} finally { await rm(temporary, { recursive: true, force: true }); }
