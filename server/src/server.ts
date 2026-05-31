import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  TextDocumentSyncKind,
  InitializeParams,
  InitializeResult,
  Location,
  Position,
  DefinitionParams,
  Connection,
  Diagnostic,
  DiagnosticSeverity,
  CompletionItemKind,
  CompletionParams,
  CompletionItem,
  InsertTextFormat,
  TextEdit,
  DocumentSymbol,
  DocumentSymbolParams,
  SymbolKind,
  Range,
  ReferenceParams,
  FoldingRange,
  FoldingRangeParams,
  FoldingRangeKind,
} from 'vscode-languageserver/node';

import {
  TextDocument
} from 'vscode-languageserver-textdocument';

import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { log } from 'console';

// Create LSP connection and document manager
const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// Global state variables
let workspaceRoot: string | null = null;
let workspaceRoots: string[] = [];
const fileVariablesMap: Map<string, VariableInfo[]> = new Map();
const logFile = path.join(__dirname, 'krl-server.log');
let logMsg="";

// Types
interface VariableInfo {
  name: string;
  type: string;
}

interface StructMap {
  [structName: string]: string[];
}

interface VariableToStructMap {
  [varName: string]: string;
}

interface FunctionDeclaration {
  uri: string;
  line: number;
  startChar: number;
  endChar: number;
  params: string;
  name: string;
}


interface WordInfo {
  word: string;
  isSubvariable: boolean;
}

interface EnclosuresLines {
  upperLine: number;
  bottomLine: number;
}

// Variables and struct maps (updated dynamically)
let variableStructTypes: VariableToStructMap = {};
let structDefinitions: StructMap = {};
let functionsDeclared: FunctionDeclaration[] = [];
let functionsDeclaredByRoot: Map<string, FunctionDeclaration[]> = new Map();
let mergedVariables :VariableInfo[] = [];
let workspaceDeclaredNameCacheByRoot: Map<string, Set<string>> = new Map();

// Server-side validation toggles, pushed by the client via 'custom/setValidationConfig'.
// Defaults match package.json: all checks on.
const serverValidationConfig = {
  defdatPublicGlobalRequired: true,
  defdatNonPublicGlobalForbidden: true,
  undeclaredIdentifiers: true,
};

// KUKA $-system variables, loaded once from server/data/system_vars.json.
interface SystemVariable {
  var_name: string;
  var_descr: string;
  var_type: string;
}
let systemVariables: SystemVariable[] = [];
// Keyed by uppercased base name (leading '$', trailing array brackets stripped) for case-insensitive lookup.
const systemVariableMap: Map<string, SystemVariable> = new Map();

function systemVariableKey(name: string): string {
  return name.replace(/\[.*$/, '').trim().toUpperCase();
}

function loadSystemVariables(): void {
  const dataPath = path.join(__dirname, '..', 'data', 'system_vars.json');
  try {
    systemVariables = JSON.parse(fs.readFileSync(dataPath, 'utf8')) as SystemVariable[];
  } catch (err) {
    systemVariables = [];
    logToFile(`Failed to load system variables from ${dataPath}: ${err}`);
    return;
  }

  systemVariableMap.clear();
  for (const sv of systemVariables) {
    systemVariableMap.set(systemVariableKey(sv.var_name), sv);
  }
}

connection.onNotification(
  'custom/setValidationConfig',
  (cfg: { defdatPublicGlobalRequired?: boolean; defdatNonPublicGlobalForbidden?: boolean; undeclaredIdentifiers?: boolean }) => {
    if (typeof cfg.defdatPublicGlobalRequired === 'boolean') {
      serverValidationConfig.defdatPublicGlobalRequired = cfg.defdatPublicGlobalRequired;
    }
    if (typeof cfg.defdatNonPublicGlobalForbidden === 'boolean') {
      serverValidationConfig.defdatNonPublicGlobalForbidden = cfg.defdatNonPublicGlobalForbidden;
    }
    if (typeof cfg.undeclaredIdentifiers === 'boolean') {
      serverValidationConfig.undeclaredIdentifiers = cfg.undeclaredIdentifiers;
    }
    // Re-validate all open files so stale diagnostics clear or fresh ones appear immediately.
    documents.all().forEach(doc => {
      if (isKrlDocument(doc)) validateDocument(doc, connection);
    });
  }
);

const CODE_KEYWORDS = [
    'GLOBAL', 'DEF', 'DEFFCT', 'END', 'ENDFCT', 'RETURN', 'TRIGGER', 
    'REAL', 'BOOL', 'DECL', 'IF', 'ELSE', 'ENDIF', 'CONTINUE', 'FOR', 'ENDFOR', 'WHILE', 
    'ENDWHILE', 'REPEAT', 'UNTIL', 'AND', 'OR', 'NOT', 'TRUE', 'FALSE', 'INT', 'STRING', 'PULSE', 'WAIT', 'SEC', 'NULLFRAME', 'THEN',
    'CASE', 'DEFAULT', 'SWITCH', 'ENDSWITCH', 'BREAK', 'ABS', 'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN2', 'MAX', 'MIN',
    'DEFDAT', 'ENDDAT', 'PUBLIC', 'STRUC', 'WHEN', 'DISTANCE', 'DO', 'DELAY', 'PRIO', 'LIN', 'PTP', 'DELAY',
    'C_PTP', 'C_LIN', 'C_VEL', 'C_DIS', 'BAS', 'LOAD', 'FRAME', 'IN', 'OUT',
    'X', 'Y', 'Z', 'A', 'B', 'C', 'S', 'T', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6',
    'SQRT', 'TO', 'Axis', 'E6AXIS', 'E6POS', 'LOAD_DATA', 'BASE', 'TOOL',
    'INVERSE', 'FORWARD', 'B_AND', 'B_OR', 'B_NOT', 'B_XOR', 'B_NAND', 'B_NOR', 'B_XNOR',
    'GOTO', 'HALT', 'INTERRUPT', 'ON', 'OFF', 'RESUME', 'BRAKE', 'ON_ERROR_PROCEED', 'ERR_CLEAR',
    'CIRC', 'SPLINE', 'ENDSPLINE', 'LIN_REL', 'PTP_REL', 'SLIN', 'SPTP', 'SCIRC', 'SPL', 'ENDSPL', 'WAITFOR', 'STRLEN',
    'CWRITE', 'SWRITE', 'STRCOMP', 'IS_KEY_PRESSED', 'CLEAR_KRLMSG', 'SET_KRLMSG', 'ERR_RAISE', 'EXOR', 'EXIT', 'CHANNEL', 'EXT',
    'STRADD', 'STRCLEAR', 'EXISTS_KRLMSG', 'EXISTS_KRLDLG', 'SET_KRLDLG',
    'LK', 'EK', 'EB', 'EO', 'EB_ABS', 'INV_POS',
    'VARSTATE', 'WITH', 'MBX_REC', 'SYNC', 'EB_TEST', 'TEST_BRAKE',
    'INTTOSTRWITHPREFIX', 'GET_COLLMON_SET',
];
 

// =======================
// Initialization Handlers
// =======================

connection.onInitialize((params: InitializeParams): InitializeResult => {
  workspaceRoots = params.workspaceFolders?.map(folder => URI.parse(folder.uri).fsPath) ?? [];
  if (workspaceRoots.length === 0 && params.rootUri) {
    workspaceRoots = [URI.parse(params.rootUri).fsPath];
  }
  workspaceRoot = workspaceRoots[0] ?? null;

  // Debug: Delete old log file if exists
  if (fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  loadSystemVariables();

  // Return server capabilities
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      definitionProvider: true,
      hoverProvider: true,
      documentSymbolProvider: true,
      referencesProvider: true,
      foldingRangeProvider: true,
      completionProvider: {
        triggerCharacters: [
          '.', '(', ',', ' ', '=', '+', '-', '*', '/', '<', '>', '!', '$',
          ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'
        ]
      }
    }
  };
});


  

connection.onInitialized(async () => {
  if (workspaceRoots.length === 0) return;

  for (const root of workspaceRoots) {
    const files = getAllDatFiles(root);

    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8');
      const uri = URI.file(filePath).toString();

      const collector = new DeclaredVariableCollector();
      collector.extractFromText(content);
      fileVariablesMap.set(uri, collector.getVariables());
    }

    functionsDeclaredByRoot.set(root, getAllFunctionDeclarations(root));
  }

  functionsDeclared = Array.from(functionsDeclaredByRoot.values()).flat();
  mergedVariables = mergeAllVariables(fileVariablesMap);
});

// ==========================
// Document Change Event Hook
// ==========================

documents.onDidChangeContent(async change => {
  const { document } = change;
  invalidateWorkspaceCachesForDocument(document.uri);

  extractStrucVariables(document.getText());

  const collector = new DeclaredVariableCollector();
  collector.extractFromText(document.getText());
  fileVariablesMap.set(document.uri, collector.getVariables());

  mergedVariables = mergeAllVariables(fileVariablesMap);
  if (isKrlDocument(document)) {
    validateDocument(document, connection);
  }
  //logToFile(`Extracted variables: ${JSON.stringify(mergedVariables, null, 2)}`);
});

documents.onDidOpen(change => {
  const { document } = change;
  invalidateWorkspaceCachesForDocument(document.uri);

  const collector = new DeclaredVariableCollector();
  collector.extractFromText(document.getText());
  fileVariablesMap.set(document.uri, collector.getVariables());
  mergedVariables = mergeAllVariables(fileVariablesMap);

  if (isKrlDocument(document)) {
    validateDocument(document, connection);
  }
});

// ===================
// File and Variables Utilities
// ===================


function normalizeFunctionName(name: string): string {
  return name.replace(/\s+/g, '').toLowerCase();
}

function indexOfIdentifierIgnoreCase(text: string, identifier: string): number {
  return text.toLowerCase().indexOf(identifier.toLowerCase());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getWorkspaceRootForUri(uri: string): string | null {
  let fsPath: string;
  try {
    fsPath = URI.parse(uri).fsPath;
  } catch {
    fsPath = uri;
  }

  const roots = workspaceRoots.length > 0 ? workspaceRoots : (workspaceRoot ? [workspaceRoot] : []);
  const matchingRoots = roots.filter(root => isPathInsideOrEqual(fsPath, root));
  matchingRoots.sort((a, b) => b.length - a.length);
  return matchingRoots[0] ?? workspaceRoot;
}

function isPathInsideOrEqual(filePath: string, rootPath: string): boolean {
  const resolvedFile = path.resolve(filePath).toLowerCase();
  const resolvedRoot = path.resolve(rootPath).toLowerCase();
  const relative = path.relative(resolvedRoot, resolvedFile);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function invalidateWorkspaceCachesForDocument(uri: string): void {
  const root = getWorkspaceRootForUri(uri);
  if (!root) {
    workspaceDeclaredNameCacheByRoot.clear();
    functionsDeclaredByRoot.clear();
    functionsDeclared = [];
    return;
  }

  workspaceDeclaredNameCacheByRoot.delete(root);
  functionsDeclaredByRoot.set(root, getAllFunctionDeclarations(root));
  functionsDeclared = Array.from(functionsDeclaredByRoot.values()).flat();
}

function getMergedVariablesForRoot(root: string): VariableInfo[] {
  const scopedMap = new Map<string, VariableInfo[]>();
  for (const [uri, variables] of fileVariablesMap.entries()) {
    if (getWorkspaceRootForUri(uri) === root) {
      scopedMap.set(uri, variables);
    }
  }
  return mergeAllVariables(scopedMap);
}

function getFunctionsForRoot(root: string): FunctionDeclaration[] {
  let declarations = functionsDeclaredByRoot.get(root);
  if (!declarations) {
    declarations = getAllFunctionDeclarations(root);
    functionsDeclaredByRoot.set(root, declarations);
    functionsDeclared = Array.from(functionsDeclaredByRoot.values()).flat();
  }
  return declarations;
}

/**
 * Recursively find all .dat files in the workspace directory.
 */
function getAllDatFiles(dir: string): string[] {
  const result: string[] = [];

  function recurse(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        recurse(fullPath);
      } else if (entry.isFile() && fullPath.endsWith('.dat')) {
        result.push(fullPath);
      }
    }
  }

  recurse(dir);
  return result;
}

function getAllKrlFiles(dir: string): string[] {
  const result: string[] = [];

  function recurse(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        recurse(fullPath);
      } else if (entry.isFile() && /\.(src|dat|sub)$/i.test(fullPath)) {
        result.push(fullPath);
      }
    }
  }

  recurse(dir);
  return result;
}

/**
 * Merge all variables from multiple files into a single map.
 */
function mergeAllVariables(map: Map<string, VariableInfo[]>): VariableInfo[] {
  const result: VariableInfo[] = [];
  const seen = new Set<string>();

  for (const vars of map.values()) {
    for (const v of vars) {
      if (!seen.has(v.name)) {
        seen.add(v.name);
        result.push({ name: v.name, type: v.type || '' });
      }
    }
  }

  return result;
}
/**
 * Append a timestamped message to the log file.
 */
function logToFile(message: string) {
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
}

// =====================
// Definition Request Handler
// =====================

connection.onDefinition(
  async (params: DefinitionParams): Promise<Location | undefined> => {
    const doc = documents.get(params.textDocument.uri);
    const documentRoot = doc ? getWorkspaceRootForUri(params.textDocument.uri) : null;
    if (!doc || !documentRoot) return;

    const lines = doc.getText().split(/\r?\n/);
    const lineText = lines[params.position.line];

    // Ignore certain declarations lines
    if (/^\s*(GLOBAL\s+)?(DEF|DEFFCT|DECL INT|DECL REAL|DECL BOOL|DECL FRAME)\b/i.test(lineText)) return;

    //Avoid looking for subvariables inside struc    
    if (getWordAtPosition(lineText, params.position.character)?.isSubvariable) {
      return;
    }

    const functionName = getWordAtPosition(lineText, params.position.character)?.word;
    if (!functionName) return;  
    

    //Search for name as function first
    const resultFct = await isFunctionDeclared(functionName,"function", undefined, undefined, undefined, undefined, documentRoot);
    if (resultFct!=undefined) {
      return Location.create(resultFct.uri, {
        start: Position.create(resultFct.line, resultFct.startChar),
        end: Position.create(resultFct.line, resultFct.endChar)
      });
    }
    
    
    //Search for name as custom user variable type
    for (const key in structDefinitions) {
      if (key.toLowerCase() === functionName.toLowerCase()) {
        const resultStruc = await isFunctionDeclared(functionName,"struc", undefined, undefined, undefined, undefined, documentRoot);
        if (resultStruc!=undefined) {
          return Location.create(resultStruc.uri, {
            start: Position.create(resultStruc.line, resultStruc.startChar),
            end: Position.create(resultStruc.line, resultStruc.endChar)
          });
        }
      }
    }

    //Search for name as variable
    let enclosures = findEnclosuresLines(params.position.line, lines);
    const rootVariables = getMergedVariablesForRoot(documentRoot);
    const functionNameLower = functionName.toLowerCase();
    for (const element of rootVariables) {
      if (element.name.toLowerCase() === functionNameLower) {
        // First: try local scope (inside enclosures)
        const scopedResult = await isFunctionDeclared(
          functionName,
          "variable",
          params.textDocument.uri,
          enclosures.upperLine,
          enclosures.bottomLine,
          lines.join('\n'),
          documentRoot
        );

        if (scopedResult) {
          return Location.create(scopedResult.uri, {
            start: Position.create(scopedResult.line, scopedResult.startChar),
            end: Position.create(scopedResult.line, scopedResult.endChar)
          });
        }

        // If not found locally, try global search
        const resultVar = await isFunctionDeclared(functionName, "variable", undefined, undefined, undefined, undefined, documentRoot);

        if (resultVar) {
          return Location.create(resultVar.uri, {
            start: Position.create(resultVar.line, resultVar.startChar),
            end: Position.create(resultVar.line, resultVar.endChar)
          });
        }
      }
    }


    return;
    
  }
);


// ===================
// Hover Request Handler
// ===================

connection.onHover(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  const documentRoot = doc ? getWorkspaceRootForUri(params.textDocument.uri) : null;
  if (!doc || !documentRoot) return;

  const lines = doc.getText().split(/\r?\n/);
  const lineText = lines[params.position.line];

  // System variable hover ($...): show type and description from the bundled index.
  const systemVar = getSystemVariableAtPosition(lineText, params.position.character);
  if (systemVar) {
    return {
      contents: {
        kind: 'markdown',
        value: `**${systemVar.var_name}** — *${systemVar.var_type}*\n\n${systemVar.var_descr}`
      }
    };
  }

  if (/^\s*(GLOBAL\s+)?(DEF|DEFFCT|DECL|SIGNAL|STRUC)\b/i.test(lineText)) return;

  const functionName = getWordAtPosition(lineText, params.position.character)?.word;
  if (!functionName) return;

  const result = await isFunctionDeclared(functionName,"function", undefined, undefined, undefined, undefined, documentRoot);
  if (!result) return;

  return {
    contents: {
      kind: 'markdown',
      value: `**${functionName}**(${result.params})`
    }
  };
});

// ==================
// Completion Request Handler
// ==================
connection.onCompletion(async (params: CompletionParams): Promise<CompletionItem[]> => {
  
  logMsg=`On completion is called`
  
  logToFile(logMsg)
  const document = documents.get(params.textDocument.uri);
  const documentRoot = document ? getWorkspaceRootForUri(params.textDocument.uri) : null;
  if (!document || !documentRoot) return [];

  const lines = document.getText().split(/\r?\n/);

  // === 1. Struct field completions ===
  const variableStructTypes: Record<string, string> = {};
  for (const line of lines) {
    const declRegex = /^(?:GLOBAL\s+)?(?:DECL\s+)?(?:GLOBAL\s+)?(\w+)\s+(\w+)/i;
    const match = declRegex.exec(line.trim());
    if (match) {
      const type = match[1];
      const varName = match[2];
      variableStructTypes[varName] = type;
    }
  }

  const line = lines[params.position.line];
  const textBefore = line.substring(0, params.position.character);
  
  const dotMatch = textBefore.match(/(\w+)\.$/);

  const structItems: CompletionItem[] = [];
  if (dotMatch) {
    const varName = dotMatch[1];
    const structName = variableStructTypes[varName];
    const members = structDefinitions[structName];
    if (members) {
      structItems.push(
        ...members.map(member => ({
          label: member,
          kind: CompletionItemKind.Field
        }))
      );
    }

    // Only return struct completions after dot
    return structItems;
  }

  // === 1b. System variable completions (after '$') ===
  const dollarMatch = textBefore.match(/\$\w*$/);
  if (dollarMatch) {
    const startChar = params.position.character - dollarMatch[0].length;
    const replaceRange = Range.create(
      params.position.line, startChar,
      params.position.line, params.position.character
    );
    return systemVariables.map(sv => ({
      label: sv.var_name,
      kind: CompletionItemKind.Variable,
      detail: sv.var_type,
      documentation: sv.var_descr,
      textEdit: TextEdit.replace(replaceRange, sv.var_name),
      filterText: sv.var_name,
      sortText: sv.var_name
    }));
  }

  // === 2. Function completions ===
  const functionItems: CompletionItem[] = getFunctionsForRoot(documentRoot).map(fn => {
    const paramList = fn.params.split(',').map(p => p.trim()).filter(Boolean);
    const snippetParams = paramList.map((p, i) => `\${${i + 1}:${p}}`).join(', ');

    return {
      label: fn.name,
      kind: CompletionItemKind.Function,
      detail: `${fn.name}(${fn.params})`,
      insertText: `${fn.name}(${snippetParams})`,
      insertTextFormat: InsertTextFormat.Snippet,
      documentation: `User-defined function: ${fn.name}`,
      commitCharacters: ['('],
      filterText: fn.name,
      sortText: fn.name
    };
  });

const currentWord = textBefore.trim().split(/\s+/).pop()?.toUpperCase() || '';


 const filtered = CODE_KEYWORDS
    .filter(kw => kw.includes(currentWord))
    .sort((a, b) => {
      const aStarts = a.startsWith(currentWord);
      const bStarts = b.startsWith(currentWord);
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;
      return a.localeCompare(b);
    });

  // Return as CompletionItems
  const keywordsFiltered= filtered.map(kw => ({
   label: kw,
    kind: CompletionItemKind.Keyword,
    data: kw,
    sortText: kw,
    filterText: kw
  }));
  
  const uniqueKeywordItems = keywordsFiltered.filter(kwItem =>
  !functionItems.some(fnItem => fnItem.label === kwItem.label)
);


  // === 3. Return all completions (if not after a dot) ===
  const allItems = [...functionItems, ...structItems, ...uniqueKeywordItems];


  logMsg=`Variable filtrées: ${JSON.stringify(allItems, null, 2)}`
  
  logToFile(logMsg)

  return allItems;
});


// ==================
// Document Symbol Request Handler (Outline / Strg+Shift+O / Breadcrumbs)
// ==================
connection.onDocumentSymbol((params: DocumentSymbolParams): DocumentSymbol[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const lines = doc.getText().split(/\r?\n/);
  const symbols: DocumentSymbol[] = [];

  const defRegex   = /^\s*(?:GLOBAL\s+)?(DEF|DEFFCT)\s+(?:(\w+)\s+)?(\w+)\s*\(([^)]*)\)/i;
  const defdatRegex = /^\s*(?:GLOBAL\s+)?DEFDAT\s+(\w+)(?:\s+(PUBLIC))?/i;
  const endRegex   = /^\s*(END|ENDFCT|ENDDAT)\b/i;

  type Open = {
    kind: SymbolKind;
    name: string;
    detail: string;
    startLine: number;
    nameStart: number;
    nameEnd: number;
    expectedEnd: 'END' | 'ENDFCT' | 'ENDDAT';
  };
  let open: Open | null = null;

  const emit = (o: Open, endLine: number, endChar: number) => {
    symbols.push({
      name: o.name,
      detail: o.detail,
      kind: o.kind,
      range: Range.create(o.startLine, 0, endLine, endChar),
      selectionRange: Range.create(o.startLine, o.nameStart, o.startLine, o.nameEnd),
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Strip line-comments (KRL: ';') for keyword detection
    const code = line.split(';')[0];

    if (open) {
      const endMatch = endRegex.exec(code);
      if (endMatch && endMatch[1].toUpperCase() === open.expectedEnd) {
        emit(open, i, line.length);
        open = null;
      }
      continue;
    }

    let m = defRegex.exec(code);
    if (m) {
      const keyword = m[1].toUpperCase();
      const returnType = m[2] || '';
      const name = m[3];
      const params = m[4].trim();
      const nameStart = line.indexOf(name);
      open = {
        kind: SymbolKind.Function,
        name,
        detail: keyword === 'DEFFCT' ? `${returnType} (${params})` : `(${params})`,
        startLine: i,
        nameStart,
        nameEnd: nameStart + name.length,
        expectedEnd: keyword === 'DEFFCT' ? 'ENDFCT' : 'END',
      };
      continue;
    }

    m = defdatRegex.exec(code);
    if (m) {
      const name = m[1];
      const isPublic = !!m[2];
      const nameStart = line.indexOf(name);
      open = {
        kind: SymbolKind.Module,
        name,
        detail: isPublic ? 'PUBLIC' : '',
        startLine: i,
        nameStart,
        nameEnd: nameStart + name.length,
        expectedEnd: 'ENDDAT',
      };
    }
  }

  // Unclosed block: span to end of file so the symbol still appears in the outline.
  if (open) {
    const lastLine = Math.max(0, lines.length - 1);
    emit(open, lastLine, lines[lastLine]?.length ?? 0);
  }

  return symbols;
});


// ==================
// References Request Handler (Shift+F12 / Right-click → Find All References)
// ==================
connection.onReferences(async (params: ReferenceParams): Promise<Location[]> => {
  const doc = documents.get(params.textDocument.uri);
  const documentRoot = doc ? getWorkspaceRootForUri(params.textDocument.uri) : null;
  if (!doc || !documentRoot) return [];

  const lines = doc.getText().split(/\r?\n/);
  const lineText = lines[params.position.line];
  const wordInfo = getWordAtPosition(lineText, params.position.character);
  if (!wordInfo) return [];

  const name = wordInfo.word;
  // Skip pure numeric tokens — \w+ matches them but they're never identifiers
  if (/^\d/.test(name)) return [];

  // KRL is case-insensitive; word boundary keeps "Foo" out of "FooBar"
  const wordRegex = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'gi');
  const declLineRegex = /^\s*(GLOBAL\s+)?(DEF|DEFFCT|DEFDAT|STRUC|ENUM|DECL|SIGNAL)\b/i;
  const includeDeclaration = params.context.includeDeclaration;

  const files = await findSrcFiles(documentRoot);
  const results: Location[] = [];

  for (const filePath of files) {
    const uri = URI.file(filePath).toString();
    // Prefer in-memory content so unsaved edits are reflected
    const openDoc = documents.get(uri);
    const content = openDoc ? openDoc.getText() : fs.readFileSync(filePath, 'utf8');
    const fileLines = content.split(/\r?\n/);

    for (let i = 0; i < fileLines.length; i++) {
      const rawLine = fileLines[i];
      // Strip line comments before matching
      const code = rawLine.split(';')[0];
      const isDeclLine = declLineRegex.test(code);
      if (isDeclLine && !includeDeclaration) continue;

      wordRegex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = wordRegex.exec(code)) !== null) {
        const start = m.index;
        const prev = start > 0 ? code[start - 1] : '';
        // Skip subvariable accesses (a.foo) and system vars ($foo, #foo)
        if (prev === '.' || prev === '$' || prev === '#') continue;

        results.push(Location.create(uri, {
          start: Position.create(i, start),
          end: Position.create(i, start + name.length),
        }));
      }
    }
  }

  return results;
});


// ==================
// Folding Ranges Request Handler
// ==================
connection.onFoldingRanges((params: FoldingRangeParams): FoldingRange[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const lines = doc.getText().split(/\r?\n/);
  const ranges: FoldingRange[] = [];

  // open keyword -> matching close keyword
  const blockOpens: Record<string, string> = {
    DEF: 'END',
    DEFFCT: 'ENDFCT',
    DEFDAT: 'ENDDAT',
    IF: 'ENDIF',
    LOOP: 'ENDLOOP',
    FOR: 'ENDFOR',
    WHILE: 'ENDWHILE',
    SWITCH: 'ENDSWITCH',
    STRUC: 'ENDSTRUC',
    REPEAT: 'UNTIL',
  };

  // Opens must sit at line start (allow leading GLOBAL for DEF*/STRUC).
  const openRegex = /^\s*(?:GLOBAL\s+)?(DEF|DEFFCT|DEFDAT|IF|LOOP|FOR|WHILE|SWITCH|STRUC|REPEAT)\b/i;
  // Word boundaries keep END out of ENDIF etc. Longer alternatives listed first defensively.
  const closeRegex = /\b(ENDFCT|ENDDAT|ENDIF|ENDLOOP|ENDFOR|ENDWHILE|ENDSWITCH|ENDSTRUC|UNTIL|END)\b/i;

  type Frame = { startLine: number; expectedEnd: string };
  const blockStack: Frame[] = [];
  const foldStack: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // ;FOLD / ;ENDFOLD — KUKA editor folds. Detect before comment-stripping.
    if (/^\s*;\s*FOLD\b/i.test(raw)) {
      foldStack.push(i);
      continue;
    }
    if (/^\s*;\s*ENDFOLD\b/i.test(raw)) {
      const start = foldStack.pop();
      if (start !== undefined && i > start) {
        ranges.push({ startLine: start, endLine: i, kind: FoldingRangeKind.Region });
      }
      continue;
    }

    const code = raw.split(';')[0];

    const openMatch = openRegex.exec(code);
    const openKw = openMatch ? openMatch[1].toUpperCase() : null;
    const closeMatch = closeRegex.exec(code);
    const closeKw = closeMatch ? closeMatch[1].toUpperCase() : null;

    // Same-line open + matching close (one-liner IF/STRUC) — nothing to fold.
    if (openKw && closeKw && blockOpens[openKw] === closeKw) continue;

    if (openKw) {
      blockStack.push({ startLine: i, expectedEnd: blockOpens[openKw] });
    } else if (closeKw) {
      const top = blockStack[blockStack.length - 1];
      if (top && top.expectedEnd === closeKw) {
        blockStack.pop();
        if (i > top.startLine) {
          ranges.push({ startLine: top.startLine, endLine: i });
        }
      }
    }
  }

  return ranges;
});


function getAllFunctionDeclarations(rootDir?: string): FunctionDeclaration[] {
  const searchRoot = rootDir ?? workspaceRoot;
  if (!searchRoot) return [];

  const files = getAllKrlFiles(searchRoot);
  const defRegex = /\b(GLOBAL\s+)?(DEF|DEFFCT)\s+(?:\w+\s+)?(\w+)\s*\(([^)]*)\)/i;

  const allDeclarations: FunctionDeclaration[] = [];

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    const fileLines = content.split(/\r?\n/);

    for (let i = 0; i < fileLines.length; i++) {
      const line = fileLines[i];
      const match = defRegex.exec(line);
      if (match) {
        const name = match[3];
        const params = match[4].trim();
        const startChar = indexOfIdentifierIgnoreCase(line, name);
        const uri = URI.file(filePath).toString();

        allDeclarations.push({
          name,
          uri,
          line: i,
          startChar,
          endChar: startChar + name.length,
          params,
        });
      }
    }
  }

  return allDeclarations;
}





// =========================
// Utility Functions
// =========================


/**
 * Find DEF, DEFCT, DETDAT enclosures lines
 */

function findEnclosuresLines(lineNumber: number, lines: string[]): EnclosuresLines {
  let row = lineNumber;
  let result: EnclosuresLines = {
    upperLine: 0,
    bottomLine: lines.length - 1
  };

  // Search upwards
  while (row >= 0) {
    if (lines[row].includes("DEFFCT") || lines[row].includes("DEF") || lines[row].includes("DEFDAT")) {
      result.upperLine = row+1;
      break;
    }
    row--;
  }

  // Reset row to start from original position
  row = lineNumber;

  // Search downwards
  while (row < lines.length) {
    if (lines[row].includes("ENDFCT") || lines[row].includes("END") || lines[row].includes("ENDDAT")) {
      result.bottomLine = row+1;
      break;
    }
    row++;
  }

  return result;
}




/**
 * Extract the word at a given character position in a line.
 */

// Match a $-prefixed system variable token at the cursor, e.g. $POS_ACT, $ACC_AXIS.
function getSystemVariableAtPosition(lineText: string, character: number): SystemVariable | undefined {
  const tokenRegex = /\$\w+/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(lineText)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (character >= start && character <= end) {
      return systemVariableMap.get(systemVariableKey(match[0]));
    }
  }
  return undefined;
}

function getWordAtPosition(lineText: string, character: number): WordInfo | undefined {
  const wordMatch = lineText.match(/\b(\w+)\b/g);
  if (!wordMatch) return;

  let charCount = 0;
  for (const w of wordMatch) {
    const start = lineText.indexOf(w, charCount);
    const end = start + w.length;
    if (character >= start && character <= end) {
      const isSubvariable = start > 0 && lineText[start - 1] === '.';
      return {
        word: w,
        isSubvariable
      };
    }
    charCount = end;
  }
  return;
}

/**
 * Recursively find .src, .dat, and .sub files in workspace.
 */
async function findSrcFiles(dir: string): Promise<string[]> {
  let results: string[] = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      const subDirFiles = await findSrcFiles(filePath);
      results = results.concat(subDirFiles);
    } else if (
      file.toLowerCase().endsWith('.src') ||
      file.toLowerCase().endsWith('.dat') ||
      file.toLowerCase().endsWith('.sub')
    ) {
      results.push(filePath);
    }
  }
  return results;
}

/**
 * Check if a function with given name is declared in any source file.
 */async function isFunctionDeclared(
  name: string,
  mode: string,
  scopedFilePath?: string,
  lineStart?: number,
  lineEnd?: number,
  fileContentOverride?: string,
  rootOverride?: string
): Promise<FunctionDeclaration | undefined> {
  const searchRoot = rootOverride ?? (scopedFilePath ? getWorkspaceRootForUri(scopedFilePath) : workspaceRoot);
  if (!searchRoot) return undefined;

  const escapedName = escapeRegExp(name);
  const normalizedName = normalizeFunctionName(name);
  const defRegex = mode === "struc"
    ? new RegExp(`\\b(?:GLOBAL\\s+)?(?:STRUC)\\s+${escapedName}\\b`, 'i')
    : mode === "variable"
    ? new RegExp(`\\b(?:GLOBAL\\s+)?(?:DECL|SIGNAL)\\b[^\\n]*\\b${escapedName}\\b`, 'i')
    : mode === "function"
    ? /\b(GLOBAL\s+)?(DEF|DEFFCT)\s+(\w+\s+)?(\w+)\s*\(([^)]*)\)/i
    : undefined;

  if (!defRegex) return undefined;

  const files = scopedFilePath ? [scopedFilePath] : await findSrcFiles(searchRoot);

  for (const filePath of files) {
    const content = fileContentOverride ?? fs.readFileSync(filePath, 'utf8');
    const fileLines = content.split(/\r?\n/);
    
    const start = lineStart ?? 0;
    const end = lineEnd ?? fileLines.length;

    for (let i = start; i <= end && i < fileLines.length; i++) {
      const defLine = fileLines[i];
      const match = defLine.match(defRegex);
      if (match) {
        const declaredName = mode === 'function' ? match[4] : name;
        if (mode === 'function' && normalizeFunctionName(declaredName) !== normalizedName) {
          continue;
        }

        const uri = filePath.startsWith("file://") ? filePath : URI.file(filePath).toString();
        // KRL is case-insensitive; find the actual declaration spelling.
        const startChar = indexOfIdentifierIgnoreCase(defLine, declaredName);
        const params = (mode === 'function' && match[5]) ? match[5].trim() : '';

        return {
          uri,
          line: i,
          startChar,
          endChar: startChar + declaredName.length,
          params,
          name: declaredName
        };
      }
    }
  }

  return undefined;
}


// =====================
// Diagnostics & Validation
// =====================

/**
 * Validate all .dat files in currently opened documents.
 */
export function validateAllDatFiles(connection: Connection) {
  documents.all().forEach(document => {
    if (document.uri.endsWith('.dat')) {
      validateDocument(document, connection);
    }
  });
}

function isKrlDocument(document: TextDocument): boolean {
  return /\.(src|dat|sub)$/i.test(document.uri);
}

function validateDocument(document: TextDocument, connection: Connection) {
  const diagnostics: Diagnostic[] = [];

  if (document.uri.toLowerCase().endsWith('.dat')) {
    diagnostics.push(...validateDatFile(document));
  }

  if (serverValidationConfig.undeclaredIdentifiers) {
    diagnostics.push(...validateUndeclaredIdentifiers(document));
  }

  connection.sendDiagnostics({ uri: document.uri, diagnostics });
}

function validateDatFile(document: TextDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = document.getText().split(/\r?\n/);

  let insideDefdat = false;
  let insidePublicDefdat = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Detect start of DEFDAT
    const defdatMatch = line.match(/^DEFDAT\s+(\w+)(?:\s+PUBLIC)?/i);
    if (defdatMatch) {
      insideDefdat = true;
      insidePublicDefdat = /PUBLIC/i.test(line);
      continue;
    }

    // Detect end of DEFDAT
    if (/^ENDDAT/i.test(line)) {
      insideDefdat = false;
      insidePublicDefdat = false;
      continue;
    }

    if (insideDefdat) {
      const declMatch = line.match(/^(DECL|SIGNAL|STRUC)\b/i);
      if (!declMatch) continue;

      if (insidePublicDefdat) {

        if (serverValidationConfig.defdatPublicGlobalRequired && !/^\s*(?:DECL\s+)?GLOBAL\b/i.test(line)) {
          const newDiagnostic: Diagnostic = {
            severity: DiagnosticSeverity.Warning,
            range: {
              start: { line: i, character: 0 },
              end: { line: i, character: line.length }
            },
            message: `Declaration is not GLOBAL but DEFDAT is PUBLIC.`,
            source: 'Kuka-krl-assistant'
          };

          if (!isDuplicateDiagnostic(newDiagnostic, diagnostics)) {
            diagnostics.push(newDiagnostic);
          }
        }

      } else {
        if (serverValidationConfig.defdatNonPublicGlobalForbidden && /^\s*(?:DECL\s+)?GLOBAL\b/i.test(line)) {
          const newDiagnostic: Diagnostic = {
            severity: DiagnosticSeverity.Error,
            range: {
              start: { line: i, character: 0 },
              end: { line: i, character: line.length }
            },
            message: `Declaration  is GLOBAL but DEFDAT is not PUBLIC.`,
            source: 'Kuka-krl-assistant'
          };

          if (!isDuplicateDiagnostic(newDiagnostic, diagnostics)) {
            diagnostics.push(newDiagnostic);
          }
        }
      }
    }
  }
  return diagnostics;
}

function validateUndeclaredIdentifiers(document: TextDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = document.getText().split(/\r?\n/);
  const declaredNames = getDeclaredNamesForDocument(document);
  const documentRoot = getWorkspaceRootForUri(document.uri);
  const knownFunctionNames = getKnownFunctionNames(document.getText(), documentRoot);
  const knownStructNames = new Set(Object.keys(structDefinitions).map(name => name.toLowerCase()));
  const keywordNames = new Set(CODE_KEYWORDS.map(keyword => keyword.toUpperCase()));
  const identifierRegex = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const rawLine = lines[lineIndex];
    const code = stripStrings(stripLineComment(rawLine));

    if (shouldSkipUndeclaredIdentifierLine(code)) continue;

    let match: RegExpExecArray | null;
    while ((match = identifierRegex.exec(code)) !== null) {
      const name = match[0];
      const lowerName = name.toLowerCase();
      const upperName = name.toUpperCase();
      const prev = match.index > 0 ? code[match.index - 1] : '';
      const next = match.index + name.length < code.length ? code[match.index + name.length] : '';

      if (prev === '$' || prev === '#' || prev === '.' || prev === '&') continue;
      if (next === ':') continue;
      if (isStructInitializerField(code, match.index, name.length)) continue;
      if (keywordNames.has(upperName)) continue;
      if (declaredNames.has(lowerName)) continue;
      if (knownFunctionNames.has(normalizeFunctionName(name))) continue;
      if (knownStructNames.has(lowerName)) continue;

      const newDiagnostic: Diagnostic = {
        severity: DiagnosticSeverity.Information,
        message: `Identifier "${name}" is not declared in the current KRL workspace index.`,
        range: {
          start: { line: lineIndex, character: match.index },
          end: { line: lineIndex, character: match.index + name.length }
        },
        source: 'Kuka-krl-assistant'
      };

      if (!isDuplicateDiagnostic(newDiagnostic, diagnostics)) {
        diagnostics.push(newDiagnostic);
      }
    }
  }

  return diagnostics;
}

function getDeclaredNamesForDocument(document: TextDocument): Set<string> {
  const declaredNames = new Set<string>();
  const documentRoot = getWorkspaceRootForUri(document.uri);

  for (const name of getWorkspaceDeclaredNames(documentRoot)) {
    declaredNames.add(name);
  }

  const rootVariables = documentRoot ? getMergedVariablesForRoot(documentRoot) : mergedVariables;
  for (const variable of rootVariables) {
    declaredNames.add(variable.name.toLowerCase());
  }

  const collector = new DeclaredVariableCollector();
  collector.extractFromText(document.getText());
  for (const variable of collector.getVariables()) {
    declaredNames.add(variable.name.toLowerCase());
  }

  for (const paramName of getFunctionParameterNames(document.getText())) {
    declaredNames.add(paramName.toLowerCase());
  }

  return declaredNames;
}

function getWorkspaceDeclaredNames(root: string | null): Set<string> {
  const cacheKey = root ?? '';
  const cached = workspaceDeclaredNameCacheByRoot.get(cacheKey);
  if (cached) {
    return cached;
  }

  const declaredNames = new Set<string>();
  if (!root) {
    workspaceDeclaredNameCacheByRoot.set(cacheKey, declaredNames);
    return declaredNames;
  }

  for (const filePath of getAllKrlFiles(root)) {
    const uri = URI.file(filePath).toString();
    const openDocument = documents.get(uri);
    const content = openDocument ? openDocument.getText() : fs.readFileSync(filePath, 'utf8');

    const collector = new DeclaredVariableCollector();
    collector.extractFromText(content);
    for (const variable of collector.getVariables()) {
      declaredNames.add(variable.name.toLowerCase());
    }
  }

  workspaceDeclaredNameCacheByRoot.set(cacheKey, declaredNames);
  return declaredNames;
}

function getKnownFunctionNames(documentText: string, root: string | null): Set<string> {
  const rootFunctions = root ? getFunctionsForRoot(root) : functionsDeclared;
  const names = new Set(rootFunctions.map(fn => normalizeFunctionName(fn.name)));
  const functionRegex = /\b(?:GLOBAL\s+)?(?:DEF|DEFFCT)\s+(?:\w+\s+)?(\w+)\s*\(/gi;
  let match: RegExpExecArray | null;

  while ((match = functionRegex.exec(documentText)) !== null) {
    names.add(normalizeFunctionName(match[1]));
  }

  return names;
}

function getFunctionParameterNames(documentText: string): string[] {
  const params: string[] = [];
  const functionRegex = /\b(?:GLOBAL\s+)?(?:DEF|DEFFCT)\s+(?:\w+\s+)?\w+\s*\(([^)]*)\)/gi;
  let match: RegExpExecArray | null;

  while ((match = functionRegex.exec(documentText)) !== null) {
    for (const rawParam of splitVarsRespectingBrackets(match[1])) {
      const paramText = rawParam.split(':')[0].trim();
      if (!paramText) continue;

      const identifiers = paramText.match(/[A-Za-z_][A-Za-z0-9_]*/g);
      if (!identifiers || identifiers.length === 0) continue;

      const name = identifiers[identifiers.length - 1];
      if (!CODE_KEYWORDS.includes(name.toUpperCase())) {
        params.push(name);
      }
    }
  }

  return params;
}

function stripLineComment(line: string): string {
  const commentStart = line.indexOf(';');
  return commentStart >= 0 ? line.slice(0, commentStart) : line;
}

function stripStrings(line: string): string {
  return line
    .replace(/"[^"]*"/g, match => ' '.repeat(match.length))
    .replace(/'[^']*'/g, match => ' '.repeat(match.length));
}

function shouldSkipUndeclaredIdentifierLine(code: string): boolean {
  return /^\s*&/.test(code) ||
    /^\s*(?:GLOBAL\s+)?(?:DEF|DEFFCT|DEFDAT|END|ENDFCT|ENDDAT|DECL|SIGNAL|STRUC|ENUM)\b/i.test(code) ||
    /^\s*(?:GLOBAL\s+)?(?:CONST\s+)?[A-Za-z_][A-Za-z0-9_]*\s+[A-Za-z_$][A-Za-z0-9_$]*(?:\s*(?:\[|=|,|;|$))/i.test(code) ||
    /^\s*(?:GOTO|HALT|INTERRUPT|ON_ERROR_PROCEED|RESUME|BRAKE|CHANNEL|EXT)\b/i.test(code);
}

function isStructInitializerField(code: string, start: number, length: number): boolean {
  const before = code.slice(0, start);
  const openBraces = (before.match(/{/g) || []).length;
  const closeBraces = (before.match(/}/g) || []).length;
  if (openBraces <= closeBraces) return false;

  const beforeNonSpace = before.trimEnd().slice(-1);
  if (beforeNonSpace !== '{' && beforeNonSpace !== ',') return false;

  const after = code.slice(start + length);
  return /^\s*(?:\[[^\]]*\])?\s*(?:(?:,|})|[-+]?\d|{|#|"|TRUE\b|FALSE\b|[A-Za-z_][A-Za-z0-9_]*\s*(?:,|}))/i.test(after);
}



/**
 * Check if a diagnostic is duplicate in the list.
 */
function isDuplicateDiagnostic(newDiag: Diagnostic, existingDiagnostics: Diagnostic[]): boolean {
  return existingDiagnostics.some(diag =>
    diag.range.start.line === newDiag.range.start.line &&
    diag.range.start.character === newDiag.range.start.character &&
    diag.range.end.line === newDiag.range.end.line &&
    diag.range.end.character === newDiag.range.end.character &&
    diag.message === newDiag.message &&
    diag.severity === newDiag.severity
  );
}

// =====================
// Struct and Variable Extraction
// =====================

/**
 * Extract struct and enum variable members from .dat file content.
 * Updates global structDefinitions map.
 */
function extractStrucVariables(datContent: string): void {
  const structRegex = /^[ \t]*(?:GLOBAL\s+)?(?:DECL\s+)?(?:GLOBAL\s+)?(STRUC|ENUM)\s+(\w+)\s+(.+)$/gm;

  const knownTypes = ['INT', 'REAL', 'BOOL', 'CHAR', 'STRING', 'FRAME', 'ENUM'];
  const tempStructDefinitions: Record<string, string[]> = {};

  let match;
  while ((match = structRegex.exec(datContent)) !== null) {
    const structName = match[2];
    let membersRaw = match[3];

    // Remove inline comments (anything after a semicolon)
    membersRaw = membersRaw.split(';')[0].trim();

    const tokens = membersRaw.split(/[,\s]+/).map(v => v.trim()).filter(Boolean);
    const members = tokens.filter(token =>
      !knownTypes.includes(token.toUpperCase()) &&
      !['ENUM', 'STRUC'].includes(token.toUpperCase())
    );

    tempStructDefinitions[structName] = members;
  }

  // Filter members to exclude other struct names and known types
  for (const [structName, members] of Object.entries(tempStructDefinitions)) {
    const filtered = members.filter(
      member =>
        !knownTypes.includes(member.toUpperCase()) &&
        !Object.keys(tempStructDefinitions).includes(member)
    );
    structDefinitions[structName] = filtered;
  }
}

// ========================
// Class: DeclaredVariableCollector
// ========================

/**
 * Helper class to extract declared variables from document text.
 */
class DeclaredVariableCollector {
  private variables: Map<string, string> = new Map(); // name -> type

  /**
   * Extract declared variables from the provided text.
   * Removes STRUC blocks before processing.
   */
  extractFromText(documentText: string): void {
    // Remove STRUC blocks (non-greedy match)
    const textWithoutStrucs = documentText.replace(/STRUC\s+\w+[^]*?ENDSTRUC/gi, '');

    // Match DECL statements with optional GLOBAL before or after
    const declRegex = /^\s*(GLOBAL\s+)?DECL\s+(GLOBAL\s+)?(?:CONST\s+)?(\w+)\s+([^\r\n;]+)/gim;

    let match: RegExpExecArray | null;
    while ((match = declRegex.exec(textWithoutStrucs)) !== null) {
      const type = match[3];
      const varList = match[4];

      const varNames = splitVarsRespectingBrackets(varList)
        .map(name => name.trim())
        .map(name => name.replace(/\[.*?\]/g, '').trim())  // Remove array brackets
        .map(name => name.replace(/\s*=\s*.+$/, ''))       // Remove initializations
        .filter(name => /^[a-zA-Z_]\w*$/.test(name));

      for (const name of varNames) {
        if (!this.variables.has(name)) {
          this.variables.set(name, type);        
        }
      }
    }

    const globalTypeRegex = /^\s*GLOBAL\s+(?:CONST\s+)?(\w+)\s+([^\r\n;]+)/gim;
    while ((match = globalTypeRegex.exec(textWithoutStrucs)) !== null) {
      const type = match[1];
      if (!CODE_KEYWORDS.includes(type.toUpperCase())) continue;

      const varNames = splitVarsRespectingBrackets(match[2])
        .map(name => name.trim())
        .map(name => name.replace(/\[.*?\]/g, '').trim())
        .map(name => name.replace(/\s*=\s*.+$/, ''))
        .filter(name => /^[a-zA-Z_]\w*$/.test(name));

      for (const name of varNames) {
        if (!this.variables.has(name)) {
          this.variables.set(name, type);
        }
      }
    }

    const signalRegex = /^\s*(GLOBAL\s+)?SIGNAL\s+([a-zA-Z_]\w*)\b/gim;
    while ((match = signalRegex.exec(textWithoutStrucs)) !== null) {
      const name = match[2];
      if (!this.variables.has(name)) {
        this.variables.set(name, 'SIGNAL');
      }
    }

    const typedDataRegex = /^\s*(?:GLOBAL\s+)?(?:CONST\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+([^\r\n;]+)/gim;
    while ((match = typedDataRegex.exec(textWithoutStrucs)) !== null) {
      const type = match[1];
      const upperType = type.toUpperCase();
      if (['DEF', 'DEFFCT', 'DEFDAT', 'END', 'ENDFCT', 'ENDDAT', 'IF', 'FOR', 'WHILE', 'SWITCH', 'ENUM', 'STRUC', 'SIGNAL', 'INTERRUPT'].includes(upperType)) {
        continue;
      }

      const varNames = splitVarsRespectingBrackets(match[2])
        .map(name => name.trim())
        .map(name => name.replace(/\[.*?\]/g, '').trim())
        .map(name => name.replace(/\s*=\s*.+$/, ''))
        .filter(name => /^[a-zA-Z_$][\w$]*$/.test(name));

      for (const name of varNames) {
        if (!this.variables.has(name)) {
          this.variables.set(name, type);
        }
      }
    }
  }

  /**
   * Returns all collected variables as an array.
   */
  getVariables(): VariableInfo[] {
    return Array.from(this.variables.entries()).map(([name, type]) => ({ name, type }));
  }

  /**
   * Clears collected variables.
   */
  clear(): void {
    this.variables.clear();
  }
}

/**
 * Utility function to split variable declarations respecting brackets.
 * Example: "var1, arr[2,3], var2" splits correctly on commas outside brackets.
 */
const splitVarsRespectingBrackets = (input: string): string[] => {
  const result: string[] = [];
  let current = '';
  let bracketDepth = 0;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '[') bracketDepth++;
    if (char === ']') bracketDepth--;
    if (char === ',' && bracketDepth === 0) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current) result.push(current.trim());
  return result;
};

// =====================
// Start LSP Server
// =====================

connection.listen();
documents.listen(connection);
