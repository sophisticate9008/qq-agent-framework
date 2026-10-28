import type { QzoneToolPort } from '../contracts/qzone-tools.ts';
import { createBuiltinPackageContent } from './native-package-content.ts';
import type { NativePackageDefinition } from './native-packages.ts';

export const NATIVE_QZONE_SERVICE_ID = 'qzone';
export const NATIVE_QZONE_SERVICE_VERSION = 1;
const content = createBuiltinPackageContent(import.meta.url, ['../adapters/onebot-qzone-tools', '../adapters/onebot-qzone-http', '../adapters/onebot-qzone', '../contracts/qzone-tools']);
/** Account-local low-level service. The consuming host/plugin chooses how and when to use it. */
export function createQzoneNativePackage(port: QzoneToolPort): NativePackageDefinition {
  return {
    content,
    manifest: { schema: 1, id: NATIVE_QZONE_SERVICE_ID, version: '1.0.0', displayName: '空间说说',
      description: '按协议端实际接口提供发布、删除、读取、评论和点赞等底层操作，供宿主与扩展调用。',
      dependencies: [], provides: [{ id: NATIVE_QZONE_SERVICE_ID, version: NATIVE_QZONE_SERVICE_VERSION }], requires: [], contributions: [] },
    install(context) {
      const service: QzoneToolPort = Object.freeze<QzoneToolPort>({
        describe() { context.signal.throwIfAborted(); return port.describe(); },
        inspect(signal) { context.signal.throwIfAborted(); return port.inspect(AbortSignal.any([signal, context.signal])); },
        execute(request) { context.signal.throwIfAborted(); return port.execute({ ...request, signal: AbortSignal.any([request.signal, context.signal]) }); },
      });
      context.publish(NATIVE_QZONE_SERVICE_ID, NATIVE_QZONE_SERVICE_VERSION, service);
    },
  };
}
