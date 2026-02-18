(function () {
    'use strict';

    const state = window.MegaMix && window.MegaMix.state;
    if (!state) return;

    const views = {
        app: document.getElementById('view-app'),
        mastering: document.getElementById('view-mastering'),
        pricing: document.getElementById('view-pricing')
    };
    let pendingDownload = null;
    const emailModalApp = document.getElementById('emailModalApp');
    const emailInputApp = document.getElementById('emailInputApp');
    const uploadZone = document.getElementById('upload-zone');
    const fileInput = document.getElementById('file-input');
    const fileListEl = document.getElementById('file-list');
    const presetSelect = document.getElementById('preset-select');
    const guidanceForJosh = document.getElementById('guidance-for-josh');
    const btnMixIt = document.getElementById('btn-mix-it');
    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input');
    const chatSend = document.getElementById('chat-send');
    const mixerStripsEl = document.getElementById('mixer-strips');
    const presetNameInput = document.getElementById('preset-name-input');
    const btnSavePreset = document.getElementById('btn-save-preset');
    const loadPresetSelect = document.getElementById('load-preset-select');
    const btnLoadPreset = document.getElementById('btn-load-preset');
    const audioBefore = document.getElementById('audio-before');
    const audioAfter = document.getElementById('audio-after');
    const playBtn = document.getElementById('play-btn');
    const playbackProgress = document.getElementById('playback-progress');
    const playbackTime = document.getElementById('playback-time');
    const playbackDuration = document.getElementById('playback-duration');
    const playbackInstruction = document.getElementById('playback-instruction');
    const playbackBuilding = document.getElementById('playback-building');
    const mixLoadingBlock = document.getElementById('mix-loading-block');
    const mixItLoading = document.getElementById('mix-it-loading');
    const mixItLoadingText = document.getElementById('mix-it-loading-text');
    const mixItProgressFill = document.getElementById('mix-it-progress-fill');
    const masteringLoadingBlock = document.getElementById('mastering-loading-block');
    const btnExport = document.getElementById('btn-export');
    const btnUndo = document.getElementById('btn-undo');
    const btnRedo = document.getElementById('btn-redo');
    const toggleFileListBtn = document.getElementById('toggle-file-list');
    const uploadAndFilesBody = document.getElementById('upload-and-files-body');
    const masteringStatusEl = document.getElementById('mastering-status');

    let masteringGraphInited = false;
    let masterCompressor = null;
    let masterGain = null;
    let masterDryGain = null;
    let masterWetGain = null;

    function showView(name) {
        Object.keys(views).forEach(k => {
            if (!views[k]) return;
            const isTarget = k === name;
            views[k].classList.toggle('hidden', !isTarget);
            views[k].classList.toggle('view-visible', isTarget);
        });
        var joshMixing = document.getElementById('josh-avatar-mixing');
        var joshMastering = document.getElementById('josh-avatar-mastering');
        if (joshMixing) joshMixing.classList.toggle('hidden', name !== 'app');
        if (joshMastering) joshMastering.classList.toggle('hidden', name !== 'mastering');
        const active = views[name];
        if (active) {
            void active.offsetHeight; // force reflow so fade-in animation runs
            setTimeout(() => active.classList.remove('view-visible'), 350);
        }
        if (name === 'mastering') initMasteringPageWhenShown();
    }
    document.querySelectorAll('[data-view]').forEach(el => {
        el.addEventListener('click', function (e) {
            e.preventDefault();
            const v = this.getAttribute('data-view');
            if (v) showView(v);
        });
    });

    function updatePlaybackInstruction() {
        if (!playbackInstruction) return;
        if (!state.mixReady) {
            playbackInstruction.textContent = 'Upload your tracks, then click Mix it to create your mix. After that, use Before/After to compare.';
            if (playBtn) playBtn.disabled = true;
        } else {
            playbackInstruction.textContent = 'Before = flat mix; After = your mix. Refine with Josh below.';
            if (playBtn) playBtn.disabled = false;
        }
        const btnExport = document.getElementById('btn-export');
        const btnMastering = document.getElementById('btn-ai-mastering');
        if (btnExport) btnExport.disabled = !state.mixReady;
        if (btnMastering) btnMastering.disabled = !state.mixReady;
    }
    function updateMasteringUI() {
        /* Mastering preview/download now on dedicated Mastering page */
    }

    async function buildMixAndSetUrls() {
        window.MegaMix.revokeMixUrls();
        if (state.uploadedFiles.length === 0) {
            audioBefore.removeAttribute('src');
            audioAfter.removeAttribute('src');
            if (mixLoadingBlock) mixLoadingBlock.classList.add('hidden');
            playbackInstruction.classList.remove('hidden');
            playBtn.disabled = true;
        return;
        }
        playbackInstruction.classList.add('hidden');
        if (mixLoadingBlock) mixLoadingBlock.classList.remove('hidden');
        playBtn.disabled = true;
        try {
            await window.MegaMix.decodeStemsToBuffers();
            if (state.stemBuffers.length === 0) return;
            const beforeMix = window.MegaMix.buildMixedBuffer(true);
            const afterMix = await window.MegaMix.buildAfterMixWithFX();
            if (beforeMix) {
                state.mixedBeforeUrl = URL.createObjectURL(window.MegaMix.encodeWav(beforeMix.left, beforeMix.right, beforeMix.sampleRate));
                audioBefore.src = state.mixedBeforeUrl;
            }
            if (afterMix) {
                state.mixedAfterUrl = URL.createObjectURL(window.MegaMix.encodeWav(afterMix.left, afterMix.right, afterMix.sampleRate));
                audioAfter.src = state.mixedAfterUrl;
            }
            if (mixLoadingBlock) mixLoadingBlock.classList.add('hidden');
            playbackInstruction.classList.remove('hidden');
            playBtn.disabled = false;
        } catch (e) {
            console.error(e);
            if (mixLoadingBlock) mixLoadingBlock.classList.add('hidden');
            playbackInstruction.classList.remove('hidden');
            playbackInstruction.textContent = 'Mix build failed. Try fewer or shorter files.';
            playBtn.disabled = true;
        }
    }

    function addFiles(files) {
        const accepted = Array.from(files).filter(f => {
            const n = f.name.toLowerCase();
            return n.endsWith('.wav') || n.endsWith('.mp3') || (f.type && f.type.startsWith('audio/'));
        });
        const existingLen = state.uploadedFiles.length;
        for (const f of accepted) {
            if (state.uploadedFiles.length >= window.MegaMix.MAX_FILES) break;
            state.uploadedFiles.push({ file: f, name: f.name, url: URL.createObjectURL(f) });
        }
        state.tracks = state.uploadedFiles.map((e, i) => {
            if (i < existingLen && state.tracks[i]) return state.tracks[i];
            return window.MegaMix.defaultTrack(e.name);
        });
        renderFileList();
        renderMixerStrips();
        updatePlaybackInstruction();
        if (state.uploadedFiles.length > existingLen) {
            const panel = document.getElementById('panel-simple');
            if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    function removeFile(index) {
        const entry = state.uploadedFiles[index];
        if (entry && entry.url) URL.revokeObjectURL(entry.url);
        state.uploadedFiles.splice(index, 1);
        state.tracks.splice(index, 1);
        renderFileList();
        renderMixerStrips();
        if (state.uploadedFiles.length === 0) {
            state.mixReady = false;
            state.hasInitialMix = false;
            state.stemBuffers = [];
            state.trackAnalyses = [];
            window.MegaMix.stopLivePlayback();
            window.MegaMix.revokeMixUrls();
            window.MegaMix.revokeMasteredUrl();
            if (audioBefore) audioBefore.removeAttribute('src');
            if (audioAfter) audioAfter.removeAttribute('src');
            updatePlaybackInstruction();
            updateMasteringUI();
        }
    }

    function renderFileList() {
        fileListEl.innerHTML = '';
        state.uploadedFiles.forEach((entry, i) => {
            const li = document.createElement('li');
            li.textContent = entry.name;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'remove-file';
            btn.textContent = '×';
            btn.setAttribute('aria-label', 'Remove');
            btn.addEventListener('click', () => removeFile(i));
            li.appendChild(btn);
            fileListEl.appendChild(li);
        });
    }

    var _lastRenderStrips = 0;
    var _renderStripsTimer = null;
    var RENDER_STRIPS_THROTTLE_MS = 120;
    function doRenderMixerStrips() {
        var t0 = performance.now();
        mixerStripsEl.innerHTML = '';
        state.tracks.forEach((track, i) => {
            const strip = document.createElement('div');
            strip.className = 'mixer-strip';
            strip.dataset.trackIndex = String(i);
            const nameWrap = document.createElement('div');
            nameWrap.className = 'mixer-strip-name-wrap';
            const nameEl = document.createElement('span');
            nameEl.className = 'mixer-strip-name';
            nameEl.title = track.name;
            nameEl.textContent = track.name.length > 18 ? track.name.slice(0, 15) + '…' : track.name;
            nameWrap.appendChild(nameEl);
            const analysis = state.trackAnalyses && state.trackAnalyses[i];
            if (analysis) {
                const blockSec = 0.2;
                const loudestSec = (analysis.loudestBlockIndex != null ? analysis.loudestBlockIndex * blockSec : 0);
                const softestSec = (analysis.softestBlockIndex != null ? analysis.softestBlockIndex * blockSec : 0);
                const fmt = (s) => { const m = Math.floor(s / 60); const sec = Math.floor(s % 60); return m + ':' + (sec < 10 ? '0' : '') + sec; };
                const peakDb = analysis.peakDb != null ? Math.round(analysis.peakDb) + ' dB' : '';
                const tip = [peakDb && 'Peak ' + peakDb, analysis.loudestBlockIndex != null ? 'Loudest @ ' + fmt(loudestSec) : '', analysis.softestBlockIndex != null ? 'Softest @ ' + fmt(softestSec) : ''].filter(Boolean).join(' · ');
                const analysisEl = document.createElement('span');
                analysisEl.className = 'mixer-strip-analysis';
                analysisEl.textContent = peakDb ? 'Peak ' + peakDb : 'Dynamics';
                analysisEl.title = tip || 'Track dynamics';
                nameWrap.appendChild(analysisEl);
            }
            const faderWrap = document.createElement('div');
            faderWrap.className = 'mixer-strip-fader';
            const fader = document.createElement('input');
            fader.type = 'range';
            fader.min = 0;
            fader.max = 1;
            fader.step = 0.01;
            fader.value = track.gain;
            fader.title = 'Level';
            fader.addEventListener('mousedown', () => pushUndo());
            fader.addEventListener('input', () => {
                track.gain = parseFloat(fader.value);
                if (track.automation && track.automation.level && track.automation.level.length >= 2) {
                    track.automation.level[0].value = track.gain;
                    track.automation.level[track.automation.level.length - 1].value = track.gain;
                }
                window.MegaMix.syncTrackToLiveGraph(i);
                window.MegaMix.scheduleBuildAfter();
            });
            faderWrap.appendChild(fader);
            const panWrap = document.createElement('div');
            panWrap.className = 'mixer-strip-pan';
            const panLabel = document.createElement('span');
            panLabel.className = 'mixer-pan-label';
            panLabel.textContent = 'Pan';
            panLabel.setAttribute('aria-hidden', 'true');
            const pan = document.createElement('input');
            pan.type = 'range';
            pan.min = -1;
            pan.max = 1;
            pan.step = 0.01;
            pan.value = track.pan;
            pan.title = 'Pan';
            pan.setAttribute('aria-label', 'Pan');
            pan.addEventListener('mousedown', () => pushUndo());
            pan.addEventListener('input', () => {
                track.pan = parseFloat(pan.value);
                if (track.automation && track.automation.pan && track.automation.pan.length >= 2) {
                    track.automation.pan[0].value = track.pan;
                    track.automation.pan[track.automation.pan.length - 1].value = track.pan;
                }
                window.MegaMix.syncTrackToLiveGraph(i);
                window.MegaMix.scheduleBuildAfter();
            });
            panWrap.appendChild(panLabel);
            panWrap.appendChild(pan);
            const fxRow = document.createElement('div');
            fxRow.className = 'mixer-fx-row';
            function makeFxSlot(fxType, label, isOn, toggleOn, params, getAdjust, setAdjust, getMix, setMix, adjustRange, adjustStep) {
                const slot = document.createElement('div');
                slot.className = 'mixer-fx-slot';
                const powerBtn = document.createElement('button');
                powerBtn.type = 'button';
                powerBtn.className = 'mixer-fx-power';
                powerBtn.setAttribute('aria-pressed', isOn);
                powerBtn.title = label + ' on/off';
                powerBtn.textContent = isOn ? '\u25CF' : '\u25CB';
                powerBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    pushUndo();
                    toggleOn();
                    powerBtn.setAttribute('aria-pressed', track[fxType === 'eq' ? 'eqOn' : 'compOn']);
                    powerBtn.textContent = track[fxType === 'eq' ? 'eqOn' : 'compOn'] ? '\u25CF' : '\u25CB';
                    window.MegaMix.syncTrackToLiveGraph(i);
                    window.MegaMix.scheduleBuildAfter();
                });
                const nameBtn = document.createElement('button');
                nameBtn.type = 'button';
                nameBtn.className = 'mixer-fx-name';
                nameBtn.textContent = label;
                nameBtn.title = 'Open ' + label + ' settings';
                const popover = document.createElement('div');
                popover.className = 'mixer-fx-popover mixer-fx-mini-panel hidden';
                popover.setAttribute('aria-hidden', 'true');
                const miniBg = document.createElement('div');
                miniBg.className = 'mixer-fx-mini-bg mixer-fx-mini-bg-' + fxType;
                const knobRow = document.createElement('div');
                knobRow.className = 'mixer-fx-mini-knobs';
                const adjustLabel = document.createElement('label');
                adjustLabel.textContent = 'Adjust';
                const adjustInput = document.createElement('input');
                adjustInput.type = 'range';
                adjustInput.min = adjustRange[0];
                adjustInput.max = adjustRange[1];
                adjustInput.step = adjustStep;
                adjustInput.value = getAdjust();
                adjustInput.title = 'Adjust';
                const mixLabel = document.createElement('label');
                mixLabel.textContent = 'Mix';
                const mixInput = document.createElement('input');
                mixInput.type = 'range';
                mixInput.min = 0;
                mixInput.max = 100;
                mixInput.step = 1;
                mixInput.value = Math.round((getMix() * 100));
                mixInput.title = 'Mix';
                const updateFromKnobs = () => {
                    setAdjust(parseFloat(adjustInput.value));
                    setMix(parseFloat(mixInput.value) / 100);
                    window.MegaMix.syncTrackToLiveGraph(i);
                    window.MegaMix.scheduleBuildAfter();
                };
                adjustInput.addEventListener('input', updateFromKnobs);
                mixInput.addEventListener('input', updateFromKnobs);
                knobRow.appendChild(adjustLabel);
                knobRow.appendChild(adjustInput);
                knobRow.appendChild(mixLabel);
                knobRow.appendChild(mixInput);
                popover.appendChild(miniBg);
                popover.appendChild(knobRow);
                nameBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const open = !popover.classList.contains('hidden');
                    document.querySelectorAll('.mixer-fx-mini-panel').forEach(p => { p.classList.add('hidden'); p.setAttribute('aria-hidden', 'true'); });
                    if (!open) {
                        popover.classList.remove('hidden');
                        popover.setAttribute('aria-hidden', 'false');
                        adjustInput.value = getAdjust();
                        mixInput.value = Math.round(getMix() * 100);
                    }
                });
                slot.appendChild(powerBtn);
                slot.appendChild(nameBtn);
                slot.appendChild(popover);
                return slot;
            }
            const eqSlot = makeFxSlot('eq', 'JoshEQ', track.eqOn, () => { track.eqOn = !track.eqOn; },
                track.eqParams,
                () => (track.eqParams && track.eqParams.high != null) ? track.eqParams.high : 0,
                (v) => { track.eqParams = track.eqParams || { low: 0, mid: 0, high: 0 }; track.eqParams.high = v; },
                () => (track.eqMix != null) ? track.eqMix : 1,
                (v) => { track.eqMix = v; },
                [-6, 6], 0.5);
            const compSlot = makeFxSlot('comp', 'JoshSquash', track.compOn, () => { track.compOn = !track.compOn; },
                track.compParams,
                () => (track.compParams && track.compParams.ratio != null) ? track.compParams.ratio : 2,
                (v) => { track.compParams = track.compParams || {}; track.compParams.ratio = v; },
                () => (track.compMix != null) ? track.compMix : 1,
                (v) => { track.compMix = v; },
                [1, 8], 0.5);
            fxRow.appendChild(eqSlot);
            fxRow.appendChild(compSlot);
            const verbBtn = document.createElement('button');
            verbBtn.type = 'button';
            verbBtn.className = 'mixer-fx-btn disabled' + (track.reverbOn ? ' on' : '');
            verbBtn.textContent = 'Reverb';
            verbBtn.title = 'Plate reverb (coming soon)';
            verbBtn.disabled = true;
            verbBtn.addEventListener('click', () => {
                pushUndo();
                track.reverbOn = !track.reverbOn;
                verbBtn.classList.toggle('on', track.reverbOn);
                window.MegaMix.syncTrackToLiveGraph(i);
                window.MegaMix.scheduleBuildAfter();
            });
            const retroBtn = document.createElement('button');
            retroBtn.type = 'button';
            retroBtn.className = 'mixer-fx-btn disabled';
            retroBtn.textContent = 'Retro';
            retroBtn.title = 'Coming soon';
            if (!track.automation) {
                track.automation = { level: [{ t: 0, value: track.gain }, { t: 1, value: track.gain }], pan: [{ t: 0, value: track.pan }, { t: 1, value: track.pan }] };
            }
            const autoBtn = document.createElement('button');
            autoBtn.type = 'button';
            autoBtn.className = 'mixer-fx-btn disabled';
            autoBtn.textContent = 'Auto';
            autoBtn.title = 'Level and pan automation (coming soon)';
            autoBtn.disabled = true;
            const autoPanel = document.createElement('div');
            autoPanel.className = 'mixer-automation-panel hidden';
            autoPanel.setAttribute('aria-hidden', 'true');
            function renderAutomationCurve(curveKey, label, valueMin, valueMax, valueStep) {
                const curve = track.automation[curveKey] || [];
                autoPanel.innerHTML = '';
                const levelHead = document.createElement('div');
                levelHead.className = 'automation-curve-header';
                levelHead.textContent = 'Level (0–100% = time, value 0–2)';
                autoPanel.appendChild(levelHead);
                const levelList = document.createElement('div');
                levelList.className = 'automation-keyframes';
                (track.automation.level || []).sort((a, b) => a.t - b.t).forEach((pt, idx) => {
                    const row = document.createElement('div');
                    row.className = 'automation-keyframe-row';
                    const tInput = document.createElement('input');
                    tInput.type = 'number';
                    tInput.min = 0;
                    tInput.max = 100;
                    tInput.step = 1;
                    tInput.value = Math.round(pt.t * 100);
                    tInput.title = 'Time %';
                    const vInput = document.createElement('input');
                    vInput.type = 'number';
                    vInput.min = 0;
                    vInput.max = 2;
                    vInput.step = 0.05;
                    vInput.value = pt.value;
                    vInput.title = 'Level';
                    const rm = document.createElement('button');
                    rm.type = 'button';
                    rm.className = 'mixer-fx-btn';
                    rm.textContent = '×';
                    rm.title = 'Remove';
                    const point = track.automation.level.slice().sort((a, b) => a.t - b.t)[idx];
                    const update = () => {
                        const t = Math.max(0, Math.min(1, parseFloat(tInput.value) / 100));
                        const v = Math.max(0, Math.min(2, parseFloat(vInput.value)));
                        point.t = t;
                        point.value = v;
                        track.automation.level.sort((a, b) => a.t - b.t);
                        window.MegaMix.scheduleBuildAfter();
                    };
                    tInput.addEventListener('input', update);
                    vInput.addEventListener('input', update);
                    rm.addEventListener('click', () => {
                        if (track.automation.level.length <= 2) return;
                        pushUndo();
                        const realIdx = track.automation.level.indexOf(point);
                        if (realIdx >= 0) track.automation.level.splice(realIdx, 1);
                        renderMixerStrips();
                        window.MegaMix.scheduleBuildAfter();
                    });
                    row.appendChild(tInput);
                    row.appendChild(vInput);
                    row.appendChild(rm);
                    levelList.appendChild(row);
                });
                autoPanel.appendChild(levelList);
                if (track.automation.level.length < 8) {
                    const addLevel = document.createElement('button');
                    addLevel.type = 'button';
                    addLevel.className = 'btn btn-small';
                    addLevel.textContent = '+ Level point';
                    addLevel.addEventListener('click', () => {
                        pushUndo();
                        track.automation.level.push({ t: 0.5, value: 1 });
                        track.automation.level.sort((a, b) => a.t - b.t);
                        renderMixerStrips();
                        window.MegaMix.scheduleBuildAfter();
                    });
                    autoPanel.appendChild(addLevel);
                }
                const panHead = document.createElement('div');
                panHead.className = 'automation-curve-header';
                panHead.textContent = 'Pan (0–100% = time, value -1 to 1)';
                autoPanel.appendChild(panHead);
                const panList = document.createElement('div');
                panList.className = 'automation-keyframes';
                (track.automation.pan || []).sort((a, b) => a.t - b.t).forEach((pt, idx) => {
                    const row = document.createElement('div');
                    row.className = 'automation-keyframe-row';
                    const tInput = document.createElement('input');
                    tInput.type = 'number';
                    tInput.min = 0;
                    tInput.max = 100;
                    tInput.step = 1;
                    tInput.value = Math.round(pt.t * 100);
                    const vInput = document.createElement('input');
                    vInput.type = 'number';
                    vInput.min = -1;
                    vInput.max = 1;
                    vInput.step = 0.05;
                    vInput.value = pt.value;
                    const rm = document.createElement('button');
                    rm.type = 'button';
                    rm.className = 'mixer-fx-btn';
                    rm.textContent = '×';
                    const point = track.automation.pan.slice().sort((a, b) => a.t - b.t)[idx];
                    const update = () => {
                        const t = Math.max(0, Math.min(1, parseFloat(tInput.value) / 100));
                        const v = Math.max(-1, Math.min(1, parseFloat(vInput.value)));
                        point.t = t;
                        point.value = v;
                        track.automation.pan.sort((a, b) => a.t - b.t);
                        window.MegaMix.scheduleBuildAfter();
                    };
                    tInput.addEventListener('input', update);
                    vInput.addEventListener('input', update);
                    rm.addEventListener('click', () => {
                        if (track.automation.pan.length <= 2) return;
                        pushUndo();
                        const realIdx = track.automation.pan.indexOf(point);
                        if (realIdx >= 0) track.automation.pan.splice(realIdx, 1);
                        renderMixerStrips();
                        window.MegaMix.scheduleBuildAfter();
                    });
                    row.appendChild(tInput);
                    row.appendChild(vInput);
                    row.appendChild(rm);
                    panList.appendChild(row);
                });
                autoPanel.appendChild(panList);
                if (track.automation.pan.length < 8) {
                    const addPan = document.createElement('button');
                    addPan.type = 'button';
                    addPan.className = 'btn btn-small';
                    addPan.textContent = '+ Pan point';
                    addPan.addEventListener('click', () => {
                        pushUndo();
                        track.automation.pan.push({ t: 0.5, value: 0 });
                        track.automation.pan.sort((a, b) => a.t - b.t);
                        renderMixerStrips();
                        window.MegaMix.scheduleBuildAfter();
                    });
                    autoPanel.appendChild(addPan);
                }
            }
            autoBtn.addEventListener('click', () => {
                const open = !autoPanel.classList.contains('hidden');
                if (open) {
                    autoPanel.classList.add('hidden');
                    autoPanel.setAttribute('aria-hidden', 'true');
                } else {
                    renderAutomationCurve('level', 'Level', 0, 2, 0.05);
                    autoPanel.classList.remove('hidden');
                    autoPanel.setAttribute('aria-hidden', 'false');
                }
            });
            fxRow.appendChild(verbBtn);
            fxRow.appendChild(retroBtn);
            fxRow.appendChild(autoBtn);
            strip.appendChild(nameWrap);
            strip.appendChild(faderWrap);
            strip.appendChild(panWrap);
            strip.appendChild(fxRow);
            strip.appendChild(autoPanel);
            mixerStripsEl.appendChild(strip);
        });
        console.log('[MegaMix perf] doRenderMixerStrips: ' + (performance.now() - t0).toFixed(2) + ' ms (tracks=' + state.tracks.length + ')');
    }
    function renderMixerStrips() {
        var now = Date.now();
        if (_renderStripsTimer) clearTimeout(_renderStripsTimer);
        if (now - _lastRenderStrips >= RENDER_STRIPS_THROTTLE_MS || _lastRenderStrips === 0) {
            _lastRenderStrips = now;
            console.log('[MegaMix perf] renderMixerStrips: run immediately (throttle ok)');
            doRenderMixerStrips();
        } else {
            var delay = RENDER_STRIPS_THROTTLE_MS - (now - _lastRenderStrips);
            console.log('[MegaMix perf] renderMixerStrips: throttled, defer ' + delay + ' ms');
            _renderStripsTimer = setTimeout(function () {
                _renderStripsTimer = null;
                _lastRenderStrips = Date.now();
                doRenderMixerStrips();
            }, delay);
        }
    }

    function initPlaybackCard() {
        window.MegaMix.onAfterMixBuilt = function () {
            if (audioAfter && state.mixedAfterUrl) audioAfter.src = state.mixedAfterUrl;
        };
        const tabs = document.querySelectorAll('.before-after-tab');
        const playbackPositionLabel = document.getElementById('playback-position-label');
        function getActiveMode() {
            const active = document.querySelector('.before-after-tab.active');
            return active ? active.getAttribute('data-mode') : 'before';
        }
        function setMutedFromTab() {
            const mode = getActiveMode();
            audioBefore.muted = (mode !== 'before');
            if (audioAfter) audioAfter.muted = (mode !== 'after');
        }
        function formatTime(s) {
            if (!isFinite(s) || s < 0) return '0:00';
            const m = Math.floor(s / 60);
            const sec = Math.floor(s % 60);
            return m + ':' + (sec < 10 ? '0' : '') + sec;
        }
        const duration = () => window.MegaMix.liveGraph() ? window.MegaMix.getTransportDuration() : (audioBefore.duration && isFinite(audioBefore.duration) ? audioBefore.duration : 0);
        var PROGRESS_UI_THROTTLE_MS = 120;
        var lastProgressUIUpdate = 0;
        function updateProgress() {
            const mode = getActiveMode();
            const d = duration();
            let t = 0;
            if (mode === 'after' && window.MegaMix.liveGraph() && window.MegaMix.livePlaybackSources().length > 0) {
                const lg = window.MegaMix.liveGraph();
                t = window.MegaMix.transportOffset() + (lg.ctx.currentTime - window.MegaMix.playbackStartTime());
                if (t >= d) {
                    window.MegaMix.stopLivePlayback();
                    playBtn.classList.remove('playing');
                    playBtn.textContent = '\u25B6';
                    window.MegaMix.setTransportOffset(0);
                    t = d;
                }
            } else if (mode === 'before') {
                t = audioBefore.currentTime || 0;
            } else if (mode === 'after' && audioAfter && isFinite(audioAfter.duration)) {
                t = audioAfter.currentTime || 0;
            } else {
                t = window.MegaMix.transportOffset();
            }
            var now = Date.now();
            if (now - lastProgressUIUpdate >= PROGRESS_UI_THROTTLE_MS) {
                lastProgressUIUpdate = now;
                if (d > 0) {
                    playbackProgress.value = (t / d) * 100;
                    playbackDuration.textContent = formatTime(d);
                }
                playbackTime.textContent = formatTime(t);
                if (playbackPositionLabel) playbackPositionLabel.textContent = 'Playback at ' + formatTime(t);
            }
        }
        function stopBoth() {
            audioBefore.pause();
            if (audioAfter) audioAfter.pause();
            window.MegaMix.stopLivePlayback();
            playBtn.classList.remove('playing');
            playBtn.textContent = '\u25B6';
            updateProgress();
        }
        function getCurrentPlaybackTime() {
            const d = duration();
            if (d <= 0) return 0;
            if (!audioBefore.paused) return audioBefore.currentTime || 0;
            if (audioAfter && !audioAfter.paused && isFinite(audioAfter.duration)) return audioAfter.currentTime || 0;
            if (window.MegaMix.livePlaybackSources().length > 0 && window.MegaMix.liveGraph()) {
                const lg = window.MegaMix.liveGraph();
                return window.MegaMix.transportOffset() + (lg.ctx.currentTime - window.MegaMix.playbackStartTime());
            }
            return (playbackProgress.value / 100) * d;
        }
        function startPlaybackAt(mode, pos) {
            const d = duration();
            if (d <= 0) return;
            if (mode === 'before') {
                audioBefore.currentTime = Math.min(pos, (audioBefore.duration || d) - 0.01);
                audioBefore.play();
                playBtn.classList.add('playing');
                playBtn.textContent = '\u23F8';
            } else if (mode === 'after' && window.MegaMix.liveGraph()) {
                window.MegaMix.startLivePlayback(pos);
                playBtn.classList.add('playing');
                playBtn.textContent = '\u23F8';
                window.MegaMix.setLivePlaybackRaf(requestAnimationFrame(tickLiveProgress));
            } else if (mode === 'after' && audioAfter && state.mixedAfterUrl) {
                audioAfter.muted = false;
                audioAfter.currentTime = Math.min(pos, (audioAfter.duration || d) - 0.01);
                audioAfter.play();
                playBtn.classList.add('playing');
                playBtn.textContent = '\u23F8';
            }
        }
        function tickLiveProgress() {
            if (window.MegaMix.livePlaybackSources().length === 0) return;
            updateProgress();
            window.MegaMix.setLivePlaybackRaf(requestAnimationFrame(tickLiveProgress));
        }
        tabs.forEach(tab => {
            tab.addEventListener('click', function () {
                tabs.forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
                this.classList.add('active');
                this.setAttribute('aria-selected', 'true');
                const playing = !audioBefore.paused || (audioAfter && !audioAfter.paused) || window.MegaMix.livePlaybackSources().length > 0;
                if (playing) {
                    const pos = getCurrentPlaybackTime();
                    audioBefore.pause();
                    if (audioAfter) audioAfter.pause();
                    window.MegaMix.stopLivePlayback();
                    setMutedFromTab();
                    startPlaybackAt(getActiveMode(), pos);
                } else {
                    setMutedFromTab();
                }
            });
        });
        playBtn.addEventListener('click', function () {
            const mode = getActiveMode();
            const playing = (mode === 'before' && !audioBefore.paused) || (mode === 'after' && (window.MegaMix.livePlaybackSources().length > 0 || (audioAfter && !audioAfter.paused)));
            if (playing) {
                stopBoth();
            } else {
                const d = duration();
                if (d <= 0) return;
                if (mode === 'before') {
                    const pos = audioBefore.currentTime || 0;
                    audioBefore.currentTime = pos;
                    audioBefore.play();
                    playBtn.classList.add('playing');
                    playBtn.textContent = '\u23F8';
                } else if (mode === 'after' && window.MegaMix.liveGraph()) {
                    const pos = (playbackProgress.value / 100) * d;
                    window.MegaMix.startLivePlayback(pos);
                    playBtn.classList.add('playing');
                    playBtn.textContent = '\u23F8';
                    window.MegaMix.setLivePlaybackRaf(requestAnimationFrame(tickLiveProgress));
                } else if (mode === 'after' && audioAfter && state.mixedAfterUrl) {
                    audioAfter.muted = false;
                    const pos = (playbackProgress.value / 100) * (audioAfter.duration || d);
                    audioAfter.currentTime = pos;
                    audioAfter.play();
                    playBtn.classList.add('playing');
                    playBtn.textContent = '\u23F8';
                }
            }
        });
        playbackProgress.addEventListener('input', function () {
            const d = duration();
            if (d <= 0) return;
            const t = (playbackProgress.value / 100) * d;
            const mode = getActiveMode();
            if (mode === 'before') {
                audioBefore.currentTime = t;
                playbackTime.textContent = formatTime(t);
            } else if (mode === 'after' && audioAfter && state.mixedAfterUrl) {
                window.MegaMix.setTransportOffset(t);
                audioAfter.currentTime = t;
                playbackTime.textContent = formatTime(t);
                if (window.MegaMix.livePlaybackSources().length > 0) {
                    window.MegaMix.startLivePlayback(t);
                }
            } else {
                window.MegaMix.setTransportOffset(t);
                playbackTime.textContent = formatTime(t);
                if (window.MegaMix.livePlaybackSources().length > 0) {
                    window.MegaMix.startLivePlayback(t);
                }
            }
            if (playbackPositionLabel) playbackPositionLabel.textContent = 'Playback at ' + formatTime(t);
        });
        audioBefore.addEventListener('loadedmetadata', function () {
            if (audioBefore.duration && isFinite(audioBefore.duration))
                playbackDuration.textContent = formatTime(audioBefore.duration);
        });
        audioBefore.addEventListener('timeupdate', function () {
            if (getActiveMode() === 'before') updateProgress();
        });
        audioBefore.addEventListener('ended', stopBoth);
        if (audioAfter) {
            audioAfter.addEventListener('ended', stopBoth);
            audioAfter.addEventListener('timeupdate', function () {
                if (getActiveMode() === 'after') updateProgress();
            });
        }
        setMutedFromTab();
    }

    function updateFileListVisibility() {
        if (uploadAndFilesBody) {
            uploadAndFilesBody.classList.toggle('collapsed', !state.fileListVisible);
            if (toggleFileListBtn) toggleFileListBtn.textContent = state.fileListVisible ? 'Hide file list' : 'Show file list';
        }
    }
    if (toggleFileListBtn && uploadAndFilesBody) {
        toggleFileListBtn.addEventListener('click', () => {
            state.fileListVisible = !state.fileListVisible;
            updateFileListVisibility();
        });
    }

    uploadZone.addEventListener('click', () => fileInput.click());
    uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('dragover'); });
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.classList.remove('dragover');
        if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener('change', () => {
        if (fileInput.files.length) addFiles(fileInput.files);
        fileInput.value = '';
    });

    const mixerCollapsible = document.getElementById('mixer-collapsible');
    const mixerCollapsibleToggle = document.getElementById('mixer-collapsible-toggle');
    if (mixerCollapsible && mixerCollapsibleToggle) {
        mixerCollapsibleToggle.addEventListener('click', function () {
            const collapsed = mixerCollapsible.classList.toggle('collapsed');
            mixerCollapsibleToggle.setAttribute('aria-expanded', !collapsed);
        });
    }

    function setMixItLoading(show) {
        if (mixItLoading) mixItLoading.classList.toggle('hidden', !show);
        btnMixIt.disabled = show;
        if (!show && mixItProgressFill) mixItProgressFill.style.width = '0%';
        if (!show && mixItLoadingText) mixItLoadingText.textContent = 'Mixing…';
    }
    function setMixItProgress(pct, statusText) {
        if (mixItProgressFill) mixItProgressFill.style.width = pct + '%';
        if (mixItLoadingText && statusText) mixItLoadingText.textContent = statusText;
    }

    async function runMixIt() {
        if (state.uploadedFiles.length === 0) {
            addChatMessage('bot', 'Upload stems first, then click Mix it.');
            return;
        }
        if (state.mixReady && state.hasInitialMix) {
            try {
                window.MegaMix.syncAllTracksToLiveGraph();
                await window.MegaMix.buildAfterOnly();
                if (audioAfter && state.mixedAfterUrl) audioAfter.src = state.mixedAfterUrl;
                addChatMessage('bot', 'Mix updated from your current settings.');
            } catch (e) {
                console.error(e);
            }
            return;
        }
        console.log('[MegaMix perf] runMixIt: start (files=' + state.uploadedFiles.length + ')');
        var tRunMixIt = performance.now();
        setMixItLoading(true);
        setMixItProgress(0, 'Decoding stems…');
        playbackInstruction.classList.add('hidden');
        if (mixLoadingBlock) mixLoadingBlock.classList.remove('hidden');
        playbackBuilding.classList.remove('hidden');
        playBtn.disabled = true;
        try {
            await window.MegaMix.decodeStemsToBuffers();
            setMixItProgress(20, 'Applying balance…');
            if (state.stemBuffers.length === 0) {
                setMixItLoading(false);
                if (mixLoadingBlock) mixLoadingBlock.classList.add('hidden');
                playbackInstruction.classList.remove('hidden');
                playbackInstruction.textContent = 'Could not decode audio. Try different files.';
                return;
            }
            const genreId = presetSelect.value;
            if (window.MegaMix.GENRE_BALANCE[genreId]) {
                pushUndo();
                window.MegaMix.applyMusicalBalance(state.tracks, genreId);
                renderMixerStrips();
            }
            if (guidanceForJosh && guidanceForJosh.value.trim()) {
                const guidance = guidanceForJosh.value.trim();
                const changes = window.MegaMix.interpretChatMessage(guidance, state.tracks, state.trackAnalyses);
                if (changes && changes.length > 0) {
                    pushUndo();
                    window.MegaMix.applyJoshResponse(state.tracks, changes);
                    renderMixerStrips();
                }
            }
            setMixItProgress(40, 'Building before mix…');
            window.MegaMix.revokeMixUrls();
            window.MegaMix.revokeMasteredUrl();
            const beforeMix = window.MegaMix.buildMixedBuffer(true);
            setMixItProgress(60, 'Building after mix…');
            const afterMix = await window.MegaMix.buildAfterMixWithFX();
            setMixItProgress(100, 'Finishing…');
            if (beforeMix) {
                state.mixedBeforeUrl = URL.createObjectURL(window.MegaMix.encodeWav(beforeMix.left, beforeMix.right, beforeMix.sampleRate));
                audioBefore.src = state.mixedBeforeUrl;
            }
            if (afterMix) {
                state.mixedAfterUrl = URL.createObjectURL(window.MegaMix.encodeWav(afterMix.left, afterMix.right, afterMix.sampleRate));
                audioAfter.src = state.mixedAfterUrl;
            }
            state.mixReady = true;
            state.hasInitialMix = true;
            state.fileListVisible = false;
            updateFileListVisibility();
            updateMasteringUI();
            var mixLoadingRow = document.getElementById('mix-it-loading-row');
            var mixProgressTrack = mixItLoading && mixItLoading.querySelector('.mix-it-progress-track');
            var mixDoneCheck = document.getElementById('mix-done-check');
            if (mixLoadingRow) mixLoadingRow.classList.add('hidden');
            if (mixProgressTrack) mixProgressTrack.classList.add('hidden');
            if (mixDoneCheck) {
                mixDoneCheck.classList.remove('hidden');
                mixDoneCheck.setAttribute('aria-hidden', 'false');
            }
            btnMixIt.disabled = false;
            setTimeout(function () {
                if (mixDoneCheck) mixDoneCheck.classList.add('mix-done-fade');
                setTimeout(function () {
                    setMixItLoading(false);
                    if (mixDoneCheck) {
                        mixDoneCheck.classList.add('hidden');
                        mixDoneCheck.classList.remove('mix-done-fade');
                        mixDoneCheck.setAttribute('aria-hidden', 'true');
                    }
                    if (mixLoadingRow) mixLoadingRow.classList.remove('hidden');
                    if (mixProgressTrack) mixProgressTrack.classList.remove('hidden');
                }, 500);
            }, 2000);
            if (mixLoadingBlock) mixLoadingBlock.classList.add('hidden');
            updatePlaybackInstruction();
            const afterTab = document.querySelector('.before-after-tab[data-mode="after"]');
            if (afterTab && !afterTab.classList.contains('active')) {
                document.querySelectorAll('.before-after-tab').forEach(tab => { tab.classList.remove('active'); tab.setAttribute('aria-selected', 'false'); });
                afterTab.classList.add('active');
                afterTab.setAttribute('aria-selected', 'true');
                audioBefore.muted = true;
                audioAfter.muted = false;
            }
            addChatMessage('bot', 'Mix ready. Listen in Before/After or refine with Josh.');
            console.log('[MegaMix perf] runMixIt: createLiveGraph');
            window.MegaMix.createLiveGraph();
            console.log('[MegaMix perf] runMixIt: total ' + (performance.now() - tRunMixIt).toFixed(2) + ' ms');
            const d = window.MegaMix.getTransportDuration();
            if (playbackDuration && d > 0) {
                const m = Math.floor(d / 60);
                const s = Math.floor(d % 60);
                playbackDuration.textContent = m + ':' + (s < 10 ? '0' : '') + s;
            }
        } catch (e) {
            console.error(e);
            setMixItLoading(false);
            if (mixLoadingBlock) mixLoadingBlock.classList.add('hidden');
            playbackInstruction.classList.remove('hidden');
            playbackInstruction.textContent = 'Mix build failed. Try fewer or shorter files.';
            playBtn.disabled = true;
        }
    }
    btnMixIt.addEventListener('click', runMixIt);

    (function initStep2PresetPrompts() {
        const grid = document.getElementById('preset-prompts-grid');
        const promptsByGenre = window.MegaMix.GENRE_PROMPTS || {};
        function updatePresetPromptButtons() {
            const genre = presetSelect && presetSelect.value ? presetSelect.value : 'custom';
            const prompts = promptsByGenre[genre] || promptsByGenre.custom || [];
            if (!grid) return;
            grid.querySelectorAll('.preset-prompt-btn').forEach((btn, idx) => {
                const text = prompts[idx] || '';
                btn.textContent = text;
                btn.setAttribute('data-prompt', text);
            });
        }
        if (presetSelect) presetSelect.addEventListener('change', updatePresetPromptButtons);
        if (grid) {
            grid.querySelectorAll('.preset-prompt-btn').forEach(btn => {
                btn.addEventListener('click', function () {
                    const prompt = this.getAttribute('data-prompt') || '';
                    if (guidanceForJosh) guidanceForJosh.value = prompt;
                });
            });
        }
        updatePresetPromptButtons();
    })();

    function appendBotMessageAnimated(containerEl, label, text) {
        const div = document.createElement('div');
        div.className = 'msg bot';
        containerEl.appendChild(div);
        const fullText = label + text;
        const words = text.split(/(\s+)/);
        const msPerWord = 40;
        const maxMs = 2000;
        const stepMs = Math.min(msPerWord, Math.floor(maxMs / Math.max(1, words.length)));
        let index = 0;
        div.textContent = label;
        function scrollToBottom() { containerEl.scrollTop = containerEl.scrollHeight; }
        function addNext() {
            if (index >= words.length) { scrollToBottom(); return; }
            div.textContent = label + words.slice(0, index + 1).join('');
            index += 1;
            scrollToBottom();
            if (index < words.length) setTimeout(addNext, stepMs);
        }
        if (words.length <= 1) { div.textContent = fullText; scrollToBottom(); }
        else setTimeout(addNext, stepMs);
    }
    function addChatMessage(who, text) {
        if (who === 'user') {
            const div = document.createElement('div');
            div.className = 'msg user';
            div.textContent = 'You: ' + text;
            chatMessages.appendChild(div);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        } else {
            appendBotMessageAnimated(chatMessages, 'Josh: ', text);
        }
    }
    chatSend.addEventListener('click', sendChat);
    chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
    function updateStep3QuickPrompts() {
        const container = document.getElementById('quick-prompts');
        const genre = (presetSelect && presetSelect.value) ? presetSelect.value : 'rock';
        const prompts = window.MegaMix.GENRE_QUICK_PROMPTS && window.MegaMix.GENRE_QUICK_PROMPTS[genre];
        if (!container) return;
        container.innerHTML = '';
        const list = Array.isArray(prompts) ? prompts : (window.MegaMix.GENRE_QUICK_PROMPTS && window.MegaMix.GENRE_QUICK_PROMPTS.custom) || [];
        list.forEach(function (item) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn-ghost btn-small quick-prompt';
            btn.setAttribute('data-prompt', item.prompt || item);
            btn.textContent = item.label || item;
            container.appendChild(btn);
        });
    }
    const quickPromptsEl = document.getElementById('quick-prompts');
    if (quickPromptsEl) {
        quickPromptsEl.addEventListener('click', function (e) {
            const btn = e.target && e.target.closest('.quick-prompt');
            if (!btn) return;
            const prompt = btn.getAttribute('data-prompt');
            if (prompt) {
                chatInput.value = prompt;
                sendChat();
            }
        });
    }
    updateStep3QuickPrompts();
    if (presetSelect) presetSelect.addEventListener('change', updateStep3QuickPrompts);

    function initJoshAvatarDrag(wrapEl) {
        if (!wrapEl) return;
        var startX = 0, startY = 0, startLeft = 0, startTop = 0;
        var wrapWidth = 0, wrapHeight = 0;
        function getRect() { return wrapEl.getBoundingClientRect(); }
        function clamp(x, min, max) { return Math.max(min, Math.min(max, x)); }
        wrapEl.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            e.preventDefault();
            var r = getRect();
            startX = e.clientX;
            startY = e.clientY;
            startLeft = r.left;
            startTop = r.top;
            wrapWidth = r.width;
            wrapHeight = r.height;
            wrapEl.style.bottom = '';
            wrapEl.style.left = startLeft + 'px';
            wrapEl.style.top = startTop + 'px';
            wrapEl.style.transform = 'none';
            function onMove(e2) {
                var dx = e2.clientX - startX;
                var dy = e2.clientY - startY;
                var newLeft = clamp(startLeft + dx, 0, window.innerWidth - wrapWidth);
                var newTop = clamp(startTop + dy, 0, window.innerHeight - wrapHeight);
                wrapEl.style.left = newLeft + 'px';
                wrapEl.style.top = newTop + 'px';
            }
            function onUp() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }
    initJoshAvatarDrag(document.getElementById('josh-avatar-mixing'));
    initJoshAvatarDrag(document.getElementById('josh-avatar-mastering'));

    function sendChat() {
        const text = chatInput.value.trim();
        if (!text) return;
        addChatMessage('user', text);
        chatInput.value = '';
        if (!state.mixReady) {
            setTimeout(() => addChatMessage('bot', 'Create your mix first: click Mix it, then I can help you refine it.'), 400);
            return;
        }
        const changes = window.MegaMix.interpretChatMessage(text, state.tracks, state.trackAnalyses);
        if (changes && changes.length > 0) {
            var tJosh = performance.now();
            console.log('[MegaMix perf] Josh chat: applying ' + changes.length + ' changes');
            pushUndo();
            window.MegaMix.applyJoshResponse(state.tracks, changes);
            console.log('[MegaMix perf] Josh chat: applyJoshResponse ' + (performance.now() - tJosh).toFixed(2) + ' ms');
            renderMixerStrips();
            window.MegaMix.syncAllTracksToLiveGraph();
            console.log('[MegaMix perf] Josh chat: renderMixerStrips + syncAllTracksToLiveGraph done, starting buildAfterOnly (async)');
            window.MegaMix.buildAfterOnly().then(() => {
                console.log('[MegaMix perf] Josh chat: buildAfterOnly finished, total since send ' + (performance.now() - tJosh).toFixed(2) + ' ms');
                if (audioAfter && state.mixedAfterUrl) audioAfter.src = state.mixedAfterUrl;
            }).catch(() => {});
            setTimeout(() => addChatMessage('bot', "I've applied those changes. Check the After tab and have a listen."), 400);
        } else {
            setTimeout(() => addChatMessage('bot', "I didn't catch which tracks to change. Try something like \"make the kick and snare more prominent\" or \"bring up the vocals\"."), 400);
        }
    }

    function getStoredPresets() {
        try {
            const raw = localStorage.getItem(window.MegaMix.PRESET_STORAGE_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch (_) { return []; }
    }
    function setStoredPresets(list) {
        localStorage.setItem(window.MegaMix.PRESET_STORAGE_KEY, JSON.stringify(list));
        refreshLoadPresetSelect();
    }
    function refreshLoadPresetSelect() {
        if (!loadPresetSelect) return;
        const list = getStoredPresets();
        const current = loadPresetSelect.value;
        loadPresetSelect.innerHTML = '<option value="">Load preset…</option>';
        list.forEach((p, i) => {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = p.name;
            loadPresetSelect.appendChild(opt);
        });
        if (current !== undefined) loadPresetSelect.value = current;
    }
    if (loadPresetSelect) refreshLoadPresetSelect();
    if (btnSavePreset) btnSavePreset.addEventListener('click', () => {
        const name = (presetNameInput && presetNameInput.value ? presetNameInput.value.trim() : '') || 'Preset ' + (getStoredPresets().length + 1);
        const list = getStoredPresets();
        list.push({ name, state: { tracks: JSON.parse(JSON.stringify(state.tracks)) } });
        setStoredPresets(list);
        if (presetNameInput) presetNameInput.value = '';
    });
    if (btnLoadPreset) btnLoadPreset.addEventListener('click', () => {
        if (!loadPresetSelect || loadPresetSelect.value === '') return;
        const list = getStoredPresets();
        const p = list[parseInt(loadPresetSelect.value, 10)];
        if (p && p.state.tracks && Array.isArray(p.state.tracks)) {
            pushUndo();
            state.tracks = JSON.parse(JSON.stringify(p.state.tracks));
            while (state.tracks.length > state.uploadedFiles.length) state.tracks.pop();
            while (state.tracks.length < state.uploadedFiles.length) state.tracks.push(window.MegaMix.defaultTrack(state.uploadedFiles[state.tracks.length].name));
            renderMixerStrips();
            window.MegaMix.buildAfterOnly().then(() => {
                if (audioAfter && state.mixedAfterUrl) audioAfter.src = state.mixedAfterUrl;
            }).catch(() => {});
        }
    });

    const MAX_UNDO_STACK = 50;
    let lastPushUndoTime = 0;
    const PUSH_UNDO_COOLDOWN_MS = 500;
    function pushUndo() {
        if (Date.now() - lastPushUndoTime < PUSH_UNDO_COOLDOWN_MS) return;
        lastPushUndoTime = Date.now();
        if (state.undoStack.length >= MAX_UNDO_STACK) state.undoStack.shift();
        state.undoStack.push(JSON.stringify(window.MegaMix.snapshotMixerState()));
        state.redoStack = [];
        updateUndoRedoButtons();
    }
    function updateUndoRedoButtons() {
        if (btnUndo) btnUndo.disabled = state.undoStack.length === 0;
        if (btnRedo) btnRedo.disabled = state.redoStack.length === 0;
    }
    function restoreTracks(s) {
        try {
            window.MegaMix.restoreMixerState(s);
            renderMixerStrips();
            window.MegaMix.syncAllTracksToLiveGraph();
            window.MegaMix.buildAfterOnly().then(() => {
                if (audioAfter && state.mixedAfterUrl) audioAfter.src = state.mixedAfterUrl;
            }).catch(() => {});
        } catch (_) {}
    }
    btnUndo.addEventListener('click', () => {
        if (state.undoStack.length === 0) return;
        if (state.redoStack.length >= MAX_UNDO_STACK) state.redoStack.shift();
        state.redoStack.push(JSON.stringify(window.MegaMix.snapshotMixerState()));
        restoreTracks(state.undoStack.pop());
        updateUndoRedoButtons();
        addChatMessage('bot', 'Undo applied.');
    });
    btnRedo.addEventListener('click', () => {
        if (state.redoStack.length === 0) return;
        if (state.undoStack.length >= MAX_UNDO_STACK) state.undoStack.shift();
        state.undoStack.push(JSON.stringify(window.MegaMix.snapshotMixerState()));
        restoreTracks(state.redoStack.pop());
        updateUndoRedoButtons();
        addChatMessage('bot', 'Redo applied.');
    });
    updateUndoRedoButtons();

    function openEmailModal(type) {
        pendingDownload = { type };
        if (emailModalApp) emailModalApp.classList.remove('hidden');
        if (emailInputApp) emailInputApp.value = '';
        document.body.style.overflow = 'hidden';
    }
    function closeEmailModal() {
        if (emailModalApp) emailModalApp.classList.add('hidden');
        pendingDownload = null;
        document.body.style.overflow = '';
    }
    function performMixDownload() {
        if (!state.mixReady || state.stemBuffers.length === 0) return;
        try {
            window.MegaMix.buildAfterMixWithFX().then(function (afterMix) {
                if (afterMix) {
                    const blob = window.MegaMix.encodeWav(afterMix.left, afterMix.right, afterMix.sampleRate);
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = (state.uploadedFiles[0].name.replace(/\.[^.]+$/, '') || 'mix') + '-mix.wav';
                    a.click();
                    URL.revokeObjectURL(a.href);
                }
            }).catch(function (e) { console.error('Export', e); });
        } catch (e) { console.error('Export', e); }
    }
    function performMasteredDownload() {
        if (!state.masteredUrl) return;
        const a = document.createElement('a');
        a.href = state.masteredUrl;
        a.download = (state.uploadedFiles[0] ? state.uploadedFiles[0].name.replace(/\.[^.]+$/, '') : 'mix') + '-mastered.wav';
        a.click();
    }
    function performPendingDownload() {
        if (!pendingDownload) return;
        const t = pendingDownload.type;
        pendingDownload = null;
        if (t === 'mix') performMixDownload();
        else if (t === 'mastered') performMasteredDownload();
    }
    function isValidEmail(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '');
    }
    async function handleEmailSignup(signedUp) {
        const info = pendingDownload;
        if (signedUp && emailInputApp) {
            const email = emailInputApp.value.trim();
            if (!email || !isValidEmail(email)) {
                alert('Please enter a valid email address.');
                return;
            }
            const format = info && info.type === 'mastered' ? 'web-mastered' : 'web-mix';
            try {
                const base = window.location.origin || '';
                const res = await fetch(base + '/mailchimp-signup', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, format, platform: 'web' })
                });
                const data = await res.json().catch(function () { return {}; });
                if (!data.success) console.warn('Mailchimp signup', data.error || data);
            } catch (e) { console.warn('Mailchimp signup', e); }
        }
        closeEmailModal();
        if (info) {
            if (info.type === 'mix') performMixDownload();
            else if (info.type === 'mastered') performMasteredDownload();
        }
    }

    function isPreviewMode() {
        return window.MegaMixAuth && window.MegaMixAuth.isPreviewMode && window.MegaMixAuth.isPreviewMode();
    }

    btnExport.addEventListener('click', function () {
        if (!state.mixReady || state.stemBuffers.length === 0) return;
        if (isPreviewMode()) {
            pendingDownload = { type: 'mix' };
            if (window.MegaMixAuth && window.MegaMixAuth.showLoginRequired) window.MegaMixAuth.showLoginRequired();
            return;
        }
        openEmailModal('mix');
    });

    const btnAiMastering = document.getElementById('btn-ai-mastering');

    var masteringProgressFill = document.getElementById('mastering-progress-fill');
    function showMasteringStatus(text, progressPct) {
        if (masteringStatusEl) masteringStatusEl.textContent = text || '';
        if (masteringLoadingBlock) masteringLoadingBlock.classList.toggle('hidden', !text);
        if (masteringProgressFill) masteringProgressFill.style.width = (progressPct != null ? progressPct : 0) + '%';
    }
    if (btnAiMastering) {
        btnAiMastering.addEventListener('click', async () => {
            if (!state.mixReady || state.stemBuffers.length === 0) {
                addChatMessage('bot', 'Upload stems and click Mix it first, then run AI Mastering.');
                return;
            }
            try {
                var tMastering = performance.now();
                console.log('[MegaMix perf] AI Mastering: start (step 1 buildAfterMixWithFX, step 2 runMasteringChain)');
                window.MegaMix.revokeMasteredUrl();
                btnAiMastering.disabled = true;
                showMasteringStatus('Rendering mix… (step 1 of 2)', 10);
                const afterMix = await window.MegaMix.buildAfterMixWithFX();
                if (!afterMix) {
                    showMasteringStatus('', 0);
                    btnAiMastering.disabled = false;
                    addChatMessage('bot', 'Could not render the mix. Try again.');
                    return;
                }
                if (state.unmasteredMixUrl) URL.revokeObjectURL(state.unmasteredMixUrl);
                state.unmasteredMixUrl = URL.createObjectURL(window.MegaMix.encodeWav(afterMix.left, afterMix.right, afterMix.sampleRate));
                showMasteringStatus('Applying AI mastering… (step 2 of 2)', 50);
                state.masteringOptions = state.masteringOptions || { punch: 0, loudness: 0, compression: 1 };
                const mastered = await window.MegaMix.runMasteringChain(afterMix, state.masteringOptions);
                showMasteringStatus('', 0);
                btnAiMastering.disabled = false;
                console.log('[MegaMix perf] AI Mastering: total ' + (performance.now() - tMastering).toFixed(2) + ' ms');
                if (mastered) {
                    state.masteredUrl = URL.createObjectURL(window.MegaMix.encodeWav(mastered.left, mastered.right, mastered.sampleRate));
                    addChatMessage('bot', 'Mastering complete. Taking you to the Mastering page.');
                    showView('mastering');
                } else {
                    addChatMessage('bot', 'Mastering did not produce output. Try again.');
                }
            } catch (e) {
                console.error('AI Mastering', e);
                showMasteringStatus('', 0);
                btnAiMastering.disabled = false;
                addChatMessage('bot', 'Mastering failed. Please try again.');
            }
        });
    }
    let masteringPageInited = false;
    function initMasteringPageWhenShown() {
        const audioMasteringBefore = document.getElementById('audio-mastering-before');
        const audioMastering = document.getElementById('audio-mastering');
        const playMastering = document.getElementById('play-mastering');
        const progressMastering = document.getElementById('progress-mastering');
        const timeMastering = document.getElementById('time-mastering');
        const durationMastering = document.getElementById('duration-mastering');
        const chatMessagesMastering = document.getElementById('chat-messages-mastering');
        const chatInputMastering = document.getElementById('chat-input-mastering');
        const chatSendMastering = document.getElementById('chat-send-mastering');
        const btnDownloadMasteredFinal = document.getElementById('btn-download-mastered-final');
        const masteringTabs = document.querySelectorAll('.mastering-tab');
        if (!audioMastering || !playMastering || !progressMastering) return;

        function formatTime(s) {
            if (!isFinite(s) || s < 0) return '0:00';
            const m = Math.floor(s / 60);
            const sec = Math.floor(s % 60);
            return m + ':' + (sec < 10 ? '0' : '') + sec;
        }
        function getActiveMasteringMode() {
            const active = document.querySelector('.mastering-tab.active');
            return active ? active.getAttribute('data-mode') : 'after';
        }
        function setMasteringMutedFromTab() {
            const mode = getActiveMasteringMode();
            if (audioMasteringBefore) audioMasteringBefore.muted = (mode !== 'before');
            audioMastering.muted = (mode !== 'after');
        }
        function masteringDuration() {
            const mode = getActiveMasteringMode();
            const el = mode === 'before' && audioMasteringBefore ? audioMasteringBefore : audioMastering;
            return (el && el.duration && isFinite(el.duration)) ? el.duration : 0;
        }
        var MASTERING_PROGRESS_THROTTLE_MS = 120;
        var lastMasteringProgressUIUpdate = 0;
        function updateMasteringProgress() {
            const mode = getActiveMasteringMode();
            const el = mode === 'before' && audioMasteringBefore ? audioMasteringBefore : audioMastering;
            const d = masteringDuration();
            const t = (el && el.currentTime != null) ? el.currentTime : 0;
            var now = Date.now();
            if (now - lastMasteringProgressUIUpdate >= MASTERING_PROGRESS_THROTTLE_MS) {
                lastMasteringProgressUIUpdate = now;
                if (d > 0) {
                    progressMastering.value = (t / d) * 100;
                    if (durationMastering) durationMastering.textContent = formatTime(d);
                }
                if (timeMastering) timeMastering.textContent = formatTime(t);
                drawMasteringWaveform();
            }
        }

        let waveformBins = null;
        const canvasWaveform = document.getElementById('waveform-mastering');
        function drawMasteringWaveform() {
            if (!canvasWaveform || !waveformBins || waveformBins.length === 0) return;
            const mode = getActiveMasteringMode();
            const el = mode === 'before' && audioMasteringBefore ? audioMasteringBefore : audioMastering;
            const d = (el && el.duration && isFinite(el.duration)) ? el.duration : 0;
            const t = (el && el.currentTime != null) ? el.currentTime : 0;
            const w = canvasWaveform.width;
            const h = canvasWaveform.height;
            const ctx = canvasWaveform.getContext('2d');
            if (!ctx) return;
            ctx.fillStyle = 'rgba(0,0,0,0.3)';
            ctx.fillRect(0, 0, w, h);
            const n = waveformBins.length;
            const barW = Math.max(1, w / n);
            const midY = h / 2;
            ctx.fillStyle = 'rgba(139, 92, 246, 0.6)';
            for (let i = 0; i < n; i++) {
                const v = waveformBins[i];
                const barH = Math.max(1, (v * midY));
                ctx.fillRect(i * barW, midY - barH / 2, barW, barH);
            }
            const playheadX = d && isFinite(d) && d > 0 ? (t / d) * w : 0;
            ctx.fillStyle = 'rgba(255,255,255,0.9)';
            ctx.fillRect(playheadX - 1, 0, 2, h);
        }
        function fillWaveformFromUrl(url) {
            if (!canvasWaveform || !window.MegaMix || !window.MegaMix.getAudioContext) return;
            const ctx = window.MegaMix.getAudioContext();
            fetch(url).then(r => r.arrayBuffer()).then(ab => ctx.decodeAudioData(ab)).then(buffer => {
                const ch0 = buffer.getChannelData(0);
                const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
                const len = buffer.length;
                const numBins = Math.min(800, Math.max(200, Math.floor(len / 1024)));
                const binSize = Math.floor(len / numBins);
                const bins = new Float32Array(numBins);
                for (let i = 0; i < numBins; i++) {
                    let peak = 0;
                    const start = i * binSize;
                    const end = Math.min(start + binSize, len);
                    for (let j = start; j < end; j++) {
                        const s = (Math.abs(ch0[j]) + Math.abs(ch1[j])) / 2;
                        if (s > peak) peak = s;
                    }
                    bins[i] = peak;
                }
                let max = 0;
                for (let i = 0; i < numBins; i++) if (bins[i] > max) max = bins[i];
                if (max > 0) for (let i = 0; i < numBins; i++) bins[i] /= max;
                waveformBins = bins;
                if (canvasWaveform.parentElement) {
                    const r = window.devicePixelRatio || 1;
                    const cw = Math.floor((canvasWaveform.parentElement.offsetWidth || 600) * r);
                    const ch = Math.floor(70 * r);
                    canvasWaveform.width = cw;
                    canvasWaveform.height = ch;
                }
                drawMasteringWaveform();
            }).catch(() => {});
        }
        const masteringBaseValues = { threshold: -18, ratio: 2.5, attack: 0.01, release: 0.2, output: 1 };
        function ensureMasteringGraph() {
            if (masteringGraphInited || !window.MegaMix || !window.MegaMix.getAudioContext) return;
            const ctx = window.MegaMix.getAudioContext();
            if (audioMasteringBefore) {
                const sourceBefore = ctx.createMediaElementSource(audioMasteringBefore);
                sourceBefore.connect(ctx.destination);
            }
            const source = ctx.createMediaElementSource(audioMastering);
            const dryGain = ctx.createGain();
            const compressor = ctx.createDynamicsCompressor();
            const wetGainNode = ctx.createGain();
            const wetGain = ctx.createGain();
            const sumNode = ctx.createGain();
            compressor.threshold.value = masteringBaseValues.threshold;
            compressor.knee.value = 6;
            compressor.ratio.value = masteringBaseValues.ratio;
            compressor.attack.value = masteringBaseValues.attack;
            compressor.release.value = masteringBaseValues.release;
            wetGainNode.gain.value = masteringBaseValues.output;
            source.connect(dryGain);
            source.connect(compressor);
            compressor.connect(wetGainNode);
            wetGainNode.connect(wetGain);
            dryGain.connect(sumNode);
            wetGain.connect(sumNode);
            sumNode.connect(ctx.destination);
            const mixEl = document.getElementById('mastering-mix');
            const mixPct = mixEl ? Math.max(0, Math.min(100, Number(mixEl.value) || 100)) : 100;
            dryGain.gain.value = 1 - mixPct / 100;
            wetGain.gain.value = mixPct / 100;
            masterCompressor = compressor;
            masterGain = wetGainNode;
            masterDryGain = dryGain;
            masterWetGain = wetGain;
            masteringGraphInited = true;
        }
        if (state.masteredUrl) {
            ensureMasteringGraph();
            audioMastering.src = state.masteredUrl;
            if (state.unmasteredMixUrl && audioMasteringBefore) audioMasteringBefore.src = state.unmasteredMixUrl;
            audioMastering.onloadedmetadata = function () {
                if (audioMastering.duration && isFinite(audioMastering.duration) && durationMastering)
                    durationMastering.textContent = formatTime(audioMastering.duration);
            };
            if (audioMasteringBefore) audioMasteringBefore.onloadedmetadata = function () {
                if (getActiveMasteringMode() === 'before' && durationMastering && audioMasteringBefore.duration && isFinite(audioMasteringBefore.duration))
                    durationMastering.textContent = formatTime(audioMasteringBefore.duration);
            };
            masteringTabs.forEach(function (t) {
                t.classList.remove('active');
                t.setAttribute('aria-selected', 'false');
            });
            var afterTab = document.querySelector('.mastering-tab[data-mode="after"]');
            if (afterTab) {
                afterTab.classList.add('active');
                afterTab.setAttribute('aria-selected', 'true');
            }
            setMasteringMutedFromTab();
            fillWaveformFromUrl(state.masteredUrl);
        } else if (chatMessagesMastering) {
            const msg = document.createElement('div');
            msg.className = 'msg bot';
            msg.textContent = 'Josh: Run AI Mastering from the mixing page first.';
            chatMessagesMastering.appendChild(msg);
        }

        function stopBothMastering() {
            if (audioMasteringBefore) audioMasteringBefore.pause();
            audioMastering.pause();
            playMastering.classList.remove('playing');
            playMastering.textContent = '\u25B6';
            updateMasteringProgress();
        }
        function getCurrentMasteringTime() {
            const mode = getActiveMasteringMode();
            if (mode === 'before' && audioMasteringBefore && !audioMasteringBefore.paused)
                return audioMasteringBefore.currentTime || 0;
            if (!audioMastering.paused) return audioMastering.currentTime || 0;
            const d = masteringDuration();
            return d > 0 ? (progressMastering.value / 100) * d : 0;
        }
        function startMasteringPlaybackAt(mode, pos) {
            const d = masteringDuration();
            if (d <= 0) return;
            if (mode === 'before' && audioMasteringBefore && state.unmasteredMixUrl) {
                audioMasteringBefore.currentTime = Math.min(pos, (audioMasteringBefore.duration || d) - 0.01);
                audioMasteringBefore.muted = false;
                audioMasteringBefore.play();
            } else if (mode === 'after' && state.masteredUrl) {
                audioMastering.currentTime = Math.min(pos, (audioMastering.duration || d) - 0.01);
                audioMastering.muted = false;
                audioMastering.play();
            }
            playMastering.classList.add('playing');
            playMastering.textContent = '\u23F8';
        }
        if (!masteringPageInited) {
            masteringPageInited = true;
            masteringTabs.forEach(function (tab) {
                tab.addEventListener('click', function () {
                    masteringTabs.forEach(function (t) { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
                    this.classList.add('active');
                    this.setAttribute('aria-selected', 'true');
                    const playing = (audioMasteringBefore && !audioMasteringBefore.paused) || !audioMastering.paused;
                    if (playing) {
                        const pos = getCurrentMasteringTime();
                        if (audioMasteringBefore) audioMasteringBefore.pause();
                        audioMastering.pause();
                        setMasteringMutedFromTab();
                        startMasteringPlaybackAt(getActiveMasteringMode(), pos);
                    } else {
                        setMasteringMutedFromTab();
                    }
                });
            });
            playMastering.addEventListener('click', function () {
                const mode = getActiveMasteringMode();
                const playing = (audioMasteringBefore && !audioMasteringBefore.paused) || !audioMastering.paused;
                if (playing) {
                    stopBothMastering();
                } else {
                    const d = masteringDuration();
                    if (d <= 0) return;
                    const pos = getCurrentMasteringTime();
                    setMasteringMutedFromTab();
                    startMasteringPlaybackAt(mode, pos);
                }
            });
            audioMastering.addEventListener('timeupdate', function () { if (getActiveMasteringMode() === 'after') updateMasteringProgress(); });
            if (audioMasteringBefore) audioMasteringBefore.addEventListener('timeupdate', function () { if (getActiveMasteringMode() === 'before') updateMasteringProgress(); });
            audioMastering.addEventListener('ended', stopBothMastering);
            if (audioMasteringBefore) audioMasteringBefore.addEventListener('ended', stopBothMastering);
            progressMastering.addEventListener('input', function () {
                const d = masteringDuration();
                if (d && isFinite(d) && d > 0) {
                    const t = (progressMastering.value / 100) * d;
                    const mode = getActiveMasteringMode();
                    if (mode === 'before' && audioMasteringBefore) audioMasteringBefore.currentTime = t;
                    else audioMastering.currentTime = t;
                    if (timeMastering) timeMastering.textContent = formatTime(t);
                    drawMasteringWaveform();
                }
            });
            if (audioMastering) audioMastering.addEventListener('seeked', drawMasteringWaveform);
            if (audioMasteringBefore) audioMasteringBefore.addEventListener('seeked', drawMasteringWaveform);
            const masteringControlsCollapsible = document.getElementById('mastering-controls-collapsible');
            const masteringControlsToggle = document.getElementById('mastering-controls-toggle');
            if (masteringControlsCollapsible && masteringControlsToggle) {
                masteringControlsToggle.addEventListener('click', function () {
                    const collapsed = masteringControlsCollapsible.classList.toggle('collapsed');
                    masteringControlsToggle.setAttribute('aria-expanded', !collapsed);
                });
            }
            function getAdjustDelta() {
                const adjEl = document.getElementById('mastering-adjust');
                const pct = adjEl ? Math.max(0, Math.min(100, Number(adjEl.value) || 50)) : 50;
                return (pct - 50) / 50;
            }
            function applyMasteringFromSlidersAndAdjust() {
                const delta = getAdjustDelta();
                const threshRange = 3;
                const ratioRange = 2.5;
                const attackRange = 0.2;
                const releaseRange = 0.5;
                const thresholdEffective = masteringBaseValues.threshold - delta * threshRange;
                const ratioEffective = Math.max(1, Math.min(20, masteringBaseValues.ratio + delta * ratioRange));
                const attackEffective = Math.max(0.001, Math.min(0.5, masteringBaseValues.attack + delta * attackRange));
                const releaseEffective = Math.max(0.01, Math.min(2, masteringBaseValues.release - delta * releaseRange));
                if (masterCompressor) {
                    masterCompressor.threshold.value = thresholdEffective;
                    masterCompressor.ratio.value = ratioEffective;
                    masterCompressor.attack.value = attackEffective;
                    masterCompressor.release.value = releaseEffective;
                }
                if (masterGain) masterGain.gain.value = Math.max(0.01, masteringBaseValues.output);
                const thresholdValEl = document.getElementById('mastering-threshold-value');
                const ratioValEl = document.getElementById('mastering-ratio-value');
                const attackValEl = document.getElementById('mastering-attack-value');
                const releaseValEl = document.getElementById('mastering-release-value');
                const outputValEl = document.getElementById('mastering-output-value');
                if (thresholdValEl) thresholdValEl.textContent = typeof thresholdEffective === 'number' && thresholdEffective % 1 !== 0 ? thresholdEffective.toFixed(2) : String(thresholdEffective);
                if (ratioValEl) ratioValEl.textContent = typeof ratioEffective === 'number' && ratioEffective % 1 !== 0 ? ratioEffective.toFixed(2) : String(ratioEffective);
                if (attackValEl) attackValEl.textContent = typeof attackEffective === 'number' ? attackEffective.toFixed(3) : String(attackEffective);
                if (releaseValEl) releaseValEl.textContent = typeof releaseEffective === 'number' && releaseEffective % 1 !== 0 ? releaseEffective.toFixed(2) : String(releaseEffective);
                if (outputValEl) outputValEl.textContent = typeof masteringBaseValues.output === 'number' && masteringBaseValues.output % 1 !== 0 ? masteringBaseValues.output.toFixed(2) : String(masteringBaseValues.output);
            }
            function updateMasteringParam(sliderId, valueId, mapFn, baseKey) {
                const slider = document.getElementById(sliderId);
                if (!slider) return;
                function update() {
                    const val = mapFn(Number(slider.value));
                    if (baseKey) masteringBaseValues[baseKey] = val;
                    applyMasteringFromSlidersAndAdjust();
                }
                slider.addEventListener('input', update);
                update();
            }
            updateMasteringParam('mastering-threshold', 'mastering-threshold-value', function (v) { return -30 + (v / 100) * 30; }, 'threshold');
            updateMasteringParam('mastering-ratio', 'mastering-ratio-value', function (v) { return 1 + (v / 100) * 19; }, 'ratio');
            updateMasteringParam('mastering-attack', 'mastering-attack-value', function (v) { return 0.001 + (v / 100) * 0.499; }, 'attack');
            updateMasteringParam('mastering-release', 'mastering-release-value', function (v) { return 0.01 + (v / 100) * 1.99; }, 'release');
            updateMasteringParam('mastering-output', 'mastering-output-value', function (v) { return 0.5 + (v / 100) * 1.5; }, 'output');
            const adjustInput = document.getElementById('mastering-adjust');
            const knobAdjustEl = document.getElementById('knob-adjust');
            function setAdjustKnobUI(value) {
                const v = Math.max(0, Math.min(100, Number(value) || 50));
                if (adjustInput) adjustInput.value = v;
                if (knobAdjustEl) {
                    const needle = knobAdjustEl.querySelector('.rotary-knob-needle');
                    if (needle) needle.style.transform = 'rotate(' + ((v / 100) * 270 - 135) + 'deg)';
                    knobAdjustEl.setAttribute('aria-valuenow', v);
                }
                const label = document.getElementById('adjust-knob-label');
                if (label) label.textContent = v === 50 ? '12:00' : (v < 50 ? '-' + (50 - v) + '%' : '+' + (v - 50) + '%');
            }
            if (adjustInput) {
                adjustInput.addEventListener('input', function () {
                    setAdjustKnobUI(this.value);
                    applyMasteringFromSlidersAndAdjust();
                });
            }
            function initRotaryKnob(knobEl, initialValue, minVal, maxVal, onChange) {
                var value = Math.max(minVal, Math.min(maxVal, initialValue));
                var startY = 0;
                var startVal = 0;
                knobEl.addEventListener('mousedown', function (e) {
                    e.preventDefault();
                    startY = e.clientY;
                    startVal = value;
                    function onMove(e2) {
                        value = Math.max(minVal, Math.min(maxVal, startVal - (e2.clientY - startY) * 0.5));
                        onChange(value);
                    }
                    function onUp() {
                        document.removeEventListener('mousemove', onMove);
                        document.removeEventListener('mouseup', onUp);
                    }
                    document.addEventListener('mousemove', onMove);
                    document.addEventListener('mouseup', onUp);
                });
                knobEl.addEventListener('keydown', function (e) {
                    var step = e.shiftKey ? 10 : 5;
                    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
                        e.preventDefault();
                        value = Math.min(maxVal, value + step);
                        onChange(value);
                    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
                        e.preventDefault();
                        value = Math.max(minVal, value - step);
                        onChange(value);
                    }
                });
            }
            if (knobAdjustEl && adjustInput) {
                initRotaryKnob(knobAdjustEl, 50, 0, 100, function (v) {
                    setAdjustKnobUI(v);
                    adjustInput.dispatchEvent(new Event('input', { bubbles: true }));
                });
                setAdjustKnobUI(adjustInput.value);
            }
            const mixKnob = document.getElementById('mastering-mix');
            const mixValueEl = document.getElementById('mastering-mix-value');
            const knobMixEl = document.getElementById('knob-mix');
            if (mixKnob && masterDryGain !== undefined && masterWetGain !== undefined) {
                function applyMixKnob() {
                    const pct = Math.max(0, Math.min(100, Number(mixKnob.value) || 100));
                    if (masterDryGain) masterDryGain.gain.value = 1 - pct / 100;
                    if (masterWetGain) masterWetGain.gain.value = pct / 100;
                    if (mixValueEl) mixValueEl.textContent = pct + '%';
                }
                mixKnob.addEventListener('input', applyMixKnob);
                if (mixValueEl) mixValueEl.textContent = (Number(mixKnob.value) || 100) + '%';
                if (knobMixEl) {
                    function setMixKnobUI(value) {
                        var v = Math.max(0, Math.min(100, Number(value) || 100));
                        mixKnob.value = v;
                        var needle = knobMixEl.querySelector('.rotary-knob-needle');
                        if (needle) needle.style.transform = 'rotate(' + ((v / 100) * 270 - 135) + 'deg)';
                        knobMixEl.setAttribute('aria-valuenow', v);
                        applyMixKnob();
                    }
                    initRotaryKnob(knobMixEl, 100, 0, 100, setMixKnobUI);
                    setMixKnobUI(mixKnob.value);
                }
            }
            function addMasteringChatMessage(who, text) {
                if (!chatMessagesMastering) return;
                if (who === 'user') {
                    const div = document.createElement('div');
                    div.className = 'msg user';
                    div.textContent = 'You: ' + text;
                    chatMessagesMastering.appendChild(div);
                    chatMessagesMastering.scrollTop = chatMessagesMastering.scrollHeight;
                } else {
                    appendBotMessageAnimated(chatMessagesMastering, 'Josh: ', text);
                }
            }
            function interpretMasteringMessage(text) {
                const t = text.toLowerCase();
                const delta = {};
                if (/\b(more|add|increase|boost)\s*(punch|punchy|transient)\b|\bpunch(ier)?\b/.test(t)) { delta.punch = 1; }
                else if (/\b(less|reduce|decrease)\s*punch\b|\b(softer|smoother)\s*transient\b/.test(t)) { delta.punch = -1; }
                else if (/\b(louder|more\s*loudness|boost\s*level|increase\s*volume)\b/.test(t)) { delta.loudness = 1; }
                else if (/\b(quieter|less\s*loud|lower\s*level|reduce\s*volume)\b/.test(t)) { delta.loudness = -1; }
                else if (/\b(more|increase|heavier)\s*compression\b|\b(compress|squash)\s*more\b/.test(t)) { delta.compression = 1; }
                else if (/\b(less|reduce|lighter)\s*compression\b|\bless\s*squash\b/.test(t)) { delta.compression = -1; }
                else if (/\bbright(er)?\b|\bmore\s*treble\b/.test(t)) { delta.punch = 1; }
                else if (/\bwarm(er)?\b|\bmore\s*bass\b/.test(t)) { delta.compression = -0.5; }
                return delta;
            }
            function applyMasteringDelta(delta) {
                state.masteringOptions = state.masteringOptions || { punch: 0, loudness: 0, compression: 1 };
                if (delta.punch !== undefined) state.masteringOptions.punch = Math.max(0, Math.min(2, (state.masteringOptions.punch || 0) + delta.punch));
                if (delta.loudness !== undefined) state.masteringOptions.loudness = Math.max(0, Math.min(2, (state.masteringOptions.loudness || 0) + delta.loudness));
                if (delta.compression !== undefined) state.masteringOptions.compression = Math.max(0, Math.min(2, (state.masteringOptions.compression !== undefined ? state.masteringOptions.compression : 1) + delta.compression));
            }
            function masteringReplyForDelta(delta) {
                if (delta.punch === 1) return "Done. I've added more punch to the master. Have a listen.";
                if (delta.punch === -1) return "Done. I've softened the punch a bit. Have a listen.";
                if (delta.loudness === 1) return "Done. I've made it louder. Have a listen.";
                if (delta.loudness === -1) return "Done. I've reduced the level a bit. Have a listen.";
                if (delta.compression === 1) return "Done. I've added more compression. Have a listen.";
                if (delta.compression === -1 || delta.compression === -0.5) return "Done. I've lightened the compression. Have a listen.";
                return "Done. I've applied your changes. Have a listen.";
            }
            if (chatSendMastering && chatInputMastering) {
                chatSendMastering.addEventListener('click', async function () {
                    const text = (chatInputMastering.value || '').trim();
                    if (!text) return;
                    addMasteringChatMessage('user', text);
                    chatInputMastering.value = '';
                    const delta = interpretMasteringMessage(text);
                    const understood = Object.keys(delta).length > 0;
                    if (!understood) {
                        addMasteringChatMessage('bot', "I can adjust things like punch, loudness, and tone. Try \"more punch\" or \"make it louder\".");
                        return;
                    }
                    if (!state.mixReady || state.stemBuffers.length === 0) {
                        addMasteringChatMessage('bot', 'Upload stems and run Mix it first, then AI Mastering, before refining here.');
                        return;
                    }
                    const sendBtn = chatSendMastering;
                    sendBtn.disabled = true;
                    function removeThinking() {
                        var el = chatMessagesMastering && chatMessagesMastering.querySelector('.mastering-thinking');
                        if (el) el.remove();
                    }
                    var thinkingEl = document.createElement('div');
                    thinkingEl.className = 'msg bot mastering-thinking';
                    thinkingEl.textContent = 'Josh: Thinking…';
                    if (chatMessagesMastering) {
                        chatMessagesMastering.appendChild(thinkingEl);
                        chatMessagesMastering.scrollTop = chatMessagesMastering.scrollHeight;
                    }
                    try {
                        const afterMix = await window.MegaMix.buildAfterMixWithFX();
                        removeThinking();
                        if (!afterMix) {
                            addMasteringChatMessage('bot', 'Could not render the mix. Try again.');
                            sendBtn.disabled = false;
                            return;
                        }
                        applyMasteringDelta(delta);
                        const mastered = await window.MegaMix.runMasteringChain(afterMix, state.masteringOptions);
                        if (!mastered) {
                            addMasteringChatMessage('bot', 'Mastering failed. Try again.');
                            sendBtn.disabled = false;
                            return;
                        }
                        if (state.masteredUrl) URL.revokeObjectURL(state.masteredUrl);
                        state.masteredUrl = URL.createObjectURL(window.MegaMix.encodeWav(mastered.left, mastered.right, mastered.sampleRate));
                        audioMastering.src = state.masteredUrl;
                        audioMastering.onloadedmetadata = function () {
                            if (audioMastering.duration && isFinite(audioMastering.duration) && durationMastering)
                                durationMastering.textContent = formatTime(audioMastering.duration);
                        };
                        fillWaveformFromUrl(state.masteredUrl);
                        addMasteringChatMessage('bot', masteringReplyForDelta(delta));
                    } catch (e) {
                        console.error('Mastering chat', e);
                        removeThinking();
                        addMasteringChatMessage('bot', 'Something went wrong. Please try again.');
                    }
                    sendBtn.disabled = false;
                });
                chatInputMastering.addEventListener('keydown', function (e) {
                    if (e.key === 'Enter') chatSendMastering.click();
                });
            }
            document.querySelectorAll('.quick-prompt-mastering').forEach(btn => {
                btn.addEventListener('click', function () {
                    const prompt = btn.getAttribute('data-prompt');
                    if (prompt && chatInputMastering) {
                        chatInputMastering.value = prompt;
                        if (chatSendMastering) chatSendMastering.click();
                    }
                });
            });
            if (btnDownloadMasteredFinal) {
                btnDownloadMasteredFinal.addEventListener('click', function () {
                    if (!state.masteredUrl) return;
                    if (isPreviewMode()) {
                        pendingDownload = { type: 'mastered' };
                        if (window.MegaMixAuth && window.MegaMixAuth.showLoginRequired) window.MegaMixAuth.showLoginRequired();
                        return;
                    }
                    openEmailModal('mastered');
                });
            }
        }
        updateMasteringProgress();
    }

    const btnSignin = document.getElementById('btn-signin');
    if (btnSignin) btnSignin.addEventListener('click', () => { /* Sign in opens login modal via auth overlay */ });

    const emailModalAppClose = document.getElementById('emailModalAppClose');
    const emailModalAppYes = document.getElementById('emailModalAppYes');
    const emailModalAppNo = document.getElementById('emailModalAppNo');
    if (emailModalAppClose) emailModalAppClose.addEventListener('click', function () { closeEmailModal(); pendingDownload = null; });
    if (emailModalAppYes) emailModalAppYes.addEventListener('click', function () { handleEmailSignup(true); });
    if (emailModalAppNo) emailModalAppNo.addEventListener('click', function () { handleEmailSignup(false); });
    if (emailModalApp) {
        emailModalApp.addEventListener('click', function (e) {
            if (e.target === emailModalApp) { closeEmailModal(); pendingDownload = null; }
        });
    }

    const contactModalApp = document.getElementById('contactModalApp');
    const contactFormApp = document.getElementById('contactFormApp');
    function openContactModalApp() {
        if (contactModalApp) {
            contactModalApp.classList.remove('hidden');
            document.body.style.overflow = 'hidden';
        }
    }
    function closeContactModalApp() {
        if (contactModalApp) {
            contactModalApp.classList.add('hidden');
            document.body.style.overflow = '';
            if (contactFormApp) contactFormApp.reset();
        }
    }
    const footerContact = document.getElementById('footer-contact');
    if (footerContact) footerContact.addEventListener('click', function (e) { e.preventDefault(); openContactModalApp(); });
    const contactModalAppClose = document.getElementById('contactModalAppClose');
    const contactModalAppCancel = document.getElementById('contactModalAppCancel');
    if (contactModalAppClose) contactModalAppClose.addEventListener('click', closeContactModalApp);
    if (contactModalAppCancel) contactModalAppCancel.addEventListener('click', closeContactModalApp);
    if (contactModalApp) {
        contactModalApp.addEventListener('click', function (e) {
            if (e.target === contactModalApp) closeContactModalApp();
        });
    }
    if (contactFormApp) {
        contactFormApp.addEventListener('submit', async function (e) {
            e.preventDefault();
            const name = document.getElementById('contactNameApp') && document.getElementById('contactNameApp').value.trim();
            const email = document.getElementById('contactEmailApp') && document.getElementById('contactEmailApp').value.trim();
            const subject = document.getElementById('contactSubjectApp') && document.getElementById('contactSubjectApp').value;
            const message = document.getElementById('contactMessageApp') && document.getElementById('contactMessageApp').value.trim();
            if (!name || !email || !subject || !message) {
                alert('Please fill in all fields.');
                return;
            }
            try {
                const response = await fetch('/contact-support', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, email, subject, message })
                });
                const result = await response.json();
                if (result.success) {
                    alert('Thank you for contacting us! We\'ll get back to you within 24 hours.');
                    closeContactModalApp();
                } else {
                    alert('Sorry, there was an error sending your message. Please try again or email us directly at support@megamixai.com');
                }
            } catch (err) {
                console.error('Contact form error:', err);
                alert('Sorry, there was an error sending your message. Please try again or email us directly at support@megamixai.com');
            }
        });
    }

    const newsletterSignupModalApp = document.getElementById('newsletterSignupModalApp');
    const newsletterEmailInputApp = document.getElementById('newsletterEmailInputApp');
    function openNewsletterSignupModal() {
        if (newsletterSignupModalApp) {
            newsletterSignupModalApp.classList.remove('hidden');
            if (newsletterEmailInputApp) newsletterEmailInputApp.value = '';
            document.body.style.overflow = 'hidden';
        }
    }
    function closeNewsletterSignupModal() {
        if (newsletterSignupModalApp) {
            newsletterSignupModalApp.classList.add('hidden');
            document.body.style.overflow = '';
        }
    }
    const footerNewsletter = document.getElementById('footer-newsletter');
    if (footerNewsletter) footerNewsletter.addEventListener('click', function (e) {
        e.preventDefault();
        openNewsletterSignupModal();
    });
    const newsletterSignupModalAppClose = document.getElementById('newsletterSignupModalAppClose');
    const newsletterSignupModalAppCancel = document.getElementById('newsletterSignupModalAppCancel');
    const newsletterSignupModalAppSubmit = document.getElementById('newsletterSignupModalAppSubmit');
    if (newsletterSignupModalAppClose) newsletterSignupModalAppClose.addEventListener('click', closeNewsletterSignupModal);
    if (newsletterSignupModalAppCancel) newsletterSignupModalAppCancel.addEventListener('click', closeNewsletterSignupModal);
    if (newsletterSignupModalApp) {
        newsletterSignupModalApp.addEventListener('click', function (e) {
            if (e.target === newsletterSignupModalApp) closeNewsletterSignupModal();
        });
    }
    if (newsletterSignupModalAppSubmit) newsletterSignupModalAppSubmit.addEventListener('click', async function () {
        const email = newsletterEmailInputApp ? newsletterEmailInputApp.value.trim() : '';
        if (!email || !isValidEmail(email)) {
            alert('Please enter a valid email address.');
            return;
        }
        try {
            const base = window.location.origin || '';
            const res = await fetch(base + '/mailchimp-signup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, format: 'web-newsletter', platform: 'web' })
            });
            const data = await res.json().catch(function () { return {}; });
            if (data.success) {
                alert('Thanks for signing up!');
            } else {
                console.warn('Newsletter signup', data.error || data);
                alert(data.error || 'Signup may have failed. Please try again.');
            }
        } catch (e) {
            console.warn('Newsletter signup', e);
            alert('Something went wrong. Please try again.');
        }
        closeNewsletterSignupModal();
    });

    window.addEventListener('megamix:logged-in', function () {
        performPendingDownload();
    });

    initPlaybackCard();
    updatePlaybackInstruction();
    if (chatMessages && typeof IntersectionObserver !== 'undefined') {
        const chatArea = chatMessages.closest('.chat-wrap') || chatMessages;
        const observer = new IntersectionObserver((entries) => {
            const entry = entries[0];
            if (!entry || !entry.isIntersecting) return;
            if (chatMessages.children.length === 0) {
                addChatMessage('bot', "Hi! I'm Josh, your AI mixing assistant. Just tell me what you want to achieve (like 'add punch' or 'smooth vocals') and I'll adjust the settings for you. I use your stems and your feedback to get the balance you want.");
            }
            observer.disconnect();
        }, { root: null, rootMargin: '0px', threshold: 0.1 });
        observer.observe(chatArea);
    } else if (chatMessages && chatMessages.children.length === 0) {
        addChatMessage('bot', "Hi! I'm Josh, your AI mixing assistant. Just tell me what you want to achieve (like 'add punch' or 'smooth vocals') and I'll adjust the settings for you. I use your stems and your feedback to get the balance you want.");
    }
})();
