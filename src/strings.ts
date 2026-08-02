/**
 * Every visible word lives here. Keeps the voice consistent and makes another
 * language a matter of swapping this one file.
 */
export const T = {
  appName: 'Everything Downloader',

  nav: {
    sources: 'Kaynaklar',
    library: 'Kitaplık',
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
    sectionApp: 'Uygulama',
    sectionTools: 'Araçlar',

    downloadDir: 'İndirme klasörü',
    downloadDirHint: 'Yeni indirmeler buraya kaydedilir.',
    choose: 'Değiştir',
    openDir: 'Aç',

    filenameTemplate: 'Dosya adı şablonu',
    filenameHint: 'yt-dlp çıktı şablonu. Örn. %(title)s [%(id)s].%(ext)s',

    concurrency: 'Eşzamanlı indirme',
    concurrencyHint: 'Aynı anda kaç aktarım çalışsın.',
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

    resolver: 'Kendi çözümleyicim',
    resolverHint:
      'yt-dlp bir sayfayı tanımazsa devreye girer: sayfayı ve gömülü oynatıcıları tarar, gerekirse sayfayı görünmez bir tarayıcıda çalıştırıp akışı yakalar. Yukarıda bir tarayıcı seçtiysen o oturumu kullanır, yani sitelere yeniden giriş yapman gerekmez.',
    resolverOn: 'Tanınmayan siteler için çözümleyiciyi kullan',
    resolverWait: 'En fazla bekleme:',

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

  confirm: {
    removeSource: 'Bu kaynağı ve altındaki listeyi kaldır?',
    removeSourceBody: 'İndirilmiş dosyalar silinmez, sadece liste kaybolur.',
    removeDownload: 'Bu kaydı sil?',
    removeDownloadBody: 'Diskteki dosyayı da silmek istersen aşağıdaki kutuyu işaretle.',
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
