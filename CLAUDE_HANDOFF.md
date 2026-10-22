# Claude için devir notu — All in One Downloader 0.13.0

Son güncelleme: 23 Ekim 2026. 0.11.0/0.12.0 geliştirmeleri ve üçüncü kod denetimi
bu sürümde birleştirildi. **v0.13.0 yayımlandı**, kaynak commit'i `6b1380d`.
[Sürüm ve indirmeler](https://github.com/Wyclaew/All-In-One-Downloader/releases/tag/v0.13.0).
Kullanıcının gerçek kitaplığı, kasa dosyaları ve indirilen
videoları testlerde kullanılmadı. Yerel Apple Silicon uygulaması:
`release/mac-arm64/All in One Downloader.app`.

## GitHub yayın ve güncelleme doğrulaması

- `main` ve annotated `v0.13.0` etiketi push edildi. Mac arm64/x64 DMG + ZIP,
  Windows EXE, blockmap'ler ve iki update manifesti yayınlandı. GitHub `/latest`
  bu sürümü döndürüyor; draft/prerelease değil.
- [Release workflow 39862592920](https://github.com/Wyclaew/All-In-One-Downloader/actions/runs/39862592920)
  son durumda **success**: Mac build, Windows build ve Install notes başarılı.
  Yerelde **55/55** test geçti. Her iki CI runner'da araçlar eksik olduğu için
  **46 geçti, 9 FFmpeg/yt-dlp entegrasyonu atlandı**, hata yok. Bu 9 test yerelde
  gerçek araçlarla çalıştı; CI'da bütün 55 çalıştı denmemeli.
- İlk notes denemesi GitHub draft release'ini tag endpoint'inden okuyamadı
  (404). `build/verify-release.js` authenticated, sayfalı release listesinde
  tag arayacak şekilde düzeltildi; bu araç değişikliği `main` üzerindedir ve
  uygulama paketinin kodunu değiştirmez. Aynı v0.13.0 taslağındaki 7 zorunlu
  paket/manifest doğrulandı, yayınlandı ve notes job yeniden çalıştırılıp geçti.
  Yayın etiketi zorla taşınmadı; yeniden uygulama sürümü üretilmedi.
- Yayındaki Mac arm64 ZIP'i GitHub'dan yeniden indirildi: **95.375.859 bayt**,
  `latest-mac.yml` ile SHA-512 eşleşti. Açılan paketin deep/strict codesign
  doğrulaması geçti; app.asar içindeki **40 kod/arayüz dosyası** çalışma kopyasıyla
  bayt olarak aynı, paket sürümü 0.13.0. Yerel paket de aynı kontrolleri geçti.
- Ayrı geçici veri klasörüyle **v0.10.0 etiketindeki gerçek eski updater kodu**
  ve yeni updater, public GitHub API üzerinde test edildi. İkisi de mevcut
  sürüm 0.10.0 iken `phase=available`, `latest=0.13.0`, `automatic=true` döndürdü.
  Bu, bildirim ve indirilebilir hedef seçiminin doğrulamasıdır; kullanıcının
  çalışan uygulaması değiştirilmedi, tam otomatik swap/install denenmedi.
- README ve yayın notları 0.13.0 davranışını anlatır. Otomatik kontrol açıksa
  açılıştan 15 sn sonra ve 6 saatte bir üst banner gelir; elle kontrol de vardır.

## 0.13.0 kod denetiminde eklenen düzeltmeler

- Browser taramasının JSON/manifest türetme istekleri sınırlı boyut ve süreyle
  çalışır; iptal bunlara iletilir. Manifest türetme artık çerezler silindikten
  sonra yapılmaz. Son snapshot oturumu kullanılır. Havuz oturumu geri verilmeden
  istekler, HTTP auth/cache/storage temizlenir; cleanup hatası olan slot yeniden
  kullanılmaz. Kapanmış taramanın callback'i yeni aday ekleyemez.
- Ölçüm tamamlanırken yeniden settle timer kurulması önlendi. Aynı iframe'in
  yeniden atlanması alternatif deneme bütçesini tüketmez.
- `video/main.m3u8` gibi başında slash olmayan göreli JSON/config kaynakları
  tanınır. Lazy iframe'deki about:blank, gerçek data-src adresini örtmez.
- ffprobe'un bir PNG/JPEG'i video stream olarak raporlaması artık doğrulama
  için yeterli değildir. Gerçek PNG regresyon testi var. Statik sayfanın altyazısı
  browser sonucuna taşınır; zorunlu/forced altyazı işareti korunur.
- HLS video/ses manifestlerinden biri hata verince diğerinin başlık bekleyen
  isteği de durdurulup beklenir; fallback sırasında başıboş istek kalmaz.
- Updater kontrolleri tek promise paylaşır; indirme sırasında kontrol durumu
  ezilemez. Disk writer error/backpressure pipeline ile ele alınır, yanlış
  SHA-512 paketi silinir. Manifest sürümü/asset boyutu/hash/filename doğrulanır.
  SemVer prerelease sırası sayısal karşılaştırılır. Başlatılamayan kurulum helper'ı
  yakalanmayan process error üretmez. Tekrarlanan schedule eski startup timer'ı siler.
- `update-metadata.js` saf metadata işlemlerini ayırır; updater için 8 regresyon
  testi eklendi. Ağ yanıt boyutu/metadata bekleme süresi sınırlıdır. Arka plan
  kontrolü geçici hata verirse mevcut yeni sürüm bildirimi kaybolmaz.
- Release workflow iki platformda `npm test` çalıştırır. Paket sürümü/tag eşleşir.
  `releaseType: draft`; `build/verify-release.js` iki Mac ZIP/DMG, Windows EXE ve
  iki update manifestinin yüklenmiş/aynı sürüm/doğru boyut/hash olduğunu doğrular.
  Yalnızca bütün build'ler başarılıysa notes job taslağı yayımlayıp latest yapar.
- Depo public; otomatik kontrol GitHub erişim anahtarı gerektirmez. Uygulama
  açılışından yaklaşık 15 sn sonra ve 6 saatte bir bakar. Kullanıcı otomatik
  kontrolü kapatmışsa Ayarlar → Uygulama'dan elle kontrol gerekir. Bildirim
  uygulamanın üst banner'ıdır; işletim sistemi bildirimi eklendi denmemeli.

## Gerçekte doğrulanan sonuç ve kalan sınır

- Kullanıcının verdiği Dizibox adresi:
  `https://www.dizibox.live/3-body-problem-1-sezon-1-bolum-izle/`.
  Oturum/üyelik olmadan, sayfa → `/player/king/king.php` →
  `dbx.molystream.org/embed/...` zinciri takip edildi. Tarayıcı motoru HLS akışını
  ve **3635 saniyelik** süreyi buldu. Yeni **kendi HLS HTTP motoru** iki parça alıp
  FFmpeg ile yalnızca yerel olarak birleştirdi: **3.244.677 bayt**, ffprobe ile
  **6,089389 saniye** okunabilir video. İkinci bağımsız denemede de aynı çıktı
  alındı (çözümleme + örnek yaklaşık 24 sn; süre ağ ve siteye bağlıdır).
  Önceki turda yt-dlp `--test` yolu da 2.409.596 bayt aktarmıştı; yeni kanıt
  yt-dlp kullanmadan aktarımdır. Ayrı altyazı veya ses dili etiketi bulunmadı.
- `https://www.hdfilmcehennemi.nl/dizi/3-body-problem/sezon-1/bolum-1/`
  ilk sayfada HTTP 403 + Cloudflare managed challenge döndürmeye devam etti.
  Yeni çözümleme, sayfanın sunduğu **hdfilmcehennemi.mobi oynatıcısına** geçerek
  `srv9.cdnimages*.shop` üzerindeki **3635 saniyelik HLS** akışını buldu.
  Kendi motoru iki parçadan **4.131.693 bayt**, **15,014989 saniye** okunabilir
  video üretti. İki bağımsız deneme başarılıydı (yaklaşık 34 ve 59 sn).
  Türkçe altyazı adresi ayrıca HTTP **200**, **WebVTT**, **35.180 bayt** olarak
  doğrulandı. Hesap girişi, kullanıcı çerezi ve görünür insan doğrulaması
  kullanılmadı; CAPTCHA çözme/üyelik atlatma eklenmedi.
- Hdfilmcehennemi ses kanallarının dil alanları boştu. Örneklerin **İngilizce
  olduğu doğrulanmadı**; Türkçe WebVTT'nin varlığı, örnek videoya gömüldüğü
  anlamına gelmez. Bu canlı test sınırlı video + altyazı adresi doğrulamasıdır.
  Tam bölüm indirme, bütün bölümün oynatımı ve uçtan uca altyazı gömme canlı
  sitede test edilmedi. Çıktılar geçiciydi ve silindi.
- İlk turdaki doğrudan uzak FFmpeg/Dizibox başarısızlığı yerinde kaldı; yeni yol
  uzak medyayı FFmpeg'e okutmak yerine HTTP ile kendisi alır, FFmpeg'e yerel
  parçalar verir. Bu ayrım önemlidir; uzak FFmpeg yolu düzeldi denmemeli.
- Bütün siteleri koşulsuz çözme garantisi yok. Gerçek üyelik, CAPTCHA ve DRM
  gereksinimlerini atlatan bir sistem eklenmedi. Sunucu/CDN/ağ sınırları nedeniyle
  her durumda mutlak en yüksek hız veya kesin bitiş zamanı garanti edilemez.
- 0.13.0 denetiminden sonra canlı örnekler tekrar geçti: Dizibox 3.244.677 bayt /
  6,089389 sn (yaklaşık 15 sn toplam), Hdfilmcehennemi 4.131.693 bayt /
  15,014989 sn (yaklaşık 30 sn toplam). İkisi de 3635 sn kaynak bildirdi.
  Hdfilmcehennemi'de Türkçe işaretli VTT yeniden HTTP 200 döndü; yanıt bu kez
  3.288 bayttı. Kaynak birden fazla track sunduğu için bu boyutların sabit veya
  bütün bölümün tam altyazısı olduğu varsayılmamalı. Forced track seçimi ayrıca
  düzeltildi. Canlı testler yine tam bölüm indirmedi.

## Çözümleyici ve ağ

- `resolverFirst: true`: genel sitelerde önce kendi çözümleyicisi çalışır,
  sonuç yoksa yt-dlp denenir. YouTube/Vimeo/Twitch vb. özel platform çıkarıcıları
  ve playlist davranışı korunur. Ayarlar → Erişim'de sıra değiştirilebilir.
- `source-discovery.js`: Next/Nuxt/application JSON, nested source nesneleri,
  dil/MIME alanları, göreli/uzantısız adresler, base64 veri ve srcdoc okunur.
  İndirilen kod eval/Function/vm ile çalıştırılmaz; derinlik/düğüm/boyut bütçesi
  vardır. Görsel/script/iframe src niteliğini video config'i sanma düzeltildi.
- `browser-discovery.js`: oynatıcının gerçek fetch/XHR **POST yanıtı**, JSON,
  atob çıktısı, video currentSrc ve runtime state okunur. POST endpoint'i yanlış
  bir GET ile yeniden çağırmak yerine orijinal yanıtın sınırlı kopyası incelenir.
  JS/Node/IPC köprüsü açılmaz. Yanıt okuma ve aday sayıları sınırlıdır.
- **Kritik hata:** eski HOOK_SCRIPT template literal'ında kaçışsız regex slash'ı
  tarayıcı programını SyntaxError ile tamamen durduruyordu. Düzeltildi; enjekte
  edilen tüm programları derleyen regresyon testi ve gerçek Chromium'da POST
  fixture testi eklendi. Eski sınırsız fetch clone/text okuması da kaldırıldı.
- Gerçek Referer/Origin/User-Agent, onBeforeSendHeaders üzerinden akışa taşınır.
  İç içe ve runtime iframe'ler kaydedilir; derindeki oynatıcı önce denenir.
  Kapsamı oynatıcıyla sınırlı alternatif düğmeler dil tercihine göre denenir.
  Giriş/üyelik/indirme/satın alma düğmeleri otomatik tıklanmaz.
- İçerik/MIME doğrulaması uzantısız veya image/png dönen manifestleri tanır;
  HTML/404 ve HTML'e çıkan master playlist video kabul edilmez. Kısa gerçek
  videolar yalnızca kısa diye reklam sayılmaz; bildirilen uzun bölüm süresi ve
  açık reklam işaretleri dikkate alınır. DRM etiketleri ayrı kalır.
- Tarayıcıda en fazla 4 eşzamanlı ölçüm, 80 aday; genel çözümlemeye ayarın 2 katı,
  en çok 180 sn bütçe var (kapanış/temizlik ek süre alabilir). İptal ağ/ffprobe
  işlemlerine iletilir. Daha önce browser kullanan hostta ucuz iç oynatıcı
  keşfi tamamen atlanmaz; tekrar deneme yolu canlı sitelerde ayrıca sınandı.
- `proxy.js`: keep-alive bağlantı havuzu, IPv4/IPv6 adres denemesi, gzip/deflate/br
  çözme, boyut sınırı, yanıt zaman aşımı, geçici hatalarda sınırlı geri çekilme,
  Retry-After desteği. Yönlendirmede başka origin'e Cookie/Authorization taşınmaz.
- `resolver.js`: statik taramada seçilen/yakalanan Netscape oturumu kullanılıyor.
  Mobil taramadan gelen adayın kendi User-Agent'i korunuyor. HTML entity,
  srcdoc/base64 doküman ve göreli config adresleri daha iyi okunuyor. Genel
  `url:` alanlarından schema/menu bağlantılarını video sanma azaltıldı.
- Paralel çözümlemelerde engelleme kuralları ayrıldı. Yeniden kullanılan Chromium
  oturumunun proxy ayarı ilk navigasyondan önce tamamlanır; doğrudan bağlantıda
  eski proxy kalmaz. Akış doğrulaması tarayıcının güncel çerezleriyle yapılır.
- Kaynak silme/yeni tarama, önceki çözümlemeyi AbortController ile durdurur.
  Yarım kalan eski tarama yeni sonucu sonradan ezmez. yt-dlp metadata işlemlerinin
  toplam çalışma süresi sınırlandı.
- `probe.js`: genel “Unable to download” artık otomatik olarak “Ağa ulaşılamadı”
  değildir. DNS, zaman aşımı, HTTP erişim reddi, gerçek giriş gereksinimi ve site
  doğrulaması ayrı ele alınır. Eksik yt-dlp'de kendi çözümleyicisine geçilebilir.

## Otomatik kurtarma

- `recovery.js` ortak hata sınıflaması/backoff; Ayarlar → Aktarım'da açma/kapama ve
  1–6 deneme bütçesi (varsayılan 3).
- Kuyruk geçici ağ/5xx/429 hatalarında kontrollü bekler. 429 bağlantı sayısını
  azaltır. Süresi dolmuş çözümlenmiş akış (403/410 ve uygun 404/format hatası)
  orijinal sayfasından tekrar bulunur. Tercih edilen ses ve süre benzerliği
  korunur; varsa önceki yakalanmış oturum yeniden kullanılır.
- Bekleyen yeniden deneme duraklatılabilir/iptal edilebilir. Manuel tekrar deneme
  yeni bütçe açar. Giriş/DRM/disk hataları sonsuz otomatik döngüye girmez.
- yt-dlp'de HTTP/parça backoff ve eksik fragmentte durma açık; videoda sessizce
  boşluk bırakılması önlenir. Ağ aşaması uzun süre takılırsa süreç sonlandırılır.
- Ses/altyazı hazırlığı bitmeden “tamamlandı” bildirimi verilmez. Altyazı ekleme
  hatası indirilen geçerli videoyu başarısız saymaz. Tamamlanmış video hazırlık
  sırasında duraklatılmışsa tekrar ağdan indirmek yerine hazırlığa dönülür.

## Parçalı indirme, hız, ETA

- **Yeni `hls-native.js`**, `nativeHls: true`: çözümleyiciden gelen HLS VOD'u
  varsayılan olarak kendi HTTP motoru indirir. Ortak görev kuyruğu, 1–16 worker,
  sınırlı parça retry, HTTP/SOCKS vekili, ortak hız limiti; TS ve fMP4/init map,
  AES-128 (DRM değil), sequence IV ve HTTP bayt aralığı desteği vardır.
- `${destPath}.segments/plan.json` atomik günlüğü; her tamamlanmış parçanın
  boyutu/SHA-256'sı doğrulanır. Duraklatma/tekrar denemede yalnızca eksikler
  istenir. Başka dosyaya ait geçici klasör silinmez. Plan/URL/kalite kimliği
  değişince eski parçalar karıştırılmaz: imzalı adres yenilenirse cache sıfırlanabilir.
- Yanlış Range, eksik gövde, hata HTML'i ve desteklenmeyen parça içerikleri
  başarı sayılmaz. İptalde worker'lar bitmeden dosyalar silinmez. Başlık bekleme
  aralığındaki abort response hatasının ana süreci çökertmesi de önlendi.
- FFmpeg'e yalnızca üretilmiş yerel playlist ve doğrulanmış yerel TS/MP4/AAC
  parçaları verilir; ağ/key URI yoktur. Protokol `file`, demuxer formatları
  sınırlıdır. Yeni FFmpeg'in extension_picky seçeneği destek kontrolüyle
  uygulanır. Yerel işlem sırasında indirme sayacı işleniyor durumunu ezmez.
- Canlı/LL-HLS/GAP ve desteklenmeyen biçimler uzak FFmpeg yoluna döner;
  **o yol kaldığı yerden sürdürülemez**. AES-128 dışı DRM çözülmez. Fragment
  boyut sınırı 64 MiB. HLS motoru Ayarlar → Erişim'den kapatılabilir.
- HLS ETA en az 3 tamamlanmış parçadan sonra gerçek bayt/süre oranını nominal
  manifest bitrate'ına tercih eder. Resume baytları hıza katılmaz. AES padding
  ve CDN ön eki çıkarılırken hız sayacı geriye gitmesin diye ağ baytları ayrı
  sayılır. Çok hızlı biten/az veri olan aktarımda ETA boş kalabilir.
- `ownengine.js`: N sabit büyük parça yerine küçük görevleri ortak kuyruktan alan
  N worker. Hızlı bağlantı yeni işi alır; yavaş bir kanalın dosyanın sabit dörtte
  birini bitirmesi beklenmez. Her parça için eksik bayttan sınırlı yeniden deneme.
- Content-Range başlangıç/bitiş/toplamı doğrulanır. Kısa/yanlış/çakışan resume
  planı reddedilir; ETag/Last-Modified değişince eski parçalar karıştırılmaz.
  Günlük atomik yazılır; konumlu yazmanın kısa yazma ihtimali işlenir.
- Bir worker hata verdiğinde bütün istek/yazıcılar kapanmadan tek bağlantıya
  geçme veya dosyayı silme/yeniden adlandırma yapılmaz. Başlık bekleyen istek de
  iptal edilebilir. Önceden ayrılmış parçalı dosya tek akışta “tamamlanmış bayt”
  sanılmaz. Tek bağlantı için ayrı dosya kimliği günlüğü var.
- Tor kullanılıyorsa parçalar zorla farklı devrelere dağıtılmıyor. Seçilen proxy
  korunur; hız uğruna kendiliğinden doğrudan bağlantıya geçilmez.
- Yeni kurulumda 8 bağlantı; eski açık bağlantı tercihi korunur. HTTP için kullanıcının
  hız sınırı bütün worker'ların paylaştığı sınır olarak uygulanır.
- `transfer-stats.js`: son ölçümlerin kayan penceresi; resume'dan önceki baytlar
  hız sayılmaz. Ayrı video/ses fazlarının baytları doğru birikir. İkinci faz
  başlamadan ilk faz “işleniyor” sayılmaz. Yeterli veri yoksa ETA boş bırakılır.
  Kuyruk tahmini döngüsünün son işleri atlama hatası düzeltildi; dosyanın kendi
  ölçümü arayüzde tahmini kuyruk hesabıyla ezilmez.

## Dil ve altyazı

- `media-preferences.js`, `audio-selection.js`: varsayılan İngilizce. Ayarlar →
  Biçim'de İngilizce/Türkçe/kaynağın varsayılan sesi seçilebilir. Yeni kuyruğa
  alınan kayıt tercihi saklar. yt-dlp format seçimi bilinen tercih dilini önce
  arar; yoksa normal biçimlere geri döner ve bulunamayan dil bildirilir.
- `mediainfo.js`: HLS AUDIO grupları, dil ve rendition URI'leri okunur.
  `ownengine` kalite varyantına geçerken ayrı sesi kaybetmez; İngilizce sesi
  ikinci giriş olarak eşler. DASH/çok sesli FFmpeg girdisi için dilin stream
  indeksi de seçilebilir. Çift sesli dosya ses kanalı kopyalanarak yeniden
  paketlenir; video yeniden kodlanmaz.
- Etiketsiz sesi İngilizce sanan ses tanıma/çeviri eklenmedi. Dil yok/bilinmiyor
  durumu kullanıcıya dürüstçe bildirilir.
- Türkçe altyazı yazma/gömme varsayılan açık. `text-tracks.js`: HLS manifesti
  dışındaki `<track>`, JW Player ve Video.js/Plyr altyazı beyanlarını toplar;
  thumbnail VTT'ler elenir. Altyazının kendi Referer'i korunur.
- OpenSubtitles otomatik araması mevcut anahtar/ayarlarına bağlı; kaynakta veya
  sağlayıcıda olmayan Türkçe altyazı üretilemiyor. Bütün bölüme Türkçe altyazı
  kesin eklendi iddiası yok. Başarısız gömme, başarı diye raporlanmaz.

## Touch ID

- `electron/native/vault-keychain.swift`: Security + LocalAuthentication.
  Ana anahtar Keychain item'ında `biometryCurrentSet` ve
  `WhenUnlockedThisDeviceOnly` ile korunur. Bu, yalnızca arayüzde parmak izi
  penceresi gösterip korumasız yerden parola okumak değildir.
- Kasa şifresi, ana süreç argümanı veya JSON ayarında saklanmaz. Anahtar helper'a
  stdin üzerinden gider. JS kilit anahtarını ve elde edilen buffer'ları temizler.
- `biometrics.js`, `vault.js`, IPC/preload/api ve Kasa arayüzü bağlandı.
  Önce kasayı şifreyle açıp Touch ID etkinleştirilir. Şifre değişikliği kaydı
  siler; anahtar kimliği değişmişse yeniden kayıt gerekir. Uyku/kilit sırasında
  bekleyen biyometrik işlem kasayı tekrar açamaz.
- `build/biometric-helper.js` ve `after-pack.js` mimariye uygun native helper
  hazırlar ve ad-hoc imzalar. Arm64 ve x86_64 helper derlemeleri doğrulandı.
  Native “olmayan item'ı oku” çağrısı beklenen Keychain item-not-found hatasını
  verdi; gerçek parmak iziyle kaydet/aç akışı **insan etkileşimiyle hâlâ denenmeli**.
- Otomatik kasa testleri Keychain sınırını taklit ederek şifreye geri dönüş,
  iptal, kilit sırasında yarış ve parola değişikliği davranışlarını sınar.
  Bunlar gerçek biyometrik donanım testinin yerine geçmez.

## Dizi/koleksiyon arayüzü

- Extractor metadata'sından ve S01E01 / 1.Sezon 1.Bölüm başlıklarından dizi/sezon/
  bölüm alanları alınır. Mevcut kayıtlar bir defalık migration ile tamamlanır.
- Ana sayfada aynı dizi tek açılır gruptadır; bölümler sezon/bölüm sırasında.
  “Bölümler birlikte” ile tekli görünüme dönülür. Her kartın `⋯ → Dizi / koleksiyon…`
  menüsünden koleksiyon atanabilir/çıkarılabilir. Arama/izlenme/kategori filtreleri
  korunur; ses dili ve altyazı bilgisi kartta gösterilir.
- Tasarım referansı: uygulamanın mevcut Home/Settings/Vault ekranları. 16:9 kart,
  sistem yazı tipi ve mevcut renk token'ları korundu. Refero rehberinin yerel
  `craft-details.md` kaynağından doğal `<details>` klavye davranışı, focus-visible,
  sabit görsel oranı ve reduced-motion ilkeleri kullanıldı; canlı Refero aracı
  mevcut değildi. Yeni bir genel görsel tasarım yapılmadı.

## Doğrulama ve devam

- `npm test`: **55/55 geçti**, atlanan test yok (bu makinede yt-dlp/FFmpeg var).
  Gerçek video testleri düz TS, AES-128, byte-range, CDN ön eki, fMP4 init,
  ayrı İngilizce ses, güvenli pause/resume, iptal ve hata HTML'ini kapsar.
  Yerel 403 → çerezli sayfadan tazele → başarılı dosya senaryosu **iki aktarım
  motorunda da** doğrulandı. Tam birim/entegrasyon turu yaklaşık 11 sn sürdü.
- `tests/manual/resolver-fixtures.js`: gerçek Chromium'da uzantısız/image MIME
  manifest, Next state, iki iframe altındaki POST JSON yanıtı, alternatif
  oynatıcı tıklaması; ayrıca sahte mp4 HTML/404 reddi ve gizlenmiş DASH DRM
  tanıması geçti. Gerçek kitaplıktan ayrı geçici profil kullanır.
- `npm run typecheck`, `npm run build`, JS syntax ve `git diff --check` geçti.
- `tests/manual/ui-smoke.js`: ayrı profil ile tek koleksiyonda 3 bölüm, sıralama,
  yeni ayarlar ve sıfır renderer error doğrulandı; ekran görüntüleri
  `/tmp/aio-ui-smoke-results/` altında üretildi.
- **0.13.0 Mac arm64** uygulaması yerel olarak paketlendi ve GitHub paketi de
  ayrıca kontrol edildi (yukarıdaki yayın doğrulaması). Yerel `--publish never`
  paketleme GitHub yayınına karışmadı. Windows paketi GitHub runner'da üretildi;
  Windows cihazında kurulum/gerçek video indirme sınanmadı. Gerçek Touch ID etkileşimi,
  tam uzunlukta film ve farklı ağlar için manuel test hâlâ değerli.
- Canlı test:
  `npx electron tests/manual/resolve-sites.js --own-sample --captions 'https://.../'`.
  `--own-sample` en fazla iki parça/track alır, yerel mux ve ffprobe kontrolü
  yapar, çıktıyı siler. `--captions` varsa Türkçe altyazı yanıtını kontrol eder.
  `--prefer-browser` önceki host profilini taklit eder. `--sample` eski yt-dlp
  karşılaştırma yoludur; seçenekleri birbirinden ayrı kullan.
- Sonraki değerli manuel doğrulama: tam bölüm indir/pause/uygulamayı yeniden
  aç/resume; kaynakta gerçek ses dilini dinleme; Türkçe altyazıyı tam dosyaya
  gömme ve senkron; gerçek Touch ID ile kaydet/aç. Bu denemeler yapılmış sayılmaz.
  Sitelerin alan adı/CDN/oynatıcı davranışı değişebileceği için iki URL'deki
  başarı tüm site ve gelecek sürümler için garanti değildir.

## Araştırmada kullanılan birincil kaynaklar

- [yt-dlp seçenekleri ve format seçimi](https://github.com/yt-dlp/yt-dlp/blob/master/README.md)
- [yt-dlp desteklenen siteler ve destek sınırları](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)
- [FFmpeg HTTP yeniden bağlanma seçenekleri](https://ffmpeg.org/ffmpeg-protocols.html)
- [FFmpeg HLS demuxer ve format/uzantı seçenekleri](https://ffmpeg.org/ffmpeg-formats.html)
- [Electron WebRequest: gerçek istek başlıklarını yakalama](https://www.electronjs.org/docs/latest/api/web-request)
- [Apple: Keychain item'ına Touch ID erişimi](https://developer.apple.com/documentation/localauthentication/accessing-keychain-items-with-face-id-or-touch-id)
- [Apple: mevcut biyometrik kayıtla anahtar koruması](https://developer.apple.com/documentation/security/secaccesscontrolcreateflags/biometrycurrentset)
- [Electron: Touch ID penceresinin tek başına veri koruması olmadığı açıklaması](https://github.com/electron/electron/blob/main/docs/api/system-preferences.md)
