import { NATIVE_ACCOUNTS_PATH, parseNativeLegacyAdoptionPreview } from '../contracts/native-accounts.ts'
import { normalizeAccountScope } from '../core/account-scope.ts'
import { isNativeConfigurationRevisions } from '../contracts/native-revisions.ts'
import { errorCode, isRecord } from '../core/values.ts'
import type { NativeAccounts } from '../host/native-accounts.ts'
import { PrivateJsonStorageError } from '../storage/private-json.ts'
import { AdminRequestError, type AdminRoute } from './server.ts'
function invalid(): never { throw new AdminRequestError(400, 'invalid_account_request') }
function exact(input: Record<string, unknown>, keys: readonly string[]) { return Object.keys(input).length === keys.length && keys.every(key => Object.hasOwn(input, key)) }
/** Account management configures/selects runtimes; it provides no model question or tool approval action. */
export function createNativeAccountRoutes(accounts: NativeAccounts): readonly AdminRoute[] {
  async function operation<Value>(run: () => Value | Promise<Value>): Promise<Value> {
    try { return await run() }
    catch (error) {
      if (error instanceof AdminRequestError) throw error
      if (error instanceof PrivateJsonStorageError) throw new AdminRequestError(error.statusCode, error.code)
      const code = errorCode(error, 'ACCOUNT_UNAVAILABLE')
      if (code === 'ACCOUNT_NOT_FOUND') throw new AdminRequestError(404, code.toLowerCase())
      if (['ACCOUNT_CONFIGURATION_INVALID', 'ACCOUNT_SCOPE_INVALID', 'ACCOUNT_PROTOCOL_INVALID'].includes(code)) invalid()
      if (['ACCOUNT_EXISTS', 'ACCOUNT_ADOPTION_CONFLICT', 'ACCOUNT_LEGACY_REQUIRES_STOPPED', 'ACCOUNT_IDENTITY_UNVERIFIED', 'ACCOUNT_LEGACY_ALREADY_BOUND'].includes(code)) throw new AdminRequestError(409, code.toLowerCase())
      throw new AdminRequestError(503, code.toLowerCase())
    }
  }
  return Object.freeze([
    { method: 'GET', pathname: NATIVE_ACCOUNTS_PATH, handle({ query }: Parameters<AdminRoute['handle']>[0]) { if (query.size) invalid(); return operation(() => accounts.read()) } },
    { method: 'POST', pathname: NATIVE_ACCOUNTS_PATH, maxRequestBytes: 4096,
      handle({ query, body, signal }: Parameters<AdminRoute['handle']>[0]) {
        if (query.size || !isRecord(body)) invalid()
        if ((body.action === 'start' || body.action === 'stop') && typeof body.id === 'string' && typeof body.revision === 'string'
          && exact(body, body.action === 'start' ? ['action', 'id', 'revision', 'revisions'] : ['action', 'id', 'revision'])) {
          if (body.action === 'start' && !isNativeConfigurationRevisions(body.revisions)) invalid()
          const { action, id, revision } = body
          const revisions = action === 'start' ? body.revisions as Readonly<Record<string, string>> : undefined
          return operation(async () => {
            if ((await accounts.read()).revision !== revision) throw new AdminRequestError(409, 'account_revision_conflict')
            if (action === 'start') await accounts.start(id, signal, revisions)
            else await accounts.stop(id, signal)
            return accounts.read()
          })
        }
        if (body.action === 'create' && exact(body, ['action', 'revision', 'label', 'accountScope']) && typeof body.revision === 'string' && typeof body.label === 'string') {
          const { revision, label } = body
          return operation(() => accounts.create({ revision, label, accountScope: normalizeAccountScope(body.accountScope) }, signal))
        }
        if (body.action === 'preview-legacy-adoption' && exact(body, ['action', 'accountScope'])) return operation(() => accounts.previewLegacyAdoption(normalizeAccountScope(body.accountScope)))
        if (body.action === 'adopt-legacy' && exact(body, ['action', 'preview', 'label']) && isRecord(body.preview) && typeof body.label === 'string') {
          const input = parseNativeLegacyAdoptionPreview(body.preview)
          if (!input) invalid()
          const label = body.label
          return operation(() => accounts.adoptLegacy({ preview: input, label }, signal))
        }
        if (body.action === 'reconcile-legacy-adoption' && exact(body, ['action', 'id', 'revision']) && typeof body.id === 'string' && typeof body.revision === 'string') {
          const { id, revision } = body
          return operation(() => accounts.reconcileLegacyAdoption(id, revision, signal))
        }
        invalid()
      } }
  ] as const)
}
