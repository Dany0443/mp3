# YouTube MP3 Downloader

A modern, feature-rich application for downloading YouTube videos as high-quality MP3 files. This application provides a sleek user interface with advanced options for audio quality and filename customization.

## Features

- Download MP3 audio from any YouTube video
- Multiple audio quality options (320kbps, 256kbps, 192kbps, 128kbps)
- Customizable filename formats
- Real-time download progress tracking
- Responsive design for desktop and mobile devices

## Installation

1. Clone this repository:
   ```
   git clone https://github.com/Dany0443/mp3r.git
   cd mp3
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Start the server:
   ```
   npm start
   ```

4. Open your browser and navigate to:
   ```
   http://localhost:3000
   ```

## Usage

1. Paste a YouTube URL into the input field
2. Click "Fetch Video Info" to load the video details
3. Select your preferred audio quality (320kbps, 256kbps, etc.)
4. Choose a title format or create a custom format
5. Click "Download MP3" to start the download process
6. The file will automatically download when complete

## Requirements

- Node.js (v14 or higher recommended)
- FFmpeg (automatically installed via ffmpeg-static package)
- Modern web browser with EventSource support

## Technical Details

- Frontend: HTML5, CSS3, JavaScript
- Backend: Node.js with Express
- YouTube data extraction: ytdl-core
- Audio processing: fluent-ffmpeg

## License

MIT

## Disclaimer

This application is for personal use only. Please respect copyright laws and YouTube's terms of service when downloading content.
