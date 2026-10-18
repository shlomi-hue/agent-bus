export function sanitizeQuickAnswer(value: string): string {
  return value
    .replace(/[@<>`{}\\]/g, "")
    .replace(/[^\p{L}\p{N} .,'!?:+\-/%]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

export function answerChoices(body: string): string[] {
  const match = body.match(/^\[answers:\s*(.{1,180})\]\s*$/m);
  if (!match?.[1]) return [];
  return match[1]
    .split("|")
    .map((part) => sanitizeQuickAnswer(part))
    .filter((part) => part.length > 0)
    .slice(0, 4);
}

export function stripAnswers(body: string): string {
  return body.replace(/\n?^\[answers:\s*.+\]\s*$/m, "").trim();
}
