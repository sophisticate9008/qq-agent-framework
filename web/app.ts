export {}

type ElementConstructor<T extends Element> = new () => T
type UiMode = 'unverified' | 'demo' | 'gateway-live'

const LIVE_MODE = 'gateway-live'
const LIVE_LABEL = '正式接入 / HTTP出站兼容，旧DSH保留'

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
  environmentBadge: requireElement('#environment-badge', HTMLDivElement),
  environmentLabel: requireElement('#environment-label', HTMLSpanElement),
  pageHeading: requireElement('#page-heading', HTMLHeadingElement),
  modeSummary: requireElement('#mode-summary', HTMLParagraphElement),
  scopeTitle: requireElement('#scope-title', HTMLElement),
  scopePrimary: requireElement('#scope-primary', HTMLElement),
  scopeSecondary: requireElement('#scope-secondary', HTMLElement),
  outboxEyebrow: requireElement('#outbox-eyebrow', HTMLElement),
  overview: requireElement('#overview-content', HTMLDivElement),
  features: requireElement('#features-content', HTMLDivElement),
  context: requireElement('#context-content', HTMLDivElement),
  policy: requireElement('#policy-content', HTMLDivElement),
  outbox: requireElement('#outbox-content', HTMLDivElement),
  audit: requireElement('#audit-content', HTMLDivElement),
  demoNav: requireElement('#demo-nav', HTMLAnchorElement),
  demoPanel: requireElement('#demo', HTMLElement),
  form: requireElement('#demo-form', HTMLFormElement),
  eventType: requireElement('#event-type', HTMLSelectElement),
  conversationId: requireElement('#conversation-id', HTMLInputElement),
  eventText: requireElement('#event-text', HTMLTextAreaElement),
  dispatch: requireElement('#dispatch', HTMLButtonElement),
  demoStatus: requireElement('#demo-status', HTMLElement)
}

let adminToken = ''
let currentMode: UiMode = 'unverified'

function clear(element: Element): void {
  element.replaceChildren()
  element.classList.remove('empty-state')
}

function showEmpty(element: HTMLElement, message: string): void {
  clear(element)
  element.classList.add('empty-state')
  element.textContent = message
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
  const entries: Array<[string, unknown]> = isRecord(overview) ? Object.entries(overview) : []
  if (entries.length === 0) {
    showEmpty(elements.overview, '暂无概览数据')
    return
  }
  clear(elements.overview)
  for (const [label, value] of entries) {
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
  if (!Array.isArray(features) || features.length === 0) {
    showEmpty(elements.features, '暂无功能数据')
    return
  }
  clear(elements.features)
  for (const featureValue of features) {
    const feature = isRecord(featureValue) ? featureValue : {}
    const card = document.createElement('article')
    card.className = 'feature-card'
    const heading = document.createElement('div')
    heading.className = 'feature-heading'
    const title = document.createElement('h3')
    title.textContent = text(feature.id, '未提供功能标识')
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

  const metadata = document.createElement('dl')
  metadata.className = 'definition-list policy-metadata'
  for (const [label, value] of Object.entries(policy)) {
    if (label !== 'paused' && label !== 'grants') addDefinition(metadata, label, value)
  }

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
  elements.policy.append(summary)
  if (metadata.childElementCount > 0) elements.policy.append(metadata)
  elements.policy.append(grants)
}

function renderRecords(container: HTMLDivElement, records: unknown, emptyMessage: string): void {
  if (!Array.isArray(records) || records.length === 0) {
    showEmpty(container, emptyMessage)
    return
  }
  clear(container)
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

function detectMode(snapshot: Record<string, unknown>): UiMode {
  if (snapshot.mode === LIVE_MODE) return 'gateway-live'
  const overview = isRecord(snapshot.overview) ? snapshot.overview : {}
  return overview.mode === 'demo' ? 'demo' : 'unverified'
}

function applyMode(mode: UiMode): void {
  currentMode = mode
  const demo = mode === 'demo'
  elements.demoNav.hidden = !demo
  elements.demoPanel.hidden = !demo
  elements.dispatch.disabled = !demo || !adminToken
  elements.environmentBadge.className = `environment-badge ${mode}`

  if (mode === 'gateway-live') {
    document.title = `QQ Agent Framework · ${LIVE_LABEL}`
    elements.environmentLabel.textContent = LIVE_LABEL
    elements.pageHeading.textContent = '网关运行概览'
    elements.modeSummary.textContent = `${LIVE_LABEL}。当前管理面仅展示网关提供的只读快照。`
    elements.scopeTitle.textContent = '正式接入'
    elements.scopePrimary.textContent = 'HTTP出站兼容'
    elements.scopeSecondary.textContent = '旧DSH保留'
    elements.outboxEyebrow.textContent = 'HTTP outbound'
    return
  }

  if (demo) {
    document.title = 'QQ Agent Framework · Demo Console'
    elements.environmentLabel.textContent = 'Demo · 非生产'
    elements.pageHeading.textContent = '运行概览'
    elements.modeSummary.textContent = '查看独立框架的演示状态，清晰区分能力、上下文、策略与运行记录。'
    elements.scopeTitle.textContent = '首轮范围'
    elements.scopePrimary.textContent = '只读观察与手动演示'
    elements.scopeSecondary.textContent = '不会自动触发或真实外发'
    elements.outboxEyebrow.textContent = 'Demo transport'
    return
  }

  document.title = 'QQ Agent Framework · 管理台'
  elements.environmentLabel.textContent = '等待认证'
  elements.pageHeading.textContent = '管理台'
  elements.modeSummary.textContent = '认证后读取受保护的运行快照并识别当前接入模式。'
  elements.scopeTitle.textContent = '访问范围'
  elements.scopePrimary.textContent = '认证后显示运行信息'
  elements.scopeSecondary.textContent = 'Token 仅驻留当前页面内存'
  elements.outboxEyebrow.textContent = 'Outbound records'
}

function resetSnapshot(): void {
  showEmpty(elements.overview, '认证后显示概览')
  showEmpty(elements.features, '认证后显示功能')
  showEmpty(elements.context, '认证后显示上下文')
  showEmpty(elements.policy, '认证后显示策略')
  showEmpty(elements.outbox, '认证后显示发件箱')
  showEmpty(elements.audit, '认证后显示审计记录')
}

function renderSnapshot(snapshotValue: unknown): void {
  const snapshot = isRecord(snapshotValue) ? snapshotValue : {}
  const mode = detectMode(snapshot)
  applyMode(mode)
  renderOverview(snapshot.overview)
  renderFeatures(snapshot.features)
  renderContext(snapshot.context)
  renderPolicy(snapshot.policy)
  renderRecords(elements.outbox, snapshot.outbox, mode === 'demo' ? '暂无演示消息' : '暂无出站记录')
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
  elements.dispatch.disabled = true
  elements.connectionStatus.textContent = currentMode === 'gateway-live'
    ? '正在刷新正式接入快照…'
    : currentMode === 'demo' ? '正在读取演示快照…' : '正在读取管理快照…'
  try {
    const snapshot = await api('/api/snapshot')
    renderSnapshot(snapshot)
    elements.connectionStatus.textContent = currentMode === 'gateway-live'
      ? `已连接 · ${LIVE_LABEL} · Token 仅驻留页面内存`
      : currentMode === 'demo'
        ? '已连接 · Demo 非生产 · Token 仅驻留页面内存'
        : '已连接 · 只读管理快照 · Token 仅驻留页面内存'
  } catch {
    adminToken = ''
    applyMode('unverified')
    resetSnapshot()
    elements.connectionStatus.textContent = '连接失败，请检查 Token'
  } finally {
    elements.refresh.disabled = !adminToken
    elements.dispatch.disabled = currentMode !== 'demo' || !adminToken
  }
}

elements.connect.addEventListener('click', async () => {
  const value = elements.token.value
  elements.token.value = ''
  if (value.length < 24) {
    adminToken = ''
    applyMode('unverified')
    resetSnapshot()
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
  if (!adminToken || currentMode !== 'demo') return
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
    elements.dispatch.disabled = currentMode !== 'demo' || !adminToken
  }
})

applyMode('unverified')
resetSnapshot()

export {}
