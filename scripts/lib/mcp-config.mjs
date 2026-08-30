// Pure text/object transforms for rewriting other tools' MCP configs.
// Kept side-effect free so tests exercise real config shapes -- Codex's
// dotted TOML tables, Claude Code's mcpServers map -- without touching a
// real home directory; scripts/install-agents.mjs does the IO around
// these and never passes them anything but our own fuzzy-brain entry.

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Replaces (or appends) one TOML table -- and any of its dotted
// subtables, e.g. [mcp_servers.fuzzy-brain.env] -- leaving every other
// table byte-for-byte untouched, including the blank-line separators a
// hand-edited config.toml already uses between tables. Idempotent: a
// second call with the same newBody reproduces the first call's output.
export function replaceTomlTable(text, tableName, newBody) {
  const exact = new RegExp(`^\\[${escapeRegExp(tableName)}\\]\\s*$`);
  const subtable = new RegExp(`^\\[${escapeRegExp(tableName)}\\.`);
  const bodyLines = newBody.replace(/\n+$/, "").split("\n");

  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = trimmed.length ? trimmed.split("\n") : [];

  const start = lines.findIndex((line) => exact.test(line));
  if (start === -1) {
    if (lines.length === 0) return `${bodyLines.join("\n")}\n`;
    const needsBlankSeparator = lines[lines.length - 1] !== "";
    const appended = needsBlankSeparator ? [...lines, "", ...bodyLines] : [...lines, ...bodyLines];
    return `${appended.join("\n")}\n`;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\[/.test(lines[i]) && !subtable.test(lines[i])) {
      end = i;
      break;
    }
  }
  const hasFollowingTable = end < lines.length;
  const replacement = hasFollowingTable ? [...bodyLines, ""] : bodyLines;
  const result = [...lines.slice(0, start), ...replacement, ...lines.slice(end)];
  return `${result.join("\n")}\n`;
}

// True when replaceTomlTable will take the "replace in place" branch
// rather than "append" -- used only to phrase the dry-run report.
export function tomlTableExists(text, tableName) {
  const exact = new RegExp(`^\\[${escapeRegExp(tableName)}\\]\\s*$`);
  return text.split("\n").some((line) => exact.test(line));
}

// Merges one MCP server entry into a config object's mcpServers map,
// leaving every other top-level key and every other server untouched.
export function mergeMcpServer(config, serverName, entry) {
  const base = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const servers = base.mcpServers && typeof base.mcpServers === "object" ? base.mcpServers : {};
  return {
    ...base,
    mcpServers: { ...servers, [serverName]: entry },
  };
}
