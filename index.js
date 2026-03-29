const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const BOTPRESS_BOT_ID = process.env.BOTPRESS_BOT_ID;
const BOTPRESS_API_TOKEN = process.env.BOTPRESS_API_TOKEN;

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memories (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      object_name TEXT NOT NULL,
      location TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reminders (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message TEXT NOT NULL,
      remind_at TIMESTAMP NOT NULL,
      channel TEXT DEFAULT 'whatsapp',
      recurrence TEXT DEFAULT 'none',
      whatsapp_count_today INTEGER DEFAULT 0,
      last_whatsapp_date DATE,
      done BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  console.log('Database pronto.');
}

initDB().catch(console.error);

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Backend assistente attivo' });
});

// ─── MEMORIA OGGETTI ────────────────────────────────────────

app.post('/memory/save', async (req, res) => {
  const { user_id, object_name, location } = req.body;
  if (!user_id || !object_name || !location)
    return res.status(400).json({ error: 'Parametri mancanti' });

  try {
    const existing = await pool.query(
      'SELECT id FROM memories WHERE user_id = $1 AND LOWER(object_name) = LOWER($2)',
      [user_id, object_name]
    );
    if (existing.rows.length > 0) {
      await pool.query(
        'UPDATE memories SET location = $1, updated_at = NOW() WHERE user_id = $2 AND LOWER(object_name) = LOWER($3)',
        [location, user_id, object_name]
      );
      return res.json({ success: true, action: 'updated', object_name, location });
    } else {
      await pool.query(
        'INSERT INTO memories (user_id, object_name, location) VALUES ($1, $2, $3)',
        [user_id, object_name, location]
      );
      return res.json({ success: true, action: 'saved', object_name, location });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore database' });
  }
});

app.post('/memory/find', async (req, res) => {
  const { user_id, object_name } = req.body;
  if (!user_id || !object_name)
    return res.status(400).json({ error: 'Parametri mancanti' });

  try {
    const result = await pool.query(
      'SELECT object_name, location, updated_at FROM memories WHERE user_id = $1 AND LOWER(object_name) = LOWER($2)',
      [user_id, object_name]
    );
    if (result.rows.length > 0) {
      const row = result.rows[0];
      return res.json({ found: true, object_name: row.object_name, location: row.location, updated_at: row.updated_at });
    } else {
      return res.json({ found: false, object_name });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore database' });
  }
});

app.get('/memory/list', async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'Parametro mancante: user_id' });

  try {
    const result = await pool.query(
      'SELECT object_name, location, updated_at FROM memories WHERE user_id = $1 ORDER BY updated_at DESC',
      [user_id]
    );
    return res.json({ items: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore database' });
  }
});

// ─── REMINDER ───────────────────────────────────────────────

app.post('/reminder/save', async (req, res) => {
  const { user_id, conversation_id, message, remind_at, channel, recurrence } = req.body;
  if (!user_id || !conversation_id || !message || !remind_at)
    return res.status(400).json({ error: 'Parametri mancanti' });

  try {
    await pool.query(
      `INSERT INTO reminders (user_id, conversation_id, message, remind_at, channel, recurrence)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [user_id, conversation_id, message, remind_at, channel || 'whatsapp', recurrence || 'none']
    );
    return res.json({ success: true, message, remind_at, channel: channel || 'whatsapp' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore database' });
  }
});

app.get('/reminder/list', async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'Parametro mancante' });

  try {
    const result = await pool.query(
      'SELECT * FROM reminders WHERE user_id = $1 AND done = FALSE ORDER BY remind_at ASC',
      [user_id]
    );
    return res.json({ reminders: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore database' });
  }
});

// ─── CRON: controlla reminder ogni minuto ───────────────────

async function checkReminders() {
  try {
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    const result = await pool.query(
      `SELECT * FROM reminders WHERE done = FALSE AND remind_at <= NOW()`
    );

    for (const reminder of result.rows) {
      const isRecurring = reminder.recurrence !== 'none';
      const whatsappToday = reminder.last_whatsapp_date === today ? reminder.whatsapp_count_today : 0;
      const canSendWhatsapp = whatsappToday < 2;

      if (reminder.channel === 'whatsapp' && canSendWhatsapp) {
        await sendWhatsappMessage(reminder.conversation_id, `🔔 Reminder: ${reminder.message}`);
        await pool.query(
          `UPDATE reminders SET
            whatsapp_count_today = $1,
            last_whatsapp_date = $2,
            done = $3,
            remind_at = CASE WHEN $4 = 'daily' THEN remind_at + INTERVAL '1 day'
                             WHEN $4 = 'weekly' THEN remind_at + INTERVAL '1 week'
                             ELSE remind_at END
           WHERE id = $5`,
          [whatsappToday + 1, today, !isRecurring, reminder.recurrence, reminder.id]
        );
      } else if (!isRecurring) {
        await pool.query('UPDATE reminders SET done = TRUE WHERE id = $1', [reminder.id]);
      }
    }
  } catch (err) {
    console.error('Errore cron reminder:', err);
  }
}

async function sendWhatsappMessage(conversationId, text) {
  try {
    await axios.post(
      `https://api.botpress.cloud/v1/chat/conversations/${conversationId}/messages`,
      { type: 'text', text: text },
      {
        headers: {
          'Authorization': `Bearer ${BOTPRESS_API_TOKEN}`,
          'x-bot-id': BOTPRESS_BOT_ID,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`Reminder inviato: ${text}`);
  } catch (err) {
    console.error('Errore invio WhatsApp:', err.response?.data || err.message);
  }
}

setInterval(checkReminders, 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
});

      return res.json({
        reply: `Ok, segno che ${withArticle(parsed.objectName)} è ${parsed.locationText}.`
      });
    }

    if (parsed.intent === "find_memory") {
      const found = findLatestObjectLocation(userId, parsed.objectName);

      if (!found) {
        return res.json({
          reply: `Non ho ancora segnato dove si trova ${withArticle(parsed.objectName)}.`
        });
      }

      return res.json({
        reply: `${withArticle(found.object_name)} è ${found.location_text}.`
      });
    }

    return res.json({
      reply: "Non ho capito bene, puoi riscriverlo?"
    });
  } catch (err) {
    console.error(err);
    return res.json({
      reply: "C'è stato un problema interno."
    });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server attivo");
});

function parseMessage(text) {
  const trimmed = text.trim();

  const save = trimmed.match(
    /ho messo\s+(?:il|lo|la|le|i)?\s*(.+?)\s+((?:nel|nella|nell'|nello|nei|in|dentro|sul|sulla)\s+.+)/i
  );

  if (save) {
    return {
      intent: "save_memory",
      objectName: cleanObjectName(save[1]),
      locationText: cleanText(save[2])
    };
  }

  const find = trimmed.match(
    /dove ho messo\s+(?:il|lo|la|le|i)?\s*(.+)/i
  );

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

function withArticle(text) {
  const value = String(text || "").trim().toLowerCase();
  if (!value) return value;
  return `il ${value}`;
}
