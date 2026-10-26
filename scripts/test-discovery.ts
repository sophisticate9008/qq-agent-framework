import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

export const TEST_SUITES = ['all', 'fast', 'deadline', 'integration'] as const;
export type TestSuite = typeof TEST_SUITES[number];

const integrationFiles = new Set([
  'native-chat-runtime', 'native-chat-gateway', 'native-account-gateway', 'native-message-sources-default', 'native-access-default',
  'native-capability-default', 'native-bootstrap-default-path', 'native-bootstrap-example',
  'native-activity-runtime', 'native-configuration-compatibility', 'native-configuration-recovery',
  'native-admission-follow', 'native-control-hooks', 'cli-bootstrap', 'cli-lifecycle',
]);

/** Longer real-time acceptance stays explicit; these tests never become part of the fast suite. */
export function testSuiteFor(filename: string): Exclude<TestSuite, 'all'> {
  const name = filename.replaceAll('\\', '/');
  if (name.endsWith('/native-chat-real-deadline.test.ts') || name.endsWith('/native-chat-real-deadline.test.js')) return 'deadline';
  if (/(?:^|\/)integration\//.test(name) || integrationFiles.has(name.split('/').at(-1)!.replace(/\.test\.(?:ts|js)$/, ''))) return 'integration';
  return 'fast';
}

/** Real deadlines run alone; CLI acceptance builds assets and therefore runs last. */
export function testExecutionBatches(files: readonly string[]): readonly (readonly string[])[] {
  const lifecycle = files.filter(filename => /(?:^|\/)cli-lifecycle\.test\.(?:ts|js)$/.test(filename.replaceAll('\\', '/')));
  const deadline = files.filter(filename => testSuiteFor(filename) === 'deadline');
  const ordinary = files.filter(filename => !lifecycle.includes(filename) && !deadline.includes(filename));
  return [ordinary, deadline, lifecycle].filter(batch => batch.length > 0);
}

export function testConcurrency(value: string | undefined): number {
  if (value === undefined) return 4;
  if (!/^[1-9]\d?$/.test(value) || Number(value) > 32) throw new Error('QQ_TEST_CONCURRENCY must be an integer from 1 to 32');
  return Number(value);
}

export function discoverTestFiles(directory: string, extension: '.ts' | '.js', suite: TestSuite = 'all'): readonly string[] {
  const found: string[] = [];
  function visit(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'fixtures' || entry.name.startsWith('.')) continue;
      const location = join(current, entry.name);
      if (entry.isDirectory()) visit(location);
      else if (entry.isFile() && entry.name.endsWith(`.test${extension}`)
        && (suite === 'all' || testSuiteFor(`/${relative(directory, location)}`) === suite)) found.push(location);
    }
  }
  visit(directory);
  return found.sort();
}
