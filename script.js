document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const videoUrlInput = document.getElementById('videoUrl');
    const fetchBtn = document.getElementById('fetchBtn');
    const videoInfoSection = document.getElementById('videoInfo');
    const thumbnail = document.getElementById('thumbnail');
    const videoTitle = document.getElementById('videoTitle');
    const videoDuration = document.getElementById('videoDuration');
    const videoAuthor = document.getElementById('videoAuthor');
    const audioFormatSelect = document.getElementById('audioFormat');
    const audioQualitySelect = document.getElementById('audioQuality');
    const titleFormatSelect = document.getElementById('titleFormat');
    const customFormatInput = document.getElementById('customFormat');
    const formatExample = document.getElementById('formatExample');
    const outputFilenameInput = document.getElementById('outputFilename');
    const downloadBtn = document.getElementById('downloadBtn');
    const downloadProgressSection = document.getElementById('downloadProgress');
    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');
    const statusMessage = document.getElementById('statusMessage');
    const downloadHistory = document.getElementById('downloadHistory');
    const historyList = document.getElementById('historyList');

    // Video data storage
    let currentVideoData = null;
    
    // Local storage for download history
    const downloadHistoryItems = JSON.parse(localStorage.getItem('downloadHistory') || '[]');
    
    // Update download history display if items exist
    if (downloadHistoryItems.length > 0) {
        updateDownloadHistoryDisplay();
        downloadHistory.classList.remove('hidden');
    }

    // Event Listeners
    fetchBtn.addEventListener('click', fetchVideoInfo);
    downloadBtn.addEventListener('click', downloadAudio);
    titleFormatSelect.addEventListener('change', handleTitleFormatChange);
    audioQualitySelect.addEventListener('change', updateOutputFilename);
    audioFormatSelect.addEventListener('change', updateOutputFilename);
    customFormatInput.addEventListener('input', updateOutputFilename);
    outputFilenameInput.addEventListener('input', validateFilename);

    // Handle title format change
    function handleTitleFormatChange() {
        if (titleFormatSelect.value === 'custom') {
            customFormatInput.classList.remove('hidden');
        } else {
            customFormatInput.classList.add('hidden');
        }
        updateOutputFilename();
    }
    
    // Validate and correct filename if needed
    function validateFilename() {
        let filename = outputFilenameInput.value;
        // Replace invalid characters
        filename = filename.replace(/[\\/:*?"<>|]/g, '_');
        // Update if sanitized filename is different
        if (filename !== outputFilenameInput.value) {
            outputFilenameInput.value = filename;
        }
    }

    // Fetch video information
    async function fetchVideoInfo() {
        const videoUrl = videoUrlInput.value.trim();
        
        if (!videoUrl) {
            alert('Please enter a YouTube URL');
            return;
        }

        if (!isValidYoutubeUrl(videoUrl)) {
            alert('Please enter a valid YouTube URL');
            return;
        }

        // Show loading state
        fetchBtn.disabled = true;
        fetchBtn.textContent = 'Fetching...';
        
        try {
            const response = await fetch(`/api/video-info?url=${encodeURIComponent(videoUrl)}`);
            
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || errorData.message || 'Failed to fetch video info');
            }
            
            const data = await response.json();
            currentVideoData = data;
            
            // Update UI with video info
            displayVideoInfo(data);
            updateOutputFilename();
            
            // Show video info section
            videoInfoSection.classList.remove('hidden');
            downloadBtn.disabled = false;
            
        } catch (error) {
            console.error('Error fetching video info:', error);
            let errorMessage = 'Error fetching video information.';
            
            // Check for specific YouTube API errors
            if (error.message.includes('YouTube may have changed their API') || 
                error.message.includes('Could not extract') || 
                error.message.includes('signature')) {
                errorMessage = 'YouTube API extraction error. This may be due to recent YouTube changes. The system will try alternative download methods, but if this fails, please try a different video.';
                
                // Show a more detailed error message in the UI instead of an alert
                const errorDiv = document.createElement('div');
                errorDiv.className = 'error-message';
                errorDiv.innerHTML = `
                    <p><strong>YouTube API extraction error</strong></p>
                    <p>This may be due to recent YouTube changes. The system will try alternative download methods.</p>
                    <p>If download fails, please try a different video.</p>
                    <button id="dismissError" class="btn">OK</button>
                `;
                
                // Add to page before the input section
                const inputSection = document.querySelector('.input-section');
                inputSection.parentNode.insertBefore(errorDiv, inputSection);
                
                // Add dismiss button functionality
                document.getElementById('dismissError').addEventListener('click', () => {
                    errorDiv.remove();
                });
                
                return; // Don't show the alert
            }
            
            alert(errorMessage);
        } finally {
            // Reset button state
            fetchBtn.disabled = false;
            fetchBtn.textContent = 'Fetch Video';
        }
    }

    // Display video information
    function displayVideoInfo(data) {
        thumbnail.src = data.thumbnailUrl;
        videoTitle.textContent = data.title;
        videoDuration.textContent = `Duration: ${formatDuration(data.lengthSeconds)}`;
        videoAuthor.textContent = `Channel: ${data.author}`;
    }

    // Update output filename based on selected format
    function updateOutputFilename() {
        if (!currentVideoData) return;
        
        const title = currentVideoData.title;
        const artist = currentVideoData.author;
        const year = new Date().getFullYear(); // Current year as a placeholder
        
        let formattedName = '';
        
        if (titleFormatSelect.value === 'custom') {
            const customFormat = customFormatInput.value || '{title}';
            formattedName = customFormat
                .replace(/{title}/g, title)
                .replace(/{artist}/g, artist)
                .replace(/{year}/g, year);
                
            // Update the example display
            formatExample.textContent = formattedName;
        } else {
            formattedName = titleFormatSelect.value
                .replace(/{title}/g, title)
                .replace(/{artist}/g, artist)
                .replace(/{year}/g, year);
        }
        
        // Add quality suffix and extension based on selected format
        const quality = audioQualitySelect.value;
        const format = audioFormatSelect.value;
        const filename = `${formattedName} [${quality}kbps].${format}`;
        
        // Clean filename of invalid characters
        outputFilenameInput.value = filename.replace(/[\\/:*?"<>|]/g, '_');
    }

    // Download audio
    async function downloadAudio() {
        if (!currentVideoData) return;
        
        const videoUrl = videoUrlInput.value.trim();
        const quality = audioQualitySelect.value;
        const audioFormat = audioFormatSelect.value;
        const filename = outputFilenameInput.value;
        
        // Show download progress section
        downloadProgressSection.classList.remove('hidden');
        downloadBtn.disabled = true;
        statusMessage.textContent = 'Preparing download...';
        updateProgress(0);
        
        try {
            // Start download process
            const response = await fetch('/api/download', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    url: videoUrl,
                    quality: quality,
                    filename: filename,
                    audioFormat: audioFormat
                })
            });
            
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Download failed');
            }
            
            // Set up event source for progress updates
            const downloadId = await response.json();
            const eventSource = new EventSource(`/api/download-progress/${downloadId.id}`);
            
            eventSource.onmessage = (event) => {
                const data = JSON.parse(event.data);
                
                if (data.progress) {
                    updateProgress(data.progress);
                }
                
                if (data.status) {
                    statusMessage.textContent = data.status;
                }
                
                if (data.complete) {
                    eventSource.close();
                    completeDownload(data.downloadUrl);
                    
                    // Add to download history
                    addToDownloadHistory({
                        title: currentVideoData.title,
                        author: currentVideoData.author,
                        thumbnail: currentVideoData.thumbnailUrl,
                        filename: filename,
                        format: audioFormat,
                        quality: quality,
                        downloadUrl: data.downloadUrl,
                        timestamp: new Date().toISOString()
                    });
                }
                
                if (data.error) {
                    eventSource.close();
                    handleDownloadError(data.status || 'Download failed');
                }
            };
            
            eventSource.onerror = () => {
                eventSource.close();
                handleDownloadError('Connection to server lost');
            };
            
        } catch (error) {
            console.error('Download error:', error);
            handleDownloadError(error.message);
        }
    }

    // Update progress bar
    function updateProgress(percent) {
        progressBar.style.width = `${percent}%`;
        progressText.textContent = `${Math.round(percent)}%`;
    }

    // Complete download process
    function completeDownload(downloadUrl) {
        // Update UI
        statusMessage.textContent = 'Download complete!';
        progressBar.style.width = '100%';
        progressText.textContent = '100%';
        
        // Create download link
        const downloadLinkContainer = document.createElement('div');
        downloadLinkContainer.className = 'download-link-container';
        
        const downloadLink = document.createElement('a');
        downloadLink.href = downloadUrl;
        downloadLink.className = 'download-link';
        downloadLink.innerHTML = `<i class="fas fa-download"></i> Download ${audioFormatSelect.value.toUpperCase()} File`;
        downloadLink.download = outputFilenameInput.value;
        
        downloadLinkContainer.appendChild(downloadLink);
        downloadProgressSection.appendChild(downloadLinkContainer);
        
        // Auto-download
        setTimeout(() => {
            downloadLink.click();
        }, 1000);
        
        // Reset UI for new downloads
        setTimeout(() => {
            downloadBtn.disabled = false;
        }, 2000);
    }

    // Handle download error
    function handleDownloadError(errorMessage) {
        statusMessage.textContent = `Error: ${errorMessage}`;
        statusMessage.classList.add('error');
        progressBar.style.backgroundColor = '#ff3b30';
        downloadBtn.disabled = false;
    }
    
    // Add to download history
    function addToDownloadHistory(downloadItem) {
        // Add to front of array (most recent first)
        downloadHistoryItems.unshift(downloadItem);
        
        // Limit to 10 items
        if (downloadHistoryItems.length > 10) {
            downloadHistoryItems.pop();
        }
        
        // Save to local storage
        localStorage.setItem('downloadHistory', JSON.stringify(downloadHistoryItems));
        
        // Update display
        updateDownloadHistoryDisplay();
        downloadHistory.classList.remove('hidden');
    }
    
    // Update download history display
    function updateDownloadHistoryDisplay() {
        historyList.innerHTML = '';
        
        downloadHistoryItems.forEach(item => {
            const historyItem = document.createElement('div');
            historyItem.className = 'history-item';
            
            historyItem.innerHTML = `
                <div class="history-thumb">
                    <img src="${item.thumbnail}" alt="${item.title}">
                </div>
                <div class="history-details">
                    <h4>${item.title}</h4>
                    <p>${item.author}</p>
                    <p class="history-meta">
                        <span class="format-badge ${item.format}">${item.format.toUpperCase()}</span>
                        <span>${item.quality}kbps</span>
                        <span>${new Date(item.timestamp).toLocaleString()}</span>
                    </p>
                </div>
                <div class="history-actions">
                    <a href="${item.downloadUrl}" download="${item.filename}" class="history-download">
                        <i class="fas fa-download"></i>
                    </a>
                </div>
            `;
            
            historyList.appendChild(historyItem);
        });
    }

    // Format duration from seconds to MM:SS or HH:MM:SS
    function formatDuration(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        
        if (hours > 0) {
            return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        } else {
            return `${minutes}:${secs.toString().padStart(2, '0')}`;
        }
    }

    // Validate YouTube URL
    function isValidYoutubeUrl(url) {
        const ytRegExp = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/;
        return ytRegExp.test(url);
    }
});