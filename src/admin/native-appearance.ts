import { NATIVE_APPEARANCE_PATH, isNativeAppearanceAssetId, parseNativeAppearanceRequest } from '../contracts/native-appearance.ts';
import { FRAMEWORK_MEDIA_WIRE_BYTES } from '../contracts/framework-media.ts';
import { FrameworkError } from '../core/values.ts';
import { createNativeAppearanceService } from '../host/native-appearance.ts';
import { PrivateJsonStorageError } from '../storage/private-json.ts';
import { AdminRequestError, type AdminRoute } from './server.ts';

async function operation<Value>(run: () => Promise<Value>): Promise<Value> {
  try { return await run(); }
  catch (error) {
    if (error instanceof AdminRequestError) throw error;
    if (error instanceof PrivateJsonStorageError) throw new AdminRequestError(error.statusCode, error.code);
    if (error instanceof FrameworkError) {
      if (['APPEARANCE_INVALID', 'APPEARANCE_IMAGE_INVALID'].includes(error.code)) throw new AdminRequestError(400, error.code.toLowerCase());
      if (['APPEARANCE_NOT_FOUND', 'APPEARANCE_PERSONA_NOT_FOUND'].includes(error.code)) throw new AdminRequestError(404, error.code.toLowerCase());
      if (['APPEARANCE_IN_USE', 'APPEARANCE_CAPACITY', 'APPEARANCE_CHANGED', 'APPEARANCE_BINDING_CHANGED'].includes(error.code)) throw new AdminRequestError(409, error.code.toLowerCase());
    }
    throw new AdminRequestError(503, 'appearance_unavailable');
  }
}
export function createNativeAppearanceRoutes(options: { readonly directory: string; readonly service?: ReturnType<typeof createNativeAppearanceService> }): readonly AdminRoute[] {
  const service = options.service ?? createNativeAppearanceService(options);
  return Object.freeze([
    { method: 'GET', pathname: NATIVE_APPEARANCE_PATH, maxResponseBytes: 2 * FRAMEWORK_MEDIA_WIRE_BYTES,
      async handle({ query, signal }: Parameters<AdminRoute['handle']>[0]) {
        if (query.size === 0) return operation(() => service.snapshot());
        const assetId = query.get('assetId'); const version = query.get('version');
        if (query.size !== 3 || !isNativeAppearanceAssetId(assetId) || version === null || !/^[1-9]\d{0,2}$/.test(version) || Number(version) > 128 || query.get('preview') !== '1') throw new AdminRequestError(400, 'invalid_query');
        return operation(() => service.preview(assetId, Number(version), signal));
      } },
    { method: 'POST', pathname: NATIVE_APPEARANCE_PATH, maxRequestBytes: 2 * FRAMEWORK_MEDIA_WIRE_BYTES,
      async handle({ query, body, signal }: Parameters<AdminRoute['handle']>[0]) {
        const request = parseNativeAppearanceRequest(body);
        if (query.size !== 0 || !request) throw new AdminRequestError(400, 'appearance_invalid');
        return operation(() => service.execute(request, signal));
      } }
  ] as const);
}
