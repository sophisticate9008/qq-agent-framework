export {}

type ElementConstructor<T extends Element> = new () => T

function requireElement<T extends Element>(selector: string, constructor: ElementConstructor<T>): T {
  const element = document.querySelector(selector)
  if (!(element instanceof constructor)) throw new Error(`Missing required element: ${selector}`)
  return element
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const elements = {
  token: requireElement('#token', HTMLInputElement),
  connect: requireElement('#connect', HTMLButtonElement),
  refresh: requireElement('#refresh', HTMLButtonElement),
  connectionStatus: requireElement('#connection-status', HTMLElement),
  overview: requireElement('#overview-content', HTMLDivElement),
  features: requireElement('#features-content', HTMLDivElement),
  context: requireElement('#context-content', HTMLDivElement),
  policy: requireElement('#policy-content', HTMLDivElement),
  outbox: requireElement('#outbox-content', HTMLDivElement),
  audit: requireElement('#audit-content', HTMLDivElement),
  form: requireElement('#demo-form', HTMLFormElement),
  eventType: requireElement('#event-type', HTMLSelectElement),
  conversationId: requireElement('#conversation-id', HTMLInputElement),
  eventText: requireElement('#event-text', HTMLTextAreaElement),
  dispatch: requireElement('#dispatch', HTMLButtonElement),
  demoStatus: requireElement('#demo-status', HTMLElement)
}

let adminToken = ''

function clear(element: Element): void {
  element.replaceChildren()
  element.classList.remove('empty-state')
}

function text(value: unknown, fallback = '—'): string {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2) ?? fallback
    } catch {
      return fallback
    }
  }
  return String(value)
}

function addDefinition(container: HTMLDListElement, label: string, value: unknown): void {
  const item = document.createElement('div')
  item.className = 'detail-item'
  const term = document.createElement('dt')
  term.textContent = label
  const description = document.createElement('dd')
  description.textContent = text(value)
  item.append(term, description)
  container.append(item)
}

function renderOverview(overview: unknown): void {
  clear(elements.overview)
  const entries: Array<[string, unknown]> = isRecord(overview) ? Object.entries(overview) : []
  const values: Array<[string, unknown]> = entries.length > 0 ? entries : [['mode', 'demo']]
  for (const [label, value] of values) {
    const card = document.createElement('article')
    card.className = 'metric'
    const name = document.createElement('span')
    name.textContent = label
    const content = document.createElement('strong')
    content.textContent = text(value)
    card.append(name, content)
    elements.overview.append(card)
  }
}

function renderFeatures(features: unknown): void {
  clear(elements.features)
  if (!Array.isArray(features) || features.length === 0) {
    elements.features.classList.add('empty-state')
    elements.features.textContent = '暂无已装配功能'
    return
  }
  for (const featureValue of features) {
    const feature = isRecord(featureValue) ? featureValue : {}
    const card = document.createElement('article')
    card.className = 'feature-card'
    const heading = document.createElement('div')
    heading.className = 'feature-heading'
    const title = document.createElement('h3')
    title.textContent = text(feature.id, '未命名功能')
    const status = document.createElement('span')
    status.className = 'pill'
    status.textContent = text(feature.status, 'unknown')
    heading.append(title, status)
    const version = document.createElement('p')
    version.textContent = `版本 ${text(feature.version)}`
    const capabilities = document.createElement('div')
    capabilities.className = 'tag-row'
    const values: unknown[] = Array.isArray(feature.capabilities) ? feature.capabilities : []
    if (values.length === 0) {
      const tag = document.createElement('span')
      tag.textContent = '无声明能力'
      capabilities.append(tag)
    } else {
      for (const capability of values) {
        const tag = document.createElement('span')
        tag.textContent = text(capability)
        capabilities.append(tag)
      }
    }
    card.append(heading, version, capabilities)
    elements.features.append(card)
  }
}

function renderContext(contextValue: unknown): void {
  clear(elements.context)
  const context = isRecord(contextValue) ? contextValue : {}
  const list = document.createElement('dl')
  list.className = 'definition-list'
  addDefinition(list, '人设', context.persona)
  addDefinition(list, '行为配置', context.configuration)
  addDefinition(list, '偏好', context.preferences)
  addDefinition(list, '来源', context.provenance)
  elements.context.append(list)
}

function renderPolicy(policyValue: unknown): void {
  clear(elements.policy)
  const policy = isRecord(policyValue) ? policyValue : {}
  const paused = policy.paused === true
  const summary = document.createElement('div')
  summary.className = paused ? 'policy-state paused' : 'policy-state active'
  const title = document.createElement('strong')
  title.textContent = paused ? '执行已暂停' : '执行未暂停'
  const detail = document.createElement('span')
  detail.textContent = '权限来自宿主授权，不从上下文或聊天推导'
  summary.append(title, detail)

  const grants = document.createElement('div')
  grants.className = 'grant-list'
  const values: unknown[] = Array.isArray(policy.grants) ? policy.grants : []
  if (values.length === 0) {
    grants.textContent = '暂无授权'
  } else {
    for (const grant of values) {
      const item = document.createElement('div')
      item.className = 'grant-item'
      item.textContent = text(grant)
      grants.append(item)
    }
  }
  elements.policy.append(summary, grants)
}

function renderRecords(container: HTMLDivElement, records: unknown, emptyMessage: string): void {
  clear(container)
  if (!Array.isArray(records) || records.length === 0) {
    container.classList.add('empty-state')
    container.textContent = emptyMessage
    return
  }
  for (const record of records) {
    const item = document.createElement('article')
    item.className = 'record'
    const marker = document.createElement('span')
    marker.className = 'record-marker'
    marker.setAttribute('aria-hidden', 'true')
    const content = document.createElement('pre')
    content.textContent = text(record)
    item.append(marker, content)
    container.append(item)
  }
}

function renderSnapshot(snapshotValue: unknown): void {
  const snapshot = isRecord(snapshotValue) ? snapshotValue : {}
  renderOverview(snapshot.overview)
  renderFeatures(snapshot.features)
  renderContext(snapshot.context)
  renderPolicy(snapshot.policy)
  renderRecords(elements.outbox, snapshot.outbox, '暂无演示消息')
  renderRecords(elements.audit, snapshot.audit, '暂无审计记录')
}

function errorCode(value: unknown): string {
  return isRecord(value) && typeof value.error === 'string' ? value.error : 'request_failed'
}

async function api(path: string, options: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(options.headers)
  headers.set('Authorization', `Bearer ${adminToken}`)
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' })
  let body: unknown = null
  try {
    body = await response.json() as unknown
  } catch {
    body = null
  }
  if (!response.ok) throw new Error(errorCode(body))
  return body
}

async function refreshSnapshot(): Promise<void> {
  elements.refresh.disabled = true
  elements.connectionStatus.textContent = '正在读取演示快照…'
  try {
    const snapshot = await api('/api/snapshot')
    renderSnapshot(snapshot)
    elements.connectionStatus.textContent = '已连接 · Token 仅驻留页面内存'
    elements.dispatch.disabled = false
  } catch {
    elements.connectionStatus.textContent = '连接失败，请检查 Token'
    elements.dispatch.disabled = true
  } finally {
    elements.refresh.disabled = !adminToken
  }
}

elements.connect.addEventListener('click', async () => {
  const value = elements.token.value
  elements.token.value = ''
  if (value.length < 24) {
    adminToken = ''
    elements.connectionStatus.textContent = 'Token 至少需要 24 个字符'
    elements.refresh.disabled = true
    elements.dispatch.disabled = true
    return
  }
  adminToken = value
  await refreshSnapshot()
})

elements.refresh.addEventListener('click', refreshSnapshot)

elements.form.addEventListener('submit', async event => {
  event.preventDefault()
  if (!adminToken) return
  const type = elements.eventType.value === 'trigger.fired' ? 'trigger.fired' : 'message.received'
  const conversationId = elements.conversationId.value.trim()
  const eventText = elements.eventText.value.trim()
  if (!conversationId || !eventText) {
    elements.demoStatus.textContent = '请填写会话标识和演示内容'
    return
  }

  const body = type === 'trigger.fired'
    ? { type, conversationId, data: { kind: 'reminder', text: eventText } }
    : { type, conversationId, data: { text: eventText, directed: true, isSelf: false } }

  elements.dispatch.disabled = true
  elements.demoStatus.textContent = '正在运行本地演示…'
  try {
    await api('/api/demo/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    elements.demoStatus.textContent = '演示事件已处理，无真实外发'
    elements.eventText.value = ''
    await refreshSnapshot()
  } catch {
    elements.demoStatus.textContent = '演示失败，请检查输入或重新连接'
  } finally {
    elements.dispatch.disabled = !adminToken
  }
})

export {}
