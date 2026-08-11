const path = require('path');
const fs = require('fs');
const { MP3_STORAGE_PATH, FILE_TTL_MS } = require('./config');
const { fileRegistry, saveRegistry } = require('./fileRegistry');
const logger = require('./logger');

function startCleanupSweep(oembedCacheRef) {
    function sweep() {
        const now = Date.now();
        let changed = false;

        // Sweep tracked files from registry
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

        // Sweep orphan items older than TTL
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

        // Evict expired oEmbed cache entries
        if (oembedCacheRef && oembedCacheRef instanceof Map) {
            for (const [k, v] of oembedCacheRef) {
                if (v.expiresAt < now) oembedCacheRef.delete(k);
            }
        }
    }

    sweep();
    setInterval(sweep, 5 * 60 * 1000);
}

module.exports = {
    startCleanupSweep,
};
