#!/usr/bin/env node
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readNativeAdapterConfiguration } from '../src/admin/native-configuration-repository.ts';
import { createDshAuthenticationOptions } from '../src/adapters/dsh-authentication.ts';
import { createDshJsonRpcPort } from '../src/adapters/dsh-jsonrpc.ts';
import { isRecord } from '../src/core/values.ts';

async function privateText(filename: string): Promise<string> {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 65_536
    || (metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.()) throw new Error('private-file');
  return readFile(filename, 'utf8');
}

async function main(): Promise<void> {
  const [component, ...extra] = process.argv.slice(2);
  if (!['dsh', 'qq', 'image-worker'].includes(component ?? '') || extra.length > 0) throw new Error('arguments');
  const value: unknown = JSON.parse(await privateText(fileURLToPath(new URL('../runtime/live/service-health.json', import.meta.url))));
  if (!isRecord(value) || value.schema !== 1 || typeof value.nativeDirectory !== 'string' || !isAbsolute(value.nativeDirectory)) throw new Error('configuration');
  const signal = AbortSignal.timeout(6_000);
  if (component === 'image-worker') {
    const image = value.imageWorker;
    if (!isRecord(image) || typeof image.url !== 'string' || typeof image.tokenFile !== 'string' || !isAbsolute(image.tokenFile)) throw new Error('configuration');
    const url = new URL(image.url);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password) throw new Error('configuration');
    const token = (await privateText(image.tokenFile)).trim();
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal });
    const body: unknown = await response.json();
    if (!response.ok || !isRecord(body) || body.ok !== true || body.queueOwner !== 'DSH') throw new Error('not-ready');
  } else {
    const configuration = await readNativeAdapterConfiguration(value.nativeDirectory);
    if (component === 'dsh') {
      const adapter = configuration.dshAgent;
      if (!adapter.enabled) throw new Error('disabled');
      const port = createDshJsonRpcPort({ endpoint: adapter.endpoint, ...createDshAuthenticationOptions(adapter), timeoutMs: 5_000 });
      try { await port.verify(signal); } finally { await port.close(); }
    } else {
      const adapter = configuration.onebotHttp;
      if (!adapter.enabled || typeof value.accountId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value.accountId)) throw new Error('configuration');
      const query = async (action: 'get_status' | 'get_login_info'): Promise<Record<string, unknown>> => {
        const response = await fetch(`${adapter.endpoint.replace(/\/+$/, '')}/${action}`, {
          method: 'POST', headers: { Authorization: `Bearer ${adapter.secret}`, 'Content-Type': 'application/json' }, body: '{}', signal,
        });
        const body: unknown = await response.json();
        if (!response.ok || !isRecord(body) || body.status !== 'ok' || body.retcode !== 0 || !isRecord(body.data)) throw new Error('not-ready');
        return body.data;
      };
      const [status, login] = await Promise.all([query('get_status'), query('get_login_info')]);
      if (status.online !== true || status.good === false || String(login.user_id) !== value.accountId) throw new Error('offline');
    }
  }
  console.log(`${component} 已就绪`);
}

void main().catch(() => {
  console.error('服务未就绪或无法核对，请检查连接、登录状态与运维配置。');
  process.exitCode = 1;
});
