require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  Events,
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
  intents: [GatewayIntentBits.Guilds],
});

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: {
    rejectUnauthorized: false,
  },
});

pool.on('error', (err) => {
  console.error('PG Pool 에러:', err);
});

// -------------------------
// 슬래시 명령어 정의
// -------------------------
const commands = [
  new SlashCommandBuilder()
    .setName('보스추가')
    .setDescription('보스를 등록합니다')
    .addStringOption((option) =>
      option
        .setName('이름')
        .setDescription('보스 이름')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName('이미지')
        .setDescription('보스 이미지 URL')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('보스목록')
    .setDescription('현재 서버에 등록된 보스 목록을 확인합니다'),

  new SlashCommandBuilder()
    .setName('참여체크')
    .setDescription('보스 참여체크를 생성합니다')
    .addStringOption((option) =>
      option
        .setName('보스')
        .setDescription('보스 이름')
        .setRequired(true)
        .setAutocomplete(true)
    ),
];

// -------------------------
// DB 초기화
// -------------------------
async function initDatabase() {
  console.log('DB 연결 테스트 시작');
  const test = await pool.query('SELECT NOW()');
  console.log('DB 연결 성공:', test.rows[0]);

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
      time_text TEXT,
      score INTEGER DEFAULT 0,
      image_url TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

  await pool.query(`
    ALTER TABLE bosses
    ADD COLUMN IF NOT EXISTS time_text TEXT;
  `);

  await pool.query(`
    ALTER TABLE bosses
    ADD COLUMN IF NOT EXISTS score INTEGER DEFAULT 0;
  `);

  await pool.query(`
    ALTER TABLE bosses
    ADD COLUMN IF NOT EXISTS image_url TEXT;
  `);

  await pool.query(`
    ALTER TABLE bosses
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'bosses_guild_id_name_key'
      ) THEN
        ALTER TABLE bosses
        ADD CONSTRAINT bosses_guild_id_name_key UNIQUE (guild_id, name);
      END IF;
    END
    $$;
  `);

  console.log('DB 초기화 완료');
}

// -------------------------
// 슬래시 명령어 등록
// -------------------------
async function registerCommands() {
  console.log('슬래시 명령어 등록 시작');

  const rest = new REST({ version: '10' }).setToken(token);

  await rest.put(
    Routes.applicationCommands(clientId),
    { body: commands.map((command) => command.toJSON()) }
  );

  console.log('슬래시 명령어 등록 완료');
}

// -------------------------
// DB 함수
// -------------------------
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

async function addBoss(guildId, name, imageUrl) {
  await pool.query(
    `
    INSERT INTO bosses (guild_id, name, image_url)
    VALUES ($1, $2, $3)
    ON CONFLICT (guild_id, name)
    DO UPDATE SET image_url = COALESCE(EXCLUDED.image_url, bosses.image_url)
    `,
    [guildId, name, imageUrl || null]
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

async function getBossList(guildId) {
  const result = await pool.query(
    `
    SELECT id, name, time_text, score, image_url, created_at
    FROM bosses
    WHERE guild_id = $1
    ORDER BY name ASC
    `,
    [guildId]
  );

  return result.rows;
}

async function searchBossNames(guildId, keyword) {
  const result = await pool.query(
    `
    SELECT name
    FROM bosses
    WHERE guild_id = $1
      AND name ILIKE $2
    ORDER BY name ASC
    LIMIT 25
    `,
    [guildId, `%${keyword}%`]
  );

  return result.rows.map((row) => row.name);
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

// -------------------------
// Ready 이벤트
// -------------------------
client.once(Events.ClientReady, async () => {
  console.log(`로그인 완료: ${client.user.tag}`);

  try {
    await registerCommands();
  } catch (error) {
    console.error('슬래시 명령어 등록 실패:', error);
  }
});

// -------------------------
// 자동완성 처리
// -------------------------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isAutocomplete()) return;
  if (!interaction.guild) return;

  const guildId = interaction.guild.id;
  const focused = interaction.options.getFocused(true);

  try {
    if (
      (interaction.commandName === '참여체크' && focused.name === '보스') ||
      (interaction.commandName === '보스추가' && focused.name === '이름')
    ) {
      const names = await searchBossNames(guildId, focused.value || '');

      await interaction.respond(
        names.slice(0, 25).map((name) => ({
          name,
          value: name,
        }))
      );
      return;
    }

    await interaction.respond([]);
  } catch (error) {
    console.error('autocomplete error:', error);

    try {
      await interaction.respond([]);
    } catch (_) {}
  }
});

// -------------------------
// 명령어 처리
// -------------------------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) return;

  const guildId = interaction.guild.id;
  const commandName = interaction.commandName;

  console.log('명령어 수신:', {
    commandName,
    guildId,
    userId: interaction.user.id,
  });

  try {
    if (commandName === '보스추가') {
      await interaction.deferReply({ ephemeral: true });

      const name = interaction.options.getString('이름');
      const imageUrl = interaction.options.getString('이미지');

      await ensureGuild(guildId);
      await addBoss(guildId, name, imageUrl);

      await interaction.editReply({
        content: `✅ 보스 등록 완료: ${name}`,
      });
      return;
    }

    if (commandName === '보스목록') {
      await interaction.deferReply({ ephemeral: true });

      const bosses = await getBossList(guildId);

      if (bosses.length === 0) {
        await interaction.editReply({
          content: `현재 서버 guild_id: ${guildId}\n등록된 보스가 없습니다.`,
        });
        return;
      }

      const lines = bosses.map((boss, index) => {
        const timeText = boss.time_text ? ` | 시간:${boss.time_text}` : '';
        const scoreText = boss.score != null ? ` | 점수:${boss.score}` : '';
        return `${index + 1}. ${boss.name}${timeText}${scoreText}`;
      });

      await interaction.editReply({
        content:
          `현재 서버 guild_id: ${guildId}\n` +
          `등록된 보스 ${bosses.length}개\n\n` +
          lines.join('\n'),
      });
      return;
    }

    if (commandName === '참여체크') {
      await interaction.deferReply();

      const bossName = interaction.options.getString('보스');

      await ensureGuild(guildId);

      const boss = await getBoss(guildId, bossName);

      if (!boss) {
        await interaction.editReply({
          content: `❌ 현재 서버(guild_id: ${guildId})에 등록되지 않은 보스입니다: ${bossName}`,
          embeds: [],
        });
        return;
      }

      await createParticipationCheck(guildId, bossName);

      const embed = new EmbedBuilder()
        .setTitle(`📢 ${bossName} 참여체크`)
        .setDescription('참여할 사람은 아래 버튼 기능 추가 전까지 수동으로 확인해 주세요.')
        .setColor(0x5865f2)
        .setTimestamp();

      if (boss.image_url && /^https?:\/\//i.test(boss.image_url)) {
        embed.setImage(boss.image_url);
      }

      await interaction.editReply({
        content: '',
        embeds: [embed],
      });
      return;
    }
  } catch (error) {
    console.error('interaction error:', error);

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
          content: '❌ 처리 중 오류가 발생했습니다.',
          embeds: [],
        });
      } else {
        await interaction.reply({
          content: '❌ 처리 중 오류가 발생했습니다.',
          ephemeral: true,
        });
      }
    } catch (replyError) {
      console.error('응답 전송 실패:', replyError);
    }
  }
});

// -------------------------
// 시작
// -------------------------
(async () => {
  try {
    await initDatabase();
    await client.login(token);
  } catch (error) {
    console.error('시작 실패:', error);
    process.exit(1);
  }
})();