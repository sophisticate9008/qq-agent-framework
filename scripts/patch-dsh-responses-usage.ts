import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, rename, unlink, lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import ts from 'typescript'

const [runtimeDirectory, ...extra] = process.argv.slice(2)
if (!runtimeDirectory || extra.length > 0) throw new Error('Usage: node scripts/patch-dsh-responses-usage.ts <DSH Node project directory>')
const modules = join(resolve(runtimeDirectory), 'node_modules')
for (const [name, version] of [['@earendil-works/pi-ai', '1.4.0'], ['@deepseek-ai/dsh-llm-pi-ai', '0.2.1-rc.2']] as const) {
  const manifest: unknown = JSON.parse(await readFile(join(modules, name, 'package.json'), 'utf8'))
  if (manifest === null || typeof manifest !== 'object' || !('name' in manifest) || manifest.name !== name
    || !('version' in manifest) || manifest.version !== version) throw new Error(`Unsupported package; expected ${name} ${version}`)
}
const apiDirectory = join(modules, '@earendil-works/pi-ai/dist/api')
const helper = join(apiDirectory, 'qaf-responses-usage.js')
const responsesOriginal = `            const inputDetails = response.usage.input_tokens_details;
            const cachedTokens = inputDetails?.cached_tokens || 0;
            const cacheWriteTokens = inputDetails?.cache_write_tokens || 0;
            output.usage = {
                // OpenAI includes cached and cache-write tokens in input_tokens, so subtract both.
                input: Math.max(0, (response.usage.input_tokens || 0) - cachedTokens - cacheWriteTokens),
                output: response.usage.output_tokens || 0,
                cacheRead: cachedTokens,
                cacheWrite: cacheWriteTokens,
                reasoning: response.usage.output_tokens_details?.reasoning_tokens || 0,
                totalTokens: response.usage.total_tokens || 0,
`
const responsesPrevious = `            output.usage = {
                ...qafReadResponsesUsage(response.usage),
`
const responsesReplacement = `            output.usage = {
                ...qafReadResponsesUsage(response.usage, new URL("./qaf-provider-usage-observed.json", import.meta.url)),
`
const completionsOriginal = `        totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
`
const completionsReplacement = `        totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
        ...qafReadCacheUsagePresence(rawUsage, new URL("./qaf-provider-usage-observed.json", import.meta.url)),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
`
const adapterOriginal = `function mapUsage(usage) {
\treturn {
\t\tinputTokens: usage.input,
\t\toutputTokens: usage.output,
\t\ttotalTokens: usage.totalTokens,
\t\t...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
\t\t...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}
\t};
}`
const adapterReplacement = `// qaf-cache-report-presence/1: explicit provider zeros survive the standard optional fields.
function mapUsage(usage) {
\treturn {
\t\tinputTokens: usage.input,
\t\toutputTokens: usage.output,
\t\ttotalTokens: usage.totalTokens,
\t\t...usage.qafCacheReadReported === true || usage.qafCacheReadReported === undefined && usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
\t\t...usage.qafCacheWriteReported === true || usage.qafCacheWriteReported === undefined && usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}
\t};
}`
const definitions = [
  { target: join(apiDirectory, 'openai-responses-shared.js'),
    marker: 'import { readResponsesUsage as qafReadResponsesUsage } from "./qaf-responses-usage.js";\n',
    original: responsesOriginal, replacement: responsesReplacement, previous: responsesPrevious },
  { target: join(apiDirectory, 'openai-completions.js'),
    marker: 'import { readCacheUsagePresence as qafReadCacheUsagePresence } from "./qaf-responses-usage.js";\n',
    original: completionsOriginal, replacement: completionsReplacement, previous: undefined },
  { target: join(modules, '@deepseek-ai/dsh-llm-pi-ai/lib/index.js'), marker: '',
    original: adapterOriginal, replacement: adapterReplacement, previous: undefined },
]
// Validate every source before creating backups or touching any installed file.
const updates = []
for (const definition of definitions) {
  const { target, marker, original, replacement, previous } = definition
  const source = await readFile(target, 'utf8')
  const stat = await lstat(target)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected regular SDK source files')
  const body = marker && source.startsWith(marker) ? source.slice(marker.length) : source
  const installedBlock = body.includes(replacement) ? replacement : previous && body.includes(previous) ? previous : undefined
  const base = installedBlock ? body.replace(installedBlock, original) : body
  if (base.split(original).length !== 2 || marker && base.includes(marker.trim())
    || installedBlock && body.split(installedBlock).length !== 2
    || marker && source.startsWith(marker) !== Boolean(installedBlock)) {
    throw new Error(`Unsupported usage source in ${target}; no SDK files changed`)
  }
  updates.push({ target, source, original: base, next: marker + base.replace(original, replacement), mode: stat.mode & 0o777 })
}
const helperSource = await readFile(new URL('../src/adapters/responses-usage.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(helperSource, { fileName: 'responses-usage.ts',
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, strict: true }, reportDiagnostics: true })
if (compiled.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) throw new Error('Unable to compile usage helper')
const generated = '// Generated from QQ Agent Framework src/adapters/responses-usage.ts.\n' + compiled.outputText
for (const update of updates) {
  const backup = update.target + '.qaf-usage-original'
  try { await writeFile(backup, update.original, { flag: 'wx', mode: update.mode }) }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
    if (await readFile(backup, 'utf8') !== update.original) throw new Error('Existing SDK backup differs; no SDK source changed')
  }
}
async function atomicWrite(filename: string, content: string, mode: number): Promise<void> {
  try { if (await readFile(filename, 'utf8') === content) return }
  catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error }
  const temporary = `${filename}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { flag: 'wx', mode })
    await rename(temporary, filename)
  } finally { await unlink(temporary).catch(() => undefined) }
}
// Install the dependency first. Interrupted installations are safe to rerun.
await atomicWrite(helper, generated, updates[0].mode)
for (const update of updates) {
  if (await readFile(update.target, 'utf8') !== update.source) throw new Error('SDK source changed concurrently; rerun after maintenance is quiet')
  await atomicWrite(update.target, update.next, update.mode)
}
console.log(`Provider usage compatibility installed (pi-ai 1.4.0, dsh-llm-pi-ai 0.2.1-rc.2, helper ${createHash('sha256').update(generated).digest('hex').slice(0, 12)}). Restart DSH to load it.`)
