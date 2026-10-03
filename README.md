# Lektor Multilanguage v3.0.6

Rozszerzenie Chrome (Manifest V3), które **czyta napisy filmów i serialów na głos** po polsku — na YouTube, Netflix, Prime Video, Amazon, iQIYI, IQ, Dailymotion i Rumble.

Działa **w całości offline**: synteza mowy odbywa się na Twoim komputerze przez silnik [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (VITS). Żadnych chmur, żadnych kluczy API, nic nie wychodzi do internetu.

> ⚠️ Narzędzie czyta tylko napisy widoczne w filmie. Nie pobiera wideo, nie omija DRM, nie łamie ochrony regionalnej.

---

## Czym to jest

Rozszerzenie wychwytuje napisy ze strony (oś czasu, plik TTSS/TTML albo `textTracks`), przesuwa je o wybrany offset i zamienia na mowę syntezowaną lokalnie. Głos miesza się z filmem przez ducking — gdy lektor mówi, film cichnie, a w pauzach wraca do normy.

**Obsługiwane serwisy:** YouTube · Netflix · Prime Video · Amazon Video · iQIYI · IQ.com · Dailymotion · Rumble

---

## Instalacja

### 1. Pobierz kod i modele

Repozytorium zawiera **tylko kod** (0,5 MB). Modele głosu mają 182 MB, więc trzymam je w [Release](https://github.com/buteleczka2345/lektor-multilanguage/releases) jako archiwum.

1. **Download ZIP** tego repo (strona główna → Code → Download ZIP) i rozpakuj.
2. Pobierz `lektor-multilanguage-models-v1.0.0.zip` z zakładki **Releases**.
3. Rozpakuj go **do katalogu z `manifest.json`** — modely muszą trafić do `sherpa/`, tak aby finalnie wyglądało to tak:

```
manifest.json
assets/
src/
sherpa/
  sherpa-onnx-tts.worker.js        ← w repo
  sherpa-onnx-wasm-main-tts.js     ← w repo
  sherpa-onnx-tts.js               ← w repo
  sherpa-espeak-data-files.js      ← w repo
  sherpa-onnx-wasm-main-tts.wasm   ← z archiwum modeli
  sherpa-onnx-wasm-main-tts.data   ← z archiwum modeli
  merged_models.json               ← z archiwum modeli
  vits-piper-pl_PL-meski_wg_glos-medium/
    pl_PL-meski_wg_glos-medium.onnx
    pl_PL-meski_wg_glos-medium.onnx.json
    tokens.txt
    espeak-ng-data/
```

### 2. Wgraj rozszerzenie

1. Otwórz `chrome://extensions`.
2. Włącz **Tryb dewelopera** (prawy górny róg).
3. **Załaduj rozpakowane** (*Load unpacked*) i wskaż katalog z `manifest.json`.
4. Wejdź na film i **odśwież kartę (F5)** — skrypty muszą się wstrzyknąć przy ładowaniu strony.

### Wymagania

**Chrome 111+** (potrzebny świat MAIN w content scripts). Działa też na Edge, Brave, Opera i innych przeglądarkach Chromium.

⚠️ Przy pierwszym uruchomieniu model się ładuje — trwa to kilkanaście sekund. Pierwsze zdanie lektor powie z opóźnieniem, kolejne płynnie.

---

## Ustawienia (popup)

| Ustawienie | Co robi |
|---|---|
| **Lektor** | Główny włącznik. |
| **Głos** | Wbudowany głos męski (Sherpa VITS, PL). Jest tylko jeden — paczka zawiera dokładnie jeden model. |
| **Własny głos** | Wgraj własny model `.onnx` + `tokens.txt` + `.onnx.json` z dysku. |
| **Cenzura przekleństw** | Usuwa przekleństwa z tekstu przed syntezą — wszystkie języki naraz. Tryby: usuń / beep / zamień. Własne słowa po przecinku. |
| **Długość słowa** | Jak długo trzymać ciszę po trafionym fragmencie. |
| **Tylko samo słowo** | Wycisza ciasno samo słowo zamiast całej kwestii. |
| **Języki świata** | Katalog głosów dla innych języków, pobieranych przez `merged_models.json`. |
| **Czas wyprzedzenia** | O ile wcześniej lektor zaczyna zdanie (ms). |
| **Przesunięcie** | Globalny offset lektora względem obrazu — ujemna wartość = wcześniej. |
| **Ducking** | Głośność filmu w trakcie czytania (0–100%). |
| **Głośność / prędkość** | Głośność lektora i tempo mowy. |

---

## Wielojęzyczność

Wbudowany głos to **Piper `pl_PL-meski_wg_glos-medium`** — jedyny model dołączony do paczki, ładowany z dysku przy pierwszym uruchomieniu.

Poza tym popup ma sekcję **„Języki świata"**, która pozwala pobrać dodatkowe głosy przez internet. Katalog `sherpa/merged_models.json` zawiera **1379 pozycji**, z czego **1333 są obsługiwane** i widoczne w interfejsie:

| Rodzina | Głosów | Język / zastosowanie | Pobieranie |
|---|---:|---|---|
| **MMS** (Meta) | 1138 | praktycznie każdy język świata | ✅ |
| **Piper** | 169 | wysokiej jakości, głównie europejskie | ✅ |
| **Coqui** | 25 | bg, cs, da, de, en, es, et, fi, fr, ga, hr, lt, lv, mt, nl, **pl**, pt, ro, sk, sl, sv, uk | ✅ |
| **Cantonese** | 1 | zh-HK | ✅ |

Głos MMS, Coqui i Cantonese mają własny `tokens.txt` i nie korzystają z espeak-ng. Piper używa go do fonetyzacji — dlatego dla niego paczka zawiera katalog `espeak-ng-data` (355 plików).

Uwaga: 5 pozycji MMS (`mms_amh`, `mms_guk`, `mms_kor`, `mms_sgw`, `mms_tir`) wypada z filtra, bo w katalogu mają `url` ustawione na `"Not available"` — bez adresu nie ma skąd ich pobrać.

### Czego katalog nie udostępnia

Z 46 pozycji katalogu **nie da się pobrać przez to rozszerzenie**. Świadomie je odfiltrowano — zarówno w `langNormalizeCatalog()` (`popup.js`), gdzie każdy głos musi przejść przez jeden z czterech rozpoznanych wzorców, jak i dlatego, że silnik nie potrafi ich obsłużyć:

- **Kokoro** (3 pozycje: `kokoro-en-en-19`, `kokoro-zh_en-int8-multi`, `kokoro-zh_en-multi-lang`) — Kokoro w sherpa-onnx wymaga osobnej funkcji konfiguracji (`initSherpaOnnxKokoroModelConfig`) i innego formatu pakietów niż VITS. Rozszerzenie wywołuje wyłącznie `offlineTtsVitsModelConfig`, więc Kokoro nie ma czego użyć. Dodanie go wymagałoby nowej ścieżki syntezy w workerze i nowej ścieżki pobierania w popupie.
- **mimic3 / melo / icefall / zh-fs / ljs / vctk** (38 pozycji) — ich repozytoria na Hugging Face są *gated* i wymagają konta oraz tokenu API, więc pobranie bez zalogowania zwraca 401.
- **mms_amh, mms_guk, mms_kor, mms_sgw, mms_tir** (5 pozycji) — brak adresu pobierania w katalogu (`url` = `"Not available"`).

Razem: 3 + 38 + 5 = **46 pozycji odfiltrowanych**, 1379 − 46 = **1333 widocznych w interfejsie**.

Jeśli potrzebujesz któregoś z tych głosów, działa **sekcja „Własny głos"** — wgrywasz pliki `.onnx` + `tokens.txt` + `.onnx.json` z dysku ręcznie.

---

## Jak to działa

```
Strona (content script)          → wykrywa napisy + oś czasu
  └─ TTS_PRELOAD / TTS_PLAY      → wiadomości
Service worker (background.js)   → routing, pamięć ustawień
  └─ offscreen (offscreen.js)    → synteza sherpa-onnx (WASM)
      └─ pula workerów (6)       → równoległa synteza
          └─ espeak-ng + model Piper PL
```

**Pula workerów.** `SHERPA_POOL_SIZE = 6` — sześć równoległych wątków syntezy. Wartość dobrana benchmarkiem 2026-09-16: burst 3,9× szybciej, strumień −46% czasu vs. jeden wątek. Każdy worker to ~0,35–0,5 GB RAM.

**Świat MAIN.** Skrypty działają w `world: "MAIN"`, żeby widzieć te same obiekty, co odtwarzacz strony.

**Rozmiar jest wspólny, nie per-karta.** Kolejka odtwarzania (`playQueue`, maks. 4 zdania) i przełącznik `enabled` dotyczą całego rozszerzenia. Otwarte karty z filmem zgłaszają się do tej samej kolejki — przy przejściu na inną kartę stara kolejka dokańcza się normalnie.

**Synteza wyprzedzająca.** Zdania są generowane zanim się odezwą (`lookaheadMin`), dzięki czemu lektor nie gubi się przy krótkich zdanach. Gotowe audio trzymane jest w `audioCache` (do 120 pozycji, LRU).

---

## Prywatność

- Uprawnienia: `activeTab`, `storage`, `offscreen`, `downloads` + jawna lista domen filmowych.
- **Synteza w 100% lokalna.** Model działa w WebAssembly w pamięci rozszerzenia. Napisy nie opuszczają komputera.
- Jedyne wyjście do sieci to opcjonalne **pobieranie głosów** z katalogu, gdy sam je wybierzesz w sekcji „Języki świata".
- Zero telemetrii, zero analityki, zero konta.

---

## Licencja

MIT — patrz [LICENSE](LICENSE).

Modele głosu (Piper `pl_PL-meski_wg_glos-medium`, sherpa-onnx, espeak-ng) są objęte **własnymi licencjami** swoich autorów — patrz pliki w katalogu modelu oraz <https://k2-fsa.github.io/sherpa/onnx/tts/license.html>.
