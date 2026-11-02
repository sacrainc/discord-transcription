import { Client, AttachmentBuilder } from 'discord.js';
import { getTranscriptChannel } from './utils';
import * as fs from 'fs';
import * as path from 'path';
import OpenAI from 'openai';
import config from './config';

export const SUMMARY_MODEL = 'gpt-6.1-sol';
const openai = config.openaiApiKey ? new OpenAI({
    apiKey: config.openaiApiKey,
    timeout: 20_000,
    maxRetries: 1,
}) : null;

async function generateText(instructions: string, input: string, maxOutputTokens: number): Promise<string> {
    if (!openai) throw new Error('OPENAI_API_KEY is not configured');
    const response = await openai.responses.create({
        model: SUMMARY_MODEL,
        instructions,
        input,
        max_output_tokens: maxOutputTokens,
        reasoning: { effort: 'low' },
        store: false,
    });
    if (response.status !== 'completed' || !response.output_text?.trim()) {
        throw new Error(`OpenAI response did not complete with text (${response.status})`);
    }
    return response.output_text.trim();
}

// Store transcripts by guild ID and user ID
interface TranscriptData {
    userId: string;
    displayName: string;
    messages: TranscriptMessage[];
    startTime: Date;
}

interface TranscriptMessage {
    text: string;
    timestamp: Date;
}

interface TranscriptSession {
    guildId: string;
    startedAt: Date;
    users: Map<string, TranscriptData>;
    accepting: boolean;
}

// Map of session ID -> transcript data for that recording session.
const transcriptSessions = new Map<string, TranscriptSession>();

// Map of guild ID -> currently active transcript session ID.
const activeTranscriptSessions = new Map<string, string>();
const QUOTE_AUTHORS = [
    'Julius Caesar',
    'Seneca',
    'Friedrich Nietzsche',
    'Aristotle',
    'Marcus Aurelius',
    'Sun Tzu',
    'Peter Drucker',
] as const;

function pickRandomAuthor(): string {
    const index = Math.floor(Math.random() * QUOTE_AUTHORS.length);
    return QUOTE_AUTHORS[index];
}

/**
 * Mark a transcript session as active for a guild.
 */
export function startTranscriptSession(guildId: string, sessionId: string) {
    transcriptSessions.set(sessionId, {
        guildId,
        startedAt: new Date(),
        users: new Map<string, TranscriptData>(),
        accepting: true,
    });
    activeTranscriptSessions.set(guildId, sessionId);
    console.log(`🆕 Started transcript session ${sessionId} for guild ${guildId}`);
}

/**
 * Remove transcript state for a session without generating output.
 */
export function discardTranscriptSession(guildId: string, sessionId: string) {
    if (transcriptSessions.get(sessionId)?.guildId !== guildId) return;
    const didDelete = transcriptSessions.delete(sessionId);
    if (activeTranscriptSessions.get(guildId) === sessionId) {
        activeTranscriptSessions.delete(guildId);
    }

    console.log(
        didDelete
            ? `🗑️ Discarded transcript session ${sessionId} for guild ${guildId}`
            : `ℹ️ No transcript session ${sessionId} found to discard for guild ${guildId}`
    );
}

/**
 * Add a message to the transcript.
 */
export function addTranscriptMessage(
    guildId: string,
    sessionId: string,
    userId: string,
    displayName: string,
    text: string
) {
    const session = transcriptSessions.get(sessionId);
    if (!session || session.guildId !== guildId || !session.accepting) return;

    // Get or create user transcript data
    if (!session.users.has(userId)) {
        session.users.set(userId, {
            userId,
            displayName,
            messages: [],
            startTime: new Date()
        });
    }

    const userTranscript = session.users.get(userId)!;
    
    // Add message to transcript
    userTranscript.messages.push({
        text,
        timestamp: new Date()
    });
    
    console.log(`📝 Added transcript message for ${displayName}: ${text}`);
}

/**
 * Generate a transcript for a recording session.
 */
export async function generateTranscript(guildId: string, sessionId: string, _client: Client): Promise<string | null> {
    const session = transcriptSessions.get(sessionId);
    if (!session || session.guildId !== guildId || session.users.size === 0) {
        console.log(`⚠️ No transcript data found for guild ${guildId} in session ${sessionId}`);
        return null;
    }

    console.log(`📄 Generating transcript for guild ${guildId} with ${session.users.size} speakers from session ${sessionId}`);
    
    // Collect all messages from all users
    const allMessages: {
        userId: string;
        displayName: string;
        text: string;
        timestamp: Date;
    }[] = [];
    
    session.users.forEach((userData, userId) => {
        userData.messages.forEach(message => {
            allMessages.push({
                userId,
                displayName: userData.displayName,
                text: message.text,
                timestamp: message.timestamp
            });
        });
    });
    
    // Sort messages by timestamp
    allMessages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    
    // Generate transcript text
    let transcript = '';
    let currentSpeaker = '';
    
    allMessages.forEach(message => {
        if (message.displayName !== currentSpeaker) {
            transcript += `\n\nSpeaker @${message.displayName}: `;
            currentSpeaker = message.displayName;
        }
        transcript += `${message.text} `;
    });
    
    // Replace "WAP" with "Whop" (case-insensitive)
    const finalTranscript = transcript.trim().replace(/\bWAP\b/gi, 'Whop');
    
    return finalTranscript;
}

/**
 * Generate a summary of a transcript using OpenAI
 */
export async function generateSummary(transcript: string): Promise<string | null> {
    if (!openai) {
        console.error('❌ OPENAI_API_KEY is not configured!');
        return null;
    }
    
    const selectedAuthor = pickRandomAuthor();
    console.log(`🤖 Generating summary using OpenAI (quote author: ${selectedAuthor})...`);
    
    try {
        const summary = await generateText(`You are a helpful assistant that converts raw meeting transcripts among colleagues at the company Sacra into a clear, concise summary. YOUR SUMMARY MUST BE 250 WORDS MAXIMUM.

Your goal is to produce a well-structured Markdown summary in this style:

### High-Level Overview
- Summarize the overall purpose and context of the conversation.
- List any key topics or themes that emerged.
### Key Discussion Points
- Organize the main ideas under headings or bullet points.
- Capture essential details and reasoning behind any decisions.
### Decisions & Outcomes
- Clearly state any final decisions, agreements, or conclusions reached.
- Note any unresolved questions or open items that need follow-up.

Instructions:
- Use H3 headings and bullet points to keep the notes scannable and organized.
- No line breaks between sections.
- Be concise—avoid unnecessary repetition or filler text.
- Target approximately 1400 characters total so the summary usually fits in one Discord message with metadata.
- If participants mention specific data, numbers, or technical details, include them accurately.
- If there's any ambiguity in the transcript, indicate that clarification is needed.
- Write in a neutral, professional tone.
- Normalize speaker names to this canonical set when relevant: Jan, Walter, Marcelo, Danny, Trey.
- If the transcript includes usernames, map them as follows: "smalter" -> "Walter", "loopboi" -> "Danny".
- Never refer to Danny as "Loopboi" in the summary body.
- End the summary with exactly one closing quote line.
- The quote author for this summary is fixed to: ${selectedAuthor}.
- Produce one quote-like line inspired by ${selectedAuthor}'s voice and themes, tangentially related to the meeting discussion, decisions, or momentum.
- Do not use a business/tech-bro tone and avoid cheesy hype.

BEGIN YOUR RESPONSE WITH THE HIGH-LEVEL OVERVIEW. DO NOT ADD ANY PREFACE OR MENTION THE FACT THAT YOU'RE STARTING YOUR SUMMARY. DO NOT START WITH A "### SUMMARY" HEADER OR A "SUMMARY:" OR ANYTHING LIKE THAT.
The closing quote must be the final line of the entire response, and it must use exactly this format:
"<quote>" — ${selectedAuthor}`, transcript, 8000);
        console.log(`Generated summary (${summary.length} chars)`);
        return summary;
    } catch (error) {
        console.error(`❌ Error generating summary: ${error}`);
        return null;
    }
}

/**
 * Generate a title for a meeting using OpenAI
 */
export async function generateTitle(summary: string): Promise<string> {
    if (!openai) {
        console.error('❌ OPENAI_API_KEY is not configured!');
        return `Meeting Transcript (${new Date().toLocaleDateString()})`;
    }
    
    console.log(`🏷️ Generating title using OpenAI...`);
    
    try {
        const date = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
        
        const title = await generateText(`You are a helpful assistant that creates concise, descriptive titles for meeting summaries.
                
Instructions:
1. Read the meeting summary and identify the main topic or purpose of the meeting.
2. Create a title that is brief (3-5 words) but descriptive of the meeting content.
3. Include the date (${date}) in parentheses at the end of the title.
4. Format should be: "Main Topic (${date})"
5. Examples: "Product Roadmap Discussion (${date})", "Team Standup Meeting (${date})", "Client Onboarding Call (${date})"

Your response should ONLY include the title, nothing else.`, summary, 2000);
        return title.replace(/\s+/g, ' ').slice(0, 200);
    } catch (error) {
        console.error(`❌ Error generating title: ${error}`);
        return `Meeting Transcript (${new Date().toLocaleDateString()})`;
    }
}

/** Stop ingestion after all transcription sockets have drained. Retain data until delivery. */
export function sealTranscriptSession(guildId: string, sessionId: string) {
    const session = transcriptSessions.get(sessionId);
    if (session?.guildId === guildId) session.accepting = false;
    if (activeTranscriptSessions.get(guildId) === sessionId) activeTranscriptSessions.delete(guildId);
}

/** Prefer section boundaries, falling back to lines/words for oversized sections. */
export function chunkSectionsForDiscord(
    title: string,
    recordedUsers: string[],
    summary: string,
    discordCharLimit = 1950
): string[] {
    const header = `**${title}**\n\n**Recording finished for:** ${recordedUsers.join(', ')}\n\n**Summary:**\n`;
    const sections = `${header}${summary}`.trim().split(/\n(?=###\s)/g);
    const messages: string[] = [];
    let current = '';
    for (let section of sections) {
        if (current && current.length + 2 + section.length <= discordCharLimit) {
            current += `\n\n${section}`;
            continue;
        }
        if (current) messages.push(current);
        while (section.length > discordCharLimit) {
            let cut = section.lastIndexOf('\n', discordCharLimit);
            if (cut < discordCharLimit / 2) cut = section.lastIndexOf(' ', discordCharLimit);
            if (cut < discordCharLimit / 2) cut = discordCharLimit;
            // Avoid splitting a UTF-16 surrogate pair (e.g. emoji).
            if (/[\uD800-\uDBFF]/.test(section[cut - 1])) cut--;
            messages.push(section.slice(0, cut));
            section = section.slice(cut).trimStart();
        }
        current = section;
    }
    if (current) messages.push(current);
    return messages;
}

/** Save the raw transcript before requesting optional AI output or contacting Discord. */
export function saveTranscript(guildId: string, sessionId: string, transcript: string): string {
    const transcriptDir = path.join(process.cwd(), 'transcripts');
    fs.mkdirSync(transcriptDir, { recursive: true });
    const filename = `transcript-${guildId}-${sessionId.replace(/[^a-zA-Z0-9-]/g, '_')}.md`;
    const filepath = path.join(transcriptDir, filename);
    fs.writeFileSync(filepath, transcript, { encoding: 'utf8', mode: 0o600 });
    return filepath;
}

/** The attachment is delivered with the first message, so later summary errors cannot block it. */
export async function sendTranscriptAndSummary(
    client: Client,
    guildId: string,
    transcript: string,
    summary: string | null,
    title: string,
    recordedUsers: string[],
    sessionId: string,
    enrich?: () => Promise<{ summary: string | null; title: string }>
): Promise<boolean> {
    const filepath = saveTranscript(guildId, sessionId, transcript);
    try {
        const transcriptChannel = await getTranscriptChannel(client);
        if (!transcriptChannel) throw new Error('Could not find transcript channel');
        let messages = chunkSectionsForDiscord(title, recordedUsers, summary || 'Summary unavailable. The full transcript is attached.');
        const firstMessage = await transcriptChannel.send({
            content: messages[0],
            files: [new AttachmentBuilder(Buffer.from(`# ${title}\n\n${transcript}`), { name: path.basename(filepath) })],
            allowedMentions: { parse: [] },
        });
        // Deliver first. Enrichment cannot delay or prevent the raw transcript attachment.
        if (enrich) {
            try {
                const result = await enrich();
                if (result.summary) {
                    messages = chunkSectionsForDiscord(result.title, recordedUsers, result.summary);
                    await firstMessage.edit({ content: messages[0], allowedMentions: { parse: [] } });
                }
            } catch (error) {
                console.error('Summary enrichment failed; full transcript was delivered:', error);
                return true;
            }
        }
        // The complete transcript is now delivered. Optional continuation failures do not undo delivery.
        for (const content of messages.slice(1)) {
            try {
                await transcriptChannel.send({ content, allowedMentions: { parse: [] } });
            } catch (error) {
                console.error('Failed to send summary continuation; full transcript was delivered:', error);
                break;
            }
        }
        return true;
    } catch (error) {
        console.error(`Transcript delivery failed; retained at ${filepath}:`, error);
        return false;
    }
}
