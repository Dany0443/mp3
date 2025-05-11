const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const ytdl = require('ytdl-core');
// Add alternative YouTube downloaders for fallback
let ytdlDiscord;
let ytdlpExec, youtubeDlExec;
try {
    ytdlDiscord = require('ytdl-core-discord');
} catch (e) {
    console.log('ytdl-core-discord not available, will skip this fallback');
}
try {
    ytdlpExec = require('yt-dlp-exec');
} catch (e) {
    console.log('yt-dlp-exec not available, will skip this fallback');
}
try {
    youtubeDlExec = require('youtube-dl-exec');
} catch (e) {
    console.log('youtube-dl-exec not available, will skip this fallback');
}
const { exec } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const util = require('util');
const execPromise = util.promisify(exec);

// Configure ffmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);

// Create Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));

// Create downloads directory if it doesn't exist
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
}

// Store active downloads
const activeDownloads = new Map();

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Get video info
app.get('/api/video-info', async (req, res) => {
    const { url } = req.query;
    
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }
    
    try {
        // Validate YouTube URL
        if (!ytdl.validateURL(url)) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }
        
        try {
            // Get video info with retry mechanism
            const info = await getVideoInfoWithRetry(url, 3);
            
            // Extract relevant data
            const videoData = {
                title: info.videoDetails.title,
                author: info.videoDetails.author.name,
                lengthSeconds: parseInt(info.videoDetails.lengthSeconds),
                thumbnailUrl: info.videoDetails.thumbnails[0].url
            };
            
            res.json(videoData);
        } catch (ytdlError) {
            console.error('YouTube extraction error:', ytdlError);
            res.status(500).json({ 
                error: 'Error fetching video information. YouTube may have changed their API.',
                message: ytdlError.message
            });
        }
    } catch (error) {
        console.error('Error in video info route:', error);
        res.status(500).json({ error: 'Failed to process video information request' });
    }
});

// Helper function to retry getting video info with multiple libraries
async function getVideoInfoWithRetry(url, maxRetries) {
    let lastError;
    
    // First try with yt-dlp-exec (most reliable)
    if (ytdlpExec) {
        try {
            console.log('Attempting to get info with yt-dlp-exec');
            const info = await ytdlpExec(url, {
                dumpSingleJson: true,
                noCheckCertificate: true,
                noWarnings: true,
                preferFreeFormats: true,
                addHeader: [
                    'referer:youtube.com',
                    'user-agent:Mozilla/5.0'
                ]
            });
            return {
                videoDetails: {
                    title: info.title,
                    author: { name: info.uploader },
                    lengthSeconds: parseInt(info.duration),
                    thumbnails: [{ url: info.thumbnail }]
                }
            };
        } catch (ytDlpError) {
            console.log('yt-dlp-exec attempt failed:', ytDlpError.message);
            lastError = ytDlpError;
        }
    }

    // Try youtube-dl-exec if available
    if (youtubeDlExec) {
        try {
            console.log('Attempting to get info with youtube-dl-exec');
            const info = await youtubeDlExec(url, {
                dumpSingleJson: true,
                noCheckCertificate: true,
                noWarnings: true,
                preferFreeFormats: true,
                addHeader: [
                    'referer:youtube.com',
                    'user-agent:Mozilla/5.0'
                ]
            });
            return {
                videoDetails: {
                    title: info.title,
                    author: { name: info.uploader },
                    lengthSeconds: parseInt(info.duration),
                    thumbnails: [{ url: info.thumbnail }]
                }
            };
        } catch (ytDlExecError) {
            console.log('youtube-dl-exec attempt failed:', ytDlExecError.message);
            lastError = ytDlExecError;
        }
    }

    // Try ytdl-core as fallback
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`Attempting to get info with ytdl-core (${attempt}/${maxRetries})`);
            return await ytdl.getInfo(url);
        } catch (error) {
            console.log(`ytdl-core attempt ${attempt}/${maxRetries} failed:`, error.message);
            lastError = error;
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            }
        }
    }

    // Last resort: try ytdl-core-discord
    if (ytdlDiscord) {
        try {
            console.log('Attempting to get info with ytdl-core-discord');
            const basicInfo = await ytdlDiscord.getBasicInfo(url);
            return {
                videoDetails: {
                    title: basicInfo.videoDetails.title,
                    author: { name: basicInfo.videoDetails.author.name },
                    lengthSeconds: basicInfo.videoDetails.lengthSeconds,
                    thumbnails: basicInfo.videoDetails.thumbnails
                }
            };
        } catch (discordError) {
            console.log('ytdl-core-discord attempt failed:', discordError.message);
            lastError = discordError;
        }
    }

    // Last resort: try using youtube-dl command line if available
    try {
        console.log('Attempting last resort with youtube-dl command');
        const { stdout } = await execPromise(`youtube-dl --dump-json "${url}"`);
        const info = JSON.parse(stdout);
        return {
            videoDetails: {
                title: info.title,
                author: { name: info.uploader },
                lengthSeconds: parseInt(info.duration),
                thumbnails: [{ url: info.thumbnail }]
            }
        };
    } catch (ytdlError) {
        console.log('youtube-dl fallback failed:', ytdlError.message);
    }

    throw lastError;
}

// Start download
app.post('/api/download', (req, res) => {
    try {
        const { url, quality, filename, audioFormat = 'mp3' } = req.body;
        
        if (!url || !filename) {
            return res.status(400).json({ error: 'URL and filename are required' });
        }
        
        // Generate unique ID for this download
        const downloadId = uuidv4();
        
        // Initialize download status
        activeDownloads.set(downloadId, {
            progress: 0,
            status: 'Initializing...',
            complete: false
        });
        
        // Process download in background
        processDownload(downloadId, url, quality, filename, audioFormat).catch(error => {
            console.error('Download process error:', error);
            updateDownloadStatus(downloadId, {
                status: `Error: ${error.message}`,
                error: true
            });
        });
        
        // Return download ID to client
        res.status(200).json({ id: downloadId });
    } catch (error) {
        console.error('Error in download route:', error);
        res.status(500).json({ error: 'Failed to start download' });
    }
});

// Download progress endpoint (SSE)
app.get('/api/download-progress/:id', (req, res) => {
    const downloadId = req.params.id;
    
    // Check if download exists
    if (!activeDownloads.has(downloadId)) {
        return res.status(404).json({ error: 'Download not found' });
    }
    
    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    // Send initial state
    const downloadData = activeDownloads.get(downloadId);
    sendSSE(res, downloadData);
    
    // Set up interval to send updates
    const intervalId = setInterval(() => {
        if (!activeDownloads.has(downloadId)) {
            clearInterval(intervalId);
            res.end();
            return;
        }
        
        const data = activeDownloads.get(downloadId);
        sendSSE(res, data);
        
        // If download is complete or has error, end the connection
        if (data.complete || data.error) {
            clearInterval(intervalId);
            
            // Clean up download data after a delay
            setTimeout(() => {
                activeDownloads.delete(downloadId);
            }, 60000); // Keep data for 1 minute
            
            res.end();
        }
    }, 1000);
    
    // Handle client disconnect
    req.on('close', () => {
        clearInterval(intervalId);
    });
});

// Serve downloaded files
app.get('/downloads/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(downloadsDir, filename);
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }
    
    res.download(filePath);
});

// Helper function to send SSE data
function sendSSE(res, data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// Process download
async function processDownload(downloadId, url, quality, filename, audioFormat = 'mp3') {
    try {
        // Update status
        updateDownloadStatus(downloadId, {
            status: 'Preparing download...'
        });
        // Create file paths
        const sanitizedFilename = filename.replace(/[\/:*?"<>|]/g, '_');
        const outputPath = path.join(downloadsDir, sanitizedFilename);
        const tempPath = path.join(downloadsDir, `temp_${sanitizedFilename}`);

        try {
            // Get video info first to validate the URL is still working
            await getVideoInfoWithRetry(url, 2);
            updateDownloadStatus(downloadId, {
                status: 'Downloading audio stream...'
            });

            // Try multiple download methods
            let audioStream;
            let downloadMethod = 'yt-dlp-exec';
            let useYoutubeDL = false;

            // First try with yt-dlp-exec (most reliable)
            if (ytdlpExec) {
                try {
                    updateDownloadStatus(downloadId, {
                        status: 'Downloading with yt-dlp (recommended method)...'
                    });
                    const ytDlpProcess = ytdlpExec(url, {
                        output: tempPath,
                        format: 'bestaudio/best',
                        extractAudio: true,
                        audioFormat: audioFormat,
                        audioQuality: quality === 'high' ? '0' : '5',
                        noCheckCertificate: true,
                        noWarnings: true,
                        preferFreeFormats: true,
                        ffmpegLocation: ffmpegPath,
                        addHeader: [
                            'referer:youtube.com',
                            'user-agent:Mozilla/5.0'
                        ]
                    });
                    
                    // Log ffmpeg path for debugging
                    console.log('Using ffmpeg path:', ffmpegPath);

                    // Handle yt-dlp process - it returns a promise, not an event emitter
                    // We need to await the promise instead of attaching event listeners
                    try {
                        // Wait for the yt-dlp process to complete
                        await ytDlpProcess;
                        
                        updateDownloadStatus(downloadId, {
                            progress: 100,
                            status: 'Download completed, processing file...'
                        });
                        
                        // Check for the file with appropriate extension
                        const possibleExtensions = ['.webm', `.${audioFormat}`];
                        let foundFile = false;
                        
                        for (const ext of possibleExtensions) {
                            if (fs.existsSync(tempPath + ext)) {
                                fs.renameSync(tempPath + ext, outputPath);
                                foundFile = true;
                                break;
                            }
                        }
                        
                        if (foundFile) {
                            // Update status to complete with download URL
                            updateDownloadStatus(downloadId, {
                                progress: 100,
                                status: 'Download complete!',
                                complete: true,
                                downloadUrl: `/downloads/${sanitizedFilename}`
                            });
                            return;
                        } else {
                            throw new Error('Downloaded file not found after yt-dlp completed');
                        }
                    } catch (innerError) {
                        console.error('Error during yt-dlp download process:', innerError);
                        throw innerError; // Re-throw to be caught by the outer catch block
                    }
                } catch (ytDlpError) {
                    console.error('yt-dlp-exec download failed:', ytDlpError);
                    downloadMethod = 'youtube-dl-exec';
                }
            }

            // Try youtube-dl-exec if yt-dlp failed
            if (youtubeDlExec && !audioStream) {
                try {
                    updateDownloadStatus(downloadId, {
                        status: 'Trying alternative download method (youtube-dl-exec)...'
                    });
                    
                    // Use youtube-dl-exec with ffmpeg path
                    const ytDlProcess = youtubeDlExec(url, {
                        output: tempPath,
                        format: 'bestaudio/best',
                        extractAudio: true,
                        audioFormat: audioFormat,
                        audioQuality: quality === 'high' ? '0' : '5',
                        ffmpegLocation: ffmpegPath,
                        noCheckCertificate: true,
                        noWarnings: true,
                        preferFreeFormats: true,
                        addHeader: [
                            'referer:youtube.com',
                            'user-agent:Mozilla/5.0'
                        ]
                    });
                    
                    // Wait for the process to complete
                    await ytDlProcess;
                    
                    // Check for file with the appropriate extension
                    const finalPath = fs.existsSync(tempPath + `.${audioFormat}`) ? tempPath + `.${audioFormat}` : tempPath;
                    
                    if (fs.existsSync(finalPath)) {
                        fs.renameSync(finalPath, outputPath);
                        
                        // Update status to complete with download URL
                        updateDownloadStatus(downloadId, {
                            progress: 100,
                            status: 'Download complete with youtube-dl-exec!',
                            complete: true,
                            downloadUrl: `/downloads/${sanitizedFilename}`
                        });
                        return;
                    } else {
                        throw new Error('Downloaded file not found after youtube-dl-exec completed');
                    }
                    
                } catch (ytDlExecError) {
                    console.error('youtube-dl-exec download failed:', ytDlExecError);
                    downloadMethod = 'ytdl-core';
                }
            }

            // Try ytdl-core if previous methods failed
            if (!audioStream) {
                try {
                    updateDownloadStatus(downloadId, {
                        status: 'Trying alternative download method (ytdl-core)...'
                    });
                    
                    // Use a more reliable approach with ytdl-core
                    const info = await ytdl.getInfo(url);
                    const format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });
                    console.log('Selected format:', format);
                    
                    // Download directly to file instead of streaming
                    const writeStream = fs.createWriteStream(tempPath);
                    ytdl(url, {
                        format: format,
                        filter: 'audioonly'
                    }).pipe(writeStream);
                    
                    await new Promise((resolve, reject) => {
                        writeStream.on('finish', resolve);
                        writeStream.on('error', reject);
                    });
                    
                    // Convert the downloaded file with ffmpeg
                    await new Promise((resolve, reject) => {
                        const ffmpegCommand = ffmpeg(tempPath)
                            .audioBitrate(quality)
                            .format(audioFormat);
                            
                        ffmpegCommand
                            .on('end', resolve)
                            .on('error', reject)
                            .save(outputPath);
                    });
                    
                    // Update status to complete with download URL
                    updateDownloadStatus(downloadId, {
                        progress: 100,
                        status: 'Download complete!',
                        complete: true,
                        downloadUrl: `/downloads/${sanitizedFilename}`
                    });
                    return;
                    
                } catch (ytdlError) {
                    console.error('ytdl-core download failed:', ytdlError);
                    useYoutubeDL = true;
                }
            }

            // If all JS-based methods failed, try system youtube-dl as last resort
            if (useYoutubeDL) {
                updateDownloadStatus(downloadId, {
                    status: 'Trying system youtube-dl as last resort...'
                });
                const { spawn } = require('child_process');
                const ytdlProc = spawn('youtube-dl', [
                    '-f', 'bestaudio',
                    '-o', '-',
                    url
                ]);
                audioStream = ytdlProc.stdout;
                ytdlProc.stderr.on('data', (data) => {
                    console.error(`youtube-dl stderr: ${data}`);
                });
                ytdlProc.on('error', (err) => {
                    updateDownloadStatus(downloadId, {
                        status: 'youtube-dl not found or failed to start',
                        error: err.message
                    });
                });
            }

            if (!audioStream) {
                throw new Error('Failed to initialize audio stream with any available method');
            }

            // Add error handler for audioStream
            audioStream.on('error', (err) => {
                console.error('Audio stream error:', err);
                updateDownloadStatus(downloadId, {
                    status: 'Error in audio stream',
                    error: err.message
                });
            });

            // Pipe audio stream to ffmpeg for mp3 conversion
            const ffmpegProcess = ffmpeg(audioStream)
                .audioBitrate(quality === 'high' ? 320 : 128)
                .format('mp3')
                .on('progress', (progress) => {
                    if (progress.percent) {
                        updateDownloadStatus(downloadId, {
                            progress: Math.round(progress.percent),
                            status: `Converting to MP3... (${Math.round(progress.percent)}%)`
                        });
                    }
                })
                .on('end', () => {
                    updateDownloadStatus(downloadId, {
                        progress: 100,
                        status: 'Download complete!',
                        complete: true,
                        downloadUrl: `/downloads/${sanitizedFilename}`
                    });
                    // Cleanup temp files
                    if (fs.existsSync(tempPath)) {
                        try {
                            fs.unlinkSync(tempPath);
                        } catch (err) {
                            console.error('Error cleaning up temp file:', err);
                        }
                    }
                    // Log successful download path for debugging
                    console.log('Download complete, file available at:', outputPath);
                })
                .on('error', (err) => {
                    console.error('FFmpeg error:', err);
                    updateDownloadStatus(downloadId, {
                        status: 'Error during conversion',
                        error: err.message
                    });
                })
                .save(outputPath);

        } catch (error) {
            console.error('Download process error:', error);
            updateDownloadStatus(downloadId, {
                status: 'Download failed',
                error: error.message
            });
            // Cleanup temp files on error
            if (fs.existsSync(tempPath)) {
                try {
                    fs.unlinkSync(tempPath);
                } catch (err) {
                    console.error('Error cleaning up temp file:', err);
                }
            }
        }
    } catch (error) {
        console.error('Unexpected error:', error);
        updateDownloadStatus(downloadId, {
            status: 'Unexpected error',
            error: error.message
        });
    }
}

// Update download status
function updateDownloadStatus(downloadId, updates) {
    if (!activeDownloads.has(downloadId)) return;
    
    const currentData = activeDownloads.get(downloadId);
    activeDownloads.set(downloadId, { ...currentData, ...updates });
}

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});