# Azuracast Discord Bot
###### Created by Nate Wombwell for RBC
A Discord bot that plays an Azuracast live stream in a voice channel and provides information about currently playing songs.

> [!NOTE]
> If your just looking to add the RBC Radio bot in your server to enjoy some songs from RBC Radio, consider adding the bot [here.](https://discord.com/oauth2/authorize?client_id=1444607568776527957)

## Features

- 🎵 Plays the live stream in a voice channel
- 🎧 Shows currently playing song with artwork and Spotify link (if wanted)
- 📡 Updates bot status with the current song
- 🔗 Directs users to request songs via website
- 🔄 Automatically reconnects if disconnected (NEVER leaves VC)

## Setup

> [!WARNING]  
> The minimum required Node.JS version is v22

1. **Install FFmpeg** (Required for audio streaming)
   
   **Ubuntu/Debian:**
   ```bash
   sudo apt update
   sudo apt install ffmpeg
   ```
   
   **macOS:**
   ```bash
   brew install ffmpeg
   ```
   
   **Windows:**
   Download from https://ffmpeg.org/download.html and add to PATH

2. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Configure Environment Variables**
   
   Create a `.env` file in the root directory:
   ```env
   # REQUIRED
   DISCORD_TOKEN=your_discord_bot_token_here
   CLIENT_ID=your_discord_bot_client_id_here

   # Spotify Artwork Fetching
   SPOTIFY_CLIENT_ID=your_spotify_client_id_here (optional)
   SPOTIFY_CLIENT_SECRET=your_spotify_client_secret_here (optional)

   # If you want the bot to autorejoin after shutdown
   MONGODB_URI=

   # If you want to change from the RBC Radio Feed
   STREAM_URL=https://your-radio-station.com/stream.mp3
   API_URL=https://your-azuracast-instance.com/api/nowplaying/yourstation
   REQUESTS_URL=https://your-radio-website.com/requests
   USER_AGENT=your-bot-name/1.0 (Icecast client; your-info)
   ```

   To get these values:
   - **Discord**: Go to https://discord.com/developers/applications
     - Create a new application or select an existing one
     - Go to the "Bot" section to get your `DISCORD_TOKEN`
     - Go to the "General Information" section to get your `CLIENT_ID`
   - **Spotify** (Optional - for better artwork fetching):
     - Go to https://developer.spotify.com/dashboard
     - Create a new app
     - Get your Client ID and Client Secret
     - The bot will fall back to Azura artwork if Spotify credentials are not provided
   - **MongoDB** (Optional - Persistent Rejoining)
     ##### You can use your own MongoDB Database (for advanced users)
     ##### The below tutorial is for MongoDB Atlas
     - Create or sign in to a [MongoDB Atlas](https://cloud.mongodb.com) account
     - Create a new project, then deploy a cluster (Shared M0 is fine to start)
     - Add a database user (username + password) with read/write access
     - Go to Network Access and allow your server IP (or 0.0.0.0/0 temporarily for testing)
     - Open the cluster → click Connect
     - Select “Drivers” (or “Connect your application”)
     - Copy the provided connection string (URI)
     - Replace <username>, <password>, and <database> in the URI
     - Insert it into the .env file

3. **Invite Bot to Server**
   
   Replace `CLIENT_ID` with your bot's client ID:
   ```
   https://discord.com/api/oauth2/authorize?client_id=CLIENT_ID&permissions=3148800&scope=bot%20applications.commands
   ```
   
   Required permissions:
   - Connect to voice channels
   - Speak in voice channels
   - Use Slash Commands

4. **Start the Bot**
   ```bash
   node bot.js &
   ```

   **Kill the bot**
   ```bash
   pkill node
   ```

## Commands

**Admin Only:**
- `/setvc [channel]` - Set the voice channel for the radio bot to connect to (Admin only)
- `/leavevc` - Disconnect the bot from the current voice channel (Admin only)

**Public:**
- `/nowplaying` - Show the currently playing song with artwork and Spotify link
- `/requests` - Get information about making song requests
- `/credits` - Show credits and information about this bot

## Notes

- The bot will automatically reconnect if disconnected from the voice channel (unless manually disconnected via `/leavevc`)
- The bot status updates every 30 seconds with the currently playing song
- The stream URL is: https://azura.rbctelevision.org/listen/rbcradio/radio.mp3
- Now playing information is fetched from: https://azura.rbctelevision.org/api/nowplaying/rbcradio
- Artwork is fetched from Spotify when credentials are provided, otherwise falls back to Azura artwork
- VC commands (`/setvc` and `/leavevc`) require Administrator permissions

A Creation of [Nate Wombwell](https://github.com/natejwaus)
