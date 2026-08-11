const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const logger = require('./logger');

const execFileAsync = promisify(execFile);

function getYtDlpPath() {
    const candidates = [
        '/usr/bin/yt-dlp',
        '/usr/local/bin/yt-dlp',
        '/snap/bin/yt-dlp',
        path.join(process.env.HOME || '/root', '.local/bin/yt-dlp'),
        path.join(__dirname, '..', 'node_modules', 'yt-dlp-exec', 'bin', 'yt-dlp'),
    ];
    for (const p of candidates) {
        try { if (fs.existsSync(p)) { try { fs.chmodSync(p, '755'); } catch {} return p; } } catch {}
    }
    return 'yt-dlp';
}

function getDenoPath() {
    const home = process.env.HOME || '/root';
    const candidates = [
        path.join(home, '.deno', 'bin', 'deno'),
        '/usr/bin/deno',
        '/usr/local/bin/deno',
        '/snap/bin/deno',
        path.join(home, '.local', 'bin', 'deno'),
    ];
    for (const p of candidates) {
        try { if (fs.existsSync(p)) return p; } catch {}
    }
    return null;
}

const YT_DLP = getYtDlpPath();
const DENO_PATH = getDenoPath();

const CHILD_ENV = (() => {
    const homeDirs = [
        process.env.HOME && path.join(process.env.HOME, '.local', 'bin'),
        process.env.HOME && path.join(process.env.HOME, '.deno', 'bin'),
        '/snap/bin', '/usr/local/bin', '/usr/bin', '/bin',
    ].filter(Boolean);
    const denoDir = DENO_PATH ? path.dirname(DENO_PATH) : null;
    const allDirs = denoDir ? [denoDir, ...homeDirs] : homeDirs;
    const merged  = [...new Set([...allDirs, ...(process.env.PATH || '').split(':')])].join(':');
    return {
        ...process.env,
        PATH: merged,
        HOME: process.env.HOME || '/root',
        DENO_DIR: process.env.DENO_DIR || path.join(process.env.HOME || '/root', '.deno')
    };
})();

function buildEnv() {
    return CHILD_ENV;
}

// Safe execution using execFile
async function safeExecFile(file, args, options = {}) {
    return execFileAsync(file, args, {
        maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
        timeout: options.timeout || 60000,
        env: buildEnv(),
    });
}

function startYtDlpAutoUpdate() {
    const CHECK_INTERVAL = 24 * 60 * 60 * 1000;

    async function tryUpdate() {
        try {
            logger.info('Auto-update: checking yt-dlp...');
            const { stdout } = await safeExecFile(YT_DLP, ['-U'], { timeout: 60000 });
            const result = stdout.trim().split('\n').pop();
            logger.success(`Auto-update yt-dlp: ${result}`);
        } catch (err) {
            logger.warn(`Auto-update yt-dlp failed: ${err.message.slice(0, 100)}`);
        }
    }

    setTimeout(() => {
        tryUpdate();
        setInterval(tryUpdate, CHECK_INTERVAL);
    }, 5 * 60 * 1000);
}

async function checkDependencies(cookiesFile) {
    try {
        const { stdout } = await safeExecFile(YT_DLP, ['--version']);
        const ver = stdout.trim();
        logger.info(`yt-dlp: ${YT_DLP} (${ver})`);
        const m = ver.match(/(\d{4})\.(\d{2})\.(\d{2})/);
        if (m) {
            const date = Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
            if (date < 20251208) {
                logger.warn('yt-dlp outdated. Run: sudo yt-dlp -U');
            } else {
                logger.success('yt-dlp version OK');
            }
        }
    } catch {
        logger.error('yt-dlp not found');
    }

    if (DENO_PATH) {
        try {
            const { stdout } = await safeExecFile(DENO_PATH, ['--version']);
            logger.success(`deno: ${DENO_PATH} (${stdout.split('\n')[0].trim()})`);
        } catch {
            logger.warn(`deno found at ${DENO_PATH} but failed to run`);
        }
    } else {
        logger.warn('deno not found');
    }

    try {
        const { stdout } = await safeExecFile('ffmpeg', ['-version']);
        logger.success(`ffmpeg: ${stdout.split('\n')[0].trim().substring(0, 60)}`);
    } catch {
        logger.error('ffmpeg not found');
    }

    if (cookiesFile) {
        logger.success(`cookies: ${cookiesFile}`);
    } else {
        logger.warn('yt-cookies.txt not found');
    }
}

module.exports = {
    YT_DLP,
    DENO_PATH,
    CHILD_ENV,
    buildEnv,
    safeExecFile,
    startYtDlpAutoUpdate,
    checkDependencies,
};
