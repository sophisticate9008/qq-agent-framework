import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTypeScriptSyntax } from './typescript-syntax.ts';
import { checkSourceRules } from './source-rules.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const excluded = new Set(['.git', 'node_modules', 'runtime', 'state', 'coverage', 'dist']);
// Offline design previews use browser scripts without a build step; application code remains TypeScript.
const designPreviewScripts = new Set(['app', 'connections', 'core', 'editors', 'overview', 'records']
  .map(name => `docs/design/full-console/${name}.js`));
const findings: string[] = [];
let checked = 0;

function walk(directory: string) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const location = path.join(directory, entry.name);
    const relative = path.relative(root, location);
    if (entry.isSymbolicLink()) { findings.push(`${relative}: symbolic link requires explicit review`); continue; }
    if (entry.isDirectory()) { walk(location); continue; }
    if (!entry.isFile()) { findings.push(`${relative}: unsupported file type`); continue; }
    if (fs.statSync(location).size > 1024 * 1024) { findings.push(`${relative}: oversized public file`); continue; }
    if (/^\.env(?:\.|$)/.test(entry.name) && entry.name !== '.env.example') findings.push(`${relative}: private environment file`);
    const source = fs.readFileSync(location, 'utf8');
    for (const pattern of [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /ghp_[A-Za-z0-9]{36}/,
      /github_pat_[A-Za-z0-9_]{50,}/, /sk-[A-Za-z0-9_-]{40,}/]) {
      if (pattern.test(source)) findings.push(`${relative}: possible credential format`);
    }
    if (/\.(?:mjs|js|cjs)$/.test(entry.name) && !designPreviewScripts.has(relative.split(path.sep).join('/'))) {
      findings.push(`${relative}: authored JavaScript must be TypeScript`);
    }
    if (/\.tsx?$/.test(entry.name)) {
      if (!checkTypeScriptSyntax(source, relative)) findings.push(`${relative}: TypeScript syntax check failed`);
      for (const finding of checkSourceRules(source, relative)) {
        findings.push(`${relative}:${finding.line}:${finding.column}: ${finding.code}: ${finding.message}`);
      }
    }
    checked++;
  }
}

walk(root);
if (findings.length) {
  for (const finding of findings) console.error(finding);
  process.exitCode = 1;
} else console.log(`Checked ${checked} public files: syntax, authored TypeScript rules, architecture and selected credential-format checks passed.`);
