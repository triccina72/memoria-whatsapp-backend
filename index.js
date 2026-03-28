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
    const userId = String(req.body?.userId || "default-user");
    const text = String(req.body?.text || "").trim();

    if (!text) {
      return res.json({ reply: "Messaggio vuoto" });
    }

    const parsed = parseMessage(text);

    if (parsed.intent === "save_memory") {
      saveObjectLocation(userId, parsed.objectName, parsed.locationText);

      return res.json({
        reply: `${parsed.objectName} è ${parsed.locationText}`
      });
    }

    if (parsed.intent === "find_memory") {
      const found = findLatestObjectLocation(userId, parsed.objectName);

      if (!found) {
        return res.json({
          reply: `Non ho trovato ${parsed.objectName}`
        });
      }

      return res.json({
        reply: `${found.object_name} è ${found.location_text}`
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
  const save = text.match(/ho messo (.+) nel (.+)/i);
  if (save) {
    return {
      intent: "save_memory",
      objectName: save[1],
      locationText: "nel " + save[2]
    };
  }

  const find = text.match(/dove ho messo (.+)/i);
  if (find) {
    return {
      intent: "find_memory",
      objectName: find[1]
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
