require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  Events
} = require('discord.js');
const { Pool } = require('pg');

const token = process.env.TOKEN;
const clientId = process.env.CLIENT_ID;
const databaseUrl = process.env.DATABASE_URL;

if (!token) throw new Error('TOKEN이 없습니다.');
if (!clientId) throw new Error('CLIENT_ID가 없습니다.');
if (!databaseUrl) throw new Error('DATABASE_URL이 없습니다.');

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false }
});

const commands = [
  new SlashCommandBuilder()
    .setName('핑')
    .setDescription('봇 응답 속도를 확인합니다.'),
  new SlashCommandBuilder()
    .setName('봇상태')
    .setDescription('봇 상태를 확인합니다.')
].map(command => command.toJSON());

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guilds (
      guild_id TEXT PRIMARY KEY,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bosses (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      time_text TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 1,
      image_url TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(guild_id, name)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS scores (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(guild_id, user_id)
    );
  `);

  console.log('DB 테이블 준비 완료');
}

async function registerGuildCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  const guilds = client.guilds.cache.map(guild => guild.id);

  console.log('슬래시 명령어 등록 중...');

  for (const guildId of guilds) {
    await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: commands }
    );
    console.log(`명령어 등록 완료: guild ${guildId}`);
  }

  console.log('전체 서버 명령어 등록 완료');
}

client.once(Events.ClientReady, async readyClient => {
  console.log(`봇 로그인 성공: ${readyClient.user.tag}`);

  try {
    await initDatabase();
    await registerGuildCommands();
  } catch (error) {
    console.error('초기화 실패:', error);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === '핑') {
    await interaction.reply(`퐁! ${client.ws.ping}ms`);
    return;
  }

  if (interaction.commandName === '봇상태') {
    await interaction.reply('PostgreSQL 연결 버전 정상 작동 중입니다.');
  }
});

client.login(token);