/**
 * Every visible word lives here. Keeps the voice consistent and makes another
 * language a matter of swapping this one file.
 */
export const T = {
  appName: 'All in One Downloader',

  nav: {
    sources: 'Kaynaklar',
    library: 'Kitaplık',
    vault: 'Kasa',
    settings: 'Ayarlar',
    categories: 'Kategoriler',
    allCategories: 'Tümü',
    uncategorized: 'Kategorisiz',
    newCategory: 'Kategori ekle',
  },

  compose: {
    placeholder: 'Bağlantı yapıştır — sayfadaki videoları çıkarayım',
    submit: 'Çözümle',
    working: 'Çözümlüyor',
    proxy: 'VPN',
    proxyOnHint:
      'Bu bağlantı vekil sunucu üzerinden çözümlenip indirilecek. Kapatmak için tıkla.',
    proxyOffHint:
      'Bu bağlantı doğrudan, vekilsiz gidecek. Vekil üzerinden eklemek için tıkla.',
    clipboard: 'Panoda bir bağlantı var',
    clipboardAdd: 'Ekle',
    multiHint: 'birden fazla bağlantıyı aynı anda yapıştırabilirsin',
  },

  topbar: {
    throughput: 'Akış',
    active: 'aktif',
    queued: 'sırada',
    idle: 'boşta',
    openFolder: 'İndirme klasörünü aç',
  },

  source: {
    probing: 'Çözümlüyor…',
    waiting: 'Sırada — önündeki bağlantı bitince başlıyor.',
    resolving: 'yt-dlp tanımadı, kendi çözümleyicim deniyor',
    itemsOne: 'öğe',
    downloaded: 'indi',
    rescan: 'Yeniden tara',
    capture:
      'Tarayıcıda yakala — pencere açılır, reklamı/doğrulamayı sen geçersin, akışı ben yakalarım',
    openPage: 'Sayfayı aç',
    removeSource: 'Kaynağı kaldır',
    downloadAll: 'Tümünü indir',
    empty: 'Bu sayfada indirilebilir bir şey bulunamadı.',
    enriching: (n: number) => `${n} öğenin bilgisi alınıyor…`,
    collapse: 'Daralt',
    expand: 'Genişlet',
  },

  item: {
    download: 'İndir',
    queued: 'Sırada',
    inQueue: 'Sırada',
    downloading: 'İniyor',
    done: 'İndi',
    failed: 'Hata',
    remove: 'Listeden çıkar',
    openPage: 'Kaynak sayfayı aç',
    live: 'CANLI',
    audioOnly: 'Sadece ses',
    quality: 'Kalite',
    unknownDuration: 'süre bilinmiyor',
    sizeExact: 'Sunucunun bildirdiği dosya boyutu',
    sizeEstimateHint: 'Tahmini boyut: bit hızı × süre. Seçtiğin kaliteye göre değişir.',
  },

  quality: {
    best: 'En iyi',
    audio: 'Sadece ses',
  },

  library: {
    active: 'Süren aktarımlar',
    finished: 'Tamamlananlar',
    problems: 'Hatalı ve iptal edilenler',
    searchPlaceholder: 'Başlık, site, kategori',
    pause: 'Duraklat',
    resume: 'Sürdür',
    cancel: 'İptal et',
    retry: 'Tekrar dene',
    open: 'Dosyayı aç',
    reveal: 'Klasörde göster',
    remove: 'Kayıttan sil',
    removeWithFile: 'Dosyayla birlikte sil',
    toVault: 'Kasaya taşı',
    movingToVault: 'Şifreleniyor…',
    movedToVault: 'Dosya şifrelenip kasaya alındı.',
    remaining: 'kaldı',
    sizeEstimate: 'tahmini boyut',
    setCategory: 'Kategori',
    clearDone: 'Tamamlananları temizle',
    clearFailed: 'Hataları temizle',
    from: 'kaynak',
    stageMerging: 'Birleştiriliyor',
    stageProcessing: 'İşleniyor',
    stageStarting: 'Başlıyor',
    of: '/',
    fileMissing: 'Dosya bulunamadı',
  },

  empty: {
    sourcesTitle: 'Henüz bir kaynak yok',
    sourcesBody:
      'Yukarıya bir bağlantı yapıştır. Sayfadaki videoları, playlistleri ve gömülü kayıtları çıkarıp burada listeler. İndirmesen bile liste kalır.',
    libraryTitle: 'Kitaplık boş',
    libraryBody: 'Kaynaklar sekmesinden bir öğe indir; buraya düşer, kategoriye ayırabilirsin.',
    filterTitle: 'Bu filtreye uyan kayıt yok',
    filterBody: 'Aramayı temizle veya başka bir kategori seç.',
  },

  settings: {
    title: 'Ayarlar',
    sectionFiles: 'Dosyalar',
    sectionTransfer: 'Aktarım',
    sectionMedia: 'Biçim',
    sectionAccess: 'Erişim',
    sectionSubs: 'Altyazı',
    sectionApp: 'Uygulama',

    subsKey: 'OpenSubtitles API anahtarı',
    subsKeyHint:
      'opensubtitles.com hesabından ücretsiz alınır (Consumers → New Consumer). Anahtar olmadan altyazı araması çalışmaz.',
    subsLangs: 'Altyazı dilleri',
    subsLangsHint: 'Sırayla denenir. Örn. tr,en',
    subsAuto: 'İndirme bitince uygun altyazıyı kendiliğinden ekle',
    subsSync: 'Ada göre bulunan altyazıyı sesle hizala',
    subsEmbed: 'Altyazıyı video dosyasına göm',
    subsSkipSame: 'Videonun sesi zaten o dildeyse altyazı ekleme',
    blocker: 'Reklam ve izleyici engelleme',
    blockerHint:
      'Çözümleyicinin tarayıcısı, bilinen reklam ağlarına ve izleyicilere yapılan istekleri iptal eder — pop-up açılmaz ve sayfa daha hızlı yüklenir. Liste 200\'ün üzerinde alan adı içeriyor: pop-under ağları, reklam borsaları, kimlik/veri simsarları, oturum kaydediciler, bildirim spam\'i ve tarayıcıda madencilik yapanlar. Reklam SDK\'ları ve ölçüm servisleri bilerek engellenmez — bazı oynatıcılar videoyu ancak reklam döngüsü bitince veriyor, o istekleri kesersen video hiç başlamıyor. Aşağıya kendi alan adlarını satır satır ekleyebilirsin.',
    blockTrackers: 'Bilinen reklam ağlarını ve izleyicileri engelle',
    minStream: 'En kısa video süresi',
    minStreamHint:
      'Reklam filtresi. Bir sayfada birden fazla akış bulunursa, bundan kısa olanlar reklam sayılıp atılır — ama yalnızca daha uzun bir akış da bulunduysa. "Yok" seçersen süre bakılmaz.',
    subsSyncReady: 'ffsubsync bulundu — hizalama yapılabilir.',
    subsSyncMissing:
      'ffsubsync kurulu değil; imza eşleşmesi olmayan altyazılar olduğu gibi kaydedilir. Kurmak için: pip3 install ffsubsync',
    sectionTools: 'Araçlar',

    downloadDir: 'İndirme klasörü',
    downloadDirHint: 'Yeni indirmeler buraya kaydedilir.',
    choose: 'Değiştir',
    openDir: 'Aç',

    filenameTemplate: 'Dosya adı şablonu',
    filenameHint: 'yt-dlp çıktı şablonu. Örn. %(title)s [%(id)s].%(ext)s',

    concurrency: 'Eşzamanlı indirme',
    concurrencyHint: 'Aynı anda kaç aktarım çalışsın.',
    connections: 'Dosya başına bağlantı',
    connectionsHint:
      'Tek bir videoyu kaç ayrı bağlantıyla çekelim. Bir indirmenin yavaş olmasının sebebi genelde hattın değil, tek bağlantının sınırlanması: sunucu bağlantı başına hız kısar, gidiş-dönüş süresi tek akışın penceresini daraltır. Dördü birden açmak bu sınırların dördünü birden kullanır. Parçalı akışlarda (HLS/DASH) aynı anda indirilen parça sayısı olur; düz dosyalarda dosya gerçekten parçalara bölünüp aynı anda indirilir ve duraklatırsan her parça kaldığı yerden devam eder. Sunucu izin vermezse kendiliğinden tek bağlantıya düşer. Çok yükseltmek bazı sitelerde 429 (çok fazla istek) yiyebilir — 4 ile 8 arası iyi bir aralık.',
    rateLimit: 'Hız sınırı',
    rateLimitHint: 'Boş bırak = sınırsız. Örn. 4M, 800K',
    autoStart: 'Sıraya eklenen indirmeler kendiliğinden başlasın',

    defaultQuality: 'Varsayılan kalite',
    container: 'Video kabı',
    audioFormat: 'Ses biçimi',
    embedThumbnail: 'Kapak görselini dosyaya göm',
    embedMetadata: 'Başlık ve künye bilgisini göm',
    writeSubs: 'Altyazıları indir',
    subLangs: 'Altyazı dilleri',

    cookiesBrowser: 'Tarayıcı çerezleri',
    cookiesHint:
      'Giriş gerektiren sayfalar için seçtiğin tarayıcının çerezlerini kullanır. Yok = çerez kullanılmaz.',
    cookiesNone: 'Yok',

    proxy: 'VPN / vekil sunucu',
    proxyHint:
      'İstediğin bağlantıyı vekil sunucu üzerinden çözümleyip indirir. Gerçek bir VPN tüm bilgisayarı tünelden geçirir — bu ise bağlantı başına çalışır: bir videoyu tünelden, yanındakini doğrudan indirebilirsin, aynı anda. URL kutusunun yanındaki VPN düğmesi hangi bağlantının hangi yoldan gideceğini belirler. socks5://, http:// ve https:// adresleri kabul edilir; kullanıcı adı/parola yazabilirsin (socks5://ad:parola@sunucu:port).',
    proxyTest: 'Sına',
    proxyTor:
      'Cloudflare WARP adresini siteden gizler, o kadar: Cloudflare senin kim olduğunu görür. Gerçekten anonim olması gerekiyorsa Tor — üç röle, hiçbiri iki ucu birden bilmez. Tor bağlantı başına yavaştır, ama bu uygulamada beklenmedik bir avantajı var: çok parçalı indirici birden çok bağlantı açıyor ve her parçaya ayrı bir devre verildiği için hızlar toplanıyor. Kurulum: Tor kurup çalıştır (Homebrew ile "brew install tor" sonra "tor"), ya da Tor Browser\'ı aç — ilki 9050, ikincisi 9150 portunda dinler. Yukarıdaki düğmelerden yeşil işaretli olan şu an açık olandır.',
    proxyDefault: 'Yeni bağlantılar varsayılan olarak VPN ile eklensin',
    proxyWarp:
      'Cloudflare ile kullanmak için: Cloudflare WARP\'ı kur, sonra terminalde "warp-cli mode proxy" ve "warp-cli connect" çalıştır — WARP 127.0.0.1:40000 üzerinde bir SOCKS5 sunucusu açar, yukarıdaki varsayılan adres de orayı gösterir. Uygulama WARP\'ı kurmaz ve ayarlarını değiştirmez; yalnızca oraya bağlanır. Not: ffmpeg SOCKS desteklemez, bu yüzden yt-dlp kapalıyken parçalı akışlar (HLS/DASH) vekille inmez — o durumda yt-dlp\'yi açık tut ya da HTTP vekili kullan.',

    engine: 'İndirme motoru',
    engineHint:
      'Açıkken sayfaları yt-dlp çözümler ve indirmeyi o yapar. Kapatırsan yt-dlp hiç çağrılmaz: her bağlantıyı kendi çözümleyicim çözer, indirmeyi de kendisi yapar — düz dosyalar için parçalı HTTP (duraklat/sürdür çalışır), HLS/DASH için ffmpeg. Kalite, master playlist içindeki varyantlardan seçilir. Kapalıyken yt-dlp\'nin bildiği siteler (YouTube gibi) için elde kalan tek yol kendi çözümleyicim olur, yani bazı sayfalarda sonuç değişir.',
    engineOn: 'yt-dlp kullan',
    engineOffNote:
      'yt-dlp kapalı. Çözümleme ve indirme tamamen kendi motorumda; ffmpeg gerekli. Bu motorda hız sınırı uygulanmaz ve parçalı akışlarda duraklatma baştan başlamak demektir.',

    deletePolicy: 'Kayıttan silerken dosya',
    deletePolicyHint:
      'Kitaplıktan bir kaydı silerken diskteki dosyanın da silinip silinmeyeceği. "Her seferinde sor" kutuyu işaretsiz açar; "her zaman sil" işaretli açar; "asla silme" kutuyu hiç göstermez. Onay penceresi üç durumda da çıkar — dosya silmek geri alınamaz.',
    deletePolicyAsk: 'Her seferinde sor',
    deletePolicyAlways: 'Her zaman dosyayı da sil',
    deletePolicyNever: 'Asla dosyayı silme',

    vaultSection: 'Kasa',
    vaultAutoLock: 'Otomatik kilit',
    vaultAutoLockHint:
      'Kasada bu kadar süre işlem yapılmazsa kilitlenir ve oynatmak için çözülmüş geçici kopyalar silinir. "Yok" seçersen yalnızca elle kilitlenir ve uygulama kapanınca kilitlenir.',
    vaultNotSet: 'Henüz kasa kurulmadı. Kasa sekmesinden kurabilirsin.',

    scripts: 'Site tarifleri (script)',
    scriptsHint:
      'Çözümleme sırasında sayfanın içinde çalışan küçük script\'ler. Fikir Tampermonkey\'den geliyor ama Tampermonkey\'in kendisi Electron\'da çalışmaz (eklenti API\'lerinin çoğu yok — uBlock\'un yüklenememesiyle aynı sebep), o yüzden aynı fikir buraya özel yazıldı. Tarayıcıdaki bir script gördüğünü değiştirir; buradaki bir script çözümleyiciye doğrudan akış verebilir: AIO.found("https://…/master.m3u8"). Yani hiç kimsenin çıkarıcı yazmadığı bir site, on beş satırlık bir metin dosyasıyla öğretilebilir. Script\'ler sayfa dünyasında çalışır (oynatıcının değişkenlerini okuyabilmeleri için), Node\'a erişemezler, ve verdikleri adres ağdan yakalananla aynı doğrulamadan geçer — öneri sayılırlar, cevap değil.',
    scriptsOn: 'Site tariflerini çalıştır',
    scriptsOpen: 'Klasörü aç',
    scriptsNone: 'Henüz script yok.',
    scriptsCount: (n: number) => `${n} script yüklü`,
    scriptsApi:
      'Kullanılabilir: AIO.found(url, {kind, title, duration}) · AIO.title(metin) · AIO.duration(saniye) · AIO.note(metin) · AIO.click(seçici) · AIO.every(ms, fn). Başlıkta @match, @run-at ve @exclude Tampermonkey ile aynı yazılır.',

    resolver: 'Kendi çözümleyicim',
    resolverHint:
      'yt-dlp bir sayfayı tanımazsa devreye girer: sayfayı ve gömülü oynatıcıları tarar, gerekirse sayfayı görünmez bir tarayıcıda çalıştırıp akışı yakalar. Yukarıda bir tarayıcı seçtiysen o oturumu kullanır, yani sitelere yeniden giriş yapman gerekmez.',
    resolverOn: 'Tanınmayan siteler için çözümleyiciyi kullan',
    resolverWait: 'En fazla bekleme:',
    resolverParallel: 'Aynı anda çözümlenecek bağlantı:',

    theme: 'Tema',
    themeDark: 'Koyu',
    themeLight: 'Açık',
    themeSystem: 'Sistem',
    clipboardWatch: 'Panodaki bağlantıyı yakala',
    notify: 'İndirme bitince bildirim gönder',
    enrichLimit: 'Otomatik bilgi çekme sınırı',
    enrichHint: 'Bir kaynakta en fazla kaç öğe için süre/kapak bilgisi alınsın.',

    ytdlpFound: 'yt-dlp hazır',
    ytdlpMissing: 'yt-dlp bulunamadı',
    ffmpegFound: 'ffmpeg hazır',
    ffmpegMissing: 'ffmpeg bulunamadı',
    toolsHint: 'İndirme motoru bu iki araca dayanır. Kurulum:',
    recheck: 'Yeniden denetle',
    updateEngine: 'Motoru güncelle',
    reset: 'Ayarları sıfırla',
    version: 'Sürüm',
  },

  batch: {
    selectOne: 'Seç',
    selectGroup: 'Bu kaynaktaki hepsini seç',
    picked: 'öğe seçildi',
    download: 'İndir',
    remove: 'Listeden çıkar',
    clear: 'Seçimi temizle',
    category: 'Kategoriye taşı',
  },

  subs: {
    find: 'Altyazı bul',
    title: 'Altyazı',
    searching: 'Aranıyor…',
    inSync: 'SENKRON',
    hearing: 'İşitme engelli',
    downloads: 'indirme',
    apply: 'Ekle',
    applying: 'Ekleniyor…',
    none: 'Bu dosya için altyazı bulunamadı.',
    noKey: 'Altyazı araması için bir OpenSubtitles API anahtarı gerekiyor.',
    noKeyHow: 'opensubtitles.com üzerinden ücretsiz alınır, sonra Ayarlar → Altyazı bölümüne yapıştır.',
    openSettings: 'Ayarlara git',
    hashNote:
      'Dosya imzasıyla eşleşen altyazılar bu sürüm için zamanlanmıştır; ek hizalama gerekmez.',
    queryNote: 'İmza eşleşmesi yok — sonuçlar ada göre bulundu, zamanlama kayabilir.',
    added: 'Altyazı eklendi',
    searchAgain: 'Başka adla ara',
  },

  vault: {
    title: 'Şifreli kasa',
    setupTitle: 'Şifreli kasa kur',
    setupBody:
      'Kasaya attığın videolar diskte şifreli durur: dosya adları rastgele kimliklere döner, içerikleri okunamaz. Sadece burada, şifreni girerek açabilirsin.',
    passphrase: 'Şifre',
    passphraseAgain: 'Şifre (yeniden)',
    tooShort: 'En az 6 karakter.',
    mismatch: 'İki şifre aynı değil.',
    noRecovery:
      'Bu şifrenin bir kopyası hiçbir yerde tutulmuyor. Unutursan kasadaki dosyalar kurtarılamaz — kurtarma yolu bırakmak, şifreyi baştan anlamsız kılardı.',
    create: 'Kasayı kur',
    created: 'Kasa kuruldu.',
    lockedTitle: 'Kasa kilitli',
    lockedBody: 'Şifreni gir; kasadaki dosyaların listesi ancak açıkken görünür.',
    unlock: 'Kilidi aç',
    unlocked: 'Kasa açıldı.',
    lock: 'Kilitle',
    open: 'Aç',
    opened: 'Dosya şifresi çözülüp oynatıcıya verildi. Kasayı kilitleyince kopya silinir.',
    openExternal: 'Sistem oynatıcısında aç (adı geçmişe düşer)',
    export: 'Şifresiz kopya çıkar',
    remove: 'Kasadan sil',
    removeTitle: 'Kasadan silinsin mi?',
    removeBody: (name: string) => `"${name}" kalıcı olarak silinecek. Şifresiz bir kopyası yoksa geri gelmez.`,
    addFiles: 'Dosya ekle',
    addedFiles: (n: number) => `${n} dosya kasaya alındı.`,
    emptyTitle: 'Kasa boş',
    emptyBody:
      'Kitaplıkta tamamlanmış bir kaydın ⋯ menüsünden "Kasaya taşı" de, ya da yukarıdan doğrudan dosya ekle. Eklenen dosya şifrelenir ve şifresiz hâli silinir.',
    autoLockNote: (n: number) => `${n} dk işlem olmazsa kendiliğinden kilitlenir`,
    autoLockOff: 'otomatik kilit kapalı',
    footer: (n: number, size: string) => `${n} dosya · ${size} şifreli olarak duruyor`,
    footerEmpty: 'Kasa diskte nerede duruyor?',
    reveal: 'Klasörü göster',
    whereTitle: 'Dosyalar burada duruyor:',
    whereBody:
      'Bu klasörü yedeklersen kasan da yedeklenmiş olur; içindekiler zaten şifreli. İçeride rastgele adlı bloklar, bir de şifreli dizin dosyası görürsün — adları ve başlıkları tutan yer orası. Bu dosyaları elle silersen o kayıtlar geri gelmez.',
    howTitle: 'Güvenlik katmanları',
    how: [
      'Her dosya AES-256-GCM ile, kendine ait rastgele bir nonce ile şifrelenir. Doğrulama etiketi dosyaya iliştirilir: kurcalanan bir dosya bozuk çözülmez, hiç açılmaz.',
      'Şifreden anahtar scrypt ile türetilir (N=32768, r=8) ve rastgele bir tuz kullanılır. Her deneme yaklaşık 100 ms ve 32 MB bellek ister — deneyerek bulmayı pahalı kılar.',
      'Dosya adları diskte rastgele kimliklerdir. Gerçek adlar, başlıklar ve boyutlar yalnızca şifreli dizinde durur; klasöre bakan biri ne olduğunu göremez.',
      'Anahtar sadece ana sürecin belleğinde, sadece kasa açıkken durur. Diske yazılmaz, arayüze geçmez; kilitlenince bellekteki kopya üzerine sıfır yazılır.',
      'Şifre kontrolü kayıtlı bir özetle karşılaştırma değil: yanlış şifre GCM doğrulamasında düşer.',
      'Bir dosyayı oynatmak, onu geçici ve yalnızca sana açık bir klasöre şifresiz kopyalamayı gerektirir. O kopyalar kasa kilitlenince, uygulama kapanınca ve boşta kalma süresi dolunca silinir. Kasa açıkken bilgisayarının başındaki birine karşı koruma sağlamaz.',
    ],
  },

  confirm: {
    removeSource: 'Bu kaynağı ve altındaki listeyi kaldır?',
    removeSourceBody: 'İndirilmiş dosyalar silinmez, sadece liste kaybolur.',
    removeDownload: 'Bu kaydı sil?',
    removeDownloadBody: 'Diskteki dosyayı da silmek istersen aşağıdaki kutuyu işaretle.',
    removeRecordOnly:
      'Yalnızca kayıt silinecek; diskteki dosya yerinde kalır. (Ayarlar → Aktarım\'da "asla dosyayı silme" seçili.)',
    deleteFile: 'Diskteki dosyayı da sil',
    cancel: 'Vazgeç',
    confirm: 'Kaldır',
  },

  common: {
    add: 'Ekle',
    close: 'Kapat',
    save: 'Kaydet',
    all: 'Tümü',
    none: 'Yok',
    error: 'Hata',
    copy: 'Kopyala',
    more: 'Diğer işlemler',
  },
} as const
