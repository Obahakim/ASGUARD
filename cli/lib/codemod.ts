import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as ts from 'typescript';
import type { Prompter } from './prompt';

export interface CodemodMatch { file: string; line: number; reason?: string }
export interface CodemodResult { applied: CodemodMatch[]; skipped: CodemodMatch[]; patch?: string; notes: string[] }
type TextEdit = { start: number; end: number; text: string };
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
const ignoreDirectories = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.asguard-backup']);

function scriptKind(filePath: string): ts.ScriptKind {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.tsx') return ts.ScriptKind.TSX;
  if (['.js', '.mjs', '.cjs'].includes(extension)) return ts.ScriptKind.JS;
  if (extension === '.jsx') return ts.ScriptKind.JSX;
  return ts.ScriptKind.TS;
}

function isStringLiteral(node: ts.Node): node is ts.StringLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function hasNearImport(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const check = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && isStringLiteral(node.moduleSpecifier)
      && (/^near-api-js(?:\/|$)/.test(node.moduleSpecifier.text) || /^@near-js\//.test(node.moduleSpecifier.text))) found = true;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.Identifier
      && (node.expression as ts.Identifier).text === 'require' && node.arguments[0] && isStringLiteral(node.arguments[0])
      && (/^near-api-js(?:\/|$)/.test(node.arguments[0].text) || /^@near-js\//.test(node.arguments[0].text))) found = true;
    ts.forEachChild(node, check);
  };
  check(sourceFile);
  return found;
}

function pure(node: ts.Expression): boolean {
  if (ts.isIdentifier(node) || node.kind === ts.SyntaxKind.ThisKeyword || ts.isStringLiteralLike(node)
    || ts.isNumericLiteral(node) || ts.isBigIntLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
  if (ts.isParenthesizedExpression(node)) return pure(node.expression);
  if (ts.isPropertyAccessExpression(node)) return pure(node.expression);
  if (ts.isElementAccessExpression(node)) return Boolean(node.argumentExpression && pure(node.expression)
    && (ts.isStringLiteralLike(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression) || ts.isBigIntLiteral(node.argumentExpression)));
  if (ts.isCallExpression(node)) {
    const expression = node.expression;
    const allowed = ts.isIdentifier(expression) && ['BigInt', 'String'].includes(expression.text)
      || ts.isPropertyAccessExpression(expression) && expression.name.text === 'parseNearAmount' && pure(expression.expression);
    return allowed && node.arguments.every((argument) => !ts.isSpreadElement(argument) && pure(argument as ts.Expression));
  }
  return false;
}

function simpleObject(node: ts.Expression): boolean {
  if (ts.isIdentifier(node) || node.kind === ts.SyntaxKind.ThisKeyword) return true;
  return ts.isPropertyAccessExpression(node) && simpleObject(node.expression);
}

function alreadyGuarded(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current?.parent) {
    current = current.parent;
    if (ts.isCallExpression(current)) {
      const callee = ts.isIdentifier(current.expression) ? current.expression.text
        : ts.isPropertyAccessExpression(current.expression) ? current.expression.name.text : '';
      if (['guardedTransfer', 'withAsguardApproval', 'guardedIntent', 'guardedChainSignature'].includes(callee)) return true;
    }
  }
  return false;
}

function collectImports(sourceFile: ts.SourceFile): ts.ImportDeclaration[] {
  return sourceFile.statements.filter(ts.isImportDeclaration);
}

function hasGuardImport(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const check = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
      && node.importClause.namedBindings.elements.some((entry) => entry.name.text === 'guardedTransfer')) found = true;
    if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
      if (declaration.initializer && ts.isCallExpression(declaration.initializer) && declaration.initializer.expression.kind === ts.SyntaxKind.Identifier
        && (declaration.initializer.expression as ts.Identifier).text === 'require' && declaration.name && ts.isObjectBindingPattern(declaration.name)
        && declaration.name.elements.some((entry) => ts.isIdentifier(entry.name) && entry.name.text === 'guardedTransfer')) found = true;
    }
    ts.forEachChild(node, check);
  };
  check(sourceFile);
  return found;
}

function moduleKind(project: string): { esm: boolean; nodeNext: boolean } {
  let esm = false;
  let nodeNext = false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')) as { type?: unknown };
    esm = pkg.type === 'module';
  } catch { /* package.json is optional */ }
  try {
    const configPath = path.join(project, 'tsconfig.json');
    if (fs.existsSync(configPath)) {
      const parsed = ts.parseConfigFileTextToJson(configPath, fs.readFileSync(configPath, 'utf8')).config as { compilerOptions?: { module?: unknown; moduleResolution?: unknown } };
      const moduleName = String(parsed.compilerOptions?.module || '').toLowerCase();
      const resolution = String(parsed.compilerOptions?.moduleResolution || '').toLowerCase();
      nodeNext = moduleName.includes('node16') || moduleName.includes('nodenext') || resolution.includes('node16') || resolution.includes('nodenext');
    }
  } catch { /* malformed project config leaves the default extension behavior */ }
  return { esm, nodeNext };
}

function importStatement(sourceFile: ts.SourceFile, filePath: string, guardPath: string, esm: boolean, nodeNext: boolean): TextEdit | undefined {
  if (hasGuardImport(sourceFile)) return undefined;
  let specifier = path.relative(path.dirname(filePath), guardPath).split(path.sep).join('/').replace(/\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/, '');
  if (!specifier.startsWith('.')) specifier = `./${specifier}`;
  const extension = path.extname(filePath).toLowerCase();
  const useJs = (esm && ['.js', '.jsx', '.mjs'].includes(extension)) || (nodeNext && ['.ts', '.tsx', '.mts', '.cts'].includes(extension));
  if (useJs) specifier += '.js';
  const statement = esm || ['.ts', '.tsx', '.mts', '.cts'].includes(extension)
    ? `import { guardedTransfer } from '${specifier}';` : `const { guardedTransfer } = require('${specifier}');`;
  const imports = collectImports(sourceFile);
  const requires = sourceFile.statements.filter((statement) => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some((declaration) => declaration.initializer && ts.isCallExpression(declaration.initializer)
      && declaration.initializer.expression.kind === ts.SyntaxKind.Identifier && (declaration.initializer.expression as ts.Identifier).text === 'require'));
  let index: number;
  if (imports.length || requires.length) index = Math.max(imports.at(-1)?.end ?? 0, requires.at(-1)?.end ?? 0);
  else {
    index = 0;
    const first = sourceFile.statements[0];
    if (first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === 'use strict') index = first.end;
    if (sourceFile.text.startsWith('#!')) {
      const end = sourceFile.text.indexOf('\n');
      index = Math.max(index, end < 0 ? sourceFile.text.length : end + 1);
    }
  }
  const newline = sourceFile.text.includes('\r\n') ? '\r\n' : '\n';
  const prefix = sourceFile.text.slice(0, index);
  const suffix = sourceFile.text.slice(index);
  const before = index > 0 && !prefix.endsWith(newline) ? newline : '';
  const after = suffix.startsWith(newline) ? '' : newline;
  return { start: index, end: index, text: `${before}${statement}${after}` };
}

export function transformSource(filePath: string, project: string, guardPath: string, source: string): { output: string; matches: CodemodMatch[]; skipped: CodemodMatch[] } {
  const kind = scriptKind(filePath);
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, kind);
  const relative = path.relative(project, filePath).split(path.sep).join('/');
  const matches: CodemodMatch[] = [];
  const skipped: CodemodMatch[] = [];
  const eligible = hasNearImport(sourceFile);
  const edits: TextEdit[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression) && ts.isPropertyAccessExpression(node.expression.expression)
      && node.expression.expression.name.text === 'sendMoney') {
      const call = node.expression;
      const object = (call.expression as ts.PropertyAccessExpression).expression;
      const line = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line + 1;
      if (!eligible) skipped.push({ file: relative, line, reason: 'skipped: no near-api-js import (possibly unrelated sendMoney method)' });
      else if (alreadyGuarded(call)) skipped.push({ file: relative, line, reason: 'already guarded' });
      else if (call.arguments.length !== 2 || call.arguments.some(ts.isSpreadElement)) skipped.push({ file: relative, line, reason: 'expected exactly two non-spread arguments' });
      else if (!simpleObject(object)) skipped.push({ file: relative, line, reason: 'impure account expression' });
      else if (!call.arguments.every((argument) => pure(argument as ts.Expression))) skipped.push({ file: relative, line, reason: 'impure arguments' });
      else {
        const objectText = object.getText(sourceFile);
        const receiver = call.arguments[0].getText(sourceFile);
        const amount = call.arguments[1].getText(sourceFile);
        const originalCall = call.getText(sourceFile);
        const replacement = `guardedTransfer({ sender: ${objectText}.accountId, receiver: ${receiver}, amount: String(${amount}) }, () => ${originalCall})`;
        edits.push({ start: call.getStart(sourceFile), end: call.end, text: replacement });
        matches.push({ file: relative, line });
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  if (!edits.length) return { output: source, matches, skipped };
  const format = moduleKind(project);
  const importEdit = importStatement(sourceFile, filePath, guardPath, format.esm || ['.mjs', '.mts'].includes(path.extname(filePath)), format.nodeNext);
  if (importEdit) edits.push(importEdit);
  edits.sort((left, right) => right.start - left.start);
  let output = source;
  for (const edit of edits) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return { output, matches, skipped };
}

function listSourceFiles(project: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || (entry.isDirectory() && ignoreDirectories.has(entry.name))) continue;
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(filePath);
      else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name).toLowerCase())) files.push(filePath);
    }
  };
  walk(project);
  return files;
}

function createBackup(project: string, filePath: string, epoch: number): string {
  const backupPath = path.join(project, '.asguard-backup', String(epoch), path.relative(project, filePath));
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
  return backupPath;
}

function unifiedDiff(project: string, filePath: string, before: string, after: string): string {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-diff-'));
  try {
    const left = path.join(temp, 'before');
    const right = path.join(temp, 'after');
    fs.writeFileSync(left, before);
    fs.writeFileSync(right, after);
    const diff = spawnSync('git', ['diff', '--no-index', '--no-color', '--', left, right], { encoding: 'utf8', shell: false });
    const relative = path.relative(project, filePath).split(path.sep).join('/');
    return (diff.stdout || '').replace(/^diff --git .*$/m, `diff --git a/${relative} b/${relative}`)
      .replace(/^--- .*$/m, `--- a/${relative}`).replace(/^\+\+\+ .*$/m, `+++ b/${relative}`).replace(/^index .*$/m, '');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

export async function applySendMoneyGuard(options: {
  project: string; guardPath: string; yes: boolean; apply: boolean; forceNoGit: boolean;
  patchPath?: string; prompter?: Prompter;
  printDiff?: boolean;
  verify?: (expectedGuarded: number) => boolean;
}): Promise<CodemodResult> {
  const result: CodemodResult = { applied: [], skipped: [], notes: [] };
  const git = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: options.project, encoding: 'utf8', shell: false, stdio: 'ignore' });
  const isGit = git.status === 0;
  if (!isGit && !options.forceNoGit) { result.notes.push('Codemod skipped: project is not a git repository (use --force-no-git to allow with backups).'); return result; }
  const changes: Array<{ filePath: string; before: string; after: string; matches: CodemodMatch[] }> = [];
  for (const filePath of listSourceFiles(options.project)) {
    const before = fs.readFileSync(filePath, 'utf8');
    const transformed = transformSource(filePath, options.project, options.guardPath, before);
    result.skipped.push(...transformed.skipped);
    if (transformed.output !== before) changes.push({ filePath, before, after: transformed.output, matches: transformed.matches });
  }
  if (!changes.length) {
    if (!result.skipped.length) result.notes.push('No simple near-api-js sendMoney calls were found.');
    return result;
  }
  if (isGit) for (const change of changes) {
    const status = spawnSync('git', ['status', '--porcelain', '--', path.relative(options.project, change.filePath)], { cwd: options.project, encoding: 'utf8', shell: false });
    if (status.status !== 0 || status.stdout.trim()) {
      result.notes.push(`Codemod refused dirty file: ${path.relative(options.project, change.filePath)}`);
      return result;
    }
  }
  const diffs = changes.map((change) => unifiedDiff(options.project, change.filePath, change.before, change.after));
  if (options.printDiff !== false && !options.patchPath) for (const diff of diffs) process.stdout.write(diff);
  if (options.patchPath) {
    fs.writeFileSync(path.resolve(options.project, options.patchPath), diffs.join(''));
    result.patch = path.resolve(options.project, options.patchPath);
    return result;
  }
  if (!options.apply) { result.notes.push('Review the displayed diff; apply with --apply-guard.'); return result; }
  if (!options.yes && options.prompter) {
    for (let index = 0; index < changes.length; index += 1) if (!await options.prompter.confirm(`Apply guard to ${path.relative(options.project, changes[index].filePath)}?`, false)) {
      result.notes.push(`Not applied: ${path.relative(options.project, changes[index].filePath)}`);
      changes.splice(index, 1); diffs.splice(index, 1); index -= 1;
    }
  }
  if (!changes.length) return result;
  const epoch = Math.floor(Date.now() / 1000);
  const backups: Array<{ filePath: string; backupPath: string }> = [];
  try {
    for (const change of changes) backups.push({ filePath: change.filePath, backupPath: createBackup(options.project, change.filePath, epoch) });
    for (const change of changes) fs.writeFileSync(change.filePath, change.after);
    for (const change of changes) {
      const diagnostics = ts.transpileModule(change.after, { fileName: change.filePath, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } }).diagnostics ?? [];
      if (diagnostics.some((item) => item.category === ts.DiagnosticCategory.Error)) throw new Error(`Syntax verification failed for ${path.relative(options.project, change.filePath)}.`);
    }
    if (options.verify && !options.verify(changes.reduce((total, change) => total + change.matches.length, 0))) {
      throw new Error('Checker verification failed; all transformed files were restored from backup.');
    }
    result.applied.push(...changes.flatMap((change) => change.matches));
  } catch (error) {
    for (const backup of backups) fs.copyFileSync(backup.backupPath, backup.filePath);
    result.applied = [];
    result.notes.push(error instanceof Error ? error.message : 'Codemod failed and source files were restored.');
  }
  return result;
}
