# Discord Transcription Bot

A Discord bot that joins voice channels, records audio, and generates transcripts using Deepgram's speech-to-text API.

## Features

- Join voice channels and record audio
- Transcribe speech in real-time using Deepgram
- Generate summaries of conversations using Claude AI
- Automatically handle voice channel events
- Command-based recording control

## Local Development

1. Clone the repository
2. Install dependencies: `npm install`
3. Create an `auth.json` file based on `auth.sample.json`
4. Build the TypeScript code: `npm run build`
5. Start the bot: `npm start`

## Deploying to Heroku

### Prerequisites

- Heroku CLI installed and logged in
- A Discord bot token
- A Deepgram API key
- (Optional) A Claude API key for summaries

### Deployment Steps

1. Create a new Heroku app:
   ```
   heroku create --team sacra discord-transcription-bot
   ```

2. Set the required environment variables:
   ```
   heroku config:set DISCORD_TOKEN=your_discord_token
   heroku config:set DEEPGRAM_TOKEN=your_deepgram_token
   heroku config:set CLAUDE_API_KEY=your_claude_api_key
   heroku config:set DEFAULT_CHANNEL=transcripts
   heroku config:set TRANSCRIPT_CHANNEL_ID=your_transcript_channel_id
   ```

3. Deploy the app:
   ```
   git push heroku main
   ```

4. Scale the worker dyno (Heroku doesn't automatically start worker dynos):
   ```
   heroku ps:scale worker=1
   ```

### Updating the Bot

To update the bot after making changes:

1. Commit your changes to git
2. Push to Heroku: `git push heroku main`

## Commands

- `/join` - Joins the voice channel you're in
- `/record` - Starts recording everyone in the voice channel
- `/leave` - Leaves the voice channel
- `/stop_recording` - Stops recording, leaves the channel, and discards the transcript/summary

## Environment Variables

- `DISCORD_TOKEN` - Your Discord bot token
- `DEEPGRAM_TOKEN` - Your Deepgram API key
- `CLAUDE_API_KEY` - Your Claude API key (optional)
- `DEFAULT_CHANNEL` - The default channel for transcripts
- `TRANSCRIPT_CHANNEL_ID` - The ID of the channel to send transcripts to

## Updates

The bot has been updated to use:
- Discord.js v14.14.1
- @discordjs/voice v0.18.0
- Deepgram SDK v3.9.0

## Setup

1. Make sure you have Node.js installed (preferably version 16.x or later)

2. Install dependencies:
```bash
npm install
```

3. Create an `auth.json` file in the root directory with the following content:
```json
{
  "token": "YOUR_DISCORD_BOT_TOKEN",
  "deepgram_token": "YOUR_DEEPGRAM_API_KEY",
  "defaultChannel": "transcription"
}
```

4. Replace `YOUR_DISCORD_BOT_TOKEN` with your Discord bot token and `YOUR_DEEPGRAM_API_KEY` with your Deepgram API key.

5. Build the project:
```bash
npm run build
```

6. Start the bot:
```bash
npm start
```

## Usage

1. Invite the bot to your Discord server with the following permissions:
   - Bot
   - Applications.Commands
   - Send Messages
   - Manage Webhooks
   - Connect to Voice Channels
   - Use Voice Activity

2. Type `!deploy` in any channel to register the slash commands
3. Use `/join` to make the bot join your voice channel
4. Use `/record @user` to start transcribing a specific user's voice
5. Use `/leave` to make the bot leave the voice channel

## Troubleshooting

### Native Module Build Issues

If you encounter issues with building native modules like `@discordjs/opus`, you may need to:

1. Install build tools for your platform:
   - **Windows**: `npm install --global windows-build-tools`
   - **macOS**: Install Xcode Command Line Tools with `xcode-select --install`
   - **Linux**: Install build-essential package (`sudo apt-get install build-essential`)

2. Try using a different version of Node.js (16.x or 18.x are recommended)

3. If you're on Apple Silicon (M1/M2/M3), you might need to use Rosetta:
   ```bash
   arch -x86_64 npm install
   ```

### Discord.js v14 Issues

- Make sure your bot has the correct intents enabled in the Discord Developer Portal
- The bot now requires the `MessageContent` intent to read message content
- Webhook creation has been updated to use the new API

### Deepgram API Issues

- Make sure your Deepgram API key is valid and has the necessary permissions
- Check that you have sufficient credits in your Deepgram account
- The bot now uses the latest Deepgram SDK (v3.9.0) with the nova-3 model
