import { DiscordGatewayAdapterCreator, entersState, joinVoiceChannel, VoiceConnection, VoiceConnectionStatus, getVoiceConnection } from '@discordjs/voice';
import { Client, ChatInputCommandInteraction, GuildMember, Snowflake } from 'discord.js';
import { discardRecording, isRecording, stopRecording, startManualRecording } from './voiceStateManager';
import config from './config';

const { voiceDebugLogs } = config;

async function createReadyConnection(
	channel: NonNullable<GuildMember['voice']['channel']>,
	context: string
): Promise<VoiceConnection> {
	let lastError: unknown = null;
	const startedAt = Date.now();

	for (let attempt = 1; attempt <= 2; attempt++) {
		const existing = getVoiceConnection(channel.guild.id);
		if (existing && existing.state.status !== VoiceConnectionStatus.Destroyed) {
			console.log(`[${context}] Destroying existing ${existing.state.status} connection before attempt ${attempt}/2`);
			existing.destroy();
		}

		const nextConnection = joinVoiceChannel({
			channelId: channel.id,
			guildId: channel.guild.id,
			selfDeaf: false,
			selfMute: true,
			adapterCreator: channel.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
			debug: Boolean(voiceDebugLogs),
		});

		console.log(`[${context}] Join attempt ${attempt}/2 started for channel ${channel.name} (${channel.id})`);

		const stateLogger = (
			oldState: { status: VoiceConnectionStatus; reason?: number; closeCode?: number },
			newState: { status: VoiceConnectionStatus; reason?: number; closeCode?: number }
		) => {
			if (!voiceDebugLogs) return;
			const elapsedMs = Date.now() - startedAt;
			const details = newState.status === VoiceConnectionStatus.Disconnected
				? ` reason=${newState.reason ?? 'n/a'} closeCode=${newState.closeCode ?? 'n/a'}`
				: '';
			console.log(`[${context}] state ${oldState.status} -> ${newState.status}${details} (+${elapsedMs}ms)`);

			// Attach once to internal networking close event so we can see the exact WS close code.
			const networking = (newState as unknown as { networking?: { on: (event: string, cb: (code: number) => void) => void; __closeHooked?: boolean } }).networking;
			if (networking && !networking.__closeHooked) {
				networking.__closeHooked = true;
				networking.on('close', (code: number) => {
					console.error(`[${context}] networking close code: ${code}`);
				});
			}
		};
		const errorLogger = (error: Error) => {
			const elapsedMs = Date.now() - startedAt;
			console.error(`[${context}] connection error (+${elapsedMs}ms): ${error.name}: ${error.message}`);
		};
		const debugLogger = (message: string) => {
			if (!voiceDebugLogs) return;
			const elapsedMs = Date.now() - startedAt;
			console.log(`[${context}] voice debug (+${elapsedMs}ms): ${message}`);
		};
		nextConnection.on('stateChange', stateLogger);
		nextConnection.on('error', errorLogger);
		nextConnection.on('debug', debugLogger);

		try {
			await entersState(nextConnection, VoiceConnectionStatus.Ready, 20e3);
			console.log(`[${context}] Voice connection is ready`);
			return nextConnection;
		} catch (error) {
			lastError = error;
			console.error(`[${context}] Join attempt ${attempt}/2 failed:`, error);
			console.error(
				`[${context}] Snapshot after failed attempt ${attempt}/2: localState=${nextConnection.state.status}, trackedState=${getVoiceConnection(channel.guild.id)?.state.status ?? 'none'}`
			);
			if (nextConnection.state.status !== VoiceConnectionStatus.Destroyed) {
				nextConnection.destroy();
			}
			if (attempt < 2) {
				await new Promise(resolve => setTimeout(resolve, 1000));
			}
		} finally {
			nextConnection.off('stateChange', stateLogger);
			nextConnection.off('error', errorLogger);
			nextConnection.off('debug', debugLogger);
		}
	}

	throw lastError ?? new Error('Failed to establish voice connection');
}

async function join(
	interaction: ChatInputCommandInteraction,
	recordable: Set<Snowflake>,
	recording: Set<Snowflake>,
	client: Client,
	connection?: VoiceConnection,
) {
	await interaction.deferReply();

	// Force fetch the member to ensure we have the latest data
	try {
		if (interaction.guildId) {
			const guild = client.guilds.cache.get(interaction.guildId);
			if (guild) {
				const member = await guild.members.fetch(interaction.user.id);
					if (member.voice.channel) {
						// Try to join using the freshly fetched member data
						if (!connection || connection.state.status !== VoiceConnectionStatus.Ready) {
							try {
								connection = await createReadyConnection(member.voice.channel, 'join');
							} catch (error) {
							console.error('Error joining voice channel:', error);
							await interaction.followUp('Error joining voice channel. Check console for details.');
							return;
						}
					}
				} else {
					await interaction.followUp('You need to join a voice channel first!');
					return;
				}
			} else {
				await interaction.followUp('Error: Could not find guild');
				return;
			}
		} else {
			await interaction.followUp('Error: No guild ID available');
			return;
		}
	} catch (error) {
		console.error('Error fetching member:', error);
		
		// Fall back to the original method if fetching fails
			if (!connection || connection.state.status !== VoiceConnectionStatus.Ready) {
				if (interaction.member instanceof GuildMember && interaction.member.voice.channel) {
					const channel = interaction.member.voice.channel;
					connection = await createReadyConnection(channel, 'join-fallback');
				} else {
				await interaction.followUp('Join a voice channel and then try that again!');
				return;
			}
		}
	}

	try {
		await entersState(connection, VoiceConnectionStatus.Ready, 5e3);
	} catch (error) {
		console.warn('Connection error:', error);
		await interaction.followUp('Failed to join voice channel within 20 seconds, please try again later!');
		return;
	}

	await interaction.followUp('Ready!');
}

async function record(
	interaction: ChatInputCommandInteraction,
	recordable: Set<Snowflake>,
	_recording: Set<Snowflake>,
	client: Client,
	connection?: VoiceConnection,
) {
	await interaction.deferReply({ ephemeral: true });
	
	if (!interaction.guildId) {
		await interaction.editReply({ content: 'This command can only be used in a server.' });
		return;
	}

	try {
		const guild = client.guilds.cache.get(interaction.guildId);
		if (!guild) {
			await interaction.editReply({ content: 'Error: Could not find guild.' });
			return;
		}

		const member = await guild.members.fetch(interaction.user.id);
		if (!member.voice.channel) {
			await interaction.editReply({ content: 'You need to join a voice channel first!' });
			return;
		}

		if (!connection || connection.state.status !== VoiceConnectionStatus.Ready) {
			connection = await createReadyConnection(member.voice.channel, 'record');
		}

		const humanMembers = member.voice.channel.members.filter(m => !m.user.bot);
		const started = await startManualRecording(
			interaction.guildId,
			member.voice.channel.id,
			member.voice.channel.name,
			humanMembers,
			connection,
			client
		);

		await interaction.editReply({
			content: started
                ? 'Started recording everyone in your voice channel. A transcript and summary will be generated when the recording ends.'
                : 'A recording is starting or finishing, or is active in another channel. Please try again shortly.'
		});
	} catch (error) {
		console.error('Error setting up connection for record command:', error);
		await interaction.editReply({ content: 'Failed to establish voice connection. Please try again in a few seconds.' });
	}
}

async function leave(
	interaction: ChatInputCommandInteraction,
	_recordable: Set<Snowflake>,
	recording: Set<Snowflake>,
	client: Client,
	connection?: VoiceConnection,
) {
	if (interaction.guildId && isRecording(interaction.guildId)) {
        await interaction.deferReply({ ephemeral: true });
        await stopRecording(interaction.guildId, client);
        await interaction.followUp({ ephemeral: true, content: 'Left the channel and stopped recording!' });
    } else if (connection) {
		connection.destroy();
        recording.clear();
		await interaction.reply({ ephemeral: true, content: 'Left the channel!' });
	} else {
		await interaction.reply({ ephemeral: true, content: 'Not playing in this server!' });
	}
}

// Add a new command to stop recording
async function stopRecordingCommand(
    interaction: ChatInputCommandInteraction,
    _recordable: Set<Snowflake>,
    _recording: Set<Snowflake>,
    client: Client,
    _connection?: VoiceConnection,
) {
    if (!interaction.guildId) {
        await interaction.reply({ ephemeral: true, content: 'This command can only be used in a server.' });
        return;
    }
    
    if (isRecording(interaction.guildId)) {
        await interaction.deferReply({ ephemeral: true });
        const discarded = await discardRecording(interaction.guildId);
        await interaction.followUp({
            ephemeral: true,
            content: discarded
                ? 'Recording stopped. The bot left the channel and discarded any transcript or summary for this call.'
                : 'Failed to stop the recording cleanly. Check the logs.'
        });
    } else {
        await interaction.reply({ ephemeral: true, content: 'No active recording to stop.' });
    }
}

export const interactionHandlers = new Map<
	string,
	(
		interaction: ChatInputCommandInteraction,
		recordable: Set<Snowflake>,
		recording: Set<Snowflake>,
		client: Client,
		connection?: VoiceConnection,
	) => Promise<void>
>();
interactionHandlers.set('join', join);
interactionHandlers.set('record', record);
interactionHandlers.set('leave', leave);
interactionHandlers.set('stop_recording', stopRecordingCommand);
