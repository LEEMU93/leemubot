require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Events,
  PermissionFlagsBits
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

const activeChecks = new Map();

/* ----------------------------- DB helpers ----------------------------- */

async function query(sql, params = []) {
  return pool.query(sql, params);
}

async function initDatabase() {
  await query(`
    CREATE TABLE IF NOT EXISTS guilds (
      guild_id TEXT PRIMARY KEY,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await query(`
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

  await query(`
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

  await query(`
    CREATE TABLE IF NOT EXISTS inventory_items (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      item_name TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(guild_id, item_name)
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS guild_assets (
      guild_id TEXT PRIMARY KEY,
      diamonds INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS inventory_logs (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      item_name TEXT,
      log_type TEXT NOT NULL,
      change_amount INTEGER NOT NULL DEFAULT 0,
      memo TEXT,
      actor_id TEXT,
      actor_name TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS participation_checks (
      check_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      boss_name TEXT NOT NULL,
      password TEXT NOT NULL,
      score INTEGER NOT NULL,
      image_url TEXT,
      time_text TEXT NOT NULL,
      limit_minutes INTEGER NOT NULL,
      created_at TIMESTAMP NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS participation_entries (
      id SERIAL PRIMARY KEY,
      check_id TEXT NOT NULL REFERENCES participation_checks(check_id) ON DELETE CASCADE,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      joined_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(check_id, user_id)
    );
  `);

  console.log('DB 테이블 준비 완료');
}

async function ensureGuild(guildId) {
  await query(
    `INSERT INTO guilds (guild_id) VALUES ($1)
     ON CONFLICT (guild_id) DO NOTHING`,
    [guildId]
  );
}

async function ensureGuildAssets(guildId) {
  await query(
    `INSERT INTO guild_assets (guild_id, diamonds)
     VALUES ($1, 0)
     ON CONFLICT (guild_id) DO NOTHING`,
    [guildId]
  );
}

async function getBosses(guildId) {
  const { rows } = await query(
    `SELECT id, name, time_text, score, image_url
     FROM bosses
     WHERE guild_id = $1
     ORDER BY name ASC`,
    [guildId]
  );
  return rows;
}

async function getBossByName(guildId, bossName) {
  const { rows } = await query(
    `SELECT id, name, time_text, score, image_url
     FROM bosses
     WHERE guild_id = $1 AND name = $2`,
    [guildId, bossName]
  );
  return rows[0] || null;
}

async function addBoss(guildId, name, timeText, score, imageUrl) {
  await query(
    `INSERT INTO bosses (guild_id, name, time_text, score, image_url)
     VALUES ($1, $2, $3, $4, $5)`,
    [guildId, name, timeText, score, imageUrl || null]
  );
}

async function updateBoss(guildId, bossName, updates) {
  const current = await getBossByName(guildId, bossName);
  if (!current) return null;

  const nextName = updates.newName ?? current.name;
  const nextTime = updates.newTime ?? current.time_text;
  const nextScore = updates.newScore ?? current.score;
  const nextImageUrl = updates.newImageUrl ?? current.image_url;

  await query(
    `UPDATE bosses
     SET name = $1, time_text = $2, score = $3, image_url = $4
     WHERE guild_id = $5 AND name = $6`,
    [nextName, nextTime, nextScore, nextImageUrl, guildId, bossName]
  );

  return {
    name: nextName,
    time_text: nextTime,
    score: nextScore,
    image_url: nextImageUrl
  };
}

async function getScore(guildId, userId) {
  const { rows } = await query(
    `SELECT user_id, user_name, score
     FROM scores
     WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId]
  );
  return rows[0] || null;
}

async function adjustScore(guildId, userId, userName, amount) {
  const existing = await getScore(guildId, userId);

  if (!existing) {
    const initialScore = Math.max(0, amount);
    await query(
      `INSERT INTO scores (guild_id, user_id, user_name, score)
       VALUES ($1, $2, $3, $4)`,
      [guildId, userId, userName, initialScore]
    );
    return initialScore;
  }

  const newScore = Math.max(0, Number(existing.score) + amount);

  await query(
    `UPDATE scores
     SET user_name = $1, score = $2, updated_at = NOW()
     WHERE guild_id = $3 AND user_id = $4`,
    [userName, newScore, guildId, userId]
  );

  return newScore;
}

async function resetScores(guildId) {
  await query(`DELETE FROM scores WHERE guild_id = $1`, [guildId]);
}

async function getRanking(guildId) {
  const { rows } = await query(
    `SELECT user_id, user_name, score
     FROM scores
     WHERE guild_id = $1
     ORDER BY score DESC, user_name ASC`,
    [guildId]
  );
  return rows;
}

/* ------------------------ inventory / diamonds ------------------------ */

async function getInventoryItems(guildId) {
  const { rows } = await query(
    `SELECT item_name, quantity
     FROM inventory_items
     WHERE guild_id = $1
     ORDER BY item_name ASC`,
    [guildId]
  );
  return rows;
}

async function getInventoryItem(guildId, itemName) {
  const { rows } = await query(
    `SELECT item_name, quantity
     FROM inventory_items
     WHERE guild_id = $1 AND item_name = $2`,
    [guildId, itemName]
  );
  return rows[0] || null;
}

async function adjustInventoryItem(guildId, itemName, amount) {
  const current = await getInventoryItem(guildId, itemName);

  if (!current) {
    const initialQuantity = Math.max(0, amount);

    await query(
      `INSERT INTO inventory_items (guild_id, item_name, quantity)
       VALUES ($1, $2, $3)`,
      [guildId, itemName, initialQuantity]
    );

    return initialQuantity;
  }

  const newQuantity = Math.max(0, Number(current.quantity) + amount);

  await query(
    `UPDATE inventory_items
     SET quantity = $1, updated_at = NOW()
     WHERE guild_id = $2 AND item_name = $3`,
    [newQuantity, guildId, itemName]
  );

  if (newQuantity === 0) {
    await query(
      `DELETE FROM inventory_items WHERE guild_id = $1 AND item_name = $2`,
      [guildId, itemName]
    );
  }

  return newQuantity;
}

async function getDiamonds(guildId) {
  await ensureGuildAssets(guildId);

  const { rows } = await query(
    `SELECT diamonds
     FROM guild_assets
     WHERE guild_id = $1`,
    [guildId]
  );

  return rows[0] ? Number(rows[0].diamonds) : 0;
}

async function adjustDiamonds(guildId, amount) {
  await ensureGuildAssets(guildId);

  const current = await getDiamonds(guildId);
  const next = Math.max(0, current + amount);

  await query(
    `UPDATE guild_assets
     SET diamonds = $1, updated_at = NOW()
     WHERE guild_id = $2`,
    [next, guildId]
  );

  return next;
}

async function setDiamonds(guildId, amount) {
  await ensureGuildAssets(guildId);

  const next = Math.max(0, amount);

  await query(
    `UPDATE guild_assets
     SET diamonds = $1, updated_at = NOW()
     WHERE guild_id = $2`,
    [next, guildId]
  );

  return next;
}

async function addInventoryLog(guildId, logType, itemName, changeAmount, memo, actorId, actorName) {
  await query(
    `INSERT INTO inventory_logs (
      guild_id, item_name, log_type, change_amount, memo, actor_id, actor_name
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [guildId, itemName || null, logType, changeAmount, memo || null, actorId || null, actorName || null]
  );
}

async function getInventoryLogs(guildId, limit = 20) {
  const { rows } = await query(
    `SELECT item_name, log_type, change_amount, memo, actor_name, created_at
     FROM inventory_logs
     WHERE guild_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [guildId, limit]
  );
  return rows;
}

/* ---------------------- participation check helpers ------------------- */

async function createParticipationCheck(data) {
  await query(
    `INSERT INTO participation_checks (
      check_id, guild_id, boss_name, password, score, image_url,
      time_text, limit_minutes, created_at, expires_at, channel_id, message_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TO_TIMESTAMP($9 / 1000.0), TO_TIMESTAMP($10 / 1000.0), $11, $12)`,
    [
      data.checkId,
      data.guildId,
      data.bossName,
      data.password,
      data.score,
      data.imageUrl || null,
      data.timeText,
      data.limitMinutes,
      data.createdAt,
      data.expiresAt,
      data.channelId,
      data.messageId || null
    ]
  );
}

async function updateParticipationCheckMessageId(checkId, messageId) {
  await query(
    `UPDATE participation_checks
     SET message_id = $1
     WHERE check_id = $2`,
    [messageId, checkId]
  );
}

async function getParticipationCheck(checkId) {
  const { rows } = await query(
    `SELECT check_id, guild_id, boss_name, password, score, image_url, time_text,
            limit_minutes,
            FLOOR(EXTRACT(EPOCH FROM created_at) * 1000) AS created_at_ms,
            FLOOR(EXTRACT(EPOCH FROM expires_at) * 1000) AS expires_at_ms,
            channel_id, message_id
     FROM participation_checks
     WHERE check_id = $1`,
    [checkId]
  );

  const row = rows[0];
  if (!row) return null;

  return {
    checkId: row.check_id,
    guildId: row.guild_id,
    bossName: row.boss_name,
    password: row.password,
    score: Number(row.score),
    imageUrl: row.image_url || null,
    timeText: row.time_text,
    limitMinutes: Number(row.limit_minutes),
    createdAt: Number(row.created_at_ms),
    expiresAt: Number(row.expires_at_ms),
    channelId: row.channel_id,
    messageId: row.message_id,
    participants: []
  };
}

async function getParticipationParticipants(checkId) {
  const { rows } = await query(
    `SELECT user_id AS id, user_name AS name
     FROM participation_entries
     WHERE check_id = $1
     ORDER BY joined_at ASC`,
    [checkId]
  );

  return rows;
}

async function hasParticipationEntry(checkId, userId) {
  const { rows } = await query(
    `SELECT 1
     FROM participation_entries
     WHERE check_id = $1 AND user_id = $2`,
    [checkId, userId]
  );

  return !!rows[0];
}

async function addParticipationEntry(checkId, guildId, userId, userName) {
  await query(
    `INSERT INTO participation_entries (check_id, guild_id, user_id, user_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (check_id, user_id) DO NOTHING`,
    [checkId, guildId, userId, userName]
  );
}

async function loadCheckData(checkId) {
  let checkData = activeChecks.get(checkId);
  if (checkData) return checkData;

  const dbCheck = await getParticipationCheck(checkId);
  if (!dbCheck) return null;

  const participants = await getParticipationParticipants(checkId);
  dbCheck.participants = participants;

  activeChecks.set(checkId, dbCheck);
  return dbCheck;
}

async function findLatestCheckByBoss(guildId, bossName) {
  const { rows } = await query(
    `SELECT check_id
     FROM participation_checks
     WHERE guild_id = $1 AND boss_name = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [guildId, bossName]
  );

  if (!rows[0]) return null;

  const checkId = rows[0].check_id;
  const checkData = await loadCheckData(checkId);

  if (!checkData) return null;

  return { checkId, checkData };
}

async function refreshCheckMessage(checkId) {
  const checkData = await loadCheckData(checkId);
  if (!checkData) return;

  checkData.participants = await getParticipationParticipants(checkId);

  try {
    const channel = await client.channels.fetch(checkData.channelId);
    if (!channel || !channel.messages) return;
    if (!checkData.messageId) return;

    const message = await channel.messages.fetch(checkData.messageId);
    await message.edit({
      embeds: [buildCheckEmbed(checkData)],
      components: [buildCheckButtons(checkId, isCheckExpired(checkData))]
    });
  } catch (error) {
    console.error('참여체크 메시지 갱신 실패:', error);
  }
}

async function deleteGuildData(guildId) {
  await query(`DELETE FROM participation_entries WHERE guild_id = $1`, [guildId]);
  await query(`DELETE FROM participation_checks WHERE guild_id = $1`, [guildId]);
  await query(`DELETE FROM inventory_logs WHERE guild_id = $1`, [guildId]);
  await query(`DELETE FROM inventory_items WHERE guild_id = $1`, [guildId]);
  await query(`DELETE FROM guild_assets WHERE guild_id = $1`, [guildId]);
  await query(`DELETE FROM bosses WHERE guild_id = $1`, [guildId]);
  await query(`DELETE FROM scores WHERE guild_id = $1`, [guildId]);
  await query(`DELETE FROM guilds WHERE guild_id = $1`, [guildId]);
}

/* --------------------------- util / builders -------------------------- */

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

async function getDisplayNameFromUser(guild, user) {
  try {
    const member = await guild.members.fetch(user.id).catch(() => null);
    return member?.nickname || user.globalName || user.username;
  } catch {
    return user.globalName || user.username;
  }
}

function getDisplayNameFromInteraction(interaction) {
  return interaction.member?.nickname || interaction.user.globalName || interaction.user.username;
}

function formatKoreaDateTime(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}

function isCheckExpired(checkData) {
  return Date.now() > Number(checkData.expiresAt);
}

function buildCheckButtons(checkId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`join|${checkId}`)
      .setLabel('참여하기')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`list|${checkId}`)
      .setLabel('참여명단')
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildCheckEmbed(checkData) {
  const participants = Array.isArray(checkData.participants) ? checkData.participants : [];
  const participantText = participants.length > 0
    ? participants.map((user, index) => `${index + 1}. ${user.name}`).join('\n')
    : '아직 참여자가 없습니다.';

  const remainingMs = Math.max(0, Number(checkData.expiresAt) - Date.now());
  const remainingMinutes = Math.ceil(remainingMs / 60000);
  const isExpired = isCheckExpired(checkData);

  const embed = new EmbedBuilder()
    .setTitle(`참여체크 - ${checkData.bossName}`)
    .setDescription(
      `시간: ${checkData.timeText}\n` +
      `점수: ${checkData.score}점\n` +
      `제한시간: ${checkData.limitMinutes}분\n` +
      `상태: ${isExpired ? '종료됨' : `${remainingMinutes}분 남음`}`
    )
    .addFields({
      name: `참여 명단 (${participants.length}명)`,
      value: participantText.length > 1024 ? participantText.slice(0, 1020) + '...' : participantText
    })
    .setFooter({ text: `생성 시각: ${formatKoreaDateTime(checkData.createdAt)}` })
    .setTimestamp(new Date());

  if (checkData.imageUrl) {
    embed.setImage(checkData.imageUrl);
  }

  return embed;
}

function getLogTypeLabel(logType) {
  const map = {
    item_add: '아이템 추가',
    item_remove: '아이템 차감',
    item_set: '아이템 설정',
    diamond_add: '다이아 추가',
    diamond_remove: '다이아 차감',
    diamond_set: '다이아 설정'
  };
  return map[logType] || logType;
}

/* ------------------------ slash command setup ------------------------ */

const commands = [
  new SlashCommandBuilder()
    .setName('보스추가')
    .setDescription('보스를 추가합니다.')
    .addStringOption(option =>
      option.setName('이름').setDescription('보스 이름').setRequired(true)
    )
    .addStringOption(option =>
      option.setName('시간').setDescription('보스 시간 텍스트').setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('점수').setDescription('보스 점수').setRequired(true)
    )
    .addStringOption(option =>
      option.setName('이미지').setDescription('보스 이미지 URL').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('보스수정')
    .setDescription('보스 정보를 수정합니다.')
    .addStringOption(option =>
      option.setName('기존이름').setDescription('수정할 보스 이름').setRequired(true)
    )
    .addStringOption(option =>
      option.setName('새이름').setDescription('새 보스 이름').setRequired(false)
    )
    .addStringOption(option =>
      option.setName('새시간').setDescription('새 보스 시간').setRequired(false)
    )
    .addIntegerOption(option =>
      option.setName('새점수').setDescription('새 보스 점수').setRequired(false)
    )
    .addStringOption(option =>
      option.setName('새이미지').setDescription('새 보스 이미지 URL').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('보스목록')
    .setDescription('등록된 보스 목록을 확인합니다.'),

  new SlashCommandBuilder()
    .setName('참여체크')
    .setDescription('보스 참여체크를 생성합니다.')
    .addStringOption(option =>
      option.setName('보스').setDescription('보스 이름').setRequired(true).setAutocomplete(true)
    )
    .addStringOption(option =>
      option.setName('비밀번호').setDescription('참여 비밀번호').setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('제한시간').setDescription('참여 가능 시간(분)').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('늦은참여추가')
    .setDescription('최근 참여체크에 늦은 참여자를 추가합니다.')
    .addStringOption(option =>
      option.setName('보스').setDescription('보스 이름').setRequired(true).setAutocomplete(true)
    )
    .addUserOption(option =>
      option.setName('유저').setDescription('추가할 유저').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('점수추가')
    .setDescription('유저 점수를 추가합니다.')
    .addUserOption(option =>
      option.setName('유저').setDescription('대상 유저').setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('점수').setDescription('추가할 점수').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('점수차감')
    .setDescription('유저 점수를 차감합니다.')
    .addUserOption(option =>
      option.setName('유저').setDescription('대상 유저').setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('점수').setDescription('차감할 점수').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('점수확인')
    .setDescription('내 점수를 확인합니다.'),

  new SlashCommandBuilder()
    .setName('점수랭킹')
    .setDescription('점수 랭킹을 확인합니다.'),

  new SlashCommandBuilder()
    .setName('점수초기화')
    .setDescription('점수를 전체 초기화합니다.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('서버초기화')
    .setDescription('이 서버의 모든 데이터를 삭제합니다.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('창고아이템추가')
    .setDescription('창고 아이템을 추가합니다.')
    .addStringOption(option =>
      option.setName('이름').setDescription('아이템 이름').setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('수량').setDescription('추가 수량').setRequired(true)
    )
    .addStringOption(option =>
      option.setName('내용').setDescription('추가 내용').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('창고아이템차감')
    .setDescription('창고 아이템을 차감합니다.')
    .addStringOption(option =>
      option.setName('이름').setDescription('아이템 이름').setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('수량').setDescription('차감 수량').setRequired(true)
    )
    .addStringOption(option =>
      option.setName('내용').setDescription('차감 내용').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('창고아이템설정')
    .setDescription('창고 아이템 수량을 설정합니다.')
    .addStringOption(option =>
      option.setName('이름').setDescription('아이템 이름').setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('수량').setDescription('설정 수량').setRequired(true)
    )
    .addStringOption(option =>
      option.setName('내용').setDescription('설정 내용').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('창고아이템목록')
    .setDescription('창고 아이템 목록을 확인합니다.'),

  new SlashCommandBuilder()
    .setName('다이아추가')
    .setDescription('다이아를 추가합니다.')
    .addIntegerOption(option =>
      option.setName('수량').setDescription('추가할 다이아 수량').setRequired(true)
    )
    .addStringOption(option =>
      option.setName('내용').setDescription('추가 내용').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('다이아차감')
    .setDescription('다이아를 차감합니다.')
    .addIntegerOption(option =>
      option.setName('수량').setDescription('차감할 다이아 수량').setRequired(true)
    )
    .addStringOption(option =>
      option.setName('내용').setDescription('차감 내용').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('다이아설정')
    .setDescription('다이아를 특정 수량으로 설정합니다.')
    .addIntegerOption(option =>
      option.setName('수량').setDescription('설정할 다이아 수량').setRequired(true)
    )
    .addStringOption(option =>
      option.setName('내용').setDescription('설정 내용').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('창고현황')
    .setDescription('다이아 및 아이템 현황을 확인합니다.'),

  new SlashCommandBuilder()
    .setName('창고기록')
    .setDescription('최근 창고 기록을 확인합니다.')
].map(command => command.toJSON());

/* ---------------------------- discord setup --------------------------- */

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(
    Routes.applicationCommands(clientId),
    { body: commands }
  );
  console.log('슬래시 명령어 등록 완료');
}

client.once(Events.ClientReady, async readyClient => {
  console.log(`로그인 완료: ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isAutocomplete()) {
      const focusedOption = interaction.options.getFocused(true);
      if (focusedOption.name !== '보스') return;

      const guildId = interaction.guildId;
      if (!guildId) {
        await interaction.respond([]);
        return;
      }

      const bosses = await getBosses(guildId);
      const focusedValue = focusedOption.value.toLowerCase();
      const filtered = bosses
        .filter(boss => boss.name.toLowerCase().includes(focusedValue))
        .slice(0, 25)
        .map(boss => ({
          name: boss.name,
          value: boss.name
        }));

      await interaction.respond(filtered);
      return;
    }

    if (interaction.isChatInputCommand()) {
      const guildId = interaction.guildId;
      if (!guildId) {
        await interaction.reply({ content: '서버에서만 사용할 수 있습니다.', ephemeral: true });
        return;
      }

      await ensureGuild(guildId);
      await ensureGuildAssets(guildId);

      if (interaction.commandName === '보스추가') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: '이 명령어는 서버 관리자만 사용할 수 있습니다.', ephemeral: true });
          return;
        }

        const name = interaction.options.getString('이름');
        const timeText = interaction.options.getString('시간');
        const score = interaction.options.getInteger('점수');
        const imageUrl = interaction.options.getString('이미지');

        await addBoss(guildId, name, timeText, score, imageUrl);

        await interaction.reply({
          content:
            `보스 추가 완료\n` +
            `이름: ${name}\n` +
            `시간: ${timeText}\n` +
            `점수: ${score}점`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '보스수정') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: '이 명령어는 서버 관리자만 사용할 수 있습니다.', ephemeral: true });
          return;
        }

        const bossName = interaction.options.getString('기존이름');
        const newName = interaction.options.getString('새이름');
        const newTime = interaction.options.getString('새시간');
        const newScore = interaction.options.getInteger('새점수');
        const newImageUrl = interaction.options.getString('새이미지');

        const updated = await updateBoss(guildId, bossName, {
          newName,
          newTime,
          newScore,
          newImageUrl
        });

        if (!updated) {
          await interaction.reply({ content: '수정할 보스를 찾지 못했습니다.', ephemeral: true });
          return;
        }

        await interaction.reply({
          content:
            `보스 수정 완료\n` +
            `이름: ${updated.name}\n` +
            `시간: ${updated.time_text}\n` +
            `점수: ${updated.score}점`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '보스목록') {
        const bosses = await getBosses(guildId);

        if (bosses.length === 0) {
          await interaction.reply({ content: '등록된 보스가 없습니다.', ephemeral: true });
          return;
        }

        const lines = bosses.map(
          (boss, index) =>
            `${index + 1}. ${boss.name} | 시간: ${boss.time_text} | 점수: ${boss.score}점`
        );

        await interaction.reply({
          content: `등록된 보스 목록\n${lines.join('\n')}`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '참여체크') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: '이 명령어는 서버 관리자만 사용할 수 있습니다.', ephemeral: true });
          return;
        }

        await interaction.deferReply();

        const bossName = interaction.options.getString('보스');
        const password = interaction.options.getString('비밀번호');
        const limitMinutes = interaction.options.getInteger('제한시간');

        const boss = await getBossByName(guildId, bossName);
        if (!boss) {
          await interaction.editReply({ content: '선택한 보스를 찾을 수 없습니다.' });
          return;
        }

        const checkId = `${guildId}-${Date.now()}`;
        const createdAt = Date.now();
        const expiresAt = createdAt + limitMinutes * 60 * 1000;

        const checkPayload = {
          checkId,
          guildId,
          bossName: boss.name,
          password,
          score: boss.score,
          participants: [],
          imageUrl: boss.image_url || null,
          timeText: boss.time_text,
          limitMinutes,
          createdAt,
          expiresAt,
          channelId: interaction.channelId,
          messageId: null
        };

        activeChecks.set(checkId, checkPayload);
        await createParticipationCheck(checkPayload);

        await interaction.editReply({
          embeds: [buildCheckEmbed(checkPayload)],
          components: [buildCheckButtons(checkId, false)]
        });

        const message = await interaction.fetchReply();

        checkPayload.messageId = message.id;
        await updateParticipationCheckMessageId(checkId, message.id);
        return;
      }

      if (interaction.commandName === '늦은참여추가') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: '이 명령어는 서버 관리자만 사용할 수 있습니다.', ephemeral: true });
          return;
        }

        const bossName = interaction.options.getString('보스');
        const targetUser = interaction.options.getUser('유저');

        const foundCheck = await findLatestCheckByBoss(guildId, bossName);
        if (!foundCheck) {
          await interaction.reply({
            content: '해당 보스의 진행 중이거나 최근 참여체크를 찾을 수 없습니다.',
            ephemeral: true
          });
          return;
        }

        const { checkId, checkData } = foundCheck;

        const alreadyJoined = await hasParticipationEntry(checkId, targetUser.id);

        if (alreadyJoined) {
          await interaction.reply({ content: '이미 참여 명단에 등록된 유저입니다.', ephemeral: true });
          return;
        }

        const displayName = await getDisplayNameFromUser(interaction.guild, targetUser);

        await addParticipationEntry(checkId, guildId, targetUser.id, displayName);
        checkData.participants = await getParticipationParticipants(checkId);

        await adjustScore(guildId, targetUser.id, displayName, checkData.score);
        await refreshCheckMessage(checkId);

        await interaction.reply({
          content: `${displayName} 님을 늦은 참여자로 추가했습니다. ${checkData.score}점 적립 완료.`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '점수추가') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: '이 명령어는 서버 관리자만 사용할 수 있습니다.', ephemeral: true });
          return;
        }

        const targetUser = interaction.options.getUser('유저');
        const amount = interaction.options.getInteger('점수');
        const displayName = await getDisplayNameFromUser(interaction.guild, targetUser);

        const newScore = await adjustScore(guildId, targetUser.id, displayName, amount);

        await interaction.reply({
          content: `${displayName} 님에게 ${amount}점을 추가했습니다. 현재 점수: ${newScore}점`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '점수차감') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: '이 명령어는 서버 관리자만 사용할 수 있습니다.', ephemeral: true });
          return;
        }

        const targetUser = interaction.options.getUser('유저');
        const amount = interaction.options.getInteger('점수');
        const displayName = await getDisplayNameFromUser(interaction.guild, targetUser);

        const current = await getScore(guildId, targetUser.id);
        if (!current || Number(current.score) < amount) {
          await interaction.reply({
            content: `${displayName} 님의 점수가 부족합니다.`,
            ephemeral: true
          });
          return;
        }

        const newScore = await adjustScore(guildId, targetUser.id, displayName, -amount);

        await interaction.reply({
          content: `${displayName} 님에게서 ${amount}점을 차감했습니다. 현재 점수: ${newScore}점`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '점수확인') {
        const displayName = getDisplayNameFromInteraction(interaction);
        const current = await getScore(guildId, interaction.user.id);
        const score = current ? Number(current.score) : 0;

        await interaction.reply({
          content: `${displayName} 님의 현재 점수는 ${score}점입니다.`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '점수랭킹') {
        const ranking = await getRanking(guildId);

        if (ranking.length === 0) {
          await interaction.reply({ content: '점수 데이터가 없습니다.', ephemeral: true });
          return;
        }

        const lines = ranking.map(
          (row, index) => `${index + 1}. ${row.user_name} - ${row.score}점`
        );

        await interaction.reply({
          content: `점수 랭킹\n${lines.join('\n')}`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '점수초기화') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: '이 명령어는 서버 관리자만 사용할 수 있습니다.', ephemeral: true });
          return;
        }

        await resetScores(guildId);
        await interaction.reply({ content: '모든 점수를 초기화했습니다.', ephemeral: true });
        return;
      }

      if (interaction.commandName === '서버초기화') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: '이 명령어는 서버 관리자만 사용할 수 있습니다.', ephemeral: true });
          return;
        }

        await deleteGuildData(guildId);
        activeChecks.clear();

        await interaction.reply({
          content: '이 서버의 모든 데이터를 초기화했습니다.',
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '창고아이템추가') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: '이 명령어는 서버 관리자만 사용할 수 있습니다.', ephemeral: true });
          return;
        }

        const itemName = interaction.options.getString('이름');
        const amount = interaction.options.getInteger('수량');
        const memo = interaction.options.getString('내용') || '';
        const actorName = getDisplayNameFromInteraction(interaction);

        const newQuantity = await adjustInventoryItem(guildId, itemName, amount);
        await addInventoryLog(
          guildId,
          'item_add',
          itemName,
          amount,
          memo,
          interaction.user.id,
          actorName
        );

        await interaction.reply({
          content:
            `아이템 추가 완료\n` +
            `아이템: ${itemName}\n` +
            `변동: +${amount}\n` +
            `현재 수량: ${newQuantity}\n` +
            `내용: ${memo || '없음'}`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '창고아이템차감') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: '이 명령어는 서버 관리자만 사용할 수 있습니다.', ephemeral: true });
          return;
        }

        const itemName = interaction.options.getString('이름');
        const amount = interaction.options.getInteger('수량');
        const memo = interaction.options.getString('내용') || '';
        const actorName = getDisplayNameFromInteraction(interaction);
        const current = await getInventoryItem(guildId, itemName);

        if (!current || Number(current.quantity) < amount) {
          await interaction.reply({
            content: '현재 수량이 부족합니다.',
            ephemeral: true
          });
          return;
        }

        const newQuantity = await adjustInventoryItem(guildId, itemName, -amount);
        await addInventoryLog(
          guildId,
          'item_remove',
          itemName,
          -amount,
          memo,
          interaction.user.id,
          actorName
        );

        await interaction.reply({
          content:
            `아이템 차감 완료\n` +
            `아이템: ${itemName}\n` +
            `변동: -${amount}\n` +
            `현재 수량: ${newQuantity}\n` +
            `내용: ${memo || '없음'}`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '창고아이템설정') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: '이 명령어는 서버 관리자만 사용할 수 있습니다.', ephemeral: true });
          return;
        }

        const itemName = interaction.options.getString('이름');
        const amount = interaction.options.getInteger('수량');
        const memo = interaction.options.getString('내용') || '';
        const actorName = getDisplayNameFromInteraction(interaction);
        const current = await getInventoryItem(guildId, itemName);
        const currentQuantity = current ? Number(current.quantity) : 0;
        const diff = amount - currentQuantity;

        if (!current) {
          await query(
            `INSERT INTO inventory_items (guild_id, item_name, quantity)
             VALUES ($1, $2, $3)`,
            [guildId, itemName, amount]
          );
        } else {
          await query(
            `UPDATE inventory_items
             SET quantity = $1, updated_at = NOW()
             WHERE guild_id = $2 AND item_name = $3`,
            [amount, guildId, itemName]
          );

          if (amount === 0) {
            await query(
              `DELETE FROM inventory_items WHERE guild_id = $1 AND item_name = $2`,
              [guildId, itemName]
            );
          }
        }

        await addInventoryLog(
          guildId,
          'item_set',
          itemName,
          diff,
          memo,
          interaction.user.id,
          actorName
        );

        await interaction.reply({
          content:
            `아이템 설정 완료\n` +
            `아이템: ${itemName}\n` +
            `현재 수량: ${amount}\n` +
            `내용: ${memo || '없음'}`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '창고아이템목록') {
        const items = await getInventoryItems(guildId);

        if (items.length === 0) {
          await interaction.reply({ content: '창고에 등록된 아이템이 없습니다.', ephemeral: true });
          return;
        }

        const lines = items.map((item, index) =>
          `${index + 1}. ${item.item_name} - ${item.quantity}개`
        );

        await interaction.reply({
          content: `창고 아이템 목록\n${lines.join('\n')}`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '다이아추가') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: '이 명령어는 서버 관리자만 사용할 수 있습니다.', ephemeral: true });
          return;
        }

        const amount = interaction.options.getInteger('수량');
        const memo = interaction.options.getString('내용') || '';
        const actorName = getDisplayNameFromInteraction(interaction);

        const newDiamonds = await adjustDiamonds(guildId, amount);
        await addInventoryLog(
          guildId,
          'diamond_add',
          null,
          amount,
          memo,
          interaction.user.id,
          actorName
        );

        await interaction.reply({
          content:
            `다이아 추가 완료\n` +
            `변동: +${amount}\n` +
            `현재 다이아: ${newDiamonds}\n` +
            `내용: ${memo || '없음'}`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '다이아차감') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: '이 명령어는 서버 관리자만 사용할 수 있습니다.', ephemeral: true });
          return;
        }

        const amount = interaction.options.getInteger('수량');
        const memo = interaction.options.getString('내용') || '';
        const actorName = getDisplayNameFromInteraction(interaction);
        const current = await getDiamonds(guildId);

        if (current < amount) {
          await interaction.reply({
            content: `현재 다이아가 부족합니다. 현재 ${current}개 보유 중입니다.`,
            ephemeral: true
          });
          return;
        }

        const newDiamonds = await adjustDiamonds(guildId, -amount);
        await addInventoryLog(
          guildId,
          'diamond_remove',
          null,
          -amount,
          memo,
          interaction.user.id,
          actorName
        );

        await interaction.reply({
          content:
            `다이아 차감 완료\n` +
            `변동: -${amount}\n` +
            `현재 다이아: ${newDiamonds}\n` +
            `내용: ${memo || '없음'}`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '다이아설정') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: '이 명령어는 서버 관리자만 사용할 수 있습니다.', ephemeral: true });
          return;
        }

        const amount = interaction.options.getInteger('수량');
        const memo = interaction.options.getString('내용') || '';
        const actorName = getDisplayNameFromInteraction(interaction);

        const newDiamonds = await setDiamonds(guildId, amount);
        await addInventoryLog(
          guildId,
          'diamond_set',
          null,
          amount,
          memo,
          interaction.user.id,
          actorName
        );

        await interaction.reply({
          content:
            `다이아 설정 완료\n` +
            `현재 다이아: ${newDiamonds}\n` +
            `내용: ${memo || '없음'}`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '창고현황') {
        const diamonds = await getDiamonds(guildId);
        const items = await getInventoryItems(guildId);

        let itemText = '등록된 아이템이 없습니다.';
        if (items.length > 0) {
          itemText = items
            .map((item, index) => `${index + 1}. ${item.item_name} - ${item.quantity}개`)
            .join('\n');
        }

        await interaction.reply({
          content:
            `창고 현황\n` +
            `다이아: ${diamonds}\n\n` +
            `아이템 목록\n${itemText}`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '창고기록') {
        const logs = await getInventoryLogs(guildId, 20);

        if (logs.length === 0) {
          await interaction.reply({ content: '창고 기록이 없습니다.', ephemeral: true });
          return;
        }

        const lines = logs.map((log, index) => {
          const target = log.item_name ? `[${log.item_name}]` : '[다이아]';
          return (
            `${index + 1}. ${target} ${getLogTypeLabel(log.log_type)} ${log.change_amount > 0 ? '+' : ''}${log.change_amount}` +
            ` | ${log.actor_name || '알 수 없음'}` +
            ` | ${log.memo || '내용 없음'}` +
            ` | ${formatKoreaDateTime(log.created_at)}`
          );
        });

        const chunks = [];
        let currentChunk = '최근 창고 기록\n';

        for (const line of lines) {
          if ((currentChunk + line + '\n').length > 1800) {
            chunks.push(currentChunk);
            currentChunk = '';
          }
          currentChunk += line + '\n';
        }

        if (currentChunk) chunks.push(currentChunk);

        await interaction.reply({ content: chunks[0], ephemeral: true });

        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp({ content: chunks[i], ephemeral: true });
        }

        return;
      }
    }

    if (interaction.isButton()) {
      const [action, checkId] = interaction.customId.split('|');

      if (action === 'join') {
        const modal = new ModalBuilder()
          .setCustomId(`pwmodal|${checkId}`)
          .setTitle('참여 비밀번호 입력');

        const passwordInput = new TextInputBuilder()
          .setCustomId('password')
          .setLabel('비밀번호를 입력하세요')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        modal.addComponents(
          new ActionRowBuilder().addComponents(passwordInput)
        );

        await interaction.showModal(modal);
        return;
      }

      const checkData = await loadCheckData(checkId);

      if (!checkData) {
        await interaction.reply({
          content: '이 참여체크는 만료되었거나 찾을 수 없습니다.',
          ephemeral: true
        });
        return;
      }

      if (action === 'list') {
        const participants = await getParticipationParticipants(checkId);

        if (participants.length === 0) {
          await interaction.reply({
            content: '아직 참여자가 없습니다.',
            ephemeral: true
          });
          return;
        }

        checkData.participants = participants;

        const text = participants
          .map((user, index) => `${index + 1}. ${user.name}`)
          .join('\n');

        await interaction.reply({
          content: `${checkData.bossName} 참여 명단\n${text}`,
          ephemeral: true
        });
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      const [action, checkId] = interaction.customId.split('|');

      if (action !== 'pwmodal') return;

      await interaction.deferReply({ ephemeral: true });

      const checkData = await loadCheckData(checkId);

      if (!checkData) {
        await interaction.editReply({
          content: '이 참여체크는 만료되었거나 찾을 수 없습니다.'
        });
        return;
      }

      if (isCheckExpired(checkData)) {
        await interaction.editReply({
          content: '참여 시간이 종료되었습니다. 늦은 참여는 관리자에게 요청하세요.'
        });
        return;
      }

      const password = interaction.fields.getTextInputValue('password');

      if (password !== checkData.password) {
        await interaction.editReply({
          content: '비밀번호가 올바르지 않습니다.'
        });
        return;
      }

      const alreadyJoined = await hasParticipationEntry(checkId, interaction.user.id);

      if (alreadyJoined) {
        await interaction.editReply({
          content: '이미 참여했습니다.'
        });
        return;
      }

      const displayName = getDisplayNameFromInteraction(interaction);

      await addParticipationEntry(checkId, interaction.guildId, interaction.user.id, displayName);

      checkData.participants = await getParticipationParticipants(checkId);

      await adjustScore(interaction.guildId, interaction.user.id, displayName, checkData.score);
      await refreshCheckMessage(checkId);

      await interaction.editReply({
        content: `참여 완료! ${checkData.score}점이 적립되었습니다.`
      });
    }
  } catch (error) {
    console.error('오류 발생:', error);

    if (interaction.isRepliable()) {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: '처리 중 오류가 발생했습니다.',
          ephemeral: true
        }).catch(() => {});
      } else {
        await interaction.reply({
          content: '처리 중 오류가 발생했습니다.',
          ephemeral: true
        }).catch(() => {});
      }
    }
  }
});

/* -------------------------- old check cleanup ------------------------- */

setInterval(() => {
  const now = Date.now();
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

  for (const [checkId, checkData] of activeChecks.entries()) {
    if (now - checkData.createdAt > THIRTY_DAYS) {
      activeChecks.delete(checkId);
      console.log(`30일 지난 메모리 참여체크 삭제: ${checkId}`);
    }
  }
}, 60 * 60 * 1000);

/* ------------------- participation check 30days cleanup -------------- */

setInterval(async () => {
  try {
    await query(`
      DELETE FROM participation_checks
      WHERE created_at < NOW() - INTERVAL '30 days'
    `);

    console.log('30일 지난 참여체크 및 참여명단 자동 삭제 완료');
  } catch (error) {
    console.error('참여체크 자동 삭제 실패:', error);
  }
}, 60 * 60 * 1000);

/* ---------------------- inventory log 30days cleanup ------------------ */

setInterval(async () => {
  try {
    await query(`
      DELETE FROM inventory_logs
      WHERE created_at < NOW() - INTERVAL '30 days'
    `);

    console.log('30일 지난 창고 로그 자동 삭제 완료');
  } catch (error) {
    console.error('창고 로그 자동 삭제 실패:', error);
  }
}, 60 * 60 * 1000);

client.login(token);
