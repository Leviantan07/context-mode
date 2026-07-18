/**
 * semantic/symbol-resolver — Instruction → Language Server-equivalent → AST → Node.
 *
 * No LSP process is spun up (too heavy for a stdio MCP tool call); instead we
 * go straight to the same source of truth an LSP would use:
 *   - TypeScript/JavaScript: the TypeScript compiler API (already a project
 *     dependency, used for `tsc` builds) gives an exact, spec-correct AST.
 *   - Python: the interpreter's own `ast` stdlib module, invoked via a short
 *     subprocess (same "shell out to the language's own runtime" pattern the
 *     PolyglotExecutor already uses for python/ruby/go/etc), gives exact
 *     `end_lineno`/`end_col_offset` spans without adding a Python parsing
 *     dependency to a Node project.
 *
 * Either way the result is the same: an exact, byte-accurate SymbolInfo span
 * that a patch can target instead of a raw line number.
 */
import * as ts from "typescript";
import { execFileSync } from "node:child_process";
import type { SymbolInfo, SymbolKind, SymbolLanguage, SourcePosition } from "./types.js";

export function detectLanguage(filePath: string): SymbolLanguage | null {
  const ext = filePath.toLowerCase().split(".").pop() ?? "";
  if (["ts", "tsx", "mts", "cts"].includes(ext)) return "typescript";
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return "javascript";
  if (ext === "py") return "python";
  return null;
}

function posOf(sourceFile: ts.SourceFile, offset: number): SourcePosition {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(offset);
  return { line: line + 1, column: character };
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  const ext = filePath.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "tsx": return ts.ScriptKind.TSX;
    case "jsx": return ts.ScriptKind.JSX;
    case "mts": case "cts": return ts.ScriptKind.TS;
    case "mjs": case "cjs": case "js": return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

/** Signature text: node's source text truncated before the body (or full text for signature-less nodes). */
function signatureText(node: ts.Node, sourceFile: ts.SourceFile): string {
  const body = (node as ts.FunctionLikeDeclarationBase).body;
  const end = body ? body.getStart(sourceFile) : node.getEnd();
  return sourceFile.text.slice(node.getStart(sourceFile), end).trim();
}

function makeSymbol(
  kind: SymbolKind,
  name: string,
  path: string,
  language: SymbolLanguage,
  node: ts.Node,
  sourceFile: ts.SourceFile,
  opts: { signature?: string } = {},
): SymbolInfo {
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  return {
    kind,
    name,
    path,
    language,
    start,
    end,
    startPos: posOf(sourceFile, start),
    endPos: posOf(sourceFile, end),
    signature: opts.signature,
    children: [],
  };
}

/**
 * Walk a TS/JS AST, collecting every symbol the engine knows how to target:
 * functions, methods, classes, interfaces, enums, variables, parameters,
 * imports, decorators, string/numeric literals, and comments.
 */
export function resolveTypeScriptSymbols(filePath: string, text: string): SymbolInfo[] {
  const language: SymbolLanguage = /\.(ts|tsx|mts|cts)$/i.test(filePath) ? "typescript" : "javascript";
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(filePath),
  );

  const symbols: SymbolInfo[] = [];
  const pathStack: string[] = [];

  const currentPath = (leaf: string) => [...pathStack, leaf].join(".");

  function collectDecorators(node: ts.Node, ownerPath: string) {
    const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
    for (const dec of decorators ?? []) {
      const name = dec.expression.getText(sourceFile).split("(")[0];
      symbols.push(makeSymbol("decorator", name, `${ownerPath}@${name}`, language, dec, sourceFile));
    }
  }

  function collectParameters(params: ts.NodeArray<ts.ParameterDeclaration>, ownerPath: string) {
    for (const p of params) {
      const name = p.name.getText(sourceFile);
      symbols.push(makeSymbol("parameter", name, `${ownerPath}.${name}`, language, p, sourceFile, {
        signature: p.getText(sourceFile),
      }));
    }
  }

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier.getText(sourceFile).replace(/['"]/g, "");
      symbols.push(makeSymbol("import", spec, `import:${spec}`, language, node, sourceFile));
      return; // don't descend into import clauses
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.text;
      const path = currentPath(name);
      symbols.push(makeSymbol("function", name, path, language, node, sourceFile, {
        signature: signatureText(node, sourceFile),
      }));
      collectDecorators(node, path);
      collectParameters(node.parameters, path);
      pathStack.push(name);
      ts.forEachChild(node, visit);
      pathStack.pop();
      return;
    }

    if (ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) {
      const name = ts.isConstructorDeclaration(node) ? "constructor" : node.name?.getText(sourceFile) ?? "<anonymous>";
      const path = currentPath(name);
      symbols.push(makeSymbol("method", name, path, language, node, sourceFile, {
        signature: signatureText(node, sourceFile),
      }));
      collectDecorators(node, path);
      collectParameters(node.parameters, path);
      pathStack.push(name);
      ts.forEachChild(node, visit);
      pathStack.pop();
      return;
    }

    if (ts.isClassDeclaration(node) && node.name) {
      const name = node.name.text;
      const path = currentPath(name);
      symbols.push(makeSymbol("class", name, path, language, node, sourceFile));
      collectDecorators(node, path);
      pathStack.push(name);
      ts.forEachChild(node, visit);
      pathStack.pop();
      return;
    }

    if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.text;
      symbols.push(makeSymbol("interface", name, currentPath(name), language, node, sourceFile));
      pathStack.push(name);
      ts.forEachChild(node, visit);
      pathStack.pop();
      return;
    }

    if (ts.isEnumDeclaration(node)) {
      const name = node.name.text;
      symbols.push(makeSymbol("enum", name, currentPath(name), language, node, sourceFile));
      pathStack.push(name);
      ts.forEachChild(node, visit);
      pathStack.pop();
      return;
    }

    if (ts.isVariableDeclaration(node) && node.name.kind === ts.SyntaxKind.Identifier) {
      const name = (node.name as ts.Identifier).text;
      symbols.push(makeSymbol("variable", name, currentPath(name), language, node, sourceFile, {
        signature: node.type ? node.getText(sourceFile).split("=")[0].trim() : undefined,
      }));
    }

    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      // Only treat as a named symbol when assigned: `const f = () => {}`.
      const parent = node.parent;
      if (parent && ts.isVariableDeclaration(parent) && parent.name.kind === ts.SyntaxKind.Identifier) {
        const name = (parent.name as ts.Identifier).text;
        const path = currentPath(name);
        collectParameters(node.parameters, path);
        pathStack.push(name);
        ts.forEachChild(node, visit);
        pathStack.pop();
        return;
      }
    }

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const preview = node.text.length > 40 ? node.text.slice(0, 40) + "…" : node.text;
      symbols.push(makeSymbol("string", preview, currentPath(`"${preview}"`), language, node, sourceFile));
    }

    if (ts.isNumericLiteral(node)) {
      symbols.push(makeSymbol("literal", node.text, currentPath(node.text), language, node, sourceFile));
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  // Comments: TS doesn't walk trivia as nodes, scan leading comment ranges per statement.
  const fullText = sourceFile.text;
  const seen = new Set<number>();
  const scanComments = (node: ts.Node) => {
    const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart()) ?? [];
    for (const r of ranges) {
      if (seen.has(r.pos)) continue;
      seen.add(r.pos);
      const commentText = fullText.slice(r.pos, r.end);
      const preview = commentText.length > 40 ? commentText.slice(0, 40) + "…" : commentText;
      symbols.push({
        kind: "comment",
        name: preview,
        path: `comment@${r.pos}`,
        language,
        start: r.pos,
        end: r.end,
        startPos: posOf(sourceFile, r.pos),
        endPos: posOf(sourceFile, r.end),
      });
    }
    ts.forEachChild(node, scanComments);
  };
  scanComments(sourceFile);

  return symbols;
}

interface PyRawSymbol {
  kind: string;
  name: string;
  path: string;
  start: number;
  end: number;
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
  signature?: string;
}

const PY_AST_DUMP_SCRIPT = `
import ast, json, sys

src_path = sys.argv[1]
with open(src_path, "r", encoding="utf-8") as f:
    src = f.read()

lines = src.splitlines(keepends=True)
offsets = [0]
for line in lines:
    offsets.append(offsets[-1] + len(line))

def to_offset(lineno, col):
    if lineno < 1:
        return 0
    return offsets[lineno - 1] + col

out = []

def add(kind, name, path, node, signature=None):
    end_lineno = getattr(node, "end_lineno", node.lineno)
    end_col = getattr(node, "end_col_offset", node.col_offset)
    out.append({
        "kind": kind,
        "name": name,
        "path": path,
        "start": to_offset(node.lineno, node.col_offset),
        "end": to_offset(end_lineno, end_col),
        "start_line": node.lineno,
        "start_col": node.col_offset,
        "end_line": end_lineno,
        "end_col": end_col,
        "signature": signature,
    })

def sig_of(node):
    try:
        args = ast.unparse(node.args)
    except Exception:
        args = ""
    ret = ""
    if getattr(node, "returns", None) is not None:
        try:
            ret = " -> " + ast.unparse(node.returns)
        except Exception:
            ret = ""
    prefix = "async def " if isinstance(node, ast.AsyncFunctionDef) else "def "
    return f"{prefix}{node.name}({args}){ret}"

def walk(node, path_stack):
    for child in ast.iter_child_nodes(node):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
            kind = "method" if path_stack and path_stack[-1] != "" and isinstance(node, ast.ClassDef) else "function"
            path = ".".join(path_stack + [child.name]) if path_stack else child.name
            add(kind, child.name, path, child, sig_of(child))
            for dec in child.decorator_list:
                dname = ast.unparse(dec)
                add("decorator", dname, f"{path}@{dname}", dec)
            for a in list(child.args.posonlyargs) + list(child.args.args) + list(child.args.kwonlyargs):
                add("parameter", a.arg, f"{path}.{a.arg}", a)
            if child.args.vararg:
                add("parameter", child.args.vararg.arg, f"{path}.{child.args.vararg.arg}", child.args.vararg)
            if child.args.kwarg:
                add("parameter", child.args.kwarg.arg, f"{path}.{child.args.kwarg.arg}", child.args.kwarg)
            walk(child, path_stack + [child.name])
        elif isinstance(child, ast.ClassDef):
            path = ".".join(path_stack + [child.name]) if path_stack else child.name
            add("class", child.name, path, child)
            for dec in child.decorator_list:
                dname = ast.unparse(dec)
                add("decorator", dname, f"{path}@{dname}", dec)
            walk(child, path_stack + [child.name])
        elif isinstance(child, (ast.Import, ast.ImportFrom)):
            try:
                mod = child.module if isinstance(child, ast.ImportFrom) else ", ".join(a.name for a in child.names)
            except Exception:
                mod = ""
            add("import", mod or "", f"import:{mod}", child)
        elif isinstance(child, ast.Assign):
            for t in child.targets:
                if isinstance(t, ast.Name):
                    path = ".".join(path_stack + [t.id]) if path_stack else t.id
                    add("variable", t.id, path, child)
            walk(child, path_stack)
        elif isinstance(child, ast.Constant) and isinstance(child.value, str):
            preview = child.value if len(child.value) <= 40 else child.value[:40] + "…"
            path = ".".join(path_stack + [f'"{preview}"']) if path_stack else f'"{preview}"'
            add("string", preview, path, child)
            walk(child, path_stack)
        else:
            walk(child, path_stack)

tree = ast.parse(src)
walk(tree, [])
print(json.dumps(out))
`;

/** Resolve Python symbols by shelling out to the interpreter's own `ast` module (stdlib only). */
export function resolvePythonSymbols(pythonBin: string, filePath: string): SymbolInfo[] {
  const raw = execFileSync(pythonBin, ["-c", PY_AST_DUMP_SCRIPT, filePath], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const parsed: PyRawSymbol[] = JSON.parse(raw);
  return parsed.map((s) => ({
    kind: s.kind as SymbolKind,
    name: s.name,
    path: s.path,
    language: "python" as const,
    start: s.start,
    end: s.end,
    startPos: { line: s.start_line, column: s.start_col },
    endPos: { line: s.end_line, column: s.end_col },
    signature: s.signature,
    children: [],
  }));
}

export interface ResolveOptions {
  pythonBin?: string | null;
}

/** Parse `filePath`/`text` and return every symbol the engine can target. */
export function resolveSymbols(filePath: string, text: string, opts: ResolveOptions = {}): SymbolInfo[] {
  const language = detectLanguage(filePath);
  if (language === "typescript" || language === "javascript") {
    return resolveTypeScriptSymbols(filePath, text);
  }
  if (language === "python") {
    if (!opts.pythonBin) {
      throw new Error("Python symbol resolution requires a python3/python runtime — none detected.");
    }
    return resolvePythonSymbols(opts.pythonBin, filePath);
  }
  throw new Error(`Unsupported language for symbol resolution: ${filePath}`);
}

const KIND_ALIASES: Record<string, SymbolKind> = {
  fn: "function", func: "function", method: "method", class: "class",
  interface: "interface", enum: "enum", var: "variable", variable: "variable",
  param: "parameter", parameter: "parameter", import: "import", decorator: "decorator",
  comment: "comment", string: "string", str: "string", literal: "literal", function: "function",
};

/**
 * Resolve a free-text query (`"process_request"`, `"ClassName.method"`,
 * `"function:process_request"`, `"process_request.timeout"`) to the single
 * best-matching symbol. Preference order: exact path match > exact name
 * match (kind-filtered) > exact name match (any kind) > substring match.
 */
export function findSymbol(symbols: SymbolInfo[], query: string): SymbolInfo | null {
  let q = query.trim();
  let kindFilter: SymbolKind | null = null;
  const kindMatch = q.match(/^(\w+):(.+)$/);
  if (kindMatch && KIND_ALIASES[kindMatch[1].toLowerCase()]) {
    kindFilter = KIND_ALIASES[kindMatch[1].toLowerCase()];
    q = kindMatch[2].trim();
  }

  const pool = kindFilter ? symbols.filter((s) => s.kind === kindFilter) : symbols;
  if (pool.length === 0) return null;

  const exactPath = pool.find((s) => s.path === q);
  if (exactPath) return exactPath;

  const exactName = pool.find((s) => s.name === q);
  if (exactName) return exactName;

  const pathEndsWith = pool.find((s) => s.path.endsWith(`.${q}`) || s.path.endsWith(`@${q}`));
  if (pathEndsWith) return pathEndsWith;

  const qLower = q.toLowerCase();
  const substringMatches = pool
    .filter((s) => s.name.toLowerCase().includes(qLower) || s.path.toLowerCase().includes(qLower))
    // Prefer the narrowest (smallest span) match among substring hits.
    .sort((a, b) => (a.end - a.start) - (b.end - b.start));
  return substringMatches[0] ?? null;
}
