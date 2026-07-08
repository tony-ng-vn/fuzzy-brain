// Node type -> star color, shared by the force-graph view and the detail panel
// so the two never drift.
const TYPE_COLORS: Record<string, string> = {
  story: "#6ec8ff",
  lesson: "#b18aff",
  quote: "#ffc46b",
  event: "#6bffb8",
  person: "#ff8ab3",
};

// Untyped nodes are plain stars; unknown types get a stable, luminous color of their own.
export function colorFor(type: string): string {
  if (!type) return "#cfe0ff";
  if (TYPE_COLORS[type]) return TYPE_COLORS[type];
  let hash = 0;
  for (const ch of type) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${hash}, 85%, 72%)`;
}
