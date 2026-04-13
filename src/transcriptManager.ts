import { Client, AttachmentBuilder } from 'discord.js';
import { getTranscriptChannel } from './utils';
import * as fs from 'fs';
import * as path from 'path';
import { Anthropic } from '@anthropic-ai/sdk';
import config from './config';

const { claudeApiKey } = config;

// Initialize Anthropic client
let anthropic: Anthropic | null = null;
if (claudeApiKey) {
    try {
        anthropic = new Anthropic({
            apiKey: claudeApiKey,
        });
        console.log('✅ Anthropic client initialized successfully');
    } catch (error) {
        console.error('❌ Failed to initialize Anthropic client:', error);
    }
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
    });
    activeTranscriptSessions.set(guildId, sessionId);
    console.log(`🆕 Started transcript session ${sessionId} for guild ${guildId}`);
}

/**
 * Remove transcript state for a session without generating output.
 */
export function discardTranscriptSession(guildId: string, sessionId: string) {
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
    if (activeTranscriptSessions.get(guildId) !== sessionId) {
        console.log(
            `🛑 Ignoring late transcript chunk for guild ${guildId}; session ${sessionId} is no longer active`
        );
        return;
    }

    if (!transcriptSessions.has(sessionId)) {
        transcriptSessions.set(sessionId, {
            guildId,
            startedAt: new Date(),
            users: new Map<string, TranscriptData>(),
        });
    }

    const session = transcriptSessions.get(sessionId)!;

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
        if (activeTranscriptSessions.get(guildId) === sessionId) {
            activeTranscriptSessions.delete(guildId);
        }
        transcriptSessions.delete(sessionId);
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
    let finalTranscript = transcript.trim().replace(/WAP/gi, 'Whop');
    
    // Clear transcript data for this session.
    transcriptSessions.delete(sessionId);
    if (activeTranscriptSessions.get(guildId) === sessionId) {
        activeTranscriptSessions.delete(guildId);
    }

    return finalTranscript;
}

/**
 * Generate a summary of a transcript using Claude
 */
export async function generateSummary(transcript: string): Promise<string | null> {
    if (!claudeApiKey || !anthropic) {
        console.error('❌ No Claude API key found in auth.json or client initialization failed!');
        return null;
    }
    
    const selectedAuthor = pickRandomAuthor();
    console.log(`🤖 Generating summary using Claude (quote author: ${selectedAuthor})...`);
    
    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 8000,
            system: `You are a helpful assistant that converts raw meeting transcripts among colleagues at the company Sacra into a clear, concise summary. YOUR SUMMARY MUST BE 250 WORDS MAXIMUM.

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
"<quote>" — ${selectedAuthor}`,
            messages: [
                {
                    role: 'user',
                    content: transcript
                }
            ]
        });
        
        // Check if the content is a text block
        if (response.content[0].type === 'text') {
            const summary = response.content[0].text;
            console.log(`✅ Generated summary (${summary.length} chars)`);
            return summary;
        } else {
            console.error('❌ Unexpected response format from Claude');
            return null;
        }
    } catch (error) {
        console.error(`❌ Error generating summary: ${error}`);
        return null;
    }
}

/**
 * Generate a title for a meeting using Claude
 */
export async function generateTitle(summary: string): Promise<string> {
    if (!claudeApiKey || !anthropic) {
        console.error('❌ No Claude API key found in auth.json or client initialization failed!');
        return `Meeting Transcript (${new Date().toLocaleDateString()})`;
    }
    
    console.log(`🏷️ Generating title using Claude...`);
    
    try {
        const date = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
        
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 50,
            system: `You are a helpful assistant that creates concise, descriptive titles for meeting summaries.
                
Instructions:
1. Read the meeting summary and identify the main topic or purpose of the meeting.
2. Create a title that is brief (3-5 words) but descriptive of the meeting content.
3. Include the date (${date}) in parentheses at the end of the title.
4. Format should be: "Main Topic (${date})"
5. Examples: "Product Roadmap Discussion (${date})", "Team Standup Meeting (${date})", "Client Onboarding Call (${date})"

Your response should ONLY include the title, nothing else.`,
            messages: [
                {
                    role: 'user',
                    content: summary
                }
            ]
        });
        
        // Check if the content is a text block
        if (response.content[0].type === 'text') {
            const title = response.content[0].text.trim();
            console.log(`✅ Generated title: ${title}`);
            return title;
        } else {
            console.error('❌ Unexpected response format from Claude');
            return `Meeting Transcript (${new Date().toLocaleDateString()})`;
        }
    } catch (error) {
        console.error(`❌ Error generating title: ${error}`);
        return `Meeting Transcript (${new Date().toLocaleDateString()})`;
    }
}

function splitSummaryIntoSections(summary: string): string[] {
    const trimmed = summary.trim();
    if (!trimmed) return [];

    // Split only at section boundaries; each block starts with an H3 heading.
    const sections = trimmed
        .split(/\n(?=###\s)/g)
        .map(section => section.trim())
        .filter(Boolean);

    return sections.length > 0 ? sections : [trimmed];
}

function chunkSectionsForDiscord(
    title: string,
    recordedUsers: string[],
    summary: string,
    discordCharLimit = 1950
): string[] {
    const header = `**${title}**\n\n**Recording finished for:** ${recordedUsers.join(', ')}\n\n**Summary:**\n`;
    const sections = splitSummaryIntoSections(summary);

    // Fast path: one message fits.
    const fullMessage = `${header}${summary}`;
    if (fullMessage.length <= discordCharLimit) return [fullMessage];

    // Build messages using whole sections only. Only the first message includes metadata/header.
    const messages: string[] = [];
    let current = header;

    for (const section of sections) {
        const separator = current.endsWith('\n') ? '' : '\n\n';
        const candidate = `${current}${separator}${section}`;

        if (candidate.length <= discordCharLimit) {
            current = candidate;
            continue;
        }

        // Commit current message and start a new message with only remaining summary sections.
        if (current !== header) {
            messages.push(current);
            current = section;
            continue;
        }

        // If a single section cannot fit even alone, send it whole in its own message.
        // This preserves "no split within a section" even if Discord rejects due size.
        messages.push(current);
        current = section;
    }

    if (current !== header) {
        messages.push(current);
    }

    return messages;
}

/**
 * Send transcript and summary to the transcript channel
 */
export async function sendTranscriptAndSummary(
    client: Client,
    guildId: string,
    transcript: string,
    summary: string,
    title: string,
    recordedUsers: string[]
) {
    try {
        // Log the Claude-generated summary
        console.log(`🤖 Claude-generated summary:\n${summary}`);
        
        // Get the transcript channel
        const transcriptChannel = await getTranscriptChannel(client);
        if (!transcriptChannel) {
            console.error(`❌ Could not find transcript channel`);
            return;
        }
        
        // Split summary into one or more Discord-safe messages at section boundaries.
        const summaryMessages = chunkSectionsForDiscord(title, recordedUsers, summary, 1950);
        console.log(`📨 Sending summary in ${summaryMessages.length} message(s)`);

        for (const [index, message] of summaryMessages.entries()) {
            if (message.length > 1950) {
                console.error(`❌ Summary message part ${index + 1} exceeds Discord limit (${message.length} chars).`);
            }
            await transcriptChannel.send(message);
        }
        
        // Format the transcript in markdown
        const transcriptMd = `# ${title}\n\n${transcript}`;
        
        // Create transcript file
        const transcriptDir = path.join(process.cwd(), 'transcripts');
        if (!fs.existsSync(transcriptDir)) {
            fs.mkdirSync(transcriptDir, { recursive: true });
        }
        
        const filename = `transcript-${Date.now()}.md`;
        const filepath = path.join(transcriptDir, filename);
        
        fs.writeFileSync(filepath, transcriptMd);
        
        // Create file attachment
        const attachment = new AttachmentBuilder(filepath, { name: filename });
        
        // Send the transcript file
        await transcriptChannel.send({
            content: '**Full Transcript:**',
            files: [attachment]
        });
        
        console.log(`✅ Sent transcript and summary to ${transcriptChannel.name}`);
        return true;
    } catch (error) {
        console.error(`❌ Error sending transcript and summary: ${error}`);
        return false;
    }
} 
