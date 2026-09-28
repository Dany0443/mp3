const path = require('path');
const fs = require('fs');
const {
    MP3_STORAGE_PATH,
    CACHE_DIR,
    FILE_TTL_MS,
    MAX_STORAGE_BYTES,
    MAX_STORAGE_GB,
    CACHE_TTL_MS,
    STALE_TEMP_DIR_TTL_MS,
} = require('./config');
const { fileRegistry, saveRegistry } = require('./fileRegistry');
const logger = require('./logger');

/**
 * Scans MP3_STORAGE_PATH and returns detailed breakdown of storage consumption.
 */
function getStorageUsage() {
    let totalBytes = 0;
    let cacheBytes = 0;
    const cacheFiles = [];      // { path, name, size, mtimeMs }
    const registeredFiles = []; // { name, path, size, mtimeMs }
    const tempDirs = [];        // { name, path, size, mtimeMs }

    try {
        if (!fs.existsSync(MP3_STORAGE_PATH)) {
            return { totalBytes: 0, cacheBytes: 0, cacheFiles, registeredFiles, tempDirs };
        }

        const items = fs.readdirSync(MP3_STORAGE_PATH);
        for (const item of items) {
            if (item === '.registry.json') continue;
            const full = path.join(MP3_STORAGE_PATH, item);
            try {
                if (!fs.existsSync(full)) continue;
                const stat = fs.statSync(full);

                if (item === '.cache') {
                    if (stat.isDirectory()) {
                        const cFiles = fs.readdirSync(full);
                        for (const cf of cFiles) {
                            const cPath = path.join(full, cf);
                            try {
                                const cStat = fs.statSync(cPath);
                                totalBytes += cStat.size;
                                cacheBytes += cStat.size;
                                cacheFiles.push({ path: cPath, name: cf, size: cStat.size, mtimeMs: cStat.mtimeMs });
                            } catch {}
                        }
                    }
                } else if (stat.isDirectory()) {
                    let dirBytes = 0;
                    try {
                        const dFiles = fs.readdirSync(full);
                        for (const df of dFiles) {
                            try {
                                const dfStat = fs.statSync(path.join(full, df));
                                dirBytes += dfStat.size;
                            } catch {}
                        }
                    } catch {}
                    totalBytes += dirBytes;
                    tempDirs.push({ name: item, path: full, size: dirBytes, mtimeMs: stat.mtimeMs });
                } else {
                    totalBytes += stat.size;
                    registeredFiles.push({ name: item, path: full, size: stat.size, mtimeMs: stat.mtimeMs });
                }
            } catch {}
        }
    } catch (e) {
        logger.warn(`Storage usage calculation error: ${e.message}`);
    }

    return { totalBytes, cacheBytes, cacheFiles, registeredFiles, tempDirs };
}

/**
 * Sweeps temporary directories (playlist_*, batch_*, temp_*) older than maxAgeMs.
 * Default is STALE_TEMP_DIR_TTL_MS (15 minutes).
 */
function sweepStaleTempDirectories(maxAgeMs = STALE_TEMP_DIR_TTL_MS) {
    const now = Date.now();
    let freedBytes = 0;

    try {
        if (!fs.existsSync(MP3_STORAGE_PATH)) return freedBytes;
        const items = fs.readdirSync(MP3_STORAGE_PATH);
        for (const item of items) {
            if (item.startsWith('playlist_') || item.startsWith('batch_') || item.startsWith('temp_')) {
                const full = path.join(MP3_STORAGE_PATH, item);
                try {
                    if (!fs.existsSync(full)) continue;
                    const stat = fs.statSync(full);
                    if (stat.isDirectory() && (now - stat.mtimeMs) > maxAgeMs) {
                        try {
                            const files = fs.readdirSync(full);
                            for (const f of files) {
                                try { freedBytes += fs.statSync(path.join(full, f)).size; } catch {}
                            }
                        } catch {}
                        fs.rmSync(full, { recursive: true, force: true });
                        logger.info(`Swept stale temp directory: ${item} (age: ${Math.round((now - stat.mtimeMs) / 60000)}m)`);
                    }
                } catch (e) {
                    logger.warn(`Failed to sweep temp directory ${item}: ${e.message}`);
                }
            }
        }
    } catch {}

    return freedBytes;
}

/**
 * Sweeps cache files older than CACHE_TTL_MS (24h default).
 */
function sweepExpiredCache(maxAgeMs = CACHE_TTL_MS) {
    const now = Date.now();
    let freedBytes = 0;

    try {
        if (!fs.existsSync(CACHE_DIR)) return freedBytes;
        const files = fs.readdirSync(CACHE_DIR);
        for (const file of files) {
            const full = path.join(CACHE_DIR, file);
            try {
                if (!fs.existsSync(full)) continue;
                const stat = fs.statSync(full);
                if ((now - stat.mtimeMs) > maxAgeMs) {
                    freedBytes += stat.size;
                    fs.unlinkSync(full);
                    logger.info(`Evicted expired cache file: ${file}`);
                }
            } catch {}
        }
    } catch {}

    return freedBytes;
}

/**
 * Enforces the max storage ceiling (default 15 GB).
 * If total storage + headroomBytes > MAX_STORAGE_BYTES:
 * Evicts space down to 80% watermark (leaving at least ~3 GB headroom).
 */
function enforceStorageCeiling(headroomBytes = 0) {
    const usage = getStorageUsage();
    const effectiveTotal = usage.totalBytes + headroomBytes;

    if (effectiveTotal <= MAX_STORAGE_BYTES) {
        return; // Under limit
    }

    const targetCeiling = Math.floor(MAX_STORAGE_BYTES * 0.80);
    const bytesToFree = effectiveTotal - targetCeiling;

    logger.warn(`Storage ceiling triggered: ${(usage.totalBytes / (1024*1024*1024)).toFixed(2)} GB / ${MAX_STORAGE_GB} GB. Freeing ${(bytesToFree / (1024*1024)).toFixed(1)} MB...`);

    // 1. Wipe temp directories older than 5 minutes
    sweepStaleTempDirectories(5 * 60 * 1000);

    // Re-check
    let currentUsage = getStorageUsage();
    if (currentUsage.totalBytes + headroomBytes <= targetCeiling) {
        logger.success(`Storage pruned to ${(currentUsage.totalBytes / (1024*1024*1024)).toFixed(2)} GB.`);
        return;
    }

    // 2. LRU eviction on .cache (oldest modified files first)
    const sortedCache = currentUsage.cacheFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let cacheFreed = 0;

    for (const cFile of sortedCache) {
        if (currentUsage.totalBytes + headroomBytes - cacheFreed <= targetCeiling) break;
        try {
            if (fs.existsSync(cFile.path)) {
                fs.unlinkSync(cFile.path);
                cacheFreed += cFile.size;
            }
        } catch {}
    }

    if (cacheFreed > 0) {
        logger.info(`Evicted ${(cacheFreed / (1024*1024)).toFixed(1)} MB from song cache (.cache) via LRU.`);
    }

    // Re-check
    currentUsage = getStorageUsage();
    if (currentUsage.totalBytes + headroomBytes <= targetCeiling) {
        logger.success(`Storage pruned to ${(currentUsage.totalBytes / (1024*1024*1024)).toFixed(2)} GB.`);
        return;
    }

    // 3. If STILL above ceiling, evict oldest registered downloads/zips
    const sortedRegistered = currentUsage.registeredFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let registeredFreed = 0;
    let registryChanged = false;

    for (const rFile of sortedRegistered) {
        if (currentUsage.totalBytes + headroomBytes - registeredFreed <= targetCeiling) break;
        try {
            if (fs.existsSync(rFile.path)) {
                fs.unlinkSync(rFile.path);
                registeredFreed += rFile.size;
                fileRegistry.delete(rFile.name);
                registryChanged = true;
                logger.info(`Evicted oldest download: ${rFile.name}`);
            }
        } catch {}
    }

    if (registryChanged) saveRegistry(true);

    currentUsage = getStorageUsage();
    logger.success(`Storage cleanup complete: ${(currentUsage.totalBytes / (1024*1024*1024)).toFixed(2)} GB used.`);
}

/**
 * Ensures enough storage headroom before starting a download (especially large playlists).
 */
function ensureStorageSpace(estimatedBytes = 500 * 1024 * 1024) {
    try {
        enforceStorageCeiling(estimatedBytes);
    } catch (e) {
        logger.warn(`ensureStorageSpace error: ${e.message}`);
    }
}

function startCleanupSweep(oembedCacheRef, playlistCacheRef) {
    function sweep() {
        const now = Date.now();
        let changed = false;

        // 1. Sweep tracked files from registry (expired 1h downloads)
        for (const [name, expiresAt] of fileRegistry) {
            if (now >= expiresAt) {
                const full = path.join(MP3_STORAGE_PATH, name);
                try {
                    if (fs.existsSync(full)) {
                        const stat = fs.statSync(full);
                        if (stat.isDirectory()) {
                            fs.rmSync(full, { recursive: true, force: true });
                        } else {
                            fs.unlinkSync(full);
                        }
                        logger.info(`Swept registered file/dir: ${name}`);
                    }
                } catch (e) {
                    logger.warn(`Failed to sweep ${name}: ${e.message}`);
                }
                fileRegistry.delete(name);
                changed = true;
            }
        }
        if (changed) saveRegistry(true);

        // 2. Sweep orphan items older than FILE_TTL_MS (excluding .cache and .registry.json)
        try {
            const items = fs.readdirSync(MP3_STORAGE_PATH);
            for (const item of items) {
                if (item === '.cache' || item === '.registry.json') continue;

                const full = path.join(MP3_STORAGE_PATH, item);
                try {
                    if (!fs.existsSync(full)) continue;
                    const stat = fs.statSync(full);
                    const ageMs = now - stat.mtimeMs;

                    if (ageMs > FILE_TTL_MS) {
                        if (stat.isDirectory()) {
                            fs.rmSync(full, { recursive: true, force: true });
                            logger.info(`Orphan dir swept: ${item}`);
                        } else {
                            fs.unlinkSync(full);
                            logger.info(`Orphan file swept: ${item}`);
                        }
                        if (fileRegistry.has(item)) {
                            fileRegistry.delete(item);
                            saveRegistry();
                        }
                    }
                } catch (e) {
                    logger.warn(`Sweep item error (${item}): ${e.message}`);
                }
            }
        } catch (e) {
            logger.warn(`Sweep directory read error: ${e.message}`);
        }

        // 3. Sweep stale temporary playlist/batch directories (> 15 min old)
        sweepStaleTempDirectories();

        // 4. Sweep expired cache files (> 24h old)
        sweepExpiredCache();

        // 5. Enforce 15 GB max storage ceiling
        enforceStorageCeiling(0);

        // 6. Evict expired oEmbed cache entries
        if (oembedCacheRef && oembedCacheRef instanceof Map) {
            for (const [k, v] of oembedCacheRef) {
                if (v.expiresAt < now) oembedCacheRef.delete(k);
            }
        }

        // 7. Evict expired playlist metadata cache entries
        if (playlistCacheRef && playlistCacheRef instanceof Map) {
            for (const [k, v] of playlistCacheRef) {
                if (v.expiresAt < now) playlistCacheRef.delete(k);
            }
        }
    }

    sweep();
    setInterval(sweep, 5 * 60 * 1000);
}

module.exports = {
    getStorageUsage,
    sweepStaleTempDirectories,
    sweepExpiredCache,
    enforceStorageCeiling,
    ensureStorageSpace,
    startCleanupSweep,
};
