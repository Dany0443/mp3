# FastMP3

Convert YouTube videos and playlists to audio files from your browser.

---

## Features

- Download as MP3, M4A, OGG, or WAV up to 320 kbps
- Playlist support with ZIP output
- Batch download multiple URLs at once
- 30-second audio preview before downloading
- ID3 metadata editor
- Download history stored locally in the browser
- Auto-cleans video titles for filenames
- File size estimates per format and quality
- PWA — installable, works as a mobile share target

## Requirements

- [Node.js](https://nodejs.org) 18+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [ffmpeg](https://ffmpeg.org)

## Setup

```bash
git clone https://github.com/yourusername/fastmp3
cd fastmp3
npm install
node server.js
```

Open `http://localhost:3556` in your browser.

## Notes

- For personal use only. Respect copyright laws.
- Files expire from the server after 1 hour.
- Download history is saved only in your browser's local storage.
- If downloads fail with a 403, run `yt-dlp -U` to update.

## License

MIT
