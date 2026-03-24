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
  PermissionsBitField,
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
// 명령어 정의
// -------------------------
const commands = [
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
      option
        .setName('점수')
        .setDescription('참여 시 지급할 점수')
        .setRequired(false)
        .setMinValue(0)
    ),

  new SlashCommandBuilder()
    .setName('보스수정')
    .setDescription('보스 정보를 수정합니다')
    .addStringOption((option) =>
      option
        .setName('기존이름')
        .setDescription('수정할 기존 보스 이름')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option.setName('새이름').setDescription('새 보스 이름').setRequired(false)
    )
    .addStringOption((option) =>
      option.setName('이미지').setDescription('새 보스 이미지 URL').setRequired(false)
    )
    .addIntegerOption((option) =>
      option
        .setName('점수')
        .setDescription('새 참여 점수')
        .setRequired(false)
        .setMinValue(0)
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
        .setDescription('보스 이름을 입력하면 자동완성됩니다')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName('점수추가')
    .setDescription('특정 유저에게 점수를 추가합니다')
    .addUserOption((option) =>
      option.setName('대상').setDescription('점수 추가 대상').setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName('점수')
        .setDescription('추가할 점수')
        .setRequired(true)
        .setMinValue(1)
    ),

  new SlashCommandBuilder()
    .setName('점수차감')
    .setDescription('특정 유저의 점수를 차감합니다')
    .addUserOption((option) =>
      option.setName('대상').setDescription('점수 차감 대상').setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName('점수')
        .setDescription('차감할 점수')
        .setRequired(true)
        .setMinValue(1)
    ),

  new SlashCommandBuilder()
    .setName('점수초기화')
    .setDescription('현재 서버의 모든 점수를 초기화합니다'),

  new SlashCommandBuilder()
    .setName('내점수')
    .setDescription('내 점수를 확인합니다'),

  new SlashCommandBuilder()
    .setName('순위')
    .setDescription('현재 서버 점수 순위를 확인합니다'),

  new SlashCommandBuilder()
    .setName('아이템추가')
    .setDescription('창고에 아이템을 추가합니다')
    .addStringOption((option) =>
      option.setName('아이템명').setDescription('아이템 이름').setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName('수량')
        .setDescription('추가할 수량')
        .setRequired(true)
        .setMinValue(1)
    ),

  new SlashCommandBuilder()
    .setName('아이템차감')
    .setDescription('창고에서 아이템을 차감합니다')
    .addStringOption((option) =>
      option.setName('아이템명').setDescription('아이템 이름').setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName('수량')
        .setDescription('차감할 수량')
        .setRequired(true)
        .setMinValue(1)
    ),

  new SlashCommandBuilder()
    .setName('다이아추가')
    .setDescription('다이아를 추가합니다')
    .addIntegerOption((option) =>
      option
        .setName('수량')
        .setDescription('추가할 다이아 수량')
        .setRequired(true)
        .setMinValue(1)
    ),

  new SlashCommandBuilder()
    .setName('다이아차감')
    .setDescription('다이아를 차감합니다')
    .addIntegerOption((option) =>
      option
        .setName('수량')
        .setDescription('차감할 다이아 수량')
        .setRequired(true)
        .setMinValue(1)
    ),

  new SlashCommandBuilder()
    .setName('창고현황')
    .setDescription('현재 창고 현황을 확인합니다'),
];

// -------------------------
// 권한 체크
// -------------------------
const adminCommands = new Set([
  '보스추가',
  '보스수정',
  '참여체크',
  '점수추가',
  '점수차감',
  '점수초기화',
  '아이템추가',
  '아이템차감',
  '다이아추가',
  '다이아차감',
]);

function isAdminCommand(commandName) {
  return adminCommands.has(commandName);
}

function hasManageGuildPermission(interaction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild) ?? false;
}

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_assets (
      guild_id TEXT PRIMARY KEY,
      diamonds INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory_items (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      item_name TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (guild_id, item_name)
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

async function ensureGuildAssets(guildId) {
  await pool.query(
    `
    INSERT INTO guild_assets (guild_id, diamonds)
    VALUES ($1, 0)
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

async function getUserScore(guildId, userId) {
  const result = await pool.query(
    `
    SELECT score
    FROM scores
    WHERE guild_id = $1 AND user_id = $2
    `,
    [guildId, userId]
  );
  return result.rows[0]?.score ?? 0;
}

async function resetGuildScores(guildId) {
  await pool.query(
    `
    DELETE FROM scores
    WHERE guild_id = $1
    `,
    [guildId]
  );
}

async function getGuildRanking(guildId) {
  const result = await pool.query(
    `
    SELECT user_id, username, score
    FROM scores
    WHERE guild_id = $1
    ORDER BY score DESC, username ASC
    LIMIT 20
    `,
    [guildId]
  );
  return result.rows;
}

async function getDisplayNameInGuild(guild, userId, fallbackName) {
  try {
    const member = await guild.members.fetch(userId);
    return (
      member.nickname ||
      member.displayName ||
      member.user.globalName ||
      member.user.username ||
      fallbackName
    );
  } catch (_) {
    return fallbackName;
  }
}

async function getDisplayNamesForRanking(guild, rankingRows) {
  const mapped = [];

  for (const row of rankingRows) {
    const displayName = await getDisplayNameInGuild(guild, row.user_id, row.username);

    mapped.push({
      user_id: row.user_id,
      username: row.username,
      display_name: displayName,
      score: row.score,
    });
  }

  return mapped;
}

async function getGuildAssets(guildId) {
  await ensureGuildAssets(guildId);
  const result = await pool.query(
    `
    SELECT guild_id, diamonds, updated_at
    FROM guild_assets
    WHERE guild_id = $1
    `,
    [guildId]
  );
  return result.rows[0];
}

async function adjustDiamonds(guildId, delta) {
  await ensureGuildAssets(guildId);

  const current = await getGuildAssets(guildId);
  const nextValue = current.diamonds + delta;

  if (nextValue < 0) {
    return { ok: false, current: current.diamonds };
  }

  await pool.query(
    `
    UPDATE guild_assets
    SET diamonds = $2, updated_at = CURRENT_TIMESTAMP
    WHERE guild_id = $1
    `,
    [guildId, nextValue]
  );

  return { ok: true, diamonds: nextValue };
}

async function adjustItemQuantity(guildId, itemName, delta) {
  const existingResult = await pool.query(
    `
    SELECT id, quantity
    FROM inventory_items
    WHERE guild_id = $1 AND item_name = $2
    `,
    [guildId, itemName]
  );

  const existing = existingResult.rows[0];

  if (!existing && delta < 0) {
    return { ok: false, reason: 'not_found' };
  }

  const currentQty = existing ? existing.quantity : 0;
  const nextQty = currentQty + delta;

  if (nextQty < 0) {
    return { ok: false, reason: 'not_enough', current: currentQty };
  }

  if (!existing && delta > 0) {
    await pool.query(
      `
      INSERT INTO inventory_items (guild_id, item_name, quantity)
      VALUES ($1, $2, $3)
      `,
      [guildId, itemName, nextQty]
    );
    return { ok: true, quantity: nextQty };
  }

  if (nextQty === 0) {
    await pool.query(
      `
      DELETE FROM inventory_items
      WHERE guild_id = $1 AND item_name = $2
      `,
      [guildId, itemName]
    );
    return { ok: true, quantity: 0, deleted: true };
  }

  await pool.query(
    `
    UPDATE inventory_items
    SET quantity = $3, updated_at = CURRENT_TIMESTAMP
    WHERE guild_id = $1 AND item_name = $2
    `,
    [guildId, itemName, nextQty]
  );

  return { ok: true, quantity: nextQty };
}

async function getInventoryItems(guildId) {
  const result = await pool.query(
    `
    SELECT item_name, quantity
    FROM inventory_items
    WHERE guild_id = $1
    ORDER BY item_name ASC
    `,
    [guildId]
  );
  return result.rows;
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

// -------------------------
// 명령어 등록
// -------------------------
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);

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

    setInterval(async () => {
      try {
        await cleanupOldParticipationData();
      } catch (err) {
        console.error('주기적 정리 실패:', err);
      }
    }, 60 * 60 * 1000);
  } catch (error) {
    console.error('시작 후 처리 실패:', error);
  }
});

// -------------------------
// 자동완성
// -------------------------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isAutocomplete()) return;
  if (!interaction.guild) return;

  try {
    const guildId = interaction.guild.id;
    const focused = interaction.options.getFocused(true);

    if (
      (interaction.commandName === '참여체크' && focused.name === '보스') ||
      (interaction.commandName === '보스수정' && focused.name === '기존이름')
    ) {
      const names = await searchBossNames(guildId, focused.value || '');

      await interaction.respond(
        names.map((name) => ({
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
// 슬래시 명령어 처리
// -------------------------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) return;

  const guildId = interaction.guild.id;
  const commandName = interaction.commandName;

  try {
    if (isAdminCommand(commandName) && !hasManageGuildPermission(interaction)) {
      await interaction.reply({
        content: '❌ 이 명령어는 서버 관리 권한이 필요합니다.',
        ephemeral: true,
      });
      return;
    }

    await ensureGuild(guildId);
    await ensureGuildAssets(guildId);
    await cleanupOldParticipationData();

    if (commandName === '보스추가') {
      await interaction.deferReply({ ephemeral: true });

      const name = interaction.options.getString('이름');
      const imageUrl = interaction.options.getString('이미지');
      const score = interaction.options.getInteger('점수') ?? 0;

      await addBoss(guildId, name, imageUrl, score);

      await interaction.editReply(
        `✅ 보스 등록 완료\n이름: ${name}\n점수: ${score}\n이미지: ${imageUrl || '없음'}`
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

      await interaction.editReply(`✅ 보스 수정 완료: ${oldName}`);
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
      const bossName = interaction.options.getString('보스');
      const boss = await getBossByName(guildId, bossName);

      if (!boss) {
        await interaction.reply({
          content: `❌ 등록되지 않은 보스입니다: ${bossName}`,
          ephemeral: true,
        });
        return;
      }

      const modal = new ModalBuilder()
        .setCustomId(`createcheck:${boss.id}`)
        .setTitle(`${boss.name} 참여체크 생성`);

      const passwordInput = new TextInputBuilder()
        .setCustomId('check_password')
        .setLabel('비밀번호')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('예: 1234');

      const durationInput = new TextInputBuilder()
        .setCustomId('check_duration')
        .setLabel('제한시간(분)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('예: 60');

      modal.addComponents(
        new ActionRowBuilder().addComponents(passwordInput),
        new ActionRowBuilder().addComponents(durationInput)
      );

      await interaction.showModal(modal);
      return;
    }

    if (commandName === '점수추가') {
      await interaction.deferReply({ ephemeral: true });

      const target = interaction.options.getUser('대상');
      const score = interaction.options.getInteger('점수');

      await addScore(guildId, target.id, target.username, score);

      const current = await getUserScore(guildId, target.id);
      await interaction.editReply(`✅ 점수 추가 완료: ${target.username} / 현재 점수 ${current}`);
      return;
    }

    if (commandName === '점수차감') {
      await interaction.deferReply({ ephemeral: true });

      const target = interaction.options.getUser('대상');
      const score = interaction.options.getInteger('점수');

      await addScore(guildId, target.id, target.username, -score);

      const current = await getUserScore(guildId, target.id);
      await interaction.editReply(`✅ 점수 차감 완료: ${target.username} / 현재 점수 ${current}`);
      return;
    }

    if (commandName === '점수초기화') {
      await interaction.deferReply({ ephemeral: true });

      await resetGuildScores(guildId);

      await interaction.editReply('✅ 현재 서버의 모든 점수를 초기화했습니다.');
      return;
    }

    if (commandName === '내점수') {
      await interaction.deferReply({ ephemeral: true });

      const score = await getUserScore(guildId, interaction.user.id);
      const displayName =
        interaction.member?.nickname ||
        interaction.member?.displayName ||
        interaction.user.globalName ||
        interaction.user.username;

      await interaction.editReply(`${displayName}님의 현재 점수: ${score}`);
      return;
    }

    if (commandName === '순위') {
      await interaction.deferReply({ ephemeral: true });

      const ranking = await getGuildRanking(guildId);

      if (ranking.length === 0) {
        await interaction.editReply('아직 점수 데이터가 없습니다.');
        return;
      }

      const withDisplayNames = await getDisplayNamesForRanking(interaction.guild, ranking);
      const lines = withDisplayNames.map(
        (row, index) => `${index + 1}. ${row.display_name} - ${row.score}점`
      );

      await interaction.editReply(lines.join('\n'));
      return;
    }

    if (commandName === '아이템추가') {
      await interaction.deferReply({ ephemeral: true });

      const itemName = interaction.options.getString('아이템명');
      const quantity = interaction.options.getInteger('수량');

      const result = await adjustItemQuantity(guildId, itemName, quantity);
      await interaction.editReply(`✅ 아이템 추가 완료: ${itemName} / 현재 수량 ${result.quantity}`);
      return;
    }

    if (commandName === '아이템차감') {
      await interaction.deferReply({ ephemeral: true });

      const itemName = interaction.options.getString('아이템명');
      const quantity = interaction.options.getInteger('수량');

      const result = await adjustItemQuantity(guildId, itemName, -quantity);

      if (!result.ok) {
        if (result.reason === 'not_found') {
          await interaction.editReply(`❌ 존재하지 않는 아이템입니다: ${itemName}`);
          return;
        }
        if (result.reason === 'not_enough') {
          await interaction.editReply(`❌ 수량 부족: 현재 ${result.current}`);
          return;
        }
      }

      if (result.deleted) {
        await interaction.editReply(`✅ 아이템 차감 완료: ${itemName} / 수량 0으로 자동 삭제됨`);
        return;
      }

      await interaction.editReply(`✅ 아이템 차감 완료: ${itemName} / 현재 수량 ${result.quantity}`);
      return;
    }

    if (commandName === '다이아추가') {
      await interaction.deferReply({ ephemeral: true });

      const quantity = interaction.options.getInteger('수량');
      const result = await adjustDiamonds(guildId, quantity);

      await interaction.editReply(`✅ 다이아 추가 완료 / 현재 다이아 ${result.diamonds}`);
      return;
    }

    if (commandName === '다이아차감') {
      await interaction.deferReply({ ephemeral: true });

      const quantity = interaction.options.getInteger('수량');
      const result = await adjustDiamonds(guildId, -quantity);

      if (!result.ok) {
        await interaction.editReply(`❌ 다이아 부족 / 현재 다이아 ${result.current}`);
        return;
      }

      await interaction.editReply(`✅ 다이아 차감 완료 / 현재 다이아 ${result.diamonds}`);
      return;
    }

    if (commandName === '창고현황') {
      await interaction.deferReply({ ephemeral: true });

      const assets = await getGuildAssets(guildId);
      const items = await getInventoryItems(guildId);

      const itemText =
        items.length === 0
          ? '아이템 없음'
          : items.map((item, index) => `${index + 1}. ${item.item_name} x ${item.quantity}`).join('\n');

      await interaction.editReply(
        `다이아: ${assets.diamonds}\n\n아이템 목록\n${itemText}`
      );
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

      const lines = [];
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const displayName = await getDisplayNameInGuild(
          interaction.guild,
          entry.user_id,
          entry.username
        );
        const lateText = entry.is_late ? ' (늦은참여)' : '';
        lines.push(`${i + 1}. ${displayName}${lateText}`);
      }

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

    if (action === 'createcheck') {
      const bossId = Number(idValue);

      const bossResult = await pool.query(
        `
        SELECT *
        FROM bosses
        WHERE id = $1 AND guild_id = $2
        `,
        [bossId, interaction.guild.id]
      );
      const boss = bossResult.rows[0];

      if (!boss) {
        await interaction.reply({
          content: '❌ 보스를 찾지 못했습니다.',
          ephemeral: true,
        });
        return;
      }

      const password = interaction.fields.getTextInputValue('check_password').trim();
      const durationRaw = interaction.fields.getTextInputValue('check_duration').trim();
      const durationMinutes = Number(durationRaw);

      if (!password) {
        await interaction.reply({
          content: '❌ 비밀번호는 필수입니다.',
          ephemeral: true,
        });
        return;
      }

      if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
        await interaction.reply({
          content: '❌ 제한시간은 1 이상의 숫자로 입력해야 합니다.',
          ephemeral: true,
        });
        return;
      }

      const checkId = await createParticipationCheck(
        interaction.guild.id,
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
            `비밀번호 있음`,
            `제한시간: ${durationMinutes}분`,
          ].join('\n')
        )
        .setColor(0x5865f2)
        .setTimestamp();

      if (boss.image_url && /^https?:\/\//i.test(boss.image_url)) {
        embed.setImage(boss.image_url);
      }

      await interaction.reply({
        embeds: [embed],
        components: buildMainButtons(checkId),
      });
      return;
    }

    if (action === 'pwmodal') {
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
      return;
    }
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