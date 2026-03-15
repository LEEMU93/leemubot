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
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const token = process.env.TOKEN;
const clientId = process.env.CLIENT_ID;

if (!token) throw new Error('TOKEN이 없습니다.');
if (!clientId) throw new Error('CLIENT_ID가 없습니다.');

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const dbPath = path.join(__dirname, 'botdata.db');
const db = new sqlite3.Database(dbPath);

const activeChecks = new Map();

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function initDatabase() {
  await run(`
    CREATE TABLE IF NOT EXISTS bosses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      time_text TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 1,
      image_url TEXT,
      UNIQUE(guild_id, name)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      UNIQUE(guild_id, user_id)
    )
  `);

  console.log('DB 초기화 완료');
}

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

function buildCheckButtons(checkId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`join|${checkId}`)
      .setLabel('참여')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`list|${checkId}`)
      .setLabel('참여 명단')
      .setStyle(ButtonStyle.Primary)
  );
}

const commands = [
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
  try {
    if (interaction.isAutocomplete()) {
      const focused = interaction.options.getFocused();
      const guildId = interaction.guildId;

      const bosses = await all(
        `SELECT name FROM bosses
         WHERE guild_id = ?
         AND name LIKE ?
         ORDER BY name ASC
         LIMIT 25`,
        [guildId, `%${focused}%`]
      );

      await interaction.respond(
        bosses.map(boss => ({
          name: boss.name,
          value: boss.name
        }))
      );
      return;
    }

    if (interaction.isChatInputCommand()) {
      const guildId = interaction.guildId;

      if (interaction.commandName === '보스추가') {
        if (!isAdmin(interaction)) {
          await interaction.reply({
            content: '이 명령어는 서버 관리자만 사용할 수 있습니다.',
            ephemeral: true
          });
          return;
        }

        const name = interaction.options.getString('이름');
        const timeText = interaction.options.getString('시간');
        const score = interaction.options.getInteger('점수');
        const imageUrl = interaction.options.getString('이미지url');

        try {
          await run(
            `INSERT INTO bosses (guild_id, name, time_text, score, image_url)
             VALUES (?, ?, ?, ?, ?)`,
            [guildId, name, timeText, score, imageUrl || null]
          );

          await interaction.reply({
            content: `보스 등록 완료\n이름: ${name}\n시간: ${timeText}\n점수: ${score}점`,
            ephemeral: true
          });
        } catch (error) {
          if (String(error.message).includes('UNIQUE')) {
            await interaction.reply({
              content: '같은 이름의 보스가 이미 등록되어 있습니다.',
              ephemeral: true
            });
          } else {
            throw error;
          }
        }
        return;
      }

      if (interaction.commandName === '보스목록') {
        const bosses = await all(
          `SELECT name, time_text, score FROM bosses
           WHERE guild_id = ?
           ORDER BY name ASC`,
          [guildId]
        );

        if (bosses.length === 0) {
          await interaction.reply({
            content: '등록된 보스가 없습니다.',
            ephemeral: true
          });
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
          await interaction.reply({
            content: '이 명령어는 서버 관리자만 사용할 수 있습니다.',
            ephemeral: true
          });
          return;
        }

        const bossName = interaction.options.getString('보스');
        const password = interaction.options.getString('비밀번호');

        const boss = await get(
          `SELECT name, time_text, score, image_url
           FROM bosses
           WHERE guild_id = ? AND name = ?`,
          [guildId, bossName]
        );

        if (!boss) {
          await interaction.reply({
            content: '선택한 보스를 찾을 수 없습니다.',
            ephemeral: true
          });
          return;
        }

        const checkId = `${guildId}-${Date.now()}`;

        activeChecks.set(checkId, {
          guildId,
          bossName: boss.name,
          password,
          score: boss.score,
          participants: [],
          imageUrl: boss.image_url || null,
          timeText: boss.time_text
        });

        const embed = new EmbedBuilder()
          .setTitle(`참여체크 - ${boss.name}`)
          .setDescription('참여 버튼을 누른 뒤 비밀번호를 입력해야 참여가 인정됩니다.')
          .addFields(
            { name: '출현 시간', value: boss.time_text, inline: true },
            { name: '점수', value: `${boss.score}점`, inline: true },
            { name: '현재 참여자', value: '0명', inline: true }
          );

        if (boss.image_url) {
          embed.setImage(boss.image_url);
        }

        await interaction.reply({
          embeds: [embed],
          components: [buildCheckButtons(checkId)]
        });
        return;
      }

      if (interaction.commandName === '내점수') {
        const row = await get(
          `SELECT score FROM scores
           WHERE guild_id = ? AND user_id = ?`,
          [guildId, interaction.user.id]
        );

        const score = row ? row.score : 0;

        await interaction.reply({
          content: `${interaction.user.username} 님의 현재 점수는 ${score}점입니다.`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '순위') {
        const rows = await all(
          `SELECT user_name, score
           FROM scores
           WHERE guild_id = ?
           ORDER BY score DESC, user_name ASC
           LIMIT 10`,
          [guildId]
        );

        if (rows.length === 0) {
          await interaction.reply({
            content: '아직 점수 데이터가 없습니다.',
            ephemeral: true
          });
          return;
        }

        const text = rows
          .map((row, index) => `${index + 1}위 ${row.user_name} - ${row.score}점`)
          .join('\n');

        await interaction.reply({
          content: `서버 순위\n${text}`
        });
        return;
      }

      if (interaction.commandName === '점수초기화') {
        if (!isAdmin(interaction)) {
          await interaction.reply({
            content: '이 명령어는 서버 관리자만 사용할 수 있습니다.',
            ephemeral: true
          });
          return;
        }

        await run(`DELETE FROM scores WHERE guild_id = ?`, [guildId]);

        await interaction.reply({
          content: '이 서버의 점수를 전부 초기화했습니다.',
          ephemeral: true
        });
        return;
      }
    }

    if (interaction.isButton()) {
      const [action, checkId] = interaction.customId.split('|');
      const checkData = activeChecks.get(checkId);

      if (!checkData) {
        await interaction.reply({
          content: '이 참여체크는 만료되었거나 찾을 수 없습니다.',
          ephemeral: true
        });
        return;
      }

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

      if (action === 'list') {
        if (checkData.participants.length === 0) {
          await interaction.reply({
            content: '아직 참여자가 없습니다.',
            ephemeral: true
          });
          return;
        }

        const text = checkData.participants
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

      const checkData = activeChecks.get(checkId);

      if (!checkData) {
        await interaction.reply({
          content: '이 참여체크는 만료되었거나 찾을 수 없습니다.',
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

      const alreadyJoined = checkData.participants.some(
        participant => participant.id === interaction.user.id
      );

      if (alreadyJoined) {
        await interaction.reply({
          content: '이미 참여했습니다.',
          ephemeral: true
        });
        return;
      }

      const displayName =
        interaction.member?.nickname ||
        interaction.user.globalName ||
        interaction.user.username;

      checkData.participants.push({
        id: interaction.user.id,
        name: displayName
      });

      const existingScore = await get(
        `SELECT score FROM scores
         WHERE guild_id = ? AND user_id = ?`,
        [interaction.guildId, interaction.user.id]
      );

      if (existingScore) {
        await run(
          `UPDATE scores
           SET score = ?, user_name = ?
           WHERE guild_id = ? AND user_id = ?`,
          [
            existingScore.score + checkData.score,
            displayName,
            interaction.guildId,
            interaction.user.id
          ]
        );
      } else {
        await run(
          `INSERT INTO scores (guild_id, user_id, user_name, score)
           VALUES (?, ?, ?, ?)`,
          [interaction.guildId, interaction.user.id, displayName, checkData.score]
        );
      }

      const updatedEmbed = new EmbedBuilder()
        .setTitle(`참여체크 - ${checkData.bossName}`)
        .setDescription('참여 버튼을 누른 뒤 비밀번호를 입력해야 참여가 인정됩니다.')
        .addFields(
          { name: '출현 시간', value: checkData.timeText, inline: true },
          { name: '점수', value: `${checkData.score}점`, inline: true },
          { name: '현재 참여자', value: `${checkData.participants.length}명`, inline: true }
        );

      if (checkData.imageUrl) {
        updatedEmbed.setImage(checkData.imageUrl);
      }

      await interaction.update({
        embeds: [updatedEmbed],
        components: [buildCheckButtons(checkId)]
      });

      await interaction.followUp({
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

client.login(token);