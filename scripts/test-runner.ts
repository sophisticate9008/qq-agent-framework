import { spawn } from 'node:child_process';
import { basename } from 'node:path';

export interface TestRunOptions {
  readonly concurrency: number;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

export interface TestRunResult {
  readonly files: number;
  readonly failed: number;
  readonly tests: number;
  readonly passed: number;
  readonly skipped: number;
}

/** One process group per file: leaked handles and fixture subprocesses cannot outlive a deadline. */
export async function runTestFiles(files: readonly string[], options: TestRunOptions): Promise<TestRunResult> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 32) throw new Error('Invalid test concurrency');
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid test timeout');
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const active = new Map<() => void, string>();
  let interrupted = false;
  const interrupt = (): void => {
    interrupted = true;
    for (const stop of active.keys()) stop();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const result = { files: 0, failed: 0, tests: 0, passed: 0, skipped: 0 };
  let next = 0;
  let latest = '';
  const began = Date.now();
  const progress = setInterval(() => options.stdout(`测试进度：${result.files}/${files.length} 个文件，失败 ${result.failed}，${Math.round((Date.now() - began) / 1000)} 秒${latest ? `，最近完成 ${latest}` : ''}，正在执行 ${[...active.values()].join('、') || '收尾'}。`), 30_000);
  async function runFile(filename: string): Promise<void> {
    const grouped = process.platform !== 'win32';
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', `--test-timeout=${timeoutMs}`, filename], {
      stdio: ['ignore', 'pipe', 'pipe'], detached: grouped, env: environment, cwd: options.cwd,
    });
    let tail = '';
    const retain = (chunk: Buffer): void => { tail = (tail + chunk.toString('utf8')).slice(-65_536); };
    child.stdout.on('data', retain);
    child.stderr.on('data', retain);
    const stop = (): void => {
      if (child.pid === undefined) return;
      try {
        if (grouped) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
      }
    };
    active.set(stop, basename(filename));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      const hasSummary = /^# tests \d+\r?$/m.test(tail);
      if (code !== 0 || timedOut || !hasSummary) {
        result.failed++;
        options.stderr(`测试文件失败：${filename}${timedOut ? `（超过 ${timeoutMs}ms，已终止进程组）` : `（退出码 ${code}${hasSummary ? '' : '，缺少测试汇总'}）`}\n${tail}`);
      }
      for (const [field, label] of [['tests', 'tests'], ['passed', 'pass'], ['skipped', 'skipped']] as const) {
        const count = [...tail.matchAll(new RegExp(`^# ${label} (\\d+)\\r?$`, 'gm'))].at(-1)?.[1];
        if (count !== undefined) result[field] += Number(count);
      }
    } finally {
      clearTimeout(timer);
      active.delete(stop);
      result.files++;
      latest = basename(filename);
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(options.concurrency, files.length) }, async () => {
      while (!interrupted) {
        const filename = files[next++];
        if (filename === undefined) return;
        await runFile(filename);
      }
    }));
    if (interrupted) throw new Error('测试已中断，已终止活动测试进程组。');
    return result;
  } finally {
    interrupted = true;
    clearInterval(progress);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    for (const stop of active.keys()) stop();
  }
}
