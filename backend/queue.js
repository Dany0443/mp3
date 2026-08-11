const { QUEUE_CONCURRENCY, MAX_DOWNLOADS_PER_IP } = require('./config');
const { EventEmitter } = require('events');

const queue = [];
let activeJobs = 0;

const activeDownloads = new Map();
const inFlightRequests = new Map();
const activeDownloadsPerIP = new Map();
const progressEmitter = new EventEmitter();

function trackIPDownload(ip) {
    if (!ip) return;
    activeDownloadsPerIP.set(ip, (activeDownloadsPerIP.get(ip) || 0) + 1);
}

function untrackIPDownload(ip) {
    if (!ip) return;
    const n = (activeDownloadsPerIP.get(ip) || 1) - 1;
    if (n <= 0) activeDownloadsPerIP.delete(ip);
    else activeDownloadsPerIP.set(ip, n);
}

function getActiveIPCount(ip) {
    return activeDownloadsPerIP.get(ip) || 0;
}

function pruneActiveDownloads() {
    if (activeDownloads.size < 20) return;
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [id, job] of activeDownloads) {
        if ((job.complete || job.error) && job._ts && job._ts < cutoff) activeDownloads.delete(id);
    }
}

setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [id, job] of activeDownloads) {
        if ((job.complete || job.error) && job._ts && job._ts < cutoff) activeDownloads.delete(id);
    }
}, 10 * 60 * 1000);

function updateDownloadStatus(id, updates) {
    const next = { ...(activeDownloads.get(id) || {}), ...updates };
    if (updates.complete || updates.error) next._ts = Date.now();
    activeDownloads.set(id, next);
    progressEmitter.emit(`progress-${id}`, next);
    pruneActiveDownloads();
}

function enqueue(fn, downloadId) {
    return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject, downloadId });
        if (downloadId) {
            const position = queue.length;
            updateDownloadStatus(downloadId, {
                status: `Queued (position ${position})`,
                queuePosition: position,
                queueLength: queue.length + activeJobs,
            });
        }
        drainQueue();
    });
}

function drainQueue() {
    while (activeJobs < QUEUE_CONCURRENCY && queue.length > 0) {
        const { fn, resolve, reject } = queue.shift();
        activeJobs++;
        queue.forEach((item, idx) => {
            if (item.downloadId) {
                updateDownloadStatus(item.downloadId, {
                    status: `Queued (position ${idx + 1})`,
                    queuePosition: idx + 1,
                    queueLength: queue.length + activeJobs,
                });
            }
        });
        fn()
            .then(resolve)
            .catch(reject)
            .finally(() => {
                activeJobs--;
                drainQueue();
            });
    }
}

module.exports = {
    queue,
    getActiveJobs: () => activeJobs,
    activeDownloads,
    inFlightRequests,
    progressEmitter,
    trackIPDownload,
    untrackIPDownload,
    getActiveIPCount,
    updateDownloadStatus,
    enqueue,
};
