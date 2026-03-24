require('dotenv').config();

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { Pool } = require('pg');

const token = process.env.TOKEN;
const clientId = process.env.CLIENT_ID;
const guildIdForCommands = process.env.GUILD_ID;
const databaseUrl = process.env.DATABASE_URL;

if (!token) {
  console.error('TOKEN이 없습니다.');
  process.exit(1);
}
if (!clientId) {
  console.error('CLIENT_ID가 없습니다.');
  process.exit(1);
}
if (!guildIdForCommands) {
  console.error('GUILD_ID가 없습니다.');
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
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('PG Pool 에러:', err);
});

// -------------------------
// DB 초기화
// -------------------------
async function initDatabase() {
  console.log('DB 연결 테스트 시작');
  const test = await pool.query('SELECT NOW()');
  console.log('DB 연결 성공:', test.rows[0]);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS guilds (
      guild_id TEXT PRIMARY KEY,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bosses (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      image_url TEXT,
      score INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (guild_id, name)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS participation_checks (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      boss_id BIGINT NOT NULL,
      boss_name TEXT NOT NULL,
      password TEXT NOT NULL DEFAULT '',
      duration_minutes INTEGER NOT NULL DEFAULT 0,
      expires_at BIGINT NOT NULL DEFAULT 0,
      created_by_user_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS participation_entries (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      check_id BIGINT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      is_late BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (check_id, user_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS scores (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (guild_id, user_id)
    );
  `);

  console.log('DB 초기화 완료');
}

// -------------------------
// 공통 함수
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

async function cleanupOldParticipationData() {
  await pool.query(`
    DELETE FROM participation_entries
    WHERE created_at < NOW() - INTERVAL '30 days'
  `);

  await pool.query(`
    DELETE FROM participation_checks
    WHERE created_at < NOW() - INTERVAL '30 days'
  `);
}

async function getBossList(guildId) {
  const result = await pool.query(
    `
    SELECT id, guild_id, name, image_url, score, created_at
    FROM bosses
    WHERE guild_id = $1
    ORDER BY name ASC
    `,
    [guildId]
  );
  return result.rows;
}

async function getBossByName(guildId, bossName) {
  const result = await pool.query(
    `
    SELECT id, guild_id, name, image_url, score, created_at
    FROM bosses
    WHERE guild_id = $1 AND name = $2
    `,
    [guildId, bossName]
  );
  return result.rows[0] || null;
}

async function addBoss(guildId, name, imageUrl, score) {
  await pool.query(
    `
    INSERT INTO bosses (guild_id, name, image_url, score)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (guild_id, name)
    DO UPDATE SET
      image_url = COALESCE(EXCLUDED.image_url, bosses.image_url),
      score = EXCLUDED.score
    `,
    [guildId, name, imageUrl || null, score ?? 0]
  );
}

async function updateBoss(guildId, oldName, newName, imageUrl, score) {
  const boss = await getBossByName(guildId, oldName);
  if (!boss) return false;

  await pool.query(
    `
    UPDATE bosses
    SET
      name = COALESCE($3, name),
      image_url = COALESCE($4, image_url),
      score = COALESCE($5, score)
    WHERE guild_id = $1 AND name = $2
    `,
    [guildId, oldName, newName || null, imageUrl || null, score]
  );

  return true;
}

async function createParticipationCheck(guildId, boss, password, durationMinutes, createdByUserId) {
  const nowMs = Date.now();
  const expiresAtMs =
    durationMinutes && Number.isInteger(durationMinutes)
      ? nowMs + durationMinutes * 60 * 1000
      : 0;

  const result = await pool.query(
    `
    INSERT INTO participation_checks (
      guild_id,
      boss_id,
      boss_name,
      password,
      duration_minutes,
      expires_at,
      created_by_user_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id
    `,
    [
      guildId,
      boss.id,
      boss.name,
      password || '',
      durationMinutes || 0,
      expiresAtMs,
      createdByUserId,
    ]
  );

  return result.rows[0].id;
}

async function getParticipationCheckById(checkId) {
  const result = await pool.query(
    `
    SELECT *
    FROM participation_checks
    WHERE id = $1
    `,
    [checkId]
  );
  return result.rows[0] || null;
}

async function addParticipationEntry(guildId, checkId, userId, username, isLate = false) {
  const result = await pool.query(
    `
    INSERT INTO participation_entries (
      guild_id,
      check_id,
      user_id,
      username,
      is_late
    )
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (check_id, user_id) DO NOTHING
    RETURNING id
    `,
    [guildId, checkId, userId, username, isLate]
  );

  return result.rowCount > 0;
}

async function getParticipationEntries(checkId) {
  const result = await pool.query(
    `
    SELECT user_id, username, is_late, created_at
    FROM participation_entries
    WHERE check_id = $1
    ORDER BY created_at ASC
    `,
    [checkId]
  );
  return result.rows;
}

async function addScore(guildId, userId, username, amount) {
  await pool.query(
    `
    INSERT INTO scores (guild_id, user_id, username, score)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (guild_id, user_id)
    DO UPDATE SET
      username = EXCLUDED.username,
      score = scores.score + EXCLUDED.score,
      updated_at = CURRENT_TIMESTAMP
    `,
    [guildId, userId, username, amount]
  );
}

function buildMainButtons(checkId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`join:${checkId}`)
        .setLabel('참여')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`list:${checkId}`)
        .setLabel('참여명단')
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

function buildBossChoices(bosses) {
  return bosses.slice(0, 25).map((boss) => ({
    name: boss.name.length > 100 ? boss.name.slice(0, 100) : boss.name,
    value: boss.name,
  }));
}

// -------------------------
// 명령어 정의(보스 선택형)
// -------------------------
async function buildCommands() {
  const bosses = await getBossList(guildIdForCommands);
  const bossChoices = buildBossChoices(bosses);

  return [
    new SlashCommandBuilder()
      .setName('보스추가')
      .setDescription('보스를 등록합니다')
      .addStringOption((option) =>
        option.setName('이름').setDescription('보스 이름').setRequired(true)
      )
      .addStringOption((option) =>
        option.setName('이미지').setDescription('보스 이미지 URL').setRequired(false)
      )
      .addIntegerOption((option) =>
        option.setName('점수').setDescription('참여 시 지급할 점수').setRequired(false).setMinValue(0)
      ),

    new SlashCommandBuilder()
      .setName('보스수정')
      .setDescription('보스 정보를 수정합니다')
      .addStringOption((option) =>
        option.setName('기존이름').setDescription('기존 보스 이름').setRequired(true)
      )
      .addStringOption((option) =>
        option.setName('새이름').setDescription('새 보스 이름').setRequired(false)
      )
      .addStringOption((option) =>
        option.setName('이미지').setDescription('새 보스 이미지 URL').setRequired(false)
      )
      .addIntegerOption((option) =>
        option.setName('점수').setDescription('새 참여 점수').setRequired(false).setMinValue(0)
      ),

    new SlashCommandBuilder()
      .setName('보스목록')
      .setDescription('현재 서버에 등록된 보스 목록을 확인합니다'),

    new SlashCommandBuilder()
      .setName('참여체크')
      .setDescription('보스 참여체크를 생성합니다')
      .addStringOption((option) =>
        option
          .setName('비밀번호')
          .setDescription('없으면 비워두기')
          .setRequired(false)
      )
      .addIntegerOption((option) =>
        option
          .setName('제한시간')
          .setDescription('분 단위, 예: 60')
          .setRequired(false)
          .setMinValue(1)
      )
      .addStringOption((option) => {
        option
          .setName('보스')
          .setDescription('보스를 선택하세요')
          .setRequired(true);

        for (const choice of bossChoices) {
          option.addChoices(choice);
        }

        return option;
      }),

    new SlashCommandBuilder()
      .setName('늦은참여추가')
      .setDescription('관리자가 늦은 참여자를 수동 등록합니다')
      .addIntegerOption((option) =>
        option.setName('참여체크아이디').setDescription('참여체크 ID').setRequired(true)
      )
      .addUserOption((option) =>
        option.setName('대상').setDescription('추가할 유저').setRequired(true)
      ),
  ];
}

// -------------------------
// 명령어 등록
// -------------------------
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  const commands = await buildCommands();

  await rest.put(
    Routes.applicationCommands(clientId),
    { body: [] }
  );
  console.log('기존 글로벌 명령어 삭제 완료');

  await rest.put(
    Routes.applicationGuildCommands(clientId, guildIdForCommands),
    { body: commands.map((command) => command.toJSON()) }
  );
  console.log('길드 슬래시 명령어 등록 완료');
}

// -------------------------
// Ready
// -------------------------
client.once(Events.ClientReady, async () => {
  console.log(`로그인 완료: ${client.user.tag}`);

  try {
    await cleanupOldParticipationData();
    await registerCommands();
  } catch (error) {
    console.error('시작 후 처리 실패:', error);
  }
});

// -------------------------
// 슬래시 명령어 처리
// -------------------------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) return;

  const guildId = interaction.guild.id;
  const commandName = interaction.commandName;

  try {
    await ensureGuild(guildId);
    await cleanupOldParticipationData();

    if (commandName === '보스추가') {
      await interaction.deferReply({ ephemeral: true });

      const name = interaction.options.getString('이름');
      const imageUrl = interaction.options.getString('이미지');
      const score = interaction.options.getInteger('점수') ?? 0;

      await addBoss(guildId, name, imageUrl, score);

      await interaction.editReply(
        `✅ 보스 등록 완료\n이름: ${name}\n점수: ${score}\n이미지: ${imageUrl || '없음'}\n\n보스 선택 목록 갱신을 위해 Railway에서 Restart 한 번 해줘야 해.`
      );
      return;
    }

    if (commandName === '보스수정') {
      await interaction.deferReply({ ephemeral: true });

      const oldName = interaction.options.getString('기존이름');
      const newName = interaction.options.getString('새이름');
      const imageUrl = interaction.options.getString('이미지');
      const score = interaction.options.getInteger('점수');

      const ok = await updateBoss(guildId, oldName, newName, imageUrl, score);

      if (!ok) {
        await interaction.editReply(`❌ 보스를 찾지 못했습니다: ${oldName}`);
        return;
      }

      await interaction.editReply(`✅ 보스 수정 완료: ${oldName}\n목록 갱신을 위해 Railway Restart 한 번 해줘야 해.`);
      return;
    }

    if (commandName === '보스목록') {
      await interaction.deferReply({ ephemeral: true });

      const bosses = await getBossList(guildId);

      if (bosses.length === 0) {
        await interaction.editReply('등록된 보스가 없습니다.');
        return;
      }

      const lines = bosses.map((boss, index) => {
        return `${index + 1}. ${boss.name} | 점수:${boss.score} | 이미지:${boss.image_url ? '있음' : '없음'}`;
      });

      await interaction.editReply(lines.join('\n'));
      return;
    }

    if (commandName === '참여체크') {
      await interaction.deferReply();

      const password = interaction.options.getString('비밀번호') || '';
      const durationMinutes = interaction.options.getInteger('제한시간') || 0;
      const bossName = interaction.options.getString('보스');

      const boss = await getBossByName(guildId, bossName);

      if (!boss) {
        await interaction.editReply(`❌ 등록되지 않은 보스입니다: ${bossName}`);
        return;
      }

      const checkId = await createParticipationCheck(
        guildId,
        boss,
        password,
        durationMinutes,
        interaction.user.id
      );

      const embed = new EmbedBuilder()
        .setTitle(`📢 ${boss.name} 참여체크`)
        .setDescription(
          [
            `참여체크 ID: ${checkId}`,
            `기본 점수: ${boss.score}`,
            password ? `비밀번호 있음` : `비밀번호 없음`,
            durationMinutes > 0 ? `제한시간: ${durationMinutes}분` : `제한시간 없음`,
          ].join('\n')
        )
        .setColor(0x5865f2)
        .setTimestamp();

      if (boss.image_url && /^https?:\/\//i.test(boss.image_url)) {
        embed.setImage(boss.image_url);
      }

      await interaction.editReply({
        embeds: [embed],
        components: buildMainButtons(checkId),
      });
      return;
    }

    if (commandName === '늦은참여추가') {
      await interaction.deferReply({ ephemeral: true });

      const checkId = interaction.options.getInteger('참여체크아이디');
      const target = interaction.options.getUser('대상');

      const check = await getParticipationCheckById(checkId);

      if (!check) {
        await interaction.editReply(`❌ 참여체크를 찾지 못했습니다: ${checkId}`);
        return;
      }

      const added = await addParticipationEntry(
        guildId,
        checkId,
        target.id,
        target.username,
        true
      );

      if (!added) {
        await interaction.editReply(`⚠️ 이미 등록된 참여자입니다: ${target.username}`);
        return;
      }

      const boss = await getBossByName(guildId, check.boss_name);
      const scoreToAdd = boss?.score ?? 0;
      await addScore(guildId, target.id, target.username, scoreToAdd);

      await interaction.editReply(`✅ 늦은 참여 추가 완료: ${target.username}`);
      return;
    }
  } catch (error) {
    console.error('slash command error:', error);

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('❌ 처리 중 오류가 발생했습니다.');
      } else {
        await interaction.reply({
          content: '❌ 처리 중 오류가 발생했습니다.',
          ephemeral: true,
        });
      }
    } catch (_) {}
  }
});

// -------------------------
// 버튼 처리
// -------------------------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.guild) return;

  try {
    const [action, idValue] = interaction.customId.split(':');
    const checkId = Number(idValue);

    if (action === 'list') {
      const entries = await getParticipationEntries(checkId);

      if (entries.length === 0) {
        await interaction.reply({
          content: '아직 참여자가 없습니다.',
          ephemeral: true,
        });
        return;
      }

      const lines = entries.map((entry, index) => {
        const lateText = entry.is_late ? ' (늦은참여)' : '';
        return `${index + 1}. ${entry.username}${lateText}`;
      });

      await interaction.reply({
        content: lines.join('\n'),
        ephemeral: true,
      });
      return;
    }

    if (action === 'join') {
      const check = await getParticipationCheckById(checkId);

      if (!check) {
        await interaction.reply({
          content: '이미 삭제되었거나 없는 참여체크입니다.',
          ephemeral: true,
        });
        return;
      }

      if (check.expires_at > 0 && Date.now() > Number(check.expires_at)) {
        await interaction.reply({
          content: '참여 제한시간이 지났습니다.',
          ephemeral: true,
        });
        return;
      }

      if (check.password && check.password.trim() !== '') {
        const modal = new ModalBuilder()
          .setCustomId(`pwmodal:${checkId}`)
          .setTitle('비밀번호 입력');

        const input = new TextInputBuilder()
          .setCustomId('password_input')
          .setLabel('비밀번호')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);

        await interaction.showModal(modal);
        return;
      }

      const added = await addParticipationEntry(
        interaction.guild.id,
        checkId,
        interaction.user.id,
        interaction.user.username,
        false
      );

      if (!added) {
        await interaction.reply({
          content: '이미 참여한 사용자입니다.',
          ephemeral: true,
        });
        return;
      }

      const boss = await getBossByName(interaction.guild.id, check.boss_name);
      const scoreToAdd = boss?.score ?? 0;
      await addScore(interaction.guild.id, interaction.user.id, interaction.user.username, scoreToAdd);

      await interaction.reply({
        content: `✅ 참여 완료! ${scoreToAdd}점 적립`,
        ephemeral: true,
      });
      return;
    }
  } catch (error) {
    console.error('button error:', error);

    try {
      await interaction.reply({
        content: '❌ 처리 중 오류가 발생했습니다.',
        ephemeral: true,
      });
    } catch (_) {}
  }
});

// -------------------------
// 모달 처리
// -------------------------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isModalSubmit()) return;
  if (!interaction.guild) return;

  try {
    const [action, idValue] = interaction.customId.split(':');
    if (action !== 'pwmodal') return;

    const checkId = Number(idValue);
    const inputPassword = interaction.fields.getTextInputValue('password_input');
    const check = await getParticipationCheckById(checkId);

    if (!check) {
      await interaction.reply({
        content: '이미 삭제되었거나 없는 참여체크입니다.',
        ephemeral: true,
      });
      return;
    }

    if (check.expires_at > 0 && Date.now() > Number(check.expires_at)) {
      await interaction.reply({
        content: '참여 제한시간이 지났습니다.',
        ephemeral: true,
      });
      return;
    }

    if ((check.password || '') !== inputPassword) {
      await interaction.reply({
        content: '❌ 비밀번호가 틀렸습니다.',
        ephemeral: true,
      });
      return;
    }

    const added = await addParticipationEntry(
      interaction.guild.id,
      checkId,
      interaction.user.id,
      interaction.user.username,
      false
    );

    if (!added) {
      await interaction.reply({
        content: '이미 참여한 사용자입니다.',
        ephemeral: true,
      });
      return;
    }

    const boss = await getBossByName(interaction.guild.id, check.boss_name);
    const scoreToAdd = boss?.score ?? 0;
    await addScore(interaction.guild.id, interaction.user.id, interaction.user.username, scoreToAdd);

    await interaction.reply({
      content: `✅ 참여 완료! ${scoreToAdd}점 적립`,
      ephemeral: true,
    });
  } catch (error) {
    console.error('modal error:', error);

    try {
      await interaction.reply({
        content: '❌ 처리 중 오류가 발생했습니다.',
        ephemeral: true,
      });
    } catch (_) {}
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