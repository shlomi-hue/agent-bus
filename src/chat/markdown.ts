import { lexer, type Tokens } from "marked";

type Block = Tokens.Generic & {
  type: string;
  raw?: string;
  text?: string;
  href?: string;
  lang?: string;
  depth?: number;
  ordered?: boolean;
  start?: number | string;
  task?: boolean;
  checked?: boolean;
  block?: boolean;
  tokens?: Block[];
  items?: Block[];
  header?: Array<{ tokens?: Block[]; text?: string }>;
  rows?: Array<Array<{ tokens?: Block[]; text?: string }>>;
};

const KEYWORDS: Record<string, string[]> = {
  js: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "import", "export", "from", "async", "await", "new", "try", "catch", "throw", "of", "in"],
  ts: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "import", "export", "from", "async", "await", "new", "try", "catch", "throw", "type", "interface", "extends", "implements", "of", "in"],
  py: ["def", "class", "return", "if", "elif", "else", "for", "while", "import", "from", "as", "try", "except", "with", "lambda", "yield", "pass", "in", "not", "and", "or"],
  sql: ["select", "from", "where", "insert", "update", "delete", "join", "left", "right", "inner", "on", "group", "order", "by", "limit", "and", "or", "as", "create", "table", "into", "values"],
  go: ["func", "package", "import", "return", "if", "else", "for", "range", "type", "struct", "var", "const", "map", "chan"],
  rust: ["fn", "let", "mut", "pub", "struct", "enum", "impl", "trait", "use", "mod", "return", "if", "else", "match", "loop", "while", "for", "in"],
  sh: ["if", "then", "else", "fi", "for", "in", "do", "done", "echo", "export", "case", "esac"],
};

function family(lang: string): string | null {
  const name = lang.toLowerCase();
  if (name === "javascript" || name === "jsx" || name === "js" || name === "mjs" || name === "cjs") return "js";
  if (name === "typescript" || name === "tsx" || name === "ts") return "ts";
  if (name === "python" || name === "py") return "py";
  if (name === "sql" || name === "postgres" || name === "postgresql") return "sql";
  if (name === "go" || name === "golang") return "go";
  if (name === "rust" || name === "rs") return "rust";
  if (name === "sh" || name === "bash" || name === "shell" || name === "zsh") return "sh";
  if (name === "json") return "json";
  return null;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** Allow http(s) and mailto only. Everything else is dropped. */
export function safeHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.startsWith("//")) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const protocol = url.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:" && protocol !== "mailto:") return null;
  return url.href;
}

function span(className: string, text: string): string {
  return `<span class="${className}">${escapeHtml(text)}</span>`;
}

function highlight(code: string, lang: string): string {
  const kind = family(lang);
  if (!kind) return escapeHtml(code);
  const words = kind === "json" ? null : new Set(KEYWORDS[kind]);
  const slashComment = kind === "js" || kind === "ts" || kind === "go" || kind === "rust";
  const hashComment = kind === "py" || kind === "sh";
  const dashComment = kind === "sql";
  let index = 0;
  let html = "";
  const length = code.length;

  while (index < length) {
    const rest = code.slice(index);
    if (slashComment && rest.startsWith("//")) {
      const end = rest.indexOf("\n");
      const chunk = end === -1 ? rest : rest.slice(0, end);
      html += span("tok-comment", chunk);
      index += chunk.length;
      continue;
    }
    if (slashComment && rest.startsWith("/*")) {
      const end = rest.indexOf("*/");
      const chunk = end === -1 ? rest : rest.slice(0, end + 2);
      html += span("tok-comment", chunk);
      index += chunk.length;
      continue;
    }
    if ((hashComment && rest.startsWith("#")) || (dashComment && rest.startsWith("--"))) {
      const end = rest.indexOf("\n");
      const chunk = end === -1 ? rest : rest.slice(0, end);
      html += span("tok-comment", chunk);
      index += chunk.length;
      continue;
    }
    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      let cursor = 1;
      while (cursor < rest.length) {
        if (rest[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (rest[cursor] === quote) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      html += span("tok-string", rest.slice(0, cursor));
      index += cursor;
      continue;
    }
    const number = /^\d+(?:\.\d+)?/.exec(rest);
    if (number && (index === 0 || !/[A-Za-z0-9_]/.test(code[index - 1] ?? ""))) {
      html += span("tok-number", number[0]);
      index += number[0].length;
      continue;
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (ident) {
      const word = ident[0];
      html += words?.has(word) ? span("tok-kw", word) : escapeHtml(word);
      index += word.length;
      continue;
    }
    html += escapeHtml(rest[0] ?? "");
    index += 1;
  }
  return html;
}

function renderInline(tokens: Block[] | undefined): string {
  if (!tokens) return "";
  return tokens.map((token) => renderToken(token, true)).join("");
}

function renderBlocks(tokens: Block[] | undefined): string {
  if (!tokens) return "";
  return tokens.map((token) => renderToken(token, false)).join("");
}

function renderToken(token: Block, inline: boolean): string {
  switch (token.type) {
    case "space":
      return "";
    case "br":
      return "<br>";
    case "hr":
      return "<hr>";
    case "escape":
    case "text":
      if (token.tokens && token.tokens.length > 0) return renderInline(token.tokens);
      return escapeHtml(token.text ?? "");
    case "html": {
      const escaped = escapeHtml(token.text ?? token.raw ?? "");
      return token.block ? `<p>${escaped}</p>` : escaped;
    }
    case "paragraph":
      return `<p>${renderInline(token.tokens)}</p>`;
    case "heading": {
      const depth = Math.min(6, Math.max(1, token.depth ?? 1));
      return `<h${depth}>${renderInline(token.tokens)}</h${depth}>`;
    }
    case "strong":
      return `<strong>${renderInline(token.tokens)}</strong>`;
    case "em":
      return `<em>${renderInline(token.tokens)}</em>`;
    case "del":
      return `<del>${renderInline(token.tokens)}</del>`;
    case "codespan":
      return `<code>${escapeHtml(token.text ?? "")}</code>`;
    case "code":
      return renderFence(token.text ?? "", token.lang ?? "");
    case "blockquote":
      return `<blockquote>${renderBlocks(token.tokens)}</blockquote>`;
    case "list":
      return renderList(token);
    case "list_item": {
      const box = token.task ? (token.checked ? "☑ " : "☐ ") : "";
      const children = token.tokens ?? [];
      const only = children.length === 1 ? children[0] : undefined;
      let inner = "";
      if (only?.type === "text") inner = renderInline(only.tokens) || escapeHtml(only.text ?? "");
      else if (only?.type === "paragraph") inner = renderInline(only.tokens);
      else inner = renderBlocks(children);
      return `<li>${box}${inner}</li>`;
    }
    case "link":
      return renderLink(token);
    case "image":
      return renderImage(token);
    case "table":
      return renderTable(token);
    default:
      if (inline && token.tokens && token.tokens.length > 0) return renderInline(token.tokens);
      return escapeHtml(token.text ?? "");
  }
}

function renderLink(token: Block): string {
  const href = safeHref(token.href ?? "");
  const label = renderInline(token.tokens) || escapeHtml(token.text ?? token.href ?? "");
  if (!href) return label;
  return `<a href="${escapeHtml(href)}" rel="noopener noreferrer" target="_blank">${label}</a>`;
}

function renderImage(token: Block): string {
  const href = safeHref(token.href ?? "");
  const alt = escapeHtml(token.text ?? "image");
  if (!href) return alt;
  return `<a href="${escapeHtml(href)}" rel="noopener noreferrer" target="_blank">${alt}</a>`;
}

function renderList(token: Block): string {
  const tag = token.ordered ? "ol" : "ul";
  const start = Number(token.start);
  const startAttr = token.ordered && Number.isInteger(start) && start > 1 ? ` start="${start}"` : "";
  const items = (token.items ?? []).map((item) => renderToken(item, false)).join("");
  return `<${tag}${startAttr}>${items}</${tag}>`;
}

function renderTable(token: Block): string {
  const header = (token.header ?? [])
    .map((cell) => `<th>${renderInline(cell.tokens) || escapeHtml(cell.text ?? "")}</th>`)
    .join("");
  const rows = (token.rows ?? [])
    .map((row) => {
      const cells = row
        .map((cell) => `<td>${renderInline(cell.tokens) || escapeHtml(cell.text ?? "")}</td>`)
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderFence(code: string, lang: string): string {
  const clean = lang.toLowerCase().replace(/[^a-z0-9+-]/g, "").slice(0, 16);
  const label = clean ? `<span class="lang">${escapeHtml(clean)}</span>` : `<span class="lang">text</span>`;
  return `<div class="codeblock"><div class="codebar">${label}<button type="button" class="copy">Copy</button></div><pre><code class="language-${escapeHtml(clean || "text")}">${highlight(code.replace(/\n$/, ""), clean)}</code></pre></div>`;
}

/** Render untrusted message text as safe HTML. Raw HTML is escaped. Images are links. */
export function renderMarkdown(source: string): string {
  const tokens = lexer(source, { gfm: true, breaks: true }) as unknown as Block[];
  return renderBlocks(tokens);
}
