export type InlineRSyntax = "knitr" | "quarto";

export interface InlineRExpression {
  syntax: InlineRSyntax;
  expression: string;
  start: number;
  end: number;
}

export function parseInlineRExpressions(markdown: string): InlineRExpression[] {
  const expressions: InlineRExpression[] = [];

  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] !== "`" || isEscaped(markdown, index)) {
      continue;
    }

    const openingLength = backtickRunLength(markdown, index);
    if (openingLength !== 1) {
      index += openingLength - 1;
      continue;
    }

    const closing = findClosingBacktick(markdown, index + 1);
    if (closing === -1) {
      break;
    }

    const content = markdown.slice(index + 1, closing);
    const quarto = content.match(/^\{r\}\s+([\s\S]+)$/i);
    const knitr = content.match(/^r\s+([\s\S]+)$/);
    const match = quarto ?? knitr;
    if (match && match[1].trim().length > 0) {
      expressions.push({
        syntax: quarto ? "quarto" : "knitr",
        expression: match[1].trim(),
        start: index,
        end: closing + 1
      });
    }

    index = closing;
  }

  return expressions;
}

export function normalizeInlineRForKnitr(markdown: string): string {
  const expressions = parseInlineRExpressions(markdown);
  if (expressions.length === 0) {
    return markdown;
  }

  let normalized = "";
  let cursor = 0;
  for (const expression of expressions) {
    normalized += markdown.slice(cursor, expression.start);
    normalized += `\`r ${expression.expression}\``;
    cursor = expression.end;
  }
  return normalized + markdown.slice(cursor);
}

export function buildInlineRExecutionCode(markdown: string): string {
  const normalized = normalizeInlineRForKnitr(markdown).replace(/\r\n/g, "\n");
  const encoded = encodeURIComponent(normalized).replace(/'/g, "%27");
  return [
    "local({",
    "if (!requireNamespace('knitr', quietly = TRUE)) stop(\"Inline R prose requires the knitr package. Install it with install.packages('knitr').\")",
    `.rmd_markdown <- utils::URLdecode('${encoded}')`,
    ".rmd_rendered <- knitr::knit(text = .rmd_markdown, quiet = TRUE, envir = .GlobalEnv)",
    "structure(list(markdown = paste(.rmd_rendered, collapse = '\\n')), class = 'rmd_notebooks_markdown')",
    "})"
  ].join("\n");
}

function findClosingBacktick(markdown: string, start: number): number {
  for (let index = start; index < markdown.length; index += 1) {
    if (markdown[index] !== "`" || isEscaped(markdown, index)) {
      continue;
    }
    if (backtickRunLength(markdown, index) === 1) {
      return index;
    }
    index += backtickRunLength(markdown, index) - 1;
  }
  return -1;
}

function backtickRunLength(value: string, start: number): number {
  let length = 0;
  while (value[start + length] === "`") {
    length += 1;
  }
  return length;
}

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}
