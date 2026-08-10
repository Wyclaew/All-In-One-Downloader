## Bu sürümde

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
