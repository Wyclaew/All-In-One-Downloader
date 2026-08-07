## Bu sürümde

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
