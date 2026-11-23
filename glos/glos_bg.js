// Głos i Napisy — tło (moduł lektora, importowany w service-worker-loader.js).
//  🎤 Alt+Shift+1: okienko glos.html słucha mikrofonu → zatwierdzone zdania wpisujemy w pole z kursorem.
//  🎧 Alt+Shift+2: id strumienia karty (tabCapture) → okienko karta.html → napisy na filmie + czytanie.
//  Dziennik: każdy krok (też z okienek) → chrome.storage.local 'gnDbg' (popup: pokaż / kopiuj / wyczyść).

// ---------- Dziennik ----------
let dbgChain = Promise.resolve();
function dlog(src, msg) {
    const line = new Date().toLocaleTimeString('pl-PL') + ' [' + src + '] ' + msg;
    console.log(line);
    dbgChain = dbgChain.then(async () => {
        const { gnDbg: dbg = [] } = await chrome.storage.local.get('gnDbg');
        dbg.push(line);
        if (dbg.length > 400) dbg.splice(0, dbg.length - 400);
        await chrome.storage.local.set({ gnDbg: dbg });
    }).catch(() => { });
}
dlog('tło', 'start service workera (wersja ' + chrome.runtime.getManifest().version + ')');

// ---------- Okienka ----------
const WIN = {
    glos: { url: 'glos/glos.html', W: 380, H: 300, corner: 'right' },
    karta: { url: 'glos/karta.html', W: 430, H: 320, corner: 'left' },
};

async function winGet(kind) {
    const k = kind + 'Win';
    const st = await chrome.storage.session.get(k);
    if (st[k] == null) return null;
    try { return await chrome.windows.get(st[k]); } catch (e) { return null; }
}

async function lastNormal() {
    try { return await chrome.windows.getLastFocused({ windowTypes: ['normal'], populate: true }); }
    catch (e) { return null; }
}

async function badge() {
    const [g, k] = await Promise.all([winGet('glos'), winGet('karta')]);
    const text = g ? 'REC' : (k ? 'CC' : '');
    if (text) chrome.action.setBadgeBackgroundColor({ color: g ? '#c62828' : '#2e7d32' }).catch(() => { });
    chrome.action.setBadgeText({ text }).catch(() => { });
}

async function openWin(kind, query, base) {
    const w = WIN[kind];
    const pos = (base && base.left != null && base.width)
        ? { left: Math.max(0, w.corner === 'right' ? base.left + base.width - w.W - 24 : base.left + 24),
            top: Math.max(0, base.top + base.height - w.H - 48) } : {};
    // widoczne (fokus) — po starcie okienko samo odda fokus stronie (…_READY)
    const win = await chrome.windows.create({ url: w.url + (query || ''), type: 'popup', width: w.W, height: w.H, focused: true, ...pos });
    await chrome.storage.session.set({ [kind + 'Win']: win.id, [kind + 'Base']: base ? base.id : null });
    dlog('tło', 'okienko ' + kind + ' otwarte (id ' + win.id + ')');
    badge();
    return win;
}

async function glosToggle(from) {
    const open = await winGet('glos');
    if (open) { dlog('tło', '🎤 stop (' + from + ')'); await chrome.windows.remove(open.id).catch(() => { }); return { on: false }; }
    dlog('tło', '🎤 start (' + from + ')');
    await openWin('glos', '', await lastNormal());
    return { on: true };
}

async function kartaToggle(from, tabHint) {
    const open = await winGet('karta');
    if (open) { dlog('tło', '🎧 stop (' + from + ')'); await chrome.windows.remove(open.id).catch(() => { }); return { on: false }; }
    const base = await lastNormal();
    let tab = tabHint && tabHint.id != null ? tabHint : (base && base.tabs ? base.tabs.find((t) => t.active) : null);
    if (!tab || tab.id == null) throw new Error('nie widzę karty z filmem');
    dlog('tło', '🎧 start (' + from + ') na karcie ' + tab.id + ': ' + String(tab.title || tab.url || '').slice(0, 80));
    let sid;
    try { sid = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }); }
    catch (e) { dlog('tło', '❌ tabCapture.getMediaStreamId: ' + (e && e.message || e)); throw e; }
    dlog('tło', 'id strumienia karty OK');
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['glos/overlay.js'] }); dlog('tło', 'nakładka napisów wstrzyknięta'); }
    catch (e) { dlog('tło', '⚠ nakładka nie weszła na stronę: ' + (e && e.message || e)); }
    await chrome.storage.session.set({ kartaTab: tab.id });
    await openWin('karta', '?sid=' + encodeURIComponent(sid) + '&tab=' + tab.id, base);
    const { kartaHistAuto } = await chrome.storage.local.get('kartaHistAuto');
    if (kartaHistAuto) histOpen(base, false).catch((e) => dlog('tło', '⚠ okienko historii: ' + (e && e.message || e)));
    return { on: true };
}

// 📜 Napisy na bieżąco — wysokie okienko przy prawej krawędzi okna Chrome; drugi raz = tylko pokaż
async function histOpen(base, focused) {
    const open = await winGet('hist');
    // [AGENT-EXP] także zminimalizowane — przywróć i wyciągnij na wierzch
    if (open) { await chrome.windows.update(open.id, { state: 'normal', focused: true, drawAttention: true }).catch(() => chrome.windows.update(open.id, { focused: true }).catch(() => { })); return { ok: true }; }
    base = base || await lastNormal();
    const W = 440, H = base && base.height ? Math.max(400, base.height - 80) : 760;
    const pos = base && base.left != null && base.width ? { left: Math.max(0, base.left + base.width - W - 12), top: Math.max(0, base.top + 60) } : {};
    const win = await chrome.windows.create({ url: 'glos/historia.html', type: 'popup', width: W, height: H, focused: focused !== false, ...pos });
    await chrome.storage.session.set({ histWin: win.id });
    dlog('tło', 'okienko „Napisy na bieżąco” otwarte');
    return { ok: true };
}

chrome.windows.onRemoved.addListener(async (id) => {
    const st = await chrome.storage.session.get(['glosWin', 'kartaWin', 'kartaTab', 'glosUiTab', 'histWin']);
    if (id === st.histWin) { await chrome.storage.session.remove('histWin'); return; }
    if (id === st.glosWin) {
        dlog('tło', 'okienko glos zamknięte');
        await chrome.storage.session.remove(['glosWin', 'glosBase', 'glosUiTab']);
        if (st.glosUiTab != null) chrome.tabs.sendMessage(st.glosUiTab, { action: 'GN_PILL', hide: true }, () => { void chrome.runtime.lastError; });
    } else if (id === st.kartaWin) {
        dlog('tło', 'okienko karta zamknięte');
        await chrome.storage.session.remove(['kartaWin', 'kartaBase', 'kartaTab']);
        if (st.kartaTab != null) chrome.tabs.sendMessage(st.kartaTab, { action: 'GN_SUB', hide: true }, () => { void chrome.runtime.lastError; });
    } else return;
    badge();
});

chrome.commands.onCommand.addListener((cmd, tab) => {
    dlog('tło', 'skrót: ' + cmd);
    if (cmd === 'glos-toggle') glosToggle('skrót').catch((e) => dlog('tło', '❌ ' + (e && e.message || e)));
    if (cmd === 'karta-toggle') kartaToggle('skrót', tab).catch((e) => dlog('tło', '❌ ' + (e && e.message || e)));
});

// ---------- Wpisywanie tekstu w pole z kursorem ----------
function probeFrame() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    const tag = el ? el.tagName : '';
    const type = el && el.type ? String(el.type).toLowerCase() : '';
    const editable = !!el && (tag === 'TEXTAREA'
        || (tag === 'INPUT' && ['text', 'search', 'email', 'url', 'tel', ''].indexOf(type) >= 0)
        || el.isContentEditable);
    return { focus: document.hasFocus(), editable, top: window === window.top, tag };
}

function putText(text) {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    if (!el) return 'brak pola';
    const isInput = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
    let before = '';
    try {
        if (isInput) before = el.value.slice(0, el.selectionStart == null ? el.value.length : el.selectionStart);
        else {
            const sel = window.getSelection();
            if (sel && sel.rangeCount) { const r = sel.getRangeAt(0).cloneRange(); r.collapse(true); r.setStart(el, 0); before = r.toString(); }
        }
    } catch (e) { /* bez spacji */ }
    const t = (before && !/\s$/.test(before) && !/^[.,?!:;)\n]/.test(text) ? ' ' : '') + text;
    let ok = false;
    try { ok = document.execCommand('insertText', false, t); } catch (e) { ok = false; }
    if (!ok && isInput) {
        const s = el.selectionStart == null ? el.value.length : el.selectionStart;
        const e2 = el.selectionEnd == null ? s : el.selectionEnd;
        el.setRangeText(t, s, e2, 'end');
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: t }));
        ok = true;
    }
    return ok ? 'ok' : 'execCommand odmówił';
}

async function glosInsert(text) {
    const win = await lastNormal();
    const tab = win && win.tabs && win.tabs.find((t) => t.active);
    if (!tab || tab.id == null) return { ok: false, why: 'brak otwartej karty' };
    let frames;
    try { frames = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: probeFrame }); }
    catch (e) { return { ok: false, why: 'ta strona nie pozwala wpisywać (' + (e && e.message || e) + ')' }; }
    const ok = (frames || []).filter((f) => f.result && f.result.editable);
    const pick = ok.find((f) => f.result.focus) || ok.find((f) => f.result.top) || ok[0];
    if (!pick) return { ok: false, why: 'kliknij najpierw w pole tekstowe na stronie' };
    const res = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [pick.frameId] }, func: putText, args: [text] });
    const r = res && res[0] && res[0].result;
    return r === 'ok' ? { ok: true, where: pick.result.tag } : { ok: false, why: r || 'nie udało się wpisać' };
}

// Plakietka stanu pisania na stronie (pill.js) — wstrzykiwana przy pierwszej wiadomości
async function glosPill(msg) {
    const win = await lastNormal();
    const tab = win && win.tabs && win.tabs.find((t) => t.active);
    if (!tab || tab.id == null) return { ok: false };
    const { glosUiTab } = await chrome.storage.session.get('glosUiTab');
    if (glosUiTab != null && glosUiTab !== tab.id) chrome.tabs.sendMessage(glosUiTab, { action: 'GN_PILL', hide: true }, () => { void chrome.runtime.lastError; });
    await chrome.storage.session.set({ glosUiTab: tab.id });
    const m = { ...msg, action: 'GN_PILL' };
    const send = () => new Promise((res) => chrome.tabs.sendMessage(tab.id, m, () => res(!chrome.runtime.lastError)));
    if (await send()) return { ok: true };
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['glos/pill.js'] }); } catch (e) { return { ok: false }; }
    return { ok: await send() };
}

async function refocus(kind) {
    const k = kind + 'Base';
    const st = await chrome.storage.session.get(k);
    if (st[k] != null) await chrome.windows.update(st[k], { focused: true }).catch(() => { });
    return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.action !== 'string' || msg.action.indexOf('GN_') !== 0) return;
    let p = null;
    switch (msg.action) {
        case 'GN_LOG': dlog(msg.src || '?', msg.msg || ''); sendResponse({ ok: true }); return;
        case 'GN_GLOS_TOGGLE': p = glosToggle('popup'); break;
        case 'GN_KARTA_TOGGLE': p = kartaToggle('popup', null); break;
        case 'GN_STATE': p = Promise.all([winGet('glos'), winGet('karta')]).then(([g, k]) => ({ glos: !!g, karta: !!k })); break;
        case 'GN_GLOS_TEXT': p = glosInsert(String(msg.text || '').slice(0, 5000)); break;
        case 'GN_GLOS_UI': p = glosPill(msg); break;
        case 'GN_GLOS_READY': p = refocus('glos'); break;
        case 'GN_KARTA_READY': p = refocus('karta'); break;
        case 'GN_HIST_OPEN': p = histOpen(null, true); break;
        default: return;
    }
    p.then(sendResponse).catch((e) => { const why = String((e && e.message) || e); dlog('tło', '❌ ' + msg.action + ': ' + why); sendResponse({ ok: false, why }); });
    return true;
});
