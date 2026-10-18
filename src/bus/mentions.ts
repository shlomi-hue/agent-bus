const FENCE = /```[\s\S]*?```/g;
const CODE = /`[^`\n]*`/g;
const MENTION = /(?:^|[^A-Za-z0-9_])@([a-z][a-z0-9_-]{0,63})/g;

export function mentionNames(body: string): string[] {
  const stripped = body.replace(FENCE, " ").replace(CODE, " ");
  const names = new Set<string>();
  for (const match of stripped.matchAll(MENTION)) {
    const name = match[1];
    if (name) names.add(name);
  }
  return [...names];
}
