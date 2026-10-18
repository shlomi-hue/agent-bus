const FENCE = /```[\s\S]*?```/g;
const CODE = /`[^`\n]*`/g;
const MENTION = /(?:^|[^A-Za-z0-9_])@([A-Za-z][A-Za-z0-9_-]{0,63})/g;

/** Unique agent names mentioned in body, normalized to lowercase. Code spans are ignored. */
export function mentionNames(body: string): string[] {
  const stripped = body.replace(FENCE, " ").replace(CODE, " ");
  const names = new Set<string>();
  for (const match of stripped.matchAll(MENTION)) {
    const name = match[1]?.toLowerCase();
    if (name) names.add(name);
  }
  return [...names];
}
