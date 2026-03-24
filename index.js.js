require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  Events
} = require('discord.js');
const { Pool } = require('pg');

const token = process.env.TOKEN;
const clientId = process.env.CLIENT_ID;
const databaseUrl = process.env.DATABASE_URL;

if (!token) {
  console.error('TOKEN이 없습니다.');
  process.exit(1);
}

if (!clientId) {
  console.error('CLIENT_ID가 없습니다.');
  process.exit(1);
}

if (!databaseUrl) {
  console.error('DATABASE_URL이 없습니다.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: {
    rejectUnauthorized: false
  }
});

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guilds (
      guild_id TEXT PRIMARY KEY
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bosses (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      image TEXT,
      UNIQUE(guild_id, name)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS participation_checks (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      boss_name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log('DB 초기화 완료');
}

const commands = [
  new SlashCommandBuilder()
    .setName('보스추가')
    .setDescription('보스를 등록합니다')
    .addStringOption(option =>
      option
        .setName('이름')
        .setDescription('보스 이름')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('이미지')
        .setDescription('보스 이미지 URL')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('참여체크')
    .setDescription('보스 참여체크를 생성합니다')
    .addStringOption(option =>
      option
        .setName('보스')
        .setDescription('보스 이름')
        .setRequired(true)
    )
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);

  await rest.put(
    Routes.applicationCommands(clientId),
    { body: commands.map(command => command.toJSON()) }
  );

  console.log('슬래시 명령어 등록 완료');
}

async function ensureGuild(guildId) {
  await pool.query(
    `
    INSERT INTO guilds (guild_id)
    VALUES ($1)
    ON CONFLICT (guild_id) DO NOTHING
    `,
    [guildId]
  );
}

async function addBoss(guildId, name, image) {
  await pool.query(
    `
    INSERT INTO bosses (guild_id, name, image)
    VALUES ($1, $2, $3)
    ON CONFLICT (guild_id, name)
    DO UPDATE SET image = EXCLUDED.image
    `,
    [guildId, name, image || null]
  );
}

async function getBoss(guildId, name) {
  const result = await pool.query(
    `
    SELECT *
    FROM bosses
    WHERE guild_id = $1 AND name = $2
    `,
    [guildId, name]
  );

  return result.rows[0] || null;
}

async function createParticipationCheck(guildId, bossName) {
  await pool.query(
    `
    INSERT INTO participation_checks (guild_id, boss_name)
    VALUES ($1, $2)
    `,
    [guildId, bossName]
  );
}

client.once(Events.ClientReady, () => {
  console.log(`로그인 완료: ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) return;

  const guildId = interaction.guild.id;

  try {
    await ensureGuild(guildId);

    if (interaction.commandName === '보스추가') {
      const name = interaction.options.getString('이름');
      const image = interaction.options.getString('이미지');

      await addBoss(guildId, name, image);

      return await interaction.reply({
        content: `✅ 보스 등록 완료: ${name}`,
        ephemeral: true
      });
    }

    if (interaction.commandName === '참여체크') {
      const bossName = interaction.options.getString('보스');
      const boss = await getBoss(guildId, bossName);

      if (!boss) {
        return await interaction.reply({
          content: `❌ 등록되지 않은 보스입니다: ${bossName}`,
          ephemeral: true
        });
      }

      await createParticipationCheck(guildId, bossName);

      const embed = new EmbedBuilder()
        .setTitle(`📢 ${bossName} 참여체크`)
        .setDescription('참여할 사람은 아래 버튼 기능 추가 전까지 수동으로 확인해 주세요.')
        .setColor(0x5865F2)
        .setTimestamp();

      if (boss.image && /^https?:\/\//i.test(boss.image)) {
        embed.setImage(boss.image);
      }

      return await interaction.reply({
        embeds: [embed]
      });
    }
  } catch (error) {
    console.error('interaction error:', error);

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        content: '❌ 처리 중 오류가 발생했습니다.',
        ephemeral: true
      });
    } else {
      await interaction.reply({
        content: '❌ 처리 중 오류가 발생했습니다.',
        ephemeral: true
      });
    }
  }
});

(async () => {
  try {
    await initDatabase();
    await registerCommands();
    await client.login(token);
  } catch (error) {
    console.error('시작 실패:', error);
    process.exit(1);
  }
})();