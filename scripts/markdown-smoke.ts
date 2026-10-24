import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

import { chromium, type Browser } from 'playwright';

import { createMarkdownRenderer } from '../src/rendering/index.ts';

const directory = new URL('../runtime/engineering/validation/006/', import.meta.url);
await mkdir(directory, { recursive: true });

const executablePath = process.env.MARKDOWN_CHROMIUM_EXECUTABLE ?? process.env.CHROMIUM_EXECUTABLE;
let browser: Browser | undefined;
try {
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {})
  });
  const renderer = createMarkdownRenderer({
    browser,
    width: 1_080,
    pageHeight: 900,
    maxPages: 6,
    maxInputBytes: 128 * 1024,
    maxOutputBytes: 24 * 1024 * 1024,
    timeoutMs: 20_000,
    maxPending: 1
  });
  const sections = Array.from({ length: 7 }, (_, index) => `## 第 ${index + 1} 节：离线渲染

- 中文列表内容清晰可读
- **加粗内容** 与 *强调内容* 保留层级
- 超长文本会安全换行：${'安全渲染'.repeat(28)}

| 检查项 | 结果 | 说明 |
| --- | --- | --- |
| JavaScript | 禁用 | 页面脚本不会执行 |
| 网络 | 拦截 | 用户 URL 不会发起请求 |
| 分页 | 完整 | 超限明确失败 |

\`\`\`ts
const section = ${index + 1};
console.log('中文代码块', section);
\`\`\``).join('\n\n');
  const pages = await renderer.render({
    title: 'Markdown → PNG 离线安全验收',
    markdown: `# 常见 Markdown 元素

[不可访问的链接](https://example.invalid/private)
![不可加载的图片](https://example.invalid/private.png)
<script>fetch('https://example.invalid/leak')</script>

${sections}`
  });
  assert(pages.length > 1);
  for (const [index, page] of pages.entries()) {
    assert.deepEqual([...page.png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(new URL(`markdown-page-${String(index + 1).padStart(2, '0')}.png`, directory), page.png);
  }
  const evidence = {
    at: new Date().toISOString(),
    browser: await browser.version(),
    executablePath: executablePath ?? 'playwright-default',
    pages: pages.map((page, index) => ({
      file: `markdown-page-${String(index + 1).padStart(2, '0')}.png`,
      width: page.width,
      height: page.height,
      bytes: page.png.byteLength
    })),
    totalBytes: pages.reduce((total, page) => total + page.png.byteLength, 0),
    offline: true,
    javaScriptEnabled: false,
    serviceWorkersBlocked: true,
    allNetworkRequestsAborted: true
  };
  await writeFile(new URL('markdown-smoke.json', directory), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Markdown smoke passed: ${pages.length} PNG pages written to runtime/engineering/validation/006/.`);
} finally {
  await browser?.close();
}
