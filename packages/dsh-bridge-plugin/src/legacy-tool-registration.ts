import type { ToolRegistrationSource } from './tool-registration.js'

function own(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value as unknown : undefined
}

interface BuiltinTools {
  readonly label: string
  readonly names: readonly string[]
  readonly configurableName?: string
}

/** Compatibility catalog for the pinned DSH 0.2.1-rc.2 registration modules.
 * A matching name alone is insufficient: its module must be loaded in this
 * exact scope. Explicit registration metadata always takes precedence. */
const builtinModules: Readonly<Record<string, BuiltinTools>> = {
  'dsh-tool-bash': { label: '命令执行', names: ['bash'] },
  'dsh-tool-bash-persistent': { label: '持续命令终端', names: ['bash'] },
  'dsh-tool-pwsh': { label: 'PowerShell', names: ['pwsh'] },
  'dsh-tool-pwsh-persistent': { label: '持续 PowerShell 终端', names: ['pwsh'] },
  'dsh-tool-fs': { label: '文件与图片读取', names: ['read', 'write', 'edit', 'read_image'] },
  'dsh-tool-fs-search': { label: '文件搜索', names: ['glob', 'grep'] },
  'dsh-tool-jobs': { label: '后台任务', names: ['job_output', 'job_list', 'job_kill'] },
  'dsh-tool-schedule': { label: '定时任务', names: ['schedule_create', 'schedule_list', 'schedule_delete', 'schedule_update'] },
  'dsh-tool-goal': { label: '目标管理', names: ['get_goal', 'create_goal', 'update_goal'] },
  'dsh-tool-skill': { label: '技能读取', names: ['skill'] },
  'dsh-tool-subagent': { label: '子助手委派', names: ['list_subagent_models'], configurableName: 'subagent' },
  'dsh-tool-subagent-control': { label: '子助手控制', names: ['send_message', 'interrupt_agent'] },
  'dsh-tool-subagent-control/list-agents': { label: '子助手列表', names: ['list_agents'] },
  'dsh-tool-workflow': { label: '工作流', names: [], configurableName: 'workflow' },
  'dsh-tool-ask-user': { label: '用户提问', names: ['ask_user_question'] },
  'dsh-tool-todo': { label: '任务清单', names: ['todo_write'] },
  'dsh-tool-web': { label: '网页搜索与读取', names: ['web_search', 'web_fetch'] },
  'dsh-tool-present': { label: '内容展示', names: ['present'] },
  'dsh-tool-cordis': { label: '运行环境查询', names: ['cordis_inspect_list', 'cordis_inspect_query'] },
  'dsh-tool-working-directory': { label: '工作目录', names: ['working_directory'] },
  'dsh-plugin-manager/tools': { label: '插件管理', names: ['plugin_manager'] },
  'dsh-plan-mode': { label: '计划模式', names: ['exit_plan_mode'] },
  'dsh-mcp-resources': { label: 'MCP 资源读取', names: ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'] },
}

/** Read only public names from an already loaded Loader tree. Never evaluate
 * raw expressions, import a module, connect MCP, or inspect transport secrets. */
export function legacyToolRegistrationReader(tree: unknown): (name: string) => ToolRegistrationSource | undefined {
  const exact = new Map<string, ToolRegistrationSource[]>()
  const servers: { prefix: string; source: ToolRegistrationSource }[] = []
  if (tree && typeof tree === 'object' && 'entries' in tree && typeof tree.entries === 'function') {
    const entries: unknown = tree.entries()
    if (entries && typeof entries === 'object' && Symbol.iterator in entries) {
      let visited = 0
      for (const entry of entries as Iterable<unknown>) {
        if (++visited > 1024) break
        const fiber = own(entry, 'fiber')
        if (own(fiber, 'state') !== 2) continue
        const options = own(entry, 'options')
        const moduleName = own(options, 'name')
        if (typeof moduleName !== 'string') continue
        // Fiber.config is the previously resolved configuration. Reading it
        // cannot evaluate a loader expression or reveal transport credentials.
        const config = own(fiber, 'config') ?? own(options, 'config')
        if (moduleName === '@deepseek-ai/dsh-mcp-client') {
          const serverName = own(config, 'serverName')
          if (typeof serverName !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(serverName) || serverName.includes('__')) continue
          servers.push({ prefix: `mcp__${serverName}__`, source: {
            origin: 'extension', ownerId: `mcp:${serverName}`, ownerName: serverName, transport: 'mcp',
          } })
          continue
        }
        const key = moduleName.startsWith('@deepseek-ai/') ? moduleName.slice('@deepseek-ai/'.length) : ''
        const builtin = Object.hasOwn(builtinModules, key) ? builtinModules[key] : undefined
        if (!builtin) continue
        const source: ToolRegistrationSource = { origin: 'dsh-builtin', ownerId: moduleName, ownerName: builtin.label, transport: 'native' }
        const names = [...builtin.names]
        if (builtin.configurableName) {
          const configured = own(config, 'toolName')
          const name = configured === undefined ? builtin.configurableName : configured
          if (typeof name === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(name)) names.push(name)
        }
        for (const name of names) {
          const candidates = exact.get(name) ?? []
          candidates.push(source)
          exact.set(name, candidates)
        }
      }
    }
  }
  return name => {
    const matches = [...(exact.get(name) ?? []), ...servers.filter(server => name.startsWith(server.prefix)).map(server => server.source)]
    // Duplicate/conflicting live owners are not silently collapsed.
    return matches.length === 1 ? matches[0] : undefined
  }
}
