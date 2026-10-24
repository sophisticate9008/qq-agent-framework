import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BROWSER_DIAGNOSTIC_LIMITS = Object.freeze({
  files: 200,
  entriesPerSuite: 256,
  pngBytes: 10 * 1024 * 1024,
  jsonBytes: 256 * 1024,
  totalBytes: 64 * 1024 * 1024,
  locations: 16
});

const picture = /^[a-zA-Z0-9-]{1,160}\.png$/;
const report = /^(?:(?:result|failure|report)(?:-[0-9TZ-]{1,64})?|terminal)\.json$/;
const suites = [
  { name: 'browser', directory: 'runtime/ui-smoke', png: picture, json: report },
  { name: 'management', directory: 'runtime/management-smoke', png: picture, json: report },
  { name: 'page-navigation', directory: 'runtime/page-navigation-smoke', png: picture, json: report },
  { name: 'activity', directory: 'runtime/activity-smoke', png: picture, json: report },
  { name: 'usage', directory: 'runtime/usage-smoke', png: picture, json: report },
  { name: 'native-chat-ui', directory: 'runtime/native-chat-ui-smoke', png: picture, json: report },
  { name: 'markdown', directory: 'runtime/engineering/validation/006',
    png: /^markdown-page-[0-9]{1,6}\.png$/, json: /^(?:markdown|presentation)-smoke\.json$/ },
  { name: 'presentation', directory: 'runtime/engineering/validation/006/presentation-assets', png: picture, json: /$^/ }
] as const;
const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const errorNames = new Set(['Error', 'AssertionError', 'TimeoutError', 'TypeError', 'FrameworkError', 'RangeError', 'AbortError']);
const publicScripts = new Set(['browser-smoke', 'management-smoke', 'page-navigation-smoke', 'activity-smoke',
  'usage-smoke', 'native-chat-ui-smoke', 'markdown-smoke', 'presentation-smoke', 'virtual-list-perf-smoke']);
const booleanFields = ['fixtureOnly', 'insecureContext', 'randomUUIDFallback', 'allVisibleH2Indexed',
  'navigationDoesNotModifyNativeResources', 'privateRuntimePermissions', 'tokenStoredByBrowserScript',
  'xssExecuted', 'runningApplyBlocked', 'deploymentCapabilityChecked'] as const;
const numberFields = ['pageCount', 'pageErrors', 'externalRequests', 'screenshots'] as const;
const pageNames = ['overview', 'sessions', 'usage', 'persona', 'features', 'access', 'model', 'providers', 'adapters', 'settings'] as const;

type Summary = Record<string, boolean | number | string | readonly string[] | Record<string, number>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
}

export function projectBrowserDiagnostic(value: unknown): Summary {
  const summary: Summary = { diagnosticSummary: true };
  if (!isRecord(value)) return summary;
  for (const key of booleanFields) if (typeof value[key] === 'boolean') summary[key] = value[key];
  for (const key of numberFields) if (isCount(value[key])) summary[key] = value[key];
  for (const key of ['errors', 'pageErrors', 'externalRequests', 'requests', 'postRequests', 'browserPostPaths'] as const) {
    if (Array.isArray(value[key])) summary[`${key}Count`] = value[key].length;
  }
  if (isRecord(value.pageEntryCounts)) {
    const counts: Record<string, number> = {};
    for (const page of pageNames) if (isCount(value.pageEntryCounts[page])) counts[page] = value.pageEntryCounts[page];
    summary.pageEntryCounts = counts;
  }
  for (const key of ['themes'] as const) {
    if (!isRecord(value[key])) continue;
    const flags = Object.values(value[key]).filter(entry => typeof entry === 'boolean');
    summary[key] = { trueFlagCount: flags.filter(entry => entry === true).length,
      falseFlagCount: flags.filter(entry => entry === false).length };
  }
  if (value.status === 'passed' || value.status === 'failed') summary.reportedPassed = value.status === 'passed';
  const error = isRecord(value.error) ? value.error : null;
  const name = error?.name ?? value.error;
  if (typeof name === 'string' && errorNames.has(name)) summary.errorName = name;
  const locations = new Set<string>();
  if (typeof error?.stack === 'string') {
    const pattern = /\b([a-z0-9-]+-smoke)\.(ts|js):([1-9][0-9]{0,6}):([1-9][0-9]{0,4})\b/g;
    for (const match of error.stack.matchAll(pattern)) {
      if (!publicScripts.has(match[1])) continue;
      locations.add(`${match[1]}.${match[2]}:${match[3]}:${match[4]}`);
      if (locations.size === BROWSER_DIAGNOSTIC_LIMITS.locations) break;
    }
  }
  summary.locations = [...locations];
  return summary;
}

async function requireDirectory(directory: string): Promise<void> {
  if (!isAbsolute(directory) || resolve(directory) !== directory) throw new Error('诊断目录必须是规范绝对路径。');
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || await realpath(directory) !== directory) throw new Error('诊断目录不能包含符号链接。');
}

async function readLimitedFile(filename: string, directory: string, limit: number): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(filename);
    if (!before.isFile() || before.nlink !== 1 || before.size > limit || await realpath(dirname(filename)) !== directory) return null;
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || await realpath(filename) !== filename) return null;
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.nlink !== 1) return null;
    return buffer.subarray(0, length);
  } catch { return null; }
  finally { await handle?.close().catch(() => undefined); }
}

export interface BrowserDiagnosticRoots {
  readonly workspace: string;
  readonly runnerTemp: string;
}

export interface BrowserDiagnosticCollection {
  readonly directory: string;
  readonly files: number;
  readonly bytes: number;
  readonly rejected: number;
  readonly entryLimitReached: boolean;
  readonly fileLimitReached: boolean;
  readonly byteLimitReached: boolean;
}

export async function collectBrowserDiagnostics({ workspace, runnerTemp }: BrowserDiagnosticRoots): Promise<BrowserDiagnosticCollection> {
  await requireDirectory(workspace);
  await requireDirectory(runnerTemp);
  const output = join(runnerTemp, 'browser-smoke-diagnostics');
  await mkdir(output, { mode: 0o700 });
  let files = 0;
  let bytes = 0;
  let rejected = 0;
  let entryLimitReached = false;
  let fileLimitReached = false;
  let byteLimitReached = false;
  for (const suite of suites) {
    const directory = join(workspace, suite.directory);
    try { await requireDirectory(directory); } catch { continue; }
    let seen = 0;
    for await (const entry of await opendir(directory)) {
      if (++seen > BROWSER_DIAGNOSTIC_LIMITS.entriesPerSuite) { entryLimitReached = true; break; }
      const isPng = suite.png.test(entry.name);
      if (!isPng && !suite.json.test(entry.name)) continue;
      if (files === BROWSER_DIAGNOSTIC_LIMITS.files) { fileLimitReached = true; break; }
      const perFileLimit = isPng ? BROWSER_DIAGNOSTIC_LIMITS.pngBytes : BROWSER_DIAGNOSTIC_LIMITS.jsonBytes;
      const filename = join(directory, entry.name);
      const metadata = await lstat(filename).catch(() => null);
      if (!metadata?.isFile() || metadata.nlink !== 1 || metadata.size > perFileLimit) { rejected++; continue; }
      const remaining = BROWSER_DIAGNOSTIC_LIMITS.totalBytes - bytes;
      if (metadata.size > remaining) { byteLimitReached = true; rejected++; continue; }
      const contents = await readLimitedFile(filename, directory, Math.min(perFileLimit, remaining));
      if (!contents) { rejected++; continue; }
      let projected: Buffer;
      if (isPng) {
        if (!contents.subarray(0, 8).equals(pngHeader)) { rejected++; continue; }
        projected = contents;
      } else {
        let summary: Summary;
        try { summary = projectBrowserDiagnostic(JSON.parse(contents.toString('utf8')) as unknown); }
        catch { summary = { diagnosticSummary: true, invalidJson: true }; }
        projected = Buffer.from(JSON.stringify(summary, null, 2) + '\n');
      }
      if (bytes + projected.length > BROWSER_DIAGNOSTIC_LIMITS.totalBytes) { byteLimitReached = true; rejected++; continue; }
      await writeFile(join(output, `${suite.name}-${entry.name}`), projected, { flag: 'wx', mode: 0o600 });
      files++;
      bytes += projected.length;
    }
    if (fileLimitReached) break;
  }
  return { directory: output, files, bytes, rejected, entryLimitReached, fileLimitReached, byteLimitReached };
}

export async function runBrowserDiagnosticCollector(argumentsList: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (argumentsList.length === 1 && argumentsList[0] === '--help') {
    console.log('用法：node scripts/collect-browser-diagnostics.ts；仅收集当前工作区固定合成测试目录，输出到 RUNNER_TEMP。');
    return;
  }
  if (argumentsList.length !== 0) throw new Error('诊断收集不接受自定义来源、目标或扫描参数。');
  if (!environment.RUNNER_TEMP) throw new Error('诊断收集需要 RUNNER_TEMP。');
  const result = await collectBrowserDiagnostics({ workspace: process.cwd(), runnerTemp: environment.RUNNER_TEMP });
  console.log(`已收集 ${result.files} 个合成浏览器诊断文件，${result.bytes} 字节；已跳过 ${result.rejected} 个不安全或超限文件。`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await runBrowserDiagnosticCollector(process.argv.slice(2)); }
  catch { console.error('浏览器诊断收集失败；未授权上传其他目录。'); process.exitCode = 1; }
}
