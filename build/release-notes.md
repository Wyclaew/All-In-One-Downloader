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
