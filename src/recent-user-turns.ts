/** First protected position; only real user messages start interactions. */
export function recentUserTurnsBoundary(messages: readonly { role: string }[], keepRecentUserTurns = 0): number {
  if (keepRecentUserTurns === 0) return messages.length;
  let remaining = keepRecentUserTurns;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && --remaining === 0) return i;
  }
  return 0;
}
