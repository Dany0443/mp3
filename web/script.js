document.addEventListener('DOMContentLoaded', () => {

    // ── Elements ──────────────────────────────────────────────────────────────
    const el = {
        urlInput:        document.getElementById('videoUrl'),
        clearBtn:        document.getElementById('clearBtn'),
        fetchBtn:        document.getElementById('fetchBtn'),
        btnText:         document.querySelector('.btn-text'),
        btnSpinner:      document.querySelector('.btn-spinner'),
        infoSection:     document.getElementById('videoInfo'),
        thumb:           document.getElementById('thumbnail'),
        title:           document.getElementById('videoTitle'),
        author:          document.getElementById('videoAuthor'),
        duration:        document.getElementById('videoDuration'),
        playlistBadge:   document.getElementById('playlistBadge'),
        audioFormat:     document.getElementById('audioFormat'),
        audioQuality:    document.getElementById('audioQuality'),
        titleFormat:     document.getElementById('titleFormat'),
        filename:        document.getElementById('outputFilename'),
        filenameRow:     document.getElementById('filenameRow'),
        cleanToggle:     document.getElementById('cleanTitleToggle'),
        cleanBadge:      document.getElementById('cleanBadge'),
        originalRow:     document.getElementById('originalTitleRow'),
        originalText:    document.getElementById('originalTitleText'),
        copyFilenameBtn: document.getElementById('copyFilenameBtn'),
        downloadBtn:     document.getElementById('downloadBtn'),
        progressSection: document.getElementById('downloadProgress'),
        progressBar:     document.getElementById('progressBar'),
        progressText:    document.getElementById('progressText'),
        statusMsg:       document.getElementById('statusMessage'),
        progressHint:    document.getElementById('progressHint'),
        expiryRow:       document.getElementById('expiryRow'),
        expiryTimer:     document.getElementById('expiryTimer'),
        etaRow:          document.getElementById('etaRow'),
        etaText:         document.getElementById('etaText'),
    };

    // ── State ─────────────────────────────────────────────────────────────────
    let currentVideo   = null;
    let eventSource    = null;
    let apiKey         = null;
    let expiryTimeout  = null;
    let expiryInterval = null;
    let savedMeta      = null;
    let etaStartTime   = null;

    // ── Title cleaner ─────────────────────────────────────────────────────────
    const CLEAN_PATTERNS = [
        { re: /[\(\[]\s*(?:(?:official|oficial|music|video|videoclip|audio|clip|visualizer|lyrics?|performance|live|session|acoustic|version|ver\.?|edit|mix|remix|remaster(?:ed)?|hq|hd|4k|uhd|720p|1080p|full|fan|made|animated|animation|colou?r(?:ized)?|karaoke|instrumental|extended|radio|single|ep|deluxe|bonus|vevo|topic)\s*){1,5}[\)\]]/gi, rep: '' },
        { re: /[\(\[]\s*ofici?al\s*[\)\]]/gi, rep: '' },
        { re: /[\(\[]\s*(?:19|20)\d{2}\s*[\)\]]/g, rep: '' },
        { re: /[\(\[]\s*(?:(?:19|20)\d{2}\s*)?remaster(?:ed)?\s*(?:(?:19|20)\d{2})?\s*[\)\]]/gi, rep: '' },
        { re: /[\(\[]\s*(?:feat(?:uring)?\.?|ft\.?)\s+[^\)\]]+[\)\]]/gi, rep: '' },
        { re: /\s+(?:feat(?:uring)?\.?|ft\.?)\s+.+$/gi, rep: '' },
        { re: /\s*[|\-–—]\s*(?:official|video|audio|lyrics?|visualizer|clip|hq|hd|4k|vevo|topic|directed\s+by|prod(?:uced)?\s*(?:by)?|©)\b.*/gi, rep: '' },
        { re: /\s*-\s*Topic$/i, rep: '' },
        { re: /\s*·\s*.*/g, rep: '' },
        { re: /\s+official\.?$/i, rep: '' },
        { re: /^["'«»]+|["'«»]+$/g, rep: '' },
        { re: /\s{2,}/g, rep: ' ' },
    ];

    function smartCleanTitle(raw) {
        if (!raw) return { cleaned: '', wasModified: false };
        let result = raw;
        for (const { re, rep } of CLEAN_PATTERNS) result = result.replace(re, rep);
        result = result.replace(/^[\s\-–—|]+|[\s\-–—|]+$/g, '').trim();
        return { cleaned: result, wasModified: result !== raw };
    }

    // ── Utilities ─────────────────────────────────────────────────────────────
    function sanitizeFilename(str) {
        return str.replace(/[\/:*?"<>|]/g, '').replace(/\.{2,}/g, '.').replace(/^[\s.]+|[\s.]+$/g, '').substring(0, 120).trim() || 'download';
    }
    function formatTime(seconds) {
        const m = Math.floor(seconds / 60), s = seconds % 60;
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    }
    function formatETA(seconds) {
        if (seconds < 60) return `${Math.round(seconds)}s`;
        return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    }
    function escHtml(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ── Bootstrap ─────────────────────────────────────────────────────────────
    async function bootstrap() {
        try {
            const res  = await fetch('api/client-key');
            const data = await res.json();
            apiKey = data.key;
        } catch {
            showError('Could not reach server. Is it running?');
            return;
        }

        const params  = new URLSearchParams(window.location.search);
        const shared  = params.get('url') || params.get('text') || params.get('title') || '';
        const ytMatch = shared.match(/(https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\S+)/);
        if (ytMatch) {
            const ytUrl = ytMatch[1].trim();
            el.urlInput.value = ytUrl;
            try { window.history.replaceState({}, '', window.location.pathname); } catch {}
            setTimeout(() => fetchVideoInfo(), 300);
        }
    }

    function apiFetch(url, opts = {}) {
        return fetch(url, {
            ...opts,
            headers: { ...(opts.headers || {}), 'X-API-Key': apiKey || '' },
        });
    }

    // ── Auto system theme ─────────────────────────────────────────────────────
    if (!localStorage.getItem('theme')) {
        if (window.matchMedia('(prefers-color-scheme: light)').matches) {
            document.body.classList.add('light-mode');
            const t = document.getElementById('themeToggle');
            if (t) t.checked = true;
        }
    }

    // ── Dropdowns ─────────────────────────────────────────────────────────────
    function setupDropdown(dropdownId, hiddenInputId) {
        const dropdown = document.getElementById(dropdownId);
        if (!dropdown) return;
        const hiddenInput = document.getElementById(hiddenInputId);
        const display     = dropdown.querySelector('.dropdown-selected span');
        const trigger     = dropdown.querySelector('.dropdown-selected');
        const options     = dropdown.querySelectorAll('.dropdown-options div');

        trigger.addEventListener('click', e => {
            e.stopPropagation();
            document.querySelectorAll('.custom-dropdown').forEach(d => {
                if (d.id !== dropdownId) d.classList.remove('open');
            });
            dropdown.classList.toggle('open');
        });

        options.forEach(option => {
            option.addEventListener('click', e => {
                e.stopPropagation();
                display.textContent = option.childNodes[0].textContent.trim();
                options.forEach(o => o.classList.remove('selected'));
                option.classList.add('selected');
                hiddenInput.value = option.getAttribute('data-value');
                dropdown.classList.remove('open');
                if (currentVideo) updateFilename();
                if (currentVideo) updateSizeHints();
            });
        });
    }

    document.addEventListener('click', () => {
        document.querySelectorAll('.custom-dropdown').forEach(d => d.classList.remove('open'));
    });

    // ── File size hints ───────────────────────────────────────────────────────
    function updateSizeHints() {
        if (!currentVideo?.lengthSeconds) return;
        const secs   = currentVideo.lengthSeconds;
        const format = el.audioFormat.value;

        document.querySelectorAll('.size-hint').forEach(hint => {
            let mb;
            if (format === 'wav') {
                mb = (1411 * 1000 / 8 * secs) / (1024 * 1024);
            } else {
                let kbps = parseInt(hint.dataset.kbps);
                if (format === 'm4a') kbps = kbps * 0.7;
                mb = (kbps * 1000 / 8 * secs) / (1024 * 1024);
            }
            hint.textContent = `~${mb.toFixed(1)} MB`;
        });
    }

    // ── Fetch video info ──────────────────────────────────────────────────────
    function setFetchLoading(loading) {
        el.fetchBtn.disabled = loading;
        el.btnText.classList.toggle('hidden', loading);
        el.btnSpinner.classList.toggle('hidden', !loading);
    }

    let isFetching = false;
    async function fetchVideoInfo() {
        resetDownloadUI();

        // FIX: Clear savedMeta when fetching a new video so old tags don't
        // bleed into the next download. Also re-syncs the metadata panel.
        savedMeta = null;

        if (isFetching) return;
        isFetching = true;

        const url = el.urlInput.value.trim();
        if (!url) {
            el.urlInput.focus();
            el.urlInput.style.borderColor = 'var(--red)';
            setTimeout(() => el.urlInput.style.borderColor = '', 1500);
            isFetching = false;
            return;
        }

        setFetchLoading(true);
        clearExpiry();

        try {
            const res = await apiFetch(`/mp3/api/video-info?url=${encodeURIComponent(url)}`);
            const data = await res.json();

            if (data.error) throw new Error(data.message || 'Failed to fetch info');

            currentVideo = data;

            if (data.isPlaylist) {
                el.title.textContent    = data.title;
                el.author.textContent   = `${data.count} tracks`;
                el.duration.textContent = '';
                el.thumb.src            = data.thumbnailUrl || '';
                if(el.playlistBadge) el.playlistBadge.classList.remove('hidden');
                if(el.filenameRow) el.filenameRow.classList.add('hidden');
            } else {
                el.title.textContent    = data.title;
                el.author.textContent   = data.author;
                el.thumb.src            = data.thumbnailUrl;
                if(el.playlistBadge) el.playlistBadge.classList.add('hidden');
                if(el.filenameRow) el.filenameRow.classList.remove('hidden');

                if (typeof updateFilename === 'function') updateFilename();
                if (typeof updateSizeHints === 'function') updateSizeHints();

                if (data.fromOembed && data.videoId) {
                    el.duration.textContent = '';
                    pollForDuration(data.videoId);
                } else {
                    el.duration.textContent = formatTime(data.lengthSeconds);
                }
            }

            el.infoSection.classList.remove('hidden');
            if(el.progressSection) el.progressSection.classList.add('hidden');

            if (typeof syncPreviewPanel === 'function') syncPreviewPanel();
            // FIX: Always re-sync metadata panel when a new video is fetched
            // (savedMeta was cleared above, so this fills in fresh values)
            if (typeof syncMetadataPanel === 'function') syncMetadataPanel();

        } catch (err) {
            if (typeof showError === 'function') showError('Could not fetch: ' + err.message);
            else alert('Could not fetch: ' + err.message);
        } finally {
            setFetchLoading(false);
            isFetching = false;
        }
    }

    // ── Duration poller ───────────────────────────────────────────────────────
    let durationPollTimer = null;

    function pollForDuration(videoId) {
        clearTimeout(durationPollTimer);
        let attempts = 0;
        const MAX    = 12;

        function poll() {
            if (attempts++ >= MAX) return;
            apiFetch(`/mp3/api/video-duration/${videoId}`)
                .then(r => r.json())
                .then(d => {
                    if (d.lengthSeconds) {
                        if (currentVideo) currentVideo.lengthSeconds = d.lengthSeconds;
                        el.duration.textContent = formatTime(d.lengthSeconds);
                        updateSizeHints();
                    } else {
                        durationPollTimer = setTimeout(poll, 1000);
                    }
                })
                .catch(() => { durationPollTimer = setTimeout(poll, 1500); });
        }
        durationPollTimer = setTimeout(poll, 800);
    }

    function updateFilename() {
        if (!currentVideo || currentVideo.isPlaylist) return;
        const template = el.titleFormat.value;
        const ext      = el.audioFormat.value;
        const doClean  = el.cleanToggle.checked;
        let titleToUse, wasModified;

        if (doClean) {
            const result = smartCleanTitle(currentVideo.title);
            titleToUse   = result.cleaned;
            wasModified  = result.wasModified;
        } else {
            titleToUse  = currentVideo.title;
            wasModified = false;
        }

        el.cleanBadge.classList.toggle('hidden', !wasModified || !doClean);
        el.originalRow.classList.toggle('hidden', !wasModified || !doClean);
        if (wasModified && doClean) el.originalText.textContent = currentVideo.title;

        const name = template
            .replace(/{title}/g,  titleToUse)
            .replace(/{artist}/g, currentVideo.author);
        el.filename.value = sanitizeFilename(name) + '.' + ext;
    }

    // ── Download ──────────────────────────────────────────────────────────────
    async function startDownload() {
        if (!currentVideo) return;
        el.downloadBtn.disabled = true;
        el.progressSection.classList.remove('hidden');
        el.progressHint.textContent = currentVideo.isPlaylist
            ? 'Downloading playlist — this can take several minutes.'
            : 'This may take a minute for longer videos.';
        el.statusMsg.style.color = '';
        clearExpiry();
        resetProgress();

        const url      = el.urlInput.value;
        const format   = el.audioFormat.value;
        const quality  = el.audioQuality.value;
        const filename = el.filename.value;

        // FIX: Use 'embedThumb' — matches what the server now reads as
        // either 'embedThumb' or 'embedThumbnail' (backward compat kept on server)
        const embedThumb = document.getElementById('metaEmbedThumb')?.checked ? '1' : '0';

        const bodyParams = new URLSearchParams();
        bodyParams.set('url',        url);
        bodyParams.set('format',     format);
        bodyParams.set('quality',    quality);
        bodyParams.set('filename',   filename);
        bodyParams.set('embedThumb', embedThumb);   // FIX: was 'embedThumbnail' on old client

        // FIX: Pass metadata as individual params — the server reads these via req.query
        // and assembles them into a metaTags object. Previously the param names didn't
        // match between client and server.
        if (savedMeta) {
            if (savedMeta.title)  bodyParams.set('metaTitle',  savedMeta.title);
            if (savedMeta.artist) bodyParams.set('metaArtist', savedMeta.artist);
            if (savedMeta.album)  bodyParams.set('metaAlbum',  savedMeta.album);
            if (savedMeta.year)   bodyParams.set('metaYear',   savedMeta.year);
            if (savedMeta.genre)  bodyParams.set('metaGenre',  savedMeta.genre);
            if (savedMeta.track)  bodyParams.set('metaTrack',  savedMeta.track);
        }

        try {
            const res = await apiFetch(`/mp3/api/download?${bodyParams.toString()}`);
            const data = await res.json();

            if (data.error) throw new Error(data.message || 'Failed to start download');
            if (!data.id) throw new Error('Failed to start download: No Job ID returned');

            etaStartTime = Date.now();
            startFakeRamp();
            listenToProgress(data.id);

        } catch (err) {
            el.statusMsg.textContent = 'Error: ' + err.message;
            el.downloadBtn.disabled  = false;
        }
    }

    // Fake progress ramp: 0→95 over ~6s, then holds until server says done
    let fakeRampInterval = null;

    function startFakeRamp() {
        stopFakeRamp();
        let fakeProgress = 0;
        const RAMP_DURATION = 6000;
        const TICK = 80;
        const steps = RAMP_DURATION / TICK;
        const increment = 90 / steps;
        let countdown = Math.ceil(RAMP_DURATION / 1000);

        if (el.etaRow) el.etaRow.classList.remove('hidden');
        if (el.etaText) el.etaText.textContent = `~${countdown}s remaining`;

        el.progressBar.style.backgroundColor = '';

        fakeRampInterval = setInterval(() => {
            fakeProgress = Math.min(fakeProgress + increment, 95);
            el.progressBar.style.width  = fakeProgress.toFixed(1) + '%';
            el.progressText.textContent = Math.floor(fakeProgress) + '%';

            const newCountdown = Math.max(1, Math.ceil((95 - fakeProgress) / increment * TICK / 1000));
            if (newCountdown !== countdown) {
                countdown = newCountdown;
                if (el.etaText) el.etaText.textContent = `~${countdown}s remaining`;
            }

            if (fakeProgress >= 95) {
                stopFakeRamp();
                if (el.statusMsg) el.statusMsg.textContent = 'Finalizing...';
                if (el.etaText) el.etaText.textContent     = 'Almost done...';
            }
        }, TICK);
    }

    let ffmpegRampInterval = null;

    function stopFakeRamp() {
        if (fakeRampInterval) { clearInterval(fakeRampInterval); fakeRampInterval = null; }
    }

    function stopFfmpegRamp() {
        if (ffmpegRampInterval) { clearInterval(ffmpegRampInterval); ffmpegRampInterval = null; }
    }

    function listenToProgress(id, isCached = false) {
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }

        stopFfmpegRamp();

        if (!isCached) {
            startFakeRamp();
        }

        const qs = `?_k=${encodeURIComponent(apiKey || '')}`;
        eventSource = new EventSource(`/mp3/api/download-progress/${id}${qs}`);

        eventSource.onmessage = e => {
            let data;
            try { data = JSON.parse(e.data); } catch { return; }

            if (data.status && data.status !== 'Queued') {
                if (!ffmpegRampInterval) el.statusMsg.textContent = data.status;
            }

            if (typeof data.progress === 'number' && data.progress > 5 && data.progress < 100) {
                stopFakeRamp();

                if (data.progress >= 90) {
                    if (!ffmpegRampInterval) {
                        let currentProg = 90;
                        ffmpegRampInterval = setInterval(() => {
                            currentProg = Math.min(currentProg + 0.34, 99.5);
                            el.progressBar.style.width = currentProg.toFixed(1) + '%';
                            el.progressText.textContent = Math.floor(currentProg) + '%';
                            if (el.statusMsg) el.statusMsg.textContent = 'Converting...';
                        }, 250);
                    }
                } else {
                    el.progressBar.style.width  = data.progress + '%';
                    el.progressText.textContent = Math.round(data.progress) + '%';
                }
            }

            if (data.speed || data.eta) {
                if (el.etaRow) el.etaRow.classList.remove('hidden');
                const parts = [];
                if (data.speed) parts.push(data.speed);
                if (data.eta)   parts.push(`ETA ${data.eta}`);
                if (el.etaText && !ffmpegRampInterval) el.etaText.textContent = parts.join(' · ');
                if (ffmpegRampInterval && el.etaRow) el.etaRow.classList.add('hidden');
            }

            if (data.status === 'Queued') {
                if (el.progressHint) el.progressHint.textContent = 'Waiting in queue...';
            }
            if (data.isPlaylist && data.total) {
                if (el.progressHint) el.progressHint.textContent = `Tracks: ${data.done || 0} / ${data.total} done`;
            }

            if (data.error) {
                stopFakeRamp();
                stopFfmpegRamp();
                eventSource.close();
                el.statusMsg.textContent    = data.status || 'Something went wrong.';
                el.statusMsg.style.color    = 'var(--red)';
                el.progressBar.style.backgroundColor = 'var(--red)';
                if (el.progressHint) el.progressHint.textContent = 'Please try again.';
                if (el.downloadBtn)  el.downloadBtn.disabled     = false;
                if (el.etaRow)       el.etaRow.classList.add('hidden');
                return;
            }

            if (data.complete) {
                stopFakeRamp();
                stopFfmpegRamp();
                eventSource.close();
                if (el.etaRow) el.etaRow.classList.add('hidden');

                if (!data.downloadUrl) {
                    el.statusMsg.textContent = 'Error: download URL missing. Please retry.';
                    el.statusMsg.style.color = 'var(--red)';
                    if (el.downloadBtn) el.downloadBtn.disabled = false;
                    return;
                }

                el.progressBar.style.width  = '100%';
                el.progressText.textContent = '100%';
                el.progressBar.style.backgroundColor = '#00C851';
                if (el.statusMsg) el.statusMsg.textContent = 'Done!';

                if (typeof finishDownload === 'function') {
                    finishDownload(data);
                }
            }
        };

        eventSource.onerror = () => {
            stopFakeRamp();
            stopFfmpegRamp();
            eventSource.close();
            el.statusMsg.textContent = 'Connection lost. Please try again.';
            el.statusMsg.style.color = 'var(--red)';
            if (el.downloadBtn) el.downloadBtn.disabled  = false;
            if (el.etaRow)      el.etaRow.classList.add('hidden');
        };
    }

    function finishDownload(data) {
        const qs = `?_k=${encodeURIComponent(apiKey || '')}`;
        const cleanUrl = data.downloadUrl.startsWith('/mp3') ? data.downloadUrl : `/mp3${data.downloadUrl}`;
        const fullDownloadUrl = `${cleanUrl}${qs}`;

        const urlInput = document.getElementById('urlInput');
        const historyItem = {
            id: data.id || urlInput?.value || Date.now(),
            title: data.title || document.getElementById('previewTitle')?.innerText || 'Unknown Title',
            author: data.author || document.getElementById('previewAuthor')?.innerText || '',
            thumbnail: data.thumbnail || document.getElementById('previewThumb')?.src || '',
            format: 'mp3',
            quality: data.quality || '320',
            date: Date.now(),
            url: fullDownloadUrl,
            filename: (data.title || 'audio') + '.mp3',
            sourceUrl: urlInput?.value || ''
        };
        addToHistory(historyItem);

        const a = document.createElement('a');
        a.href = fullDownloadUrl;
        a.download = '';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        const originalBtn = document.getElementById('downloadBtn');
        if (originalBtn) originalBtn.style.display = 'none';

        const previewAudio = document.getElementById('previewAudio');
        const previewPlayerWrap = document.getElementById('previewPlayerWrap');
        const previewPlayBtn = document.getElementById('previewPlayBtn');

        if (previewAudio && previewPlayerWrap) {
            previewAudio.src = fullDownloadUrl;
            previewAudio.style.colorScheme = 'dark';
            previewPlayerWrap.classList.remove('hidden');
            if (previewPlayBtn) previewPlayBtn.style.display = 'none';
        }

        if (!document.getElementById('postDownloadActions')) {
            const actionsContainer = document.createElement('div');
            actionsContainer.id = 'postDownloadActions';
            actionsContainer.style.display = 'flex';
            actionsContainer.style.flexDirection = 'column';
            actionsContainer.style.gap = '15px';
            actionsContainer.style.marginTop = '15px';

            const reloadBtn = document.createElement('button');
            reloadBtn.className = 'download-btn';
            reloadBtn.innerHTML = '<i class="fas fa-redo"></i><span>Download Another</span>';
            reloadBtn.onclick = () => window.location.reload();

            const saveBtn = document.createElement('a');
            saveBtn.href = fullDownloadUrl;
            saveBtn.className = 'download-btn';
            saveBtn.style.background = 'var(--surface3)';
            saveBtn.style.border = '1px solid var(--border2)';
            saveBtn.style.textDecoration = 'none';
            saveBtn.innerHTML = '<i class="fas fa-download"></i><span>Save File (Manual)</span>';
            saveBtn.download = '';

            actionsContainer.appendChild(reloadBtn);
            actionsContainer.appendChild(saveBtn);

            if (originalBtn && originalBtn.parentElement) {
                originalBtn.parentElement.appendChild(actionsContainer);
            }
        }
    }

    // ── Expiry countdown ──────────────────────────────────────────────────────
    function startExpiry(expiresAt) {
        el.expiryRow?.classList.remove('hidden');
        clearExpiry();
        function tick() {
            const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
            const m = Math.floor(remaining / 60), s = remaining % 60;
            if (el.expiryTimer) el.expiryTimer.textContent = `${m}:${s < 10 ? '0' : ''}${s}`;
            if (remaining === 0) {
                clearExpiry();
                if (el.expiryTimer) el.expiryTimer.textContent = 'expired';
                const btn = el.progressSection.querySelector('.download-success-btn');
                if (btn) { btn.style.opacity = '0.4'; btn.style.pointerEvents = 'none'; }
            }
        }
        tick();
        expiryInterval = setInterval(tick, 1000);
    }

    function clearExpiry() {
        clearInterval(expiryInterval);
        clearTimeout(expiryTimeout);
        el.expiryRow?.classList.add('hidden');
    }

    // ── Progress reset ────────────────────────────────────────────────────────
    function resetProgress() {
        stopFakeRamp();
        el.progressBar.style.width  = '0%';
        el.progressText.textContent = '0%';
        el.statusMsg.textContent    = 'Connecting...';
        el.etaRow?.classList.add('hidden');
        el.progressSection.querySelector('.download-success-btn')?.remove();
    }

    // ── Drag & drop URL ───────────────────────────────────────────────────────
    function initDragDrop() {
        const overlay = document.getElementById('dragOverlay');
        let dragTimer;
        document.addEventListener('dragover', e => {
            e.preventDefault();
            clearTimeout(dragTimer);
            overlay?.classList.remove('hidden');
        });
        document.addEventListener('dragleave', () => {
            dragTimer = setTimeout(() => overlay?.classList.add('hidden'), 200);
        });
        document.addEventListener('drop', e => {
            e.preventDefault();
            overlay?.classList.add('hidden');
            const text  = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list') || '';
            const match = text.match(/(https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\S+)/);
            if (match) { el.urlInput.value = match[1].trim(); fetchVideoInfo(); }
        });
    }

    // ── Keyboard shortcuts ────────────────────────────────────────────────────
    function initKeyboardShortcuts() {
        document.addEventListener('keydown', e => {
            const active  = document.activeElement;
            const isInput = active.tagName === 'INPUT' || active.tagName === 'TEXTAREA';

            if ((e.metaKey || e.ctrlKey) && e.key === 'v' && !isInput) {
                e.preventDefault();
                navigator.clipboard.readText().then(text => {
                    if (text.includes('youtube.com') || text.includes('youtu.be')) {
                        el.urlInput.value = text.trim();
                        fetchVideoInfo();
                    }
                }).catch(() => {});
            }

            if (e.key === 'Enter' && !isInput &&
                !el.infoSection.classList.contains('hidden') &&
                !el.downloadBtn.disabled) {
                startDownload();
            }

            if (e.key === 'Escape') {
                closeAllPanels();
                active.blur();
            }
        });
    }

    // ── Floating panels ───────────────────────────────────────────────────────
    const PANELS = [
        { openId: 'openPreview',  panelId: 'previewPanel', backdropId: 'previewBackdrop', closeId: 'closePreview' },
        { openId: 'openHistory',  panelId: 'historyPanel', backdropId: 'historyBackdrop', closeId: 'closeHistory' },
        { openId: 'openMetadata', panelId: 'metaPanel',    backdropId: 'metaBackdrop',    closeId: 'closeMeta'    },
        { openId: 'openBatch',    panelId: 'batchPanel',   backdropId: 'batchBackdrop',   closeId: 'closeBatch'   },
    ];

    function openPanel(panelId, backdropId) {
        const panel    = document.getElementById(panelId);
        const backdrop = document.getElementById(backdropId);
        if (!panel) return;
        panel.classList.remove('hidden');
        backdrop?.classList.remove('hidden');
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                panel.classList.add('panel-open');
                backdrop?.classList.add('backdrop-visible');
            });
        });
    }

    function closePanel(panelId, backdropId) {
        const panel    = document.getElementById(panelId);
        const backdrop = document.getElementById(backdropId);
        if (!panel) return;
        panel.classList.remove('panel-open');
        backdrop?.classList.remove('backdrop-visible');
        setTimeout(() => {
            panel.classList.add('hidden');
            backdrop?.classList.add('hidden');
        }, 300);
    }

    function closeAllPanels() {
        PANELS.forEach(({ panelId, backdropId }) => {
            const p = document.getElementById(panelId);
            if (p && !p.classList.contains('hidden')) closePanel(panelId, backdropId);
        });
    }

    function initPanels() {
        PANELS.forEach(({ openId, panelId, backdropId, closeId }) => {
            document.getElementById(openId)?.addEventListener('click', () => {
                const isOpen = !document.getElementById(panelId)?.classList.contains('hidden');
                closeAllPanels();
                if (!isOpen) {
                    openPanel(panelId, backdropId);
                    if (panelId === 'historyPanel') renderHistory();
                }
            });

            document.getElementById(closeId)?.addEventListener('click', () => {
                closePanel(panelId, backdropId);
            });

            document.getElementById(backdropId)?.addEventListener('click', () => {
                closePanel(panelId, backdropId);
            });
        });
    }

    // ── PANEL: Audio Preview + Waveform ───────────────────────────────────────
    let audioCtx   = null;
    let analyser   = null;
    let sourceNode = null;
    let animFrame  = null;

    function syncPreviewPanel() {
        const infoDiv = document.getElementById('previewVideoInfo');
        const playBtn = document.getElementById('previewPlayBtn');
        const pThumb  = document.getElementById('previewThumb');
        const pTitle  = document.getElementById('previewTitle');
        const pAuthor = document.getElementById('previewAuthor');

        if (currentVideo && !currentVideo.isPlaylist) {
            infoDiv?.classList.remove('hidden');
            if (pThumb)  pThumb.src = currentVideo.thumbnailUrl;
            if (pTitle)  pTitle.textContent = currentVideo.title;
            if (pAuthor) pAuthor.textContent = currentVideo.author;
            if (playBtn) playBtn.disabled = false;
        } else {
            infoDiv?.classList.add('hidden');
            if (playBtn) playBtn.disabled = true;
        }
    }

    function initPreviewPanel() {
        document.getElementById('previewPlayBtn')?.addEventListener('click', startPreview);
    }

    async function startPreview() {
        if (!currentVideo) return;
        const playBtn    = document.getElementById('previewPlayBtn');
        const playerWrap = document.getElementById('previewPlayerWrap');
        const audio      = document.getElementById('previewAudio');
        const qualNote   = document.getElementById('previewQualityNote');

        playBtn.disabled  = true;
        playBtn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Fetching preview...';

        try {
            const url     = el.urlInput.value;
            const format  = el.audioFormat.value;
            const quality = el.audioQuality.value;
            const res     = await apiFetch(
                `/mp3/api/download?url=${encodeURIComponent(url)}&format=${format}&quality=${quality}&filename=preview&preview=1`
            );
            const data = await res.json();
            if (!data.id) throw new Error('Preview failed to start');

            const qs = `?_k=${encodeURIComponent(apiKey || '')}`;
            const es = new EventSource(`/api/download-progress/${data.id}${qs}`);
            es.onmessage = e => {
                let d; try { d = JSON.parse(e.data); } catch { return; }
                if (d.complete && d.downloadUrl) {
                    es.close();
                    audio.src = d.downloadUrl + qs;
                    playerWrap?.classList.remove('hidden');
                    playBtn.innerHTML = '<i class="fas fa-play"></i> Preview 30s';
                    playBtn.disabled  = false;
                    audio.play().catch(() => {});
                    if (qualNote) qualNote.textContent = `${format.toUpperCase()} · ${quality} kbps · 30s preview`;
                    initWaveform(audio);
                }
                if (d.error) {
                    es.close();
                    playBtn.innerHTML = '<i class="fas fa-play"></i> Preview 30s';
                    playBtn.disabled  = false;
                }
            };
            es.onerror = () => {
                es.close();
                playBtn.innerHTML = '<i class="fas fa-play"></i> Preview 30s';
                playBtn.disabled  = false;
            };
        } catch {
            playBtn.innerHTML = '<i class="fas fa-play"></i> Preview 30s';
            playBtn.disabled  = false;
        }
    }

    function initWaveform(audioEl) {
        const canvas = document.getElementById('waveformCanvas');
        if (!canvas) return;
        if (animFrame) cancelAnimationFrame(animFrame);
        try { audioCtx?.close(); } catch {}

        try {
            audioCtx   = new (window.AudioContext || window.webkitAudioContext)();
            analyser   = audioCtx.createAnalyser();
            analyser.fftSize = 256;
            sourceNode = audioCtx.createMediaElementSource(audioEl);
            sourceNode.connect(analyser);
            analyser.connect(audioCtx.destination);
        } catch { return; }

        const dataArr = new Uint8Array(analyser.frequencyBinCount);
        const ctx     = canvas.getContext('2d');

        function draw() {
            animFrame = requestAnimationFrame(draw);
            analyser.getByteFrequencyData(dataArr);
            const W = canvas.offsetWidth, H = canvas.offsetHeight;
            canvas.width = W; canvas.height = H;
            ctx.clearRect(0, 0, W, H);
            const bufLen = dataArr.length;
            const barW   = (W / bufLen) * 2.5;
            let x = 0;
            for (let i = 0; i < bufLen; i++) {
                const barH = (dataArr[i] / 255) * H;
                const grad = ctx.createLinearGradient(0, H - barH, 0, H);
                grad.addColorStop(0, '#4285f4');
                grad.addColorStop(1, '#34a853');
                ctx.fillStyle = grad;
                ctx.fillRect(x, H - barH, Math.max(1, barW - 1), barH);
                x += barW + 1;
            }
        }
        draw();
        audioEl.addEventListener('ended', () => {
            cancelAnimationFrame(animFrame);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }, { once: true });
    }

    // ── PANEL: Download History ────────────────────────────────────────────────
    function getHistory()   { try { return JSON.parse(localStorage.getItem('dlHistory') || '[]'); } catch { return []; } }
    function saveHistory(h) { localStorage.setItem('dlHistory', JSON.stringify(h.slice(0, 50))); }

    function addToHistory(item) {
        let history = getHistory();
        const itemId = item.id || item.videoId;
        if (itemId) {
            history = history.filter(h => (h.id || h.videoId) !== itemId);
        }
        history.unshift(item);
        saveHistory(history);
        if (typeof renderHistory === 'function') renderHistory();
    }

    function updateHistoryBadge() {
        const count = getHistory().length;
        const badge = document.getElementById('historyBadge');
        if (badge) {
            badge.textContent = count > 9 ? '9+' : count;
            badge.classList.toggle('hidden', count === 0);
        }
        const badgeD = document.getElementById('historyBadgeDesktop');
        if (badgeD) {
            badgeD.textContent = count > 9 ? '9+' : count;
            badgeD.classList.toggle('hidden', count === 0);
        }
    }

    function renderHistory() {
        const list    = document.getElementById('historyList');
        const empty   = document.getElementById('historyEmpty');
        const history = getHistory();
        if (!list) return;

        updateHistoryBadge();

        if (history.length === 0) {
            empty?.classList.remove('hidden');
            list.innerHTML = '';
            return;
        }
        empty?.classList.add('hidden');

        list.innerHTML = history.map((item, i) => {
            const date    = new Date(item.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            const expired = item.expiresAt && Date.now() > item.expiresAt;
            const canRefetch = expired && item.sourceUrl;
            return `<div class="history-item">
                <img src="${escHtml(item.thumbnail || '')}" class="history-thumb" alt="" onerror="this.style.display='none'">
                <div class="history-info">
                    <p class="history-title">${escHtml(item.title)}</p>
                    <p class="history-meta">${escHtml(item.author || '')} · ${(item.format || '').toUpperCase()} ${item.quality || ''}kbps · ${date}</p>
                </div>
                <div class="history-actions">
                    ${!expired && item.url
                        ? `<a href="${escHtml(item.url)}" download="${escHtml(item.filename)}" class="history-dl-btn" title="Re-download"><i class="fas fa-arrow-down"></i></a>`
                        : canRefetch
                            ? `<button class="history-dl-btn history-refetch-btn" data-url="${escHtml(item.sourceUrl)}" title="Re-convert & download"><i class="fas fa-rotate-right"></i></button>`
                            : `<span class="history-expired" title="Expired"><i class="fas fa-clock"></i></span>`}
                    <button class="history-del-btn" data-index="${i}" title="Remove"><i class="fas fa-xmark"></i></button>
                </div>
            </div>`;
        }).join('');

        list.querySelectorAll('.history-refetch-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const ytUrl = btn.dataset.url;
                if (!ytUrl) return;
                closeAllPanels();
                el.urlInput.value = ytUrl;
                fetchVideoInfo();
            });
        });

        list.querySelectorAll('.history-del-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const h = getHistory();
                h.splice(parseInt(btn.dataset.index), 1);
                saveHistory(h);
                renderHistory();
            });
        });

        const clearBtn = document.getElementById('clearHistoryBtn');
        if (clearBtn) {
            clearBtn.onclick = () => {
                if (confirm('Clear all download history?')) { saveHistory([]); renderHistory(); }
            };
        }
    }

    // ── PANEL: Metadata Editor ────────────────────────────────────────────────
    function syncMetadataPanel() {
        if (!currentVideo || currentVideo.isPlaylist) return;

        // FIX: savedMeta is cleared in fetchVideoInfo() before this is called,
        // so this block always runs for a fresh video fetch. It will also NOT
        // run if the user has manually saved tags (savedMeta !== null), because
        // fetchVideoInfo() only clears savedMeta, and re-calls syncMetadataPanel
        // after clearing — at which point savedMeta is null and we fill in fresh data.
        if (savedMeta) return;

        const { cleaned } = smartCleanTitle(currentVideo.title);

        const fields = {
            metaTitle:  cleaned || currentVideo.title,
            metaArtist: currentVideo.author || '',
            metaAlbum:  '',
            metaYear:   '',
            metaGenre:  '',
            metaTrack:  '',
        };
        Object.entries(fields).forEach(([id, val]) => {
            const input = document.getElementById(id);
            if (input) input.value = val;
        });

        document.getElementById('metaSavedMsg')?.classList.add('hidden');
    }

    function initMetadataPanel() {
        document.getElementById('metaSaveBtn')?.addEventListener('click', () => {
            savedMeta = {
                title:  document.getElementById('metaTitle')?.value.trim()  || null,
                artist: document.getElementById('metaArtist')?.value.trim() || null,
                album:  document.getElementById('metaAlbum')?.value.trim()  || null,
                year:   document.getElementById('metaYear')?.value.trim()   || null,
                genre:  document.getElementById('metaGenre')?.value.trim()  || null,
                track:  document.getElementById('metaTrack')?.value.trim()  || null,
            };

            // FIX: Only save if at least one field has a value
            const hasAnyValue = Object.values(savedMeta).some(Boolean);
            if (!hasAnyValue) {
                savedMeta = null;
                return;
            }

            const msg = document.getElementById('metaSavedMsg');
            if (msg) {
                msg.textContent = '✓ Tags will be embedded on download';
                msg.classList.remove('hidden');
                // Keep it visible so user knows tags are active — hide on next fetch
            }
        });

        document.getElementById('metaClearBtn')?.addEventListener('click', () => {
            savedMeta = null;
            ['metaTitle', 'metaArtist', 'metaAlbum', 'metaYear', 'metaGenre', 'metaTrack']
                .forEach(id => { const e = document.getElementById(id); if (e) e.value = ''; });
            const msg = document.getElementById('metaSavedMsg');
            if (msg) {
                msg.textContent = 'Tags cleared.';
                msg.classList.remove('hidden');
                setTimeout(() => msg?.classList.add('hidden'), 2000);
            }
            if (currentVideo) syncMetadataPanel();
        });
    }

    function resetDownloadUI() {
        const postActions = document.getElementById('postDownloadActions');
        if (postActions) postActions.remove();

        const originalBtn = document.getElementById('downloadBtn');
        if (originalBtn) {
            originalBtn.style.display = 'flex';
            originalBtn.disabled = false;
            originalBtn.classList.remove('disabled');
        }

        const previewAudio = document.getElementById('previewAudio');
        const previewPlayerWrap = document.getElementById('previewPlayerWrap');
        const previewPlayBtn = document.getElementById('previewPlayBtn');

        if (previewAudio) {
            previewAudio.pause();
            previewAudio.src = '';
        }
        if (previewPlayerWrap) previewPlayerWrap.classList.add('hidden');
        if (previewPlayBtn)    previewPlayBtn.style.display = '';

        if (window.el && el.progressBar) {
            el.progressBar.style.width = '0%';
            el.progressBar.classList.remove('bg-green');
        }
        if (window.el && el.progressText) el.progressText.textContent = 'Ready';
    }

    // ── PANEL: Batch Download ─────────────────────────────────────────────────
    function initBatchPanel() {
        document.getElementById('batchStartBtn')?.addEventListener('click', startBatch);
    }

    async function startBatch() {
        const textarea = document.getElementById('batchUrls');
        if (!textarea) return;
        const lines = textarea.value.split('\n')
            .map(l => l.trim())
            .filter(l => l && (l.includes('youtube.com') || l.includes('youtu.be')));

        if (!lines.length) {
            textarea.style.borderColor = 'var(--red)';
            setTimeout(() => textarea.style.borderColor = '', 1500);
            return;
        }

        const format   = document.getElementById('batchFormat')?.value  || 'mp3';
        const quality  = document.getElementById('batchQuality')?.value || '320';
        const queueEl  = document.getElementById('batchQueue');
        const startBtn = document.getElementById('batchStartBtn');

        queueEl.classList.remove('hidden');
        startBtn.disabled = true;

        queueEl.innerHTML = `
            <div class="batch-item batch-item-summary">
                <span><i class="fas fa-circle-notch fa-spin"></i> Processing ${lines.length} URLs — a ZIP will be ready when done</span>
            </div>
            ${lines.map((url, i) =>
                `<div class="batch-item" id="bi-${i}">
                    <span class="batch-url">${escHtml(url.substring(0, 60))}${url.length > 60 ? '…' : ''}</span>
                    <span class="batch-status" id="bs-${i}"><i class="fas fa-clock"></i> Queued</span>
                </div>`
            ).join('')}
        `;

        try {
            const res  = await apiFetch('/api/batch-zip', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ urls: lines, format, quality }),
            });
            const data = await res.json();
            if (!data.id) throw new Error('Server did not return a job ID');

            const qs = `?_k=${encodeURIComponent(apiKey || '')}`;
            const es = new EventSource(`/api/download-progress/${data.id}${qs}`);

            es.onmessage = e => {
                let d; try { d = JSON.parse(e.data); } catch { return; }

                if (typeof d.done === 'number' && d.total) {
                    for (let i = 0; i < d.total; i++) {
                        const st = document.getElementById(`bs-${i}`);
                        if (!st) continue;
                        if (i < d.done) {
                            st.innerHTML = '<i class="fas fa-check" style="color:var(--green)"></i> Done';
                        } else if (i === d.done) {
                            st.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Converting...';
                        }
                    }
                }

                if (d.complete && d.downloadUrl) {
                    es.close();
                    startBtn.disabled = false;

                    lines.forEach((_, i) => {
                        const st = document.getElementById(`bs-${i}`);
                        if (st && !st.innerHTML.includes('fa-check'))
                            st.innerHTML = '<i class="fas fa-check" style="color:var(--green)"></i> Done';
                    });

                    const doneDiv = document.createElement('div');
                    doneDiv.className = 'batch-done';
                    doneDiv.innerHTML = `
                        <p class="batch-done-title"><i class="fas fa-check-circle"></i> ${d.done} / ${d.total} tracks → ZIP ready</p>
                        <a href="${escHtml(d.downloadUrl)}${qs}" download="${escHtml(d.filename)}" class="batch-dl-link">
                            <i class="fas fa-file-zipper"></i> Download ZIP
                        </a>
                    `;
                    queueEl.appendChild(doneDiv);
                    doneDiv.querySelector('a')?.click();
                }

                if (d.error) {
                    es.close();
                    startBtn.disabled = false;
                    const errDiv = document.createElement('div');
                    errDiv.className = 'batch-done';
                    errDiv.style.color = 'var(--red)';
                    errDiv.innerHTML = `<i class="fas fa-xmark"></i> Batch failed: ${escHtml(d.status || 'Unknown error')}`;
                    queueEl.appendChild(errDiv);
                }
            };

            es.onerror = () => {
                es.close();
                startBtn.disabled = false;
                const errDiv = document.createElement('div');
                errDiv.className = 'batch-done';
                errDiv.style.color = 'var(--red)';
                errDiv.textContent = 'Connection lost. Please try again.';
                queueEl.appendChild(errDiv);
            };

        } catch (err) {
            startBtn.disabled = false;
            const errDiv = document.createElement('div');
            errDiv.className = 'batch-done';
            errDiv.style.color = 'var(--red)';
            errDiv.textContent = 'Error: ' + err.message;
            queueEl.appendChild(errDiv);
        }
    }

    // ── Copy filename ─────────────────────────────────────────────────────────
    async function copyFilename() {
        const text = el.filename.value;
        if (!text) return;
        try { await navigator.clipboard.writeText(text); }
        catch { el.filename.select(); document.execCommand('copy'); }
        el.copyFilenameBtn.innerHTML = '<i class="fas fa-check"></i>';
        el.copyFilenameBtn.classList.add('copied');
        setTimeout(() => {
            el.copyFilenameBtn.innerHTML = '<i class="fas fa-copy"></i>';
            el.copyFilenameBtn.classList.remove('copied');
        }, 1800);
    }

    function showError(msg) {
        el.progressSection.classList.remove('hidden');
        el.statusMsg.textContent    = msg;
        el.statusMsg.style.color    = 'var(--red)';
        el.progressBar.style.width  = '0%';
        el.progressText.textContent = '';
        el.progressHint.textContent = '';
    }

    // ── Wire up everything ────────────────────────────────────────────────────
    setupDropdown('formatDropdown',       'audioFormat');
    setupDropdown('qualityDropdown',      'audioQuality');
    setupDropdown('titleDropdown',        'titleFormat');
    setupDropdown('batchFormatDropdown',  'batchFormat');
    setupDropdown('batchQualityDropdown', 'batchQuality');

    el.fetchBtn.addEventListener('click', fetchVideoInfo);
    el.downloadBtn.addEventListener('click', startDownload);
    el.cleanToggle.addEventListener('change', updateFilename);
    el.copyFilenameBtn.addEventListener('click', copyFilename);
    el.clearBtn.addEventListener('click', () => { el.urlInput.value = ''; el.urlInput.focus(); });
    el.urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') fetchVideoInfo(); });

    const toggle = document.getElementById('themeToggle');
    if (localStorage.getItem('theme') === 'light') {
        document.body.classList.add('light-mode');
        if (toggle) toggle.checked = true;
    }
    toggle?.addEventListener('change', () => {
        const light = toggle.checked;
        document.body.classList.toggle('light-mode', light);
        localStorage.setItem('theme', light ? 'light' : 'dark');
    });

    bootstrap();
    initDragDrop();
    initKeyboardShortcuts();
    initPanels();
    initPreviewPanel();
    initMetadataPanel();
    initBatchPanel();
    updateHistoryBadge();
    initMobileNav();

    // ── Mobile bottom nav ─────────────────────────────────────────────────────
    function initMobileNav() {
        const NAV = [
            { btnId: 'mobileNavHome',    action: () => { closeAllPanels(); setActive('mobileNavHome'); window.scrollTo({top:0,behavior:'smooth'}); } },
            { btnId: 'mobileNavPreview', panelId: 'previewPanel',  backdropId: 'previewBackdrop' },
            { btnId: 'mobileNavHistory', panelId: 'historyPanel',  backdropId: 'historyBackdrop' },
            { btnId: 'mobileNavMeta',    panelId: 'metaPanel',     backdropId: 'metaBackdrop'    },
            { btnId: 'mobileNavBatch',   panelId: 'batchPanel',    backdropId: 'batchBackdrop'   },
        ];

        function setActive(activeId) {
            NAV.forEach(({ btnId }) =>
                document.getElementById(btnId)?.classList.toggle('active', btnId === activeId)
            );
        }

        NAV.forEach(({ btnId, panelId, backdropId, action }) => {
            const btn = document.getElementById(btnId);
            if (!btn) return;
            btn.addEventListener('click', () => {
                if (action) { action(); return; }
                const panel   = document.getElementById(panelId);
                const isOpen  = panel && !panel.classList.contains('hidden');
                closeAllPanels();
                if (isOpen) {
                    setActive('mobileNavHome');
                } else {
                    setActive(btnId);
                    openPanel(panelId, backdropId);
                    if (panelId === 'historyPanel') renderHistory();
                }
            });
        });

        PANELS.forEach(({ backdropId, closeId }) => {
            document.getElementById(backdropId)?.addEventListener('click', () => setActive('mobileNavHome'));
            document.getElementById(closeId)?.addEventListener('click',    () => setActive('mobileNavHome'));
        });
    }

});