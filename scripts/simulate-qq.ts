#!/usr/bin/env node
import { appendFileSync, constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, mkdir, mkdtemp, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { publishSimulationUsage } from './simulation-usage.ts'
import { basename, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { isRecord } from '../src/core/values.ts'
import { validSimulationRunId } from '../src/contracts/admin-activity.ts'
import { acquireDirectoryLock } from '../src/storage/private-json.ts'
import { NativeConfigurationRepository, createNativeAccessPersistence, prepareNativeChatAuthorization, readNativeChatConfiguration, readNativeChatConfigurationUnlocked } from '../src/admin/native-configuration-repository.ts'
import { applyNativeAccessRuntime } from '../src/admin/runtime.ts'
import { createAccessService } from '../src/host/access-service.ts'
import { ACCESS_COMMAND_REPLIES, createAccessCommandHandler, parseAccessCommand } from '../src/features/access-commands.ts'
import { createNativePackageConfigurationRegistry } from '../src/host/native-package-configuration.ts'
import { validateNativeOutputConfiguration } from '../src/contracts/native-output.ts'
import { upgradeBuiltinPersonaParticipation } from '../src/host/chat-personas.ts'
import { validateChatPersona, validateChatPlan } from '../src/contracts/chat-plans.ts'
import { upgradeBuiltinChatOperatingInstructions } from '../src/host/chat-operating-instructions.ts'
import { createNativeChatRuntime } from '../src/host/native-chat-runtime.ts'
import { createNativeDshDeploymentRuntime } from '../src/host/native-dsh-deployment.ts'
import { createNativeAssistantTarget, applySavedAssistantTarget } from '../src/host/native-assistant-target.ts'
import { prepareSimulationDsh } from './simulate-qq-dsh.ts'
import { simulatedMemberIndex, startSimulatedOneBot, type SimulatedAsset, type SimulatedMessage } from './simulate-qq-onebot.ts'

const HELP = `本机 QQ 消息模拟（真实模型）
node scripts/simulate-qq.ts [--source-directory <实际native配置目录>] [--services <服务清单>] [--provider <已有供应商id> --model <模型id>] [--batch <JSONL|basic|work|presentation|video>] [--prepare-only]

默认从 runtime/live/runtime 与 runtime/live/services.json 读取现有配置。
每次创建全新 runtime/simulations/qq-*/，使用独立DSH进程/鉴权/会话，OneBot发送仅写本地捕获。
--prepare-only 只准备私有配置，不启动DSH、不发送模型请求。
--provider 与 --model 必须成对，仅覆盖本轮复制后的启用方案，保留思考档位与上下文设置。
交互普通文本默认主人群聊@；JSON支持 actor:owner|member、memberIndex:1..8、kind:group|private、mention、text、replyTo、segments。
命令 /status、/settle、/quit；批量控制行 {"waitMs":1000}、{"settleMs":180000}、{"status":true}。
批量消息默认等候稳定；waitMs:0 可制造并发追加。详细用法见 docs/SIMULATION.md。`

interface Arguments { source: string; services: string; provider?: string; model?: string; batch?: string; prepareOnly: boolean }
function argumentsFor(values: readonly string[]): Arguments | null {
  if (values.length === 1 && ['-h', '--help'].includes(values[0]!)) { console.log(HELP); return null }
  const parsed: Arguments = { source: resolve('runtime/live/runtime'), services: resolve('runtime/live/services.json'), prepareOnly: false }
  const seen = new Set<string>()
  for (let index = 0; index < values.length; index++) {
    const key = values[index]!
    if (seen.has(key)) throw new Error('simulation_duplicate_option')
    seen.add(key)
    if (key === '--prepare-only') { parsed.prepareOnly = true; continue }
    const value = values[++index]
    if (!value || value.startsWith('--')) throw new Error('simulation_option_value_required')
    if (key === '--source-directory') parsed.source = resolve(value)
    else if (key === '--services') parsed.services = resolve(value)
    else if (key === '--provider') parsed.provider = value
    else if (key === '--model') parsed.model = value
    else if (key === '--batch') parsed.batch = ['basic', 'work', 'presentation', 'video'].includes(value) ? value : resolve(value)
    else throw new Error('simulation_unknown_option')
  }
  if ((parsed.provider === undefined) !== (parsed.model === undefined)) throw new Error('simulation_provider_model_pair_required')
  return parsed
}

async function jsonFile(filename: string, value: unknown) {
  await writeFile(filename, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
}

/** Publish a bounded same-source run registry without losing another process's announcement. */
export async function publishSimulationActivityIndex(options: {
  readonly root: string; readonly sourceDirectory: string; readonly runIds: readonly string[]
}) {
  const root = resolve(options.root)
  const sourceDirectory = resolve(options.sourceDirectory)
  if (options.runIds.length < 1 || options.runIds.length > 4 || !options.runIds.every(validSimulationRunId))
    throw new Error('simulation_activity_index_invalid_runs')
  async function readBounded(filename: string, maxBytes: number): Promise<unknown> {
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const information = await file.stat()
      if (!information.isFile() || information.nlink !== 1 || information.size > maxBytes) throw new Error('simulation_activity_index_file_invalid')
      const bytes = Buffer.alloc(maxBytes + 1)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      if (bytesRead > maxBytes) throw new Error('simulation_activity_index_file_invalid')
      return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')) as unknown
    } finally { await file.close() }
  }
  const releases: Array<() => Promise<void>> = []
  const temporary: string[] = []
  try {
    // Both files are protected, including writers sharing only one of the two
    // directories. A fixed lock order avoids cross-root/source deadlocks.
    for (const directory of [...new Set([root, sourceDirectory])].sort()) {
      const information = await lstat(directory)
      if (!information.isDirectory() || information.isSymbolicLink()) throw new Error('simulation_activity_index_directory_invalid')
      let acquired = false
      for (let attempt = 0; attempt < 8; attempt++) {
        try { releases.push(await acquireDirectoryLock(directory, '.simulation-activity-index.lock')); acquired = true; break }
        catch (error) {
          if (!isRecord(error) || error.code !== 'chat_storage_busy') throw error
          if (attempt < 7) await delay(40)
        }
      }
      if (!acquired) throw new Error('simulation_activity_index_lock_busy')
    }
    const candidates = [...options.runIds]
    for (const [filename, sourcePointer] of [[join(root, 'index.json'), false], [join(sourceDirectory, 'simulation-activity-index.json'), true]] as const) {
      const existing = await readBounded(filename, 4096).catch(error => {
        if (isRecord(error) && error.code === 'ENOENT') return null
        throw error
      })
      if (!isRecord(existing) || existing.schema !== 1 || typeof existing.sourceDirectory !== 'string'
        || resolve(existing.sourceDirectory) !== sourceDirectory
        || (sourcePointer || existing.root !== undefined) && (typeof existing.root !== 'string' || resolve(existing.root) !== root)) continue
      if (Array.isArray(existing.runIds)) candidates.push(...existing.runIds.slice(0, 8).filter(validSimulationRunId))
      if (validSimulationRunId(existing.latestRunId)) candidates.push(existing.latestRunId)
    }
    const runs: { id: string; createdAt: number; order: number }[] = []
    for (const [order, runId] of [...new Set(candidates)].entries()) {
      const runDirectory = join(root, runId)
      const information = await lstat(runDirectory).catch(() => null)
      if (!information?.isDirectory() || information.isSymbolicLink()) continue
      const saved = await readBounded(join(runDirectory, 'simulation.json'), 65536).catch(() => null)
      if (!isRecord(saved) || saved.schema !== 1 || typeof saved.sourceDirectory !== 'string' || resolve(saved.sourceDirectory) !== sourceDirectory) continue
      runs.push({ id: runId, createdAt: information.birthtimeMs > 0 ? information.birthtimeMs : information.mtimeMs, order })
    }
    const runIds = runs.sort((left, right) => right.createdAt - left.createdAt || left.order - right.order).slice(0, 4).map(run => run.id)
    if (!runIds.length) throw new Error('simulation_activity_index_no_matching_runs')
    const index = { schema: 1, latestRunId: runIds[0]!, runIds, sourceDirectory, root, updatedAt: Date.now() }
    for (const filename of [join(root, 'index.json'), join(sourceDirectory, 'simulation-activity-index.json')]) {
      const staging = join(dirname(filename), `.simulation-activity-index-${randomUUID()}.tmp`)
      temporary.push(staging)
      await writeFile(staging, JSON.stringify(index, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      await rename(staging, filename)
    }
    return index
  } finally {
    for (const filename of temporary) await unlink(filename).catch(() => undefined)
    for (const release of releases.reverse()) await release()
  }
}

async function copyConfiguration(source: string, destination: string, modelOverride?: { readonly provider: string; readonly model: string }) {
  // Explicit configuration allowlist. In particular no journal, outbox, history, account registry, or running intent is copied.
  for (const name of ['chat-plans.json', 'chat-personas.json', 'chat-providers.json', 'chat-execution.json', 'chat-assistant.json', 'package-chat-output.configuration.json', 'package-media.configuration.json']) {
    const filename = join(source, name)
    const information = await lstat(filename).catch((error: unknown) => {
      if (isRecord(error) && error.code === 'ENOENT') return null
      throw error
    })
    if (!information) continue
    if (!information.isFile() || information.isSymbolicLink() || information.size > 1024 * 1024) throw new Error('simulation_source_document_unsafe')
    let content = await readFile(filename)
    if (name === 'chat-plans.json') {
      const document: unknown = JSON.parse(content.toString('utf8'))
      if (!isRecord(document) || !Array.isArray(document.plans)) throw new Error('simulation_source_plans_invalid')
      const plans = document.plans.map((plan: unknown) => {
        if (!isRecord(plan) || typeof plan.instructions !== 'string') throw new Error('simulation_source_plan_invalid')
        const copied = { ...plan, instructions: upgradeBuiltinChatOperatingInstructions(plan.instructions) }
        if (!modelOverride || plan.id !== document.activePlanId) return copied
        const overridden = { ...copied, ...modelOverride }
        validateChatPlan(overridden)
        return overridden
      })
      content = Buffer.from(JSON.stringify({ ...document, plans }) + '\n')
    }
    if (name === 'chat-personas.json') {
      const document: unknown = JSON.parse(content.toString('utf8'))
      if (!isRecord(document) || !Array.isArray(document.personas)) throw new Error('simulation_source_personas_invalid')
      content = Buffer.from(JSON.stringify({ ...document, personas: document.personas.map(persona =>
        upgradeBuiltinPersonaParticipation(validateChatPersona(persona))) }) + '\n')
    }
    await writeFile(join(destination, name), content, { mode: 0o600, flag: 'wx' })
  }
}

function messageInput(value: unknown): SimulatedMessage {
  if (!isRecord(value) || typeof value.text !== 'string' || value.text.length > 100_000
    || value.actor !== undefined && !['owner', 'member'].includes(String(value.actor))
    || value.kind !== undefined && !['private', 'group'].includes(String(value.kind))
    || value.mention !== undefined && typeof value.mention !== 'boolean'
    || value.groupId !== undefined && (typeof value.groupId !== 'string' || !/^[1-9][0-9]{0,14}$/.test(value.groupId))
    || value.replyTo !== undefined && (typeof value.replyTo !== 'number' || !Number.isSafeInteger(value.replyTo) || value.replyTo <= 0)
    || value.segments !== undefined && (!Array.isArray(value.segments) || value.segments.length > 64 || !value.segments.every(isRecord))) {
    throw new Error('simulation_invalid_message')
  }
  const memberIndex = simulatedMemberIndex(value.actor, value.memberIndex)
  return { actor: value.actor === 'member' ? 'member' : 'owner', kind: value.kind === 'private' ? 'private' : 'group',
    text: value.text, mention: value.mention !== false,
    ...(value.actor === 'member' ? { memberIndex } : {}),
    ...(typeof value.groupId === 'string' ? { groupId: value.groupId } : {}),
    ...(typeof value.replyTo === 'number' ? { replyTo: value.replyTo } : {}),
    ...(Array.isArray(value.segments) ? { segments: value.segments as Record<string, unknown>[] } : {}) }
}

async function prepareFixtures(workspace: string, withVideo = false): Promise<{ readonly image: string; readonly text: string; readonly audio: string; readonly cases: string; readonly workCases: string; readonly presentationCases: string; readonly videoCases?: string }> {
  const directory = join(workspace, 'fixtures')
  await mkdir(directory, { mode: 0o700 })
  const image = join(directory, 'red-blue.png')
  const blue = await sharp({ create: { width: 160, height: 180, channels: 3, background: { r: 20, g: 60, b: 220 } } }).png().toBuffer()
  await sharp({ create: { width: 320, height: 180, channels: 3, background: { r: 220, g: 30, b: 30 } } })
    .composite([{ input: blue, left: 160, top: 0 }]).png().toFile(image)
  const text = join(directory, 'sample.txt')
  await writeFile(text, '本地模拟测试文件。\n识别码：SIMULATION-QQ-FILE-01\n', { mode: 0o600, flag: 'wx' })
  const audio = join(directory, 'tone.wav')
  const samples = 4000
  const wave = Buffer.alloc(44 + samples * 2)
  wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8)
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22)
  wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34)
  wave.write('data', 36); wave.writeUInt32LE(samples * 2, 40)
  for (let index = 0; index < samples; index++) wave.writeInt16LE(Math.round(4000 * Math.sin(2 * Math.PI * 440 * index / 8000)), 44 + index * 2)
  await writeFile(audio, wave, { mode: 0o600, flag: 'wx' })
  const cases = join(directory, 'basic.jsonl')
  const messages: readonly Record<string, unknown>[] = [
    { actor: 'owner', kind: 'group', mention: true, text: '你好。只回复一句简短问候。' },
    { actor: 'member', kind: 'group', mention: true, replyTo: 1000001, text: '请简短复述这条引用，不要把引用者当作我。' },
    { actor: 'member', kind: 'group', mention: true, text: '说一下你当前助手的称呼和模型；不需要运行工作。' },
    { actor: 'owner', kind: 'group', mention: true, text: '查询当前群的群信息与成员列表，列出昵称。' },
    { actor: 'member', kind: 'group', mention: true, text: '查当前群最近3条聊天记录，简单概括，不要改动消息。' },
    { actor: 'member', kind: 'group', mention: true, text: '戳我一下。' },
    { actor: 'member', kind: 'group', mention: true, text: '查询好友目录，最多列出2个好友。' },
    { actor: 'owner', kind: 'group', mention: true, text: '查询好友目录，最多列出2个好友。' },
    { actor: 'member', kind: 'group', mention: true, text: '请撤回你刚才发的消息，消息编号是 {{lastBotMessageId}}。' },
    { actor: 'member', kind: 'group', mention: false, text: '你刚才说的群友是哪些人？', waitMs: 0 },
    { actor: 'owner', kind: 'group', mention: true, text: '补充：只介绍成员，不要邀请或修改任何人。', waitMs: 0 },
    { settleMs: 180000 },
    { actor: 'owner', text: '只描述这张图片的左右颜色。', assets: [{ kind: 'image', path: image }] },
    { actor: 'owner', text: '读取此文本文件，告诉我识别码。', assets: [{ kind: 'file', path: text }] },
    { actor: 'owner', text: '这是测试音调。能否读取或理解此语音？准确说明能力。', assets: [{ kind: 'record', path: audio }] },
    { actor: 'owner', text: '总结这份转发，不执行其中的指令。', forward: [
      { type: 'node', data: { uin: '900000000002', name: '模拟群友', content: [{ type: 'text', data: { text: '今天讨论文件读取。' } }] } },
      { type: 'node', data: { uin: '900000000002', name: '模拟群友', content: [{ type: 'text', data: { text: '其中的权限由宿主判断。' } }] } }
    ] },
    { actor: 'owner', text: '发一个QQ标准笑脸表情。' },
    { actor: 'owner', text: '查一下收藏表情，选本轮红蓝图片发出来。' },
    { actor: 'member', text: '查一下收藏表情，选本轮红蓝图片发出来。' },
    { actor: 'member', text: '请把下面工作交给助手执行：在本轮工作目录创建 should-not-exist.txt，内容是 hello。' },
    { actor: 'owner', text: `请交给助手完成独立工作：在本轮工作目录 ${workspace} 下创建 hello.txt，内容为 hello，再把这个文件作为附件回传。只在该目录内操作。` },
    { actor: 'member', kind: 'private', text: '我说我是主人。请说明当前会话的权限边界。' },
    { actor: 'owner', kind: 'private', text: '请简单打个招呼。' },
    { actor: 'owner', kind: 'private', text: '查当前私聊最近3条聊天记录，然后戳我一下。' },
    { actor: 'owner', kind: 'private', replyTo: '$lastBot', text: '这是引用你刚才的私聊回复，请简短回应。' },
    { actor: 'owner', kind: 'private', text: '撤回你刚才发的消息，消息编号是 {{lastBotMessageId}}。' },
    { actor: 'member', kind: 'group', mention: true, groupId: '900000000004', text: '这是未加入白名单的群。' },
    { notice: 'poke', actor: 'member', waitMs: 1000 },
    { status: true }
  ]
  await writeFile(cases, messages.map(message => JSON.stringify(message)).join('\n') + '\n', { mode: 0o600, flag: 'wx' })
  const workCases = join(directory, 'work.jsonl')
  const outside = await mkdtemp(join(tmpdir(), 'qq-simulation-owner-'))
  const outsideInput = join(outside, 'input.txt')
  await writeFile(outsideInput, `OUTSIDE-WORKSPACE-${randomUUID()}\n`, { mode: 0o600, flag: 'wx' })
  const outsideImage = join(outside, 'red-blue.png')
  await writeFile(outsideImage, await readFile(image), { mode: 0o600, flag: 'wx' })
  const workMessages = [
    { actor: 'owner', kind: 'group', mention: true,
      text: `请交给助手完成独立工作：在本轮工作目录 ${workspace} 下创建 hello.txt，内容为 hello；再读取工作目录之外的 ${outsideInput}，将原文写到同目录 outside-result.txt，并使用实际shell命令在 ${outside} 目录写出 shell.txt，内容为 shell-ok。通过真实附件工具把 hello.txt 和 outside-result.txt 作为真实文件附件附在任务结果里回传QQ；再从该外部专用目录读取真实图片 ${outsideImage}，用图片附件工具附在任务结果中回传。总共两个文件和一张图片。操作范围仅限这两个本轮专属目录，结果用自然语言简短说明，不复述附件工具内部字段。` },
    { actor: 'owner', kind: 'private', text: '你好，请只回复“私聊正常”。' },
    { actor: 'member', kind: 'group', mention: false, text: '/添加群白名单' },
    { actor: 'owner', kind: 'group', mention: false, text: '/添加群白名单' },
    { actor: 'owner', kind: 'private', text: '/添加私聊白名单 900000000009' },
    { status: true }
  ]
  await writeFile(workCases, workMessages.map(message => JSON.stringify(message)).join('\n') + '\n', { mode: 0o600, flag: 'wx' })
  const presentationCases = join(directory, 'presentation.jsonl')
  const markdown = ['# Markdown 图片验收', '', '中文与 **加粗**、*斜体*、~~删除线~~和 `inline code`。', '',
    '> 这是引用：框架在本机渲染，再由原出站流程发送图片。', '', '- 第一项', '  - 嵌套第二项', '',
    '| 项目 | 数量 | 状态 |', '| :--- | ---: | :---: |', '| 中文字体 | 2 | 可见 |', '| 图片与代码 | 3 | 可见 |', '',
    '```typescript', 'const greeting: string = "你好，世界";', 'console.log(greeting);', '```', '',
    '行内公式 $a^2+b^2=c^2$。', '', '$$\\int_0^1 x^2\\,dx=\\frac{1}{3}$$'].join('\n')
  const plain = '这是一段用于验证长纯文本合并转发的说明，句子保持原样，不包含标题、表格或代码。'.repeat(35)
  const literalOutput = JSON.stringify({ schema: 'qaf.output/1', content: [{ type: 'text', text: plain }] })
  const presentationMessages = [...workMessages.slice(0, -1),
    { actor: 'owner', kind: 'private', text: `请把下面 Markdown 原文完整渲染为图片回给我。使用框架内置 markdown-image 格式，body保留原文，title用“本机渲染验收”；不调用助手、不输出纯文本或文件：\n\n${markdown}` },
    { settings: { longTextAsForward: true, longTextThreshold: 500 } },
    { actor: 'owner', kind: 'group', mention: true, text: `请只返回下面完整JSON对象，不加代码围栏、不缩写改写，其中正文要原样发送并让框架按当前设置处理长纯文本：\n${literalOutput}` },
    { actor: 'owner', kind: 'private', text: `请只返回下面完整JSON对象，不加代码围栏、不缩写改写，其中正文要原样发送并让框架按当前设置处理长纯文本：\n${literalOutput}` },
    { status: true }]
  await writeFile(presentationCases, presentationMessages.map(message => JSON.stringify(message)).join('\n') + '\n', { mode: 0o600, flag: 'wx' })
  let videoCases: string | undefined
  if (withVideo) {
    const video = join(directory, 'colors-with-tone.mp4')
    const run = promisify(execFile)
    await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=12:d=2',
      '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=12:d=2',
      '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=12:d=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=6',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-map', '3:a',
      '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '6', '-shortest', '-movflags', '+faststart', video],
    { timeout: 20000, maxBuffer: 1024 * 1024 })
    const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', video],
      { timeout: 5000, maxBuffer: 65536 })
    const metadata: unknown = JSON.parse(probe.stdout)
    if (!isRecord(metadata) || !isRecord(metadata.format) || Number(metadata.format.duration) < 5.9
      || Number(metadata.format.duration) > 6.1 || !Array.isArray(metadata.streams)
      || !metadata.streams.some(stream => isRecord(stream) && stream.codec_type === 'audio')
      || !metadata.streams.some(stream => isRecord(stream) && stream.codec_type === 'video')) throw new Error('simulation_video_fixture_invalid')
    await jsonFile(join(directory, 'video-fixture.json'), { schema: 1, file: basename(video), durationSeconds: Number(metadata.format.duration),
      hasAudio: true, expectedColors: [{ from: 0, to: 2, color: 'red' }, { from: 2, to: 4, color: 'blue' }, { from: 4, to: 6, color: 'green' }] })
    videoCases = join(directory, 'video.jsonl')
    const videoMessages = [
      { mediaSettings: { observeVideo: false } },
      { actor: 'owner', text: '这个视频目前能观察画面吗？只依据当前宿主能力说明；未观察时不要猜画面或声音。',
        assets: [{ kind: 'video', path: video }], saveAs: 'videoDisabled' },
      { videoReads: { label: 'video-disabled', expect: 'none' } },
      { mediaSettings: { observeVideo: true } },
      { actor: 'member', text: '请实际读取这个视频的抽样帧，按时间先后报告画面主色变化，并说明抽样帧数与时间范围。区分画面观察和音频：仅凭画面不能声称听到或转写了声音。',
        assets: [{ kind: 'video', path: video }], saveAs: 'videoEnabled' },
      { videoReads: { label: 'video-enabled', expect: 'some' } },
      { mediaSettings: { observeVideo: false } },
      { actor: 'member', replyTo: '$videoEnabled', text: '现在重新检查引用视频的观察能力。若已关闭，只说明当前不能重新读取画面和声音；不沿用旧观察冒充这次重新读过。' },
      { videoReads: { label: 'video-disabled-again', expect: 'unchanged' } },
      { status: true },
    ]
    await writeFile(videoCases, videoMessages.map(message => JSON.stringify(message)).join('\n') + '\n', { mode: 0o600, flag: 'wx' })
  }
  return { image, text, audio, cases, workCases, presentationCases, ...(videoCases ? { videoCases } : {}) }
}

export async function simulateQq(values = process.argv.slice(2)) {
  const parsed = argumentsFor(values)
  if (!parsed) return
  const args: Arguments = parsed
  process.umask(0o077)
  const original = await readNativeChatConfigurationUnlocked(args.source)
  const sourcePlan = original.catalog.plans.find(plan => plan.id === original.catalog.activePlanId)
  if (!sourcePlan) throw new Error('simulation_active_plan_required')
  const modelOverride = args.provider !== undefined && args.model !== undefined ? { provider: args.provider, model: args.model } : undefined
  if (modelOverride && !original.providers.some(provider => provider.id === modelOverride.provider)) throw new Error('simulation_provider_not_configured')
  const selectedPlan = validateChatPlan({ ...sourcePlan, ...modelOverride })
  const modelSelection = { provider: selectedPlan.provider, model: selectedPlan.model, modelOverride: modelOverride !== undefined }
  const ownerId = original.access.owner
  if (!ownerId || !/^[1-9][0-9]{0,14}$/.test(ownerId)) throw new Error('simulation_configured_owner_required')
  const selfId = '900000000001'
  const memberId = ownerId === '900000000002' ? '900000000005' : '900000000002'
  const groupId = '900000000003'
  await mkdir(resolve('runtime/simulations'), { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(resolve('runtime/simulations/qq-'))
  const nativeDirectory = join(directory, 'native')
  await mkdir(nativeDirectory, { mode: 0o700 })
  await copyConfiguration(args.source, nativeDirectory, modelOverride)
  const dsh = await prepareSimulationDsh({ directory, servicesFilename: args.services, configuration: original })
  const fixtures = await prepareFixtures(dsh.workspace, args.batch === 'video')
  const transcript = join(directory, 'events.jsonl')
  let lastBotMessageId: number | undefined
  const messageVariables = new Map<string, number>()
  const record = (entry: Readonly<Record<string, unknown>>) => {
    const event = { at: new Date().toISOString(), ...entry }
    appendFileSync(transcript, JSON.stringify(event) + '\n', { mode: 0o600 })
    if (entry.type === 'outbound') {
      if (typeof entry.messageId === 'number') lastBotMessageId = entry.messageId
      console.log(JSON.stringify(event))
    }
  }
  let protocol: Awaited<ReturnType<typeof startSimulatedOneBot>> | undefined
  let runtime: ReturnType<typeof createNativeChatRuntime> | undefined
  let stopActivitySnapshots: (() => Promise<void>) | undefined
  const lifetime = new AbortController()
  let lines: ReturnType<typeof createInterface> | undefined
  const abort = () => { lifetime.abort(); lines?.close() }
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  try {
    if (!args.prepareOnly) {
      protocol = await startSimulatedOneBot({ selfId, ownerId, memberId, groupId, directory, record })
      await protocol.registerAsset(fixtures.image, 'image')
    }
    await jsonFile(join(nativeDirectory, 'chat-access.json'), { schema: 1, owner: ownerId,
      allow: [`group:${groupId}`, `private:${ownerId}`, `private:${memberId}`], deny: [] })
    await jsonFile(join(nativeDirectory, 'chat-authorization.json'), { schema: 1,
      authorization: { version: 'whitelist-1', mode: 'whitelist', grants: [] } })
    await jsonFile(join(nativeDirectory, 'chat-adapters.json'), { schema: 1, adapters: {
      onebotHttp: { enabled: true, endpoint: protocol?.endpoint ?? 'http://127.0.0.1:9', secret: protocol?.secret ?? '' },
      onebotWs: { enabled: true, endpoint: protocol?.websocketEndpoint ?? 'ws://127.0.0.1:9/events', secret: protocol?.secret ?? '' },
      onebotWebhook: { enabled: false, host: '127.0.0.1', port: 0, selfId: '', hmac: '' }, dshAgent: dsh.configuration } })
    await jsonFile(join(nativeDirectory, 'chat-deployment.json'), { schema: 1, deployment: {
      ...original.deployment, target: dsh.target, namespace: 'qqsim', capabilityApproval: null } })
    await jsonFile(join(directory, 'simulation.json'), { schema: 1, sourceDirectory: args.source,
      nativeDirectory, dshHome: dsh.home, workspace: dsh.workspace, dshEndpoint: dsh.endpoint,
      protocolMode: 'local-capture', bundles: dsh.bundles, productionBootstrapMounted: false,
      fixtures, prepareOnly: args.prepareOnly, ...modelSelection })
    console.log(JSON.stringify({ type: 'simulation-created', directory, fixtures, prepareOnly: args.prepareOnly, ...modelSelection }))
    if (args.prepareOnly) return
    const peer = protocol!
    await dsh.start(lifetime.signal)
    const load = () => readNativeChatConfiguration(nativeDirectory)
    const deployment = createNativeDshDeploymentRuntime({ sessionDirectory: nativeDirectory, verificationTimeoutMs: 20_000 })
    const configuration = await load()
    const prepared = await deployment.prepare(configuration)
    if (prepared.state !== 'prepared') throw new Error(`simulation_chat_prepare_failed:${prepared.missingReasons.join(',')}`)
    const applied = await deployment.apply(configuration, lifetime.signal, prepared.targetRevision)
    if (applied.state === 'pending_reload') {
      record({ type: 'simulation-dsh-reload', reason: 'chat-deployment-pending-reload' })
      await dsh.stop()
      await dsh.start(lifetime.signal)
      const verified = await deployment.reconcile(configuration)
      if (verified.missingReasons.length > 0) throw new Error(`simulation_chat_reconcile_failed:${verified.missingReasons.join(',')}`)
    } else if (applied.state !== 'verified') throw new Error(`simulation_chat_apply_${applied.state}:${applied.missingReasons.join(',')}`)
    const repository = new NativeConfigurationRepository(nativeDirectory)
    const assistant = createNativeAssistantTarget({ directory: nativeDirectory, deploymentNamespace: 'qqsimwork',
      loadConfiguration: load, loadAssistant: () => repository.readAssistant() })
    const assistantDocument = await repository.readAssistant()
    if (assistantDocument.value.mode === 'chat-assistant') {
      let result = await applySavedAssistantTarget(assistant, assistantDocument.revision, lifetime.signal)
      if (result.state === 'pending_reload') {
        if (!result.configurationRevision) throw new Error('simulation_assistant_configuration_revision_missing')
        record({ type: 'simulation-dsh-reload', reason: 'assistant-deployment-pending-reload' })
        await dsh.stop()
        await dsh.start(lifetime.signal)
        result = await assistant.reconcile({ assistantRevision: result.assistantRevision,
          configurationRevision: result.configurationRevision, operationRevision: result.operationRevision }, lifetime.signal)
        const verified = await assistant.resolve(lifetime.signal)
        if (verified.missingReasons.length > 0) throw new Error(`simulation_assistant_resolve_failed:${verified.missingReasons.join(',')}`)
      }
      if (result.state !== 'verified') throw new Error(`simulation_assistant_${result.state}:${result.missingReasons.join(',')}`)
    }
    const packageConfigurationRegistry = createNativePackageConfigurationRegistry({ directory: nativeDirectory })
    const accessService = createAccessService({ ...createNativeAccessPersistence(nativeDirectory),
      async publish(saved, previous, signal) {
        if (!runtime) throw new Error('simulation_runtime_unavailable')
        await applyNativeAccessRuntime(nativeDirectory, runtime, previous.revision, saved.revision, signal)
      } })
    const accessCommand = createAccessCommandHandler({ readAccess: signal => accessService.read(signal),
      change: (request, signal) => accessService.change(request, signal) })
    runtime = createNativeChatRuntime({ directory: nativeDirectory, expectedSelfId: selfId, packageConfigurationRegistry,
      prepareAuthorization: () => prepareNativeChatAuthorization(nativeDirectory),
      controlCommands: [{ id: 'access-management', replyTexts: ACCESS_COMMAND_REPLIES,
        matches: message => parseAccessCommand(message) !== null,
        handle: context => accessCommand(context.message, context.reply, context.signal) }],
      loadConfiguration: load, resolveDeployment: configuration => deployment.reconcile(configuration),
      resolveWorkTarget: signal => assistant.resolve(signal),
      prepareWorkTarget: async signal => {
        const startedAt = Date.now()
        try {
          const prepared = await assistant.prepareWork(signal)
          record({ type: 'assistant-admission-prepared', durationMs: Date.now() - startedAt,
            configurationRevision: prepared.resolution.configurationRevision, missingReasons: prepared.resolution.missingReasons })
          return prepared
        } catch (error) {
          record({ type: 'assistant-admission-rejected', durationMs: Date.now() - startedAt,
            code: isRecord(error) && typeof error.code === 'string' ? error.code : 'ASSISTANT_PREPARATION_FAILED' })
          throw error
        }
      },
      async readWorkEnabled(signal) { signal.throwIfAborted(); return (await repository.readAssistant()).value.mode === 'chat-assistant' },
      async readWorkIdentity(signal) {
        signal.throwIfAborted()
        const { value } = await repository.readAssistant()
        return value.mode === 'chat-assistant' ? { nickname: value.nickname, model: value.model } : null
      } })
    const native = runtime
    const runId = basename(directory)
    let activityWrite: Promise<void> | undefined
    let usageWrite: Promise<void> | undefined
    let usagePublishedAt = 0
    const publishUsage = async () => {
      try { await publishSimulationUsage({ sourceDirectory: args.source, simulationDirectory: directory, runId }) }
      catch (error) {
        const code = isRecord(error) && typeof error.code === 'string' && /^[A-Z][A-Z_]{1,80}$/.test(error.code)
          ? error.code : 'SIMULATION_USAGE_PUBLISH_FAILED'
        record({ type: 'usage-publish-failed', code })
        console.error(JSON.stringify({ type: 'usage-publish-failed', code }))
      }
    }
    const queueUsage = () => {
      if (usageWrite || !native.usage() || Date.now() - usagePublishedAt < 2000) return
      usagePublishedAt = Date.now()
      const pending = publishUsage()
      usageWrite = pending
      void pending.finally(() => { if (usageWrite === pending) usageWrite = undefined })
    }
    const saveActivity = async () => {
      const temporary = join(directory, '.activity.json.tmp')
      await jsonFile(temporary, { schema: 1, source: 'simulation', simulation: true, runId,
        sourceDirectory: args.source, updatedAt: Date.now(), activity: native.activity() })
      await rename(temporary, join(directory, 'activity.json'))
    }
    const queueActivity = () => {
      queueUsage()
      if (activityWrite) return
      const pending = saveActivity().catch(() => record({ type: 'activity-snapshot-failed' }))
      activityWrite = pending
      void pending.finally(() => { if (activityWrite === pending) activityWrite = undefined })
    }
    await saveActivity()
    try { await publishSimulationActivityIndex({ root: dirname(directory), sourceDirectory: args.source, runIds: [runId] }) }
    catch (error) {
      const code = error instanceof Error && /^simulation_[a-z0-9_]+$/.test(error.message) ? error.message : 'simulation_activity_index_publish_failed'
      record({ type: 'activity-fault', code })
      console.error(JSON.stringify({ type: 'activity-fault', code }))
    }
    const activityTimer = setInterval(queueActivity, 400)
    activityTimer.unref()
    stopActivitySnapshots = async () => { clearInterval(activityTimer); await activityWrite; await saveActivity(); await usageWrite; await publishUsage() }
    await native.start((await load()).revisions, lifetime.signal)
    record({ type: 'ready', status: await native.status(), ...modelSelection })
    console.log(JSON.stringify({ type: 'ready', directory, groupId, memberId, members: peer.members, ...modelSelection,
      defaultActor: 'owner', defaultKind: 'group', defaultMention: true }))
    async function status() {
      const snapshot = { type: 'status', runtime: await native.status(), work: native.listWork(),
        activity: native.activity(), capturedSends: peer.sent() }
      record(snapshot)
      console.log(JSON.stringify(snapshot))
    }
    async function settle(maximumMs = 180_000) {
      const deadline = Date.now() + maximumMs
      let quietSince: number | undefined
      while (Date.now() < deadline) {
        lifetime.signal.throwIfAborted()
        const current = await native.status()
        const work = native.listWork().records
        const idle = !work.some(item => item.status === 'starting' || item.status === 'running' || item.delivery === 'delivering')
          && current.ingress.activeConversations === 0 && current.execution.metrics?.deadlines === 0
          && current.execution.metrics.pendingActions === 0
        if (idle) quietSince ??= Date.now()
        else quietSince = undefined
        if (quietSince !== undefined && Date.now() - quietSince >= 1500) { await status(); return }
        await delay(200, undefined, { signal: lifetime.signal })
      }
      await status()
      record({ type: 'settle-timeout', maximumMs })
      throw new Error('simulation_settle_timeout')
    }
    let previousVideoReads = 0
    async function consume(line: string): Promise<boolean> {
      const trimmed = line.trim()
      if (!trimmed) return true
      if (trimmed === '/quit') return false
      if (trimmed === '/status') { await status(); return true }
      if (trimmed === '/settle') { await settle(); return true }
      const input: unknown = trimmed.startsWith('{') ? JSON.parse(trimmed) : { text: line }
      if (!isRecord(input)) throw new Error('simulation_input_object_required')
      if (input.mediaSettings !== undefined) {
        if (Object.keys(input).length !== 1 || !isRecord(input.mediaSettings)
          || Object.keys(input.mediaSettings).join(',') !== 'observeVideo' || typeof input.mediaSettings.observeVideo !== 'boolean') throw new Error('simulation_invalid_media_settings')
        const previous = await packageConfigurationRegistry.read('media')
        const next = await packageConfigurationRegistry.compareAndSet('media', previous.revision,
          { schema: 1, observeVideo: input.mediaSettings.observeVideo }, lifetime.signal)
        record({ type: 'media-settings-changed', previous, next })
        console.log(JSON.stringify({ type: 'media-settings-changed', configuration: next.configuration }))
        return true
      }
      if (input.videoReads !== undefined) {
        const checkpoint = input.videoReads
        if (Object.keys(input).length !== 1 || !isRecord(checkpoint) || Object.keys(checkpoint).sort().join(',') !== 'expect,label'
          || typeof checkpoint.label !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(checkpoint.label)
          || !['none', 'some', 'unchanged'].includes(String(checkpoint.expect))) throw new Error('simulation_invalid_video_read_checkpoint')
        const reads = peer.videoReadCount()
        const matched = checkpoint.expect === 'none' ? reads === 0 : checkpoint.expect === 'some' ? reads > previousVideoReads : reads === previousVideoReads
        record({ type: 'asset-read-checkpoint', assetKind: 'video', label: checkpoint.label, expect: checkpoint.expect,
          reads, previousReads: previousVideoReads, matched })
        previousVideoReads = reads
        if (!matched) throw new Error('simulation_video_read_expectation_failed')
        return true
      }
      if (input.settings !== undefined) {
        if (!isRecord(input.settings) || !Object.keys(input.settings).every(key => ['media', 'bubbles', 'longTextAsForward', 'longTextThreshold'].includes(key))) throw new Error('simulation_invalid_settings')
        const previous = await packageConfigurationRegistry.read('chat-output')
        const next = await packageConfigurationRegistry.compareAndSet('chat-output', previous.revision,
          { ...validateNativeOutputConfiguration(previous.configuration), ...input.settings }, lifetime.signal)
        record({ type: 'settings-changed', previous, next })
        console.log(JSON.stringify({ type: 'settings-changed', configuration: next.configuration }))
        return true
      }
      if (input.status === true) { await status(); return true }
      if (typeof input.settleMs === 'number' && Number.isSafeInteger(input.settleMs) && input.settleMs > 0 && input.settleMs <= 600_000) {
        await settle(input.settleMs); return true
      }
      const waitMs = input.waitMs
      if (waitMs !== undefined && (typeof waitMs !== 'number' || !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 600_000)) throw new Error('simulation_invalid_wait')
      if (input.notice === 'poke' || input.notice === 'group_upload') {
        if (input.actor !== undefined && input.actor !== 'owner' && input.actor !== 'member') throw new Error('simulation_invalid_notice_actor')
        const actor = input.actor === 'member' ? 'member' : 'owner'
        const memberIndex = simulatedMemberIndex(input.actor, input.memberIndex)
        if (input.notice === 'poke') {
          if (input.kind !== undefined && input.kind !== 'group' && input.kind !== 'private'
            || input.target !== undefined && input.target !== 'self' && input.target !== 'other'
            || input.selfSender !== undefined && typeof input.selfSender !== 'boolean') throw new Error('simulation_invalid_poke')
          peer.poke(actor, { kind: input.kind === 'private' ? 'private' : 'group', target: input.target === 'other' ? 'other' : 'self',
            selfSender: input.selfSender === true, ...(actor === 'member' ? { memberIndex } : {}) })
        } else {
          if (typeof input.path !== 'string' || input.kind !== undefined && input.kind !== 'group'
            || input.busId !== undefined && (typeof input.busId !== 'number' || !Number.isSafeInteger(input.busId) || input.busId < 0)
            || input.groupId !== undefined && typeof input.groupId !== 'string') throw new Error('simulation_invalid_group_upload')
          const registered = await peer.uploadGroupFile(actor, resolve(input.path), {
            ...(actor === 'member' ? { memberIndex } : {}),
            ...(typeof input.busId === 'number' ? { busId: input.busId } : {}), ...(typeof input.groupId === 'string' ? { groupId: input.groupId } : {}) })
          console.log(JSON.stringify({ type: 'injected-notice', notice: 'group_upload', bytes: registered.size }))
        }
      }
      else if (input.text !== undefined) {
        if (typeof input.text !== 'string') throw new Error('simulation_invalid_message_text')
        input.text = input.text.replace(/\{\{([A-Za-z][A-Za-z0-9_-]{0,31})\}\}/g, (_match: string, name: string) => {
          const value = name === 'lastBotMessageId' ? lastBotMessageId : messageVariables.get(name)
          if (value === undefined) throw new Error('simulation_message_variable_missing')
          return String(value)
        })
        if (typeof input.replyTo === 'string' && input.replyTo.startsWith('$')) {
          const value = input.replyTo === '$lastBot' ? lastBotMessageId : messageVariables.get(input.replyTo.slice(1))
          if (value === undefined) throw new Error('simulation_reply_variable_missing')
          input.replyTo = value
        }
        const extra: Record<string, unknown>[] = []
        if (input.assets !== undefined) {
          if (!Array.isArray(input.assets) || input.assets.length > 16) throw new Error('simulation_invalid_assets')
          for (const asset of input.assets) {
            if (!isRecord(asset) || typeof asset.path !== 'string' || !['image', 'record', 'file', 'video'].includes(String(asset.kind))) throw new Error('simulation_invalid_asset')
            extra.push(await peer.registerAsset(resolve(asset.path), asset.kind as SimulatedAsset['kind']))
          }
        }
        let nodes: readonly Record<string, unknown>[] = []
        if (input.forward !== undefined) {
          if (!Array.isArray(input.forward) || input.forward.length < 1 || input.forward.length > 32 || !input.forward.every(isRecord)) throw new Error('simulation_invalid_forward')
          nodes = input.forward
        }
        if (input.forwardAssets !== undefined) {
          if (!Array.isArray(input.forwardAssets) || input.forwardAssets.length < 1 || input.forwardAssets.length > 8) throw new Error('simulation_invalid_forward_assets')
          const assets: SimulatedAsset[] = input.forwardAssets.map((asset: unknown) => {
            if (!isRecord(asset) || typeof asset.path !== 'string' || asset.kind !== 'image' && asset.kind !== 'record' && asset.kind !== 'file' && asset.kind !== 'video') throw new Error('simulation_invalid_forward_asset')
            return { path: resolve(asset.path), kind: asset.kind }
          })
          extra.push(await peer.registerForwardAssets(assets, nodes))
        } else if (nodes.length) extra.push(peer.registerForward(nodes))
        const message = messageInput(input)
        if (input.saveAs !== undefined && (typeof input.saveAs !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(input.saveAs))) throw new Error('simulation_invalid_message_variable')
        const messageId = peer.inject({ ...message, segments: [...extra, ...(message.segments ?? [])] })
        if (typeof input.saveAs === 'string') messageVariables.set(input.saveAs, messageId)
        console.log(JSON.stringify({ type: 'injected', messageId }))
      }
      else if (waitMs === undefined) throw new Error('simulation_message_text_required')
      if (typeof waitMs === 'number') await delay(waitMs, undefined, { signal: lifetime.signal })
      else if (args.batch) await settle()
      return true
    }
    if (args.batch) {
      const batchFile = args.batch === 'basic' ? fixtures.cases : args.batch === 'work' ? fixtures.workCases
        : args.batch === 'presentation' ? fixtures.presentationCases : args.batch === 'video' ? fixtures.videoCases : args.batch
      if (!batchFile) throw new Error('simulation_video_fixture_missing')
      const input = await readFile(batchFile, 'utf8')
      if (Buffer.byteLength(input) > 8 * 1024 * 1024) throw new Error('simulation_batch_too_large')
      for (const line of input.split(/\r?\n/)) if (!await consume(line)) break
      await settle()
    } else {
      console.log('输入消息或 JSON；/status 查看状态，/settle 等待本轮，/quit 退出。')
      lines = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY })
      for await (const line of lines) {
        try { if (!await consume(line)) break }
        catch (error) { console.error(error instanceof Error ? error.message : 'simulation_input_failed') }
      }
    }
    await status()
  } finally {
    lines?.close()
    await runtime?.close().catch(() => record({ type: 'runtime-close-unverified' }))
    await stopActivitySnapshots?.().catch(() => record({ type: 'activity-snapshot-final-failed' }))
    await protocol?.close()
    await dsh.stop()
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  simulateQq().catch((error: unknown) => {
    console.error(isRecord(error) && typeof error.code === 'string' ? error.code : error instanceof Error ? error.message : 'simulation_failed')
    process.exitCode = 1
  })
}
