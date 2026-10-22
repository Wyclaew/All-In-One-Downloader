Çözümleyici ve indirme sistemi yenilendi: dinamik oynatıcıları bulma, parçalı videolarda kaldığı yerden devam etme ve geçici hatalardan otomatik kurtarma geliştirildi. İngilizce ses/Türkçe altyazı tercihi, Touch ID ve dizi grupları bu sürümde birlikte geliyor.

## 0.13.0 ile gelenler

- **Daha güçlü çözümleyici:** genel sitelerde önce uygulamanın kendi motoru çalışır. İç içe oynatıcılar, JSON/POST yanıtları, uzantısız ve göreli kaynaklar, alternatif oynatıcılar taranır. Gerçek video doğrulanır; kapak görseli veya hata sayfası video kabul edilmez.
- **Parçalı HLS indirme:** TS, fMP4, AES-128 ve bayt aralıkları desteklenir. Hızlı bağlantı sıradaki işi alır; tamamlanan parçalar doğrulanıp saklanır. Duraklatıp devam ederken yalnızca eksikler indirilir. Son birleştirme yerel olarak yapılır.
- **Otomatik kurtarma ve süre hesabı:** geçici ağ/sunucu hataları sınırlı olarak tekrar denenir; süresi dolmuş akış sayfasından yenilenir. Hız ve tahmini süre ölçülen parçalara dayanır.
- **Ses ve altyazı:** varsayılan tercih İngilizce ses ve Türkçe altyazıdır. Ayarlardan Türkçe/kaynak sesi seçilebilir. Ayrı ses grupları korunur; dil etiketi yoksa İngilizce olduğu iddia edilmez. Yalnızca zorunlu kısa altyazı, tam altyazıyla karıştırılmaz.
- **Mac'te Touch ID:** kasayı önce şifreyle açıp Touch ID'yi etkinleştir. Anahtar mevcut parmak izi kaydıyla Keychain'de korunur; kasa şifresi kaydedilmez. Şifreyle açma seçeneği devam eder.
- **Dizi grupları:** aynı dizinin bölümleri ana sayfada sezon/bölüm sırasıyla bir arada durur. Elle koleksiyon atanabilir.
- **Hata düzeltmeleri:** iptal edilen taramanın ağ istekleri durdurulur; eski tarayıcı oturumu sonraki taramaya taşınmaz. Bekleyen manifest isteği sonsuza kadar çözümlemeyi tutamaz. Güncellemede disk yazım hatası, yanlış dosya özeti ve eşzamanlı kontrol durumları ele alınır.
- **Yayın doğrulaması:** Mac/Windows paketleri ve güncelleme dosyaları tamamlanıp doğrulanmadan sürüm otomatik güncellemede görünmez.

Verilen Dizibox ve Hdfilmcehennemi bölüm bağlantılarında oturum açmadan, uygulamanın kendi motoruyla kısa örnek indirme doğrulandı. Bu, tüm siteler veya tam bölüm için garanti değildir. Gerçek üyelik, CAPTCHA ve DRM gereksinimleri atlatılmaz. Kaynakta olmayan ses veya altyazı üretilemez.

## İndir

| Sistem | Dosya |
|---|---|
| macOS Apple Silicon | `All-in-One-Downloader-0.13.0-arm64.dmg` |
| macOS Intel | `All-in-One-Downloader-0.13.0-x64.dmg` |
| Windows 10/11 64 bit | `All-in-One-Downloader-0.13.0-setup.exe` |

Uygulama içindeki güncelleme denetimi açıksa yeni sürüm üstte bildirilir. Açılıştan yaklaşık 15 saniye sonra, ardından altı saatte bir kontrol edilir. Hemen kontrol etmek için Ayarlar → Uygulama → Güncellemeleri denetle kullanılabilir. Kurulum kullanıcı düğmeye bastığında başlar.

İndirme/birleştirme araçları ayrıca kurulu olmalıdır:

```bash
brew install yt-dlp ffmpeg
```

Windows:

```powershell
winget install yt-dlp.yt-dlp
winget install Gyan.FFmpeg
```

## macOS'ta ilk açılış

Paket ad-hoc imzalıdır; Apple Developer ID/notarization kullanılmadığında macOS ilk açılışı engelleyebilir. DMG'deki uygulamayı Applications klasörüne taşıdıktan sonra Sistem Ayarları → Gizlilik ve Güvenlik bölümündeki “Yine de Aç” seçeneğini kullanabilirsin.

Windows'ta imza sertifikası olmadığı için SmartScreen uyarısı görülebilir.

Geliştirici ayrıntıları ve kalan testler: depodaki `CLAUDE_HANDOFF.md`.
