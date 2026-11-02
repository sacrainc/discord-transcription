import * as fs from 'fs';
import * as path from 'path';

// Interface for our configuration
interface Config {
    token: string;
    defaultChannel: string;
    openaiApiKey?: string;
    deepgram_token?: string;
    transcriptChannelId?: string;
    voiceDebugLogs?: boolean;
}

// Try to load from auth.json first (for local development)
let config: Config;

try {
    // Check if auth.json exists
    if (fs.existsSync(path.join(__dirname, '../auth.json'))) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
        config = require('../auth.json');
        console.log('📄 Loaded configuration from auth.json');
    } else {
        // Load from environment variables (for Heroku)
        config = {
            token: process.env.DISCORD_TOKEN || '',
            defaultChannel: process.env.DEFAULT_CHANNEL || 'transcripts',
            openaiApiKey: process.env.OPENAI_API_KEY,
            deepgram_token: process.env.DEEPGRAM_TOKEN,
            transcriptChannelId: process.env.TRANSCRIPT_CHANNEL_ID,
            voiceDebugLogs: process.env.VOICE_DEBUG_LOGS === 'true'
        };
        console.log('🌐 Loaded configuration from environment variables');
    }

    // Environment credentials can supplement local auth.json without embedding secrets.
    config.openaiApiKey = process.env.OPENAI_API_KEY || config.openaiApiKey;

    // Validate required config
    if (!config.token) {
        throw new Error('No Discord bot token found in configuration!');
    }

} catch (error) {
    console.error('❌ Error loading configuration:', error);
    process.exit(1);
}

export default config; 
