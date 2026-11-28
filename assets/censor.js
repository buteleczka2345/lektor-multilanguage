// censor.js — JEDEN cenzor przekleństw Multilektora (WSZYSTKIE języki naraz). [FIX 2026-11-02]
// Wcześniej były dwa cenzory z osobnymi listami: ten (mowa lektora) i cenzor_main.js (wyciszanie oryginalnego dźwięku
// filmu, własna lista „kurw*”). Teraz to jest jedyny silnik słów i jedna lista (wbudowane + własne słowa użytkownika
// „censorCustomWords”; „-słowo” = wyjątek z listy wbudowanej). Używają go:
//   * dokument lektora (offscreen.html, PRZED offscreen.js) — applyText: tekst kwestii przed syntezą,
//   * strony z filmem (świat MAIN, PRZED cenzor_main.js) — findMatches: gdzie w napisie jest przekleństwo → cisza w filmie.
// Obiekt globalny: __lektorCensor (Censor — stara nazwa, tylko na stronach rozszerzenia).
// Krzyżowe kolizje między językami (sv. 'hora' = es. 'godzina') usuwamy z list.
(function (global) {
    'use strict';

    var DEFAULT_MODE = 'remove'; // 'remove' | 'beep' | 'replace' | 'dashes'
    // [AGENT-EXP] 2026-11-17: tryb „dashes” — każde wykryte przekleństwo w tekście kwestii czytanej przez lektora
    // na ten sam ciąg kresek, żeby w zdaniu było widać, że coś zostało wycięte (a nie znikało bez śladu). Napisy na ekranie mają własną maskę (maskText → dashMask) — długość słowa, żeby nie skakało zawijanie.
    var DASH_MASK = '----------';

    // Lista polska (z userscriptu Wszystki14) + kuratorowane listy dla największych
    // języków katalogu „Języki świata”. Odmienione formy wpisujemy osobno —
    // dopasowanie ma granice słów (Unicode \p{L}), więc 'ass' nie łapie w 'class'.
    var LISTS = {
        pl: ['kurwa', 'kurwo', 'kurwu', 'kurwy', 'kurwę', 'kurwą', 'kurwie', 'kurwom',
            'kurwica', 'kurweńka', 'kurwiszcze', 'kurwiący', 'kurwiąca', 'kurwią',
            'kurde', 'kurcze',
            'skurwiel', 'skurwiele', 'skurwiela', 'skurwielowi', 'skurwielu',
            'skurwić', 'skurwiony', 'skurwysyn', 'skurwysyna', 'skurwysynowi', 'skurwysynie',
            'skurwysyny', 'skurwysynów', 'skurwysyński', 'skurwysyneczek', 'skurwysynstwo', 'okurwiony', 'okurwiać',
            'chuj', 'chuja', 'chuju', 'chujowi', 'chujem', 'chuje', 'chujach', 'chujami', 'przechuj',
            'chujowy', 'chujowa', 'chujowe', 'chujowo', 'chujowizna', 'chujek', 'chujnia', 'chujostwo', 'rozchujać',
            'po chuja', 'w chuj', 'do chuja', 'na chuj', 'o chuj', 'chuj wie',
            'jebać', 'jebie', 'jebał', 'jebała', 'jebali', 'jebią', 'jebie', 'jebcie', 'jebańce',
            'jebany', 'jebana', 'jebane', 'jebani', 'jebanych', 'jebaka', 'jebanie', 'jebnięcie', 'jebnięty',
            'wyjebany', 'wyjebać', 'zajebisty', 'zajebiste', 'zajebać', 'zajebany', 'zajebana', 'zajebane', 'zajebiście',
            'rozjebany', 'rozjebać', 'zjebany', 'odjebać', 'podjebać', 'wjebać', 'najebany', 'najebać',
            'przejebany', 'dojebany',
            'pierdolić', 'pierdoli', 'pierdolił', 'pierdola', 'pierdolenie', 'pierdolnięty', 'pierdolnięta',
            'pierdolnik', 'pierdoła', 'spierdolić', 'spierdalaj', 'spierdalać', 'wypierdalać', 'wypierdalaj',
            'odpierdalać', 'wpierdalać', 'popierdolić', 'rozperdolić', 'doperdolić',
            'pierdol', 'pierdole', 'pierdolony', 'pierdolona',
            'pizda', 'pizdy', 'pizdę', 'pizdą', 'pizdzie', 'pizdeczka',
            'cipa', 'cipy', 'cipę', 'cipą', 'cipie', 'cipka', 'cipki', 'cipiasty',
            'kutas', 'kutasa', 'kutasowi', 'kutasem', 'kutasy', 'kutasów', 'fiut', 'fiuty', 'fiutem',
            'gówno', 'gówna', 'gównie', 'gównem', 'gówniany', 'gówniana', 'gowno',
            'gówniarz', 'gówniarze', 'gówniarzeria', 'osrać', 'obsrany', 'obsrana', 'srać', 'nasrać', 'sraczka',
            'szmata', 'szmato', 'szmaty', 'szmatława', 'dziwka', 'dziwki', 'dziwką', 'dziwce',
            'dupa', 'dupy', 'dupę', 'dupą', 'dupie',
            // [FIX 2026-11-25] Uzupełnione formy i derywaty: test na 54 potocznych formach pokazał 24 braki
            // („dupami”, „dupek”, „zasrany”, „wysrał”, „rucham”, „gówniara”…). Celowo POJEDYNCZE formy, nie rdzenie:
            // „dup*” złapałby „duplikat”, „sr*” — „srokę” i „srogi”, „ruch*” — „ruch drogowy” i „ruchomy”.
            'dupami', 'dupach', 'dupkom', 'dupkami', 'dupkach', 'dupka', 'dupki', 'dupków', 'dupek',
            'dupcia', 'dupci', 'dupcią', 'dupnąć', 'dupnął', 'dupnęła', 'dupnięty', 'dupnięta',
            'sram', 'srasz', 'srają', 'srając', 'srający', 'srająca', 'srające', 'srał', 'srała', 'srali',
            'wysrać', 'wysrał', 'wysrała', 'wysrali', 'obsrać', 'obsrał', 'obsrała', 'obsrali',
            'zasrany', 'zasrana', 'zasrane', 'zasrani', 'osrany', 'osrana', 'osrane', 'osrani',
            'gówniara', 'gówniary', 'gówniarski', 'gówniarstwo',
            'skurwysyństwo', 'skurwysyństwa', 'skurwysyństwem', 'skurwysyństw',
            'kurwisko', 'kurwiska', 'kurwiszony', 'kurwiszon',
            'cipsko', 'cipencja', 'fiutek', 'fiutka', 'fiutki', 'kutasik', 'kutasika',
            'rucham', 'ruchasz', 'rucha', 'ruchają', 'ruchał', 'ruchała', 'ruchało', 'ruchali',
            'ruchanie', 'ruchanka', 'ruchacz', 'wyruchać', 'wyruchał', 'wyruchała', 'wyruchanie',
            'cholery', 'cholera', 'cholerny', 'cholerna', 'pieprzyć', 'pieprzony', 'kurwić', 'pierdzić'],
        en: ['fuck', 'fucks', 'fucked', 'fucking', 'fuckin', 'fucker', 'fuckers', 'fuckup', 'fuckups',
            'fuckface', 'fuckwit', 'fucktard', 'clusterfuck', 'motherfucker', 'motherfuckers', 'motherfucking',
            'fuck you', 'fuck off', 'fucked up', 'fuck this', 'fuck that',
            'shit', 'shits', 'shitty', 'shitting', 'shitted', 'shithead', 'shitheads', 'shitface', 'shitless',
            'shitstorm', 'shitfaced', 'bullshit', 'bullshitting', 'horseshit', 'dipshit', 'dipshits', 'apeshit',
            'piece of shit',
            'bitch', 'bitches', 'bitched', 'bitching', 'bitchy', 'bitchass', 'son of a bitch', 'sonofabitch',
            'bastard', 'bastards',
            'ass', 'asses', 'arse', 'arses', 'asshole', 'assholes', 'arsehole', 'arseholes', 'assclown', 'asshat',
            'asswipe', 'asscrack', 'dumbass', 'dumbasses', 'jackass', 'smartass',
            'cunt', 'cunts',
            'dick', 'dicks', 'dickhead', 'dickheads', 'dickwad', 'dickweed', 'dickface', 'prick', 'pricks',
            'wank', 'wanked', 'wanker', 'wankers', 'bollocks', 'bollocking', 'bugger', 'buggered', 'buggers', 'buggering',
            'twat', 'twats',
            'piss', 'pissed', 'pissing', 'piss off', 'crap', 'crappy',
            'damn', 'damned', 'dammit', 'damn it', 'goddamn', 'goddammit', 'goddamnit',
            'douchebag', 'douchebags', 'douche', 'slut', 'sluts', 'slutty', 'sluttiest', 'whore', 'whores', 'whoring',
            'cocksucker', 'cocksuckers', 'cocksucking', 'jerkoff', 'jackoff', 'cum', 'cumshot', 'blowjob', 'handjob',
            'wtf', 'stfu'],
        de: ['scheiße', 'scheisse', 'scheiss', 'scheiß', 'scheißen', 'scheißt', 'geschissen', 'beschissen',
            'scheißkerl', 'scheißkerle', 'scheißdreck', 'scheißhaus', 'scheißtag', 'scheißegal',
            'verdammt', 'verdammte', 'verdammter', 'verdammten', 'verdammtes', 'verdammen',
            'arsch', 'ärsche', 'arschloch', 'arschlöcher', 'arschficker', 'arschfick', 'arschgeige', 'arschtritt',
            'fotze', 'fotzen', 'fotzenlecker',
            'hurensohn', 'hurensöhne', 'hure', 'huren', 'hurenkind',
            'wichser', 'wichserin', 'wichsen', 'gewichst', 'wichst',
            'schwanz', 'schwänze', 'schwanzlutscher',
            'ficken', 'fick', 'fickt', 'fickte', 'fickten', 'gefickt', 'verfickt', 'verfickte', 'fick dich', 'fick mich',
            'miststück', 'miststücke', 'mistkerl', 'mistkerle',
            'leck mich', 'leck mich am arsch', 'am arsch', 'verpiss dich', 'verpiss', 'verpissen',
            'pimmel', 'kacke', 'kacken', 'kackt', 'bescheuert', 'blödmann', 'blöd', 'depp', 'vollidiot', 'trottel'],
        es: ['puta', 'putas', 'puto', 'putos', 'putita', 'putilla', 'putero', 'putería',
            'mierda', 'mierdas', 'mierdero',
            'joder', 'jodido', 'jodida', 'jodidos', 'jodidas', 'jodiendo', 'jódete',
            'cabrón', 'cabron', 'cabrona', 'cabrones', 'cabronas', 'cabronada',
            'coño', 'coños',
            'chinga', 'chingar', 'chingada', 'chingado', 'chingón', 'chingones', 'chingadera', 'chingatumadre',
            'pendejo', 'pendeja', 'pendejos', 'pendejas', 'pendejada', 'pendejadas',
            'carajo', 'carajos',
            'verga', 'vergas',
            'pija', 'pijas',
            'gilipollas', 'gilipollez', 'gilipolleces',
            'hostia', 'hostias',
            'hijo de puta', 'hija de puta', 'hijos de puta', 'hijueputa', 'hijoputa', 'hijo de la chingada',
            'puta madre', 'tu puta madre', 'me cago en', 'me cago',
            'malparido', 'malparida', 'malparidos', 'malparidas',
            'zorra', 'zorras', 'culero', 'culera', 'culeros',
            'cojones',
            'imbécil', 'imbecil', 'imbéciles',
            'huevón', 'huevona', 'huevones',
            'boludo', 'boluda', 'boludos', 'boludas',
            'pelotudo', 'pelotuda', 'pelotudos', 'pelotudez',
            'conchatumadre', 'concha de tu madre', 'la concha de tu madre',
            'maricón', 'maricones', 'mariconazo',
            'mamón', 'mamada', 'mamonazo', 'mamahuevo', 'mamahuevos',
            'polla', 'pollas', 'chupapollas',
            'idiota', 'idiotas', 'estúpido', 'estúpida', 'estúpidos'],
        fr: ['putain', 'putains', 'putain de merde', 'putain de', 'pute', 'putes', 'putasse',
            'merde', 'merdes', 'merdique', 'merdier', 'bordel', 'bordel de merde',
            'salope', 'salopes', 'salaud', 'salauds', 'salopard', 'salopards', 'saloperie', 'saloperies',
            'connard', 'connards', 'connarde', 'connasse', 'connasses', 'conne', 'connerie', 'conneries',
            'enculé', 'encule', 'enculés', 'enculée', 'enculées', 'enculer', 'enculade',
            'nique', 'niquer', 'niqué', 'nique ta mère', 'nique sa mère', 'niquetamère',
            'baise', 'baiser', 'baisé', 'baisée', 'baisés', 'baisées', 'baiseur',
            'foutre', 'foutu', 'foutue', 'foutus', 'foutues', 'va te faire foutre', 'va te faire voir',
            'ta gueule', 'ferme ta gueule', 'casse-toi',
            'pétasse', 'pétasses', 'poufiasse', 'grognasse',
            'fils de pute', 'fille de pute', 'fils de putes',
            'chier', 'chieur', 'chieuse', 'emmerde', 'emmerder', 'emmerdeur', 'emmerdeuse', 'emmerdant',
            'ordure', 'ordures',
            'couille', 'couilles', 'couillon', 'couillons', 'couillonne',
            'bâtard', 'batard', 'bâtards', 'bâtarde',
            'abruti', 'abrutie', 'abrutis', 'débile', 'débiles', 'crétin', 'crétine', 'crétins', 'taré', 'tarée'],
        it: ['cazzo', 'cazzi', 'cazzone', 'cazzoni', 'cazzata', 'cazzate', 'che cazzo', 'cazzo di',
            'merda', 'merde', 'merdoso', 'merdosa', 'merdose', 'merdosi',
            'puttana', 'puttane', 'puttanata', 'puttanate', 'puttaniere',
            'stronzo', 'stronza', 'stronzi', 'stronze', 'stronzata', 'stronzate',
            'troia', 'troie', 'troione', 'troietta',
            'figa', 'fighe', 'fighetta', 'sfiga', 'sfigato', 'sfigata',
            'vaffanculo', 'fanculo', 'affanculo', 'vai a fare in culo', 'in culo',
            'fottiti', 'fottuto', 'fottuta', 'fottuti', 'fottute', 'fottere',
            'minchia', 'minchione', 'minchiate', 'minchiata',
            'coglione', 'coglioni', 'coglionata',
            'bastardo', 'bastarda', 'bastardi', 'bastarde',
            'porco dio', 'porca madonna', 'porca puttana', 'porco zio', 'porco due', 'porca troia',
            'imbecille', 'imbecilli', 'idiota', 'idioti', 'stupido', 'stupida', 'stupidi',
            'testa di cazzo', 'pezzo di merda', 'figlio di puttana', 'figlia di puttana',
            'culo', 'culone', 'incazzato', 'incazzata', 'incazzare',
            'cagare', 'cagata', 'cagate', 'sborra', 'sborrare', 'scopata', 'scopate'],
        pt: ['porra', 'porras', 'porrada', 'porradaria',
            'caralho', 'caralhos', 'caralhada',
            'foda', 'fodas', 'foda-se', 'fodido', 'fodida', 'fodidos', 'fodidas', 'fodão', 'foder', 'fodendo',
            'vai se foder', 'vai-te foder',
            'puta', 'putas', 'puto', 'putos', 'putaria', 'putona',
            'merda', 'merdas', 'merdice', 'que merda', 'merdinha',
            'filho da puta', 'filha da puta', 'filhos da puta', 'fdp',
            'puta que pariu', 'puta que o pariu',
            'vai tomar no cu', 'toma no cu', 'vai pro caralho', 'vai para o caralho',
            'buceta', 'bucetas', 'bucetão',
            'cabrão', 'cabrões',
            'arrombado', 'arrombada', 'arrombados', 'arrombadas',
            'corno', 'cornos', 'corna', 'chifrudo',
            'desgraçado', 'desgraçada', 'desgraçados', 'desgraçadas',
            // [FIX 2026-11-25] BEZ „pica”/„picas”: w polskim to medyczna nazwa zaburzenia łaknienia
            // („Badanie pica i fok w Bałtyku” było wyciszane w całości). Zostaje „piroca”.
            'piroca', 'cacete', 'cacetada', 'cuzinho', 'cuzão',
            'otário', 'otária', 'otários', 'babaca', 'babacas',
            'viado', 'bicha', 'boiola',
            'escroto', 'escrota', 'escrotos', 'escrotas'],
        nl: ['kut', 'kutje', 'kutten', 'kutwijf', 'kutlul', 'lul', 'lullen', 'lulletje',
            'kloot', 'kloten', 'klootzak', 'klootzakken', 'klootviool',
            'hoer', 'hoeren', 'hoerenzoon', 'hoerenjong', 'hoerig',
            'godverdomme', 'verdomme', 'verdomd', 'godver',
            'neuken', 'neukt', 'geneukt', 'neuker',
            'kankerlijer', 'kankerlijers', 'kankerhoer', 'tyfuslijer', 'teringlijer',
            'mierenneuker', 'eikel', 'eikels', 'sukkel', 'sukkels',
            'slet', 'sletten', 'sletterig',
            'reet', 'kont', 'kontgat', 'mietje', 'flikker', 'flikker op', 'opflikkeren',
            'opdonderen', 'optyfen', 'tyf op'],
        ru: ['блядь', 'бляди', 'бля', 'блять', 'блядский', 'блядская', 'блядина', 'блядки', 'блядство',
            'хуй', 'хуя', 'хую', 'хуе', 'хуем', 'хуи', 'хуёвый', 'хуёвая', 'хуйло', 'хуйня', 'хуйню', 'нахуй',
            'пизда', 'пизды', 'пизде', 'пизду', 'пиздой', 'пиздец', 'пиздюлина', 'пиздюк',
            'ебать', 'ебаться', 'ебёт', 'ебет', 'ебал', 'ебала', 'ебали', 'ебанутый', 'ебанутая', 'ебануться',
            'ебаный', 'ебаная', 'ебаное', 'ебаные', 'ёбаный', 'ёбнутый', 'ёбнутая',
            'заебать', 'заебал', 'заебала', 'заебали', 'заебись', 'отъебись', 'въебать', 'въебал',
            'охуеть', 'охуел', 'охуела', 'охуели', 'охуенно', 'охуенный', 'охуенная',
            'сука', 'суки', 'суке', 'суку', 'сучка', 'сучки', 'сучонок', 'сучара',
            'мудак', 'мудаки', 'мудака', 'мудаков', 'мудила', 'мудило',
            'гандон', 'гондон', 'гандоны', 'гондоны',
            'говно', 'говна', 'говнюк', 'говнюки', 'гавно',
            'дерьмо', 'дерьма', 'дерьмовый', 'дерьмовая',
            'хер', 'хера', 'херня', 'херовый', 'херовая', 'похуй', 'похер', 'дохуя', 'нихуя',
            'пидор', 'пидоры', 'пидорас', 'педик', 'пидорский',
            'шлюха', 'шлюхи', 'шлюшка', 'шалава',
            'мразь', 'мрази', 'тварь', 'твари', 'ублюдок', 'ублюдки', 'козёл', 'козел', 'козлы',
            'долбоёб', 'долбоеб', 'дебил', 'дебилы', 'идиот', 'идиоты', 'кретин', 'кретины'],
        uk: ['бля', 'блядь', 'бляди', 'блять', 'бляха', 'блядський', 'блядство',
            'хуй', 'хуя', 'хую', 'хуєм', 'хуї', 'хуйло', 'хуйня', 'нахуй', 'похуй', 'дохуя',
            'пизда', 'пизди', 'пізда', 'пиздєц', 'пиздец', 'піздец', 'пиздюк',
            'сука', 'суки', 'суці', 'сучка', 'сучки',
            'мудак', 'мудаки', 'мудака', 'мудило',
            'говно', 'говнюк', 'лайно', 'дерьмо',
            'ебать', 'єбать', 'єбати', 'йобаний', 'йобана', 'єбаний', 'заїбав', 'заїбал', 'заїбись',
            'курва', 'курво', 'курви', 'курву',
            'шлюха', 'шлюхи', 'шльондра',
            'підар', 'підарас', 'підор', 'гандон', 'гондон',
            'мразь', 'виродок', 'покидько', 'ідіот', 'дебіл'],
        tr: ['orospu', 'orospular', 'orospu çocuğu', 'orospu evladı', 'orospuçocuğu',
            'piç', 'piçler', 'piçlik',
            'siktir', 'siktir git', 'sikeyim', 'sikeceğim', 'siktim', 'siktiğim', 'ananı sikeyim',
            'sik', 'siki', 'sikim', 'sikik', 'sikiş', 'sikerim', 'sikiyorum',
            'amına', 'amına koyayım', 'amına koyim', 'amk', 'amcık', 'amcik', 'amcığı',
            'yarak', 'yaraklar', 'yarram',
            'göt', 'götü', 'götveren', 'götverenler', 'götlek',
            'kahpe', 'kahpeler', 'pezevenk', 'pezevenkler', 'yavşak', 'yavşaklar',
            'şerefsiz', 'şerefsizler', 'aptal', 'aptallar', 'salak', 'salaklar',
            'gerizekalı', 'gerizekali', 'manyak', 'manyaklar'],
        cs_sk: ['kurva', 'kurvy', 'kurvě', 'kurvu', 'kurvou', 'kurví', 'zkurvený', 'zkurvenej', 'skurven', 'skurvený',
            'do prdele', 'prdel', 'prdele', 'prdět', 'vyprdnout', 'zmrd', 'zmrdi',
            'kokot', 'kokoti', 'kokotina', 'kokotice', 'čurák', 'čuráci', 'čůrák',
            'hovno', 'hovna', 'hovado', 'hnůj',
            'do píči', 'píča', 'piča', 'píče', 'piče', 'píčovina', 'pičovina', 'polib mi',
            'jebat', 'jebať', 'jebem', 'jebe', 'jebem ti', 'jebnutý', 'jebnutá', 'zajebaný',
            'sráč', 'sračka', 'srať', 'posrať', 'posraný', 'oserat', 'vyjebat', 'vysrať sa',
            'debil', 'debilní', 'kretén', 'kreténka', 'idiot', 'idioti', 'sprosták', 'volovina', 'vůl'],
        sv: ['jävla', 'jävel', 'jävlar', 'jävligt', 'jävlig', 'jävla skit',
            'helvete', 'helvetes', 'dra åt helvete', 'åt helvete', 'för helvete',
            'kuk', 'kuken', 'kukar', 'kukjävel',
            'fitta', 'fittan', 'fittor',
            'skit', 'skiten', 'skitsnack', 'skitstövel', 'skitungen', 'skitgubbe',
            'knulla', 'knullar', 'knullade', 'knull',
            'röv', 'röven', 'rövhål', 'arsle', 'arslet',
            'piss', 'pissa', 'pissar',
            'satan', 'satan i helvete', 'djävul', 'djävlar', 'djävulens',
            'svin', 'svinet', 'svinpäls', 'mög', 'möglig',
            'idiot', 'idioter', 'dumbom', 'dumskalle', 'korkad', 'pucko', 'puckon', 'fåne', 'nöt'],
        ro: ['curvă', 'curva', 'curve', 'curvi', 'curvar', 'curvărie',
            'futu', 'fut', 'fute', 'futut', 'futută', 'futu-i', 'futui', 'futu-ți mama',
            'muie', 'muist', 'muistă',
            'pizda', 'pizde', 'pizdă',
            'coaie', 'coi', 'coaiele',
            'sloboz', 'slobozi', 'slobozit',
            'pula', 'pule', 'pulă', 'pulii', 'pula mea',
            'căcat', 'căca', 'căcăcios',
            'dracu', 'dracul', 'dracului', 'la dracu',
            'idiot', 'idioată', 'prost', 'proastă', 'tâmpit', 'tâmpită', 'nesimțitule',
            'găozar', 'găozari', 'târfă', 'târfe'],
        hu: ['kurva', 'kurvák', 'kurvát', 'kurvára', 'kurvul', 'kurvafi', 'kurvanyak',
            'szar', 'szaros', 'szarok', 'szarul', 'szarság', 'szarrá', 'szarházi', 'szarzsák',
            'bassza meg', 'basszameg', 'basszus', 'bassza', 'basszátok', 'basszad',
            'baszni', 'baszik', 'baszás', 'baszott', 'baszd meg', 'baszd', 'kibaszott', 'kibaszottul',
            'geci', 'gecik', 'gecis',
            'picsa', 'picsába', 'picsás',
            'fasz', 'faszom', 'faszt', 'faszod', 'faszfej', 'faszszopó',
            'bazmeg', 'bazdmeg', 'bazd meg',
            'szopd', 'szopjál', 'leszop', 'leszopni',
            'anyád', 'anyádat', 'az anyád', 'kurva anyád', 'kurva anyádat',
            'idióta', 'hülye', 'hülyék', 'gyökér', 'köcsög', 'köcsögök', 'pöcs', 'pöcsfej'],
        id: ['anjing', 'anjir', 'anjeng', 'bangsat', 'keparat', 'sialan', 'sial', 'brengsek',
            'tolol', 'goblok', 'goblog', 'bego', 'dungu', 'bodoh',
            'bajingan', 'kampret',
            'kontol', 'memek', 'pepek', 'jembut', 'jancuk', 'jancok',
            'ngentot', 'ngentod', 'ngewe', 'telaso', 'pukimak', 'pantek', 'kimak',
            'sundal', 'sundel', 'pelacur', 'jablay', 'lonte', 'bencong', 'banci'],
        ms: ['bodoh', 'bodohlah', 'bebal', 'bengap', 'bangang', 'sial', 'sialan', 'celaka',
            'pukimak', 'kimak', 'pantat', 'lancau', 'cibai',
            'kontol', 'puki', 'pukima', 'memek', 'tetek', 'butoh',
            'babi', 'anjing', 'setan', 'syaitan', 'goblok',
            'sundal', 'pelacur', 'jalang', 'bapuk'],
        ja: ['くそ', 'クソ', 'くそっ', 'クソッ', 'くそったれ', 'クソッタレ', 'ちくしょう', '畜生',
            'ばかやろう', 'バカヤロー', '馬鹿野郎', 'たわけ', 'あほ', 'アホ', '阿呆', 'ボケ', 'まぬけ', 'マヌケ',
            '死ね', 'しね', 'てめえ', 'テメエ', '手前', 'きさま', '貴様', 'ふざけるな', 'ざけんな',
            'ちんこ', 'ちんぽ', 'まんこ', 'マンコ'],
        ko: ['씨발', '씨발놈', '씨발년', '씨부랄', '씨팔', '좆', '좆같', '좆같은', '좆밥', '지랄',
            '개새끼', '개자식', '새끼', '새끼야', '병신', '병신새끼', '미친놈', '미친년', '미친새끼',
            '썅', '엿', '엿같은', '엿먹어', '니미', '니미럴', '빌어먹을', '꺼져', '뒈져'],
        zh: ['他妈的', '他妈', '妈的', '妈的个逼', '操你妈', '操你祖宗', '干你娘', '干你妈', '日你妈',
            '傻逼', '傻屄', '沙比', '煞笔', '傻鸟', '二逼', '装逼',
            '混蛋', '王八蛋', '王八羔子', '狗屎', '狗屁', '放屁', '滚蛋',
            '贱人', '婊子', '妓女', '屌', '鸡巴', '鸡掰', '龟头', '屁眼', '屁精', '蠢货'],
        vi: ['đụ', 'địt', 'địt mẹ', 'đụ má', 'đụ mẹ', 'cặc', 'lồn', 'lồn mẹ', 'mẹ mày', 'mẹ kiếp',
            'đéo', 'đéo mẹ', 'đm', 'đmm', 'đĩ', 'đĩ điếm', 'điếm', 'cave',
            'thằng chó', 'đồ chó', 'chó má', 'óc chó', 'ngu', 'đồ ngu',
            'khốn', 'khốn nạn', 'khốn kiếp', 'mất dạy', 'súc vật', 'cút', 'cút đi'],
        th: ['ควย', 'ไอ้ควย', 'เหี้ย', 'ไอ้เหี้ย', 'อีเหี้ย', 'สัด', 'ไอ้สัด', 'แตด', 'หี', 'หมอย',
            'เย็ด', 'เย็ดแม่', 'แม่ง', 'อีดอก', 'ดอกทอง', 'ระยำ', 'ชิบหาย', 'ฉิบหาย', 'ไอ้เวร'],
        ar: ['قحبة', 'قحبه', 'قحاب', 'شرموطة', 'شرموط', 'شرموطه', 'عاهرة', 'عاهره', 'زانية', 'زانيه',
            'عرص', 'عرصة', 'خول', 'دياثة', 'خرا', 'خراء', 'زبي', 'زبك', 'منيك', 'منيوك', 'نيك', 'نيكك',
            'كس', 'كسي', 'كسمك', 'طيز', 'طيزك', 'كلب', 'كلبة', 'حمار', 'حمارة', 'غبي', 'غبية',
            'أحمق', 'حيوان', 'حقير', 'تافه', 'يلعن', 'لعنة', 'قذر', 'زبالة', 'وسخ'],
        hi: ['चूतिया', 'चुतिया', 'चूतियापंति', 'मादरचोद', 'मदरचोद', 'बहनचोद', 'भेनचोद', 'रंडी', 'रांड',
            'भोसड़ा', 'भोसड़ी', 'भोसड़ीके', 'गांड', 'गांडू', 'गांडफट', 'चूत', 'चूतड़', 'लौड़ा', 'लंड',
            'हरामखोर', 'हरामी', 'कमीना', 'कमीनी', 'कुत्ता', 'कुत्ती', 'कुत्ते', 'छिनाल', 'छिनाली',
            'झाटू', 'मूत', 'मूतना', 'टट्टी', 'हगना', 'सूअर', 'सूअरी'],
        // [FIX 2026-11-25] BEZ samego „fok”: to polski dopełniacz liczby mnogiej od „foka” („obserwacja fok”).
        // Afrikaans dalej łapie „fokken”, „fok jou”, „fokker”.
        af: ['fokken', 'gefok', 'fokking', 'fokker', 'fokkers', 'fok jou', 'poes', 'kak', 'kakken', 'kakhuis',
            'piel', 'piele', 'pielkop', 'hoer', 'hoere', 'hoerhuis', 'moerse', 'naai', 'naaier',
            'slet', 'slette', 'teef', 'idioot', 'verdomp', 'verdomde'],
        bg: ['кур', 'кура', 'курва', 'курви', 'курво', 'курвар', 'еба', 'ебати', 'ебах', 'ебеш', 'ебем', 'еби',
            'ебало', 'ебане', 'ебав', 'ебаха', 'да еба', 'майка ти', 'путка', 'путки', 'пичка', 'пички',
            'гъз', 'гъзове', 'шибан', 'шибана', 'шибани', 'лайно', 'лайна', 'педераст', 'педерасти',
            'пидер', 'копеле', 'копелета', 'мръсник', 'мръсници', 'идиот', 'идиоти', 'глупак', 'дебил'],
        bn: ['চোদা', 'চুদি', 'চুদ', 'চোদ', 'চোদাচুদি', 'মাদারচোদ', 'মাগীচোদ', 'বোনচোদ', 'ভোদাই', 'ভোদা',
            'খানকি', 'শালা', 'শালী', 'গান্ডু', 'গান্ড', 'কুত্তা', 'বাল', 'ছাগল', 'হারামজাদা', 'হারামি'],
        ca: ['puta', 'putes', 'puto', 'putos', 'merda', 'merdes', 'cabró', 'cabrona', 'cabrons', 'cony', 'collons',
            'fotre', 'fotut', 'fotuda', 'fotuts', 'fill de puta', 'filla de puta', 'maricón', 'hòstia', 'hòsties',
            'pixa', 'punyeta', 'carall', 'carallot', 'gilipolles', 'imbècil', 'idiota', 'estúpid', 'estúpida'],
        cy: ['cachu', 'cythraul', 'diawl', 'diawled', 'sothach', 'pen-ôl', 'penol', 'cont', 'coc'],
        da: ['lort', 'lortet', 'fandens', 'fanden', 'for fanden', 'skid', 'skiden',
            // UWAGA: celowo BEZ 'pis' — kolizja z polskim 'PiS' (partia polityczna).
            'pisse', 'pissede',
            'røv', 'røven', 'røvhul', 'røvhuller', 'kæft', 'hold kæft', 'fisse', 'fissen', 'pik', 'pikken',
            'kusse', 'kussen', 'kneppe', 'knepper', 'kneppede', 'svin', 'svinet', 'møgsvin', 'idiot', 'idioter',
            'dumrian', 'fjols', 'tosse', 'djævel', 'djævle', 'helvede', 'for helvede'],
        el: ['μαλάκας', 'μαλάκα', 'μαλάκες', 'μαλακία', 'μαλακίες', 'πουτάνα', 'πουτάνας', 'πουτάνες',
            'σκατά', 'σκατό', 'σκατένιος', 'γαμώ', 'γαμώτο', 'γαμήσου', 'γαμιέσαι', 'γαμημένος', 'γαμημένη',
            'πούτσα', 'πούτσας', 'πούτσε', 'αρχίδια', 'αρχίδι', 'μουνί', 'μουνιά', 'μουνόπανο',
            'κωλόπαιδο', 'κωλόπαιδα', 'κώλος', 'κώλο', 'ηλίθιος', 'ηλίθια', 'βλάκας', 'βλάκα',
            'καριόλης', 'καριόλα', 'πούστης', 'πούστη', 'πούστες', 'παπάρας'],
        et: ['kurat', 'kuradi', 'kuratlik', 'perse', 'persse', 'perses', 'pask', 'paskane', 'paska',
            'sitt', 'sitane', 'munn', 'munni', 'munniga', 'türa', 'türas', 'lits', 'litsid',
            // UWAGA: celowo BEZ 'hoor' (kolizja z niderlandzkim 'hoor', bardzo częstym)
            // i BEZ 'sita' (kolizja z polskim 'sita' — liczba mnoga od 'sito').
            'hoora', 'raisk', 'raisad', 'neetud', 'pagan', 'loll', 'lollakas', 'idioot'],
        fa: ['کس', 'کسکش', 'کسخل', 'کص', 'کصکش', 'کیر', 'کیری', 'کیرم', 'خایه', 'خایمال', 'جنده', 'جندهخانه',
            'مادرجنده', 'مادرقحبه', 'قحبه', 'گه', 'گهی', 'گهخور', 'عن', 'دیوث', 'بیغیرت', 'کون', 'کونی', 'کونکش',
            'هرزه', 'لاشی', 'لاشخور', 'حرومزاده', 'حرامزاده', 'احمق', 'خرفت', 'کثافت', 'لعنتی', 'بیشرف'],
        fi: ['vittu', 'vittua', 'vitun', 'vittuun', 'vituttaa', 'perkele', 'perkeleen', 'saatana', 'saatanan',
            'jumalauta', 'helvetti', 'helvetin', 'helvettiin', 'paska', 'paskaa', 'paskainen', 'paskahousu',
            'kusipää', 'kusipäät', 'kyrpä', 'kulli', 'kullit', 'huora', 'huorat', 'pillu', 'pillut',
            'nussia', 'nussii', 'nussi', 'runkkari', 'runkata', 'mulkku', 'mulkut', 'perse', 'persreikä',
            'idiootti', 'tyhmä'],
        ga: ['cac', 'cacamas', 'diabhal', 'diabhail', 'ifreann', 'ifrinn', 'striapach', 'bitseach',
            'amadán', 'pleidhce', 'pleidhcí'],
        gu: ['ગાંડુ', 'ગાંડ', 'ભોસડી', 'ભોસડો', 'ચોદ', 'ચોદા', 'લોડો', 'લોડા', 'ચૂતિયો', 'ચૂતિયા',
            'બહેનચોદ', 'માદરચોદ', 'રંડી', 'ખાનખસ', 'ખાનખસી', 'કૂતરો', 'કૂતરી', 'હરામખોર', 'હરામી'],
        hr: ['kurva', 'kurve', 'kurvi', 'kurvo', 'kurvin', 'kurvin sin', 'kurvica',
            'jebi', 'jebem', 'jebeš', 'jebote', 'jebeno', 'jebeni', 'jeben', 'jebena', 'jebem ti', 'jebiga',
            'pizda', 'pizde', 'pizdi', 'pizdarija', 'pizdarije', 'kurac', 'kurca', 'kurcu', 'kučkin', 'kučka',
            'kučke', 'pička', 'pičke', 'pičkica', 'picka', 'picke', 'sranje', 'sranja', 'seronja', 'govno',
            'govna', 'drolja', 'drolje', 'kenjati', 'budala', 'budale', 'idiot', 'idioti', 'kreten', 'kreteni'],
        is: ['andskoti', 'andskotinn', 'andskotans', 'djöfull', 'djöfullinn', 'djöfulsins', 'helvíti', 'helvítis',
            'fjandinn', 'fjandans', 'fokk', 'fokka', 'fokking', 'skítur', 'skít', 'skíta', 'skítlegt',
            'drullusokkur', 'hóra', 'hórur', 'píka', 'píkur', 'typpi', 'rass', 'rassgat', 'hálfviti',
            'hálfvitar', 'bjáni', 'fífl', 'fíflar', 'auli'],
        ka: ['ყლე', 'ყლევ', 'მუტელი', 'ბოზი', 'ბოზები', 'ნაბოზარი', 'ტრაკი', 'ტრაკში', 'შარმუტა',
            'პიდარასტი', 'იდიოტი', 'დებილი'],
        kk: ['ақымақ', 'ақымақтар', 'қотақ', 'қотағы', 'қотақбас', 'анаңды', 'анаң', 'шешеңді', 'шешең',
            'сігу', 'сік', 'сіккіш', 'боқ', 'боғы', 'жезөкше', 'жезөкшелер', 'ойнас', 'ойнасу',
            'нақұрыс', 'есер', 'есуас', 'мисыз'],
        lb: ['scheiss', 'scheiße', 'scheissen', 'scheisskerl', 'scheissdreck', 'fick', 'ficken', 'gefickt',
            'verfickt', 'arsch', 'arschloch', 'ärsche', 'dreck', 'dreckstück', 'dreckeg', 'sau', 'sauerei',
            'saukerl', 'verreck', 'verreckt', 'hurensohn', 'hure', 'huren', 'pimmel', 'fotz', 'fotzen',
            'idiot', 'idioten'],
        lt: ['kurva', 'kurvos', 'kurvai', 'kurvą', 'kurvas', 'bybis', 'bybio', 'bybi', 'pizda', 'pizdos',
            'pizdą', 'pižda', 'piždos', 'šūdas', 'šudo', 'šudai', 'šūdinas', 'varle', 'varlė', 'varlių',
            'pisti', 'pistis', 'pistukas', 'kekšė', 'kekšės', 'paleistuvė', 'rupūžė', 'velnias', 'velniai',
            'velniop', 'kvailys', 'kvailiai', 'durnius', 'durniai'],
        lv: ['kuce', 'kuces', 'kucei', 'kuci', 'maita', 'maitas', 'mēsls', 'mēsli', 'sūds', 'sūdi', 'sūdīgs',
            'pizda', 'pizdas', 'pists', 'pisties', 'pist', 'dirst', 'dirsa', 'dirsā', 'dirsas',
            'velns', 'velna', 'velnu', 'idiots', 'idiotes', 'stulbenis', 'muļķis', 'muļķi', 'kretīns', 'kretīni'],
        mt: ['ħara', 'ħmieġ', 'qahba', 'qahbiet', 'żobb', 'żobba', 'żobbok', 'ostja', 'baħnan', 'iblah', 'imbiċċek'],
        ne: ['मुजी', 'मुजि', 'चिक्ने', 'चिक', 'चिके', 'भोस्डी', 'भोस्दी', 'रान्डी', 'रँडी', 'गन्डु',
            'गाँड', 'गान्ड', 'कुकुर', 'खान्की', 'लाटो', 'लाटा', 'छिनाल', 'छिनाली', 'जारी'],
        no: ['faen', 'faens', 'fanden', 'for faen', 'faen ta deg', 'jævlig', 'jævla', 'jævel', 'jævler',
            'helvete', 'helvetes', 'dra til helvete', 'for helvete', 'dritt', 'drit', 'driten', 'drittsekk',
            'drittsekker', 'dritunge', 'fitte', 'fitta', 'fitter', 'pikk', 'pikken', 'kuk', 'kuken',
            'pikkhode', 'rumpehull', 'ræva', 'ræv', 'rumpa', 'hore', 'horer', 'knulle', 'knuller', 'puler',
            'pult', 'idiot', 'idioter', 'tulling', 'tosk'],
        sl: ['kurba', 'kurbe', 'kurbin', 'kurvin', 'kurva', 'kurve', 'kurvo', 'jebi', 'jebem', 'jebiga',
            'jebeno', 'jebeni', 'jeben', 'jebem ti', 'jebi se', 'zajeban', 'zajebancija', 'pizda', 'pizde',
            'pizdarija', 'pizdarije', 'kurac', 'kurca', 'kurcu', 'kurec', 'pička', 'pičke', 'picka', 'picke',
            'pičkica', 'sranje', 'govno', 'govna', 'dreka', 'drek', 'gnoj', 'gnida', 'prasica', 'prasec',
            'prasci', 'pipec', 'budala', 'budale', 'bedak', 'bedaki', 'idiot', 'idioti', 'kreten', 'kreteni'],
        sr: ['курва', 'курве', 'курво', 'курвин', 'курвин син', 'јеби', 'јебем', 'јеботе', 'јебено', 'јебени',
            'јебен', 'јебем ти', 'јеби се', 'зајебан', 'пичка', 'пичке', 'пичкица', 'курац', 'курца',
            'кучки', 'кучка', 'срање', 'говно', 'говна', 'сератор', 'дроља', 'дроље', 'будала', 'будале',
            'идиот', 'идиоти', 'кретен', 'кретени',
            'kurva', 'kurve', 'kurvo', 'kurvin', 'jebi', 'jebem', 'jebote', 'jebeno', 'jebeni', 'jeben',
            'jebem ti', 'jebi se', 'zajeban', 'picka', 'picke', 'pickica', 'kurac', 'kurca', 'kucka', 'kucke',
            'sranje', 'govno', 'govna', 'serator', 'drolja', 'drolje', 'budala', 'budale'],
        sw: ['malaya', 'mboo', 'mbwa', 'umbwa', 'mavi', 'mjinga', 'wajinga', 'shenzi',
            // UWAGA: celowo BEZ 'kuma' — kolizja z polskim 'kuma' (matka chrzestna).
            'mshenzi', 'washenzi', 'fisi', 'punda'],
        tn: ['masepa', 'tshwene', 'setshwene', 'phoofolo', 'sethoto', 'lefela'],
    };

    // [AGENT-EXP] 2026-10-19: WZORCE Z GWIAZDKĄ (dowolna końcówka) — polska lista wyżej to pojedyncze formy,
    // więc odmiany spoza niej („pierdolisz”, „spierdolił”, „zajebał”, „wkurwiony”, „przejebane”) lektor czytał
    // na głos. Te same rdzenie co w 🤐 Cenzorze filmu (assets/cenzor_main.js). Gwiazdka działa też we własnych
    // słowach z popupu (np. „cholern*”). Celowo BEZ „cip*” (łapałoby angielskie „cipher”) — formy cipa/cipka
    // są na liście wyżej.
    var STEMS = ['kurw*', 'kurew*', 'nakurw*', 'wkurw*', 'zakurw*', 'rozkurw*', 'pokurw*', 'skurwysyn*', 'skurwi*',
        'chuj*', 'huj*', 'pizd*', 'spizdz*', 'wypizdz*', 'przypizdz*', 'zapizdz*', 'popizdz*', 'podpizdz*',
        'dziwk*', 'jeb*', 'wjeb*', 'podjeb*', 'przyjeb*', 'ujeb*', 'zjeb*',
        'pierdol*', 'pierdal*', 'spierdol*', 'spierdal*', 'wypierdol*', 'wypierdal*',
        'odpierdol*', 'odpierdal*', 'napierdal*', 'napierdol*', 'napierdziel*', 'rozpierdal*', 'zapierdal*', 'rozpierdol*', 'zapierdol*',
        'przepierdal*', 'opierdal*', 'wpierdal*', 'dopierdol*', 'dopierdal*',
        'przypierdol*', 'przypierdal*', 'podpierdol*', 'podpierdal*', 'popierdol*', 'popierdal*',
        'zajeb*', 'dojeb*', 'pojeb*', 'najeb*', 'wyjeb*', 'odjeb*', 'rozjeb*', 'przejeb*',
        'fuck*', 'motherfuck*', 'shit*', 'bitch*', 'cunt*'];   // [FIX 2026-11-02] + reszta dawnej listy cenzora dźwięku

    var cfg = { enabled: true, mode: DEFAULT_MODE, custom: [], exclude: Object.create(null) };
    var reBounded = null;   // pisma ze spacjami (łacina, cyrylica, arabski, dewanagari...)
    var reUnbounded = null; // pisma bez spacji (japoński, chiński, tajski) — dopasowanie podciągiem

    function esc(s) {
        return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function parseCustom(v) {
        if (Array.isArray(v)) {
            return v.map(function (x) { return String(x || '').trim().toLowerCase(); }).filter(Boolean);
        }
        return String(v || '').split(/[,;\n]+/)
            .map(function (x) { return x.trim().toLowerCase(); })
            .filter(Boolean);
    }
    // [FIX 2026-11-02] „-słowo” = wyjątek: to słowo (dokładnie ta forma) nie jest cenzurowane, nawet gdy jest na liście
    // wbudowanej albo łapie je rdzeń „kurw*”. Zastępuje dawną opcję „własna lista zamiast wbudowanej” cenzora dźwięku.
    function splitCustom(list) {
        var add = [], ex = Object.create(null);
        list.forEach(function (w) {
            if (w.charAt(0) === '-') { var x = w.replace(/^-+/, '').trim(); if (x) ex[x] = 1; }
            else if (w.replace(/\*+$/, '').length >= 2 || /[\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/.test(w)) add.push(w);   // 1 litera (np. „w”) wycinałaby pół mowy
        });
        return { add: add, ex: ex };
    }
    function excluded(m) { return !!cfg.exclude[String(m || '').toLowerCase()]; }

    // Pisma bez spacji (CJK: han / kana / hangul, oraz tajski) — słowa stykają
    // się bez separatorów, więc granice \p{L} nigdy by nie zadziałały (np.
    // '畜生' w 'この畜生' albo '병신' w '병신아'). Dla nich dopasowujemy podciąg,
    // bez granic. Uwaga: hangul MUSI tu być, inaczej koreańskie słowa z
    // przyrostkami (병신아, 씨발놈아) nigdy się nie dopasują.
    var NO_SPACE_CLS = '\\u0E00-\\u0E7F\\u1100-\\u11FF\\u3040-\\u30FF\\u3130-\\u318F' +
        '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF';
    var NO_SPACE_RE = new RegExp('[' + NO_SPACE_CLS + ']');

    // Do SKLEJANIA spacji nadaje się tylko pismo, które naprawdę nie używa
    // spacji (chiński, japoński, tajski). Koreański używa spacji między
    // wyrazami ('오늘 날씨가 좋네요'), więc hangul NIE może być tutaj —
    // inaczej zlepilibyśmy normalne zdania. Hangul zostaje w klasie
    // dopasowania (NO_SPACE_CLS), bo tam chodzi o przyrostki (병신아).
    var TIGHTEN_CLS = '\\u0E00-\\u0E7F\\u3040-\\u30FF' +
        '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF';
    var TIGHTEN_AFTER = new RegExp('([' + TIGHTEN_CLS + '])\\s+', 'g');
    var TIGHTEN_BEFORE = new RegExp('\\s+([' + TIGHTEN_CLS + '])', 'g');

    // UWAGA: bez flagi 'g' — regex z /g w .test() zapamiętuje lastIndex
    // i dawałby niestabilne wyniki przy kolejnych wywołaniach.
    function isNoSpaceScript(w) {
        return NO_SPACE_RE.test(String(w));
    }

    // [FIX 2026-11-21] Przekleństwa ZAKRYTE w napisach gwiazdkami/krzyżykami: „k***a”, „ch*j”, „f**k”, „p*******ć”,
    // samo „****”. W dźwięku filmu padają w całości, a granice \p{L} rozbijały je na kawałki, więc nie było ciszy.
    // Warunek: 1–3 litery + (≥1 znak maski + litera) albo ≥2 znaki maski. Nie łapie „*śmiech*”, „5*3”, „Mr*”.
    // [FIX 2026-11-25] Sam ciąg gwiazdek dopiero od 4: „***” to w napisach znak sceny/przerwy, nie zakryte słowo.
    var MASKED_RE = /(?<![\p{L}\p{N}*#])\p{L}{1,3}(?:[*#]{1,10}\p{L}{1,5}|[*#]{2,10}\p{L}{0,5})(?![\p{L}\p{N}*#])|(?<![\p{L}\p{N}*])\*{4,}(?![\p{L}\p{N}*])/gu;

    // Budujemy DWA dopasowywacze:
    //  * bounded   — (?<!\p{L}) słowo (?!\p{L}) — nie łapie 'ass' w 'class'
    //  * unbounded — podciąg — dla pism bez spacji, gdzie granice nie istnieją
    function rebuild() {
        var bounded = [];
        var unbounded = [];
        var seen = Object.create(null);
        function add(w) {
            w = String(w || '').trim().toLowerCase();
            if (!w || seen[w]) return;
            seen[w] = 1;
            (isNoSpaceScript(w) ? unbounded : bounded).push(w);
        }
        Object.keys(LISTS).forEach(function (k) { LISTS[k].forEach(add); });
        STEMS.forEach(add);   // [AGENT-EXP] 2026-10-19
        (cfg.custom || []).forEach(add);
        // wyjątki („-słowo”) wypadają z list wbudowanych; formy złapane rdzeniem pomija excluded() przy dopasowaniu
        bounded = bounded.filter(function (w) { return !cfg.exclude[w]; });
        unbounded = unbounded.filter(function (w) { return !cfg.exclude[w]; });
        // [AGENT-EXP] 2026-10-19: „rdzeń*” = rdzeń + dowolne litery (kurw* → kurwa, kurwami, kurwiszon…).
        function pat(w) {
            if (w.length > 2 && w.charAt(w.length - 1) === '*') return esc(w.slice(0, -1)) + '\\p{L}*';
            return esc(w.replace(/\*+$/, ''));
        }
        function build(arr, withBounds) {
            if (!arr.length) return null;
            // Dłuższe warianty pierwsze — alternacja łapie najdłuższe dopasowanie.
            arr.sort(function (a, b) { return b.length - a.length; });
            var body = arr.map(withBounds ? pat : esc).join('|');
            if (withBounds) {
                try {
                    return new RegExp('(?<!\\p{L})(?:' + body + ')(?!\\p{L})', 'giu');
                } catch (e) {
                    // Staruszkowa przeglądarka bez lookbehind — cenzura ryzykowna, ale działamy.
                    try { return new RegExp('(?:' + body + ')', 'gi'); } catch (e2) { return null; }
                }
            }
            try { return new RegExp('(?:' + body + ')', 'gu'); } catch (e) { return null; }
        }
        reBounded = build(bounded, true);
        reUnbounded = build(unbounded, false);
    }

    // Tekst kwestii → tekst po cenzurze (może być pusty — silnik wtedy milczy).
    function applyText(text) {
        var t = String(text || '');
        if (!cfg.enabled || !t) return t;
        if (reBounded === null && reUnbounded === null) rebuild();
        var rep;
        if (cfg.mode === 'beep') {
            rep = function () { return '[BEEP]'; };
        } else if (cfg.mode === 'replace') {
            rep = function (m) { return m.charAt(0) + new Array(m.length).join('*'); };
        } else if (cfg.mode === 'dashes') {
            rep = function () { return DASH_MASK; };
        } else {
            rep = function () { return ' '; };
        }
        var sub = function (m) { return excluded(m) ? m : rep(m); };   // [FIX 2026-11-02] „-słowo” zostaje
        // Najpierw granice słów (bezpieczniejsze), potem podciągi (CJK / tajski).
        if (reBounded) t = t.replace(reBounded, sub);
        if (reUnbounded) t = t.replace(reUnbounded, sub);
        t = t.replace(MASKED_RE, sub);   // [FIX 2026-11-21] „k***a” itp. — lektor nie czyta „k gwiazdka a”
        t = t.replace(/\s{2,}/g, ' ')
            .replace(/\s+([,.!?;:…])/g, '$1')
            .replace(TIGHTEN_AFTER, '$1')
            .replace(TIGHTEN_BEFORE, '$1');
        return t.replace(/^[\s,;:]+/, '').replace(/\s+$/, '');   // [AGENT-EXP] 2026-10-19: bez „, stary.” po wycięciu
    }

    // [AGENT-EXP] 2026-11-17: napisy NA EKRANIE (tryb „Kreski”) — to samo zdanie, ale tylko same słowa zamienione
    // na kreski. Bez sprzątania spacji i interpunkcji: to widoczny tekst odtwarzacza, nie mowa lektora, więc nic
    // poza przekleństwem nie może się przesunąć. Użycie: cenzor_main.js (podmiana w DOM napisów).
    // [FIX 2026-11-25] Kreski dokładnie tej długości co słowo. Wcześniej KAŻDE przekleństwo dostawało 10 kresek,
    // więc „kurwa” (5) rozciągała napis, a „chuj” (4) też — linia zmieniała szerokość i przeskakiwało zawijanie.
    function dashMask(word) {
        var w = String(word || ''), n = 0;
        for (var i = 0; i < w.length; i++) {
            var c = w.charCodeAt(i);
            if (c >= 0xD800 && c <= 0xDBFF && i + 1 < w.length) i++;   // para zastępcza = jeden znak
            n++;
        }
        return new Array(Math.max(2, n) + 1).join('-');
    }

    function maskText(text) {
        var t = String(text || '');
        if (!t) return t;
        if (!/[\p{L}\p{N}]/u.test(t)) return t;   // [FIX 2026-11-25] sam znak sceny („***”) — nie ruszamy napisu
        var ms = findMatches(t);
        if (!ms.length) return t;
        var out = '', last = 0;
        ms.forEach(function (m) {
            if (m.index < last) return;   // nakładające się dopasowania (dwa regexy) — liczy się pierwsze
            out += t.slice(last, m.index) + dashMask(m.word);
            last = m.index + String(m.word).length;
        });
        return out + t.slice(last);
    }

    // [FIX 2026-11-02] Gdzie w tekście są przekleństwa: [{ word, index }] (rosnąco). Niezależnie od „cenzura w mowie
    // lektora wł./wył.” — z tego korzysta wyciszanie oryginalnego dźwięku filmu (cenzor_main.js), które ma własny przełącznik.
    function findMatches(text) {
        var t = String(text || ''), out = [], m;
        if (!t) return out;
        if (reBounded === null && reUnbounded === null) rebuild();
        [reBounded, reUnbounded].forEach(function (re) {
            if (!re) return;
            re.lastIndex = 0;
            while ((m = re.exec(t))) {
                if (!excluded(m[0])) out.push({ word: m[0], index: m.index });
                if (m.index === re.lastIndex) re.lastIndex++;
            }
        });
        // [FIX 2026-11-21] zakryte gwiazdkami — tylko tam, gdzie żadna lista nic nie znalazła
        MASKED_RE.lastIndex = 0;
        while ((m = MASKED_RE.exec(t))) {
            var mi = m.index, me = mi + m[0].length;
            var dup = out.some(function (o) { return o.index < me && o.index + String(o.word).length > mi; });
            if (!dup && !excluded(m[0])) out.push({ word: m[0], index: mi });
        }
        return out.sort(function (a, b) { return a.index - b.index; });
    }

    function applySettings(s) {
        if (!s || typeof s !== 'object') return;
        if (s.censorEnabled !== undefined) cfg.enabled = !!s.censorEnabled;
        if (s.censorMode !== undefined && ['remove', 'beep', 'replace', 'dashes'].indexOf(s.censorMode) >= 0) cfg.mode = s.censorMode;
        if (s.censorCustomWords !== undefined) {
            var sp = splitCustom(parseCustom(s.censorCustomWords));   // [FIX 2026-11-02] „-słowo” = wyjątek
            cfg.custom = sp.add;
            cfg.exclude = sp.ex;
        }
        reBounded = null; reUnbounded = null; // przebuduj przy najbliższym tekście
    }

    function langCount() {
        return Object.keys(LISTS).length;
    }

    function wordCount() {
        var n = 0;
        Object.keys(LISTS).forEach(function (k) { n += LISTS[k].length; });
        return n + (cfg.custom || []).length;
    }

    var api = {
        applyText: applyText,
        maskText: maskText,   // [AGENT-EXP] 2026-11-17: napisy na ekranie (kreski zamiast przekleństw)
        findMatches: findMatches,   // [FIX 2026-11-02] wyciszanie dźwięku filmu
        applySettings: applySettings,
        langCount: langCount,
        wordCount: wordCount
    };
    global.__lektorCensor = api;
    // stara nazwa tylko na stronach rozszerzenia — na stronach z filmem (świat MAIN) nie zajmujemy globalnego „Censor”
    try { if (global.location && global.location.protocol === 'chrome-extension:') global.Censor = api; } catch (e) {}
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this));
