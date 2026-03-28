import express from "express";
import Database from "better-sqlite3";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "10mb" }));

const db = new Database("memoria.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    object_name TEXT NOT NULL,
    location_text TEXT NOT NULL,
    original_text TEXT,
    created_at TEXT NOT NULL
  );
`);

app.get("/", (_req, res) => {
  res.send("Backend memoria attivo 🚀");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/message", (req, res) => {
  try {
    const userId = String(req.body?.userId || "default-user").trim();
    const text = String(req.body?.text || "").trim();

    if (!text) {
      return res.status(400).json({
        reply: "Messaggio vuoto."
      });
    }

    const parsed = parseMessage(text);

    if (parsed.intent === "save_memory") {
      saveObjectLocation(userId, parsed.objectName, parsed.locationText, text);

      return res.json({
        reply: `${capitalize(parsed.objectName)} risulta ${normalizeLocation(parsed.locationText)}.`
      });
    }

    if (parsed.intent === "find_memory") {
      const found = findLatestObjectLocation(userId, parsed.objectName);

      if (!found) {
        return res.json({
          reply: `Non ho ancora segnato dove si trova ${parsed.objectName}.`
        });
      }

      return res.json({
        reply: `${capitalize(found.object_name)} risulta ${normalizeLocation(found.location_text)}.`
      });
    }

return res.json({
  reply: "DEBUG BACKEND OK"
});
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      reply: "C'è stato un problema interno."
    });
  }
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Server attivo sulla porta ${port}`);
});

function parseMessage(text) {
  const trimmed = text.trim();

  const saveMatch = trimmed.match(
    /(?:ho messo|ho lasciato|metti via|segnati che (?:il|lo|la|le|i)?|ricorda che (?:il|lo|la|le|i)?)(?:\s+)?(.+?)\s+(?:nel|nella|in|dentro|sul|sulla)\s+(.+)/i
  );

  if (saveMatch) {
    return {
      intent: "save_memory",
      objectName: cleanObjectName(saveMatch[1]),
      locationText: cleanLocation(saveMatch[2])
    };
  }

  const findMatch = trimmed.match(
    /(?:dove ho messo|dove sono|dov[eè]'?|ti ricordi dove ho messo)\s+(?:il|lo|la|le|i)?\s*(.+?)\??$/i
  );

  if (findMatch) {
    return {
      intent: "find_memory",
      objectName: cleanObjectName(findMatch[1])
    };
  }

  return { intent: "unknown" };
}

function saveObjectLocation(userId, objectName, locationText, originalText) {
  const stmt = db.prepare(`
    INSERT INTO memories (id, user_id, object_name, location_text, original_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    crypto.randomUUID(),
    userId,
    objectName,
    locationText,
    originalText,
    new Date().toISOString()
  );
}

function findLatestObjectLocation(userId, objectName) {
  const stmt = db.prepare(`
    SELECT object_name, location_text, created_at
    FROM memories
    WHERE user_id = ?
      AND object_name LIKE ?
    ORDER BY created_at DESC
    LIMIT 1
  `);

  return stmt.get(userId, `%${objectName}%`);
}

function cleanObjectName(text) {
  return String(text || "")
    .trim()
    .replace(/\?+$/, "")
    .replace(/^(il|lo|la|le|i)\s+/i, "")
    .trim();
}

function cleanLocation(text) {
  return String(text || "").trim().replace(/\?+$/, "").trim();
}

function normalizeLocation(location) {
  const trimmed = String(location || "").trim();

  if (/^(nel|nella|in|dentro|sul|sulla)\b/i.test(trimmed)) {
    return trimmed;
  }

  return `in ${trimmed}`;
}

function capitalize(text) {
  const value = String(text || "").trim();
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}
