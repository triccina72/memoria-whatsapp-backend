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
    created_at TEXT NOT NULL
  );
`);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/message", (req, res) => {
  try {
    const userId = String(req.body?.userId || "default-user").trim();
    const text = String(req.body?.text || "").trim();

    if (!text) {
      return res.json({ reply: "Messaggio vuoto." });
    }

    const parsed = parseMessage(text);

    if (parsed.intent === "save_memory") {
      saveObjectLocation(userId, parsed.objectName, parsed.locationText);

      return res.json({
        reply: `MEMO ${parsed.objectName} si trova ${parsed.locationText}`
      });
    }

    if (parsed.intent === "find_memory") {
      const found = findLatestObjectLocation(userId, parsed.objectName);

      if (!found) {
        return res.json({
          reply: `MEMO ${parsed.objectName} non è stato trovato`
        });
      }

      return res.json({
        reply: `MEMO ${found.object_name} si trova ${found.location_text}`
      });
    }

    return res.json({
      reply: "Non ho capito bene, puoi riscriverlo?"
    });
  } catch (err) {
    console.error(err);
    return res.json({
      reply: "Errore interno"
    });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server attivo");
});

function parseMessage(text) {
  const trimmed = text.trim();

  const save = trimmed.match(/ho messo\s+(?:il|lo|la|le|i)?\s*(.+?)\s+nel\s+(.+)/i);
  if (save) {
    return {
      intent: "save_memory",
      objectName: cleanObjectName(save[1]),
      locationText: "nel " + cleanText(save[2])
    };
  }

  const find = trimmed.match(/dove ho messo\s+(?:il|lo|la|le|i)?\s*(.+)/i);
  if (find) {
    return {
      intent: "find_memory",
      objectName: cleanObjectName(find[1])
    };
  }

  return { intent: "unknown" };
}

function saveObjectLocation(userId, objectName, locationText) {
  db.prepare(`
    INSERT INTO memories (id, user_id, object_name, location_text, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    userId,
    objectName,
    locationText,
    new Date().toISOString()
  );
}

function findLatestObjectLocation(userId, objectName) {
  return db.prepare(`
    SELECT object_name, location_text
    FROM memories
    WHERE user_id = ?
      AND object_name LIKE ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(userId, `%${objectName}%`);
}

function cleanObjectName(text) {
  return String(text || "")
    .trim()
    .replace(/[?.!,;:]+$/g, "")
    .replace(/^(il|lo|la|le|i)\s+/i, "")
    .trim()
    .toLowerCase();
}

function cleanText(text) {
  return String(text || "")
    .trim()
    .replace(/[?.!,;:]+$/g, "")
    .trim()
    .toLowerCase();
}
