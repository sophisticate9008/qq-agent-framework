export type ModelProviderType = 'openai' | 'anthropic'
export type ModelProviderApi = string

export function modelProviderApi(provider: { readonly type?: ModelProviderType; readonly api?: ModelProviderApi }): ModelProviderApi {
  return provider.api ?? (provider.type === 'openai' ? 'openai-completions' : provider.type === 'anthropic' ? 'anthropic-messages' : '')
}

export function validModelProviderApi(api: unknown): api is ModelProviderApi {
  return typeof api === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(api)
}
