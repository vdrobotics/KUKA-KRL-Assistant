import * as vscode from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind
} from 'vscode-languageclient/node';
import * as path from 'path';
import * as fs from 'fs';

// Diagnostic collection for KRL language
const diagnosticCollection = vscode.languages.createDiagnosticCollection('krl');
let client: LanguageClient;

interface ValidationConfig {
  variableNameLength: boolean;
  variableNameSyntax: boolean;
  undeclaredIdentifiers: boolean;
  globalUsage: boolean;
  defdatPublicGlobalRequired: boolean;
  defdatNonPublicGlobalForbidden: boolean;
}

function getValidationConfig(): ValidationConfig {
  const cfg = vscode.workspace.getConfiguration('kukaKrl');
  return {
    variableNameLength: cfg.get<boolean>('validation.variableNameLength', true),
    variableNameSyntax: cfg.get<boolean>('validation.variableNameSyntax', true),
    undeclaredIdentifiers: cfg.get<boolean>('validation.undeclaredIdentifiers', false),
    globalUsage: cfg.get<boolean>('validation.globalUsage', true),
    defdatPublicGlobalRequired: cfg.get<boolean>('validation.defdatPublicGlobalRequired', true),
    defdatNonPublicGlobalForbidden: cfg.get<boolean>('validation.defdatNonPublicGlobalForbidden', true),
  };
}

interface DeclaredName {
  name: string;
  start: number;
}

function pushConfigToServer(): void {
  if (!client) return;
  const cfg = getValidationConfig();
  client.sendNotification('custom/setValidationConfig', {
    defdatPublicGlobalRequired: cfg.defdatPublicGlobalRequired,
    defdatNonPublicGlobalForbidden: cfg.defdatNonPublicGlobalForbidden,
    undeclaredIdentifiers: cfg.undeclaredIdentifiers,
  });
}

/**
 * Extension activation function
 */
export function activate(context: vscode.ExtensionContext) {
  // Path to the language server module
  const serverModule = context.asAbsolutePath(path.join('server', 'out', 'server.js'));

  // Server options for run and debug modes
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc }
  };

  // Client options, including document selector and file watchers
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'krl' }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{dat,src,sub}')
    }
  };

  // Create the language client
  client = new LanguageClient('kukaKRL', 'KUKA KRL Language Server', serverOptions, clientOptions);

  // Register event handlers for document open/change/save
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(document => {
      if (document.languageId === 'krl') {
        validateTextDocument(document);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.languageId === 'krl') {
        validateTextDocument(event.document);
        client.sendNotification('custom/validateFile', {
          uri: event.document.uri.toString(),
          text: event.document.getText(),
        });
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(document => {
      if (document.languageId === 'krl') {
        validateTextDocument(document);
      }
    })
  );

  // React to configuration changes: re-run client validation on all open KRL docs
  // and push the latest config to the server (which will re-validate .dat files).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('kukaKrl')) return;
      vscode.workspace.textDocuments.forEach(doc => {
        if (doc.languageId === 'krl') validateTextDocument(doc);
      });
      pushConfigToServer();
    })
  );

  // Start the language client
  client.start().then(() => {
    // Send initial validation config so the server gates its own checks correctly.
    pushConfigToServer();

    // After client starts, validate all already opened KRL documents
    vscode.workspace.textDocuments.forEach(doc => {
      if (doc.languageId === 'krl') {
        validateTextDocument(doc);
      }
    });

    // Also trigger a full workspace validation shortly after activation
    setTimeout(() => {
      validateAllKrlFiles();
    }, 1000);
  });

  // Dispose the diagnostic collection on extension deactivate
  context.subscriptions.push(diagnosticCollection);
}

/**
 * Validate a single KRL text document
 * Produces diagnostics for variable name length and improper GLOBAL usage
 */
function validateTextDocument(document: vscode.TextDocument): void {
  const cfg = getValidationConfig();
  const diagnostics: vscode.Diagnostic[] = [];

  // If all client-side checks are off, just clear stale diagnostics and bail out.
  if (!cfg.variableNameLength && !cfg.variableNameSyntax && !cfg.globalUsage) {
    diagnosticCollection.set(document.uri, diagnostics);
    return;
  }

  for (let i = 0; i < document.lineCount; i++) {
    try {
      const line = document.lineAt(i);
      const fullText = line.text;
      const lineText = fullText.split(';')[0].trim(); // Ignore comments
      if (lineText.startsWith('&')) continue;

      if ((cfg.variableNameLength || cfg.variableNameSyntax) && isVariableDeclarationLine(lineText)) {
        for (const declaredName of getDeclaredNames(fullText)) {
          if (isSystemVariableName(declaredName.name)) continue;

          if (cfg.variableNameLength && declaredName.name.length > 24) {
            const range = new vscode.Range(i, declaredName.start, i, declaredName.start + declaredName.name.length);
            diagnostics.push(new vscode.Diagnostic(
              range,
              'The variable name is too long (max 24 characters).',
              vscode.DiagnosticSeverity.Error
            ));
          }

          if (cfg.variableNameSyntax) {
            const invalidReason = getInvalidVariableNameReason(declaredName.name);
            if (invalidReason) {
              const range = new vscode.Range(i, declaredName.start, i, declaredName.start + declaredName.name.length);
              diagnostics.push(new vscode.Diagnostic(
                range,
                invalidReason,
                vscode.DiagnosticSeverity.Error
              ));
            }
          }
        }
      }

      // Check for standalone GLOBAL usage without DECL, DEF, DEFFCT, STRUC, SIGNAL
      if (cfg.globalUsage && /\bGLOBAL\b/i.test(lineText) && !/\b(DECL|DEF|DEFFCT|STRUC|SIGNAL|ENUM)\b/i.test(lineText)&& !/\b(INT|REAL|FRAME|CHAR|BOOL|STRING|E6AXIS|E6POS|AXIS|LOAD)\b/i.test(lineText)) {
        const globalMatch = /\bGLOBAL\b/i.exec(fullText);
        const globalIndex = globalMatch ? globalMatch.index : 0;
        const range = new vscode.Range(i, globalIndex, i, globalIndex + 'GLOBAL'.length);
        diagnostics.push(new vscode.Diagnostic(
          range,
          `'GLOBAL' must be used with DECL, STRUC, or SIGNAL on the same line, except if it's used with a predefined types.`,
          vscode.DiagnosticSeverity.Warning
        ));
      }
    } catch (error) {
      console.error(`Error processing line ${i + 1}:`, error);
    }
  }

  diagnosticCollection.set(document.uri, diagnostics);
}

function isVariableDeclarationLine(lineText: string): boolean {
  return /^\s*(?:(?:GLOBAL\s+)?DECL|DECL\s+GLOBAL|(?:GLOBAL\s+)?SIGNAL|(?:GLOBAL\s+)?STRUC|GLOBAL\s+(?:CONST\s+)?(?:INT|REAL|BOOL|CHAR|STRING|FRAME|E6POS|E6AXIS|AXIS|LOAD|LOAD_DATA)\b)/i.test(lineText);
}

function getDeclaredNames(fullLine: string): DeclaredName[] {
  const commentStart = fullLine.indexOf(';');
  const code = commentStart >= 0 ? fullLine.slice(0, commentStart) : fullLine;
  const trimmed = code.trimStart();
  const offset = code.length - trimmed.length;

  const signalMatch = /^(?:GLOBAL\s+)?SIGNAL\s+([^\s=,\[]+)/i.exec(trimmed);
  if (signalMatch) {
    return [{ name: signalMatch[1], start: offset + signalMatch.index + signalMatch[0].lastIndexOf(signalMatch[1]) }];
  }

  const structMatch = /^(?:GLOBAL\s+)?STRUC\s+([^\s=,\[]+)\s*(.*)$/i.exec(trimmed);
  if (structMatch) {
    const names: DeclaredName[] = [{
      name: structMatch[1],
      start: offset + structMatch.index + structMatch[0].indexOf(structMatch[1])
    }];
    const memberPart = structMatch[2];
    const memberOffset = offset + structMatch[0].length - memberPart.length;
    names.push(...getStructMemberNames(memberPart, memberOffset));
    return names;
  }

  const declMatch = /^(?:(?:GLOBAL\s+)?DECL\s+(?:GLOBAL\s+)?|GLOBAL\s+)(?:CONST\s+)?([A-Za-z][A-Za-z0-9_]*)\s+(.+)$/i.exec(trimmed);
  if (!declMatch) return [];

  const varPart = declMatch[2];
  const varOffset = offset + declMatch[0].length - varPart.length;
  return getVariableListNames(varPart, varOffset);
}

function getVariableListNames(varPart: string, offset: number): DeclaredName[] {
  const names: DeclaredName[] = [];
  const tokens = splitRespectingBrackets(varPart);
  let searchStart = 0;

  for (const token of tokens) {
    const tokenIndex = varPart.indexOf(token, searchStart);
    searchStart = tokenIndex + token.length;
    const candidate = /^[\s]*([^\s=\[]+)/.exec(token);
    if (!candidate) continue;

    names.push({
      name: candidate[1],
      start: offset + tokenIndex + candidate[0].indexOf(candidate[1])
    });
  }

  return names;
}

function getStructMemberNames(memberPart: string, offset: number): DeclaredName[] {
  const names: DeclaredName[] = [];
  const typeRegex = /\b(INT|REAL|BOOL|CHAR|STRING|FRAME|E6POS|E6AXIS|AXIS|LOAD|LOAD_DATA)\b/gi;
  const typeMatches = Array.from(memberPart.matchAll(typeRegex));

  for (let i = 0; i < typeMatches.length; i++) {
    const match = typeMatches[i];
    const nextMatch = typeMatches[i + 1];
    const typeStart = match.index ?? 0;
    const nextTypeStart = nextMatch ? nextMatch.index ?? memberPart.length : memberPart.length;
    const varStart = typeStart + match[0].length;
    const varEnd = nextTypeStart;
    const varPart = memberPart.slice(varStart, varEnd).replace(/,\s*$/, '');
    names.push(...getVariableListNames(varPart, offset + varStart));
  }

  return names;
}

function getInvalidVariableNameReason(name: string): string | undefined {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    return 'Invalid KRL variable name. Use letters, digits, and underscores, and start with a letter.';
  }

  return undefined;
}

function isSystemVariableName(name: string): boolean {
  return /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function splitRespectingBrackets(input: string): string[] {
  const result: string[] = [];
  let current = '';
  let bracketDepth = 0;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '[') bracketDepth++;
    if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);

    if (char === ',' && bracketDepth === 0) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) result.push(current.trim());
  return result;
}

/**
 * Validate all KRL files in the workspace with extensions .src, .dat, .sub
 */
async function validateAllKrlFiles(): Promise<void> {
  const patterns = ['**/*.src', '**/*.dat', '**/*.sub'];
  const uris: vscode.Uri[] = [];

  // Collect all matching files
  for (const pattern of patterns) {
    const matched = await vscode.workspace.findFiles(pattern);
    uris.push(...matched);
  }

  // Validate each file (opening it if needed)
  for (const file of uris) {
    try {
      let document = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === file.fsPath);
      if (!document) {
        document = await vscode.workspace.openTextDocument(file);
      }
      if (document.languageId === 'krl') {
        validateTextDocument(document);
      }
    } catch (error) {
      console.error(`Failed to validate ${file.fsPath}`, error);
    }
  }
}

/**
 * Append a timestamped message to the log file.
 */

const logFile = path.join(__dirname, 'krl-extension.log');
function logToFile(message: string) {
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
}

/**
 * Extension deactivation handler
 */
export function deactivate(): Thenable<void> | undefined {
  diagnosticCollection.clear();
  diagnosticCollection.dispose();
  if (!client) return undefined;
  return client.stop();
}
