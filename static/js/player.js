/* =========================================================================
   WinampZ player engine
   Audio/video state machine, Web Audio API EQ + visualizer,
   playlist / library management, window chrome.
   ========================================================================= */

(() => {
  "use strict";

  const EQ_FREQS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];

  const EQ_PRESETS = {
    Flat:       [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    Rock:       [5, 4, 3, 0, -2, -3, 0, 2, 4, 5],
    Pop:        [-1, 2, 4, 4, 2, -1, -2, -2, -1, -1],
    Jazz:       [3, 2, 0, 0, -2, -2, 0, 2, 3, 4],
    "Bass Boost": [8, 7, 5, 3, 1, 0, 0, 0, 0, 0],
  };

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  const state = {
    queue: [],
    currentIndex: -1,
    playOrder: [],
    orderPos: 0,
    activePlaylistId: null,
    shuffle: false,
    repeat: "none", // none | all | one
    isPlaying: false,
    showRemaining: false,
    visualizerMode: "bars",
    volume: 80,
    balance: 0,
    eqEnabled: false,
    eqPreamp: 0,
    eqBands: Array(10).fill(0),
    eqPreset: "Flat",
    isSeeking: false,
    loadGeneration: 0,
  };

  let contextTarget = null; // {type:'library'|'playlist', mediaId, playlistItemId, index}

  // -----------------------------------------------------------------------
  // DOM refs (populated in cacheDom)
  // -----------------------------------------------------------------------

  const $ = (id) => document.getElementById(id);
  let dom = {};

  function cacheDom() {
    dom = {
      desktop: $("desktop"),
      elAudio: $("audio-el"),
      elVideo: $("video-el"),
      videoWindow: $("video-window"),
      videoOverlay: $("video-overlay-msg"),

      marquee: $("lcd-marquee"),
      marqueeText: $("lcd-marquee-text"),
      lcdTime: $("lcd-time"),
      bitrateValue: $("lcd-bitrate-value"),
      samplerateValue: $("lcd-samplerate-value"),
      indPlay: $("ind-play"),
      indShuffle: $("ind-shuffle"),
      indRepeat: $("ind-repeat"),
      canvas: $("visualizer-canvas"),

      seekSlider: $("seek-slider"),
      btnPrev: $("btn-prev"),
      btnPlay: $("btn-play"),
      btnPause: $("btn-pause"),
      btnStop: $("btn-stop"),
      btnNext: $("btn-next"),
      btnEject: $("btn-eject"),
      btnShuffle: $("btn-shuffle"),
      btnRepeat: $("btn-repeat"),
      btnVizMode: $("btn-viz-mode"),
      volumeSlider: $("volume-slider"),
      balanceSlider: $("balance-slider"),

      eqWindow: $("eq-window"),
      eqEnabledCheckbox: $("eq-enabled-checkbox"),
      eqPresetSelect: $("eq-preset-select"),
      eqPreamp: $("eq-preamp"),
      eqPreampValue: $("eq-value-preamp"),

      playlistWindow: $("playlist-window"),
      playlistSelect: $("playlist-select"),
      btnNewPlaylist: $("btn-new-playlist"),
      btnDeletePlaylist: $("btn-delete-playlist"),
      playlistSearch: $("playlist-search"),
      playlistList: $("playlist-list"),
      playlistSummary: $("playlist-summary"),
      btnPlaylistClear: $("btn-playlist-clear"),

      libraryWindow: $("library-window"),
      librarySearch: $("library-search"),
      scanInput: $("scan-directory-input"),
      btnScan: $("btn-scan"),
      dropzone: $("dropzone"),
      fileInput: $("file-input"),
      libraryList: $("library-list"),

      youtubeUrlInput: $("youtube-url-input"),
      youtubeFormatSelect: $("youtube-format-select"),
      btnYoutubeImport: $("btn-youtube-import"),
      youtubeProgress: $("youtube-progress"),

      contextMenu: $("context-menu"),
      infoModal: $("info-modal"),
      infoModalBody: $("info-modal-body"),
      btnCloseModal: $("btn-close-modal"),
      toast: $("toast"),

      btnVideoFullscreen: $("btn-video-fullscreen"),
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return "00:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function fmtDb(v) {
    v = Number(v);
    return (v > 0 ? "+" : "") + v;
  }

  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function humanSize(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    let val = bytes;
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    return `${val.toFixed(1)} ${units[i]}`;
  }

  let toastTimer = null;
  function toast(message, isError = false, duration = 3200) {
    dom.toast.textContent = message;
    dom.toast.classList.toggle("error", !!isError);
    dom.toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => dom.toast.classList.add("hidden"), duration);
  }

  let settingsSaveTimer = null;
  let pendingSettings = {};
  function saveSettings(partial) {
    Object.assign(pendingSettings, partial);
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = setTimeout(() => {
      const body = JSON.stringify({ settings: pendingSettings });
      pendingSettings = {};
      fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }).catch(() => {});
    }, 400);
  }

  // -----------------------------------------------------------------------
  // Web Audio graph: EQ + visualizer + volume/balance
  // -----------------------------------------------------------------------

  let audioCtx = null;
  let preampGain = null;
  let filters = [];
  let pannerNode = null;
  let masterGain = null;
  let analyser = null;
  let activeEl = null;

  function ensureAudioGraph() {
    if (audioCtx) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContextClass();

    preampGain = audioCtx.createGain();
    filters = EQ_FREQS.map((freq) => {
      const f = audioCtx.createBiquadFilter();
      f.type = "peaking";
      f.frequency.value = freq;
      f.Q.value = 1.1;
      f.gain.value = 0;
      return f;
    });
    pannerNode = audioCtx.createStereoPanner();
    masterGain = audioCtx.createGain();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;

    const sourceAudio = audioCtx.createMediaElementSource(dom.elAudio);
    const sourceVideo = audioCtx.createMediaElementSource(dom.elVideo);
    sourceAudio.connect(preampGain);
    sourceVideo.connect(preampGain);

    let node = preampGain;
    filters.forEach((f) => { node.connect(f); node = f; });
    node.connect(pannerNode);
    pannerNode.connect(masterGain);
    masterGain.connect(analyser);
    analyser.connect(audioCtx.destination);

    applyVolumeToGraph();
    applyBalanceToGraph();
    applyEqToGraph();
    startVisualizerLoop();
  }

  function dbToLinear(db) { return Math.pow(10, db / 20); }

  function applyVolumeToGraph() {
    if (masterGain) masterGain.gain.value = state.volume / 100;
  }

  function applyBalanceToGraph() {
    if (pannerNode) pannerNode.pan.value = state.balance / 100;
  }

  function applyEqToGraph() {
    if (!preampGain) return;
    preampGain.gain.value = state.eqEnabled ? dbToLinear(state.eqPreamp) : 1;
    filters.forEach((f, i) => { f.gain.value = state.eqEnabled ? state.eqBands[i] : 0; });
  }

  // -----------------------------------------------------------------------
  // Visualizer (canvas spectrum / oscilloscope)
  // -----------------------------------------------------------------------

  let vizFreqData = null;
  let vizTimeData = null;
  let peakHeights = null;
  let vizRafId = null;

  function startVisualizerLoop() {
    vizFreqData = new Uint8Array(analyser.frequencyBinCount);
    vizTimeData = new Uint8Array(analyser.fftSize);
    const NUM_BARS = 28;
    peakHeights = new Array(NUM_BARS).fill(0);

    const ctx = dom.canvas.getContext("2d");
    const W = dom.canvas.width;
    const H = dom.canvas.height;

    function drawBars() {
      analyser.getByteFrequencyData(vizFreqData);
      ctx.clearRect(0, 0, W, H);
      const usableBins = Math.floor(vizFreqData.length * 0.5);
      const perBar = Math.max(1, Math.floor(usableBins / NUM_BARS));
      const barWidth = W / NUM_BARS;

      for (let i = 0; i < NUM_BARS; i++) {
        let sum = 0;
        const start = i * perBar;
        for (let j = 0; j < perBar; j++) sum += vizFreqData[start + j] || 0;
        const avg = sum / perBar;
        const barHeight = (avg / 255) * H;

        if (barHeight >= peakHeights[i]) peakHeights[i] = barHeight;
        else peakHeights[i] = Math.max(0, peakHeights[i] - H * 0.02);

        const x = i * barWidth + 1;
        const w = barWidth - 2;
        const grad = ctx.createLinearGradient(0, H, 0, 0);
        grad.addColorStop(0, "#39ff14");
        grad.addColorStop(0.7, "#8aff2a");
        grad.addColorStop(1, "#ffb000");
        ctx.fillStyle = grad;
        ctx.fillRect(x, H - barHeight, w, barHeight);

        ctx.fillStyle = "#ffb000";
        ctx.fillRect(x, H - peakHeights[i] - 2, w, 2);
      }
    }

    function drawScope() {
      analyser.getByteTimeDomainData(vizTimeData);
      ctx.clearRect(0, 0, W, H);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#39ff14";
      ctx.shadowColor = "#39ff14";
      ctx.shadowBlur = 4;
      ctx.beginPath();
      const sliceWidth = W / vizTimeData.length;
      let x = 0;
      for (let i = 0; i < vizTimeData.length; i++) {
        const v = vizTimeData[i] / 128.0;
        const y = (v * H) / 2;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        x += sliceWidth;
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    function loop() {
      if (state.visualizerMode === "bars") drawBars(); else drawScope();
      vizRafId = requestAnimationFrame(loop);
    }
    if (vizRafId) cancelAnimationFrame(vizRafId);
    loop();
  }

  // -----------------------------------------------------------------------
  // Marquee
  // -----------------------------------------------------------------------

  let marqueeRafId = null;
  let marqueeX = 0;

  function setMarqueeText(text) {
    const wrapWidth = dom.marquee.parentElement.clientWidth;
    dom.marqueeText.textContent = text;
    const singleWidth = dom.marqueeText.scrollWidth;

    if (marqueeRafId) { cancelAnimationFrame(marqueeRafId); marqueeRafId = null; }
    dom.marqueeText.style.transform = "translateX(0)";
    marqueeX = 0;

    if (singleWidth <= wrapWidth) return;

    dom.marqueeText.textContent = `${text}   ***   ${text}   ***   `;
    const fullWidth = dom.marqueeText.scrollWidth / 2;

    function step() {
      marqueeX -= 1;
      if (Math.abs(marqueeX) >= fullWidth) marqueeX = 0;
      dom.marqueeText.style.transform = `translateX(${marqueeX}px)`;
      marqueeRafId = requestAnimationFrame(step);
    }
    marqueeRafId = requestAnimationFrame(step);
  }

  // -----------------------------------------------------------------------
  // Transport / playback
  // -----------------------------------------------------------------------

  function updateStatsDisplay(track) {
    dom.bitrateValue.textContent = Math.round(track.bitrate || 0);
    dom.samplerateValue.textContent = track.sample_rate ? (track.sample_rate / 1000).toFixed(1) : "0";
  }

  function buildPlayOrder(preserveIndex = true) {
    const n = state.queue.length;
    const order = Array.from({ length: n }, (_, i) => i);
    if (state.shuffle) {
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
    }
    state.playOrder = order;
    if (preserveIndex && state.currentIndex >= 0) {
      const pos = order.indexOf(state.currentIndex);
      state.orderPos = pos === -1 ? 0 : pos;
    } else {
      state.orderPos = 0;
    }
  }

  function highlightPlaylistItem() {
    document.querySelectorAll(".playlist-item").forEach((li) => {
      li.classList.toggle("playing", Number(li.dataset.index) === state.currentIndex);
    });
  }

  async function waitForStreamReady(mediaId, isVideo, generation) {
    const url = `/api/stream/${mediaId}`;
    const stale = () => generation !== state.loadGeneration;

    for (let attempt = 0; attempt < 180; attempt++) {
      if (stale()) return { ok: false, reason: "superseded" };
      let resp;
      try {
        resp = await fetch(url, { headers: { Range: "bytes=0-1" } });
      } catch (err) {
        return { ok: false, reason: "network error" };
      }
      if (stale()) return { ok: false, reason: "superseded" };

      if (resp.status === 200 || resp.status === 206) {
        if (isVideo) dom.videoOverlay.classList.add("hidden");
        return { ok: true, url };
      }
      if (resp.status === 202) {
        if (isVideo) dom.videoOverlay.classList.remove("hidden");
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      let reason = "stream unavailable";
      try { reason = (await resp.json()).reason || reason; } catch (err) { /* noop */ }
      if (isVideo) dom.videoOverlay.classList.add("hidden");
      return { ok: false, reason };
    }
    return { ok: false, reason: "timed out waiting for transcode" };
  }

  function showVideoWindow(show) {
    if (show) {
      dom.videoWindow.classList.remove("hidden");
      dom.canvas.classList.add("hidden");
    } else {
      dom.videoOverlay.classList.add("hidden");
      dom.canvas.classList.remove("hidden");
    }
  }

  async function loadTrack(idx, autoplay = true) {
    if (idx < 0 || idx >= state.queue.length) return;
    ensureAudioGraph();

    const myGeneration = ++state.loadGeneration;
    const track = state.queue[idx];
    const isVideo = track.media_type === "video";
    const el = isVideo ? dom.elVideo : dom.elAudio;
    const other = isVideo ? dom.elAudio : dom.elVideo;

    other.pause();
    other.removeAttribute("src");
    other.load();

    state.currentIndex = idx;
    showVideoWindow(isVideo);
    dom.videoOverlay.classList.add("hidden");
    setMarqueeText(`${track.artist} - ${track.title}`);
    updateStatsDisplay(track);
    dom.seekSlider.value = 0;
    highlightPlaylistItem();

    const result = await waitForStreamReady(track.id, isVideo, myGeneration);
    if (myGeneration !== state.loadGeneration) return; // a newer track load has taken over

    if (!result.ok) {
      toast(`Could not play "${track.title}": ${result.reason}`, true);
      return next(true);
    }

    el.src = result.url;
    el.currentTime = 0;
    activeEl = el;

    fetch(`/api/media/${track.id}/played`, { method: "POST" }).catch(() => {});
    saveSettings({ last_media_id: track.id, active_playlist_id: state.activePlaylistId });

    if (autoplay) play();
  }

  function updateTransportUI() {
    dom.btnPlay.classList.toggle("playing", state.isPlaying);
    dom.indPlay.classList.toggle("active", state.isPlaying);
  }

  function play() {
    ensureAudioGraph();
    if (audioCtx.state === "suspended") audioCtx.resume();

    if (!activeEl) {
      if (!state.queue.length) { toast("Playlist is empty", true); return; }
      buildPlayOrder();
      loadTrack(state.playOrder[state.orderPos], true);
      return;
    }
    activeEl.play()
      .then(() => { state.isPlaying = true; updateTransportUI(); })
      .catch((err) => toast(`Playback blocked: ${err.message}`, true));
  }

  function pause() {
    if (activeEl) activeEl.pause();
    state.isPlaying = false;
    updateTransportUI();
  }

  function stop() {
    state.loadGeneration++; // invalidate any in-flight stream readiness checks
    if (activeEl) { activeEl.pause(); activeEl.currentTime = 0; }
    state.isPlaying = false;
    updateTransportUI();
    dom.seekSlider.value = 0;
    dom.lcdTime.textContent = "00:00";
    dom.videoOverlay.classList.add("hidden");
  }

  function next(auto = false) {
    if (!state.queue.length) return;
    if (state.orderPos < state.playOrder.length - 1) {
      state.orderPos++;
    } else if (state.repeat === "all") {
      state.orderPos = 0;
    } else {
      if (auto) stop();
      return;
    }
    loadTrack(state.playOrder[state.orderPos], true);
  }

  function prev() {
    if (!state.queue.length) return;
    if (activeEl && activeEl.currentTime > 3) { activeEl.currentTime = 0; return; }
    if (state.orderPos > 0) {
      state.orderPos--;
    } else if (state.repeat === "all") {
      state.orderPos = state.playOrder.length - 1;
    } else {
      state.orderPos = 0;
    }
    loadTrack(state.playOrder[state.orderPos], true);
  }

  function onMediaEnded() {
    if (state.repeat === "one") {
      activeEl.currentTime = 0;
      activeEl.play().catch(() => {});
      return;
    }
    next(true);
  }

  function onTimeUpdate() {
    if (!activeEl || state.isSeeking) return;
    const duration = activeEl.duration || state.queue[state.currentIndex]?.duration || 0;
    const current = activeEl.currentTime || 0;
    if (duration > 0) dom.seekSlider.value = Math.round((current / duration) * 1000);
    dom.lcdTime.textContent = state.showRemaining
      ? `-${formatTime(Math.max(duration - current, 0))}`
      : formatTime(current);
  }

  // -----------------------------------------------------------------------
  // Playlist rendering + reordering
  // -----------------------------------------------------------------------

  function updatePlaylistSummary() {
    const totalSeconds = state.queue.reduce((acc, t) => acc + (t.duration || 0), 0);
    dom.playlistSummary.textContent = `${state.queue.length} items / ${formatTime(totalSeconds)}`;
  }

  let dragSrcIndex = null;

  function renderPlaylist() {
    const ul = dom.playlistList;
    ul.innerHTML = "";
    const filterText = dom.playlistSearch.value.trim().toLowerCase();

    state.queue.forEach((track, idx) => {
      const haystack = `${track.title} ${track.artist}`.toLowerCase();
      if (filterText && !haystack.includes(filterText)) return;

      const li = document.createElement("li");
      li.className = "playlist-item" + (idx === state.currentIndex ? " playing" : "");
      li.draggable = true;
      li.dataset.index = String(idx);
      li.innerHTML = `
        <span class="drag-handle">::</span>
        <span class="pl-index">${idx + 1}.</span>
        <span class="pl-title">${escapeHtml(track.artist)} - ${escapeHtml(track.title)}</span>
        <span class="pl-duration">${formatTime(track.duration)}</span>`;

      li.addEventListener("dblclick", () => loadTrack(idx, true));
      li.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        contextTarget = { type: "playlist", mediaId: track.id, playlistItemId: track.playlist_item_id, index: idx };
        showContextMenu(e.pageX, e.pageY, "playlist");
      });
      li.addEventListener("dragstart", (e) => {
        dragSrcIndex = idx;
        e.dataTransfer.effectAllowed = "move";
      });
      li.addEventListener("dragover", (e) => { e.preventDefault(); li.classList.add("dragging-over"); });
      li.addEventListener("dragleave", () => li.classList.remove("dragging-over"));
      li.addEventListener("drop", (e) => {
        e.preventDefault();
        li.classList.remove("dragging-over");
        if (dragSrcIndex === null || dragSrcIndex === idx) return;
        reorderQueue(dragSrcIndex, idx);
        dragSrcIndex = null;
      });

      ul.appendChild(li);
    });
    updatePlaylistSummary();
  }

  function reorderQueue(from, to) {
    const moved = state.queue.splice(from, 1)[0];
    state.queue.splice(to, 0, moved);

    if (state.currentIndex === from) state.currentIndex = to;
    else if (from < state.currentIndex && to >= state.currentIndex) state.currentIndex--;
    else if (from > state.currentIndex && to <= state.currentIndex) state.currentIndex++;

    buildPlayOrder();
    renderPlaylist();

    const order = state.queue.map((t) => t.playlist_item_id);
    fetch(`/api/playlists/${state.activePlaylistId}/reorder`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order }),
    }).catch(() => {});
  }

  async function loadPlaylists() {
    const resp = await fetch("/api/playlists");
    const list = await resp.json();
    dom.playlistSelect.innerHTML = "";
    list.forEach((pl) => {
      const opt = document.createElement("option");
      opt.value = String(pl.id);
      opt.textContent = `${pl.name} (${pl.item_count})`;
      dom.playlistSelect.appendChild(opt);
    });
    return list;
  }

  async function selectPlaylist(id, { autoplay = false } = {}) {
    state.activePlaylistId = id;
    dom.playlistSelect.value = String(id);
    const resp = await fetch(`/api/playlists/${id}/items`);
    const items = await resp.json();
    state.queue = items;
    state.currentIndex = -1;
    buildPlayOrder(false);
    renderPlaylist();
    saveSettings({ active_playlist_id: id });
    if (autoplay && state.queue.length) loadTrack(0, true);
  }

  // -----------------------------------------------------------------------
  // Library rendering
  // -----------------------------------------------------------------------

  async function addMediaToActivePlaylist(mediaId) {
    if (!state.activePlaylistId) { toast("No active playlist", true); return null; }
    const resp = await fetch(`/api/playlists/${state.activePlaylistId}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ media_id: mediaId }),
    });
    const data = await resp.json();
    await selectPlaylist(state.activePlaylistId);
    await loadPlaylists();
    return data.id;
  }

  async function addAndPlayFromLibrary(mediaId) {
    await addMediaToActivePlaylist(mediaId);
    const idx = state.queue.findIndex((t) => t.id === mediaId);
    if (idx !== -1) {
      buildPlayOrder(false);
      state.currentIndex = idx;
      state.orderPos = state.playOrder.indexOf(idx);
      loadTrack(idx, true);
    }
  }

  async function deleteLibraryItem(mediaId, title) {
    if (!confirm(`Delete "${title}" from the library? This also removes the file from disk.`)) return;
    await fetch(`/api/media/${mediaId}`, { method: "DELETE" });
    loadLibrary();
  }

  function renderLibrary(items) {
    const ul = dom.libraryList;
    ul.innerHTML = "";
    items.forEach((item) => {
      const li = document.createElement("li");
      li.className = "library-item";
      li.innerHTML = `
        <span class="lib-type">${item.media_type === "video" ? "\u{1F3AC}" : "\u{1F3B5}"}</span>
        <span class="lib-title">${escapeHtml(item.artist)} - ${escapeHtml(item.title)}</span>
        <span class="lib-meta">${formatTime(item.duration)}</span>
        <button type="button" class="lib-delete-btn" title="Delete from library">&times;</button>`;
      li.addEventListener("dblclick", () => addAndPlayFromLibrary(item.id));
      li.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        contextTarget = { type: "library", mediaId: item.id, title: `${item.artist} - ${item.title}` };
        showContextMenu(e.pageX, e.pageY, "library");
      });
      li.querySelector(".lib-delete-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        deleteLibraryItem(item.id, `${item.artist} - ${item.title}`);
      });
      ul.appendChild(li);
    });
  }

  let librarySearchTimer = null;
  function loadLibrary() {
    const search = dom.librarySearch.value.trim();
    const qs = search ? `?search=${encodeURIComponent(search)}` : "";
    fetch(`/api/library${qs}`)
      .then((r) => r.json())
      .then(renderLibrary)
      .catch(() => toast("Failed to load library", true));
  }

  // -----------------------------------------------------------------------
  // Context menu + file info modal
  // -----------------------------------------------------------------------

  function showContextMenu(x, y, type) {
    const menu = dom.contextMenu;
    const addItem = menu.querySelector('[data-action="add-to-playlist"]');
    addItem.style.display = type === "library" ? "" : "none";
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.classList.remove("hidden");
  }

  function hideContextMenu() { dom.contextMenu.classList.add("hidden"); }

  async function showFileInfo(mediaId) {
    const resp = await fetch(`/api/media/${mediaId}`);
    if (!resp.ok) { toast("Could not load file info", true); return; }
    const item = await resp.json();
    dom.infoModalBody.innerHTML = `
      <div><b>Title:</b> ${escapeHtml(item.title)}</div>
      <div><b>Artist:</b> ${escapeHtml(item.artist)}</div>
      <div><b>Album:</b> ${escapeHtml(item.album)}</div>
      <div><b>Genre:</b> ${escapeHtml(item.genre || "-")}</div>
      <div><b>Type:</b> ${item.media_type}</div>
      <div><b>Duration:</b> ${formatTime(item.duration)}</div>
      <div><b>Bitrate:</b> ${Math.round(item.bitrate)} kbps</div>
      <div><b>Sample rate:</b> ${item.sample_rate} Hz</div>
      <div><b>File size:</b> ${humanSize(item.filesize)}</div>
      <div><b>Play count:</b> ${item.play_count}</div>
      <div><b>Added:</b> ${escapeHtml(item.added_at)}</div>
      <div><b>Path:</b> ${escapeHtml(item.file_path)}</div>`;
    dom.infoModal.classList.remove("hidden");
  }

  function wireContextMenu() {
    dom.contextMenu.addEventListener("click", async (e) => {
      const action = e.target.dataset.action;
      if (!action || !contextTarget) { hideContextMenu(); return; }

      if (action === "play") {
        if (contextTarget.type === "playlist") loadTrack(contextTarget.index, true);
        else await addAndPlayFromLibrary(contextTarget.mediaId);
      } else if (action === "add-to-playlist") {
        await addMediaToActivePlaylist(contextTarget.mediaId);
        toast("Added to playlist");
      } else if (action === "remove") {
        if (contextTarget.type === "playlist") {
          await fetch(`/api/playlists/${state.activePlaylistId}/items/${contextTarget.playlistItemId}`, { method: "DELETE" });
          await selectPlaylist(state.activePlaylistId);
          await loadPlaylists();
        } else {
          await deleteLibraryItem(contextTarget.mediaId, contextTarget.title || "this file");
        }
      } else if (action === "info") {
        showFileInfo(contextTarget.mediaId);
      }
      hideContextMenu();
    });

    document.addEventListener("click", (e) => {
      if (!dom.contextMenu.contains(e.target)) hideContextMenu();
    });
    window.addEventListener("scroll", hideContextMenu, true);
  }

  // -----------------------------------------------------------------------
  // Upload / scan / YouTube import
  // -----------------------------------------------------------------------

  function uploadFiles(fileList) {
    if (!fileList || !fileList.length) return;
    const fd = new FormData();
    Array.from(fileList).forEach((f) => fd.append("files", f));
    toast("Uploading...");
    fetch("/api/upload", { method: "POST", body: fd })
      .then((r) => r.json())
      .then((data) => {
        const extra = data.errors.length ? `, ${data.errors.length} error(s)` : "";
        toast(`Added ${data.items.length} file(s)${extra}`, data.items.length === 0 && data.errors.length > 0);
        loadLibrary();
      })
      .catch((err) => toast(`Upload failed: ${err.message}`, true));
  }

  function wireLibraryPanel() {
    dom.dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dom.dropzone.classList.add("drag-active"); });
    dom.dropzone.addEventListener("dragleave", () => dom.dropzone.classList.remove("drag-active"));
    dom.dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dom.dropzone.classList.remove("drag-active");
      uploadFiles(e.dataTransfer.files);
    });
    dom.fileInput.addEventListener("change", () => uploadFiles(dom.fileInput.files));

    dom.librarySearch.addEventListener("input", () => {
      clearTimeout(librarySearchTimer);
      librarySearchTimer = setTimeout(loadLibrary, 300);
    });

    dom.btnScan.addEventListener("click", () => {
      const directory = dom.scanInput.value.trim();
      if (!directory) return;
      toast("Scanning...");
      fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directory }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.error) { toast(data.error, true); return; }
          toast(`Scan complete: ${data.added} added, ${data.skipped} already in library, ${data.failed} failed`);
          loadLibrary();
        })
        .catch((err) => toast(`Scan failed: ${err.message}`, true));
    });

    dom.btnYoutubeImport.addEventListener("click", () => {
      const url = dom.youtubeUrlInput.value.trim();
      if (!url) return;
      const format = dom.youtubeFormatSelect.value;
      dom.youtubeProgress.classList.remove("hidden");
      dom.youtubeProgress.textContent = "Starting import...";
      fetch("/api/youtube/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, format }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.error) { toast(data.error, true); dom.youtubeProgress.classList.add("hidden"); return; }
          pollYoutubeJob(data.job_id);
        })
        .catch((err) => {
          toast(`Import failed: ${err.message}`, true);
          dom.youtubeProgress.classList.add("hidden");
        });
    });
  }

  function pollYoutubeJob(jobId) {
    fetch(`/api/youtube/import/${jobId}`)
      .then((r) => r.json())
      .then((job) => {
        if (job.status === "error") {
          dom.youtubeProgress.classList.add("hidden");
          toast(`YouTube import error: ${job.error}`, true);
          return;
        }
        if (job.status === "pending") {
          dom.youtubeProgress.textContent = "Reading URL...";
          setTimeout(() => pollYoutubeJob(jobId), 1200);
          return;
        }
        if (job.status === "downloading") {
          dom.youtubeProgress.textContent = `Downloading ${job.completed}/${job.total} (added ${job.added})...`;
          setTimeout(() => pollYoutubeJob(jobId), 1200);
          return;
        }
        if (job.status === "done") {
          dom.youtubeProgress.classList.add("hidden");
          const extra = job.errors.length ? `, ${job.errors.length} skipped` : "";
          toast(`YouTube import finished: ${job.added} track(s) added${extra}`);
          loadLibrary();
          loadPlaylists().then(() => { if (job.playlist_id) selectPlaylist(job.playlist_id); });
        }
      })
      .catch(() => setTimeout(() => pollYoutubeJob(jobId), 2500));
  }

  // -----------------------------------------------------------------------
  // Window chrome: dragging + show/hide toggles
  // -----------------------------------------------------------------------

  function wireWindowDragging(win) {
    const handle = win.querySelector("[data-drag-handle]");
    let startX = 0, startY = 0, startLeft = 0, startTop = 0, dragging = false;

    handle.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      win.classList.add("dragging");
      const rect = win.getBoundingClientRect();
      const deskRect = dom.desktop.getBoundingClientRect();
      startLeft = rect.left - deskRect.left;
      startTop = rect.top - deskRect.top;
      startX = e.clientX;
      startY = e.clientY;
      handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      win.style.left = `${Math.max(0, startLeft + dx)}px`;
      win.style.top = `${Math.max(0, startTop + dy)}px`;
    });

    const endDrag = () => { dragging = false; win.classList.remove("dragging"); };
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
  }

  function bringToFront(win) {
    document.querySelectorAll(".winamp-window").forEach((w) => { w.style.zIndex = 5; });
    win.style.zIndex = 10;
  }

  function wireWindowToggles() {
    document.querySelectorAll("[data-action]").forEach((btn) => {
      const action = btn.dataset.action;
      const map = {
        "toggle-eq": dom.eqWindow,
        "toggle-playlist": dom.playlistWindow,
        "toggle-library": dom.libraryWindow,
        "toggle-video": dom.videoWindow,
      };
      if (!(action in map)) return;
      btn.addEventListener("click", () => {
        const win = map[action];
        win.classList.toggle("hidden");
        if (!win.classList.contains("hidden")) bringToFront(win);
      });
    });
  }

  // -----------------------------------------------------------------------
  // EQ wiring
  // -----------------------------------------------------------------------

  function wireEqualizer() {
    EQ_FREQS.forEach((_, i) => {
      const slider = $(`eq-band-${i}`);
      const valueEl = $(`eq-value-${i}`);
      slider.addEventListener("input", () => {
        const v = parseInt(slider.value, 10);
        state.eqBands[i] = v;
        valueEl.textContent = fmtDb(v);
        state.eqPreset = "Custom";
        dom.eqPresetSelect.value = "Custom";
        applyEqToGraph();
        saveSettings({ eq_bands: JSON.stringify(state.eqBands), eq_preset: "Custom" });
      });
    });

    dom.eqPreamp.addEventListener("input", () => {
      state.eqPreamp = parseInt(dom.eqPreamp.value, 10);
      dom.eqPreampValue.textContent = fmtDb(state.eqPreamp);
      applyEqToGraph();
      saveSettings({ eq_preamp: state.eqPreamp });
    });

    dom.eqEnabledCheckbox.addEventListener("change", () => {
      state.eqEnabled = dom.eqEnabledCheckbox.checked;
      applyEqToGraph();
      saveSettings({ eq_enabled: state.eqEnabled ? 1 : 0 });
    });

    dom.eqPresetSelect.addEventListener("change", () => {
      const name = dom.eqPresetSelect.value;
      if (name === "Custom" || !EQ_PRESETS[name]) return;
      state.eqBands = [...EQ_PRESETS[name]];
      state.eqPreset = name;
      state.eqBands.forEach((v, i) => {
        $(`eq-band-${i}`).value = v;
        $(`eq-value-${i}`).textContent = fmtDb(v);
      });
      applyEqToGraph();
      saveSettings({ eq_preset: name, eq_bands: JSON.stringify(state.eqBands) });
    });
  }

  // -----------------------------------------------------------------------
  // Transport / sliders wiring
  // -----------------------------------------------------------------------

  function wireTransport() {
    dom.btnPlay.addEventListener("click", play);
    dom.btnPause.addEventListener("click", pause);
    dom.btnStop.addEventListener("click", stop);
    dom.btnNext.addEventListener("click", () => next(false));
    dom.btnPrev.addEventListener("click", prev);
    dom.btnEject.addEventListener("click", () => { dom.fileInput.click(); if (dom.libraryWindow.classList.contains("hidden")) { dom.libraryWindow.classList.remove("hidden"); bringToFront(dom.libraryWindow); } });

    dom.btnShuffle.addEventListener("click", () => {
      state.shuffle = !state.shuffle;
      dom.btnShuffle.classList.toggle("active", state.shuffle);
      dom.indShuffle.classList.toggle("active", state.shuffle);
      buildPlayOrder();
      saveSettings({ shuffle: state.shuffle ? 1 : 0 });
    });

    dom.btnRepeat.addEventListener("click", () => {
      const cycle = { none: "all", all: "one", one: "none" };
      state.repeat = cycle[state.repeat];
      dom.btnRepeat.dataset.mode = state.repeat;
      dom.btnRepeat.classList.toggle("active", state.repeat !== "none");
      dom.btnRepeat.textContent = state.repeat === "one" ? "REP 1" : "REP";
      dom.indRepeat.classList.toggle("active", state.repeat !== "none");
      saveSettings({ repeat: state.repeat });
    });

    dom.btnVizMode.addEventListener("click", () => {
      state.visualizerMode = state.visualizerMode === "bars" ? "scope" : "bars";
      dom.btnVizMode.textContent = state.visualizerMode === "bars" ? "BARS" : "SCOPE";
      saveSettings({ visualizer_mode: state.visualizerMode });
    });

    dom.volumeSlider.addEventListener("input", () => {
      state.volume = parseInt(dom.volumeSlider.value, 10);
      applyVolumeToGraph();
      saveSettings({ volume: state.volume });
    });

    dom.balanceSlider.addEventListener("input", () => {
      state.balance = parseInt(dom.balanceSlider.value, 10);
      applyBalanceToGraph();
      saveSettings({ balance: state.balance });
    });

    dom.seekSlider.addEventListener("pointerdown", () => { state.isSeeking = true; });
    dom.seekSlider.addEventListener("input", () => {
      if (!activeEl) return;
      const duration = activeEl.duration || state.queue[state.currentIndex]?.duration || 0;
      const current = (dom.seekSlider.value / 1000) * duration;
      dom.lcdTime.textContent = state.showRemaining
        ? `-${formatTime(Math.max(duration - current, 0))}`
        : formatTime(current);
    });
    dom.seekSlider.addEventListener("change", () => {
      if (activeEl) {
        const duration = activeEl.duration || state.queue[state.currentIndex]?.duration || 0;
        activeEl.currentTime = (dom.seekSlider.value / 1000) * duration;
      }
      state.isSeeking = false;
    });

    dom.lcdTime.addEventListener("click", () => { state.showRemaining = !state.showRemaining; onTimeUpdate(); });

    dom.elAudio.addEventListener("timeupdate", onTimeUpdate);
    dom.elVideo.addEventListener("timeupdate", onTimeUpdate);
    dom.elAudio.addEventListener("ended", onMediaEnded);
    dom.elVideo.addEventListener("ended", onMediaEnded);
    dom.elAudio.addEventListener("play", () => { if (activeEl === dom.elAudio) { state.isPlaying = true; updateTransportUI(); } });
    dom.elVideo.addEventListener("play", () => { if (activeEl === dom.elVideo) { state.isPlaying = true; updateTransportUI(); } });
    dom.elAudio.addEventListener("pause", () => { if (activeEl === dom.elAudio) { state.isPlaying = false; updateTransportUI(); } });
    dom.elVideo.addEventListener("pause", () => { if (activeEl === dom.elVideo) { state.isPlaying = false; updateTransportUI(); } });

    dom.btnVideoFullscreen.addEventListener("click", () => {
      const req = dom.elVideo.requestFullscreen || dom.elVideo.webkitRequestFullscreen;
      if (req) req.call(dom.elVideo);
    });
  }

  function wirePlaylistPanel() {
    dom.playlistSelect.addEventListener("change", () => selectPlaylist(parseInt(dom.playlistSelect.value, 10)));
    dom.playlistSearch.addEventListener("input", renderPlaylist);

    dom.btnNewPlaylist.addEventListener("click", async () => {
      const name = prompt("Playlist name:", "New Playlist");
      if (!name) return;
      const resp = await fetch("/api/playlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await resp.json();
      await loadPlaylists();
      selectPlaylist(data.id);
    });

    dom.btnDeletePlaylist.addEventListener("click", async () => {
      if (!state.activePlaylistId) return;
      if (!confirm("Delete this playlist?")) return;
      await fetch(`/api/playlists/${state.activePlaylistId}`, { method: "DELETE" });
      const list = await loadPlaylists();
      if (list.length) selectPlaylist(list[0].id);
      else { state.queue = []; state.activePlaylistId = null; renderPlaylist(); }
    });

    dom.btnPlaylistClear.addEventListener("click", async () => {
      if (!state.activePlaylistId) return;
      if (!confirm("Clear all items from this playlist?")) return;
      await fetch(`/api/playlists/${state.activePlaylistId}/clear`, { method: "POST" });
      selectPlaylist(state.activePlaylistId);
    });
  }

  function wireModal() {
    dom.btnCloseModal.addEventListener("click", () => dom.infoModal.classList.add("hidden"));
    dom.infoModal.addEventListener("click", (e) => { if (e.target === dom.infoModal) dom.infoModal.classList.add("hidden"); });
  }

  // -----------------------------------------------------------------------
  // Settings bootstrap
  // -----------------------------------------------------------------------

  function applySettingsToUI(s) {
    state.volume = parseInt(s.volume ?? "80", 10);
    state.balance = parseInt(s.balance ?? "0", 10);
    state.shuffle = s.shuffle === "1";
    state.repeat = s.repeat || "none";
    state.eqEnabled = s.eq_enabled === "1";
    state.eqPreamp = parseInt(s.eq_preamp ?? "0", 10);
    state.visualizerMode = s.visualizer_mode || "bars";
    try {
      const parsed = JSON.parse(s.eq_bands || "[]");
      state.eqBands = Array.isArray(parsed) && parsed.length === 10 ? parsed : Array(10).fill(0);
    } catch (err) {
      state.eqBands = Array(10).fill(0);
    }
    state.eqPreset = s.eq_preset || "Flat";

    dom.volumeSlider.value = state.volume;
    dom.balanceSlider.value = state.balance;
    dom.btnShuffle.classList.toggle("active", state.shuffle);
    dom.indShuffle.classList.toggle("active", state.shuffle);
    dom.btnRepeat.dataset.mode = state.repeat;
    dom.btnRepeat.classList.toggle("active", state.repeat !== "none");
    dom.btnRepeat.textContent = state.repeat === "one" ? "REP 1" : "REP";
    dom.indRepeat.classList.toggle("active", state.repeat !== "none");
    dom.btnVizMode.textContent = state.visualizerMode === "bars" ? "BARS" : "SCOPE";
    dom.eqEnabledCheckbox.checked = state.eqEnabled;
    dom.eqPreamp.value = state.eqPreamp;
    dom.eqPreampValue.textContent = fmtDb(state.eqPreamp);
    dom.eqPresetSelect.value = state.eqPreset;
    state.eqBands.forEach((v, i) => {
      $(`eq-band-${i}`).value = v;
      $(`eq-value-${i}`).textContent = fmtDb(v);
    });

    applyVolumeToGraph();
    applyBalanceToGraph();
    applyEqToGraph();
  }

  // -----------------------------------------------------------------------
  // Boot
  // -----------------------------------------------------------------------

  async function init() {
    cacheDom();
    document.querySelectorAll(".winamp-window").forEach(wireWindowDragging);
    wireWindowToggles();
    wireTransport();
    wireEqualizer();
    wirePlaylistPanel();
    wireLibraryPanel();
    wireContextMenu();
    wireModal();
    ensureAudioGraph();

    const settings = await fetch("/api/settings").then((r) => r.json()).catch(() => ({}));
    applySettingsToUI(settings);

    const playlists = await loadPlaylists();
    let activeId = parseInt(settings.active_playlist_id, 10);
    if (!activeId || !playlists.find((p) => p.id === activeId)) activeId = playlists[0]?.id;

    if (activeId) {
      await selectPlaylist(activeId);
      const lastId = parseInt(settings.last_media_id, 10);
      if (lastId) {
        const idx = state.queue.findIndex((t) => t.id === lastId);
        if (idx !== -1) {
          state.currentIndex = idx;
          buildPlayOrder(true);
          const track = state.queue[idx];
          setMarqueeText(`${track.artist} - ${track.title}`);
          updateStatsDisplay(track);
          renderPlaylist();
        }
      }
    }

    loadLibrary();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
