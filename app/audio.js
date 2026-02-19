/**
 * MegaMix audio: encode/decode, mix build, mastering chain, live graph, transport.
 * Reads/writes MegaMix.state. No DOM. Attaches to window.MegaMix.
 */
(function () {
    'use strict';

    const state = window.MegaMix && window.MegaMix.state;
    if (!state) return;

    let buildAfterTimer = null;
    let buildAfterGen = 0;
    let liveGraph = null;
    let livePlaybackSources = [];
    let transportOffset = 0;
    let playbackStartTime = 0;
    let livePlaybackRaf = null;

    function getAudioContext() {
        if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        return state.audioCtx;
    }

    function revokeMixUrls() {
        if (state.mixedBeforeUrl) { URL.revokeObjectURL(state.mixedBeforeUrl); state.mixedBeforeUrl = null; }
        if (state.mixedAfterUrl) { URL.revokeObjectURL(state.mixedAfterUrl); state.mixedAfterUrl = null; }
    }
    function revokeMasteredUrl() {
        if (state.masteredUrl) { URL.revokeObjectURL(state.masteredUrl); state.masteredUrl = null; }
        if (state.unmasteredMixUrl) { URL.revokeObjectURL(state.unmasteredMixUrl); state.unmasteredMixUrl = null; }
    }

    function encodeWav(left, right, sampleRate) {
        const numChannels = 2;
        const numSamples = left.length;
        const buffer = new ArrayBuffer(44 + numSamples * numChannels * 2);
        const view = new DataView(buffer);
        const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
        writeStr(0, 'RIFF');
        view.setUint32(4, 36 + numSamples * numChannels * 2, true);
        writeStr(8, 'WAVE');
        writeStr(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * numChannels * 2, true);
        view.setUint16(32, numChannels * 2, true);
        view.setUint16(34, 16, true);
        writeStr(36, 'data');
        view.setUint32(40, numSamples * numChannels * 2, true);
        const offset = 44;
        for (let i = 0; i < numSamples; i++) {
            const l = Math.max(-1, Math.min(1, left[i]));
            const r = Math.max(-1, Math.min(1, right[i]));
            view.setInt16(offset + i * 4, l < 0 ? l * 0x8000 : l * 0x7FFF, true);
            view.setInt16(offset + i * 4 + 2, r < 0 ? r * 0x8000 : r * 0x7FFF, true);
        }
        return new Blob([buffer], { type: 'audio/wav' });
    }

    function panGain(pan) {
        const p = Math.max(-1, Math.min(1, pan));
        const left = Math.sqrt(0.5 - p / 2);
        const right = Math.sqrt(0.5 + p / 2);
        return { left, right };
    }

    /**
     * Algorithmic plate reverb (Schroeder/Freeverb-style): parallel comb filters + series allpass.
     * Avoids convolution mud; gives clear, smooth tail. Returns { input, output, updateParams }.
     */
    function createAlgorithmicPlate(ctx, sampleRate, decaySeconds, damping) {
        sampleRate = sampleRate || (ctx.sampleRate || 48000);
        decaySeconds = Math.max(0.2, Math.min(2, decaySeconds || 0.4));
        damping = Math.max(0, Math.min(1, damping !== undefined ? damping : 0.5));
        const sr = sampleRate;
        const scale = sr / 44100;
        const combDelaysMs = [1116, 1188, 1277, 1356].map(n => (n * scale) / sr);
        const allpassDelaysMs = [225, 556].map(n => (n * scale) / sr);
        const maxDelay = Math.max(...combDelaysMs, ...allpassDelaysMs) + 0.1;
        const combFeedback = Math.pow(10, -3 * (combDelaysMs[0]) / decaySeconds);
        const feedbackGain = Math.max(0.5, Math.min(0.92, combFeedback));
        const allpassG = 0.5;
        const lpFreq = 800 + damping * 6000;

        const input = ctx.createGain();
        input.gain.value = 1;
        const combsOut = ctx.createGain();
        combsOut.gain.value = 1;
        const combs = [];
        for (let c = 0; c < 4; c++) {
            const sum = ctx.createGain();
            sum.gain.value = 1;
            const delay = ctx.createDelay(maxDelay);
            delay.delayTime.value = combDelaysMs[c];
            const lowpass = ctx.createBiquadFilter();
            lowpass.type = 'lowpass';
            lowpass.frequency.value = lpFreq;
            lowpass.Q.value = 0.7;
            const fbGain = ctx.createGain();
            fbGain.gain.value = feedbackGain;
            input.connect(sum);
            delay.connect(lowpass);
            lowpass.connect(fbGain);
            fbGain.connect(sum);
            sum.connect(delay);
            delay.connect(combsOut);
            combs.push({ sum, delay, lowpass, fbGain });
        }
        let apInput = combsOut;
        const allpasses = [];
        for (let a = 0; a < 2; a++) {
            const sum = ctx.createGain();
            sum.gain.value = 1;
            const delay = ctx.createDelay(maxDelay);
            delay.delayTime.value = allpassDelaysMs[a];
            const gPos = ctx.createGain();
            gPos.gain.value = allpassG;
            const gNeg = ctx.createGain();
            gNeg.gain.value = -allpassG;
            const outSum = ctx.createGain();
            outSum.gain.value = 1;
            apInput.connect(sum);
            apInput.connect(gNeg);
            gNeg.connect(outSum);
            delay.connect(outSum);
            delay.connect(gPos);
            gPos.connect(sum);
            sum.connect(delay);
            allpasses.push({ sum, delay, gPos, gNeg, outSum });
            apInput = outSum;
        }
        const output = ctx.createGain();
        output.gain.value = 1;
        apInput.connect(output);

        function updateParams(decaySec, damp) {
            const d = Math.max(0.2, Math.min(2, decaySec || 0.4));
            const g = Math.max(0.5, Math.min(0.92, Math.pow(10, -3 * combDelaysMs[0] / d)));
            const freq = 800 + (damp !== undefined ? Math.max(0, Math.min(1, damp)) : damping) * 6000;
            combs.forEach(co => {
                co.fbGain.gain.setTargetAtTime(g, ctx.currentTime, 0.01);
                co.lowpass.frequency.setTargetAtTime(freq, ctx.currentTime, 0.01);
            });
        }

        return { input, output, updateParams, combs, allpasses };
    }

    const DECODE_PARALLEL = 6;

    async function decodeStemsToBuffers() {
        if (state.uploadedFiles.length === 0) { state.stemBuffers = []; state.trackAnalyses = []; return; }
        console.log('[MegaMix perf] decodeStemsToBuffers: start, files=' + state.uploadedFiles.length + ', parallel=' + DECODE_PARALLEL);
        const t0 = performance.now();
        const ctx = getAudioContext();
        const buffers = new Array(state.uploadedFiles.length);
        async function decodeOne(i) {
            const entry = state.uploadedFiles[i];
            const tFile = performance.now();
            const ab = await entry.file.arrayBuffer();
            const buf = await ctx.decodeAudioData(ab.slice(0));
            buffers[i] = buf;
            console.log('[MegaMix perf]   decode file ' + (i + 1) + '/' + state.uploadedFiles.length + ' "' + (entry.name || '') + '": ' + (performance.now() - tFile).toFixed(2) + ' ms');
        }
        for (let c = 0; c < state.uploadedFiles.length; c += DECODE_PARALLEL) {
            const chunk = [];
            for (let i = c; i < Math.min(c + DECODE_PARALLEL, state.uploadedFiles.length); i++) chunk.push(decodeOne(i));
            await Promise.all(chunk);
        }
        state.stemBuffers = buffers;
        analyzeStems();
        console.log('[MegaMix perf] decodeStemsToBuffers: total ' + (performance.now() - t0).toFixed(2) + ' ms');
    }

    /** ARA-style: analyze each stem for dynamics, loudest/softest blocks, and inferred role. Fills state.trackAnalyses. */
    function analyzeStems() {
        state.trackAnalyses = [];
        if (!state.stemBuffers.length || !state.uploadedFiles.length) return;
        const t0 = performance.now();
        const inferRole = window.MegaMix && window.MegaMix.inferRole;
        const total = state.stemBuffers.length;
        for (let i = 0; i < state.stemBuffers.length; i++) {
            const buf = state.stemBuffers[i];
            const entry = state.uploadedFiles[i];
            const ch0 = buf.getChannelData(0);
            const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
            const len = buf.length;
            const sr = buf.sampleRate;
            const blockSec = 0.2;
            const blockSamples = Math.max(1, Math.floor(sr * blockSec));
            const numBlocks = Math.max(1, Math.floor(len / blockSamples));
            const rmsOverTime = new Float32Array(numBlocks);
            let sumSqAll = 0;
            let peak = 0;
            let loudestIdx = 0;
            let softestIdx = 0;
            let minRms = Infinity;
            for (let b = 0; b < numBlocks; b++) {
                const start = b * blockSamples;
                const end = Math.min(start + blockSamples, len);
                let sumSq = 0;
                for (let j = start; j < end; j++) {
                    const s = (ch0[j] + ch1[j]) / 2;
                    const s2 = s * s;
                    sumSq += s2;
                    sumSqAll += s2;
                    if (Math.abs(s) > peak) peak = Math.abs(s);
                }
                const rms = Math.sqrt(sumSq / (end - start)) || 0;
                rmsOverTime[b] = rms;
                if (rms > rmsOverTime[loudestIdx]) loudestIdx = b;
                if (rms < minRms) { minRms = rms; softestIdx = b; }
            }
            const rmsAll = Math.sqrt(sumSqAll / len) || 1e-6;
            const peakDb = 20 * Math.log10(peak || 1e-6);
            const rmsDb = 20 * Math.log10(rmsAll);
            state.trackAnalyses.push({
                duration: len / sr,
                sampleRate: sr,
                numberOfChannels: buf.numberOfChannels,
                rmsOverTime,
                peakDb,
                rmsDb,
                loudestBlockIndex: loudestIdx,
                softestBlockIndex: softestIdx,
                inferredRole: inferRole ? inferRole(entry.name, i, total) : 'other'
            });
        }
        console.log('[MegaMix perf] analyzeStems: ' + (performance.now() - t0).toFixed(2) + ' ms (stems=' + state.stemBuffers.length + ')');
    }

    function buildMixedBuffer(useBefore) {
        if (state.stemBuffers.length === 0) return null;
        const t0 = performance.now();
        let maxLen = 0;
        let sampleRate = state.stemBuffers[0].sampleRate;
        for (const b of state.stemBuffers) {
            if (b.length > maxLen) maxLen = b.length;
        }
        const left = new Float32Array(maxLen);
        const right = new Float32Array(maxLen);
        const tracks = state.tracks;
        for (let ti = 0; ti < state.stemBuffers.length; ti++) {
            const buf = state.stemBuffers[ti];
            const numCh = buf.numberOfChannels;
            const ch0 = buf.getChannelData(0);
            const ch1 = numCh > 1 ? buf.getChannelData(1) : ch0;
            const gain = useBefore ? 1 : (tracks[ti] ? tracks[ti].gain : 1);
            const pan = useBefore ? 0 : (tracks[ti] ? tracks[ti].pan : 0);
            const { left: gL, right: gR } = panGain(pan);
            const volL = gain * gL;
            const volR = gain * gR;
            for (let i = 0; i < buf.length; i++) {
                left[i] += (ch0[i] * volL);
                right[i] += (ch1[i] * volR);
            }
        }
        let peak = 0;
        for (let i = 0; i < maxLen; i++) {
            peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
        }
        if (peak > 0.99) {
            const scale = 0.99 / peak;
            for (let i = 0; i < maxLen; i++) {
                left[i] *= scale;
                right[i] *= scale;
            }
        }
        console.log('[MegaMix perf] buildMixedBuffer(' + (useBefore ? 'before' : 'after') + '): ' + (performance.now() - t0).toFixed(2) + ' ms (len=' + maxLen + ')');
        return { left, right, sampleRate, length: maxLen };
    }

    async function renderOneTrackWithFX(ti, maxLen, sampleRate) {
        const interpolateAutomation = window.MegaMix.interpolateAutomation;
        const buf = state.stemBuffers[ti];
        const track = state.tracks[ti];
        const ctx = new OfflineAudioContext({ length: maxLen, numberOfChannels: 2, sampleRate });
        const src = ctx.createBufferSource();
        src.buffer = buf;
        let last = src;

        if (track && track.eqOn && track.eqParams) {
            const eq = track.eqParams;
            const lowShelf = ctx.createBiquadFilter();
            lowShelf.type = 'lowshelf';
            lowShelf.frequency.value = 320;
            lowShelf.gain.value = typeof eq.low === 'number' ? eq.low : 0;
            const midPeak = ctx.createBiquadFilter();
            midPeak.type = 'peaking';
            midPeak.frequency.value = 1000;
            midPeak.Q.value = 1;
            midPeak.gain.value = typeof eq.mid === 'number' ? eq.mid : 0;
            const highShelf = ctx.createBiquadFilter();
            highShelf.type = 'highshelf';
            highShelf.frequency.value = 3200;
            highShelf.gain.value = typeof eq.high === 'number' ? eq.high : 0;
            last.connect(lowShelf);
            lowShelf.connect(midPeak);
            midPeak.connect(highShelf);
            last = highShelf;
        }

        if (track && track.compOn && track.compParams) {
            const c = track.compParams;
            const comp = ctx.createDynamicsCompressor();
            comp.threshold.value = typeof c.threshold === 'number' ? c.threshold : -20;
            comp.knee.value = typeof c.knee === 'number' ? c.knee : 6;
            comp.ratio.value = typeof c.ratio === 'number' ? c.ratio : 2;
            comp.attack.value = typeof c.attack === 'number' ? c.attack : 0.003;
            comp.release.value = typeof c.release === 'number' ? c.release : 0.25;
            last.connect(comp);
            last = comp;
        }

        if (track && track.reverbOn) {
            const rp = track.reverbParams || { mix: 0.25, decaySeconds: 0.4 };
            const mix = typeof rp.mix === 'number' ? Math.max(0, Math.min(1, rp.mix)) : 0.25;
            const decaySeconds = typeof rp.decaySeconds === 'number' ? rp.decaySeconds : 0.4;
            const dryGain = ctx.createGain();
            dryGain.gain.value = 1;
            const wetAmount = mix * 0.5;
            const wetGain = ctx.createGain();
            wetGain.gain.value = wetAmount;
            const plate = createAlgorithmicPlate(ctx, ctx.sampleRate, decaySeconds, 0.5);
            const sumGain = ctx.createGain();
            sumGain.gain.value = 1 / (1 + wetAmount);
            last.connect(dryGain);
            last.connect(plate.input);
            plate.output.connect(wetGain);
            dryGain.connect(sumGain);
            wetGain.connect(sumGain);
            last = sumGain;
        }

        const gainNode = ctx.createGain();
        gainNode.gain.value = 1;
        last.connect(gainNode);
        const panner = ctx.createStereoPanner();
        panner.pan.value = 0;
        gainNode.connect(panner);
        panner.connect(ctx.destination);

        src.start(0);
        const rendered = await ctx.startRendering();
        const ch0 = rendered.getChannelData(0);
        const ch1 = rendered.getChannelData(1);

        const levelPoints = (track && track.automation && track.automation.level && track.automation.level.length) ? track.automation.level : [{ t: 0, value: track ? track.gain : 1 }, { t: 1, value: track ? track.gain : 1 }];
        const panPoints = (track && track.automation && track.automation.pan && track.automation.pan.length) ? track.automation.pan : [{ t: 0, value: track ? track.pan : 0 }, { t: 1, value: track ? track.pan : 0 }];

        const leftContrib = new Float32Array(maxLen);
        const rightContrib = new Float32Array(maxLen);
        for (let i = 0; i < maxLen; i++) {
            const t = i / maxLen;
            const g = interpolateAutomation(levelPoints, t);
            const p = interpolateAutomation(panPoints, t);
            const { left: gL, right: gR } = panGain(p);
            const volL = g * gL;
            const volR = g * gR;
            leftContrib[i] = ch0[i] * volL + ch1[i] * volL;
            rightContrib[i] = ch0[i] * volR + ch1[i] * volR;
        }
        return { leftContrib, rightContrib };
    }

    /** Single OfflineAudioContext render: all tracks in one pass (much faster than 23 separate renders). */
    async function buildAfterMixWithFX() {
        if (state.stemBuffers.length === 0) return null;
        const myGen = ++buildAfterGen;
        const t0 = performance.now();
        console.log('[MegaMix perf] buildAfterMixWithFX: start (tracks=' + state.stemBuffers.length + ', gen=' + myGen + ')');
        let maxLen = 0;
        const sampleRate = state.stemBuffers[0].sampleRate;
        for (const b of state.stemBuffers) {
            if (b.length > maxLen) maxLen = b.length;
        }
        const durationSec = maxLen / sampleRate;
        const ctx = new OfflineAudioContext({ length: maxLen, numberOfChannels: 2, sampleRate });
        const anySolo = state.tracks.some(t => t.solo);

        for (let ti = 0; ti < state.stemBuffers.length; ti++) {
            if (myGen !== buildAfterGen) {
                console.log('[MegaMix perf] buildAfterMixWithFX: cancelled (gen ' + myGen + ')');
                return null;
            }
            const buf = state.stemBuffers[ti];
            const track = state.tracks[ti];
            const src = ctx.createBufferSource();
            src.buffer = buf;
            let last = src;

            if (track && track.eqOn && track.eqParams) {
                const eq = track.eqParams;
                const lowShelf = ctx.createBiquadFilter();
                lowShelf.type = 'lowshelf';
                lowShelf.frequency.value = 320;
                lowShelf.gain.value = typeof eq.low === 'number' ? eq.low : 0;
                const midPeak = ctx.createBiquadFilter();
                midPeak.type = 'peaking';
                midPeak.frequency.value = 1000;
                midPeak.Q.value = 1;
                midPeak.gain.value = typeof eq.mid === 'number' ? eq.mid : 0;
                const highShelf = ctx.createBiquadFilter();
                highShelf.type = 'highshelf';
                highShelf.frequency.value = 3200;
                highShelf.gain.value = typeof eq.high === 'number' ? eq.high : 0;
                last.connect(lowShelf);
                lowShelf.connect(midPeak);
                midPeak.connect(highShelf);
                last = highShelf;
            }
            if (track && track.compOn && track.compParams) {
                const c = track.compParams;
                const comp = ctx.createDynamicsCompressor();
                comp.threshold.value = typeof c.threshold === 'number' ? c.threshold : -20;
                comp.knee.value = typeof c.knee === 'number' ? c.knee : 6;
                comp.ratio.value = typeof c.ratio === 'number' ? c.ratio : 2;
                comp.attack.value = typeof c.attack === 'number' ? c.attack : 0.003;
                comp.release.value = typeof c.release === 'number' ? c.release : 0.25;
                last.connect(comp);
                last = comp;
            }
            if (track && track.reverbOn) {
                const rp = track.reverbParams || { mix: 0.25, decaySeconds: 0.4 };
                const mix = typeof rp.mix === 'number' ? Math.max(0, Math.min(1, rp.mix)) : 0.25;
                const decaySeconds = typeof rp.decaySeconds === 'number' ? rp.decaySeconds : 0.4;
                const dryGain = ctx.createGain();
                dryGain.gain.value = 1;
                const wetAmount = mix * 0.5;
                const wetGain = ctx.createGain();
                wetGain.gain.value = wetAmount;
                const plate = createAlgorithmicPlate(ctx, ctx.sampleRate, decaySeconds, 0.5);
                const sumGain = ctx.createGain();
                sumGain.gain.value = 1 / (1 + wetAmount);
                last.connect(dryGain);
                last.connect(plate.input);
                plate.output.connect(wetGain);
                dryGain.connect(sumGain);
                wetGain.connect(sumGain);
                last = sumGain;
            }
            const gainNode = ctx.createGain();
            const panner = ctx.createStereoPanner();
            last.connect(gainNode);
            gainNode.connect(panner);
            panner.connect(ctx.destination);

            const levelPoints = (track && track.automation && track.automation.level && track.automation.level.length) ? track.automation.level : [{ t: 0, value: track ? track.gain : 1 }, { t: 1, value: track ? track.gain : 1 }];
            const panPoints = (track && track.automation && track.automation.pan && track.automation.pan.length) ? track.automation.pan : [{ t: 0, value: track ? track.pan : 0 }, { t: 1, value: track ? track.pan : 0 }];
            const muteSoloMult = (track && track.mute) ? 0 : (anySolo ? (track && track.solo ? 1 : 0) : 1);
            gainNode.gain.setValueAtTime(levelPoints[0].value * muteSoloMult, 0);
            for (let i = 1; i < levelPoints.length; i++) {
                gainNode.gain.linearRampToValueAtTime(levelPoints[i].value * muteSoloMult, levelPoints[i].t * durationSec);
            }
            panner.pan.setValueAtTime(Math.max(-1, Math.min(1, panPoints[0].value)), 0);
            for (let i = 1; i < panPoints.length; i++) {
                panner.pan.linearRampToValueAtTime(Math.max(-1, Math.min(1, panPoints[i].value)), panPoints[i].t * durationSec);
            }
            src.start(0);
        }

        if (myGen !== buildAfterGen) return null;
        const rendered = await ctx.startRendering();
        if (myGen !== buildAfterGen) return null;
        const left = rendered.getChannelData(0);
        const right = rendered.getChannelData(1);
        let peak = 0;
        for (let i = 0; i < maxLen; i++) {
            peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
        }
        if (peak > 0.99) {
            const scale = 0.99 / peak;
            for (let i = 0; i < maxLen; i++) {
                left[i] *= scale;
                right[i] *= scale;
            }
        }
        console.log('[MegaMix perf] buildAfterMixWithFX: total ' + (performance.now() - t0).toFixed(2) + ' ms');
        return { left, right, sampleRate, length: maxLen };
    }

    /** Master the mix: compression (punch/compression opts) then peak-normalize to max loudness without clipping. */
    async function runMasteringChain(mix, options) {
        if (!mix || !mix.left || !mix.right) return null;
        const t0 = performance.now();
        console.log('[MegaMix perf] runMasteringChain: start (samples=' + (mix.left && mix.left.length) + ')');
        const opts = options || {};
        const punch = Math.max(0, Math.min(2, Number(opts.punch) || 0));
        const loudness = Math.max(0, Math.min(2, Number(opts.loudness) || 0));
        const compression = Math.max(0, Math.min(2, Number(opts.compression) !== undefined ? opts.compression : 1));
        const len = mix.left.length;
        const sr = mix.sampleRate;
        const ctx = new OfflineAudioContext({ length: len, numberOfChannels: 2, sampleRate: sr });
        const buffer = ctx.createBuffer(2, len, sr);
        buffer.copyToChannel(mix.left, 0);
        buffer.copyToChannel(mix.right, 1);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        const comp = ctx.createDynamicsCompressor();
        const thr = compression === 0 ? -12 : compression === 2 ? -24 : -18;
        const ratio = compression === 0 ? 1.5 : compression === 2 ? 4 : 2.5;
        comp.threshold.value = thr;
        comp.knee.value = 6;
        comp.ratio.value = ratio;
        comp.attack.value = punch === 0 ? 0.01 : punch === 1 ? 0.005 : 0.003;
        comp.release.value = punch === 0 ? 0.2 : punch === 1 ? 0.15 : 0.1;
        src.connect(comp);
        comp.connect(ctx.destination);
        src.start(0);
        const rendered = await ctx.startRendering();
        console.log('[MegaMix perf] runMasteringChain: OfflineAudioContext.startRendering ' + (performance.now() - t0).toFixed(2) + ' ms');
        const left = rendered.getChannelData(0);
        const right = rendered.getChannelData(1);
        let peak = 0;
        for (let i = 0; i < len; i++) {
            peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
        }
        // Primary goal: as loud as possible without clipping. Target just under full scale for safety.
        const targetPeak = 0.99;
        const scale = peak > 0 ? targetPeak / peak : 1;
        for (let i = 0; i < len; i++) {
            left[i] = Math.max(-1, Math.min(1, left[i] * scale));
            right[i] = Math.max(-1, Math.min(1, right[i] * scale));
        }
        console.log('[MegaMix perf] runMasteringChain: total ' + (performance.now() - t0).toFixed(2) + ' ms');
        return { left, right, sampleRate: sr, length: len };
    }

    function getTransportDuration() {
        if (state.stemBuffers.length === 0) return 0;
        let maxLen = 0;
        const sr = state.stemBuffers[0].sampleRate;
        for (const b of state.stemBuffers) if (b.length > maxLen) maxLen = b.length;
        return maxLen / sr;
    }

    function scheduleBuildAfter() {
        if (buildAfterTimer) clearTimeout(buildAfterTimer);
        buildAfterTimer = setTimeout(() => {
            buildAfterTimer = null;
            buildAfterOnly().then(() => {
                if (window.MegaMix.syncAllTracksToLiveGraph) window.MegaMix.syncAllTracksToLiveGraph();
                if (typeof window.MegaMix.onAfterMixBuilt === 'function') window.MegaMix.onAfterMixBuilt();
            });
        }, 1000);
    }

    async function buildAfterOnly() {
        if (state.stemBuffers.length === 0 || state.uploadedFiles.length === 0) return;
        const t0 = performance.now();
        console.log('[MegaMix perf] buildAfterOnly: start');
        try {
            const afterMix = await buildAfterMixWithFX();
            if (afterMix) {
                const tEncode = performance.now();
                if (state.mixedAfterUrl) URL.revokeObjectURL(state.mixedAfterUrl);
                state.mixedAfterUrl = URL.createObjectURL(encodeWav(afterMix.left, afterMix.right, afterMix.sampleRate));
                console.log('[MegaMix perf] buildAfterOnly: encodeWav + createObjectURL ' + (performance.now() - tEncode).toFixed(2) + ' ms');
            }
            console.log('[MegaMix perf] buildAfterOnly: total ' + (performance.now() - t0).toFixed(2) + ' ms');
        } catch (e) {
            console.error('buildAfterOnly', e);
        }
    }

    function createLiveGraph() {
        if (state.stemBuffers.length === 0 || !state.tracks.length) return;
        const t0 = performance.now();
        console.log('[MegaMix perf] createLiveGraph: start (tracks=' + state.tracks.length + ')');
        const ctx = getAudioContext();
        if (liveGraph) {
            try {
                if (liveGraph.masterGain) liveGraph.masterGain.disconnect();
            } catch (_) {}
        }
        liveGraph = { ctx, masterGain: ctx.createGain(), tracks: [] };
        liveGraph.masterGain.connect(ctx.destination);
        const tracks = state.tracks;
        for (let i = 0; i < tracks.length; i++) {
            const gainNode = ctx.createGain();
            const panner = ctx.createStereoPanner();
            const lowShelf = ctx.createBiquadFilter();
            lowShelf.type = 'lowshelf';
            lowShelf.frequency.value = 320;
            const midPeak = ctx.createBiquadFilter();
            midPeak.type = 'peaking';
            midPeak.frequency.value = 1000;
            midPeak.Q.value = 1;
            const highShelf = ctx.createBiquadFilter();
            highShelf.type = 'highshelf';
            highShelf.frequency.value = 3200;
            const comp = ctx.createDynamicsCompressor();
            const reverbDryGain = ctx.createGain();
            const reverbWetGain = ctx.createGain();
            const track = tracks[i];
            const rp0 = track && track.reverbParams ? track.reverbParams : { mix: 0.25, decaySeconds: 0.4 };
            const plate = createAlgorithmicPlate(ctx, ctx.sampleRate, rp0.decaySeconds, 0.5);
            const reverbSumGain = ctx.createGain();
            reverbSumGain.gain.value = 1;
            gainNode.connect(panner);
            panner.connect(lowShelf);
            lowShelf.connect(midPeak);
            midPeak.connect(highShelf);
            highShelf.connect(comp);
            comp.connect(reverbDryGain);
            comp.connect(plate.input);
            plate.output.connect(reverbWetGain);
            reverbDryGain.connect(reverbSumGain);
            reverbWetGain.connect(reverbSumGain);
            reverbSumGain.connect(liveGraph.masterGain);
            liveGraph.tracks.push({ gainNode, pannerNode: panner, lowShelf, midPeak, highShelf, compNode: comp, reverbDryGain, reverbWetGain, reverbSumGain, reverbPlate: plate });
        }
        console.log('[MegaMix perf] createLiveGraph: ' + (performance.now() - t0).toFixed(2) + ' ms');
        if (window.MegaMix.syncAllTracksToLiveGraph) window.MegaMix.syncAllTracksToLiveGraph();
    }

    function syncTrackToLiveGraph(i) {
        if (!liveGraph || i < 0 || i >= liveGraph.tracks.length || i >= state.tracks.length) return;
        const track = state.tracks[i];
        const chain = liveGraph.tracks[i];
        const anySolo = state.tracks.some(t => t.solo);
        const effectiveGain = track.mute ? 0 : (anySolo ? (track.solo ? track.gain : 0) : track.gain);
        chain.gainNode.gain.setTargetAtTime(effectiveGain, liveGraph.ctx.currentTime, 0.01);
        chain.pannerNode.pan.setTargetAtTime(Math.max(-1, Math.min(1, track.pan)), liveGraph.ctx.currentTime, 0.01);
        const eq = track.eqParams || { low: 0, mid: 0, high: 0 };
        chain.lowShelf.gain.setTargetAtTime(track.eqOn ? (eq.low || 0) : 0, liveGraph.ctx.currentTime, 0.01);
        chain.midPeak.gain.setTargetAtTime(track.eqOn ? (eq.mid || 0) : 0, liveGraph.ctx.currentTime, 0.01);
        chain.highShelf.gain.setTargetAtTime(track.eqOn ? (eq.high || 0) : 0, liveGraph.ctx.currentTime, 0.01);
        const c = track.compParams || {};
        if (track.compOn) {
            chain.compNode.threshold.setTargetAtTime(c.threshold !== undefined ? c.threshold : -20, liveGraph.ctx.currentTime, 0.01);
            chain.compNode.ratio.setTargetAtTime(c.ratio !== undefined ? c.ratio : 2, liveGraph.ctx.currentTime, 0.01);
            chain.compNode.attack.setTargetAtTime(c.attack !== undefined ? c.attack : 0.003, liveGraph.ctx.currentTime, 0.01);
            chain.compNode.release.setTargetAtTime(c.release !== undefined ? c.release : 0.25, liveGraph.ctx.currentTime, 0.01);
            chain.compNode.knee.setTargetAtTime(c.knee !== undefined ? c.knee : 6, liveGraph.ctx.currentTime, 0.01);
        } else {
            chain.compNode.ratio.setTargetAtTime(1, liveGraph.ctx.currentTime, 0.01);
            chain.compNode.threshold.setTargetAtTime(0, liveGraph.ctx.currentTime, 0.01);
        }
        const rp = track.reverbParams || { mix: 0.25, decaySeconds: 0.4 };
        const revMix = track.reverbOn ? (typeof rp.mix === 'number' ? Math.max(0, Math.min(1, rp.mix)) : 0.25) : 0;
        if (chain.reverbPlate && chain.reverbPlate.updateParams) {
            chain.reverbPlate.updateParams(rp.decaySeconds, 0.5);
        }
        chain.reverbDryGain.gain.setTargetAtTime(1, liveGraph.ctx.currentTime, 0.01);
        const wetAmount = revMix * 0.5;
        chain.reverbWetGain.gain.setTargetAtTime(wetAmount, liveGraph.ctx.currentTime, 0.01);
        chain.reverbSumGain.gain.setTargetAtTime(1 / (1 + wetAmount), liveGraph.ctx.currentTime, 0.01);
    }

    function syncAllTracksToLiveGraph() {
        if (!liveGraph) return;
        const t0 = performance.now();
        for (let i = 0; i < liveGraph.tracks.length && i < state.tracks.length; i++) syncTrackToLiveGraph(i);
        console.log('[MegaMix perf] syncAllTracksToLiveGraph: ' + (performance.now() - t0).toFixed(2) + ' ms (tracks=' + liveGraph.tracks.length + ')');
    }

    function stopLivePlayback() {
        livePlaybackSources.forEach(s => {
            try { s.stop(); } catch (_) {}
        });
        livePlaybackSources = [];
        transportOffset = 0;
        if (livePlaybackRaf) {
            cancelAnimationFrame(livePlaybackRaf);
            livePlaybackRaf = null;
        }
    }

    function startLivePlayback(offset) {
        if (!liveGraph || state.stemBuffers.length === 0) return;
        stopLivePlayback();
        const ctx = liveGraph.ctx;
        const duration = getTransportDuration();
        const safeOffset = Math.max(0, Math.min(offset, duration - 0.01));
        for (let i = 0; i < state.stemBuffers.length && i < liveGraph.tracks.length; i++) {
            const src = ctx.createBufferSource();
            src.buffer = state.stemBuffers[i];
            src.connect(liveGraph.tracks[i].gainNode);
            src.start(ctx.currentTime, safeOffset);
            livePlaybackSources.push(src);
        }
        playbackStartTime = ctx.currentTime;
        transportOffset = safeOffset;
    }

    /** Current playback position in seconds for the After timeline (live or seek). Used so Josh and UI share the same reference. */
    function getCurrentPlaybackPosition() {
        if (!liveGraph) return transportOffset;
        if (livePlaybackSources.length > 0) {
            const elapsed = liveGraph.ctx.currentTime - playbackStartTime;
            return transportOffset + elapsed;
        }
        return transportOffset;
    }

    window.MegaMix.getAudioContext = getAudioContext;
    window.MegaMix.encodeWav = encodeWav;
    window.MegaMix.panGain = panGain;
    window.MegaMix.revokeMixUrls = revokeMixUrls;
    window.MegaMix.revokeMasteredUrl = revokeMasteredUrl;
    window.MegaMix.decodeStemsToBuffers = decodeStemsToBuffers;
    window.MegaMix.analyzeStems = analyzeStems;
    window.MegaMix.buildMixedBuffer = buildMixedBuffer;
    window.MegaMix.buildAfterMixWithFX = buildAfterMixWithFX;
    window.MegaMix.runMasteringChain = runMasteringChain;
    window.MegaMix.getTransportDuration = getTransportDuration;
    window.MegaMix.scheduleBuildAfter = scheduleBuildAfter;
    window.MegaMix.buildAfterOnly = buildAfterOnly;
    window.MegaMix.createLiveGraph = createLiveGraph;
    window.MegaMix.syncTrackToLiveGraph = syncTrackToLiveGraph;
    window.MegaMix.syncAllTracksToLiveGraph = syncAllTracksToLiveGraph;
    window.MegaMix.startLivePlayback = startLivePlayback;
    window.MegaMix.stopLivePlayback = stopLivePlayback;
    window.MegaMix.liveGraph = function () { return liveGraph; };
    window.MegaMix.livePlaybackSources = function () { return livePlaybackSources; };
    window.MegaMix.transportOffset = function () { return transportOffset; };
    window.MegaMix.playbackStartTime = function () { return playbackStartTime; };
    window.MegaMix.livePlaybackRaf = function () { return livePlaybackRaf; };
    window.MegaMix.setLivePlaybackRaf = function (v) { livePlaybackRaf = v; };
    window.MegaMix.setTransportOffset = function (v) { transportOffset = v; };
    window.MegaMix.getCurrentPlaybackPosition = getCurrentPlaybackPosition;
})();
