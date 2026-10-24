# Native Adapter Configuration

`GET /api/chat/adapters` and `POST /api/chat/adapters` manage the framework's own `chat-adapters.json` in the directory supplied to `createNativeRuntimeRoutes`. The directory is private (`0700`), the document is `0600` and at most 64 KiB. Writes use the same directory queue, exclusive `.chat-runtime.lock`, revision checks, atomic rename and directory sync as the native chat catalogs. No configuration or credentials are discovered from another project.

Saving records desired configuration only. The only native adapters are OneBot HTTP (`onebotHttp`), DSH (`dshAgent`) and the OneBot webhook (`onebotWebhook`); all default to disabled. The current CLI does not mount a native chat host, an adapter manager or an adapter status port. Saving never binds a webhook listener, sends a QQ message, connects an agent or invokes a model.

## API

GET and successful POST return:

```json
{
  "revision": "64 lowercase hexadecimal SHA-256 characters",
  "adapters": {
    "onebotHttp": { "enabled": false, "endpoint": "", "secretConfigured": false },
    "dshAgent": { "enabled": false, "endpoint": "", "authConfigured": false },
    "onebotWebhook": {
      "enabled": false, "host": "127.0.0.1", "port": 0, "selfId": "", "hmacConfigured": false
    }
  },
  "status": { "assembled": false, "running": false, "applyAvailable": false }
}
```

POST accepts `{ revision, adapters }`. `adapters` is a nonempty subset of the three fixed IDs. Each supplied outbound adapter requires `enabled` and `endpoint`; webhook requires `enabled`, `host`, `port`, and `selfId`. Unspecified adapters are preserved. Unknown fields, modules, file paths and executable options are rejected. Query parameters are rejected.

| Adapter | Write-only credential | Explicit deletion flag |
| --- | --- | --- |
| `onebotHttp` | `secret` | `clearSecret` |
| `dshAgent` | `auth` | `clearAuth` |
| `onebotWebhook` | `hmac` | `clearHmac` |

Omitting a credential or sending `""` preserves its stored value. `clearX: true` removes it; supplying a nonempty new credential at the same time is rejected. `clearX: false` does not clear. Credential values are bounded to 4096 printable, non-whitespace ASCII characters. GET and POST responses expose only the configured booleans, never credential contents or masked strings. Configured booleans are read-only and must be omitted from POST.

Example save:

```json
{
  "revision": "revision from GET",
  "adapters": {
    "dshAgent": { "enabled": false, "endpoint": "http://127.0.0.1:3080", "auth": "" }
  }
}
```

Endpoints must be explicit HTTP URLs on literal loopback (`127.x.x.x`, `[::1]`) or `localhost`, or HTTPS URLs. URL credentials, query strings, fragments, whitespace and backslashes are rejected. Endpoint length is at most 2048 characters. Enabled outbound entries require a nonempty endpoint. The external DSH service is selected only by this explicit endpoint; there is no assumed SDK request mapping, preset sync, profile discovery or health probe.

Webhook host is limited to loopback or `localhost`. Disabled webhook may use port `0` and empty self ID. Enabling it requires port `1..65535`, a decimal self ID (up to 32 digits) and a configured HMAC. This is configuration validation, not listener assembly or ingress authorization.

## Custom Extensions and Unsupported Fields

Custom capabilities belong to operator-supplied feature/plugin packages, not the native protocol and agent adapter catalog. Trusted host code registers their implementations through the generic `EffectAdapter` extension boundary; features invoke them through capability-checked execution. The framework does not prescribe a service interface, endpoint, credential schema or workflow for these capabilities. Extension configuration remains outside this native adapter document and cannot grant permissions or bypass policy. This API does not install plugins or load executable modules from JSON.

Unsupported adapter IDs and fields are rejected with `400 invalid_adapter_configuration`, even when disabled or supplied alongside a valid adapter update. If an existing private `chat-adapters.json` contains unsupported fields, both GET and POST return `500 chat_storage_invalid`; validation does not strip fields, reset defaults or rewrite the file. There is no automatic migration. An operator must coordinate with all writers, securely back up the original document and explicitly migrate unsupported configuration according to their own extension's requirements. Preserve the three native adapter entries and their credentials, retain directory/file permissions of `0700`/`0600`, and GET a fresh revision before resuming conditional writes. Do not delete the document or place private backups or credentials in the repository.

## Host Extension

Trusted host code may pass an `adapterRuntime` port to `createNativeRuntimeRoutes`:

```ts
createNativeRuntimeRoutes({
  directory,
  adapterRuntime: {
    status: () => ({ running: manager.isRunning() })
  }
})
```

The optional status-only port is a code-level extension, never JSON configuration. It receives no configuration or credentials. GET and POST read the port's exact `{ running: boolean }` snapshot and then report `assembled: true`. The running snapshot describes the explicitly mounted manager, not whether the latest saved configuration has been applied. POST reads status before committing. Missing port reports unassembled/stopped; a throwing or malformed port returns `503 adapter_runtime_status_unavailable`. There is no apply/start/connect route, and `applyAvailable` remains `false`. The shared `/api/chat/status` still reports the separate chat host as disconnected.

`src/host/adapter-configuration.ts` exports strict private configuration validation, patch merging, safe endpoint validation and public redaction for future host integration. Runtime consumers must explicitly map these values to their chosen adapter APIs and preserve policy checks before external effects.

## Failure Semantics

- `400 invalid_adapter_configuration`: malformed envelope, unsupported fields or invalid settings. Error bodies contain no credentials.
- `400 invalid_query`: query parameters are unsupported.
- `409 chat_revision_conflict`: refresh before deciding whether to retry.
- `409 chat_storage_busy`: another writer holds the directory lock. Abandoned locks require operator inspection; the API never steals them.
- `500 chat_storage_invalid` / `chat_storage_write_failed`: private storage validation or pre-rename write failure.
- `500 chat_write_unknown`: rename succeeded but durability or verification failed. The value may already be visible. Refresh; do not automatically retry.

Conditional-write guarantees require all writers to honor the lock protocol. HTTP cancellation does not cancel or roll back a started storage transaction. A response deadline or disconnect can leave the result unknown; refresh before another write.
