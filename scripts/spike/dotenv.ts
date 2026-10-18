/**
 * Minimal reader for `.dev.vars` (dotenv syntax as Wrangler accepts it): `KEY=value` lines,
 * `#` comments, optional single or double quotes. Escapes such as `\n` are kept literally;
 * `normalizePrivateKey` turns them into line breaks.
 */
export function parseDotenv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    const [, key = "", rest = ""] = match;
    values[key] = unquote(rest.trim());
  }
  return values;
}

function unquote(value: string): string {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  // Unquoted values may carry a trailing comment.
  const comment = value.search(/\s#/);
  return comment === -1 ? value : value.slice(0, comment).trimEnd();
}
