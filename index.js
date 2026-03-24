require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, Events } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const db = new sqlite3.Database('./database.sqlite');
const token = process.env.TOKEN;
const clientId = process.env.CLIENT_ID;

// ================= DB 초기화 =================
function initDatabase() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`
        CREATE TABLE IF NOT EXISTS guilds (
          guild_id TEXT PRIMARY KEY
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS bosses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT,
          name TEXT,
          image TEXT
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS participation_checks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT,
          boss_name TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

// ================= 명령어 등록 =================
const commands = [
  new SlashCommandBuilder()
    .setName('참여체크')
    .setDescription('보스 참여 체크 생성')
    .addStringOption(option =>
      option.setName('보스')
        .setDescription('보스 이름')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('보스추가')
    .setDescription('보스 등록')
    .addStringOption(option =>
      option.setName('이름')
        .setDescription('보스 이름')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('이미지')
        .setDescription('이미지 URL')
        .setRequired(false)
    )
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(
    Routes.applicationCommands(clientId),
    { body: commands.map(c => c.toJSON()) }
  );
  console.log('슬래시 명령어 등록 완료');
}

// ================= 유틸 =================
function ensureGuild(guildId) {
  return new Promise((resolve) => {
    db.run(
      `INSERT OR IGNORE INTO guilds (guild_id) VALUES (?)`,
      [guildId],
      resolve
    );
  });
}

function getBoss(guildId, name) {
  return new Promise((resolve) => {
    db.get(
      `SELECT * FROM bosses WHERE guild_id = ? AND name = ?`,
      [guildId, name],
      (err, row) => resolve(row)
    );
  });
}

// ================= 이벤트 =================
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const guildId = interaction.guild.id;
  await ensureGuild(guildId);

  try {
    // ================= 보스추가 =================
    if (interaction.commandName === '보스추가') {
      const name = interaction.options.getString('이름');
      const image = interaction.options.getString('이미지');

      db.run(
        `INSERT INTO bosses (guild_id, name, image) VALUES (?, ?, ?)`,
        [guildId, name, image],
        (err) => {
          if (err) {
            interaction.reply('❌ 보스 등록 실패');
            return;
          }
          interaction.reply(`✅ ${name} 등록 완료`);
        }
      );
    }

    // ================= 참여체크 =================
    if (interaction.commandName === '참여체크') {
      const bossName = interaction.options.getString('보스');

      const boss = await getBoss(guildId, bossName);

      if (!boss) {
        return interaction.reply(`❌ ${bossName} 보스 없음`);
      }

      db.run(
        `INSERT INTO participation_checks (guild_id, boss_name) VALUES (?, ?)`,
        [guildId, bossName]
      );

      const embed = new EmbedBuilder()
        .setTitle(`📢 ${bossName} 참여 체크`)
        .setDescription('버튼 눌러서 참여!')
        .setColor(0x00AE86);

      // 이미지 안전 처리 (에러 방지)
      if (boss.image && boss.image.startsWith('http')) {
        embed.setImage(boss.image);
      }

      await interaction.reply({
        embeds: [embed]
      });
    }

  } catch (err) {
    console.error(err);
    interaction.reply({ content: '❌ 오류 발생', ephemeral: true });
  }
});

// ================= 실행 =================
(async () => {
  try {
    await initDatabase();   // ⭐ 핵심 수정
    await registerCommands();
    await client.login(token);
  } catch (err) {
    console.error('시작 실패:', err);
  }
})();