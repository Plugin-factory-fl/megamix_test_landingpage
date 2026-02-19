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
            gain: 0.8,
            pan: 0,
            eqOn: false,
            compOn: false,
            eqParams: { low: 0, mid: 0, high: 0 },
            compParams: { threshold: -20, ratio: 2, attack: 0.003, release: 0.25, knee: 6 },
            reverbOn: false,
            retroOn: false,
            mute: false,
            solo: false,
            reverbParams: { mix: 0.25, decaySeconds: 0.4 },
            automation: {
                level: [{ t: 0, value: 0.8 }, { t: 1, value: 0.8 }],
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
        masteredUrl: null,
        unmasteredMixUrl: null,
        /** Last Josh changes as human-readable strings for "What Josh did" transparency panel */
        lastJoshChangesSummary: []
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
        if (/\boverhead|oh\b|room|cymbals|ride|hats?|hi.?hat|click|clicking\b/.test(n)) return 'overhead';
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

    /** Genre-based reverb: which roles get reverb on "Mix it" and with what settings (mix 0–1, decaySeconds). Industry-standard plate/room by genre. */
    const GENRE_REVERB = {
        rock:     { leadVocal: { mix: 0.18, decaySeconds: 0.32 }, backingVocal: { mix: 0.2, decaySeconds: 0.35 }, snare: { mix: 0.08, decaySeconds: 0.22 } },
        metal:    { leadVocal: { mix: 0.12, decaySeconds: 0.25 }, overhead: { mix: 0.08, decaySeconds: 0.22 } },
        hiphop:   { leadVocal: { mix: 0.1, decaySeconds: 0.25 } },
        pop:      { leadVocal: { mix: 0.22, decaySeconds: 0.4 }, backingVocal: { mix: 0.25, decaySeconds: 0.42 } },
        edm:      { leadVocal: { mix: 0.2, decaySeconds: 0.4 }, keys: { mix: 0.18, decaySeconds: 0.38 }, other: { mix: 0.15, decaySeconds: 0.35 } },
        rnb:      { leadVocal: { mix: 0.22, decaySeconds: 0.42 }, backingVocal: { mix: 0.2, decaySeconds: 0.38 } },
        jazz:     { leadVocal: { mix: 0.18, decaySeconds: 0.38 }, overhead: { mix: 0.15, decaySeconds: 0.35 }, bass: { mix: 0.08, decaySeconds: 0.28 } },
        funk:     { leadVocal: { mix: 0.12, decaySeconds: 0.28 } },
        country:  { leadVocal: { mix: 0.2, decaySeconds: 0.4 } },
        custom:   {}
    };

    /** Genre-specific preset prompts for Step 2 "Words of guidance". Keys match GENRE_BALANCE. */
    const GENRE_PROMPTS = {
        rock:     ['Clean and present', 'Punchy drums', 'Vocal forward', 'Warm low end', 'Bright and open', 'Glue and punch'],
        metal:    ['Aggressive and tight', 'Kick and snare punch', 'Guitars forward', 'Dark and heavy', 'Clear vocals', 'Room and width'],
        hiphop:   ['Clean and present', 'Kick and 808 up', 'Vocal crisp', 'Warm low end', 'Punchy drums', 'Thick and present'],
        pop:      ['Clean and present', 'Vocal forward', 'Bright airy', 'Warm intimate', 'Punchy modern', 'Radio ready'],
        edm:      ['Punchy compress', 'Kick and bass locked', 'Bright and wide', 'Thick chorus', 'Atmospheric', 'Club ready'],
        rnb:      ['Warm intimate', 'Vocal forward', 'Smooth low end', 'Bright airy', 'Punchy snare', 'Thick and present'],
        jazz:     ['Warm intimate', 'Natural balance', 'Open and airy', 'Bass present', 'Brush and room', 'Organic'],
        funk:     ['Punchy drums', 'Bass forward', 'Guitar bite', 'Tight and groovy', 'Bright and open', 'Thick chorus'],
        country:  ['Vocal forward', 'Acoustic present', 'Warm and natural', 'Bright and open', 'Punchy kick', 'Clean and present'],
        custom:   ['Clean and present', 'Vocal forward', 'Punchy drums', 'Warm low end', 'Bright and open', 'More glue']
    };

    /** Step 3 quick prompts per genre: { label, prompt }[]. Keys match GENRE_BALANCE. */
    const GENRE_QUICK_PROMPTS = {
        rock:     [{ label: 'Kick & snare up', prompt: 'Make the kick and snare more prominent' }, { label: 'Vocal forward', prompt: 'Bring up the vocals' }, { label: 'More punch', prompt: 'Add more punch to the drums' }, { label: 'Brighter', prompt: 'Make it brighter' }, { label: 'Guitars down', prompt: 'Lower the guitars' }, { label: 'Warm low end', prompt: 'Warm up the low end' }],
        metal:    [{ label: 'Kick punch', prompt: 'More kick punch' }, { label: 'Guitars forward', prompt: 'Bring guitars forward' }, { label: 'Clear vocals', prompt: 'Make vocals clearer' }, { label: 'Tighter', prompt: 'Tighten the mix' }, { label: 'Snare up', prompt: 'Bring up the snare' }, { label: 'Dark and heavy', prompt: 'More dark and heavy' }],
        hiphop:   [{ label: '808 up', prompt: 'Bring up the 808/bass' }, { label: 'Vocal crisp', prompt: 'Make vocals crisper' }, { label: 'Punchy drums', prompt: 'More punchy drums' }, { label: 'Brighter', prompt: 'Make it brighter' }, { label: 'Thicker', prompt: 'Make it thicker' }, { label: 'Kick up', prompt: 'Bring up the kick' }],
        pop:      [{ label: 'Vocal forward', prompt: 'Vocal forward' }, { label: 'Bright airy', prompt: 'Brighter and airier' }, { label: 'Punchy modern', prompt: 'More punchy and modern' }, { label: 'Warm intimate', prompt: 'Warmer and more intimate' }, { label: 'Radio ready', prompt: 'More radio ready' }, { label: 'Kick & snare up', prompt: 'Bring up kick and snare' }],
        edm:      [{ label: 'Kick and bass locked', prompt: 'Lock kick and bass' }, { label: 'Bright and wide', prompt: 'Brighter and wider' }, { label: 'Punchy compress', prompt: 'More punchy compression' }, { label: 'Thick chorus', prompt: 'Thicker chorus' }, { label: 'Club ready', prompt: 'More club ready' }, { label: 'Atmospheric', prompt: 'More atmospheric' }],
        rnb:      [{ label: 'Vocal forward', prompt: 'Vocal forward' }, { label: 'Smooth low end', prompt: 'Smoother low end' }, { label: 'Warm intimate', prompt: 'Warmer and more intimate' }, { label: 'Punchy snare', prompt: 'More punchy snare' }, { label: 'Bright airy', prompt: 'Brighter and airier' }, { label: 'Thick and present', prompt: 'Thicker and more present' }],
        jazz:     [{ label: 'Natural balance', prompt: 'More natural balance' }, { label: 'Open and airy', prompt: 'More open and airy' }, { label: 'Bass present', prompt: 'Bass more present' }, { label: 'Warm intimate', prompt: 'Warmer and more intimate' }, { label: 'Brush and room', prompt: 'More brush and room' }, { label: 'Organic', prompt: 'More organic' }],
        funk:     [{ label: 'Punchy drums', prompt: 'More punchy drums' }, { label: 'Bass forward', prompt: 'Bass forward' }, { label: 'Guitar bite', prompt: 'More guitar bite' }, { label: 'Tight and groovy', prompt: 'Tighter and groovier' }, { label: 'Bright and open', prompt: 'Brighter and more open' }, { label: 'Thick chorus', prompt: 'Thicker chorus' }],
        country:  [{ label: 'Vocal forward', prompt: 'Vocal forward' }, { label: 'Acoustic present', prompt: 'Acoustic more present' }, { label: 'Warm and natural', prompt: 'Warmer and more natural' }, { label: 'Punchy kick', prompt: 'More punchy kick' }, { label: 'Bright and open', prompt: 'Brighter and more open' }, { label: 'Clean and present', prompt: 'Cleaner and more present' }],
        custom:   [{ label: 'Kick & snare up', prompt: 'Make the kick and snare more prominent' }, { label: 'Vocal forward', prompt: 'Bring up the vocals' }, { label: 'More punch', prompt: 'Add more punch' }, { label: 'Brighter', prompt: 'Make it brighter' }, { label: 'Warm low end', prompt: 'Warm up the low end' }, { label: 'More glue', prompt: 'More glue and cohesion' }]
    };

    /** Convert Josh changes to human-readable strings for the transparency panel */
    function formatJoshChangesForDisplay(changes, tracksArr) {
        if (!changes || !Array.isArray(changes)) return [];
        const lines = [];
        changes.forEach(change => {
            const i = change.i;
            const name = (tracksArr[i] && tracksArr[i].name) ? tracksArr[i].name : 'Track ' + (i + 1);
            const parts = [];
            if (change.makeupGainDb != null) {
                const db = change.makeupGainDb;
                const dir = db >= 0 ? '+' : '';
                parts.push(dir + db.toFixed(1) + ' dB');
            }
            if (change.pan != null) {
                parts.push('pan ' + (change.pan >= 0 ? 'R' : 'L') + ' ' + Math.abs(change.pan * 100).toFixed(0) + '%');
            }
            if (change.eqOn && change.eqParams) {
                const eq = change.eqParams;
                const bands = [];
                if (eq.low != null && eq.low !== 0) bands.push('low ' + (eq.low >= 0 ? '+' : '') + eq.low.toFixed(1) + ' dB');
                if (eq.mid != null && eq.mid !== 0) bands.push('mid ' + (eq.mid >= 0 ? '+' : '') + eq.mid.toFixed(1) + ' dB');
                if (eq.high != null && eq.high !== 0) bands.push('high ' + (eq.high >= 0 ? '+' : '') + eq.high.toFixed(1) + ' dB');
                if (bands.length) parts.push('EQ: ' + bands.join(', '));
            }
            if (change.compOn) {
                const c = change.compParams || {};
                const thr = c.threshold != null ? c.threshold : -18;
                const ratio = c.ratio != null ? c.ratio : 3;
                parts.push('comp (thr ' + thr + ' dB, ratio ' + ratio + ':1)');
            }
            if (change.reverbOn != null && change.reverbOn) {
                const r = change.reverbParams || {};
                const mix = r.mix != null ? Math.round(r.mix * 100) : 25;
                const decay = r.decaySeconds != null ? r.decaySeconds.toFixed(2) : '0.40';
                parts.push('reverb (mix ' + mix + '%, decay ' + decay + 's)');
            }
            if (change.addLevelPoint) {
                parts.push('automation at ' + ((change.addLevelPoint.t || 0) * 100).toFixed(0) + '%');
            }
            if (change.mute === true) parts.push('muted');
            if (change.solo === true) parts.push('solo');
            if (change.mute === false) parts.push('unmuted');
            if (change.solo === false) parts.push('solo off');
            if (parts.length) lines.push(name + ': ' + parts.join('; '));
        });
        return lines;
    }

    function applyJoshResponse(tracksArr, response) {
        if (!response || !Array.isArray(response)) return;
        response.forEach(change => {
            const i = change.i;
            if (i < 0 || i >= tracksArr.length) return;
            const t = tracksArr[i];
            if (change.makeupGainDb != null) {
                const g = dbToGain(change.makeupGainDb);
                t.gain = Math.max(0.01, Math.min(3, g));
                if (t.automation && t.automation.level && t.automation.level.length >= 2) {
                    t.automation.level[0].value = t.gain;
                    t.automation.level[t.automation.level.length - 1].value = t.gain;
                }
            }
            if (change.pan != null) {
                t.pan = Math.max(-1, Math.min(1, change.pan));
                if (t.automation && t.automation.pan && t.automation.pan.length >= 2) {
                    t.automation.pan[0].value = t.pan;
                    t.automation.pan[t.automation.pan.length - 1].value = t.pan;
                }
            }
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
            if (change.reverbOn != null && !(window.MegaMix && window.MegaMix.JOSH_VERB_DISABLED)) t.reverbOn = !!change.reverbOn;
            if (change.reverbParams) {
                t.reverbParams = t.reverbParams || { mix: 0.25, decaySeconds: 0.4 };
                if (change.reverbParams.mix != null) t.reverbParams.mix = Math.max(0, Math.min(1, change.reverbParams.mix));
                if (change.reverbParams.decaySeconds != null) t.reverbParams.decaySeconds = Math.max(0.15, Math.min(1.5, change.reverbParams.decaySeconds));
            }
            if (change.addLevelPoint != null && t.automation && t.automation.level) {
                const pt = change.addLevelPoint;
                const tNorm = Math.max(0, Math.min(1, pt.t));
                const val = Math.max(0, Math.min(2, pt.value));
                t.automation.level.push({ t: tNorm, value: val });
                t.automation.level.sort((a, b) => a.t - b.t);
            }
            if (change.mute != null) t.mute = !!change.mute;
            if (change.solo != null) t.solo = !!change.solo;
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
        if (/\bclick|clicking|clicks\b/.test(lower)) rolesToChange.push('overhead');
        if (/\btom\b/.test(lower)) rolesToChange.push('tom');
        if (/\bkeys?|piano|synth\b/.test(lower)) rolesToChange.push('keys');
        const goUp = /more|prominent|bring up|boost|louder|stronger|up/.test(lower) && !/lower|down|less|reduce|weaker/.test(lower);
        const goDown = /lower|weaker|reduce|less|down/.test(lower);
        const brighter = /bright|brighter|air|top|high/.test(lower);
        const punch = /punch|punchy|tight|compress/.test(lower);
        const warmer = /warm|warmer|low|body/.test(lower);
        const reverbAsk = /\breverb|room|space|wetter|wet\b|add\s*reverb|more\s*room|atmosphere|airier\b/.test(lower);
        const lessReverb = /\bless\s*reverb|dryer|drier|less\s*room|no\s*reverb\b/.test(lower);
        const muteAsk = /\bmute\b/.test(lower) && !/\bunmute\b/.test(lower);
        const unmuteAsk = /\bunmute\b/.test(lower);
        const soloAsk = /\bsolo\b/.test(lower) && !/\bunsolo\b/.test(lower) && !/solo\s*off\b/.test(lower);
        const unsoloAsk = /\bunsolo\b|solo\s*off\b/.test(lower);

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
            if (reverbAsk) {
                delta.reverbOn = true;
                var rp = track.reverbParams || { mix: 0.25, decaySeconds: 0.4 };
                var mix = (rp.mix != null ? rp.mix : 0.25) + 0.1;
                var decay = (rp.decaySeconds != null ? rp.decaySeconds : 0.4) + 0.05;
                delta.reverbParams = { mix: Math.min(0.5, mix), decaySeconds: Math.min(1.2, decay) };
            }
            if (lessReverb) {
                delta.reverbOn = false;
            }
            if (muteAsk && (rolesToChange.length > 0 || /\ball|everything|whole\s*(song|mix)|entire\b/.test(lower))) delta.mute = true;
            if (unmuteAsk) delta.mute = false;
            if (soloAsk && (rolesToChange.length > 0 || /\ball|everything|whole\s*(song|mix)|entire\b/.test(lower))) delta.solo = true;
            if (unsoloAsk) delta.solo = false;
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
        const reverbCfg = GENRE_REVERB[genre] || GENRE_REVERB.custom;
        if (!balance) return;
        const n = tracksArr.length;
        tracksArr.forEach((track, i) => {
            const role = inferRole(track.name, i, n);
            const cfg = balance[role] || balance.other;
            track.gain = Math.max(0.01, Math.min(2, dbToGain(cfg.db) * 0.85));
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
            track.eqOn = true;
            track.eqParams = { low: 0, mid: 0, high: 0.75 };
            var rev = reverbCfg[role];
            if (rev && typeof rev.mix === 'number' && typeof rev.decaySeconds === 'number') {
                track.reverbOn = true;
                track.reverbParams = { mix: Math.max(0, Math.min(1, rev.mix)), decaySeconds: Math.max(0.15, Math.min(1.5, rev.decaySeconds)) };
            } else {
                track.reverbOn = false;
                track.reverbParams = track.reverbParams || { mix: 0.25, decaySeconds: 0.4 };
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
    window.MegaMix.GENRE_PROMPTS = GENRE_PROMPTS;
    window.MegaMix.GENRE_QUICK_PROMPTS = GENRE_QUICK_PROMPTS;
    window.MegaMix.applyJoshResponse = applyJoshResponse;
    window.MegaMix.formatJoshChangesForDisplay = formatJoshChangesForDisplay;
    window.MegaMix.interpretChatMessage = interpretChatMessage;
    window.MegaMix.applyMusicalBalance = applyMusicalBalance;
})();
