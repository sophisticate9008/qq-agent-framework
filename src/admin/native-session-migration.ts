import type { NativeChatRuntime } from '../host/native-chat-runtime.ts'
import { isRecord, reference } from '../core/values.ts'
import { AdminRequestError, type AdminRoute } from './server.ts'

import { isNativeConfigurationRevisions as validRevisions } from '../contracts/native-revisions.ts'

export function createNativeSessionMigrationRoutes(options: {
  readonly runtime: NativeChatRuntime
  readonly readRevisions: () => Promise<Readonly<Record<string, string>>>
  readonly control: <Result>(operation: () => Promise<Result>) => Promise<Result>
}): readonly AdminRoute[] {
  return [
    {
      method: 'GET', pathname: '/api/chat/sessions/migration',
      async handle({ query, signal }) {
        if (query.size !== 0) throw new AdminRequestError(400, 'invalid_query')
        return options.control(async () => options.runtime.previewSessionMigration(await options.readRevisions(), signal))
      }
    },
    {
      method: 'POST', pathname: '/api/chat/sessions/migrate', maxRequestBytes: 16_384,
      async handle({ query, body, signal }) {
        if (query.size !== 0 || !isRecord(body) || Object.keys(body).length !== 4
          || !Object.keys(body).every(key => ['revisions', 'confirm', 'migrationId', 'revision'].includes(key))
          || body.confirm !== true || !validRevisions(body.revisions)
          || !reference(body.migrationId) || (body.migrationId as string).length > 128
          || typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision)) {
          throw new AdminRequestError(400, 'invalid_session_migration')
        }
        const revisions = body.revisions as Readonly<Record<string, string>>
        const migrationId = body.migrationId as string
        const revision = body.revision
        return options.control(() => options.runtime.migrateSessions({ revisions, confirm: true, migrationId, revision }, signal))
      }
    }
  ]
}
