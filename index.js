require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  Events
} = require('discord.js');

const token = process.env.TOKEN;
const clientId = process.env.CLIENT_ID;

if (!token) {
  throw new Error('TOKEN이 없습니다.');
}

if (!clientId) {
  throw new Error('CLIENT_ID가 없습니다.');
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const commands = [
  new SlashCommandBuilder()
    .setName('핑')
    .setDescription('봇 응답 속도 확인'),
  new SlashCommandBuilder()
    .setName('봇상태')
    .setDescription('봇 상태 확인')
].map(command => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);

  console.log('슬래시 명령어 등록 중...');

  await rest.put(
    Routes.applicationCommands(clientId),
    { body: commands }
  );

  console.log('슬래시 명령어 등록 완료');
}

client.once(Events.ClientReady, async readyClient => {
  console.log(`봇 로그인 성공: ${readyClient.user.tag}`);

  try {
    await registerCommands();
  } catch (error) {
    console.error('명령어 등록 실패:', error);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === '핑') {
    await interaction.reply(`퐁! ${client.ws.ping}ms`);
    return;
  }

  if (interaction.commandName === '봇상태') {
    await interaction.reply('봇 정상 작동 중');
  }
});

client.login(token);