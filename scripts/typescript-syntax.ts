import { spawnSync } from 'node:child_process';
import ts from 'typescript';

export function checkTypeScriptSyntax(source: string, filename = 'module.ts'): boolean {
  try {
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true, jsx: ts.JsxEmit.ReactJSX },
      reportDiagnostics: true,
      fileName: filename,
    });
    if (compiled.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) return false;
    const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
      input: compiled.outputText,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return result.status === 0 && result.signal === null && result.error === undefined;
  } catch {
    return false;
  }
}
