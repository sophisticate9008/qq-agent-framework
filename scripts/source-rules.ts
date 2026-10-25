import path from 'node:path';
import ts from 'typescript';

export interface SourceFinding {
  readonly line: number;
  readonly column: number;
  readonly code: 'explicit-any' | 'type-suppression' | 'architecture';
  readonly message: string;
}

interface Dependency { readonly specifier: string; readonly typeOnly: boolean; readonly node: ts.Node }

function dependencies(source: ts.SourceFile): Dependency[] {
  const found: Dependency[] = [];
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const typeOnly = clause?.isTypeOnly === true || clause?.name === undefined && named !== undefined
        && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every(element => element.isTypeOnly);
      found.push({ specifier: node.moduleSpecifier.text, typeOnly, node });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const typeOnly = node.isTypeOnly || clause !== undefined && ts.isNamedExports(clause)
        && clause.elements.length > 0 && clause.elements.every(element => element.isTypeOnly);
      found.push({ specifier: node.moduleSpecifier.text, typeOnly, node });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
      found.push({ specifier: node.moduleReference.expression.text, typeOnly: node.isTypeOnly, node });
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      const argument = node.arguments[0];
      if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
        found.push({ specifier: argument.text, typeOnly: false, node });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

function architecturalViolation(filename: string, dependency: Dependency): boolean {
  const specifier = dependency.specifier;
  const target = specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(filename), specifier))
    : specifier.startsWith('@/') ? `web/${specifier.slice(2)}` : specifier;
  const inLayer = (layer: string): boolean => target.startsWith(`src/${layer}/`);
  // Type dependencies are still dependencies of core and browser-safe contracts.
  if (filename.startsWith('src/core/')) {
    return target.startsWith('web/') || target.startsWith('src/') && !inLayer('core') && !inLayer('contracts');
  }
  if (filename.startsWith('src/contracts/')) {
    return specifier.startsWith('node:') || target.startsWith('web/')
      || target.startsWith('src/') && !inLayer('contracts') && !(dependency.typeOnly && inLayer('core'));
  }
  if (dependency.typeOnly) return false;
  if (filename.startsWith('src/host/')) return inLayer('admin') || target.startsWith('web/');
  if (filename.startsWith('src/features/')) {
    return inLayer('adapters') || inLayer('storage') || inLayer('admin')
      || /^(?:node:)?(?:fs|http|https|net|tls|dgram|child_process|sqlite)(?:\/|$)/.test(specifier)
      || ['ws', 'undici'].includes(specifier);
  }
  return false;
}

/** These rules inspect authored TS/TSX only; dependency/build directories are excluded by the caller. */
export function checkSourceRules(text: string, filename: string): readonly SourceFinding[] {
  const normalized = filename.replaceAll('\\', '/');
  const source = ts.createSourceFile(normalized, text, ts.ScriptTarget.Latest, true,
    normalized.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const findings: SourceFinding[] = [];
  function add(position: number, code: SourceFinding['code'], message: string): void {
    const location = source.getLineAndCharacterOfPosition(position);
    findings.push({ line: location.line + 1, column: location.character + 1, code, message });
  }
  function visit(node: ts.Node): void {
    if (node.kind === ts.SyntaxKind.AnyKeyword) add(node.getStart(source), 'explicit-any', 'Use an explicit type or unknown instead of any');
    if (normalized.startsWith('src/features/') && ts.isCallExpression(node)
      && (ts.isIdentifier(node.expression) && node.expression.text === 'fetch'
        || ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
          && ['globalThis', 'window'].includes(node.expression.expression.text) && node.expression.name.text === 'fetch')) {
      add(node.getStart(source), 'architecture', 'Feature network effects must use a controlled host service');
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  // Scan actual comments only, preserving string/regex/JSX text containing these words.
  const comments = new Set<number>();
  function inspectComments(node: ts.Node): void {
    for (const range of [...ts.getLeadingCommentRanges(text, node.pos) ?? [], ...ts.getTrailingCommentRanges(text, node.end) ?? []]) {
      if (comments.has(range.pos)) continue;
      comments.add(range.pos);
      if (/\x40ts-(?:ignore|nocheck)\b/.test(text.slice(range.pos, range.end))) {
        add(range.pos, 'type-suppression', 'Type checking suppression is forbidden');
      }
    }
    ts.forEachChild(node, inspectComments);
  }
  inspectComments(source);
  for (const dependency of dependencies(source)) {
    if (architecturalViolation(normalized, dependency)) {
      add(dependency.node.getStart(source), 'architecture', `Forbidden layer dependency: ${dependency.specifier}`);
    }
  }
  return findings;
}
