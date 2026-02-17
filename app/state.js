/**
 * MegaMix state and model logic (undo/redo snapshot, genre, Josh chat).
 * No DOM; no audio. Attaches to window.MegaMix.
 *
 * Josh (web app): Interpretation is aligned with the MegaMix AI plugin's Josh so user
 * phrases are understood the same way (balance first, track roles, punch/bright/warm etc.).
 * In the web app Josh has full control over the session: all stems, random access, seek,
 * and per-track level, pan, EQ, and compression. Same persona as plugin Josh; more control.
 */
(function () {
    'use strict';

    const MAX_FILES = 32;
    const PRESET_STORAGE_KEY = 'megamix_mixer_presets';

    function defaultTrack(name) {
        return {
            name,
            gain: 1,
            pan: 0,
            eqOn: false,
            compOn: false,
            eqParams: { low: 0, mid: 0, high: 0 },
            compParams: { threshold: -20, ratio: 2, attack: 0.003, release: 0.25, knee: 6 },
            reverbOn: false,
            retroOn: false,
            reverbParams: { mix: 0.25, decaySeconds: 0.4 },
            automation: {
                level: [{ t: 0, value: 1 }, { t: 1, value: 1 }],
                pan: [{ t: 0, value: 0 }, { t: 1, value: 0 }]
            }
        };
    }

    function interpolateAutomation(breakpoints, t) {
        if (!breakpoints || breakpoints.length === 0) return 0;
        const sorted = [...breakpoints].sort((a, b) => a.t - b.t);
        if (t <= sorted[0].t) return sorted[0].value;
        if (t >= sorted[sorted.length - 1].t) return sorted[sorted.length - 1].value;
        for (let i = 0; i < sorted.length - 1; i++) {
            if (t >= sorted[i].t && t <= sorted[i + 1].t) {
                const a = sorted[i];
                const b = sorted[i + 1];
                const frac = (t - a.t) / (b.t - a.t);
                return a.value + frac * (b.value - a.value);
            }
        }
        return sorted[sorted.length - 1].value;
    }

    const state = {
        uploadedFiles: [],
        tracks: [],
        stemBuffers: [],
        /** ARA-style: one entry per stem after analyzeStems(). Shape: { duration, sampleRate, numberOfChannels, rmsOverTime, peakDb, rmsDb, loudestBlockIndex, softestBlockIndex, inferredRole } */
        trackAnalyses: [],
        audioCtx: null,
        mixedBeforeUrl: null,
        mixedAfterUrl: null,
        mixBuildPromise: null,
        undoStack: [],
        redoStack: [],
        fileListVisible: true,
        mixReady: false,
        hasInitialMix: false,
        masteredUrl: null
    };

    /** Snapshot for undo: deep clone of tracks. */
    function snapshotMixerState() {
        return JSON.parse(JSON.stringify(state.tracks));
    }

    /** Restore from snapshot: only updates state.tracks and normalizes length. Caller must call renderMixerStrips, syncAllTracksToLiveGraph, scheduleBuildAfter. */
    function restoreMixerState(snapshot) {
        const arr = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
        if (!Array.isArray(arr)) return;
        state.tracks.length = 0;
        for (let j = 0; j < arr.length; j++) state.tracks.push(arr[j]);
        while (state.tracks.length > state.uploadedFiles.length) state.tracks.pop();
        while (state.tracks.length < state.uploadedFiles.length) state.tracks.push(defaultTrack(state.uploadedFiles[state.tracks.length].name));
    }

    function dbToGain(db) { return Math.pow(10, db / 20); }

    function inferRole(name, index, total) {
        const n = (name || '').toLowerCase();
        if (/\bkick|kickdrum|bd\b/.test(n)) return 'kick';
        if (/\bsnare|snr\b/.test(n)) return 'snare';
        if (/\bbass\b/.test(n)) return 'bass';
        if (/\bvocal|voc|lead\s*vox|singer|main\s*vocal\b/.test(n)) return 'leadVocal';
        if (/\bbacking|bv|harmony|double|ad.?lib\b/.test(n)) return 'backingVocal';
        if (/\bguitar|gtr|rhythm|solo\b/.test(n)) return 'guitar';
        if (/\boverhead|oh\b|room|cymbals|ride|hats?|hi.?hat\b/.test(n)) return 'overhead';
        if (/\btom|floor\b/.test(n)) return 'tom';
        if (/\bkeys?|piano|rhodes|synth|pad|pluck|arp\b/.test(n)) return 'keys';
        if (/\bdrums?|perc\b/.test(n) && !/kick|snare|overhead|tom|hats|ride/.test(n)) return 'drums';
        if (total <= 8) {
            if (index === 0) return 'kick';
            if (index === 1) return 'snare';
            if (index === 2) return 'bass';
            if (index === 3) return 'leadVocal';
        }
        return 'other';
    }

    const GENRE_BALANCE = {
        rock:     { kick: { db: 2, pan: 0 }, snare: { db: 4, pan: 0 }, bass: { db: 1, pan: 0 }, leadVocal: { db: 2.5, pan: 0 }, backingVocal: { db: -1, pan: 0.5 }, guitar: { db: 0, pan: -0.55 }, overhead: { db: -6, pan: 0.75 }, tom: { db: -2, pan: 0.35 }, keys: { db: -2, pan: 0 }, drums: { db: -1, pan: 0 }, other: { db: -1, pan: 0 } },
        metal:    { kick: { db: 2.5, pan: 0 }, snare: { db: 4, pan: 0 }, bass: { db: 1, pan: 0 }, leadVocal: { db: 2, pan: 0 }, backingVocal: { db: -1.5, pan: 0.5 }, guitar: { db: 0.5, pan: -0.6 }, overhead: { db: -7, pan: 0.8 }, tom: { db: -1, pan: 0.4 }, keys: { db: -2, pan: 0 }, drums: { db: -1, pan: 0 }, other: { db: -1, pan: 0 } },
        hiphop:   { kick: { db: 2, pan: 0 }, snare: { db: 2.5, pan: 0 }, bass: { db: 1.5, pan: 0 }, leadVocal: { db: 3, pan: 0 }, backingVocal: { db: 0, pan: 0.45 }, guitar: { db: -2, pan: 0.3 }, overhead: { db: -4, pan: 0.5 }, tom: { db: -2, pan: 0.3 }, keys: { db: -1, pan: 0 }, drums: { db: -1, pan: 0 }, other: { db: -1, pan: 0 } },
        pop:      { kick: { db: 1, pan: 0 }, snare: { db: 2, pan: 0 }, bass: { db: 0.5, pan: 0 }, leadVocal: { db: 3.5, pan: 0 }, backingVocal: { db: 0, pan: 0.4 }, guitar: { db: -1, pan: -0.4 }, overhead: { db: -5, pan: 0.6 }, tom: { db: -2, pan: 0.25 }, keys: { db: -1, pan: 0 }, drums: { db: -1, pan: 0 }, other: { db: -1, pan: 0 } },
        edm:      { kick: { db: 2.5, pan: 0 }, snare: { db: 1.5, pan: 0 }, bass: { db: 2, pan: 0 }, leadVocal: { db: 2, pan: 0 }, backingVocal: { db: -1, pan: 0.6 }, guitar: { db: -2, pan: 0.4 }, overhead: { db: -4, pan: 0.7 }, tom: { db: -2, pan: 0.3 }, keys: { db: 0, pan: 0.5 }, drums: { db: -1, pan: 0 }, other: { db: -1, pan: 0.3 } },
        rnb:      { kick: { db: 1.5, pan: 0 }, snare: { db: 2, pan: 0 }, bass: { db: 2, pan: 0 }, leadVocal: { db: 3, pan: 0 }, backingVocal: { db: 0, pan: 0.5 }, guitar: { db: -2, pan: 0.35 }, overhead: { db: -5, pan: 0.5 }, tom: { db: -2, pan: 0.2 }, keys: { db: -0.5, pan: 0 }, drums: { db: -1, pan: 0 }, other: { db: -1, pan: 0 } },
        jazz:     { kick: { db: 0, pan: 0 }, snare: { db: 1, pan: 0 }, bass: { db: 1, pan: 0 }, leadVocal: { db: 1.5, pan: 0 }, backingVocal: { db: -1, pan: 0.4 }, guitar: { db: 0, pan: -0.3 }, overhead: { db: -2, pan: 0.7 }, tom: { db: 0, pan: 0.3 }, keys: { db: 0, pan: 0 }, drums: { db: -0.5, pan: 0 }, other: { db: -0.5, pan: 0 } },
        funk:     { kick: { db: 2, pan: 0 }, snare: { db: 2.5, pan: 0 }, bass: { db: 2, pan: 0 }, leadVocal: { db: 2, pan: 0 }, backingVocal: { db: -0.5, pan: 0.45 }, guitar: { db: 0, pan: -0.4 }, overhead: { db: -4, pan: 0.6 }, tom: { db: -1, pan: 0.35 }, keys: { db: 0, pan: 0.2 }, drums: { db: -1, pan: 0 }, other: { db: -1, pan: 0 } },
        country:  { kick: { db: 1.5, pan: 0 }, snare: { db: 2, pan: 0 }, bass: { db: 1, pan: 0 }, leadVocal: { db: 2.5, pan: 0 }, backingVocal: { db: 0, pan: 0.4 }, guitar: { db: 0, pan: -0.5 }, overhead: { db: -5, pan: 0.65 }, tom: { db: -1, pan: 0.3 }, keys: { db: -1, pan: 0 }, drums: { db: -1, pan: 0 }, other: { db: -1, pan: 0 } },
        custom:   null
    };

    function applyJoshResponse(tracksArr, response) {
        if (!response || !Array.isArray(response)) return;
        response.forEach(change => {
            const i = change.i;
            if (i < 0 || i >= tracksArr.length) return;
            const t = tracksArr[i];
            if (change.makeupGainDb != null) {
                const g = dbToGain(change.makeupGainDb);
                t.gain = Math.max(0.01, Math.min(3, g));
            }
            if (change.pan != null) t.pan = Math.max(-1, Math.min(1, change.pan));
            if (change.eqOn != null) t.eqOn = !!change.eqOn;
            if (change.eqParams) {
                t.eqParams = t.eqParams || { low: 0, mid: 0, high: 0 };
                if (change.eqParams.low != null) t.eqParams.low = change.eqParams.low;
                if (change.eqParams.mid != null) t.eqParams.mid = change.eqParams.mid;
                if (change.eqParams.high != null) t.eqParams.high = change.eqParams.high;
            }
            if (change.compOn != null) t.compOn = !!change.compOn;
            if (change.compParams) {
                t.compParams = t.compParams || { threshold: -20, ratio: 2, attack: 0.003, release: 0.25, knee: 6 };
                if (change.compParams.threshold != null) t.compParams.threshold = change.compParams.threshold;
                if (change.compParams.ratio != null) t.compParams.ratio = change.compParams.ratio;
                if (change.compParams.attack != null) t.compParams.attack = change.compParams.attack;
                if (change.compParams.release != null) t.compParams.release = change.compParams.release;
                if (change.compParams.knee != null) t.compParams.knee = change.compParams.knee;
            }
            if (change.addLevelPoint != null && t.automation && t.automation.level) {
                const pt = change.addLevelPoint;
                const tNorm = Math.max(0, Math.min(1, pt.t));
                const val = Math.max(0, Math.min(2, pt.value));
                t.automation.level.push({ t: tNorm, value: val });
                t.automation.level.sort((a, b) => a.t - b.t);
            }
        });
    }

    /** Aligned with plugin Josh: same roles (inferRole), same actions (makeupGain, pan, EQ/comp), same wording (punch, bright, warm, bring up, lower). */
    function interpretChatMessage(text, tracksArr, trackAnalyses) {
        const lower = (text || '').toLowerCase();
        const n = tracksArr.length;
        const analyses = Array.isArray(trackAnalyses) && trackAnalyses.length === n ? trackAnalyses : null;
        const changes = [];
        const dBUp = (lower.includes('more') || lower.includes('prominent') || lower.includes('bring up') || lower.includes('boost') || lower.includes('louder') || lower.includes('stronger')) ? 2 : (lower.includes('slightly') || lower.includes('a bit') || lower.includes('little')) ? 1 : 2;
        const dBDown = (lower.includes('lower') || lower.includes('weaker') || lower.includes('reduce') || lower.includes('less') || lower.includes('down')) ? 2 : (lower.includes('slightly') || lower.includes('a bit')) ? 1 : 2;
        const rolesToChange = [];
        if (/\bkick|kickdrum|bd\b/.test(lower)) rolesToChange.push('kick');
        if (/\bsnare|snr\b/.test(lower)) rolesToChange.push('snare');
        if (/\bbass\b/.test(lower)) rolesToChange.push('bass');
        if (/\bvocal|voc|singer|lead\s*vox\b/.test(lower)) rolesToChange.push('leadVocal');
        if (/\bbacking|bv|harmony\b/.test(lower)) rolesToChange.push('backingVocal');
        if (/\bguitar|gtr\b/.test(lower)) rolesToChange.push('guitar');
        if (/\bdrums?|perc\b/.test(lower) && !rolesToChange.length) rolesToChange.push('kick', 'snare', 'drums', 'overhead', 'tom');
        if (/\boverhead|oh|cymbal|ride|hats?\b/.test(lower)) rolesToChange.push('overhead');
        if (/\btom\b/.test(lower)) rolesToChange.push('tom');
        if (/\bkeys?|piano|synth\b/.test(lower)) rolesToChange.push('keys');
        const goUp = /more|prominent|bring up|boost|louder|stronger|up/.test(lower) && !/lower|down|less|reduce|weaker/.test(lower);
        const goDown = /lower|weaker|reduce|less|down/.test(lower);
        const brighter = /bright|brighter|air|top|high/.test(lower);
        const punch = /punch|punchy|tight|compress/.test(lower);
        const warmer = /warm|warmer|low|body/.test(lower);

        tracksArr.forEach((track, i) => {
            const role = inferRole(track.name, i, n);
            const match = rolesToChange.length === 0 || rolesToChange.includes(role);
            if (!match) return;
            const delta = {};
            if (goUp) delta.makeupGainDb = (20 * Math.log10(Math.max(track.gain, 0.01))) + dBUp;
            if (goDown) delta.makeupGainDb = (20 * Math.log10(Math.max(track.gain, 0.01))) - dBDown;
            if (brighter) {
                delta.eqOn = true;
                delta.eqParams = { ...(track.eqParams || { low: 0, mid: 0, high: 0 }), high: (track.eqParams && track.eqParams.high) ? track.eqParams.high + 2 : 2 };
            }
            if (punch) {
                delta.compOn = true;
                delta.compParams = { ...(track.compParams || {}), threshold: -18, ratio: 3 };
            }
            if (warmer) {
                delta.eqOn = true;
                delta.eqParams = { ...(track.eqParams || { low: 0, mid: 0, high: 0 }), low: (track.eqParams && track.eqParams.low) ? track.eqParams.low + 1.5 : 1.5 };
            }
            if (Object.keys(delta).length) {
                delta.i = i;
                changes.push(delta);
            }
        });

        if (analyses && (/\bloud\s*part|loudest|peak\s*part\b/.test(lower) || /\bquiet\s*section|softest|quietest|soft\s*part\b/.test(lower))) {
            const quieter = /\bloud\s*part|loudest|peak\s*part\b/.test(lower) && /quiet|lower|reduce|less|down/.test(lower);
            const boostQuiet = /\bquiet\s*section|softest|quietest|soft\s*part\b/.test(lower) && /boost|bring up|more|up|raise/.test(lower);
            const blockSec = 0.2;
            tracksArr.forEach((track, i) => {
                const role = inferRole(track.name, i, n);
                const match = rolesToChange.length === 0 || rolesToChange.includes(role);
                if (!match) return;
                const a = analyses[i];
                if (!a || !a.rmsOverTime || !a.rmsOverTime.length) return;
                const duration = a.duration || 1;
                const numBlocks = a.rmsOverTime.length;
                if (quieter && a.loudestBlockIndex != null) {
                    const tNorm = (a.loudestBlockIndex * blockSec) / duration;
                    const curVal = track.gain || 1;
                    changes.push({ i, addLevelPoint: { t: Math.max(0, Math.min(1, tNorm)), value: Math.max(0.01, curVal * 0.7) } });
                }
                if (boostQuiet && a.softestBlockIndex != null) {
                    const tNorm = (a.softestBlockIndex * blockSec) / duration;
                    const curVal = track.gain || 1;
                    changes.push({ i, addLevelPoint: { t: Math.max(0, Math.min(1, tNorm)), value: Math.min(2, curVal * 1.3) } });
                }
            });
        }

        if (changes.length === 0 && (goUp || goDown)) {
            tracksArr.forEach((track, i) => {
                const g = Math.max(track.gain, 0.01);
                const delta = goUp ? { i, makeupGainDb: 20 * Math.log10(g) + 1.5 } : { i, makeupGainDb: 20 * Math.log10(g) - 1.5 };
                changes.push(delta);
            });
        }
        return changes;
    }

    function applyMusicalBalance(tracksArr, genre) {
        const balance = GENRE_BALANCE[genre];
        if (!balance) return;
        const n = tracksArr.length;
        tracksArr.forEach((track, i) => {
            const role = inferRole(track.name, i, n);
            const cfg = balance[role] || balance.other;
            track.gain = Math.max(0.01, Math.min(3, dbToGain(cfg.db)));
            track.pan = Math.max(-1, Math.min(1, cfg.pan));
            if (track.automation) {
                if (track.automation.level && track.automation.level.length >= 2) {
                    track.automation.level[0].value = track.gain;
                    track.automation.level[track.automation.level.length - 1].value = track.gain;
                }
                if (track.automation.pan && track.automation.pan.length >= 2) {
                    track.automation.pan[0].value = track.pan;
                    track.automation.pan[track.automation.pan.length - 1].value = track.pan;
                }
            }
        });
    }

    window.MegaMix = window.MegaMix || {};
    window.MegaMix.MAX_FILES = MAX_FILES;
    window.MegaMix.PRESET_STORAGE_KEY = PRESET_STORAGE_KEY;
    window.MegaMix.state = state;
    window.MegaMix.defaultTrack = defaultTrack;
    window.MegaMix.interpolateAutomation = interpolateAutomation;
    window.MegaMix.snapshotMixerState = snapshotMixerState;
    window.MegaMix.restoreMixerState = restoreMixerState;
    window.MegaMix.dbToGain = dbToGain;
    window.MegaMix.inferRole = inferRole;
    window.MegaMix.GENRE_BALANCE = GENRE_BALANCE;
    window.MegaMix.applyJoshResponse = applyJoshResponse;
    window.MegaMix.interpretChatMessage = interpretChatMessage;
    window.MegaMix.applyMusicalBalance = applyMusicalBalance;
})();
