import { Client, GatewayIntentBits, Interaction, ChannelType, TextChannel, DiscordAPIError, version as discordJsVersion } from 'discord.js';
import { getVoiceConnection, version as discordVoiceVersion, generateDependencyReport } from '@discordjs/voice';
import { deploy } from './deploy';
import { interactionHandlers } from './interactions';
import { handleVoiceStateUpdate, shutdownRecordings } from './voiceStateManager';
import { ensureDirectoryExists } from './utils';
import config from './config';

// Extract config values
const { token, defaultChannel, openaiApiKey, deepgram_token, voiceDebugLogs } = config;

// Validate required tokens
if (!token) {
    console.error('❌ ERROR: No Discord bot token found!');
    process.exit(1);
}

if (!deepgram_token) {
    console.error('❌ WARNING: No Deepgram API token found!');
    console.error('Transcription will not work without a Deepgram API token.');
}

if (!openaiApiKey) {
    console.error('❌ WARNING: No OpenAI API key found!');
    console.error('Summary generation will not work without an OpenAI API key.');
}

// Ensure necessary directories exist
ensureDirectoryExists('./recordings');
ensureDirectoryExists('./transcripts');

const client = new Client({ 
    intents: [
        GatewayIntentBits.GuildVoiceStates, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.Guilds,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ] 
});

client.once('clientReady', () => {
    console.log(`🤖 Bot is ready! Logged in as ${client.user?.tag}`);
    console.log(`🌐 Connected to ${client.guilds.cache.size} servers`);
    console.log(`🧰 Runtime: node ${process.version}, discord.js ${discordJsVersion}, @discordjs/voice ${discordVoiceVersion}`);
    if (voiceDebugLogs) {
        console.log('🎛️ Voice dependency report:\n' + generateDependencyReport());
    }
    client.guilds.cache.forEach(guild => {
        console.log(`   - ${guild.name} (${guild.id})`);
    });
});

client.on('messageCreate', async (message) => {
	if (!message.guild) return;
	if (!client.application?.owner) await client.application?.fetch();

	if (message.content.toLowerCase() === '!deploy' && message.author.id === client.application?.owner?.id) {
		await deploy(message.guild);

        try {
            const webhooks = await message.guild.fetchWebhooks();
            const webhook = webhooks.find(wh => wh.name === "Deepgram");

            const channel = message.guild.channels.cache.find(
                channel => channel && 
                channel.type === ChannelType.GuildText && 
                channel.name === defaultChannel
            ) as TextChannel | null;

            if (webhook) {
                console.log(`Found existing Deepgram webhook ${webhook.id}`);
            } else if (channel && channel instanceof TextChannel) {
                try {
                    const newWebhook = await channel.createWebhook({
                        name: "Deepgram",
                        avatar: "https://www.deepgram.com/favicon.ico"
                    });
                    console.log(`Created Deepgram webhook ${newWebhook.id}`);
                } catch (error) {
                    if (error instanceof DiscordAPIError && error.code === 50013) {
                        console.error('Bot lacks permission to create webhooks. Please ensure the bot has the "Manage Webhooks" permission.');
                        await message.reply('Error: Bot lacks permission to create webhooks. Please ensure the bot has the "Manage Webhooks" permission.');
                    } else {
                        console.error('Error creating webhook:', error);
                        await message.reply('Error creating webhook. Check console for details.');
                    }
                }
            } else {
                console.error(`Could not find channel ${defaultChannel}`);
                await message.reply(`Error: Could not find channel #${defaultChannel}`);
            }
        } catch (error) {
            if (error instanceof DiscordAPIError && error.code === 50013) {
                console.error('Bot lacks permission to fetch webhooks. Please ensure the bot has the "Manage Webhooks" permission.');
                await message.reply('Error: Bot lacks permission to fetch webhooks. Please ensure the bot has the "Manage Webhooks" permission.');
            } else {
                console.error('Error fetching webhooks:', error);
                await message.reply('Error fetching webhooks. Check console for details.');
            }
            return;
        }

		await message.reply('Deployed!');
	}
});

/**
 * The IDs of the users that can be recorded by the bot.
 */
const recordable = new Set<string>();
const recording = new Set<string>();

client.on('interactionCreate', async (interaction: Interaction) => {
	if (!interaction.isChatInputCommand() || !interaction.guildId) {
		return;
	}

	const handler = interactionHandlers.get(interaction.commandName);
	if (voiceDebugLogs) {
		console.log(`[interaction] command=${interaction.commandName} guild=${interaction.guildId} handler=${Boolean(handler)}`);
	}

	try {
		if (handler) {
			const existingConnection = getVoiceConnection(interaction.guildId);
			if (voiceDebugLogs) {
				console.log(`[interaction] existing voice connection=${Boolean(existingConnection)}`);
			}
			
			await handler(interaction, recordable, recording, client, existingConnection);
		} else {
			await interaction.reply('Unknown command');
		}
	} catch (error) {
		console.warn('Error handling interaction:', error);
	}
});

// Handle voice state updates for automatic recording
client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
        await handleVoiceStateUpdate(oldState, newState, client);
    } catch (error) {
        console.error('Error handling voice state update:', error);
    }
});

// One shutdown handler for the process; utterances never install signal listeners.
let shuttingDown = false;
async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutting down: draining audio and delivering transcripts...');
    const deadline = setTimeout(() => {
        console.error('Shutdown deadline reached; exiting.');
        process.exit(1);
    }, 25_000);
    try {
        await shutdownRecordings(client);
        for (const guildId of client.guilds.cache.keys()) {
            const connection = getVoiceConnection(guildId);
            if (connection) connection.destroy();
        }
        await client.destroy();
        clearTimeout(deadline);
        process.exit(0);
    } catch (error) {
        console.error('Graceful shutdown failed:', error);
        clearTimeout(deadline);
        process.exit(1);
    }
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

client.on('error', console.warn);

void client.login(token);
