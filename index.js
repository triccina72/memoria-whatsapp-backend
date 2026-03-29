const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const BOTPRESS_BOT_ID = process.env.BOTPRESS_BOT_ID;
const BOTPRESS_API_TOKEN = process.env.BOTPRESS_API_TOKEN;
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

// Google Calendar auth
function getCalendarClient() {
  const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/calendar']
  });
  return google.calendar({ version: 'v3', auth });
}

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
  if (!user_id) return res.status(400).json({ error: 'Parametro mancante' });
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

  const selectedChannel = channel || 'whatsapp';
  let calendarEventId = null;
  let finalChannel = selectedChannel;

  // Prova Calendar se richiesto o come fallback
  if (selectedChannel === 'calendar' || selectedChannel === 'both') {
    try {
      const calendar = getCalendarClient();
      const startTime = new Date(remind_at);
      const endTime = new Date(startTime.getTime() + 30 * 60000);
      const event = await calendar.events.insert({
        calendarId: GOOGLE_CALENDAR_ID,
        requestBody: {
          summary: `🔔 ${message}`,
          start: { dateTime: startTime.toISOString() },
          end: { dateTime: endTime.toISOString() },
          reminders: {
            useDefault: false,
            overrides: [{ method: 'popup', minutes: 0 }]
          }
        }
      });
      calendarEventId = event.data.id;
      finalChannel = selectedChannel;
    } catch (err) {
      console.error('Errore Calendar:', err.message);
      finalChannel = 'whatsapp';
    }
  }

  try {
    await pool.query(
      `INSERT INTO reminders (user_id, conversation_id, message, remind_at, channel, recurrence)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [user_id, conversation_id, message, remind_at, finalChannel, recurrence || 'none']
    );
    return res.json({
      success: true,
      message,
      remind_at,
      channel: finalChannel,
      calendar_event_id: calendarEventId
    });
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
      `SELECT * FROM reminders WHERE done = FALSE AND remind_at <= NOW() AND channel = 'whatsapp'`
    );
    for (const reminder of result.rows) {
      const isRecurring = reminder.recurrence !== 'none';
      const whatsappToday = reminder.last_whatsapp_date === today ? reminder.whatsapp_count_today : 0;
      const canSendWhatsapp = whatsappToday < 2;

      if (canSendWhatsapp) {
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
      { type: 'text', text },
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
