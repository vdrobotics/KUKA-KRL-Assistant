"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = require("vscode");
const node_1 = require("vscode-languageclient/node");
const path = require("path");
const fs = require("fs");
// Diagnostic collection for KRL language
const diagnosticCollection = vscode.languages.createDiagnosticCollection('krl');
let client;
function getValidationConfig() {
    const cfg = vscode.workspace.getConfiguration('kukaKrl');
    return {
        variableNameLength: cfg.get('validation.variableNameLength', true),
        variableNameSyntax: cfg.get('validation.variableNameSyntax', true),
        undeclaredIdentifiers: cfg.get('validation.undeclaredIdentifiers', false),
        globalUsage: cfg.get('validation.globalUsage', true),
        defdatPublicGlobalRequired: cfg.get('validation.defdatPublicGlobalRequired', true),
        defdatNonPublicGlobalForbidden: cfg.get('validation.defdatNonPublicGlobalForbidden', true),
    };
}
function pushConfigToServer() {
    if (!client)
        return;
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
function activate(context) {
    // Path to the language server module
    const serverModule = context.asAbsolutePath(path.join('server', 'out', 'server.js'));
    // Server options for run and debug modes
    const serverOptions = {
        run: { module: serverModule, transport: node_1.TransportKind.ipc },
        debug: { module: serverModule, transport: node_1.TransportKind.ipc }
    };
    // Client options, including document selector and file watchers
    const clientOptions = {
        documentSelector: [{ scheme: 'file', language: 'krl' }],
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{dat,src,sub}')
        }
    };
    // Create the language client
    client = new node_1.LanguageClient('kukaKRL', 'KUKA KRL Language Server', serverOptions, clientOptions);
    // Register event handlers for document open/change/save
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
        if (document.languageId === 'krl') {
            validateTextDocument(document);
        }
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.languageId === 'krl') {
            validateTextDocument(event.document);
            client.sendNotification('custom/validateFile', {
                uri: event.document.uri.toString(),
                text: event.document.getText(),
            });
        }
    }));
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
        if (document.languageId === 'krl') {
            validateTextDocument(document);
        }
    }));
    // React to configuration changes: re-run client validation on all open KRL docs
    // and push the latest config to the server (which will re-validate .dat files).
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (!e.affectsConfiguration('kukaKrl'))
            return;
        vscode.workspace.textDocuments.forEach(doc => {
            if (doc.languageId === 'krl')
                validateTextDocument(doc);
        });
        pushConfigToServer();
    }));
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
exports.activate = activate;
/**
 * Validate a single KRL text document
 * Produces diagnostics for variable name length and improper GLOBAL usage
 */
function validateTextDocument(document) {
    const cfg = getValidationConfig();
    const diagnostics = [];
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
            if (lineText.startsWith('&'))
                continue;
            if ((cfg.variableNameLength || cfg.variableNameSyntax) && isVariableDeclarationLine(lineText)) {
                for (const declaredName of getDeclaredNames(fullText)) {
                    if (isSystemVariableName(declaredName.name))
                        continue;
                    if (cfg.variableNameLength && declaredName.name.length > 24) {
                        const range = new vscode.Range(i, declaredName.start, i, declaredName.start + declaredName.name.length);
                        diagnostics.push(new vscode.Diagnostic(range, 'The variable name is too long (max 24 characters).', vscode.DiagnosticSeverity.Error));
                    }
                    if (cfg.variableNameSyntax) {
                        const invalidReason = getInvalidVariableNameReason(declaredName.name);
                        if (invalidReason) {
                            const range = new vscode.Range(i, declaredName.start, i, declaredName.start + declaredName.name.length);
                            diagnostics.push(new vscode.Diagnostic(range, invalidReason, vscode.DiagnosticSeverity.Error));
                        }
                    }
                }
            }
            // Check for standalone GLOBAL usage without DECL, DEF, DEFFCT, STRUC, SIGNAL
            if (cfg.globalUsage && /\bGLOBAL\b/i.test(lineText) && !/\b(DECL|DEF|DEFFCT|STRUC|SIGNAL|ENUM)\b/i.test(lineText) && !/\b(INT|REAL|FRAME|CHAR|BOOL|STRING|E6AXIS|E6POS|AXIS|LOAD)\b/i.test(lineText)) {
                const globalMatch = /\bGLOBAL\b/i.exec(fullText);
                const globalIndex = globalMatch ? globalMatch.index : 0;
                const range = new vscode.Range(i, globalIndex, i, globalIndex + 'GLOBAL'.length);
                diagnostics.push(new vscode.Diagnostic(range, `'GLOBAL' must be used with DECL, STRUC, or SIGNAL on the same line, except if it's used with a predefined types.`, vscode.DiagnosticSeverity.Warning));
            }
        }
        catch (error) {
            console.error(`Error processing line ${i + 1}:`, error);
        }
    }
    diagnosticCollection.set(document.uri, diagnostics);
}
function isVariableDeclarationLine(lineText) {
    return /^\s*(?:(?:GLOBAL\s+)?DECL|DECL\s+GLOBAL|(?:GLOBAL\s+)?SIGNAL|(?:GLOBAL\s+)?STRUC|GLOBAL\s+(?:CONST\s+)?(?:INT|REAL|BOOL|CHAR|STRING|FRAME|E6POS|E6AXIS|AXIS|LOAD|LOAD_DATA)\b)/i.test(lineText);
}
function getDeclaredNames(fullLine) {
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
        const names = [{
                name: structMatch[1],
                start: offset + structMatch.index + structMatch[0].indexOf(structMatch[1])
            }];
        const memberPart = structMatch[2];
        const memberOffset = offset + structMatch[0].length - memberPart.length;
        names.push(...getStructMemberNames(memberPart, memberOffset));
        return names;
    }
    const declMatch = /^(?:(?:GLOBAL\s+)?DECL\s+(?:GLOBAL\s+)?|GLOBAL\s+)(?:CONST\s+)?([A-Za-z][A-Za-z0-9_]*)\s+(.+)$/i.exec(trimmed);
    if (!declMatch)
        return [];
    const varPart = declMatch[2];
    const varOffset = offset + declMatch[0].length - varPart.length;
    return getVariableListNames(varPart, varOffset);
}
function getVariableListNames(varPart, offset) {
    const names = [];
    const tokens = splitRespectingBrackets(varPart);
    let searchStart = 0;
    for (const token of tokens) {
        const tokenIndex = varPart.indexOf(token, searchStart);
        searchStart = tokenIndex + token.length;
        const candidate = /^[\s]*([^\s=\[]+)/.exec(token);
        if (!candidate)
            continue;
        names.push({
            name: candidate[1],
            start: offset + tokenIndex + candidate[0].indexOf(candidate[1])
        });
    }
    return names;
}
function getStructMemberNames(memberPart, offset) {
    var _a, _b;
    const names = [];
    const typeRegex = /\b(INT|REAL|BOOL|CHAR|STRING|FRAME|E6POS|E6AXIS|AXIS|LOAD|LOAD_DATA)\b/gi;
    const typeMatches = Array.from(memberPart.matchAll(typeRegex));
    for (let i = 0; i < typeMatches.length; i++) {
        const match = typeMatches[i];
        const nextMatch = typeMatches[i + 1];
        const typeStart = (_a = match.index) !== null && _a !== void 0 ? _a : 0;
        const nextTypeStart = nextMatch ? (_b = nextMatch.index) !== null && _b !== void 0 ? _b : memberPart.length : memberPart.length;
        const varStart = typeStart + match[0].length;
        const varEnd = nextTypeStart;
        const varPart = memberPart.slice(varStart, varEnd).replace(/,\s*$/, '');
        names.push(...getVariableListNames(varPart, offset + varStart));
    }
    return names;
}
function getInvalidVariableNameReason(name) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
        return 'Invalid KRL variable name. Use letters, digits, and underscores, and start with a letter.';
    }
    return undefined;
}
function isSystemVariableName(name) {
    return /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}
function splitRespectingBrackets(input) {
    const result = [];
    let current = '';
    let bracketDepth = 0;
    for (let i = 0; i < input.length; i++) {
        const char = input[i];
        if (char === '[')
            bracketDepth++;
        if (char === ']')
            bracketDepth = Math.max(0, bracketDepth - 1);
        if (char === ',' && bracketDepth === 0) {
            result.push(current.trim());
            current = '';
        }
        else {
            current += char;
        }
    }
    if (current.trim())
        result.push(current.trim());
    return result;
}
/**
 * Validate all KRL files in the workspace with extensions .src, .dat, .sub
 */
function validateAllKrlFiles() {
    return __awaiter(this, void 0, void 0, function* () {
        const patterns = ['**/*.src', '**/*.dat', '**/*.sub'];
        const uris = [];
        // Collect all matching files
        for (const pattern of patterns) {
            const matched = yield vscode.workspace.findFiles(pattern);
            uris.push(...matched);
        }
        // Validate each file (opening it if needed)
        for (const file of uris) {
            try {
                let document = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === file.fsPath);
                if (!document) {
                    document = yield vscode.workspace.openTextDocument(file);
                }
                if (document.languageId === 'krl') {
                    validateTextDocument(document);
                }
            }
            catch (error) {
                console.error(`Failed to validate ${file.fsPath}`, error);
            }
        }
    });
}
/**
 * Append a timestamped message to the log file.
 */
const logFile = path.join(__dirname, 'krl-extension.log');
function logToFile(message) {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
}
/**
 * Extension deactivation handler
 */
function deactivate() {
    diagnosticCollection.clear();
    diagnosticCollection.dispose();
    if (!client)
        return undefined;
    return client.stop();
}
exports.deactivate = deactivate;
