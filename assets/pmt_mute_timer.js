/* Profanity Mute Timer - model czasow slow i pauz.
 * Browser: window.PMT_MUTE_TIMER
 * Node: module.exports
 */
(function (root) {
    'use strict';

    var MODEL = {
        features: ['char_len', 'syllables', 'is_short_word', 'is_profanity',
            'punct_comma_after', 'punct_period_after', 'punct_question_after', 'punct_excl_after',
            'punct_dash_after', 'punct_colon_after', 'punct_other_after', 'punct_before',
            'pos_in_segment', 'segment_words'],
        word_model: {
            intercept: 36.4666,
            coef: { char_len: 23.2179, syllables: 35.8218, is_short_word: -27.7782,
                is_profanity: 39.6114, punct_comma_after: 35.9744, punct_period_after: 88.7466,
                punct_question_after: 103.8526, punct_excl_after: 91.4903, punct_dash_after: 61.965,
                punct_colon_after: 51.1866, punct_other_after: 52.2047, punct_before: 14.5523,
                pos_in_segment: 30.3692, segment_words: 2.0577 }
        },
        gap_model: {
            intercept: 36.9098,
            coef: { char_len: -1.0657, syllables: -8.8744, is_short_word: 10.7043,
                is_profanity: -12.7804, punct_comma_after: 117.5528, punct_period_after: 276.7314,
                punct_question_after: 292.5858, punct_excl_after: 290.5858, punct_dash_after: 87.596,
                punct_colon_after: 51.1866, punct_other_after: 42.9871, punct_before: 14.5523,
                pos_in_segment: 21.660000000000004, segment_words: 2.0577 }
        }
    };

    var SAFETY = {
        margin_ms: 51.5, preroll_ms: 120, postroll_ms: 140, bleed_ms: 60,
        neighbor_aware: true, merge_gap_ms: 120, min_word_ms: 60, min_gap_ms: 30,
        scale_min: 0.75, scale_max: 1.35
    };
    MODEL.safety = SAFETY;
    MODEL.timeline = { mode: 'auto', default_axis: 'file_1.0x', rate: 1.5 };
    var RATE = 1.5;
    var PL_VOWELS = 'aąeęioóuy';

    function countSyllablesPL(word) {
        var w = String(word || '').toLowerCase();
        if (!w) return 0;
        var count = 0, prevVowel = false;
        for (var i = 0; i < w.length; i++) {
            var isV = PL_VOWELS.indexOf(w.charAt(i)) !== -1;
            if (isV && !prevVowel) count++;
            prevVowel = isV;
        }
        return Math.max(1, count);
    }

    var TRAILING_RE = /([,!?;:.\u2026\u2014\u2013\u2012-]+)["'\u00BB)\]]*\s*$/;
    var LEADING_RE = /^["'\u00AB(\u2014\u2013\u2012-]+/;
    var PUNCT_CLASS = {
        ',': 'comma', '.': 'period', '?': 'question', '!': 'excl', ';': 'colon', ':': 'colon',
        '\u2014': 'dash', '\u2013': 'dash', '-': 'dash', '\u2012': 'dash', '\u2026': 'other'
    };

    function classifyPunctRun(run) {
        var classes = {};
        if (!run) return classes;
        var dotsOnly = true;
        for (var i = 0; i < run.length; i++) {
            if (run.charAt(i) !== '.') dotsOnly = false;
            var cls = PUNCT_CLASS[run.charAt(i)];
            if (cls) classes[cls] = 1;
        }
        if (dotsOnly && run.length >= 2) classes.other = 1;
        return classes;
    }

    function stripPunctuation(token) {
        var s = String(token == null ? '' : token).trim();
        if (!s) return null;
        var mTrail = s.match(TRAILING_RE);
        var afterRun = mTrail ? mTrail[1] : '';
        var core = mTrail ? s.slice(0, mTrail.index) : s;
        var mLead = core.match(LEADING_RE);
        var clean = (mLead ? core.slice(mLead[0].length) : core).trim();
        if (!clean) return null;
        return { word: clean, after: classifyPunctRun(afterRun),
            beforeLen: mLead ? mLead[0].length : 0 };
    }

    function extractFeatures(token, indexInSegment, totalWords, isProfanity) {
        var parsed = stripPunctuation(token);
        if (!parsed) return null;
        var after = parsed.after;
        var total = Math.max(1, totalWords);
        var posRatio = total > 1 ? indexInSegment / (total - 1) : 0;
        return {
            word: parsed.word,
            char_len: parsed.word.length,
            syllables: countSyllablesPL(parsed.word),
            is_short_word: parsed.word.length <= 3 ? 1 : 0,
            is_profanity: isProfanity ? 1 : 0,
            punct_comma_after: after.comma ? 1 : 0,
            punct_period_after: after.period ? 1 : 0,
            punct_question_after: after.question ? 1 : 0,
            punct_excl_after: after.excl ? 1 : 0,
            punct_dash_after: after.dash ? 1 : 0,
            punct_colon_after: after.colon ? 1 : 0,
            punct_other_after: after.other ? 1 : 0,
            punct_before: parsed.beforeLen > 0 ? 1 : 0,
            pos_in_segment: Math.round(posRatio * 10000) / 10000,
            segment_words: total
        };
    }

    function predict(part, f) {
        var s = part.intercept;
        for (var i = 0; i < MODEL.features.length; i++) {
            var name = MODEL.features[i];
            var c = part.coef[name];
            if (c) s += c * (f[name] || 0);
        }
        return s;
    }

    function estimateWordMs(f) { return Math.max(40, predict(MODEL.word_model, f)); }
    function estimateGapMs(f) { return Math.max(0, predict(MODEL.gap_model, f)); }

    function nz(v, dflt) {
        return typeof v === 'number' && isFinite(v) ? v : dflt;
    }

    function detectAxis(cueDurMs, totalPredMs, rate) {
        if (!(totalPredMs > 0)) return { axis: 'file_1.0x', kFile: 1, kReal: 1, confidence: 0 };
        var kFile = (cueDurMs / rate) / totalPredMs;
        var kReal = cueDurMs / totalPredMs;
        var lf = Math.abs(Math.log(kFile));
        var lr = Math.abs(Math.log(kReal));
        var axis = lf <= lr + 0.05 ? 'file_1.0x' : 'realtime_1.5x';
        return { axis: axis, kFile: kFile, kReal: kReal, confidence: Math.abs(lf - lr) };
    }

    function voteAxis(votes, defaultAxis) {
        defaultAxis = defaultAxis || 'file_1.0x';
        var weights = {}, n = 0;
        for (var i = 0; i < (votes || []).length; i++) {
            n++;
            var v = votes[i];
            if (!v || (v.axis !== 'file_1.0x' && v.axis !== 'realtime_1.5x')) continue;
            var w = typeof v.confidence === 'number' && v.confidence > 0 ? v.confidence : 0.05;
            weights[v.axis] = (weights[v.axis] || 0) + Math.max(0.05, w);
        }
        var axis = defaultAxis, best = -1;
        ['file_1.0x', 'realtime_1.5x'].forEach(function (name) {
            var w = weights[name] || 0;
            if (w > best) { best = w; axis = name; }
        });
        return { axis: axis, weights: weights, n: n };
    }

    function mergeRanges(ranges, mergeGapMs) {
        if (!ranges.length) return [];
        var sorted = ranges.slice().sort(function (a, b) { return a.relS - b.relS; });
        var out = [sorted[0]];
        for (var i = 1; i < sorted.length; i++) {
            var last = out[out.length - 1];
            if (sorted[i].relS - last.relE <= mergeGapMs) {
                last.relE = Math.max(last.relE, sorted[i].relE);
            } else out.push(sorted[i]);
        }
        return out;
    }

    function round1(x) { return Math.round(x * 10) / 10; }

    function computeCueMuteWindows(words, startMs, endMs, opts) {
        opts = opts || {};
        var rate = nz(opts.rate, RATE) || 1.5;
        var axisMode = opts.axis || 'auto';
        var preroll = nz(opts.preroll_ms, SAFETY.preroll_ms);
        var postroll = nz(opts.postroll_ms, SAFETY.postroll_ms);
        var margin = nz(opts.margin_ms, SAFETY.margin_ms);
        var minWord = nz(opts.min_word_ms, SAFETY.min_word_ms);
        var minGap = nz(opts.min_gap_ms, SAFETY.min_gap_ms);
        var mergeGap = nz(opts.merge_gap_ms, SAFETY.merge_gap_ms);
        var bleed = nz(opts.bleed_ms, SAFETY.bleed_ms);
        var neighborAware = opts.neighbor_aware !== undefined ? !!opts.neighbor_aware : SAFETY.neighbor_aware;

        var feats = [];
        for (var i = 0; i < words.length; i++) {
            var f = extractFeatures(words[i].text, feats.length, words.length, words[i].isProfanity);
            if (f) feats.push({ f: f, prof: f.is_profanity >= 0.5 });
        }
        if (!feats.length) return { windows: [], layout: [], axis: axisMode, scale: 1, totalPredMs: 0 };

        var wordMs = [], gapMs = [], totalPred = 0;
        for (i = 0; i < feats.length; i++) {
            var wMs = estimateWordMs(feats[i].f);
            wordMs.push(wMs);
            totalPred += wMs;
            var gMs = i < feats.length - 1 ? estimateGapMs(feats[i].f) : 0;
            gapMs.push(gMs);
            if (gMs) totalPred += gMs;
        }

        var cueDur = Math.max(100, endMs - startMs);
        var axis = axisMode, diag = null;
        if (axis === 'auto') { diag = detectAxis(cueDur, totalPred, rate); axis = diag.axis; }
        var budgetReal = axis === 'file_1.0x' ? cueDur / rate : cueDur;
        var kRaw = totalPred > 0 ? budgetReal / totalPred : 1;
        var k = Math.min(SAFETY.scale_max, Math.max(SAFETY.scale_min, kRaw));
        var clampSide = kRaw > SAFETY.scale_max * 1.0001 ? 'max'
            : (kRaw < SAFETY.scale_min * 0.9999 ? 'min' : null);

        var pos = 0, layout = [], wordStarts = [], wordEnds = [];
        for (i = 0; i < feats.length; i++) {
            var wStart = pos;
            var wLen = Math.max(minWord, wordMs[i] * k);
            wordStarts.push(wStart);
            wordEnds.push(wStart + wLen);
            var gLen = i < feats.length - 1 ? Math.max(minGap, gapMs[i] * k) : 0;
            layout.push({ word: feats[i].f.word, isProfanity: feats[i].prof,
                startRealMs: round1(wStart), endRealMs: round1(wStart + wLen),
                gapAfterRealMs: round1(gLen) });
            pos = wordEnds[i] + gLen;
        }

        var ranges = [];
        for (i = 0; i < feats.length; i++) {
            if (!layout[i].isProfanity) continue;
            var silenceBefore = i > 0 ? wordStarts[i] - wordEnds[i - 1] : wordStarts[i];
            var silenceAfter = i + 1 < feats.length
                ? wordStarts[i + 1] - wordEnds[i]
                : Math.max(0, budgetReal - wordEnds[feats.length - 1]);
            var prerollEff = neighborAware ? Math.min(preroll, silenceBefore + bleed) : preroll;
            var tailEff = neighborAware
                ? Math.min(margin + postroll, Math.max(margin, silenceAfter + bleed))
                : margin + postroll;
            ranges.push({ relS: Math.max(0, wordStarts[i] - prerollEff),
                relE: wordEnds[i] + tailEff, word: layout[i].word });
        }
        var merged = mergeRanges(ranges, mergeGap);
        var toFileRel = function (rel) { return axis === 'file_1.0x' ? rel * rate : rel; };
        var windows = merged.map(function (m) {
            var s = startMs + toFileRel(m.relS);
            var e = startMs + toFileRel(m.relE);
            return { startMs: round1(s), endMs: round1(e),
                durationMs: round1(e - s), word: m.word };
        });

        return { windows: windows, layout: layout, axis: axis,
            scale: Math.round(k * 1000) / 1000,
            kUncapped: Math.round(kRaw * 1000) / 1000,
            scaleClampedSide: clampSide,
            totalPredMs: round1(totalPred), axisDiagnostics: diag };
    }

    var api = {
        MODEL: MODEL, countSyllablesPL: countSyllablesPL,
        stripPunctuation: stripPunctuation, extractFeatures: extractFeatures,
        estimateWordMs: estimateWordMs, estimateGapMs: estimateGapMs,
        detectAxis: detectAxis, voteAxis: voteAxis,
        computeCueMuteWindows: computeCueMuteWindows
    };
    root.PMT_MUTE_TIMER = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
