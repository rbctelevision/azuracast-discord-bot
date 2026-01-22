import { Client, GatewayIntentBits, ActivityType, SlashCommandBuilder, REST, Routes, EmbedBuilder, PermissionFlagsBits, ChannelType, MessageFlags } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, getVoiceConnection, entersState, VoiceConnectionStatus as VCS, StreamType } from '@discordjs/voice';
import axios from 'axios';
import dotenv from 'dotenv';
import { fetch } from 'undici';
import { MongoClient } from 'mongodb';

// Load and initialize encryption library
let encryptionReady = false;
let encryptionErrorOccurred = false;

// Try to initialize libsodium-wrappers first, then fallback to tweetnacl
(async () => {
    try {
        const libsodium = await import('libsodium-wrappers');
        await libsodium.default.ready;
        encryptionReady = true;
        console.log('libsodium-wrappers initialized successfully');
    } catch (error) {
        console.log('libsodium-wrappers not available, using tweetnacl');
        // tweetnacl should be available as it's in dependencies
        encryptionReady = true;
    }
})();

dotenv.config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

// Radio station configuration (configurable via environment variables)
const STREAM_URL = process.env.STREAM_URL || 'https://azura.rbctelevision.org/listen/rbcradio/radio.mp3';
const API_URL = process.env.API_URL || 'https://azura.rbctelevision.org/api/nowplaying/rbcradio';
const REQUESTS_URL = process.env.REQUESTS_URL || 'https://www.rbctelevision.org/radio';
const SPOTIFY_API_URL = 'https://api.spotify.com/v1';
const USER_AGENT = process.env.USER_AGENT || 'rbctelevision-radio-bot/1.0 (Icecast client; bot.rbctv.xyz; contact: nate@rbctv.xyz)';

// Create axios instance with custom user agent
const axiosInstance = axios.create({
    headers: {
        'User-Agent': USER_AGENT
    }
});

let currentVoiceChannel = null;
let audioPlayer = null;
let connection = null;
let statusUpdateInterval = null;
let nowPlayingCache = { song: '', artist: '', art: '', spotifyUrl: '', isLive: false, streamerName: '' };
let shouldStayConnected = true;
let mongoClient = null;
let db = null;
let reconnectAttempts = {}; // Track reconnect attempts per guild
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BACKOFF_MS = 2000; // Base backoff time
const DEBUG_ENDPOINT = 'http://127.0.0.1:7242/ingest/65adcaca-c989-4b88-87ed-f71a63d67458';

// Helper function to send debug logs to monitoring endpoint
async function sendDebugLog(location, message, data = {}) {
    try {
        await fetch(DEBUG_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                location,
                message,
                data,
                timestamp: Date.now(),
                sessionId: 'debug-session',
                runId: 'run1'
            })
        }).catch(() => {}); // Silently fail if endpoint is unavailable
    } catch (error) {
        // Ignore debug logging errors
    }
}

// MongoDB connection
async function connectToMongoDB() {
    try {
        const mongoUri = process.env.MONGODB_URI;
        if (!mongoUri) {
            console.log('MONGODB_URI not set, skipping MongoDB connection');
            return false;
        }
        mongoClient = new MongoClient(mongoUri);
        await mongoClient.connect();
        db = mongoClient.db('rbc_radio_bot');
        console.log('Connected to MongoDB');
        return true;
    } catch (error) {
        console.error('Error connecting to MongoDB:', error.message);
        console.log('Continuing without MongoDB persistence...');
        return false;
    }
}

// Save voice channel to database
async function saveVoiceChannel(guildId, channelId) {
    if (!db) return;
    
    try {
        const collection = db.collection('voice_channels');
        await collection.updateOne(
            { guildId: guildId },
            { $set: { channelId: channelId, updatedAt: new Date() } },
            { upsert: true }
        );
        console.log(`Saved VC: Guild ${guildId}, Channel ${channelId}`);
    } catch (error) {
        console.error('Error saving voice channel:', error.message);
    }
}

// Get saved voice channel from database
async function getSavedVoiceChannel(guildId) {
    if (!db) return null;
    
    try {
        const collection = db.collection('voice_channels');
        const doc = await collection.findOne({ guildId: guildId });
        return doc ? doc.channelId : null;
    } catch (error) {
        console.error('Error getting saved voice channel:', error.message);
        return null;
    }
}

// Clear saved voice channel
async function clearSavedVoiceChannel(guildId) {
    if (!db) return;
    
    try {
        const collection = db.collection('voice_channels');
        await collection.deleteOne({ guildId: guildId });
        console.log(`Cleared saved VC for Guild ${guildId}`);
    } catch (error) {
        console.error('Error clearing saved voice channel:', error.message);
    }
}

// Get Spotify access token (if credentials are provided)
async function getSpotifyToken() {
    if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
        return null;
    }
    
    try {
        const response = await axiosInstance.post(
            'https://accounts.spotify.com/api/token',
            'grant_type=client_credentials',
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Basic ${Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64')}`
                }
            }
        );
        return response.data.access_token;
    } catch (error) {
        console.error('Error getting Spotify token:', error.message);
        return null;
    }
}

// Search Spotify for track and get artwork
async function getSpotifyArtwork(artist, title) {
    const token = await getSpotifyToken();
    if (!token) {
        console.log('Spotify credentials not configured - skipping Spotify artwork lookup');
        return null;
    }
    
    try {
        // Clean up artist and title for better search results
        const cleanArtist = artist.replace(/\([^)]*\)/g, '').trim();
        const cleanTitle = title.replace(/\([^)]*\)/g, '').trim();
        const query = `artist:"${cleanArtist}" track:"${cleanTitle}"`;
        
        console.log(`Searching Spotify for: ${query}`);
        
        const response = await axiosInstance.get(`${SPOTIFY_API_URL}/search`, {
            headers: {
                'Authorization': `Bearer ${token}`
            },
            params: {
                q: query,
                type: 'track',
                limit: 5  // Get more results for better matching
            },
            timeout: 5000 // 5 second timeout for Spotify API
        });
        
        if (response.data.tracks && response.data.tracks.items && response.data.tracks.items.length > 0) {
            const track = response.data.tracks.items[0];
            // Get highest resolution image (first in array is usually the largest)
            if (track.album && track.album.images && track.album.images.length > 0) {
                const artworkUrl = track.album.images[0].url;
                console.log(`Found Spotify artwork for "${title}"`);
                return artworkUrl;
            }
        } else {
            console.log(`No Spotify results found for "${title}" by "${artist}"`);
        }
    } catch (error) {
        console.error('Error searching Spotify:', error.response?.data?.error?.message || error.message);
        if (error.response?.status === 401) {
            console.error('Spotify token invalid - check SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET');
        }
    }
    
    return null;
}

// Fetch now playing information from Azura API
async function fetchNowPlaying() {
    try {
        const response = await axiosInstance.get(API_URL, { timeout: 5000 });
        const data = response.data;
        
        if (data.now_playing && data.now_playing.song) {
            const song = data.now_playing.song;
            const title = song.title || 'Unknown Title';
            const artist = song.artist || 'Unknown Artist';
            
            // Check if someone is actively streaming (live DJ)
            const isLive = data.live && data.live.is_live === true;
            const streamerName = data.live && data.live.streamer_name ? data.live.streamer_name : '';
            
            // Get artwork from Spotify first (higher quality)
            let art = await getSpotifyArtwork(artist, title);
            
            // Fall back to Azura art if Spotify doesn't have it
            if (!art && song.art) {
                art = song.art;
                console.log(`Using Azura artwork for "${title}"`);
            }
            
            // Check if Spotify link exists in API response, otherwise construct search URL
            let spotifyUrl = 'https://open.spotify.com';
            if (song.links && song.links.spotify) {
                spotifyUrl = song.links.spotify;
            } else {
                // Construct Spotify search URL
                const searchQuery = encodeURIComponent(`${artist} ${title}`);
                spotifyUrl = `https://open.spotify.com/search/${searchQuery}`;
            }
            
            nowPlayingCache = {
                song: title,
                artist: artist,
                art: art || '',
                spotifyUrl: spotifyUrl,
                isLive: isLive,
                streamerName: streamerName
            };
            
            return nowPlayingCache;
        }
    } catch (error) {
        console.error('Error fetching now playing:', error.message);
        return null;
    }
}

// Update bot status with currently playing song
async function updateStatus() {
    const np = await fetchNowPlaying();
    if (np && np.song && np.artist) {
        let statusText = `${np.artist} - ${np.song}`;
        
        // Add live streaming indicator if someone is actively streaming
        if (np.isLive && np.streamerName) {
            statusText = `🔴 LIVE: ${np.streamerName} | ${np.artist} - ${np.song}`;
        }
        
        // Set the activity with the status text
        client.user.setActivity(statusText, { 
            type: ActivityType.Listening
        });
    }
}

// Create audio resource from stream URL by fetching manually (for proper User-Agent control)
async function createStreamResource() {
    try {
        // Fetch the stream manually with custom User-Agent header
        const response = await fetch(STREAM_URL, {
            headers: {
                'User-Agent': USER_AGENT
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch stream: ${response.status} ${response.statusText}`);
        }

        // Create audio resource from the response body stream
        const resource = createAudioResource(response.body, {
            inputType: StreamType.Arbitrary,
            inlineVolume: false,
            metadata: {
                title: 'RBC Radio Live Stream'
            }
        });

        console.log('Audio resource created successfully');
        return resource;
    } catch (error) {
        console.error('Error creating audio resource:', error);
        return null;
    }
}

// Helper to get backoff time with exponential increase
function getReconnectBackoff(guildId) {
    const attempts = reconnectAttempts[guildId] || 0;
    return RECONNECT_BACKOFF_MS * Math.pow(2, Math.min(attempts, 3)); // Cap at 16 seconds
}

// Reset reconnect counter for a guild
function resetReconnectCounter(guildId) {
    delete reconnectAttempts[guildId];
}

// Increment reconnect counter for a guild
function incrementReconnectCounter(guildId) {
    reconnectAttempts[guildId] = (reconnectAttempts[guildId] || 0) + 1;
}

// Connect to voice channel and play stream
async function connectToVoiceChannel(channel) {
    // Don't attempt connection if encryption has failed
    if (encryptionErrorOccurred) {
        console.error('Cannot connect - encryption error has occurred. Please check encryption library installation.');
        sendDebugLog('bot.js:connectToVoiceChannel', 'Connection blocked due to encryption error', {
            channelId: channel.id,
            guildId: channel.guild.id,
            encryptionErrorOccurred
        });
        return false;
    }
    
    try {
        shouldStayConnected = true;
        sendDebugLog('bot.js:connectToVoiceChannel', 'shouldStayConnected set to true', {
            channelId: channel.id,
            guildId: channel.guild.id
        });
        
        // Disconnect from previous channel if exists
        if (currentVoiceChannel && connection) {
            try {
                if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                    connection.destroy();
                }
            } catch (error) {
                console.log('Connection already destroyed:', error.message);
            }
            connection = null;
        }
        
        // Also check for any existing connection in the guild
        if (channel.guild) {
            const existingConnection = getVoiceConnection(channel.guild.id);
            if (existingConnection) {
                try {
                    if (existingConnection.state.status !== VoiceConnectionStatus.Destroyed) {
                        existingConnection.destroy();
                    }
                } catch (error) {
                    console.log('Existing connection already destroyed:', error.message);
                }
            }
        }

        // Stop existing audio player
        if (audioPlayer) {
            audioPlayer.stop();
        }

        connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator,
        });

        // Wait for connection to be ready (10 second timeout)
        try {
            await entersState(connection, VCS.Ready, 10000);
            console.log(`Connected to voice channel: ${channel.name}`);
            resetReconnectCounter(channel.guild.id);
            sendDebugLog('bot.js:connectToVoiceChannel', 'Connection reached Ready state', {
                channelId: channel.id,
                guildId: channel.guild.id
            });
        } catch (error) {
            console.error('Connection failed:', error.message);
            sendDebugLog('bot.js:connectToVoiceChannel', 'Connection failed to reach Ready', {
                error: error.message,
                channelId: channel.id,
                guildId: channel.guild.id
            });
            // Don't try to reconnect if it's an encryption error
            if (error.message && error.message.includes('encryption')) {
                console.error('Encryption error - check that libsodium-wrappers or tweetnacl is properly installed');
                shouldStayConnected = false;
                encryptionErrorOccurred = true;
            }
            try {
                if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
                    connection.destroy();
                }
            } catch (e) {
                // Ignore destroy errors
            }
            return false;
        }

        // Remove any existing Disconnected listeners to prevent duplicates
        connection.removeAllListeners(VoiceConnectionStatus.Disconnected);
        
        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            sendDebugLog('bot.js:Disconnected', 'Disconnected event fired', {
                shouldStayConnected,
                encryptionErrorOccurred,
                connectionState: connection?.state?.status,
                guildId: channel.guild.id
            });
            // Only reconnect if we should stay connected and encryption hasn't failed
            if (shouldStayConnected && !encryptionErrorOccurred) {
                console.log('Disconnected, attempting to reconnect...');
                try {
                    await Promise.race([
                        entersState(connection, VCS.Ready, 5000),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
                    ]);
                    resetReconnectCounter(channel.guild.id);
                } catch (error) {
                    sendDebugLog('bot.js:Disconnected', 'Disconnected reconnection attempt failed', {
                        error: error.message,
                        shouldStayConnected,
                        encryptionErrorOccurred,
                        guildId: channel.guild.id
                    });
                    // Check if it's an encryption error
                    if (error.message && error.message.includes('encryption')) {
                        console.error('Encryption error detected - stopping reconnection attempts');
                        shouldStayConnected = false;
                        encryptionErrorOccurred = true;
                        return;
                    }
                    
                    // Force reconnect only if shouldStayConnected and no encryption error
                    if (shouldStayConnected && !encryptionErrorOccurred && currentVoiceChannel) {
                        incrementReconnectCounter(channel.guild.id);
                        const attempts = reconnectAttempts[channel.guild.id];
                        
                        if (attempts > MAX_RECONNECT_ATTEMPTS) {
                            console.error(`Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) exceeded for guild ${channel.guild.id}`);
                            sendDebugLog('bot.js:Disconnected', 'Max reconnect attempts exceeded', {
                                attempts,
                                maxAttempts: MAX_RECONNECT_ATTEMPTS,
                                guildId: channel.guild.id
                            });
                            return;
                        }
                        
                        const backoff = getReconnectBackoff(channel.guild.id);
                        console.log(`Scheduling reconnection (attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS}) in ${backoff}ms...`);
                        sendDebugLog('bot.js:Disconnected', 'Scheduling reconnection', {
                            attempt: attempts,
                            maxAttempts: MAX_RECONNECT_ATTEMPTS,
                            backoffMs: backoff,
                            guildId: channel.guild.id
                        });
                        
                        setTimeout(async () => {
                            try {
                                // Clean up old connection first
                                if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
                                    try {
                                        connection.destroy();
                                    } catch (e) {
                                        // Ignore destroy errors
                                    }
                                }
                                
                                // Get fresh channel reference
                                const guild = await client.guilds.fetch(currentVoiceChannel.guild.id);
                                const freshChannel = await guild.channels.fetch(currentVoiceChannel.id);
                                
                                if (!freshChannel) {
                                    console.error('Channel no longer exists');
                                    return;
                                }
                                
                                connection = joinVoiceChannel({
                                    channelId: freshChannel.id,
                                    guildId: freshChannel.guild.id,
                                    adapterCreator: freshChannel.guild.voiceAdapterCreator,
                                });
                                
                                await entersState(connection, VCS.Ready, 10000);
                                resetReconnectCounter(freshChannel.guild.id);
                                
                                if (!audioPlayer) {
                                    audioPlayer = createAudioPlayer();
                                    setupAudioPlayer();
                                }
                                
                                connection.subscribe(audioPlayer);
                                const resource = await createStreamResource();
                                if (resource) {
                                    audioPlayer.play(resource);
                                }
                            } catch (error) {
                                console.error('Reconnection error:', error.message);
                                if (error.message && error.message.includes('encryption')) {
                                    shouldStayConnected = false;
                                    encryptionErrorOccurred = true;
                                }
                            }
                        }, backoff);
                    }
                }
            }
        });

        if (!audioPlayer) {
            audioPlayer = createAudioPlayer();
            setupAudioPlayer();
        }

        // Subscribe player to connection
        connection.subscribe(audioPlayer);
        
        // Create and play audio resource
        const resource = await createStreamResource();
        if (!resource) {
            console.error('Failed to create audio resource');
            return false;
        }
        
        audioPlayer.play(resource);
        console.log('Started playing audio stream');

        currentVoiceChannel = channel;
        resetReconnectCounter(channel.guild.id);
        
        // Save to database
        await saveVoiceChannel(channel.guild.id, channel.id);
        
        return true;
    } catch (error) {
        console.error('Error connecting to voice channel:', error);
        return false;
    }
}

// Setup audio player event handlers
function setupAudioPlayer() {
    // Remove existing listeners to avoid duplicates
    audioPlayer.removeAllListeners();
    
    audioPlayer.on(AudioPlayerStatus.Idle, async () => {
        if (shouldStayConnected) {
            console.log('Audio player idle, restarting stream...');
            const resource = await createStreamResource();
            if (resource) {
                audioPlayer.play(resource);
            } else {
                console.error('Failed to create resource for restart');
            }
        }
    });

    audioPlayer.on('error', error => {
        console.error('Audio player error:', error);
        // Restart on error only if should stay connected
        if (shouldStayConnected) {
            setTimeout(async () => {
                const resource = await createStreamResource();
                if (resource) {
                    audioPlayer.play(resource);
                } else {
                    console.error('Failed to create resource after error');
                }
            }, 1000);
        }
    });

    audioPlayer.on(AudioPlayerStatus.Playing, () => {
        console.log('Audio player is now playing');
    });

    audioPlayer.on(AudioPlayerStatus.Paused, () => {
        console.log('Audio player paused');
    });
}

// Disconnect from voice channel
async function disconnectFromVoiceChannel() {
    shouldStayConnected = false;
    
    if (audioPlayer) {
        audioPlayer.stop();
        audioPlayer = null;
    }
    
    if (connection) {
        try {
            if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                connection.destroy();
            }
        } catch (error) {
            console.log('Error destroying connection:', error.message);
        }
        connection = null;
    }
    
    const guild = currentVoiceChannel?.guild;
    if (guild) {
        const voiceConnection = getVoiceConnection(guild.id);
        if (voiceConnection) {
            try {
                if (voiceConnection.state.status !== VoiceConnectionStatus.Destroyed) {
                    voiceConnection.destroy();
                }
            } catch (error) {
                console.log('Error destroying voice connection:', error.message);
            }
        }
        
        // Clear from database
        await clearSavedVoiceChannel(guild.id);
        resetReconnectCounter(guild.id);
    }
    
    currentVoiceChannel = null;
    return true;
}

// Register slash commands
const commands = [
    new SlashCommandBuilder()
        .setName('setvc')
        .setDescription('Set the voice channel for the radio bot (Admin only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false)
        .addChannelOption(option =>
            option.setName('channel')
                .setDescription('The voice channel to connect to')
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildVoice)),
    
    new SlashCommandBuilder()
        .setName('leavevc')
        .setDescription('Leave the current voice channel (Admin only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false),
    
    new SlashCommandBuilder()
        .setName('requests')
        .setDescription('Get information about making song requests'),
    
    new SlashCommandBuilder()
        .setName('nowplaying')
        .setDescription('Show the currently playing song'),
    
    new SlashCommandBuilder()
        .setName('credits')
        .setDescription('Show credits and information about this bot'),
];

async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    try {
        console.log('Started refreshing application (/) commands.');

        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands },
        );

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
}

// Handle interactions
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'setvc') {
        // Ensure command is used in a guild
        if (!interaction.guild) {
            return interaction.reply({ content: 'This command can only be used in a server!', flags: MessageFlags.Ephemeral });
        }

        // Double check admin permission (backup check)
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: 'You need Administrator permissions to use this command!', flags: MessageFlags.Ephemeral });
        }

        const channel = interaction.options.getChannel('channel');
        
        // Validate that it's a voice channel (should already be restricted, but double-check)
        if (!channel || channel.type !== ChannelType.GuildVoice) {
            return interaction.reply({ content: 'Please select a valid voice channel!', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const success = await connectToVoiceChannel(channel);
        
        if (success) {
            await interaction.editReply({ content: `Connected to ${channel.name}! Playing radio stream...` });
        } else {
            await interaction.editReply({ content: 'Failed to connect to voice channel. Please check permissions.' });
        }
    }

    if (interaction.commandName === 'leavevc') {
        // Ensure command is used in a guild
        if (!interaction.guild) {
            return interaction.reply({ content: 'This command can only be used in a server!', flags: MessageFlags.Ephemeral });
        }

        // Double check admin permission (backup check)
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: 'You need Administrator permissions to use this command!', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (!currentVoiceChannel) {
            return interaction.editReply({ content: 'Bot is not connected to any voice channel!' });
        }

        const success = await disconnectFromVoiceChannel();
        
        if (success) {
            await interaction.editReply({ content: 'Disconnected from voice channel.' });
        } else {
            await interaction.editReply({ content: 'Failed to disconnect from voice channel.' });
        }
    }

    if (interaction.commandName === 'requests') {
        const embed = new EmbedBuilder()
            .setTitle('Make a Request!')
            .setDescription(`To request a song, please visit:\n${REQUESTS_URL}`)
            .setColor(0xE91E63) // Vibrant pink/magenta from image
            .setURL(REQUESTS_URL);

        await interaction.reply({ embeds: [embed] });
    }

    if (interaction.commandName === 'nowplaying') {
        await interaction.deferReply();

        const np = await fetchNowPlaying();
        
        if (np && np.song) {
            const embed = new EmbedBuilder()
                .setTitle('🎵 Now Playing')
                .setDescription(`**${np.song}**\nby ${np.artist}`)
                .setColor(0xE91E63) // Vibrant pink/magenta from image
                .addFields(
                    { name: '<:spotify:1463041463716937885> Spotify', value: `[Search on Spotify](${np.spotifyUrl})`, inline: true }
                );

            // Add live streaming indicator if someone is actively streaming
            if (np.isLive && np.streamerName) {
                embed.setDescription(`**LIVE:** ${np.streamerName} is currently on air!\n\n**${np.song}**\nby ${np.artist}`);
                embed.setColor(0xDC143C); // Deep red/crimson for live
            }

            // Set Spotify artwork (or fallback) as thumbnail only (top right)
            if (np.art && np.art.trim() !== '') {
                embed.setThumbnail(np.art);
            }

            await interaction.editReply({ embeds: [embed] });
        } else {
            await interaction.editReply({ content: 'Unable to fetch currently playing song. Please try again later.' });
        }
    }

    if (interaction.commandName === 'credits') {
        const embed = new EmbedBuilder()
            .setTitle('🎵 AzuraCast Discord Bot')
            .setDescription('A Discord bot that plays an AzuraCast live stream in a voice channel and provides information about currently playing songs.')
            .setColor(0xFF1744) // Vibrant red from image
            .addFields(
                { name: '👨‍💻 Creator', value: '[**RBC Television**](https://rbctelevision.org)', inline: true },
                { name: '🌐 Website', value: '[bot.rbctv.xyz](https://bot.rbctv.xyz)', inline: true },
                { name: '📦 Repository', value: '[GitHub](https://github.com/rbctelevision/azuracast-discord-bot)', inline: true }
            )
            .addFields(
                { name: '🔧 Technologies', value: '• Discord.js\n• AzuraCast API\n• Spotify API\n• MongoDB', inline: false }
            )
            .setFooter({ text: 'RBC Television © 2026', iconURL: 'https://avatars.githubusercontent.com/u/206373161?s=200&v=4' });

        await interaction.reply({ embeds: [embed] });
    }
});

// Bot ready
client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    
    // Connect to MongoDB
    await connectToMongoDB();
    
    // Register commands
    await registerCommands();
    
    // Restore previous voice channel connections
    await restoreVoiceChannels();
    
    // Update status every 30 seconds
    await updateStatus();
    statusUpdateInterval = setInterval(updateStatus, 30000);
    
    console.log('Bot is ready!');
});

// Restore voice channel connections from database
async function restoreVoiceChannels() {
    if (!db) {
        console.log('MongoDB not available, skipping VC restoration');
        return;
    }
    
    try {
        const collection = db.collection('voice_channels');
        const savedChannels = await collection.find({}).toArray();
        
        for (const savedChannel of savedChannels) {
            try {
                const guild = await client.guilds.fetch(savedChannel.guildId);
                const channel = await guild.channels.fetch(savedChannel.channelId);
                
                if (channel && channel.type === ChannelType.GuildVoice) {
                    console.log(`Restoring connection to ${channel.name} in ${guild.name}`);
                    await connectToVoiceChannel(channel);
                } else {
                    // Channel doesn't exist or is not a voice channel, remove from DB
                    console.log(`Removing invalid saved VC: ${savedChannel.guildId}/${savedChannel.channelId}`);
                    await clearSavedVoiceChannel(savedChannel.guildId);
                }
            } catch (error) {
                console.error(`Error restoring VC for guild ${savedChannel.guildId}:`, error.message);
                // Remove invalid entry
                await clearSavedVoiceChannel(savedChannel.guildId);
            }
        }
    } catch (error) {
        console.error('Error restoring voice channels:', error.message);
    }
}

// Handle disconnects and reconnects
client.on('voiceStateUpdate', async (oldState, newState) => {
    // If bot was disconnected from a channel, reconnect only if shouldStayConnected is true and no encryption error
    if (shouldStayConnected && !encryptionErrorOccurred && oldState.member?.id === client.user.id && oldState.channelId && !newState.channelId) {
        if (currentVoiceChannel && currentVoiceChannel.id === oldState.channelId) {
            console.log('Bot was disconnected, attempting to reconnect...');
            sendDebugLog('bot.js:voiceStateUpdate', 'Bot was disconnected, triggering reconnection', {
                shouldStayConnected,
                encryptionErrorOccurred,
                guildId: oldState.guild.id,
                channelId: oldState.channelId
            });
            
            incrementReconnectCounter(oldState.guild.id);
            const attempts = reconnectAttempts[oldState.guild.id];
            
            if (attempts > MAX_RECONNECT_ATTEMPTS) {
                console.error(`Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) exceeded`);
                sendDebugLog('bot.js:voiceStateUpdate', 'Max reconnect attempts exceeded', {
                    attempts,
                    maxAttempts: MAX_RECONNECT_ATTEMPTS,
                    guildId: oldState.guild.id
                });
                return;
            }
            
            const backoff = getReconnectBackoff(oldState.guild.id);
            console.log(`Scheduling reconnection (attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS}) in ${backoff}ms...`);
            sendDebugLog('bot.js:voiceStateUpdate', 'Scheduling reconnection with backoff', {
                attempt: attempts,
                maxAttempts: MAX_RECONNECT_ATTEMPTS,
                backoffMs: backoff,
                guildId: oldState.guild.id
            });
            
            setTimeout(async () => {
                if (shouldStayConnected && !encryptionErrorOccurred && currentVoiceChannel) {
                    try {
                        // Get fresh channel reference
                        const guild = await client.guilds.fetch(currentVoiceChannel.guild.id);
                        const channel = await guild.channels.fetch(currentVoiceChannel.id);
                        if (channel) {
                            await connectToVoiceChannel(channel);
                        }
                    } catch (error) {
                        console.error('Error reconnecting from voiceStateUpdate:', error.message);
                        if (error.message && error.message.includes('encryption')) {
                            encryptionErrorOccurred = true;
                            shouldStayConnected = false;
                        }
                    }
                }
            }, backoff);
        }
    }
});

// Keep process alive and handle errors
process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    
    if (mongoClient) {
        await mongoClient.close();
        console.log('MongoDB connection closed');
    }
    
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('Shutting down gracefully...');
    
    if (mongoClient) {
        await mongoClient.close();
        console.log('MongoDB connection closed');
    }
    
    process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);