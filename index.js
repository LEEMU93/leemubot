require('dotenv').config();

const fs = require('fs');
const path = require('path');
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

const token = process.env.TOKEN;
const clientId = process.env.CLIENT_ID;

if (!token) throw new Error('TOKEN이 없습니다.');
if (!clientId) throw new Error('CLIENT_ID가 없습니다.');

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const dataPath = path.join(__dirname, 'data.json');
const activeChecks = new Map();

function ensureDataFile() {
  if (!fs.existsSync(dataPath)) {
    const initialData = {
      guilds: {}
    };
    fs.writeFileSync(dataPath, JSON.stringify(initialData, null, 2), 'utf8');
  }
}

function loadData() {
  ensureDataFile();
  const raw = fs.readFileSync(dataPath, 'utf8');
  return JSON.parse(raw || '{"guilds":{}}');
}

function saveData(data) {
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8');
}

function ensureGuildData(guildId) {
  const data = loadData();

  if (!data.guilds[guildId]) {
    data.guilds[guildId] = {
      bosses: [],
      scores: {}
    };
    saveData(data);
  }

  return data;
}

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

function getDisplayNameFromInteraction(interaction) {
  return (
    interaction.member?.nickname ||
    interaction.user.globalName ||
    interaction.user.username
  );
}

function getDisplayNameFromUser(guild, user) {
  const member = guild.members.cache.get(user.id);
  return member?.nickname || user.globalName || user.username;
}

function formatRemainingMs(ms) {
  if (ms <= 0) return '종료';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}분 ${seconds}초`;
}

function isCheckExpired(checkData) {
  return Date.now() > checkData.expiresAt;
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

  const embed = new EmbedBuilder()
    .setTitle(`참여체크 - ${checkData.bossName}`)
    .setDescription(
      expired
        ? '참여 시간이 종료되었습니다. 늦은 참여자는 관리자가 수동으로 추가할 수 있습니다.'
        : '참여 버튼을 누른 뒤 비밀번호를 입력해야 참여가 인정됩니다.'
    )
    .addFields(
      { name: '출현 시간', value: checkData.timeText, inline: true },
      { name: '점수', value: `${checkData.score}점`, inline: true },
      { name: '현재 참여자', value: `${checkData.participants.length}명`, inline: true },
      { name: '참여 제한시간', value: `${checkData.limitMinutes}분`, inline: true },
      {
        name: '남은 시간',
        value: formatRemainingMs(checkData.expiresAt - Date.now()),
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

function awardScore(guildId, userId, userName, amount) {
  const data = ensureGuildData(guildId);
  const guildScores = data.guilds[guildId].scores;

  if (guildScores[userId]) {
    guildScores[userId].score += amount;
    guildScores[userId].userName = userName;
  } else {
    guildScores[userId] = {
      userId,
      userName,
      score: amount
    };
  }

  saveData(data);
}

function adjustScore(guildId, userId, userName, amount) {
  const data = ensureGuildData(guildId);
  const guildScores = data.guilds[guildId].scores;

  if (!guildScores[userId]) {
    guildScores[userId] = {
      userId,
      userName,
      score: 0
    };
  }

  guildScores[userId].userName = userName;
  guildScores[userId].score += amount;

  if (guildScores[userId].score < 0) {
    guildScores[userId].score = 0;
  }

  saveData(data);

  return guildScores[userId].score;
}

function findLatestCheckByBoss(guildId, bossName) {
  let matched = null;

  for (const [checkId, checkData] of activeChecks.entries()) {
    if (checkData.guildId === guildId && checkData.bossName === bossName) {
      if (!matched || checkData.createdAt > matched.checkData.createdAt) {
        matched = { checkId, checkData };
      }
    }
  }

  return matched;
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
    ensureDataFile();
    console.log('JSON 데이터 파일 준비 완료');
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
      const data = ensureGuildData(guildId);

      const bosses = data.guilds[guildId].bosses
        .filter(boss => boss.name.includes(focused))
        .slice(0, 25)
        .map(boss => ({
          name: boss.name,
          value: boss.name
        }));

      await interaction.respond(bosses);
      return;
    }

    if (interaction.isChatInputCommand()) {
      const guildId = interaction.guildId;
      let data = ensureGuildData(guildId);

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

        const exists = data.guilds[guildId].bosses.some(boss => boss.name === name);

        if (exists) {
          await interaction.reply({
            content: '같은 이름의 보스가 이미 등록되어 있습니다.',
            ephemeral: true
          });
          return;
        }

        data.guilds[guildId].bosses.push({
          name,
          timeText,
          score,
          imageUrl: imageUrl || null
        });

        saveData(data);

        await interaction.reply({
          content: `보스 등록 완료\n이름: ${name}\n시간: ${timeText}\n점수: ${score}점`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '보스수정') {
        if (!isAdmin(interaction)) {
          await interaction.reply({
            content: '이 명령어는 서버 관리자만 사용할 수 있습니다.',
            ephemeral: true
          });
          return;
        }

        const bossName = interaction.options.getString('보스');
        const newName = interaction.options.getString('새이름');
        const newTime = interaction.options.getString('새시간');
        const newScore = interaction.options.getInteger('새점수');
        const newImageUrl = interaction.options.getString('새이미지url');

        if (!newName && !newTime && newScore === null && !newImageUrl) {
          await interaction.reply({
            content: '수정할 항목을 하나 이상 입력해야 합니다.',
            ephemeral: true
          });
          return;
        }

        const targetBoss = data.guilds[guildId].bosses.find(boss => boss.name === bossName);

        if (!targetBoss) {
          await interaction.reply({
            content: '수정할 보스를 찾을 수 없습니다.',
            ephemeral: true
          });
          return;
        }

        if (newName) {
          const duplicate = data.guilds[guildId].bosses.some(
            boss => boss.name === newName && boss.name !== bossName
          );

          if (duplicate) {
            await interaction.reply({
              content: '같은 이름의 다른 보스가 이미 등록되어 있습니다.',
              ephemeral: true
            });
            return;
          }

          targetBoss.name = newName;
        }

        if (newTime) targetBoss.timeText = newTime;
        if (newScore !== null) targetBoss.score = newScore;
        if (newImageUrl) targetBoss.imageUrl = newImageUrl;

        saveData(data);

        await interaction.reply({
          content:
            `보스 수정 완료\n` +
            `이름: ${targetBoss.name}\n` +
            `시간: ${targetBoss.timeText}\n` +
            `점수: ${targetBoss.score}점`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '보스목록') {
        const bosses = data.guilds[guildId].bosses;

        if (bosses.length === 0) {
          await interaction.reply({
            content: '등록된 보스가 없습니다.',
            ephemeral: true
          });
          return;
        }

        const lines = bosses.map(
          (boss, index) =>
            `${index + 1}. ${boss.name} | 시간: ${boss.timeText} | 점수: ${boss.score}점`
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
        const limitMinutes = interaction.options.getInteger('제한시간');

        const boss = data.guilds[guildId].bosses.find(b => b.name === bossName);

        if (!boss) {
          await interaction.reply({
            content: '선택한 보스를 찾을 수 없습니다.',
            ephemeral: true
          });
          return;
        }

        const checkId = `${guildId}-${Date.now()}`;
        const createdAt = Date.now();
        const expiresAt = createdAt + limitMinutes * 60 * 1000;

        activeChecks.set(checkId, {
          guildId,
          bossName: boss.name,
          password,
          score: boss.score,
          participants: [],
          imageUrl: boss.imageUrl || null,
          timeText: boss.timeText,
          limitMinutes,
          createdAt,
          expiresAt
        });

        const checkData = activeChecks.get(checkId);

        await interaction.reply({
          embeds: [buildCheckEmbed(checkData)],
          components: [buildCheckButtons(checkId, false)]
        });
        return;
      }

      if (interaction.commandName === '늦은참여추가') {
        if (!isAdmin(interaction)) {
          await interaction.reply({
            content: '이 명령어는 서버 관리자만 사용할 수 있습니다.',
            ephemeral: true
          });
          return;
        }

        const bossName = interaction.options.getString('보스');
        const targetUser = interaction.options.getUser('유저');

        const foundCheck = findLatestCheckByBoss(guildId, bossName);

        if (!foundCheck) {
          await interaction.reply({
            content: '해당 보스의 진행 중이거나 최근 참여체크를 찾을 수 없습니다.',
            ephemeral: true
          });
          return;
        }

        const { checkData } = foundCheck;

        const alreadyJoined = checkData.participants.some(
          participant => participant.id === targetUser.id
        );

        if (alreadyJoined) {
          await interaction.reply({
            content: '이미 참여 명단에 등록된 유저입니다.',
            ephemeral: true
          });
          return;
        }

        const displayName = getDisplayNameFromUser(interaction.guild, targetUser);

        checkData.participants.push({
          id: targetUser.id,
          name: displayName
        });

        awardScore(guildId, targetUser.id, displayName, checkData.score);

        await interaction.reply({
          content: `${displayName} 님을 늦은 참여자로 추가했습니다. ${checkData.score}점 적립 완료.`,
          ephemeral: true
        });

        return;
      }

      if (interaction.commandName === '점수추가') {
        if (!isAdmin(interaction)) {
          await interaction.reply({
            content: '이 명령어는 서버 관리자만 사용할 수 있습니다.',
            ephemeral: true
          });
          return;
        }

        const targetUser = interaction.options.getUser('유저');
        const amount = interaction.options.getInteger('점수');
        const displayName = getDisplayNameFromUser(interaction.guild, targetUser);

        const newScore = adjustScore(guildId, targetUser.id, displayName, amount);

        await interaction.reply({
          content: `${displayName} 님에게 ${amount}점을 추가했습니다. 현재 점수: ${newScore}점`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '점수차감') {
        if (!isAdmin(interaction)) {
          await interaction.reply({
            content: '이 명령어는 서버 관리자만 사용할 수 있습니다.',
            ephemeral: true
          });
          return;
        }

        const targetUser = interaction.options.getUser('유저');
        const amount = interaction.options.getInteger('점수');
        const displayName = getDisplayNameFromUser(interaction.guild, targetUser);

        const newScore = adjustScore(guildId, targetUser.id, displayName, -amount);

        await interaction.reply({
          content: `${displayName} 님의 점수를 ${amount}점 차감했습니다. 현재 점수: ${newScore}점`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '내점수') {
        const scoreData = data.guilds[guildId].scores[interaction.user.id];
        const score = scoreData ? scoreData.score : 0;

        await interaction.reply({
          content: `${interaction.user.username} 님의 현재 점수는 ${score}점입니다.`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === '순위') {
        const scoreEntries = Object.values(data.guilds[guildId].scores);

        if (scoreEntries.length === 0) {
          await interaction.reply({
            content: '아직 점수 데이터가 없습니다.',
            ephemeral: true
          });
          return;
        }

        const ranking = scoreEntries
          .sort((a, b) => b.score - a.score || a.userName.localeCompare(b.userName))
          .slice(0, 10)
          .map((row, index) => `${index + 1}위 ${row.userName} - ${row.score}점`)
          .join('\n');

        await interaction.reply({
          content: `서버 순위\n${ranking}`
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

        data.guilds[guildId].scores = {};
        saveData(data);

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

      const displayName = getDisplayNameFromInteraction(interaction);

      checkData.participants.push({
        id: interaction.user.id,
        name: displayName
      });

      awardScore(interaction.guildId, interaction.user.id, displayName, checkData.score);

      await interaction.update({
        embeds: [buildCheckEmbed(checkData)],
        components: [buildCheckButtons(checkId, isCheckExpired(checkData))]
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