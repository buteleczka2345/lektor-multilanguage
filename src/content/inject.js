// ==========================================
// MAIN WORLD SCRIPT (Injected by content.js)
// ==========================================

(function() {
    // console.log("%c🎬 [LiveDub Inject] Netflix Subtitle Hook Initialized!", "color: #E50914; font-size: 16px; font-weight: bold;");

    const OriginalXHR = window.XMLHttpRequest;
    
    function HookedXHR() {
        const xhr = new OriginalXHR();
        const originalOpen = xhr.open;

        xhr.open = function(method, url, ...rest) {
            xhr._hookedUrl = url;
            return originalOpen.apply(this, [method, url, ...rest]);
        };

        xhr.addEventListener('load', function() {
            try {
                checkForSubtitle(xhr._hookedUrl, xhr.responseText);
            } catch(e) { /* ignore */ }
        });

        return xhr;
    }
    
    HookedXHR.prototype = OriginalXHR.prototype;
    window.XMLHttpRequest = HookedXHR;

    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        const response = await originalFetch.apply(this, args);

        try {
            const clonedResponse = response.clone();
            const text = await clonedResponse.text();
            checkForSubtitle(url, text);
        } catch(e) { /* ignore non-text */ }

        return response;
    };

    // ===== Źródła napisów (osobno dla każdego pliku) =====
    // Netflix potrafi wczytać na raz DWIE ścieżki napisów: natywną (wybraną w
    // odtwarzaczu) oraz plik, który pobiera Immersive Translate. Content script
    // musi wiedzieć, z którego pliku pochodzi każda kwestia, żeby czytać TYLKO
    // jedną wersję — dlatego każdy URL pliku dostaje własny klucz ('s1', 's2'…).
    const srcByUrl = new Map();   // url → { key, url }
    const seenHash = new Map();   // url → odcisk treści (ten sam plik nie jest parsowany dwa razy)
    let srcSeq = 0;

    function sourceFor(url) {
        const u = String(url || '');
        let s = srcByUrl.get(u);
        if (!s) {
            s = { key: 's' + (++srcSeq), url: u };
            srcByUrl.set(u, s);
        }
        return s;
    }

    // Odcisk treści pliku napisów: ten sam URL z IDENTYCZNĄ treścią nie jest parsowany
    // drugi raz (Netflix potrafi pobrać ten sam plik wielokrotnie), ale gdy treść się
    // zmieni (kolejna partia napisów), plik parsujemy ponownie.
    function textHash(s) {
        const str = String(s || '');
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return (h >>> 0) + ':' + str.length;
    }

    function checkForSubtitle(url, text) {
        if (!text || typeof text !== 'string') return;
        
        const isTTML = text.includes('<tt') && (text.includes('xmlns') || text.includes('xml:lang'));
        const isWebVTT = text.startsWith('WEBVTT');
        const isDFXP = text.includes('http://www.w3.org/ns/ttml') || text.includes('dfxp');
        
        if (isTTML || isWebVTT || isDFXP) {
            // Ta sama treść tego samego pliku już poszła — nie parsujemy drugi raz.
            if (seenHash.get(String(url || '')) === textHash(text)) return;
            parseTTML(text, url);
        }
    }

    function parseTTML(ttmlText, url) {
        try {
            const src = sourceFor(url);
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(ttmlText, "text/xml");
            
            // Tìm tickRate nếu dùng định dạng 't'
            let tickRate = 10000000; // default 10^7
            const ttNode = xmlDoc.getElementsByTagName('tt')[0];
            if (ttNode && ttNode.getAttribute('ttp:tickRate')) {
                tickRate = parseInt(ttNode.getAttribute('ttp:tickRate'), 10);
            }

            function timeToMs(timeStr) {
                if (!timeStr) return 0;
                const match = timeStr.match(/(?:(\d+):)?(\d+):(\d+)[.,](\d+)/);
                if (match) {
                    const [_, h, m, s, ms] = match;
                    return (parseInt(h || '0') * 3600 + parseInt(m) * 60 + parseInt(s)) * 1000 + parseInt(ms.padEnd(3, '0').slice(0, 3));
                }
                const tickMatch = timeStr.match(/(\d+)t/);
                if (tickMatch) {
                    return Math.floor((parseInt(tickMatch[1]) * 1000) / tickRate);
                }
                const secMatch = timeStr.match(/([\d.]+)s/);
                if (secMatch) {
                    return Math.floor(parseFloat(secMatch[1]) * 1000);
                }
                return parseFloat(timeStr) * 1000 || 0;
            }

            const paragraphs = xmlDoc.getElementsByTagName('p');
            if (paragraphs.length === 0) return;

            const subtitles = [];

            for (let i = 0; i < paragraphs.length; i++) {
                const p = paragraphs[i];
                // Wiersze wewnątrz jednego <p> bywają osobnymi liniami napisów
                // (np. „Hello there\nCześć" z trybu dwujęzycznego Immersive Translate).
                const lines = String(p.textContent || '')
                    .split(/[\r\n]+/)
                    .map((s) => s.replace(/\s+/g, ' ').trim())
                    .filter(Boolean);
                const text = lines.join(' ').trim();
                if (!text) continue;

                // Lấy timestamp từ thuộc tính
                const beginAttr = p.getAttribute('begin') || p.getAttribute('t');
                const endAttr = p.getAttribute('end') || p.getAttribute('d'); // 'd' là duration trong xml netflix

                const startMs = timeToMs(beginAttr);
                let endMs = timeToMs(endAttr);
                
                // Nếu 'd' là khoảng thời gian (duration) thay vì thời điểm kết thúc
                if (p.hasAttribute('d')) {
                    endMs = startMs + timeToMs(endAttr);
                }

                // Cố gắng gộp nếu có 2 dòng sub trùng khít thời gian (Netflix hay tách 2 dòng thành 2 thẻ <p>)
                const existingSub = subtitles.find(s => Math.abs(s.startMs - startMs) < 100 && Math.abs(s.endMs - endMs) < 100);
                
                if (existingSub) {
                    existingSub.text += " " + text;
                    for (const ln of lines) {
                        if (existingSub.lines.indexOf(ln) === -1) existingSub.lines.push(ln);
                    }
                } else {
                    // Id z prefiksem pliku (źródła): kwestie z natywnego pliku i z pliku
                    // Immersive Translate nie są już scalane w jedną (był to powód
                    // czytania dwóch wersji napisów na raz).
                    const id = `${src.key}_${startMs}_${i}`;
                    subtitles.push({ id, text, lines, startMs, endMs });
                }
            }
            
            if (subtitles.length > 0) {
                seenHash.set(String(url || ''), textHash(ttmlText)); // ten plik nie jest parsowany ponownie
                window.postMessage({
                    type: "LIVEDUB_SUBTITLE_DATA",
                    subtitles: subtitles,
                    source: { key: src.key, url: src.url }
                }, window.location.origin);
            }
        } catch (e) {
            console.error("❌ [LiveDub] Parse error:", e);
        }
    }
})();
