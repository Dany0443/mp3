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

    // ── Title cleaner — declared first so nothing hits TDZ ───────────────────
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

    // ── Utilities — also declared early ──────────────────────────────────────
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
            const res  = await fetch('/api/client-key');
            const data = await res.json();
            apiKey = data.key;
        } catch {
            showError('Could not reach server. Is it running?');
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
                if (currentVideo) updateSizeHints(); // recalc on any format/quality change
            });
        });
    }

    document.addEventListener('click', () => {
        document.querySelectorAll('.custom-dropdown').forEach(d => d.classList.remove('open'));
    });

    // ── File size hints ───────────────────────────────────────────────────────
    // Bitrate reference per format:
    //   mp3/ogg  → uses the selected kbps directly
    //   m4a(aac) → AAC is ~30% smaller than MP3 at same bitrate
    //   wav      → uncompressed PCM: 44100 * 16bit * 2ch = ~10 MB/min regardless of quality
    function updateSizeHints() {
        if (!currentVideo?.lengthSeconds) return;
        const secs   = currentVideo.lengthSeconds;
        const format = el.audioFormat.value; // mp3 | m4a | ogg | wav

        document.querySelectorAll('.size-hint').forEach(hint => {
            let mb;
            if (format === 'wav') {
                // Uncompressed: 44100 Hz * 16 bit * 2 ch = 1411 kbps
                mb = (1411 * 1000 / 8 * secs) / (1024 * 1024);
            } else {
                let kbps = parseInt(hint.dataset.kbps);
                if (format === 'm4a') kbps = kbps * 0.7; // AAC efficiency
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

    async function fetchVideoInfo() {
        const url = el.urlInput.value.trim();
        if (!url) {
            el.urlInput.focus();
            el.urlInput.style.borderColor = 'var(--red)';
            setTimeout(() => el.urlInput.style.borderColor = '', 1500);
            return;
        }

        setFetchLoading(true);
        clearExpiry();

        try {
            const res  = await apiFetch(`/api/video-info?url=${encodeURIComponent(url)}`);
            const data = await res.json();
            if (data.error) throw new Error(data.message || 'Failed to fetch info');

            currentVideo = data;

            if (data.isPlaylist) {
                el.title.textContent    = data.title;
                el.author.textContent   = `${data.count} tracks`;
                el.duration.textContent = '';
                el.thumb.src            = data.thumbnailUrl || '';
                el.playlistBadge?.classList.remove('hidden');
                el.filenameRow?.classList.add('hidden');
            } else {
                el.title.textContent    = data.title;
                el.author.textContent   = data.author;
                el.duration.textContent = formatTime(data.lengthSeconds);
                el.thumb.src            = data.thumbnailUrl;
                el.playlistBadge?.classList.add('hidden');
                el.filenameRow?.classList.remove('hidden');
                updateFilename();
                updateSizeHints();
            }

            el.infoSection.classList.remove('hidden');
            el.progressSection.classList.add('hidden');
            syncPreviewPanel();
            syncMetadataPanel();

        } catch (err) {
            showError('Could not fetch: ' + err.message);
        } finally {
            setFetchLoading(false);
        }
    }

    // ── Filename ──────────────────────────────────────────────────────────────
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

        let metaParams = '';
        if (savedMeta) {
            const mp = new URLSearchParams();
            if (savedMeta.title)  mp.set('metaTitle',  savedMeta.title);
            if (savedMeta.artist) mp.set('metaArtist', savedMeta.artist);
            if (savedMeta.album)  mp.set('metaAlbum',  savedMeta.album);
            if (savedMeta.year)   mp.set('metaYear',   savedMeta.year);
            if (savedMeta.genre)  mp.set('metaGenre',  savedMeta.genre);
            if (savedMeta.track)  mp.set('metaTrack',  savedMeta.track);
            metaParams = '&' + mp.toString();
        }

        try {
            const res  = await apiFetch(
                `/api/download?url=${encodeURIComponent(url)}&format=${format}&quality=${quality}&filename=${encodeURIComponent(filename)}${metaParams}`
            );
            const data = await res.json();
            if (!data.id) throw new Error('Failed to start download');
            etaStartTime = Date.now();
            startFakeRamp();
            listenToProgress(data.id);
        } catch (err) {
            el.statusMsg.textContent = 'Error: ' + err.message;
            el.downloadBtn.disabled  = false;
        }
    }

    // Fake progress ramp: 0→95 over ~5s, then holds until server says done
    let fakeRampInterval = null;

    function startFakeRamp() {
        stopFakeRamp();
        let fakeProgress = 0;
        const RAMP_DURATION = 3000; // ms to reach 95%
        const TICK = 80;            // update every 80ms
        const steps = RAMP_DURATION / TICK;
        const increment = 95 / steps;
        let countdown = Math.ceil(RAMP_DURATION / 1000);

        el.etaRow?.classList.remove('hidden');
        el.etaText.textContent = `~${countdown}s remaining`;

        fakeRampInterval = setInterval(() => {
            fakeProgress = Math.min(fakeProgress + increment, 95);
            el.progressBar.style.width  = fakeProgress.toFixed(1) + '%';
            el.progressText.textContent = Math.floor(fakeProgress) + '%';

            // Countdown in whole seconds
            const newCountdown = Math.max(1, Math.ceil((95 - fakeProgress) / increment * TICK / 1000));
            if (newCountdown !== countdown) {
                countdown = newCountdown;
                el.etaText.textContent = `~${countdown}s remaining`;
            }

            if (fakeProgress >= 95) {
                stopFakeRamp();
                el.statusMsg.textContent    = 'Finalizing...';
                el.etaText.textContent      = 'Almost done...';
            }
        }, TICK);
    }

    function stopFakeRamp() {
        if (fakeRampInterval) { clearInterval(fakeRampInterval); fakeRampInterval = null; }
    }

    function listenToProgress(id) {
        if (eventSource) eventSource.close();
        const qs = `?_k=${encodeURIComponent(apiKey || '')}`;
        eventSource = new EventSource(`/api/download-progress/${id}${qs}`);

        eventSource.onmessage = e => {
            let data;
            try { data = JSON.parse(e.data); } catch { return; }

            // Only show status text updates from server — let fake ramp own the bar
            if (data.status && data.status !== 'Queued') {
                el.statusMsg.textContent = data.status;
            }

            if (data.status === 'Queued')     el.progressHint.textContent = 'Waiting in queue...';
            if (data.isPlaylist && data.total) el.progressHint.textContent = `Tracks: ${data.done || 0} / ${data.total} done`;

            if (data.error) {
                stopFakeRamp();
                eventSource.close();
                el.statusMsg.textContent    = data.status || 'Something went wrong.';
                el.statusMsg.style.color    = 'var(--red)';
                el.progressHint.textContent = 'Please try again.';
                el.downloadBtn.disabled     = false;
                el.etaRow?.classList.add('hidden');
                return;
            }

            if (data.complete) {
                stopFakeRamp();
                eventSource.close();
                el.etaRow?.classList.add('hidden');
                if (!data.downloadUrl) {
                    el.statusMsg.textContent = 'Error: download URL missing. Please retry.';
                    el.statusMsg.style.color = 'var(--red)';
                    el.downloadBtn.disabled  = false;
                    return;
                }
                // Quickly fill to 100% then finish
                el.progressBar.style.width  = '100%';
                el.progressText.textContent = '100%';
                finishDownload(data);
            }
        };

        eventSource.onerror = () => {
            stopFakeRamp();
            eventSource.close();
            el.statusMsg.textContent = 'Connection lost. Please try again.';
            el.statusMsg.style.color = 'var(--red)';
            el.downloadBtn.disabled  = false;
            el.etaRow?.classList.add('hidden');
        };
    }

    function finishDownload(data) {
        const isPlaylist   = data.isPlaylist;
        const saveFilename = data.filename || el.filename.value || 'download';

        el.statusMsg.textContent    = isPlaylist ? 'Playlist ready!' : 'Ready to save!';
        el.progressBar.style.width  = '100%';
        el.progressText.textContent = '100%';
        el.progressHint.textContent = isPlaylist
            ? `${data.done} of ${data.total} tracks downloaded as ZIP` : '';

        el.progressSection.querySelector('.download-success-btn')?.remove();

        const btn    = document.createElement('a');
        btn.href     = data.downloadUrl + `?_k=${encodeURIComponent(apiKey || '')}`;
        btn.className = 'download-success-btn';
        btn.innerHTML = isPlaylist
            ? '<i class="fas fa-file-zipper"></i> Save ZIP'
            : '<i class="fas fa-file-arrow-down"></i> Save File';
        btn.download = saveFilename;
        el.progressSection.appendChild(btn);
        btn.click();

        el.downloadBtn.disabled = false;

        if (currentVideo) {
            addToHistory({
                title:     currentVideo.title,
                author:    currentVideo.author,
                thumbnail: currentVideo.thumbnailUrl,
                format:    el.audioFormat.value,
                quality:   el.audioQuality.value,
                filename:  saveFilename,
                url:       btn.href,
                expiresAt: data.expiresAt || null,
                date:      Date.now(),
                isPlaylist: !!isPlaylist,
            });
        }

        if (data.expiresAt) startExpiry(data.expiresAt);
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

            // Cmd/Ctrl+V anywhere (outside inputs) → paste & fetch
            if ((e.metaKey || e.ctrlKey) && e.key === 'v' && !isInput) {
                e.preventDefault();
                navigator.clipboard.readText().then(text => {
                    if (text.includes('youtube.com') || text.includes('youtu.be')) {
                        el.urlInput.value = text.trim();
                        fetchVideoInfo();
                    }
                }).catch(() => {});
            }

            // Enter (outside inputs, info visible) → download
            if (e.key === 'Enter' && !isInput &&
                !el.infoSection.classList.contains('hidden') &&
                !el.downloadBtn.disabled) {
                startDownload();
            }

            // Escape → close panels / unfocus
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
        // rAF so the browser paints before we add the transition class
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
                `/api/download?url=${encodeURIComponent(url)}&format=${format}&quality=${quality}&filename=preview&preview=1`
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
        const h = getHistory();
        const sourceUrl = el.urlInput.value.trim();
        const newEntry  = { ...item, sourceUrl };

        // If same video URL already exists, replace it in-place and move to top
        const existingIdx = h.findIndex(e => e.sourceUrl && e.sourceUrl === sourceUrl);
        if (existingIdx !== -1) {
            h.splice(existingIdx, 1);
        }
        h.unshift(newEntry);

        saveHistory(h);
        updateHistoryBadge();
    }

    function updateHistoryBadge() {
        const badge   = document.getElementById('historyBadge');
        const count   = getHistory().length;
        if (!badge) return;
        badge.textContent = count > 9 ? '9+' : count;
        badge.classList.toggle('hidden', count === 0);
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
            return `<div class="history-item">
                <img src="${escHtml(item.thumbnail || '')}" class="history-thumb" alt="" onerror="this.style.display='none'">
                <div class="history-info">
                    <p class="history-title">${escHtml(item.title)}</p>
                    <p class="history-meta">${escHtml(item.author || '')} · ${(item.format || '').toUpperCase()} ${item.quality || ''}kbps · ${date}</p>
                </div>
                <div class="history-actions">
                    ${!expired && item.url
                        ? `<a href="${escHtml(item.url)}" download="${escHtml(item.filename)}" class="history-dl-btn" title="Re-download"><i class="fas fa-arrow-down"></i></a>`
                        : `<span class="history-expired" title="Expired"><i class="fas fa-clock"></i></span>`}
                    <button class="history-del-btn" data-index="${i}" title="Remove"><i class="fas fa-xmark"></i></button>
                </div>
            </div>`;
        }).join('');

        list.querySelectorAll('.history-del-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const h = getHistory();
                h.splice(parseInt(btn.dataset.index), 1);
                saveHistory(h);
                renderHistory();
            });
        });

        // Wire clear-all (re-attach each render since innerHTML replaces it)
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

        // If user already clicked "Apply Tags", don't clobber their manual edits
        if (savedMeta) return;

        const { cleaned } = smartCleanTitle(currentVideo.title);

        // Always overwrite with fresh video data on every new fetch
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

        // Clear any stale "Tags will be embedded" message
        document.getElementById('metaSavedMsg')?.classList.add('hidden');
    }

    function initMetadataPanel() {
        document.getElementById('metaSaveBtn')?.addEventListener('click', () => {
            savedMeta = {
                title:  document.getElementById('metaTitle')?.value.trim(),
                artist: document.getElementById('metaArtist')?.value.trim(),
                album:  document.getElementById('metaAlbum')?.value.trim(),
                year:   document.getElementById('metaYear')?.value.trim(),
                genre:  document.getElementById('metaGenre')?.value.trim(),
                track:  document.getElementById('metaTrack')?.value.trim(),
            };
            const msg = document.getElementById('metaSavedMsg');
            msg?.classList.remove('hidden');
            setTimeout(() => msg?.classList.add('hidden'), 3000);
        });

        document.getElementById('metaClearBtn')?.addEventListener('click', () => {
            savedMeta = null; // allow syncMetadataPanel to re-fill on next fetch
            ['metaTitle', 'metaArtist', 'metaAlbum', 'metaYear', 'metaGenre', 'metaTrack']
                .forEach(id => { const e = document.getElementById(id); if (e) e.value = ''; });
            document.getElementById('metaSavedMsg')?.classList.add('hidden');
            if (currentVideo) syncMetadataPanel(); // re-fill with current video
        });
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

        queueEl.innerHTML = lines.map((url, i) =>
            `<div class="batch-item" id="bi-${i}">
                <span class="batch-url">${escHtml(url.substring(0, 55))}${url.length > 55 ? '…' : ''}</span>
                <span class="batch-status" id="bs-${i}"><i class="fas fa-clock"></i> Queued</span>
            </div>`
        ).join('');

        const completed = [];
        for (let i = 0; i < lines.length; i++) {
            const statusEl = document.getElementById(`bs-${i}`);
            try {
                if (statusEl) statusEl.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Fetching...';

                const infoRes = await apiFetch(`/api/video-info?url=${encodeURIComponent(lines[i])}`);
                const info    = await infoRes.json();
                if (info.error) throw new Error(info.message);

                const fn = sanitizeFilename(info.title || `track_${i + 1}`);
                if (statusEl) statusEl.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Downloading...';

                const dlRes  = await apiFetch(`/api/download?url=${encodeURIComponent(lines[i])}&format=${format}&quality=${quality}&filename=${encodeURIComponent(fn)}`);
                const dlData = await dlRes.json();
                if (!dlData.id) throw new Error('No job ID');

                await new Promise(resolve => {
                    const qs = `?_k=${encodeURIComponent(apiKey || '')}`;
                    const es = new EventSource(`/api/download-progress/${dlData.id}${qs}`);
                    es.onmessage = e => {
                        let d; try { d = JSON.parse(e.data); } catch { return; }
                        if (statusEl && typeof d.progress === 'number')
                            statusEl.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> ${d.progress}%`;
                        if (d.complete && d.downloadUrl) {
                            es.close();
                            if (statusEl) statusEl.innerHTML = '<i class="fas fa-check" style="color:var(--green)"></i> Done';
                            completed.push({ url: d.downloadUrl + qs, filename: fn + '.' + format });
                            resolve();
                        }
                        if (d.error) {
                            es.close();
                            if (statusEl) statusEl.innerHTML = '<i class="fas fa-xmark" style="color:var(--red)"></i> Failed';
                            resolve();
                        }
                    };
                    es.onerror = () => {
                        es.close();
                        if (statusEl) statusEl.innerHTML = '<i class="fas fa-xmark" style="color:var(--red)"></i> Error';
                        resolve();
                    };
                });
            } catch {
                if (statusEl) statusEl.innerHTML = '<i class="fas fa-xmark" style="color:var(--red)"></i> Error';
            }
        }

        startBtn.disabled = false;
        const doneDiv = document.createElement('div');
        doneDiv.className = 'batch-done';
        doneDiv.innerHTML = `<p class="batch-done-title"><i class="fas fa-check-circle"></i> ${completed.length} / ${lines.length} files ready</p>`;
        completed.forEach(item => {
            const a     = document.createElement('a');
            a.href      = item.url;
            a.download  = item.filename;
            a.className = 'batch-dl-link';
            a.innerHTML = `<i class="fas fa-file-audio"></i> ${escHtml(item.filename)}`;
            doneDiv.appendChild(a);
            setTimeout(() => a.click(), 400);
        });
        queueEl.appendChild(doneDiv);
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

    // Theme toggle
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
    updateHistoryBadge(); // show badge count on load from existing history
});