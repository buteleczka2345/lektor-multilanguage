# Multilektor 3.7.3

Rozszerzenie do przeglądarek Chrome / Edge (Manifest V3), które **czyta napisy z filmów i seriali głosem lektora** (text-to-speech), dzięki czemu możesz słuchać tłumaczenia zamiast go czytać na ekranie.

---

## Co to w zasadzie jest?

Multilektor to **wielojęzyczny lektor napisów** dla stron streamingowych. Pobiera napisy wyświetlane na stronie (YouTube, Netflix, Prime Video i wiele innych) i odtwarza je głosem syntetycznym w czasie rzeczywistym. Działa jak osobisty lektor filmowy wbudowany w przeglądarkę — nie musisz szukać zewnętrznych plików z napisami ani korzystać z osobnych programów do tłumaczenia.

---

## Jak to działa?

1. **Wykrywanie napisów** – rozszerzenie wstrzykuje skrypty do stron obsługiwanych serwisów (np. YouTube, Netflix, Prime Video, Dailymotion, Rumble, Viki, Bilibili) i przechwytuje napisy wyświetlane na ekranie.
2. **Przetwarzanie tekstu** – napisy są przekazywane do silnika TTS (text-to-speech), który zamienia je na mowę.
3. **Odtwarzanie głosu** – lektor czyta napisy po polsku (lub innym wybranym języku) zsynchronizowanie z obrazem.
4. **Dodatkowe narzędzia** – wbudowany cenzor, odszumiacz dźwięku, łowca napisów, tłumacz AI napisów, OCR (rozpoznawanie tekstu z obrazu) oraz nagrywanie wypowiedzi lektora do pliku WAV.

---

## Główne funkcje

| Funkcja | Opis |
|---------|------|
| **Lektor napisów** | Czyta napisy z ekranu głosem (Sherpa VITS lub Matcha TTS) w czasie rzeczywistym |
| **Obsługa wielu platform** | Netflix, YouTube, Prime Video, Amazon, IQ.com, IQiyi, Dailymotion, Rumble, Viki, Wet.vip, Bilibili, HBO Max, Max |
| **Cenzor** | Filtruje niechciane słowa w mowie lektora i dźwięku filmu |
| **Łowca napisów** | Wyszukuje napisy online dla oglądanego filmu/serialu |
| **AI Subtitle Translator** | Tłumaczy napisy z użyciem sztucznej inteligencji |
| **OCR** | Rozpoznawanie tekstu z wbudowanych napisów w wideo |
| **Nagrywanie lektora (REC)** | Zapisuje wypowiedzi lektora do pliku audio WAV |
| **Karta głosowa** | Odszumianie, wybór języka filmu, tryb lektora / same napisy |
| **Popup z zakładkami** | Szybka obsługa z ikony rozszerzenia (Lektor, Napisy, Głosy, Narzędzia) |
| **Strona ustawień** | Pełna konfiguracja domen, głosów, cenzury, skrótów klawiszowych (Alt+Shift+1 / Alt+Shift+2) |

---

## Na czym polega działanie technologiczne?

- **JavaScript (ES Modules), HTML, CSS**
- **Chrome Extension API** (offscreen, storage, scripting, tabCapture, webRequest)
- **Sherpa-ONNX / VITS Piper** – synteza mowy po polsku
- **Matcha TTS** – alternatywny silnik głosu
- **espeak-ng** – baza głosów i fonemów
- **PaddleOCR / silnik OCR** – rozpoznawanie tekstu z obrazu
- **IndexedDB** – pamięć podręczna napisów i sesji nagrań

---

## Czy można modyfikować?

**Tak.** Kod jest otwarty i możesz go swobodnie pobierać, zmieniać, rozwijać i dostosowywać do własnych potrzeb.

Jeśli chcesz wprowadzić własne zmiany:

1. Sklonuj repozytorium:
   ```bash
   git clone https://github.com/buteleczka2345/lektor-multilanguage.git
   ```
2. Wprowadź zmiany w kodzie (np. nowe języki, inne głosy, dodatkowe serwisy streamingowe).
3. Załaduj rozszerzenie w trybie deweloperskim w Chrome/Edge (`chrome://extensions` → „Tryb deweloperski” → „Wczytaj wypakowane”).
4. W razie potrzeby utwórz własne fork i rozwijaj dalej.

Wszystkie pliki źródłowe znajdują się w folderach:
- `src/` – logika rozszerzenia (tło, treści, popup, opcje, offscreen)
- `assets/` – skrypty stron, lektor_bar, cenzor, i18n i inne zasoby
- `glos/` – moduły głosowe i TTS
- `supertonic/` – silnik TTS (SuperTonic)
- `sherpa/` – głos Sherpa VITS
- `ocr/` – zasoby OCR
- `ppocr/` – PaddleOCR
- `matcha_web/` – Matcha TTS

---

## Zachęta do współpracy

Ten projekt powstał, by ułatwiać oglądanie filmów i seriali osobom, które wolą słuchać tłumaczenia niż czytać napisy. Jeśli kod Ci się podoba:

- **Gwiazdkuj repozytorium** ⭐ — daj znać, że projekt jest przydatny.
- **Rozwijaj go** — dodaj nowe języki, głosy, obsługę kolejnych platform streamingowych.
- **Zgłaszaj błędy i pomysły** — otwieraj Issues na GitHubie.
- **Tworz Pull Requesty** — dziel się swoimi ulepszeniami z innymi użytkownikami.

Wspólnie możemy zrobić z Multilektora jeszcze lepsze narzędzie dla społeczności!

---

## Licencja

Projekt udostępniany jest na licencji LICENSE (plik w repozytorium). Możesz go swobodnie używać i modyfikować zgodnie z jej warunkami.

---

**Autor:** buteleczka2345  
**Wersja:** 3.7.3  
**Repozytorium:** https://github.com/buteleczka2345/lektor-multilanguage