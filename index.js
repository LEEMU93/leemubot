이무봇 인덱스 백업

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
    CREATE TABLE IF NOT EXISTS participation_checks (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      boss_name TEXT NOT NULL,
      time_text TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 1,
      image_url TEXT,
      password TEXT NOT NULL,
      limit_minutes INTEGER NOT NULL,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      channel_id TEXT,
      message_id TEXT
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS participation_entries (
      id SERIAL PRIMARY KEY,
      check_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      boss_name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      joined_at BIGINT NOT NULL,
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

async function createParticipationCheck(data) {
  await query(
    `INSERT INTO participation_checks (
      id, guild_id, boss_name, time_text, score, image_url, password,
      limit_minutes, created_at, expires_at, channel_id, message_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      data.id,
      data.guildId,
      data.bossName,
      data.timeText,
      data.score,
      data.imageUrl || null,
      data.password,
      data.limitMinutes,
      data.createdAt,
      data.expiresAt,
      data.channelId || null,
      data.messageId || null
    ]
  );
}

async function updateParticipationCheckMessage(checkId, messageId) {
  await query(
    `UPDATE participation_checks
     SET message_id = $1
     WHERE id = $2`,
    [messageId, checkId]
  );
}

async function getParticipationCheck(checkId) {
  const { rows } = await query(
    `SELECT *
     FROM participation_checks
     WHERE id = $1`,
    [checkId]
  );
  return rows[0] || null;
}

async function getLatestParticipationCheckByBoss(guildId, bossName) {
  const { rows } = await query(
    `SELECT *
     FROM participation_checks
     WHERE guild_id = $1 AND boss_name = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [guildId, bossName]
  );
  return rows[0] || null;
}

async function getParticipationEntries(checkId) {
  const { rows } = await query(
    `SELECT user_id, user_name, joined_at
     FROM participation_entries
     WHERE check_id = $1
     ORDER BY joined_at ASC`,
    [checkId]
  );
  return rows;
}

async function hasJoinedParticipation(checkId, userId) {
  const { rows } = await query(
    `SELECT 1
     FROM participation_entries
     WHERE check_id = $1 AND user_id = $2`,
    [checkId, userId]
  );
  return rows.length > 0;
}

async function addParticipationEntry(checkId, guildId, bossName, userId, userName) {
  await query(
    `INSERT INTO participation_entries (
      check_id, guild_id, boss_name, user_id, user_name, joined_at
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (check_id, user_id) DO NOTHING`,
    [checkId, guildId, bossName, userId, userName, Date.now()]
  );
}

async function deleteGuildData(guildId) {
  await query(`DELETE FROM participation_entries WHERE guild_id = $1`, [guildId]);
  await query(`DELETE FROM participation_checks WHERE guild_id = $1`, [guildId]);
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
  return (
    interaction.member?.nickname ||
    interaction.user.globalName ||
    interaction.user.username
  );
}

function isCheckExpired(checkData) {
  return Date.now() > Number(checkData.expiresAt);
}

function formatRemainingMs(ms) {
  if (ms <= 0) return '종료';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}분 ${seconds}초`;
}

function buildCheckButtons(checkId, expired = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`join|${checkId}`)
      .setLabel('참여')
      .setStyle(ButtonStyle.Success)
      .setDisabled(expired),
    new ButtonBuilder()
      .setCustomId(`list|${checkId}`)
      .setLabel('참여 명단')
      .setStyle(ButtonStyle.Primary)
  );
}

function buildCheckEmbed(checkData) {
  const expired = isCheckExpired(checkData);
  const participantCount = checkData.participantCount ?? checkData.participants?.length ?? 0;

  const embed = new EmbedBuilder()
    .setTitle(`참여체크 - ${checkData.bossName}`)
    .setDescription(
      expired
        ? '참여 시간은 종료되었습니다. 참여 명단은 계속 확인할 수 있습니다.'
        : '참여 버튼을 누른 뒤 비밀번호를 입력해야 참여가 인정됩니다.'
    )
    .addFields(
      { name: '출현 시간', value: checkData.timeText, inline: true },
      { name: '점수', value: `${checkData.score}점`, inline: true },
      { name: '현재 참여자', value: `${participantCount}명`, inline: true },
      { name: '참여 제한시간', value: `${checkData.limitMinutes}분`, inline: true },
      {
        name: '남은 시간',
        value: formatRemainingMs(Number(checkData.expiresAt) - Date.now()),
        inline: true
      },
      {
        name: '상태',
        value: expired ? '참여 종료' : '참여 가능',
        inline: true
      }
    );

  if (checkData.imageUrl) {
    embed.setImage(checkData.imageUrl);
  }

  return embed;
}

function rowToCheckData(row) {
  if (!row) return null;

  return {
    guildId: row.guild_id,
    bossName: row.boss_name,
    password: row.password,
    score: Number(row.score),
    imageUrl: row.image_url,
    timeText: row.time_text,
    limitMinutes: Number(row.limit_minutes),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    channelId: row.channel_id,
    messageId: row.message_id
  };
}

async function findLatestCheckByBoss(guildId, bossName) {
  const row = await getLatestParticipationCheckByBoss(guildId, bossName);
  if (!row) return null;

  return {
    checkId: row.id,
    checkData: rowToCheckData(row)
  };
}

async function getCheckDataById(checkId) {
  const memoryData = activeChecks.get(checkId);
  if (memoryData) return memoryData;

  const row = await getParticipationCheck(checkId);
  if (!row) return null;

  const checkData = rowToCheckData(row);
  activeChecks.set(checkId, checkData);
  return checkData;
}

async function refreshCheckMessage(checkId) {
  const checkData = await getCheckDataById(checkId);
  if (!checkData) return;

  const participants = await getParticipationEntries(checkId);
  checkData.participantCount = participants.length;

  try {
    const channel = await client.channels.fetch(checkData.channelId);
    if (!channel || !channel.messages) return;

    const message = await channel.messages.fetch(checkData.messageId);
    await message.edit({
      embeds: [buildCheckEmbed(checkData)],
      components: [buildCheckButtons(checkId, isCheckExpired(checkData))]
    });
  } catch (error) {
    console.error('참여체크 메시지 갱신 실패:', error);
  }
}

/* ----------------------------- slash cmds ----------------------------- */

const commands = [
  new SlashCommandBuilder()
    .setName('핑')
    .setDescription('봇 응답 속도를 확인합니다.'),

  new SlashCommandBuilder()
    .setName('봇상태')
    .setDescription('봇 상태를 확인합니다.'),

  new SlashCommandBuilder()
    .setName('보스추가')
    .setDescription('이 서버에 보스를 추가합니다.')
    .addStringOption(option =>
      option.setName('이름').setDescription('보스 이름').setRequired(true)
    )
    .addStringOption(option =>
      option.setName('시간').setDescription('예: 20:00 / 12:30, 18:30').setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('점수').setDescription('참여 성공 시 지급 점수').setRequired(true)
    )
    .addStringOption(option =>
      option.setName('이미지url').setDescription('보스 이미지 URL (선택)').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('보스수정')
    .setDescription('등록된 보스 정보를 수정합니다.')
    .addStringOption(option =>
      option
        .setName('보스')
        .setDescription('수정할 보스를 선택하세요')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(option =>
      option.setName('새이름').setDescription('새 보스 이름').setRequired(false)
    )
    .addStringOption(option =>
      option.setName('새시간').setDescription('새 시간').setRequired(false)
    )
    .addIntegerOption(option =>
      option.setName('새점수').setDescription('새 점수').setRequired(false)
    )
    .addStringOption(option =>
      option.setName('새이미지url').setDescription('새 이미지 URL').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('보스목록')
    .setDescription('이 서버에 등록된 보스 목록을 봅니다.'),

  new SlashCommandBuilder()
    .setName('참여체크')
    .setDescription('보스를 선택해 참여 체크를 생성합니다.')
    .addStringOption(option =>
      option
        .setName('보스')
        .setDescription('등록된 보스를 선택하세요')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(option =>
      option
        .setName('비밀번호')
        .setDescription('참여자가 입력할 비밀번호')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName('제한시간')
        .setDescription('참여 가능 시간(분)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(180)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('늦은참여추가')
    .setDescription('늦은 참여자를 관리자 권한으로 수동 추가합니다.')
    .addStringOption(option =>
      option
        .setName('보스')
        .setDescription('현재 또는 최근 참여체크 보스')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addUserOption(option =>
      option
        .setName('유저')
        .setDescription('추가할 유저')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('점수추가')
    .setDescription('특정 유저에게 점수를 추가합니다.')
    .addUserOption(option =>
      option
        .setName('유저')
        .setDescription('점수를 추가할 유저')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName('점수')
        .setDescription('추가할 점수')
        .setRequired(true)
        .setMinValue(1)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('점수차감')
    .setDescription('특정 유저의 점수를 차감합니다.')
    .addUserOption(option =>
      option
        .setName('유저')
        .setDescription('점수를 차감할 유저')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName('점수')
        .setDescription('차감할 점수')
        .setRequired(true)
        .setMinValue(1)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('내점수')
    .setDescription('내 현재 점수를 확인합니다.'),

  new SlashCommandBuilder()
    .setName('순위')
    .setDescription('이 서버 점수 순위를 확인합니다.'),

  new SlashCommandBuilder()
    .setName('점수초기화')
    .setDescription('이 서버 점수를 초기화합니다.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
].map(command => command.toJSON());

async function registerCommandsForGuild(guildId) {
  const rest = new REST({ version: '10' }).setToken(token);

  await rest.put(
    Routes.applicationGuildCommands(clientId, guildId),
    { body: commands }
  );

  console.log(`명령어 등록 완료: guild ${guildId}`);
}

async function registerGuildCommands() {
  const guilds = client.guilds.cache.map(guild => guild.id);

  console.log('슬래시 명령어 등록 중...');

  for (const guildId of guilds) {
    await ensureGuild(guildId);
    await registerCommandsForGuild(guildId);
  }

  console.log('전체 서버 명령어 등록 완료');
}

/* ------------------------------- events ------------------------------- */

client.once(Events.ClientReady, async readyClient => {
  console.log(`봇 로그인 성공: ${readyClient.user.tag}`);

  try {
    await initDatabase();
    await registerGuildCommands();
  } catch (error) {
    console.error('초기화 실패:', error);
  }
});

client.on(Events.GuildCreate, async guild => {
  try {
    await ensureGuild(guild.id);
    await registerCommandsForGuild(guild.id);
    console.log(`새 서버 명령어 자동 등록 완료: ${guild.name}`);
  } catch (error) {
    console.error('새 서버 명령어 등록 실패:', error);
  }
});

client.on(Events.GuildDelete, async guild => {
  try {
    for (const [checkId, checkData] of activeChecks.entries()) {
      if (checkData.guildId === guild.id) {
        activeChecks.delete(checkId);
      }
    }

    await deleteGuildData(guild.id);

    console.log(`서버 제거 감지: ${guild.name} (${guild.id})`);
    console.log(`해당 서버 데이터 자동 삭제 완료`);
  } catch (error) {
    console.error('서버 삭제 자동 정리 실패:', error);
  }
});

/* ---------------------------- interactions ---------------------------- */

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isAutocomplete()) {
      const focused = interaction.options.getFocused();
      const guildId = interaction.guildId;

      const bosses = await getBosses(guildId);

      const result = bosses
        .filter(boss => boss.name.includes(focused))
        .slice(0, 25)
        .map(boss => ({
          name: boss.name,
          value: boss.name
        }));

      await interaction.respond(result);
      return;
    }

    if (interaction.isChatInputCommand()) {
      const guildId = interaction.guildId;
      await ensureGuild(guildId);

      if (interaction.commandName === '핑') {
        await interaction.reply(`퐁! ${client.ws.ping}ms`);
        return;
      }

      if (interaction.commandName === '봇상태') {
        await interaction.reply('PostgreSQL 연결 버전 정상 작동 중입니다.');
        return;
      }

      if (interaction.commandName === '보스추가') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: '이 명령어는 서버 관리자만 사용할 수 있습니다.', ephemeral: true });
          return;
        }

        const name = interaction.options.getString('이름');
        const timeText = interaction.options.getString('시간');
        const score = interaction.options.getInteger('점수');
        const imageUrl = interaction.options.getString('이미지url');

        const exists = await getBossByName(guildId, name);
        if (exists) {
          await interaction.reply({ content: '같은 이름의 보스가 이미 등록되어 있습니다.', ephemeral: true });
          return;
        }

        await addBoss(guildId, name, timeText, score, imageUrl);

        await interaction.reply({
          content: `보스 등록 완료\n이름: ${name}\n시간: ${timeText}\n점수: ${score}점`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '보스수정') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: '이 명령어는 서버 관리자만 사용할 수 있습니다.', ephemeral: true });
          return;
        }

        const bossName = interaction.options.getString('보스');
        const newName = interaction.options.getString('새이름');
        const newTime = interaction.options.getString('새시간');
        const newScore = interaction.options.getInteger('새점수');
        const newImageUrl = interaction.options.getString('새이미지url');

        if (!newName && !newTime && newScore === null && !newImageUrl) {
          await interaction.reply({ content: '수정할 항목을 하나 이상 입력해야 합니다.', ephemeral: true });
          return;
        }

        const current = await getBossByName(guildId, bossName);
        if (!current) {
          await interaction.reply({ content: '수정할 보스를 찾을 수 없습니다.', ephemeral: true });
          return;
        }

        if (newName && newName !== bossName) {
          const duplicate = await getBossByName(guildId, newName);
          if (duplicate) {
            await interaction.reply({ content: '같은 이름의 다른 보스가 이미 등록되어 있습니다.', ephemeral: true });
            return;
          }
        }

        const updated = await updateBoss(guildId, bossName, {
          newName,
          newTime,
          newScore,
          newImageUrl
        });

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

        const bossName = interaction.options.getString('보스');
        const password = interaction.options.getString('비밀번호');
        const limitMinutes = interaction.options.getInteger('제한시간');

        const boss = await getBossByName(guildId, bossName);
        if (!boss) {
          await interaction.reply({ content: '선택한 보스를 찾을 수 없습니다.', ephemeral: true });
          return;
        }

        const checkId = `${guildId}-${Date.now()}`;
        const createdAt = Date.now();
        const expiresAt = createdAt + limitMinutes * 60 * 1000;

        const newCheckData = {
          id: checkId,
          guildId,
          bossName: boss.name,
          password,
          score: Number(boss.score),
          participants: [],
          imageUrl: boss.image_url || null,
          timeText: boss.time_text,
          limitMinutes,
          createdAt,
          expiresAt,
          channelId: interaction.channelId,
          messageId: null
        };

        activeChecks.set(checkId, newCheckData);
        await createParticipationCheck(newCheckData);

        const checkData = activeChecks.get(checkId);

        const message = await interaction.reply({
          embeds: [buildCheckEmbed(checkData)],
          components: [buildCheckButtons(checkId, false)],
          fetchReply: true
        });

        checkData.messageId = message.id;
        await updateParticipationCheckMessage(checkId, message.id);
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

        const alreadyJoined = await hasJoinedParticipation(checkId, targetUser.id);

        if (alreadyJoined) {
          await interaction.reply({ content: '이미 참여 명단에 등록된 유저입니다.', ephemeral: true });
          return;
        }

        const displayName = await getDisplayNameFromUser(interaction.guild, targetUser);

        await addParticipationEntry(checkId, guildId, checkData.bossName, targetUser.id, displayName);
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

        const newScore = await adjustScore(guildId, targetUser.id, displayName, -amount);

        await interaction.reply({
          content: `${displayName} 님의 점수를 ${amount}점 차감했습니다. 현재 점수: ${newScore}점`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '내점수') {
        const scoreData = await getScore(guildId, interaction.user.id);
        const score = scoreData ? scoreData.score : 0;

        await interaction.reply({
          content: `${interaction.user.username} 님의 현재 점수는 ${score}점입니다.`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '순위') {
        const rankingRows = await getRanking(guildId);

        if (rankingRows.length === 0) {
          await interaction.reply({ content: '아직 점수 데이터가 없습니다.', ephemeral: true });
          return;
        }

        const lines = rankingRows.map(
          (row, index) => `${index + 1}위 ${row.user_name} - ${row.score}점`
        );

        const chunks = [];
        let currentChunk = '서버 순위\n';

        for (const line of lines) {
          if ((currentChunk + line + '\n').length > 1800) {
            chunks.push(currentChunk);
            currentChunk = '';
          }
          currentChunk += line + '\n';
        }

        if (currentChunk) chunks.push(currentChunk);

        await interaction.reply({ content: chunks[0] });

        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp({ content: chunks[i] });
        }

        return;
      }

      if (interaction.commandName === '점수초기화') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: '이 명령어는 서버 관리자만 사용할 수 있습니다.', ephemeral: true });
          return;
        }

        await resetScores(guildId);

        await interaction.reply({
          content: '이 서버의 점수를 전부 초기화했습니다.',
          ephemeral: true
        });
        return;
      }
    }

    if (interaction.isButton()) {
      const [action, checkId] = interaction.customId.split('|');
      const checkData = await getCheckDataById(checkId);

      if (!checkData) {
        await interaction.reply({
          content: '이 참여체크를 찾을 수 없습니다.',
          ephemeral: true
        });
        return;
      }

      if (action === 'join') {
        if (isCheckExpired(checkData)) {
          await interaction.reply({
            content: '참여 시간이 종료되었습니다. 늦은 참여는 관리자에게 요청하세요.',
            ephemeral: true
          });
          return;
        }

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

      if (action === 'list') {
        const entries = await getParticipationEntries(checkId);

        if (entries.length === 0) {
          await interaction.reply({
            content: '아직 참여자가 없습니다.',
            ephemeral: true
          });
          return;
        }

        const text = entries
          .map((user, index) => `${index + 1}. ${user.user_name}`)
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

      const checkData = await getCheckDataById(checkId);

      if (!checkData) {
        await interaction.reply({
          content: '이 참여체크를 찾을 수 없습니다.',
          ephemeral: true
        });
        return;
      }

      if (isCheckExpired(checkData)) {
        await interaction.reply({
          content: '참여 시간이 종료되었습니다. 늦은 참여는 관리자에게 요청하세요.',
          ephemeral: true
        });
        return;
      }

      const password = interaction.fields.getTextInputValue('password');

      if (password !== checkData.password) {
        await interaction.reply({
          content: '비밀번호가 올바르지 않습니다.',
          ephemeral: true
        });
        return;
      }

      const alreadyJoined = await hasJoinedParticipation(checkId, interaction.user.id);

      if (alreadyJoined) {
        await interaction.reply({
          content: '이미 참여했습니다.',
          ephemeral: true
        });
        return;
      }

      const displayName = getDisplayNameFromInteraction(interaction);

      await addParticipationEntry(
        checkId,
        interaction.guildId,
        checkData.bossName,
        interaction.user.id,
        displayName
      );

      await adjustScore(interaction.guildId, interaction.user.id, displayName, checkData.score);
      await refreshCheckMessage(checkId);

      await interaction.reply({
        content: `참여 완료! ${checkData.score}점이 적립되었습니다.`,
        ephemeral: true
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

client.login(token);