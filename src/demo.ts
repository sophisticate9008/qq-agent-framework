import { pathToFileURL } from 'node:url';
import { createDemoApplication } from './app.ts';
import { createAdminServer } from './admin/server.ts';
import { assert } from './core/values.ts';

export async function startDemo({ token, port = 3210, host = '127.0.0.1' }:
  { token?: string; port?: number; host?: string } = {}) {
  assert(['127.0.0.1', '::1'].includes(host), 'LOOPBACK_REQUIRED', 'The demo must bind a loopback address.');
  assert(Number.isSafeInteger(port) && port >= 0 && port <= 65535, 'INVALID_PORT', 'The port must be a valid integer.');
  assert(typeof token === 'string' && token.length >= 24, 'INVALID_TOKEN', 'An administrator token is required.');
  const application = createDemoApplication();
  let server: ReturnType<typeof createAdminServer>;
  try {
    server = createAdminServer({ token, snapshot: application.snapshot, dispatchDemo: application.dispatchDemo });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(); });
    });
  } catch (error) { await application.stop(); throw error; }
  const address = server.address();
  assert(address && typeof address !== 'string', 'LISTEN_FAILED', 'No network listener was created.');
  let stopping: Promise<void> | undefined;
  return Object.freeze({
    address,
    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        await new Promise<void>((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          server.closeIdleConnections();
        });
        await application.stop();
      })();
      return stopping;
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startDemo({ token: process.env.BRIDGE_ADMIN_TOKEN, port: Number(process.env.PORT ?? 3210) }).then(demo => {
    console.log(`QQ Bridge Framework 1.5.1 — local demo on 127.0.0.1:${demo.address.port}`);
    console.log('演示模式：无 QQ 连接、无付费模型、无自动触发；管理令牌仅从环境变量读取。');
    const stop = () => demo.stop().catch(() => { process.exitCode = 1; });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }).catch(() => {
    console.error('演示未启动：请检查 BRIDGE_ADMIN_TOKEN（至少24字符）、PORT 与端口可用性。');
    process.exitCode = 1;
  });
}
