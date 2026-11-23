// [AGENT-EXP] 2026-10-24 podział na zdania — wspólny dla workera i engine.js (dzielenie długiej kwestii między workery).
// Jak splitSentences w Space: zdanie krótsze niż minChars łączy się z następnym (krótkie syntezują się mniej stabilnie).
export function splitSentences(text, minChars = 40) {
    const parts = (text.replace(/\s+/g, ' ').match(/[^.!?…]+[.!?…]+[”"»)]*\s*|[^.!?…]+$/g) || []).map((x) => x.trim()).filter(Boolean);
    const out = [];
    for (const x of parts) {
        if (out.length && (!/\p{L}/u.test(x) || out[out.length - 1].length < minChars)) out[out.length - 1] += ' ' + x;
        else out.push(x);
    }
    if (out.length > 1 && out[out.length - 1].length < minChars) { const last = out.pop(); out[out.length - 1] += ' ' + last; }
    return out;
}
