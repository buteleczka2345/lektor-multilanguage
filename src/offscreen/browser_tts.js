// [AGENT-EXP] 2026-10-21: 🗣 Głos przeglądarki — Web Speech API (speechSynthesis), jak tryb Standard w DubMog.
// Darmowy, bez serwera: w Chrome „Google polski” (głos sieciowy), w Edge „Microsoft … Online (Natural)”.
// Działa w dokumencie offscreen (tam gra cały lektor); offscreen.js wybiera ten silnik przy ttsEngine === 'browser'.
// Dźwięk idzie prosto z systemu, poza <audio>: bez wzmocnienia >100%, kompresora, nagrywania i zapisu bufora.
//
// Co tu jest ponad prosty wzorzec (wnioski z DubMog standard.js / offscreen.js pumpStd):
// * własna kolejka — kolejka speechSynthesis potrafi się zawiesić (end/error nigdy nie przychodzi),
// * strażnik: brak startu po 8 s albo koniec mocno spóźniony → cancel i następna kwestia;
//   2 zawieszenia z rzędu → głos lokalny do końca sesji,
// * błąd głosu sieciowego → głos lokalny i ta sama kwestia jeszcze raz,
// * długi tekst dzielony na kawałki ≤ 200 znaków (Chrome ucina głosy Google po ~15 s mowy).

const START_MAX_MS = 8000;   // speak() → onstart (głosy sieciowe zwykle 200–1300 ms)
const CPS = 14;              // znaki na sekundę przy tempie 1 — szacunek dla strażnika końca
const CHUNK_MAX = 200;

function norm(l) { return String(l || '').replace('_', '-').toLowerCase(); }

export default class BrowserTTSManager {
    constructor(lang = 'pl-PL', opts = {}) {
        this.lang = lang;
        this.synth = opts.synth || globalThis.speechSynthesis || null;
        this.Utterance = opts.Utterance || globalThis.SpeechSynthesisUtterance || null;
        this.log = opts.log || (() => {});
        this.selectedVoice = null;
        this.voiceName = '';      // wymuszony głos (nazwa); '' = automatycznie najlepszy
        this.forceLocal = false;  // po błędzie / zawieszeniu głosu sieciowego
        this.rate = 1.0;
        this.pitch = 1.0;
        this.volume = 1.0;
        this.queue = [];
        this.current = null;
        this.paused = false;
        this.hangs = 0;
        this.onidle = null;       // kolejka opróżniona (offscreen → TTS_QUEUE_IDLE)
        this._u = null;
        this._listening = false;
        this.initVoices();
    }

    initVoices() {
        if (!this.synth) {
            console.error('[BrowserTTS] Web Speech API nie jest wspierane w tym środowisku.');
            return;
        }
        this._updateVoice();
        if (this._listening) return;
        this._listening = true;
        // głosy przychodzą asynchronicznie (Google sieciowe nawet po kilku sekundach)
        const h = () => this._updateVoice();
        if (typeof this.synth.addEventListener === 'function') this.synth.addEventListener('voiceschanged', h);
        else if (this.synth.onvoiceschanged !== undefined) this.synth.onvoiceschanged = h;
    }

    _voices() {
        try { return (this.synth && this.synth.getVoices()) || []; } catch (e) { return []; }
    }

    _updateVoice() {
        const prev = this.selectedVoice;
        this.selectedVoice = this.pickVoice();
        const v = this.selectedVoice;
        if (v && v !== prev) this.log('browser-voice', v.name + ' | ' + v.lang + (v.localService ? ' (lokalny)' : ' (sieciowy)'));
    }

    // czeka na listę głosów najwyżej ms (pusta lista przy pierwszym getVoices() to norma w Chrome)
    ready(ms = 1000) {
        if (!this.synth || this._voices().length) { this._updateVoice(); return Promise.resolve(this.selectedVoice); }
        return new Promise((resolve) => {
            let t = 0;
            const fin = () => {
                clearTimeout(t);
                try { if (this.synth.removeEventListener) this.synth.removeEventListener('voiceschanged', fin); } catch (e) {}
                this._updateVoice();
                resolve(this.selectedVoice);
            };
            t = setTimeout(fin, ms);
            try { if (this.synth.addEventListener) this.synth.addEventListener('voiceschanged', fin); } catch (e) {}
        });
    }

    // Punkty: Google +200, Microsoft Natural/Online +80, enhanced/premium/neural +50, dokładny kod (pl-pl) +20,
    // sam główny kod (pl) — 1; „compact” −10. Tylko głosy w danym języku.
    _score(v, onlyLocal) {
        const lang = norm(v.lang), full = norm(this.lang), base = full.split('-')[0];
        if (!lang || lang.split('-')[0] !== base) return 0;
        if (onlyLocal && !v.localService) return 0;
        const s = String(v.name || '') + ' ' + String(v.voiceURI || '');
        let score = 1;
        if (lang === full) score += 20;
        if (!onlyLocal && /google/i.test(v.name || '')) score += 200;   // > Microsoft Natural (80 + 50)
        if (/microsoft/i.test(s) && /natural|online/i.test(s)) score += 80;
        if (/enhanced|premium|natural|neural/i.test(s)) score += 50;
        if (/compact/i.test(s)) score -= 10;
        return score;
    }

    _best(onlyLocal) {
        let best = null, bestScore = 0;
        for (const v of this._voices()) {
            const sc = this._score(v, onlyLocal);
            if (sc > bestScore) { bestScore = sc; best = v; }
        }
        return best;
    }

    pickVoice() {
        if (this.voiceName) {
            const v = this._voices().find((x) => x.name === this.voiceName);
            if (v && (!this.forceLocal || v.localService)) return v;
        }
        if (this.forceLocal) return this.pickLocal() || this._best(false);
        return this._best(false);
    }

    pickLocal() { return this._best(true); }

    listVoices(all) {
        const base = norm(this.lang).split('-')[0];
        return this._voices()
            .filter((v) => all || norm(v.lang).split('-')[0] === base)
            .map((v) => ({ name: v.name, lang: v.lang, local: !!v.localService }));
    }

    setLanguage(lang) {
        this.lang = lang || 'pl-PL';
        this.forceLocal = false;
        this.hangs = 0;
        this.initVoices();
    }

    setVoice(name) {
        this.voiceName = String(name || '');
        this.forceLocal = false;
        this.hangs = 0;
        this._updateVoice();
    }

    // zdania; zbyt długie kawałki tniemy po przecinku / spacji
    splitText(text) {
        const parts = String(text || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?…;:])\s+/);
        const out = [];
        let cur = '';
        const push = (p) => {
            while (p.length > CHUNK_MAX) {
                let cut = p.lastIndexOf(', ', CHUNK_MAX);
                if (cut < CHUNK_MAX / 2) cut = p.lastIndexOf(' ', CHUNK_MAX);
                if (cut < CHUNK_MAX / 2) cut = CHUNK_MAX;
                out.push(p.slice(0, cut + (p[cut] === ',' ? 1 : 0)).trim());
                p = p.slice(cut + (p[cut] === ',' ? 1 : 0)).trim();
            }
            if (p) out.push(p);
        };
        for (const p of parts) {
            if (!p) continue;
            if (cur && (cur.length + 1 + p.length) <= CHUNK_MAX) { cur += ' ' + p; continue; }
            if (cur) push(cur);
            cur = p;
        }
        if (cur) push(cur);
        return out;
    }

    // options: rate, pitch, volume, clearQueue (domyślnie true — nowa kwestia ucisza poprzednią),
    // maxQueue (ile kwestii może czekać; starsze bez noSkip wypadają), expireAt (ms; po tym czasie pomijana),
    // noSkip, onstart(), onend(powód)
    speak(text, overrideOptions = {}) {
        const o = overrideOptions || {};
        if (!text || !this.synth || !this.Utterance) return false;
        if (o.clearQueue !== false) this.stop();
        const chunks = this.splitText(text);
        if (!chunks.length) return false;
        const item = {
            chunks, idx: 0, retried: false, started: false,
            rate: o.rate || this.rate, pitch: o.pitch || this.pitch,
            volume: o.volume !== undefined ? o.volume : this.volume,
            expireAt: o.expireAt || 0, noSkip: !!o.noSkip, onstart: o.onstart, onend: o.onend
        };
        this.queue.push(item);
        const max = Number(o.maxQueue);
        if (Number.isFinite(max) && max >= 0) {
            while (this.queue.length > max) {
                const i = this.queue.findIndex((q) => q !== item && !q.noSkip);
                if (i < 0) break;
                this._end(this.queue.splice(i, 1)[0], 'skipped');
            }
        }
        this._pump();
        return true;
    }

    _end(item, why) {
        try { if (item && item.onend) item.onend(why); } catch (e) {}
    }

    _pump() {
        if (this.current) return;
        let next = this.queue.shift();
        while (next && next.expireAt && Date.now() > next.expireAt && !next.noSkip) {
            this._end(next, 'expired');
            next = this.queue.shift();
        }
        if (!next) {
            try { if (this.onidle) this.onidle(); } catch (e) {}
            return;
        }
        this.current = next;
        this._speakChunk();
    }

    _advance(why) {
        const item = this.current;
        if (!item) return;
        item.idx++;
        if (item.idx < item.chunks.length) { this._speakChunk(); return; }
        this.current = null;
        this._end(item, why);
        this._pump();
    }

    _speakChunk() {
        const item = this.current;
        const chunk = item.chunks[item.idx];
        if (!this.selectedVoice) this._updateVoice();
        const voice = this.selectedVoice;
        const u = new this.Utterance(chunk);
        if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = this.lang;
        u.rate = Math.min(10, Math.max(0.1, Number(item.rate) || 1));
        u.pitch = Math.min(2, Math.max(0, Number(item.pitch) || 1));
        u.volume = Math.min(1, Math.max(0, Number(item.volume)));
        this._u = u;
        let finished = false, timer = 0;
        const done = (why) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            if (this._u !== u) return;   // przerwane przez stop()
            this._u = null;
            this._advance(why);
        };
        const arm = (ms, why) => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                if (finished || this._u !== u) return;
                if (this.paused) { arm(ms, why); return; }   // pauza to nie zawieszenie
                this.hangs++;
                this.log('browser-hang', why + ' (' + (voice ? voice.name : 'brak głosu') + ', ' + this.hangs + ')');
                if (this.hangs >= 2 && voice && !voice.localService) {
                    const local = this.pickLocal();
                    if (local) { this.forceLocal = true; this.selectedVoice = local; this.hangs = 0; this.log('browser-voice', 'zawieszenia → lokalny ' + local.name); }
                }
                try { this.synth.cancel(); } catch (e) {}
                done('hang');
            }, ms);
        };
        u.onstart = () => {
            if (this._u !== u) return;
            this.hangs = 0;
            arm(Math.round(chunk.length / CPS / u.rate * 1000 * 2 + 4000), 'brak końca');
            if (!item.started) { item.started = true; try { if (item.onstart) item.onstart(); } catch (e) {} }
        };
        u.onend = () => done('end');
        u.onerror = (ev) => {
            const err = ev && ev.error;
            if (err === 'interrupted' || err === 'canceled') { done('interrupted'); return; }
            console.warn('[BrowserTTS] Błąd syntezy mowy:', err);
            this.log('browser-error', String(err || 'błąd') + ' (' + (voice ? voice.name : '') + ')');
            // głos sieciowy zawiódł → lokalny / systemowy i ta sama kwestia jeszcze raz
            if (voice && !voice.localService && !item.retried && this._u === u) {
                const local = this.pickLocal();
                if (local) {
                    finished = true;
                    clearTimeout(timer);
                    item.retried = true;
                    this.forceLocal = true;
                    this.selectedVoice = local;
                    this._u = null;
                    this.log('browser-voice', 'przełączam na lokalny ' + local.name);
                    this._speakChunk();
                    return;
                }
            }
            done('error');
        };
        arm(START_MAX_MS, 'brak startu');
        try { this.synth.resume(); } catch (e) {}   // Chrome potrafi utknąć w stanie „paused”
        try { this.synth.speak(u); } catch (e) { done('error'); }
    }

    stop() {
        const cur = this.current, q = this.queue;
        this.current = null;
        this.queue = [];
        this._u = null;
        this.paused = false;
        if (this.synth) { try { this.synth.cancel(); } catch (e) {} }
        if (cur) this._end(cur, 'stopped');
        for (const it of q) this._end(it, 'stopped');
    }

    // [AGENT-EXP] 2026-10-22: miękka pauza — bieżąca kwestia czyta się do końca, czekające przepadają
    dropQueued() {
        const q = this.queue;
        this.queue = [];
        for (const it of q) this._end(it, 'stopped');
    }

    pause() {
        if (!this.synth) return;
        this.paused = true;
        try { this.synth.pause(); } catch (e) {}
    }

    resume() {
        if (!this.synth) return;
        this.paused = false;
        try { this.synth.resume(); } catch (e) {}
    }

    isBusy() { return !!this.current || this.queue.length > 0; }
}
