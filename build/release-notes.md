## Bu sürümde

- **Bağlantı kopyalama.** Kaynaklar'daki bir videonun `⋯` menüsünde: *Bağlantıyı
  kopyala* (sayfa adresi) ve çözümlenmiş öğelerde *Akış adresini kopyala* (m3u8/mp4
  adresinin kendisi). Satır zaten yoğun olduğu için menüye koydum — yeni bir düğme
  aynı birkaç pikselde yarışacaktı.
- **Kasa kilitlenince oynatıcı penceresi kapanıyor.** Kilitlemek çözülmüş kopyayı
  siliyor; onu oynatmaya devam eden bir pencere, kullanıcının tam da kaldırılmasını
  istediği şeyi göstermeye devam ederdi.

## Önceki sürümde

- **Kasa videoları artık uygulama içinde oynuyor.** QuickTime geçmişi sorununun
  doğru çözümü bu: dosyayı hiçbir dış uygulamaya vermiyoruz, dolayısıyla hiçbir
  uygulamanın "son kullanılanlar" listesine düşmüyor. (Alternatifi macOS'un
  paylaşılan listesini kurcalamaktı — bu senin **tüm** QuickTime geçmişini silerdi.)
  Yine de kendi oynatıcını kullanmak istersen `⋯` menüsünde duruyor.
- **Dört hazır tarif** kutudan çıkıyor, hepsi siteye değil **yönteme** özel:
  *Oynatıcıya sor* (oynatıcı nesnesinin kendi listesi), *Kod çözücüleri dinle*
  (`atob` ve `JSON.parse` çıktısı — şifreli oynatıcıların neredeyse tamamı adresi
  kullanmadan hemen önce burada çözer), *Kapıyı aç* (yaş/çerez/ara ekran düğmelerini
  görünen yazısına göre kapatır — "hiçbir şey bulamadı"nın önemli bir kısmı
  oynatıcının hiç kurulmamasıdır), *Sayfa değişkenlerini gez* (window ve oynatıcı
  kaplarını iki kat gezer).

## Önceki sürümde

- **Altyazı sorunu çözüldü.** Sebebi buydu: `--write-subs` altyazıyı *çıkarıcıya*
  sorar, dizi sitesinden kazınmış bir m3u8'in ise çıkarıcısı yok. Ama altyazı
  parçaları master playlist'in içinde listeleniyor ve kimse okumuyordu. Artık
  okunuyor, ffmpeg ile birleştirilip SRT olarak videonun yanına yazılıyor.
- **Ve artık sessiz kalmıyor.** Asıl kusur buydu: altyazı açıkken hiçbir şey
  bulunamadığında hiçbir şey söylenmiyordu, yani "altyazı yok" ile "hiç bakmadık"
  aynı görünüyordu. Şimdi üç durumu da söylüyor — kaydedildi, akışta var ama
  istediğin dilde değil, ya da bu akışta hiç yok.
- **Tor desteği.** Ayarlar → Erişim'de hazır ayar düğmeleri: Tor (9050), Tor
  Browser (9150), Cloudflare WARP (40000) — hangisi o an açıksa yeşil işaretli.
  Cloudflare adresini siteden gizler, o kadar; Cloudflare seni görür. Tor'da üç
  röle var ve hiçbiri iki ucu birden bilmez.
- **Tor'u hızlandıran şey.** Tor bağlantı başına yavaştır, ama çok parçalı
  indiricinin burada beklenmedik bir avantajı var: her parçaya ayrı bir SOCKS
  kullanıcı adı verilerek **ayrı devre** açtırılıyor, böylece parçaların hızı
  toplanıyor. Yalnızca Tor'un kendi portlarında ve kimlik bilgisi olmayan yerel bir
  vekilde yapılıyor — başka yerde uydurma kullanıcı adı en iyi hâlde yok sayılır.

## Önceki sürümde

- **İptal düğmesi artık çalışıyor.** Bu sürümde eklediğim eşzamanlı parça indirme
  yüzünden yt-dlp, SIGTERM'i alıp uçuşan parçaları bitirmeye çalışırken saniyeler
  geçiyordu; satır o sürede hiçbir şey olmamış gibi devam ediyor ve düğme bozuk
  görünüyordu. Ayrıca motor henüz öldürülecek bir süreç vermediyse çağrı sessizce
  düşüyordu. Artık: anında iptal olarak gösteriliyor, nazikçe soruluyor, 1,5 saniye
  sonra ısrar ediliyor.
- **İptal artık sıfırlıyor.** Yarım dosya, parça dosyaları, günlük ve kaydın
  kendisi gidiyor — satır boşta hâline dönüyor, başka bir çözünürlükle baştan
  başlayabiliyorsun.
- **Kasaya taşırken "dosya bulunamadı" düzeltildi.** Kaydın yolu eskiyebiliyor
  (son işlem uzantıyı değiştirir, dosya taşınır). Artık kayıtlı ada, sonra başlığa
  göre indirme klasöründe aranıyor ve bulunca kayıt da düzeltiliyor.

## Önceki sürümde

- **Site tarifleri (script).** Tampermonkey fikri, bu uygulamaya özel yazılmış
  hâli. Çözümleme sırasında sayfanın içinde çalışan küçük script'ler — ve
  tarayıcıdakilerden farklı olarak, çözümleyiciye doğrudan akış verebiliyorlar:
  `AIO.found('https://…/master.m3u8')`. Hiç kimsenin çıkarıcı yazmadığı bir site
  on beş satırlık bir dosyayla öğretilebiliyor. Ayarlar → Erişim → Site tarifleri.
- **Kutudan çıkan tarif: "Oynatıcıya sor".** Sayfadaki oynatıcı nesnelerinin kendi
  kaynak listesini okuyor (JW Player, Video.js, Clappr, Plyr, hls.js, Shaka,
  DPlayer, Playerjs). MSE/blob ile beslenen oynatıcılarda ağı izlemek işe yaramaz;
  oynatıcının kendisi adresi bilir.

## Önceki sürümde

- **Vekil yolu kökten kapatıldı.** Önceki sürümde sayfa taramasını tünele almıştım
  ama aday doğrulama, manifest okuma, künye çıkarma (ffprobe) ve öğe
  zenginleştirme hâlâ tünelin dışındaydı. Artık vekilli bir bağlantı adına yapılan
  **her** istek aynı kapıdan geçiyor. ffprobe SOCKS konuşamadığı için o durumda
  hiç çalıştırılmıyor — künye eksik kalır, ama adres sızmaz.
- **Vekil adresi diske yazılmıyor.** Adres kullanıcı adı/parola taşıyabildiği ve
  kitaplık dosyası düz metin olduğu için, kayıtlarda yalnızca "bu bağlantı
  vekilliydi" bayrağı duruyor; adres kullanılacağı anda ayarlardan okunuyor.

## Önceki sürümde

- **VPN düzeltmesi.** Vekil açıkken sayfa taraması, aday doğrulama ve manifest
  okuma hâlâ tünelin *etrafından* gidiyordu: yalnızca indirme vekilliydi. Coğrafi
  engelli bir sitede çözümleme bu yüzden düşüyordu — üstelik gerçek adres de
  sızıyordu. Artık vekilli bir bağlantı adına yapılan her istek aynı kapıdan
  geçiyor.
- **Çözümleyicide öncelik düzeltmesi.** Yeni eklenen kaynak-API ve script zinciri
  denemeleri, iframe takibiyle aynı istek bütçesini paylaşıyordu; dört API adayı
  olan bir sayfada tek bir iframe bile açılmadan bütçe bitebiliyordu. Kanıtlanmış
  yollar (iframe, yönlendirme) artık sırada önce.

## Önceki sürümde

- **Çözümleyiciye dört yeni teknik.** Oynatıcının kendi kaynak API'sini sorma
  (adresin sayfada hiç bulunmadığı siteler için), script zincirini bir kat daha
  takip etme, masaüstünde boş dönen sayfayı telefon olarak isteme, ve 3xx dönmeyen
  meta-refresh yönlendirmelerini takip etme.
- **Bağlantı başına VPN.** URL kutusunun yanındaki düğme: bir videoyu vekil
  sunucudan, yanındakini doğrudan indirebilirsin — aynı anda. Cloudflare WARP'ın
  proxy kipiyle çalışır. SOCKS5 ve HTTP vekilleri, kullanıcı adı/parola dahil.
- **Kasa küçük görselleri**, videodan alınıp diğer her şeyle aynı anahtarla
  şifrelenerek. Kasa artık diskte nerede durduğunu da söylüyor.
- **Oynatma ad sızıntısı kapatıldı:** kasadaki bir dosyayı açmak adını sistemin
  "son kullanılanlar" listesine yazıyordu; geçici kopya artık anlamsız bir adla
  açılıyor.
- **İndirme çubuğu bağlantı sayısınca bölünüyor**, her dilim kendi bağlantısını
  gösteriyor.
- **Kaynaklar'da iptal düğmesi**, ve bir kaynağı silmek ona ait süren indirmeleri
  de durduruyor. İptal artık yarım dosyayı, parça dosyalarını ve günlüğü siliyor.
- **Kalite seçimi** sekme değiştirince sıfırlanmıyor.

## Önceki sürümlerde

- **İndirme hızı: dosya başına birden çok bağlantı.** Bir indirmenin yavaş
  kalmasının sebebi genelde hattın değil, tek bağlantının sınırlanması. Parçalı
  akışlarda (HLS/DASH) parçalar artık aynı anda iniyor — yt-dlp'nin varsayılanı
  **1**'di. Düz dosyalarda ise dosya gerçekten parçalara bölünüp her parça kendi
  bağlantısıyla iniyor; duraklatırsan her parça kaldığı yerden devam ediyor.
  Ayarlar → Aktarım → **Dosya başına bağlantı** (varsayılan 4).
- **Kaynaklar'dan doğrudan kasaya taşıma**, ve kasaya giden videonun kaynak
  listesinden de silinmesi. Bir kaynağın son videosu kasaya girerse başlık
  kendiliğinden kayboluyor.
- **Kasa nerede duruyor** bilgisi kasa ekranında; yanındaki düğme klasörü açıyor.
- **Engelleme listesi** 66'dan 183 alan adına çıktı: pop-under ağları, reklam
  borsaları, kimlik/veri simsarları, oturum kaydediciler, bildirim spam'i ve
  tarayıcıda madencilik. Reklam SDK'ları ve ölçüm servisleri bilerek dışarıda —
  onları kesince bazı oynatıcılar videoyu hiç vermiyor.

- **Şifreli kasa.** İçeriği *ve adı* şifreli duran bir klasör: diskte rastgele adlı
  bloklar, gerçek adlar yalnızca şifreli dizinde. Dosya başına AES-256-GCM,
  şifreden anahtar scrypt ile, anahtar yalnızca bellekte ve kilitlenince üzerine
  sıfır yazılıyor. Boşta kalınca kendiliğinden kilitleniyor.
- **yt-dlp'yi kapatma anahtarı.** Kapalıyken hiç çağrılmıyor: çözümlemeyi de
  indirmeyi de uygulamanın kendi motoru yapıyor — düz dosyalar için parçalı HTTP
  (duraklat/sürdür kaldığı yerden), HLS/DASH için ffmpeg.
- **İndirmeden önce boyut.** Kalite başına hesaplanıyor ve satır, açılır menüde ne
  seçiliyse onun cevabını veriyor. Tahminler `~` ile işaretli.
- **Kalan süre.** Parçalı akışlarda yt-dlp süre vermiyor; artık ölçülen hızdan,
  parça hızından veya videonun zaman çizgisinden hesaplanıyor.
- **Yapışkan silme tercihi.** "Diskteki dosyayı da sil" kutusu artık her silmede
  sıfırlanmıyor; Ayarlar'dan bir kez seçiliyor.
- Kalite seçiminde bir hata düzeltildi: sınır verilmediğinde ("en iyi") en kötü
  varyant seçilebiliyordu.

## İndir

| İşletim sistemi | Dosya |
|---|---|
| macOS, Apple Silicon (M1–M4) | `All-in-One-Downloader-<sürüm>-arm64.dmg` |
| macOS, Intel | `All-in-One-Downloader-<sürüm>-x64.dmg` |
| Windows 10/11 (64-bit) | `All in One Downloader-<sürüm>-setup.exe` |

İndirme motoru iki komut satırı aracına dayanır:

```bash
brew install yt-dlp ffmpeg          # macOS
```

```powershell
winget install yt-dlp.yt-dlp; winget install Gyan.FFmpeg   # Windows
```

---

## macOS: ilk açılışta çıkan uyarı

> **"Apple, 'All in One Downloader' uygulamasının kötü amaçlı yazılım içermediğini doğrulayamadı."**

Bu bir virüs uyarısı değil ve uygulamanın içeriğiyle ilgisi yok. macOS, ücretli bir
Apple geliştirici sertifikasıyla imzalanıp Apple'a notarization için gönderilmemiş
**her** uygulamaya aynı uyarıyı gösterir. Bu proje sertifikasız dağıtıldığı için
uyarı çıkıyor.

Bir kez geçmek yeterli, sonra bir daha sormaz:

1. `.dmg` dosyasını aç, uygulamayı **Applications** klasörüne sürükle.
2. Applications içinde uygulamaya çift tıkla, çıkan uyarıyı kapat.
3. **Sistem Ayarları → Gizlilik ve Güvenlik**'i aç, aşağı in.
4. *"All in One Downloader engellendi"* satırının yanındaki **Yine de Aç**
   düğmesine bas ve onayla.

Terminal'i tercih edersen aynı işi tek satır yapar:

```bash
xattr -dr com.apple.quarantine "/Applications/All in One Downloader.app"
```

Uyarıyı tamamen yok etmenin tek yolu yıllık ücretli bir Apple Developer hesabı ve
notarization; altyapısı hazır, `README` içindeki *İmzalama ve notarization*
bölümünde anlatıldı.

## Windows: SmartScreen uyarısı

Aynı sebep, farklı isim: kurulum dosyası bir kod imzalama sertifikasıyla
imzalanmadığı için **"Windows kişisel bilgisayarınızı korudu"** çıkar.
**Daha fazla bilgi → Yine de çalıştır** ile geçilir.
