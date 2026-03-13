// ============================================================
//  911 Dispatch Bot — ElevenLabs TTS + Discord Voice
// ============================================================

require('dotenv').config();

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, entersState,
  getVoiceConnection,
} = require('@discordjs/voice');
const mysql      = require('mysql2/promise');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');
const https      = require('https');
const { spawn }  = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const {
  DISCORD_TOKEN,
  TEXT_CHANNEL_ID,
  VOICE_CHANNEL_ID,
  DB_HOST, DB_PORT, DB_USER, DB_PASS, DB_NAME,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL', // default: Bella
  POLL_INTERVAL       = '4000',
  VOICE_IDLE_TIMEOUT  = '30000',
} = process.env;

const PRIORITY = {
  1: { label: 'PRIORITY 1 — EMERGENCY', color: 0xe03030, emoji: '🔴' },
  2: { label: 'PRIORITY 2 — URGENT',    color: 0xe0a030, emoji: '🟡' },
  3: { label: 'PRIORITY 3 — ROUTINE',   color: 0x4ab4f0, emoji: '🔵' },
};

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// ── DB ───────────────────────────────────────────────────────
let db;
async function initDB() {
  db = await mysql.createPool({
    host: DB_HOST, port: parseInt(DB_PORT) || 3306,
    user: DB_USER, password: DB_PASS, database: DB_NAME,
    waitForConnections: true, connectionLimit: 5,
  });
  console.log('[DB] Connected');
}

// ── ElevenLabs TTS ───────────────────────────────────────────
function buildTTSText(call) {
  const pri    = PRIORITY[call.priority] || PRIORITY[3];
  const postal = String(call.postal).split('').join(' ');
  return `911 call. ${pri.label}. Postal ${postal}. Caller ${call.caller}. ${call.message}.`;
}

async function generateElevenLabs(text) {
  const mp3Path = path.join(os.tmpdir(), `911_${Date.now()}.mp3`);

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      text,
      model_id: 'eleven_monolingual_v1',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    });

    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path:     `/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      method:   'POST',
      headers:  {
        'Content-Type':  'application/json',
        'xi-api-key':    ELEVENLABS_API_KEY,
        'Accept':        'audio/mpeg',
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`ElevenLabs API returned ${res.statusCode}`));
        return;
      }
      const out = fs.createWriteStream(mp3Path);
      res.pipe(out);
      out.on('finish', () => resolve(mp3Path));
      out.on('error', reject);
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function mp3ToWav(mp3Path) {
  const wavPath = mp3Path.replace('.mp3', '.wav');
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, [
      '-i', mp3Path, '-f', 'wav', '-ar', '48000', '-ac', '2', wavPath, '-y',
    ]);
    ff.stderr.on('data', () => {});
    ff.on('close', (code) => code === 0 ? resolve(wavPath) : reject(new Error(`ffmpeg ${code}`)));
    ff.on('error', reject);
  });
}

// ── Voice queue ───────────────────────────────────────────────
const queue   = [];
let isPlaying = false;
let idleTimer = null;

async function playNext() {
  if (isPlaying || queue.length === 0) return;
  isPlaying = true;
  clearTimeout(idleTimer);

  const guild = client.guilds.cache.first();
  if (!guild) { isPlaying = false; return; }

  let conn = getVoiceConnection(guild.id);
  if (!conn) {
    conn = joinVoiceChannel({
      channelId: VOICE_CHANNEL_ID, guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false, selfMute: false,
    });
    try {
      await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
      console.log('[Voice] Connected');
    } catch (err) {
      console.error('[Voice] Failed:', err.message);
      conn.destroy(); isPlaying = false; return;
    }
  }

  const { mp3Path } = queue.shift();
  try {
    const wavPath = await mp3ToWav(mp3Path);
    fs.unlink(mp3Path, () => {});

    const resource = createAudioResource(wavPath);
    const player   = createAudioPlayer();
    conn.subscribe(player);
    player.play(resource);
    console.log('[Voice] Playing...');

    player.once(AudioPlayerStatus.Idle, () => {
      fs.unlink(wavPath, () => {});
      isPlaying = false;
      if (queue.length > 0) {
        playNext();
      } else {
        idleTimer = setTimeout(() => {
          const c = getVoiceConnection(guild.id);
          if (c) { c.destroy(); console.log('[Voice] Left channel'); }
        }, parseInt(VOICE_IDLE_TIMEOUT));
      }
    });

    player.once('error', (err) => {
      console.error('[Voice] Error:', err.message);
      fs.unlink(wavPath, () => {});
      isPlaying = false; playNext();
    });

  } catch (err) {
    console.error('[Audio] Error:', err.message);
    fs.unlink(mp3Path, () => {});
    isPlaying = false; playNext();
  }
}

// ── Embed ─────────────────────────────────────────────────────
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

// ── Poll ──────────────────────────────────────────────────────
async function pollCalls() {
  try {
    const [rows] = await db.execute(
      'SELECT * FROM `911_calls` WHERE read_by_bot = 0 ORDER BY created_at ASC LIMIT 10'
    );
    if (rows.length === 0) return;

    const textCh = client.channels.cache.get(TEXT_CHANNEL_ID);

    for (const call of rows) {
      await db.execute('UPDATE `911_calls` SET read_by_bot = 1 WHERE id = ?', [call.id]);
      if (textCh) await textCh.send({ embeds: [buildEmbed(call)] }).catch(console.error);

      try {
        const text    = buildTTSText(call);
        console.log('[TTS] Generating:', text);
        const mp3Path = await generateElevenLabs(text);
        console.log('[TTS] Done:', mp3Path);
        queue.push({ mp3Path });
        playNext();
      } catch (err) {
        console.error('[TTS] Error:', err.message);
      }
    }
  } catch (err) {
    console.error('[Poll] DB error:', err.message);
  }
}

// ── Start ─────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`[Bot] Ready as ${client.user.tag}`);
  await client.guilds.fetch();
  await initDB();
  setInterval(pollCalls, parseInt(POLL_INTERVAL));
  console.log(`[Bot] Polling every ${POLL_INTERVAL}ms`);
});

client.login(DISCORD_TOKEN);