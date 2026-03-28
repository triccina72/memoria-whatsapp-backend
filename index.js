function parseMessage(text) {
  const trimmed = text.trim();

  const saveMatch = trimmed.match(
    /(?:ho messo|ho lasciato|metti via|segnati che|ricorda che)\s+(?:il|lo|la|le|i)?\s*(.+?)\s+((?:nel|nella|nell'|nello|nei|in|dentro|sul|sulla)\s+.+)/i
  );

  if (saveMatch) {
    return {
      intent: "save_memory",
      objectName: cleanObjectName(saveMatch[1]),
      locationText: cleanLocation(saveMatch[2])
    };
  }

  const findMatch = trimmed.match(
    /(?:dove ho messo|dove sono|ti ricordi dove ho messo|dov'è|dove sta|dove si trova)\s+(?:il|lo|la|le|i)?\s*(.+?)\??$/i
  );

  if (findMatch) {
    return {
      intent: "find_memory",
      objectName: cleanObjectName(findMatch[1])
    };
  }

  return { intent: "unknown" };
}
