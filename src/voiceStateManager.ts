import { Client, VoiceState, GuildMember, Collection, PermissionsBitField } from 'discord.js';
import { joinVoiceChannel, VoiceConnection, entersState, VoiceConnectionStatus, getVoiceConnection } from '@discordjs/voice';
import { createListeningStream } from './createListeningStream';
import {
    discardTranscriptSession,
    generateTranscript,
    generateSummary,
    generateTitle,
    sendTranscriptAndSummary,
    startTranscriptSession,
} from './transcriptManager';
import { getTranscriptChannel } from './utils';
import config from './config';

// Get config values
const { defaultChannel, transcriptChannelId, voiceDebugLogs } = config;

// Store active recordings by guild ID
interface RecordingData {
    sessionId: string;
    connection: VoiceConnection;
    channelId: string;
    channelName: string;
    recordable: Set<string>;
    recording: Set<string>;
    startTime: Date;
    notificationMessageId?: string;
    isManualRecording?: boolean; // Flag to indicate if this was started manually via /record
}

const activeRecordings = new Map<string, RecordingData>();
const pendingAutoStarts = new Set<string>();

function createRecordingSessionId(guildId: string): string {
    return `${guildId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Handle voice state updates to automatically start/stop recordings
 */
export async function handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState, client: Client) {
    // Skip bot voice state updates
    if (newState.member?.user.bot) return;

    const guildId = newState.guild.id;

    // Handle member joining a voice channel
    if (newState.channelId && (!oldState.channelId || oldState.channelId !== newState.channelId)) {
        console.log(`👂 Member ${newState.member?.displayName} joined voice channel ${newState.channel?.name}`);
        await handleMemberJoin(newState, client);
    }

    // Handle member leaving a voice channel
    if (oldState.channelId && (!newState.channelId || oldState.channelId !== newState.channelId)) {
        console.log(`👋 Member ${oldState.member?.displayName} left voice channel ${oldState.channel?.name}`);
        await handleMemberLeave(oldState, client);
    }
}

/**
 * Handle a member joining a voice channel
 */
async function handleMemberJoin(state: VoiceState, client: Client) {
    const guildId = state.guild.id;
    const channelId = state.channelId;
    
    if (!channelId) return;
    
    // Get the voice channel
    const channel = state.channel;
    if (!channel) return;
    
    // Count human members in the channel (excluding bots)
    const humanMembers = channel.members.filter(member => !member.user.bot);
    const memberCount = humanMembers.size;
    
    console.log(`🔢 Voice channel ${channel.name} has ${memberCount} human members`);
    
    // Only start recording if there are at least 2 real human members
    if (memberCount >= 2) {
        // Check if we're already recording in this guild
        if (activeRecordings.has(guildId)) {
            console.log(`⏺️ Already recording in guild ${guildId}`);
            
            // If we're recording in a different channel, we might want to move
            const recordingData = activeRecordings.get(guildId)!;
            if (recordingData.channelId !== channelId) {
                console.log(`🔄 Currently recording in ${recordingData.channelName}, but new activity in ${channel.name}`);
                // For now, we'll stick with the current recording
            } else {
                // Add this user to the recordable set if they joined the channel we're recording
                console.log(`👤 Adding new user ${state.member?.displayName} to recordable set`);
                recordingData.recordable.add(state.member!.id);
            }
            
            return;
        }

        if (pendingAutoStarts.has(guildId)) {
            console.log(`⏳ Automatic recording start already in progress for guild ${guildId}`);
            return;
        }

        const attemptId = `${guildId}-${Date.now()}`;
        const attemptStartedAt = Date.now();
        const humanMemberNames = humanMembers.map(member => member.displayName).join(', ');
        let connection: VoiceConnection | null = null;
        
        console.log(
            `🎙️ [auto-start:${attemptId}] Starting in ${channel.name} (${channel.id}) with ${memberCount} members: ${humanMemberNames}`
        );
        pendingAutoStarts.add(guildId);
        
        try {
            const botMember = channel.guild.members.me;
            if (!botMember) {
                console.error(`❌ [auto-start:${attemptId}] Cannot start: bot member cache is unavailable in guild ${guildId}`);
                return;
            }

            console.log(
                `ℹ️ [auto-start:${attemptId}] Bot voice state before join: channelId=${botMember.voice.channelId ?? 'none'}`
            );

            const permissions = channel.permissionsFor(botMember);
            const missingPermissions: string[] = [];
            if (!permissions?.has(PermissionsBitField.Flags.ViewChannel)) missingPermissions.push('ViewChannel');
            if (!permissions?.has(PermissionsBitField.Flags.Connect)) missingPermissions.push('Connect');
            if (missingPermissions.length > 0) {
                console.error(
                    `❌ [auto-start:${attemptId}] Cannot start in ${channel.name}. Missing permissions: ${missingPermissions.join(', ')}`
                );
                return;
            }
            if (channel.full) {
                console.error(`❌ [auto-start:${attemptId}] Cannot start in ${channel.name}. Voice channel is full.`);
                return;
            }

            const existingConnection = getVoiceConnection(guildId);
            if (existingConnection && existingConnection.state.status !== VoiceConnectionStatus.Destroyed) {
                console.log(
                    `🧹 [auto-start:${attemptId}] Found existing voice connection in state ${existingConnection.state.status} for channel ${existingConnection.joinConfig.channelId}. Destroying before retrying.`
                );
                existingConnection.destroy();
            }

            // Join the voice channel, with one retry after full cleanup on timeout-style aborts.
            let lastJoinError: unknown = null;
            for (let joinAttempt = 1; joinAttempt <= 2; joinAttempt++) {
                connection = joinVoiceChannel({
                    channelId: channel.id,
                    guildId: channel.guild.id,
                    selfDeaf: false,
                    selfMute: true,
                    adapterCreator: channel.guild.voiceAdapterCreator,
                    debug: Boolean(voiceDebugLogs),
                });

                console.log(`ℹ️ [auto-start:${attemptId}] Join attempt ${joinAttempt}/2 started`);

            const stateLogger = (
                oldState: { status: VoiceConnectionStatus; reason?: number; closeCode?: number },
                newState: { status: VoiceConnectionStatus; reason?: number; closeCode?: number }
            ) => {
                if (!voiceDebugLogs) return;
                    const elapsedMs = Date.now() - attemptStartedAt;
                    const details = newState.status === VoiceConnectionStatus.Disconnected
                        ? ` reason=${newState.reason ?? 'n/a'} closeCode=${newState.closeCode ?? 'n/a'}`
                        : '';
                console.log(
                    `🔌 [auto-start:${attemptId}] state ${oldState.status} -> ${newState.status}${details} (+${elapsedMs}ms)`
                );

                // Attach once to internal networking close event so we can capture the exact WS close code.
                const networking = (newState as unknown as { networking?: { on: (event: string, cb: (code: number) => void) => void; __closeHooked?: boolean } }).networking;
                if (networking && !networking.__closeHooked) {
                    networking.__closeHooked = true;
                    networking.on('close', (code: number) => {
                        console.error(`❌ [auto-start:${attemptId}] networking close code: ${code}`);
                    });
                }
            };
                const errorLogger = (error: Error) => {
                    if (voiceDebugLogs) {
                        const elapsedMs = Date.now() - attemptStartedAt;
                        console.error(
                            `❌ [auto-start:${attemptId}] Voice connection error before ready (+${elapsedMs}ms): ${error.name}: ${error.message}`
                        );
                    }
                };
                const debugLogger = (message: string) => {
                    if (!voiceDebugLogs) return;
                    const elapsedMs = Date.now() - attemptStartedAt;
                    console.log(`🧪 [auto-start:${attemptId}] voice debug (+${elapsedMs}ms): ${message}`);
                };
                connection.on('stateChange', stateLogger);
                connection.on('error', errorLogger);
                connection.on('debug', debugLogger);
                
                try {
                    await entersState(connection, VoiceConnectionStatus.Ready, 20e3);
                    console.log(`✅ [auto-start:${attemptId}] Connected to voice channel ${channel.name}`);
                    lastJoinError = null;
                    break;
                } catch (joinError) {
                    lastJoinError = joinError;
                    const elapsedMs = Date.now() - attemptStartedAt;
                    if (joinError instanceof Error) {
                        console.error(
                            `❌ [auto-start:${attemptId}] Join attempt ${joinAttempt}/2 failed after ${elapsedMs}ms: ${joinError.name}: ${joinError.message}`
                        );
                    } else {
                        console.error(
                            `❌ [auto-start:${attemptId}] Join attempt ${joinAttempt}/2 failed after ${elapsedMs}ms: ${joinError}`
                        );
                    }

                    const trackedConnection = getVoiceConnection(guildId);
                    if (trackedConnection && trackedConnection.state.status !== VoiceConnectionStatus.Destroyed) {
                        trackedConnection.destroy();
                        console.log(`🧹 [auto-start:${attemptId}] Destroyed connection after failed join attempt ${joinAttempt}/2`);
                    }

                    if (joinAttempt < 2) {
                        console.log(`🔁 [auto-start:${attemptId}] Retrying automatic join in 1000ms`);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                } finally {
                    connection.off('stateChange', stateLogger);
                    connection.off('error', errorLogger);
                    connection.off('debug', debugLogger);
                }
            }

            if (lastJoinError) {
                throw lastJoinError;
            }
            
            // Initialize recording data
            const sessionId = createRecordingSessionId(guildId);
            const recordable = new Set<string>();
            const recording = new Set<string>();
            
            // Recompute in case members joined while the connection was being established.
            const currentHumanMembers = channel.members.filter(member => !member.user.bot);

            // Add all current members to recordable
            currentHumanMembers.forEach(member => {
                recordable.add(member.id);
            });
            
            // Store recording data
            activeRecordings.set(guildId, {
                sessionId,
                connection,
                channelId: channel.id,
                channelName: channel.name,
                recordable,
                recording,
                startTime: new Date(),
                isManualRecording: false // This is an automatic recording
            });

            startTranscriptSession(guildId, sessionId);
            
            // Send notification to transcript channel
            const notificationMessage = await sendRecordingNotification(
                client, 
                guildId, 
                channel.name, 
                currentHumanMembers
            );
            
            if (notificationMessage) {
                const recordingData = activeRecordings.get(guildId)!;
                recordingData.notificationMessageId = notificationMessage.id;
            }
            
            // Set up the recording
            setupRecording(connection, recordable, recording, client, guildId, sessionId);
            console.log(
                `✅ [auto-start:${attemptId}] Recording setup complete for guild ${guildId} in ${channel.name}`
            );
            
        } catch (error) {
            const elapsedMs = Date.now() - attemptStartedAt;
            const trackedConnection = getVoiceConnection(guildId);
            if (error instanceof Error) {
                console.error(
                    `❌ [auto-start:${attemptId}] Failed after ${elapsedMs}ms: ${error.name}: ${error.message}`
                );
                if (error.stack) {
                    console.error(`❌ [auto-start:${attemptId}] Stack: ${error.stack}`);
                }
            } else {
                console.error(`❌ [auto-start:${attemptId}] Failed after ${elapsedMs}ms: ${error}`);
            }

            console.error(
                `❌ [auto-start:${attemptId}] Snapshot: localConnectionState=${connection?.state.status ?? 'none'}, trackedConnectionState=${trackedConnection?.state.status ?? 'none'}, trackedChannelId=${trackedConnection?.joinConfig.channelId ?? 'none'}, botVoiceChannel=${channel.guild.members.me?.voice.channelId ?? 'none'}`
            );

            if (trackedConnection && trackedConnection.state.status !== VoiceConnectionStatus.Destroyed) {
                try {
                    trackedConnection.destroy();
                    console.log(`🧹 [auto-start:${attemptId}] Cleaned up stale voice connection after failed start.`);
                } catch (cleanupError) {
                    console.error(`❌ [auto-start:${attemptId}] Error cleaning up failed voice connection: ${cleanupError}`);
                }
            }
        } finally {
            pendingAutoStarts.delete(guildId);
            const elapsedMs = Date.now() - attemptStartedAt;
            console.log(`🏁 [auto-start:${attemptId}] Finished (elapsed ${elapsedMs}ms)`);
        }
    }
}

/**
 * Handle a member leaving a voice channel
 */
async function handleMemberLeave(state: VoiceState, client: Client) {
    const guildId = state.guild.id;
    const channelId = state.channelId;
    
    if (!channelId) return;
    
    // Check if we're recording in this channel
    const recordingData = activeRecordings.get(guildId);
    if (!recordingData || recordingData.channelId !== channelId) {
        return;
    }
    
    // Get the voice channel
    const channel = state.channel;
    if (!channel) return;
    
    // Count human members in the channel (excluding bots)
    const humanMembers = channel.members.filter(member => !member.user.bot);
    const memberCount = humanMembers.size;
    
    console.log(`🔢 Voice channel ${channel.name} now has ${memberCount} human members after someone left`);
    
    // For automatic recordings, stop if only 1 or 0 human members remain
    // For manual recordings, stop if only the bot remains (0 human members)
    if ((recordingData.isManualRecording && memberCount === 0) || 
        (!recordingData.isManualRecording && memberCount <= 1)) {
        console.log(`⏹️ Stopping recording in ${channel.name} as ${memberCount} human members remain`);
        
        // Add a small delay to allow any final audio to be processed
        console.log(`⏱️ Waiting 2 seconds before stopping recording to capture final audio...`);
        setTimeout(async () => {
            await stopRecording(guildId, client, true);
        }, 2000);
    }
}

/**
 * Set up recording for a voice connection
 */
function setupRecording(
    connection: VoiceConnection, 
    recordable: Set<string>, 
    recording: Set<string>, 
    client: Client,
    guildId: string,
    sessionId: string
) {
    const receiver = connection.receiver;
    
    // Listen for speaking events
    receiver.speaking.on('start', async (userId) => {
        if (recordable.has(userId)) {
            // Get the member
            const guild = client.guilds.cache.get(guildId);
            if (!guild) return;
            
            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member) return;
            
            const displayName = member.displayName;
            
            if (recording.has(userId)) {
                // Already recording this user
                return;
            }
            
            recording.add(userId);
            
            // Get the webhook for the transcript channel
            const transcriptChannel = await getTranscriptChannel(client);
            if (!transcriptChannel) {
                console.error(`❌ Could not find transcript channel`);
                return;
            }
            
            // Get the webhook for the channel
            let webhook;
            try {
                const webhooks = await transcriptChannel.fetchWebhooks();
                webhook = webhooks.first();
                
                if (!webhook) {
                    webhook = await transcriptChannel.createWebhook({
                        name: 'Transcript Webhook',
                        avatar: client.user?.displayAvatarURL(),
                    });
                }
            } catch (error) {
                console.error(`❌ Error getting webhook: ${error}`);
                return;
            }
            
            // Get the user's avatar URL
            const avatarUrl = member.displayAvatarURL();
            
            try {
                createListeningStream(
                    webhook,
                    recording,
                    receiver,
                    userId,
                    displayName,
                    avatarUrl,
                    guildId,
                    sessionId
                );
            } catch (error) {
                console.error(`❌ Error creating listening stream: ${error}`);
                recording.delete(userId);
            }
        }
    });
    
    // Handle connection state changes
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
            console.log(`⚠️ Voice connection disconnected, attempting to reconnect...`);
            // Try to reconnect if disconnected
            await Promise.race([
                entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
            ]);
            console.log(`✅ Successfully reconnected to voice channel`);
        } catch (error) {
            // If we can't reconnect, stop the recording gracefully
            console.log(`❌ Voice connection disconnected and couldn't reconnect: ${error}`);
            
            // Check if we're still recording in this guild
            if (activeRecordings.has(guildId)) {
                console.log(`🛑 Attempting graceful shutdown after disconnection`);
                try {
                    // Try to stop recording gracefully
                    await stopRecording(guildId, client, true);
                } catch (stopError) {
                    console.error(`❌ Error during graceful shutdown: ${stopError}`);
                    // Last resort cleanup
                    connection.destroy();
                    activeRecordings.delete(guildId);
                }
            } else {
                // Just destroy the connection if we're not recording
                connection.destroy();
            }
        }
    });
}

/**
 * Stop recording in a guild and generate transcript/summary
 */
export async function stopRecording(guildId: string, client: Client, isGracefulExit: boolean = false) {
    const recordingData = activeRecordings.get(guildId);
    if (!recordingData) {
        console.log(`⚠️ No active recording found for guild ${guildId}`);
        return;
    }
    
    try {
        console.log(`🛑 Stopping recording for guild ${guildId} (graceful: ${isGracefulExit})`);
        
        // First, mark that we're stopping to prevent new recordings
        const { connection, recording, recordable, sessionId } = recordingData;
        
        // If this is a graceful exit, wait a moment for any final audio to be processed
        if (isGracefulExit) {
            // We already added a delay before calling this function
            console.log(`✅ Processing final audio before stopping recording`);
        }
        
        // Clear recording sets to prevent new recordings
        recording.clear();
        
        // Get recorded users
        const recordedUsers = Array.from(recordable).map(userId => {
            const member = client.guilds.cache.get(guildId)?.members.cache.get(userId);
            return member ? member.displayName : userId;
        });
        
        // Remove from active recordings map before destroying connection
        // This prevents race conditions with the disconnection handler
        activeRecordings.delete(guildId);
        
        // Now destroy the connection
        connection.destroy();
        console.log(`🛑 Destroyed voice connection for guild ${guildId}`);
        
        console.log(`✅ Successfully stopped recording in guild ${guildId}`);
        
        // Wait a moment for any final transcripts to be processed
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Generate transcript
        const transcript = await generateTranscript(guildId, sessionId, client);
        if (!transcript) {
            console.log(`⚠️ No transcript generated for guild ${guildId}`);
            await sendStopRecordingNotification(client, guildId, recordingData);
            return;
        }
        
        console.log(`📝 Generated transcript for guild ${guildId} (${transcript.length} chars)`);
        
        // Generate summary
        const summary = await generateSummary(transcript);
        if (!summary) {
            console.log(`⚠️ No summary generated for guild ${guildId}`);
            await sendStopRecordingNotification(client, guildId, recordingData);
            return;
        }
        
        console.log(`📋 Generated summary for guild ${guildId} (${summary.length} chars)`);
        
        // Generate title
        const title = await generateTitle(summary);
        console.log(`🏷️ Generated title for guild ${guildId}: ${title}`);
        
        // Send transcript and summary
        await sendTranscriptAndSummary(
            client,
            guildId,
            transcript,
            summary,
            title,
            recordedUsers
        );
    } catch (error) {
        console.error(`❌ Error stopping recording: ${error}`);
        
        // Try to send a basic notification
        try {
            if (recordingData) {
                await sendStopRecordingNotification(client, guildId, recordingData);
            }
        } catch (innerError) {
            console.error(`❌ Error sending stop notification: ${innerError}`);
        }
        
        // Make sure we clean up even if there was an error
        if (activeRecordings.has(guildId)) {
            const data = activeRecordings.get(guildId);
            if (data && data.connection) {
                try {
                    data.connection.destroy();
                } catch (err) {
                    console.error(`❌ Error destroying connection during cleanup: ${err}`);
                }
            }
            activeRecordings.delete(guildId);
        }
    }
}

/**
 * Stop recording in a guild and discard any transcript/summary state.
 */
export async function discardRecording(guildId: string) {
    const recordingData = activeRecordings.get(guildId);
    if (!recordingData) {
        console.log(`⚠️ No active recording found for guild ${guildId} to discard`);
        return false;
    }

    try {
        console.log(`🛑 Discarding recording for guild ${guildId}`);

        const { connection, recording, recordable, channelName, sessionId } = recordingData;

        // Clear recording sets to prevent new recordings
        recording.clear();
        recordable.clear();

        // Remove from active recordings map before destroying connection
        activeRecordings.delete(guildId);

        // Mark this session as discarded immediately so any late Deepgram events are ignored.
        discardTranscriptSession(guildId, sessionId);

        // Destroy the connection
        if (connection) {
            connection.destroy();
            console.log(`🛑 Destroyed voice connection for guild ${guildId} during discard`);
        }

        console.log(`✅ Successfully discarded recording in ${channelName} for guild ${guildId}`);
        return true;
    } catch (error) {
        console.error(`❌ Error discarding recording: ${error}`);
        
        // Ensure cleanup even if error occurs during discard.
        if (activeRecordings.has(guildId)) {
            const data = activeRecordings.get(guildId);
            if (data && data.connection) {
                try {
                    data.connection.destroy();
                } catch (err) {
                    console.error(`❌ Error destroying connection during discard cleanup: ${err}`);
                }
            }
            activeRecordings.delete(guildId);
        }

        discardTranscriptSession(guildId, recordingData.sessionId);
        return false;
    }
}

/**
 * Send a notification that recording has started
 */
async function sendRecordingNotification(
    client: Client, 
    guildId: string, 
    channelName: string, 
    members: Collection<string, GuildMember>
) {
    try {
        // Get the transcript channel
        const transcriptChannel = await getTranscriptChannel(client);
        if (!transcriptChannel) {
            console.error(`❌ Could not find transcript channel`);
            return null;
        }
        
        // Format member names
        const memberNames = members.map(member => member.displayName).join(', ');
        
        // Send notification
        const message = await transcriptChannel.send(
            `🔴 Started recording in ${channelName}!`
        );
        
        console.log(`✅ Sent recording notification to ${transcriptChannel.name}`);
        return message;
    } catch (error) {
        console.error(`❌ Error sending recording notification: ${error}`);
        return null;
    }
}

/**
 * Send a notification that recording has stopped
 */
async function sendStopRecordingNotification(
    client: Client, 
    guildId: string, 
    recordingData: RecordingData
) {
    try {
        // Get the transcript channel
        const transcriptChannel = await getTranscriptChannel(client);
        if (!transcriptChannel) {
            console.error(`❌ Could not find transcript channel`);
            return;
        }
        
        // Calculate recording duration
        const duration = Math.round((new Date().getTime() - recordingData.startTime.getTime()) / 1000);
        const minutes = Math.floor(duration / 60);
        const seconds = duration % 60;
        
        // Send notification
        await transcriptChannel.send(
            `⏹️ Recording stopped in ${recordingData.channelName} after ${minutes}m ${seconds}s\n` +
            `Generating transcript and summary... please wait.`
        );
        
        console.log(`✅ Sent recording stopped notification to ${transcriptChannel.name}`);
    } catch (error) {
        console.error(`❌ Error sending recording stopped notification: ${error}`);
    }
}

/**
 * Check if a guild is currently being recorded
 */
export function isRecording(guildId: string): boolean {
    return activeRecordings.has(guildId);
}

/**
 * Get all active recordings
 */
export function getActiveRecordings(): Map<string, RecordingData> {
    return activeRecordings;
}

/**
 * Start a manual recording initiated by the /record command
 */
export async function startManualRecording(
    guildId: string,
    channelId: string,
    channelName: string,
    humanMembers: Collection<string, GuildMember>,
    connection: VoiceConnection,
    client: Client
) {
    // Check if we're already recording in this guild
    if (activeRecordings.has(guildId)) {
        console.log(`⏺️ Already recording in guild ${guildId}`);
        
        // If we're recording in this channel, add the user to recordable
        const recordingData = activeRecordings.get(guildId)!;
        if (recordingData.channelId === channelId) {
            humanMembers.forEach(member => {
                if (!recordingData.recordable.has(member.id)) {
                    console.log(`👤 Adding new user ${member.displayName} to recordable set (manual recording)`);
                    recordingData.recordable.add(member.id);
                }
            });
        }
        
        return;
    }
    
    console.log(`🎙️ Starting manual recording in ${channelName} with ${humanMembers.size} members`);
    
    try {
        // Wait for the connection to be ready
        await entersState(connection, VoiceConnectionStatus.Ready, 20e3);
        console.log(`✅ Connected to voice channel ${channelName}`);
        
        // Initialize recording data
        const sessionId = createRecordingSessionId(guildId);
        const recordable = new Set<string>();
        const recording = new Set<string>();
        
        // Add all current members to recordable
        humanMembers.forEach(member => {
            recordable.add(member.id);
        });
        
        // Store recording data
        activeRecordings.set(guildId, {
            sessionId,
            connection,
            channelId,
            channelName,
            recordable,
            recording,
            startTime: new Date(),
            isManualRecording: true // Mark this as a manual recording
        });

        startTranscriptSession(guildId, sessionId);
        
        // Send notification to transcript channel
        const notificationMessage = await sendRecordingNotification(
            client, 
            guildId, 
            channelName, 
            humanMembers
        );
        
        if (notificationMessage) {
            const recordingData = activeRecordings.get(guildId)!;
            recordingData.notificationMessageId = notificationMessage.id;
        }
        
        // Set up the recording
        setupRecording(connection, recordable, recording, client, guildId, sessionId);
        
        return true;
    } catch (error) {
        console.error(`❌ Error starting manual recording: ${error}`);
        return false;
    }
} 
