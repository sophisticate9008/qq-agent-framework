# 管理界面与扩展约定

管理台使用 React、shadcn/ui（Base UI）、Tailwind CSS 和 Vite，构建结果作为本地静态资源由管理服务提供。界面是中文配置工作台，不是独立替换 QQ、DSH 或旧 bridge 的新宿主。

框架只提供通用管理页面范式、共享组件和受控接线边界，不继续内置具体业务包的管理 UI。业务方或 AI 可以按本页模板编写页面，但页面及其 API 必须作为可信源码接受审核、构建并由装配根显式接入。

## 页面结构

侧栏固定提供六个页面：

| 页面 | 职责 |
| --- | --- |
| 概览 | 汇总当前接入状态、运行指标和常用入口。 |
| 人设与形象 | 新建、读取、编辑、启用或停用真实人设；同时管理人格相关配置。 |
| 功能与触发 | 管理功能开关、触发条件、发送节奏和媒体行为。 |
| 访问范围 | 管理群聊、私聊和管理员范围；允许目标为零时明确显示“全部拒绝”。 |
| 模型与回复 | 管理 DSH 思考强度、模型连接、搜索、价格和回复配置。 |
| 运行设置 | 管理预算、容量、监听地址、端口和部署参数。 |

依赖现有桥接部署的页面能力只在可信装配显式提供对应集成时可用；这些内部接线名称不应显示给普通使用者。在线应用也只在提供受信任服务管理程序时可用。缺少接线时应显示不可用或要求手动重载，不能用演示数据冒充成功。

## 本页目录与全局搜索

`web/console.tsx` 在页面宿主层用 `web/components/page-navigator.tsx` 的 `PageNavigator` 包裹当前 `ActivePage`。`PageNavigator` 只负责当前页面的目录定位，不包含搜索输入，也不维护另一份页面结构：

- 带稳定 `id` 的共享 `Section` 自动进入本页目录；`id` 在页面内必须唯一、稳定且不含业务秘密。`Section.id` 在类型上可以保持可选，但需要进入目录或作为深层定位目标的分组必须显式提供。
- 桌面端在内容右侧显示 sticky 目录；移动端显示可折叠的“本页目录”。目录不修改 URL、路由或页面 hash。
- 选择目录项时，先展开目标的所有祖先 `details`，再滚动并把焦点移到目标标题；不得修改表单值、未保存草稿、dirty 状态或 revision。
- API 返回后新增、移除或条件渲染的 `Section(id)` 应自动更新目录；页面不得手写重复目录。

搜索由标题栏唯一的 `WorkspaceSearch` 提供。按 `Ctrl/⌘K` 打开 `Dialog`，在整个管理工作台中查询已显式注册的页面、分组和字段元数据：

- 页面注册信息提供安全的页面名称和目标；`Section.id` / `Section.title` 提供分组元数据，共享 `Field`、`ToggleField` 等组件的显式 `label` 提供字段元数据。页面和共享组件不得为搜索复制一套可漂移的显示文案。
- 全局索引只包含审核过的名称、标题、标签、安全标识和必要的目标关系。禁止读取或缓存 `input`、`textarea`、`select` 的当前值，禁止索引 token、secret、人设正文、消息正文、错误详情、API 响应正文或任意 DOM 子节点文本。
- 选择结果后可以导航到目标页面；若当前页面有未保存草稿，必须先经过现有离开确认。目标页面渲染后再展开祖先 `details`、滚动并聚焦对应分组标题、字段标签或控件。
- 搜索导航不得重置、保存或改写任何表单草稿，不得触发字段 `onChange` 或写请求。定位所需状态应与业务表单状态分离。
- 功能关闭后隐藏的依赖配置退出本页目录，并按注册元数据的可用状态退出全局搜索结果；再次开启后恢复。搜索目录本身不得决定或改写功能开关。
- 页面不再提供页内搜索，`ConfigurationEditor` 等页面也不保留内部分组筛选。`WorkspaceSearch` 是唯一搜索入口，`PageNavigator` 是唯一目录入口。

自定义复杂控件如需被目录定位，应放入有稳定 `id` 和明确标题的 `Section`；如需进入全局搜索，应通过共享字段的显式标签或审核过的页面元数据注册，而不是抓取任意 DOM 文本。

## 外观与交互

- 提供日间、夜间和跟随系统三种模式；显示偏好保存在浏览器中，跟随系统会响应系统配色变化。
- 管理员令牌只在登录提交期间短暂存在于 `#token` 表单状态，通过 `#connect` 触发 `POST /api/auth/login`；提交后立即清空表单内存状态。不得写入 `localStorage`、`sessionStorage`、cookie、主题偏好、URL、日志或其他持久状态。
- 登录成功后的管理访问使用服务端签发的同源 `HttpOnly`、`SameSite=Strict`、`Path=/api` 会话 cookie。页面脚本不读取 cookie；普通 API 只携带 cookie，不发送管理员 `Authorization`。刷新时通过 `GET /api/auth/session` 恢复登录，并把数值型 Unix 毫秒 `expiresAt` 校验后显示。默认七天绝对期限到达、主动注销或服务重启后返回登录状态。
- “运行设置 → 访问会话 → 访问令牌有效期（毫秒）”编辑管理配置 `accessSessionTtlMs`，范围为 300000 毫秒至 30 天，默认七天。该值表示绝对期限，不是滑动续期；保存后重启管理服务生效，重启同时注销全部现有会话。
- 页面标题、字段、单位、状态和错误使用中文；内部键名和 revision 只用于必要的排障信息。
- 桌面端使用可收起侧栏，移动端选择页面后关闭导航；表单支持键盘操作、明确焦点和离开前未保存提醒。
- 表单按来源和用途分组。秘密字段不回显原值，只报告是否已配置；留空不覆盖已有秘密。
- 同一功能域的运行模式使用单选、分段控件或 `Select` 表达，值在 schema 和 UI 中都必须互斥，不能用多个可同时开启的布尔开关模拟模式。
- 功能总开关关闭时不渲染未修改的依赖配置，而不是仅禁用后继续堆在页面上；隐藏不清空浏览器草稿或已保存值，再次开启时恢复。已有未保存草稿的停用字段可以暂时保持可见并明确标记，直到用户保存或撤销，避免隐藏冲突；允许提供显式“显示停用配置”开关供核对，但默认仍隐藏。与开关无关的状态、错误和恢复操作仍应可见。
- 页面使用 `console.css` 的主题变量与现有语义类，不写死只适合单一主题的背景、边框或文字色。

首次访问 `/api/setup` 时，页面会在尚未初始化的部署上自动请求创建固定私有管理员令牌文件，并在登录窗口显示文件路径。初始化完成后不重复生成；`token_missing` 或令牌文件丢失时显示管理员令牌恢复提示，短令牌校验也统一使用“管理员令牌”术语，不用新令牌掩盖部署异常。管理员令牌与 gateway、OneBot upstream 等协议 API token 必须使用不同名称和帮助文本，不能引导用户混用。

## 写入状态

界面必须区分以下状态：

- `未保存`：仅浏览器草稿。
- `已保存，尚未应用`：配置文件已有新 revision，运行服务尚未重载。
- `已应用`：服务管理操作完成并返回确认。
- `重启已受理，需要重连`：管理端重启已提交，但新实例尚未由当前请求确认。
- `结果待确认`：响应丢失、超时或下游结果为 `unknown`；不自动重试，要求重新读取状态。

运行设置在兼容网关未配置 `timeoutMs` 时显示 60 秒默认请求期限。读取超时可由用户重新发起；写入超时必须进入“结果待确认”，不能自动重复提交，也不能把客户端停止等待解释为服务端未执行。

保存使用 revision 检测并发更改。应用前再次核对 revision。用户修改管理端监听地址或端口后，保存只落盘；“应用并重启”返回已受理后，页面应引导用户使用新地址重新连接，而不是显示为已应用。

预算开关关闭时，次数和期限输入可禁用但原值必须保留；再次开启恢复这些值。允许目标列表可以为空，UI 必须说明这会拒绝全部目标发送，不能把空列表解释成无限制。

## 共享组件约定

页面位于 `web/pages/`，通过共享 `PageProps` 接收认证 `ApiClient`、快照、导航、刷新和未保存状态方法。布局、本页目录、全局搜索元数据、字段、开关、保存栏、状态提示与空状态使用 `web/components/` 中的共享组件；基础交互组件集中在 `web/components/ui/`。

页面至少遵守以下边界：

- 使用 `PageHeading` 表达页面名称，并依赖 `web/console.tsx` 的单个 `PageNavigator` 覆盖页面全部加载、错误、空状态和正常内容；页面自身不要嵌套第二个导航器或搜索框。
- 为需要进入目录的 `Section` 提供稳定 `id`；使用 `Section.title` 和共享字段 `label` 提供全局搜索元数据，不为目录或搜索额外复制标题；`SaveBar` 只表达草稿、保存和应用状态。
- 通过 `PageProps.api` 或显式接收的 `ApiClient` 调用同源 `/api/...`，由浏览器携带 `HttpOnly` 访问会话 cookie，并把返回的 `unknown` 校验成页面模型后再显示；业务页面不得接收或缓存管理员 Bearer 令牌。
- 普通 API 的 `401` / `403` 清除前端连接态并返回登录界面；网络失败保留当前会话状态并显示可重试错误，不能把无法确认响应误当作注销成功。
- 退出操作存在 dirty scope 时必须先走未保存确认；用户取消则不调用注销接口，确认后才请求 `POST /api/auth/logout`。
- 用 `PageProps.setDirty(value, scope)` 登记并清理页面草稿；目录定位、全局搜索、展开 `details` 和主题切换不得改变 dirty 状态，跨页面搜索结果必须复用现有离开确认。
- 功能开关用条件渲染控制依赖 `Section` / `Field`，互斥模式使用单值联合类型；关闭、切换或隐藏控件时不得偷偷重写其他模式的保存值。
- 复用现有 Button、Input、Textarea、Switch、Select、Dialog 等控件及主题 token，保证键盘、焦点、禁用和错误状态一致。

## 可复制 TSX 页面范式

以下骨架演示框架接线，不代表框架内置了 `example-settings` 业务。复制时替换页面名、校验函数和由可信宿主安装的 API 路由，不要把响应对象、消息内容或秘密直接渲染到页面。

```tsx
import { useEffect, useMemo, useState } from 'react';
import { ConnectPrompt, Field, PageHeading, SaveBar, Section, ToggleField } from '../components/management.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select.tsx';
import { Textarea } from '../components/ui/textarea.tsx';
import { asRecord, errorMessage, type ApiClient } from '../lib/api.ts';
import type { PageProps } from '../lib/types.ts';

interface Draft {
  readonly enabled: boolean;
  readonly mode: 'standard' | 'guarded';
  readonly displayName: string;
  readonly notes: string;
}

interface LoadedDraft {
  readonly revision: string;
  readonly draft: Draft;
}

function parseLoadedDraft(value: unknown): LoadedDraft {
  const record = asRecord(value);
  const settings = asRecord(record.settings);
  if (typeof record.revision !== 'string'
    || typeof settings.enabled !== 'boolean'
    || settings.mode !== 'standard' && settings.mode !== 'guarded'
    || typeof settings.displayName !== 'string'
    || typeof settings.notes !== 'string') throw new Error('invalid_response');
  return {
    revision: record.revision,
    draft: {
      enabled: settings.enabled,
      mode: settings.mode,
      displayName: settings.displayName,
      notes: settings.notes,
    },
  };
}

async function readDraft(api: ApiClient, signal: AbortSignal): Promise<LoadedDraft> {
  return parseLoadedDraft(await api.get('/api/example-settings', signal));
}

export function ExamplePage({ connected, api, connect, setDirty }: PageProps) {
  const [loaded, setLoaded] = useState<LoadedDraft | null>(null);
  const [draft, setDraft] = useState<Draft>({ enabled: false, mode: 'standard', displayName: '', notes: '' });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState('');
  const [reloadVersion, setReloadVersion] = useState(0);
  const dirty = useMemo(() => loaded !== null
    && (draft.enabled !== loaded.draft.enabled
      || draft.mode !== loaded.draft.mode
      || draft.displayName !== loaded.draft.displayName
      || draft.notes !== loaded.draft.notes),
  [draft, loaded]);

  useEffect(() => {
    setDirty(dirty, 'example-settings');
  }, [dirty, setDirty]);
  useEffect(() => () => setDirty(false, 'example-settings'), [setDirty]);

  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    void readDraft(api, controller.signal)
      .then(next => { setLoaded(next); setDraft(next.draft); setMessage(''); })
      .catch(error => { if (!controller.signal.aborted) setLoadError(errorMessage(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, connected, reloadVersion]);

  function update<Key extends keyof Draft>(key: Key, value: Draft[Key]): void {
    setDraft(current => ({ ...current, [key]: value }));
    setMessage('');
  }

  async function save(): Promise<void> {
    if (!loaded) return;
    setSaving(true);
    try {
      const next = parseLoadedDraft(await api.post('/api/example-settings', {
        revision: loaded.revision,
        settings: draft,
      }));
      setLoaded(next);
      setDraft(next.draft);
      setMessage('已保存');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return <div className="grid gap-5">
      <PageHeading title="扩展设置" description="使用共享页面结构管理受信任扩展。" />
      {!connected ? <ConnectPrompt connect={connect} /> : loading ?
        <Section title="正在读取设置"><p role="status" className="text-sm text-muted-foreground">请稍候</p></Section> : !loaded ?
        <Section title="无法读取设置" description={loadError || '服务返回了无法识别的内容。'} actions={<Button variant="outline" onClick={() => setReloadVersion(version => version + 1)}>重新读取</Button>}><p role="alert" className="text-sm text-destructive">当前草稿没有被修改。</p></Section> : <>
          <Section id="extension-basics" title="基础设置" description="稳定 id 自动进入本页目录，标题与字段标签作为全局搜索元数据。" footer={<SaveBar dirty={dirty} saving={saving} message={message || undefined} onSave={() => void save()} onReset={() => { setDraft(loaded.draft); setMessage(''); }} />}>
            <ToggleField label="启用扩展" description="关闭后隐藏依赖配置，但保留当前草稿值。" checked={draft.enabled} disabled={saving} onChange={enabled => update('enabled', enabled)} />
            {draft.enabled && <div className="grid gap-5 pt-5">
              <Field label="运行模式">
                <Select value={draft.mode} disabled={saving} onValueChange={value => {
                  if (value === 'standard' || value === 'guarded') update('mode', value);
                }}>
                  <SelectTrigger><SelectValue>{draft.mode === 'standard' ? '标准' : '审慎'}</SelectValue></SelectTrigger>
                  <SelectContent><SelectItem value="standard">标准</SelectItem><SelectItem value="guarded">审慎</SelectItem></SelectContent>
                </Select>
              </Field>
              <Field label="显示名称">
                <Input value={draft.displayName} disabled={saving} onChange={event => update('displayName', event.target.value)} />
              </Field>
            </div>}
          </Section>
          {draft.enabled && <Section id="extension-notes" title="补充说明">
            <Field label="说明正文" description="全局搜索只使用此标签元数据，不索引输入内容。">
              <Textarea value={draft.notes} disabled={saving} onChange={event => update('notes', event.target.value)} />
            </Field>
          </Section>}
        </>}
  </div>;
}
```

真实页面还应把加载错误和空状态分开，并按后端契约处理 revision 冲突、`unknown`、秘密保留与应用状态。示例中的 endpoint 只有在可信宿主显式安装对应 `AdminRoute` 后才存在。

## 可信扩展与构建接线

管理 UI 不是运行时插件市场。扩展接线遵循以下流程：

1. 审核页面 TSX、共享组件使用、数据校验和对应的服务端 `AdminRoute`，确认权限、秘密与写入恢复语义。
2. 在 `web/console.tsx` 的页面注册表、导航和 `WorkspaceSearch` 元数据中显式导入页面；在可信 composition 中显式安装固定 `/api/...` 路由。
3. 运行按范围的类型检查、构建和浏览器验收。`npm run build` 会执行服务端与 Web TypeScript 编译，再由 Vite 生成 `dist/admin-web/app.js` 和 `style.css`。
4. 管理服务只提供构建产物中的固定 `/`、`/app.js`、`/style.css`，API 也只来自装配时给出的有限路由；部署审核通过的同一份产物。

框架不存在从 QQ 消息、模型输出、远端 URL、任意本地目录或声明清单动态加载页面/代码的机制，也不存在“放入业务包后自动注册插件或 UI”的约定。普通消息不能新增路由、执行源码、安装页面或扩大 capability。需要热更新、第三方不可信插件或代码沙箱的部署必须另行设计，不能把本管理台描述成已经支持。

## 可访问性要求

- `PageNavigator` 使用独立导航语义并标明“本页目录”，桌面 sticky 目录与移动端折叠目录保持同一顺序；它不混入搜索控件或搜索结果。
- 标题栏 `WorkspaceSearch` 触发器有可辨认名称并暴露 `Ctrl/⌘K` 快捷键；快捷键不得在用户使用输入法组合键或其他可编辑控件时误触发。
- 搜索 `Dialog` 打开后把焦点移到有明确名称的搜索输入，使用合适的 dialog/combobox/listbox 语义和键盘顺序；`Escape` 关闭后把焦点还给原触发器。
- 搜索结果应区分页面、分组和字段，并能只用键盘选择。激活后先完成受控页面导航和未保存草稿确认，再展开祖先 `details`、滚动目标，并把焦点置于可辨认的标题、标签或控件。
- 目录同样可只用键盘操作；`Enter` 或 `Space` 激活后展开祖先 `details`、滚动目标，并把焦点置于目标标题。
- 程序化焦点目标在视觉上保留清晰的 `focus-visible` 状态；sticky 目录、移动端折叠面板和滚动定位不能遮住目标。
- `Section` 标题层级保持在页面 `h1` 之后；`Field` 标签继续与实际控件关联。不能为目录方便而把可交互元素改成无语义 `div`。
- 搜索结果数量、加载状态、保存结果和错误使用适当的 `role="status"` / `role="alert"`，但不要在每次键入时制造冗长的屏幕阅读器播报；无结果状态必须可辨认。
- 日间、夜间、系统主题及窄屏下均保持可读对比度、触控尺寸、无横向溢出和不被遮挡的焦点。

## 扩展验收清单

- [ ] 页面注册到 `web/console.tsx` 后由唯一的 `PageNavigator` 宿主包裹全部状态，页面自身使用 `PageHeading`、共享 `Section`、`Field` 和 `SaveBar`，不重复挂载导航器或搜索框。
- [ ] 每个需要进入目录或接受深层定位的 Section 都有稳定、唯一、安全的 `Section.id`，并自动出现在本页目录；字段不作为目录层级。
- [ ] `WorkspaceSearch` 通过 `Ctrl/⌘K` 打开，能全局命中已注册的页面、分组和字段标签元数据；页面没有页内搜索或内部分组筛选。
- [ ] 全局索引不读取输入值、令牌、secret、人设正文、消息正文、错误原文、API 正文或任意 DOM 子节点文本。
- [ ] 从折叠 `details` 中选择目录项或全局搜索结果会先展开全部祖先，再正确滚动和聚焦；键盘与屏幕阅读器流程可用。
- [ ] 目录定位不改变 hash/路由；搜索跨页导航遵守未保存草稿确认。两者都不触发字段 `onChange`、不丢失或重置草稿、不改变 dirty/revision，也不发起写请求。
- [ ] 桌面 sticky 右栏和移动端折叠目录均可用；全局搜索 Dialog 在桌面、移动端和纯键盘操作下均可用，关闭后恢复触发焦点。
- [ ] 互斥模式只能选择一个值；关闭功能默认隐藏依赖配置和目录项，并按可用状态更新全局元数据，但不会清空值，也不会把业务 UI 内置进框架。
- [ ] API 的 `unknown` 响应经过结构校验；写操作处理 revision 冲突、超时未知、重复提交和秘密留空语义。
- [ ] 登录保留 `#token` / `#connect`，仅把管理员令牌提交到 `POST /api/auth/login`；提交后立即清空表单值，业务页面与 `ApiClient` 不缓存或持久化该 Bearer 令牌。
- [ ] 普通 API 只使用 `HttpOnly`、`SameSite=Strict`、`Path=/api` cookie，不发送管理员 `Authorization`；刷新通过 `GET /api/auth/session` 恢复并校验数值型 Unix 毫秒 `expiresAt`。
- [ ] `POST /api/auth/logout` 会撤销会话并清 cookie；默认七天绝对期限和服务重启也会使会话失效并返回登录状态。
- [ ] 普通 API 的 `401` / `403` 清除前端连接态；网络失败保留会话状态并提供重试。有脏表单时取消退出不会注销，确认后才调用注销接口；只有注销成功或 `401` / `403` 才清连接态。
- [ ] 管理员令牌、访问会话和协议 API token 在名称、输入位置、错误提示与存储规则上清楚区分，互不替代。
- [ ] 独立模式在“访问范围 → 消息发送范围 → 允许发送的会话”逐行接受 `group:群号` / `private:QQ号`，空列表全部拒绝；保存执行 CAS 并旋转授权版本。
- [ ] `chatManagement=false` 时人设与模型页显示“尚未接入聊天宿主”，不请求或误报旧管理 API；只有兼容管理状态为 true 时展示对应管理内容。
- [ ] 运行设置中的“访问会话”分组展示“访问令牌有效期（毫秒）”，限制为 300000 至 30 天并说明默认七天、绝对期限、保存后重启生效及重启注销现有会话。
- [ ] 使用 `PageProps` 与 `ApiClient`，卸载时取消读取并清理独立 dirty scope；不持久化秘密值。
- [ ] 页面只使用主题 token 和共享控件，在日间、夜间、系统主题以及桌面、移动端下无重叠或溢出。
- [ ] 页面与 API 均由可信源码显式导入、审核和构建；不存在消息驱动代码加载、任意路径加载或虚构的插件自动注册。
- [ ] 按改动范围完成 TypeScript、构建及浏览器验证，确认生产部署使用的正是审核后的静态产物和服务端路由。

## 验证

页面验证应覆盖三种主题及系统主题变化、显示偏好保留、首次管理员令牌初始化、登录提交后令牌清除、刷新恢复会话、主动注销成功与网络失败、七天绝对期限、服务重启失效、协议 token 不混用、六页导航、独立发送范围 CAS 与授权版本旋转、未接入聊天宿主提示、每页目录、`Ctrl/⌘K` 全局搜索、跨页与折叠内容定位、未保存草稿确认、索引数据边界、互斥模式、功能关闭后的依赖配置隐藏与值保留、兼容网关 60 秒默认请求超时、键盘焦点、移动端布局、人设实际写入、零允许目标、预算值保留、revision 冲突，以及保存、应用、重连受理和结果未知的不同反馈。
