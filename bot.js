// ============================================================
//  911 Dispatch Bot — Discord TTS (no voice connection needed)
// ============================================================

require('dotenv').config();

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const mysql = require('mysql2/promise');

const {
  DISCORD_TOKEN,
  TEXT_CHANNEL_ID,
  DB_HOST, DB_PORT, DB_USER, DB_PASS, DB_NAME,
  POLL_INTERVAL = '4000',
} = process.env;

const PRIORITY = {
  1: { label: 'PRIORITY 1 — EMERGENCY', color: 0xe03030, emoji: '🔴' },
  2: { label: 'PRIORITY 2 — URGENT',    color: 0xe0a030, emoji: '🟡' },
  3: { label: 'PRIORITY 3 — ROUTINE',   color: 0x4ab4f0, emoji: '🔵' },
};

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

let db;
async function initDB() {
  db = await mysql.createPool({
    host:               DB_HOST,
    port:               parseInt(DB_PORT) || 3306,
    user:               DB_USER,
    password:           DB_PASS,
    database:           DB_NAME,
    waitForConnections: true,
    connectionLimit:    5,
  });
  console.log('[DB] Connected');
}

function buildTTSText(call) {
  const pri    = PRIORITY[call.priority] || PRIORITY[3];
  const postal = String(call.postal).split('').join(' ');
  return `911 call. ${pri.label}. Postal ${postal}. Caller ${call.caller}. ${call.message}.`;
}

function buildEmbed(call) {
  const pri = PRIORITY[call.priority] || PRIORITY[3];
  return new EmbedBuilder()
    .setColor(pri.color)
    .setTitle(`${pri.emoji}  911 CALL — ${pri.label}`)
    .addFields(
      { name: '📍 Postal', value: String(call.postal),  inline: true  },
      { name: '👤 Caller', value: String(call.caller),  inline: true  },
      { name: '📋 Nature', value: String(call.message), inline: false },
    )
    .setFooter({ text: `Call ID #${call.id}` })
    .setTimestamp(new Date(call.created_at));
}

async function pollCalls() {
  try {
    const [rows] = await db.execute(
      'SELECT * FROM `911_calls` WHERE read_by_bot = 0 ORDER BY created_at ASC LIMIT 10'
    );
    if (rows.length === 0) return;

    const channel = client.channels.cache.get(TEXT_CHANNEL_ID);
    if (!channel) return;

    for (const call of rows) {
      await db.execute('UPDATE `911_calls` SET read_by_bot = 1 WHERE id = ?', [call.id]);

      // Send embed
      await channel.send({ embeds: [buildEmbed(call)] }).catch(console.error);

      // Send TTS message — Discord reads this aloud to anyone with TTS on
      await channel.send({
        content: buildTTSText(call),
        tts:     true,
      }).catch(console.error);

      console.log(`[911] Dispatched call #${call.id} from ${call.caller}`);
    }
  } catch (err) {
    console.error('[Poll] DB error:', err.message);
  }
}

client.once('ready', async () => {
  console.log(`[Bot] Ready as ${client.user.tag}`);
  await initDB();
  setInterval(pollCalls, parseInt(POLL_INTERVAL));
  console.log(`[Bot] Polling every ${POLL_INTERVAL}ms`);
});

client.login(DISCORD_TOKEN);