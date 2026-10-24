import { registerHooks } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function registerBrowserToolchainResolver(directory: string): ReturnType<typeof registerHooks> {
  if (!isAbsolute(directory)) throw new Error('浏览器测试工具目录必须是绝对路径。');
  const parentURL = pathToFileURL(join(directory, 'package.json')).href;
  const moduleRoot = pathToFileURL(join(directory, 'node_modules') + '/').href;
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier !== 'playwright' && specifier !== 'playwright-core'
        && !specifier.startsWith('playwright/') && !specifier.startsWith('playwright-core/')) {
        return nextResolve(specifier, context);
      }
      const result = nextResolve(specifier, { ...context, parentURL });
      if (!result.url.startsWith(moduleRoot)) throw new Error('浏览器测试依赖缺失，请先运行 npm run cli -- install --browser。');
      return result;
    }
  });
}

if (process.env.QQ_AGENT_BROWSER_TOOLCHAIN_ROOT !== undefined) {
  registerBrowserToolchainResolver(process.env.QQ_AGENT_BROWSER_TOOLCHAIN_ROOT);
}
