import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

export const TEST_SUITES = ['all', 'fast', 'deadline', 'integration', 'artifacts'] as const;
export type TestSuite = typeof TEST_SUITES[number];

/** Suites partition source and compiled tests identically, including real-clock and asset checks. */
export function testSuiteFor(filename: string): Exclude<TestSuite, 'all'> {
  const name = filename.replaceAll('\\', '/');
  const stem = name.split('/').at(-1)!.replace(/\.test\.(?:ts|js)$/, '');
  if (stem === 'native-chat-real-deadline' || stem === 'admin-deadline') return 'deadline';
  if (['cli-lifecycle', 'admin-chunks', 'admin', 'app'].includes(stem)) return 'artifacts';
  if (/(?:^|\/)integration\//.test(name) || stem.startsWith('native-') || stem === 'cli-bootstrap') return 'integration';
  return 'fast';
}

export interface TestShard {
  readonly index: number;
  readonly total: number;
}

export function parseTestShard(value: string): TestShard {
  const match = /^([1-9]\d?)\/([1-9]\d?)$/.exec(value);
  if (!match || Number(match[1]) > Number(match[2]) || Number(match[2]) > 32) {
    throw new Error('--shard 必须为 序号/总数，满足 1 ≤ 序号 ≤ 总数 ≤ 32');
  }
  return { index: Number(match[1]), total: Number(match[2]) };
}

/** Sort before distributing so discovery order cannot duplicate or omit files across workers. */
export function shardTestFiles(files: readonly string[], shard?: TestShard): readonly string[] {
  if (!shard) return files;
  return [...files].sort().filter((_, index) => index % shard.total === shard.index - 1);
}

export function testNeedsBuild(suite: TestSuite, built: boolean): boolean {
  return built || suite === 'all' || suite === 'artifacts';
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
