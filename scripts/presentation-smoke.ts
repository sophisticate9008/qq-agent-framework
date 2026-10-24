import assert from 'node:assert/strict';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser } from 'playwright';

import { createOneBotTransport } from '../src/adapters/onebot.ts';
import { normalizeContent } from '../src/core/content.ts';
import { createContextStore } from '../src/core/context.ts';
import type { JsonValue } from '../src/core/types.ts';
import { FrameworkError } from '../src/core/values.ts';
import { createBridgeHost } from '../src/host/bridge.ts';
import { createPresentationEffect, createPresentationService } from '../src/host/presentation.ts';
import { createRenderedAssetPublisher } from '../src/host/rendered-assets.ts';
import { createResourceRegistry } from '../src/host/resources.ts';
import type { AgentAdapter } from '../src/host/types.ts';
import { createMarkdownRenderer } from '../src/rendering/index.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

const validationDirectory = fileURLToPath(new URL('../runtime/engineering/validation/006/', import.meta.url));
const assetDirectory = join(validationDirectory, 'presentation-assets');
const conversationId = 'group:9001';
const personaId = 'presentation-smoke';
const personaVersion = '1.0.0';
const personaKey = `${personaId}@${personaVersion}`;
const executablePath = process.env.MARKDOWN_CHROMIUM_EXECUTABLE ?? process.env.CHROMIUM_EXECUTABLE;

await mkdir(validationDirectory, { recursive: true });

const agent: AgentAdapter = {
  async createSession() { return { sessionId: 'presentation-smoke-unused' }; },
  async submit() { return { status: 'accepted' }; },
  async follow() { return () => undefined; }
};

let browser: Browser | undefined;
let host: ReturnType<typeof createBridgeHost> | undefined;
const store = createSqliteStore({ filename: ':memory:' });
try {
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {})
  });
  const renderer = createMarkdownRenderer({
    browser,
    width: 1_080,
    pageHeight: 1_200,
    maxPages: 6,
    maxInputBytes: 128 * 1024,
    maxOutputBytes: 24 * 1024 * 1024,
    timeoutMs: 20_000,
    maxPending: 1
  });
  const registry = createResourceRegistry({
    store,
    rootDirectory: validationDirectory,
    maxFileBytes: 24 * 1024 * 1024
  });
  const publisher = createRenderedAssetPublisher({
    registry,
    directory: assetDirectory,
    maxFiles: 64,
    maxFileBytes: 24 * 1024 * 1024
  });
  const httpCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const resolutions: Array<{ assetId: string; conversationId: string; persona?: string; file: string }> = [];
  const transport = createOneBotTransport({
    endpoint: 'http://onebot.invalid/api',
    persona: personaKey,
    resolveAsset(request) {
      const file = registry.resolve({
        assetId: request.assetId,
        type: request.type,
        conversationId: request.conversationId,
        ...(request.persona === undefined ? {} : { persona: request.persona }),
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        ...(request.generation === undefined ? {} : { generation: request.generation })
      });
      resolutions.push({
        assetId: request.assetId,
        conversationId: request.conversationId,
        ...(request.persona === undefined ? {} : { persona: request.persona }),
        file
      });
      return { file };
    },
    async fetch(input, init = {}) {
      assert.equal(init.signal?.aborted, false);
      httpCalls.push({
        url: String(input),
        body: JSON.parse(String(init.body)) as Record<string, unknown>
      });
      return new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 88001 } }), {
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  const presentation = createPresentationService({
    capabilities: transport.capabilities!(),
    renderer,
    publishImage: request => publisher.publish(request),
    timeoutMs: 25_000,
    maxPending: 1
  });
  const context = createContextStore();
  const persona = context.registerPersona({
    id: personaId,
    version: personaVersion,
    name: 'Presentation Smoke Persona',
    identity: { role: 'offline validation' },
    style: { tone: 'plain' }
  });
  host = createBridgeHost({
    store,
    agent,
    transport,
    context,
    persona,
    authorizeIncoming: () => true,
    replyTimeoutNotice: null,
    taskTickMs: 60_000,
    eventTimeoutMs: 30_000,
    eventValidators: {
      'presentation.requested': data => typeof data.body === 'string' && data.body.length > 0
        && data.format === 'markdown-image'
    },
    effectAdapters: {
      'presentation.prepare': createPresentationEffect(presentation)
    }
  });
  host.engine.install({
    id: 'presentation-smoke',
    version: '1.0.0',
    apiVersion: 1,
    capabilities: ['presentation.prepare', 'messaging.send'],
    subscriptions: ['presentation.requested'],
    setup(services) {
      services.on('presentation.requested', async (execution, event) => {
        const prepared = await execution.invoke('presentation.prepare', event.data);
        const value = prepared as { content?: JsonValue };
        const receipt = await execution.send(normalizeContent(value.content));
        if (receipt.status !== 'confirmed') {
          throw new FrameworkError(receipt.status === 'rejected' ? 'DELIVERY_REJECTED' : 'DELIVERY_UNKNOWN',
            'Presentation smoke delivery was not confirmed.');
        }
      });
    }
  });
  host.policy.grant({
    id: 'presentation-smoke-grant',
    featureId: 'presentation-smoke',
    conversationId,
    capabilities: ['presentation.prepare', 'messaging.send'],
    maxUses: { 'presentation.prepare': 1, 'messaging.send': 1 }
  });

  const report = await host.engine.emit({
    id: 'presentation-smoke-event',
    type: 'presentation.requested',
    conversationId,
    data: {
      body: `# 中文工程验收报告

本文件由真实 Chromium 离线渲染，经资源目录审批后编码为 OneBot 图片段。

| 检查项 | 状态 | 说明 |
| --- | --- | --- |
| Markdown 渲染 | 通过 | 标题、表格、列表和代码块可读 |
| PNG 发布 | 通过 | 文件权限和 PNG 结构受校验 |
| 资源作用域 | 通过 | 会话与 persona 版本匹配 |
| OneBot 编码 | 通过 | 只调用本地 fake fetch |

## 示例代码

\`\`\`ts
const result = await presentation.prepare({
  format: 'markdown-image',
  body: '安全的中文文档'
});
\`\`\`

- 不调用真实 QQ
- 不调用真实模型
- 不自动附加 reply
- 所有网络请求均被渲染器拒绝`,
      title: 'Presentation 全链路离线 Smoke',
      format: 'markdown-image',
      purpose: 'document',
      fallback: 'none',
      reply: 'auto'
    }
  });

  assert.deepEqual(report.outcomes, [{ featureId: 'presentation-smoke', status: 'completed' }]);
  assert.equal(httpCalls.length, 1);
  assert.equal(httpCalls[0]?.url, 'http://onebot.invalid/api/send_group_msg');
  const oneBotMessage = httpCalls[0]?.body.message;
  assert(Array.isArray(oneBotMessage) && oneBotMessage.length > 0);
  assert(oneBotMessage.every(segment => segment !== null && typeof segment === 'object'
    && !Array.isArray(segment) && segment.type === 'image'));
  assert.doesNotMatch(JSON.stringify(oneBotMessage), /reply/);
  assert(resolutions.length > 0 && resolutions.every(resolution => resolution.persona === personaKey
    && resolution.conversationId === conversationId));
  const resources = registry.list();
  assert(resources.length === resolutions.length && resources.every(resource => resource.status === 'approved'
    && resource.scope === conversationId && resource.persona === personaKey));
  const files = await Promise.all((await readdir(assetDirectory)).filter(name => name.endsWith('.png')).map(async name => {
    const information = await stat(join(assetDirectory, name));
    return { name, bytes: information.size, mode: information.mode & 0o777 };
  }));
  const evidence = {
    at: new Date().toISOString(),
    browser: await browser.version(),
    executablePath: executablePath ?? 'playwright-default',
    event: report,
    policy: host.policy.describe().grants.find(grant => grant.id === 'presentation-smoke-grant'),
    outbox: host.outbox.list(),
    resources,
    publishedFiles: files,
    resolutions: resolutions.map(resolution => ({
      assetId: resolution.assetId,
      conversationId: resolution.conversationId,
      persona: resolution.persona,
      file: basename(resolution.file)
    })),
    oneBot: httpCalls[0],
    externalHttpCalls: 0,
    modelCalls: 0,
    automaticReplySegments: 0
  };
  await writeFile(join(validationDirectory, 'presentation-smoke.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Presentation smoke passed: ${resources.length} approved PNG asset(s), one fake OneBot call.`);
} finally {
  if (host) await host.stop();
  store.close();
  await browser?.close();
}
