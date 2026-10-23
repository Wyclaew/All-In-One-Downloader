Tor bağlantısı, video bilgileri ve kasa kullanımı güçlendirildi. Kaynakları topluca tekrar deneyebilir, takılan taramayı durdurabilir ve eksik video bilgilerini yeniden inceletebilirsin.

## 0.14.1 ile gelenler

- **Otomatik Tor:** VPN’li kaynakta uygulamanın Tor seçeneği kullanılıyorsa kendisi bağlanır. Ayrı kaynaklar ayrı Tor oturumları alır; her kaynağın çözümlemesi, indirmesi ve altyazısı aynı kimlikte kalır. Özel vekil ve WARP tercihin korunur. İki davranış ayarlardan yönetilebilir.
- **Daha ayrıntılı video bilgisi:** HLS/DASH yayın listeleri, oynatıcı verileri, dosya ve sınırlı parça başlıklarından süre/boyut çıkarılır. Tahminler işaretlenir. Bozuk kalite bağlantısının yerine doğrulanmış seçenek seçilebilir.
- **Kaynak araçları:** toplu tekrar dene/durdur, kaynak başına durdur, eksik bilgileri yeniden tara ve temizlenmiş hata raporunu kopyala.
- **Görünür Touch ID:** kasa kilitliyken de kurulum/durum paneli görünür. Önce kasayı şifreyle açıp Touch ID’yi etkinleştir. Parmak izi/Keychain sorunu varsa açıklama ve güvenli yeniden kayıt yolu gösterilir; şifreyle erişim devam eder.
- **Daha güvenilir işlemler:** iptal edilmiş eski metadata işi yeni taramayı engellemez. Uyku/kilit sırasında bekleyen şifre işlemi kasayı tekrar açamaz. Yeniden başlatmada eski ağ ve yükleniyor durumları temizlenir.
- **Özel ağ tercihi korunur:** VPN’li kaynakların uzak kapakları doğrudan yüklenmez; tarayıcı oturumu internete örnek istek göndermeden aktarılır. Son işlemler sürdürülürken de kaynak bağlantısı hazırlanır.
- **Tor üzerinden altyazı:** WebVTT/SRT ve desteklenen parçalı WebVTT önce seçili ağdan alınır, yerelde dönüştürülür. Yönlendirmelerde çerez kapsamı korunur.

Tor için ayrıca `brew install tor` veya Tor Browser kurulumu gerekir. Ayrı Tor oturumları farklı IP/hız garantilemez. Gerçek üyelik, insan doğrulaması ve DRM gereksinimleri atlatılmaz; kaynağın sunmadığı ses/altyazı üretilemez.

## İndir

| Sistem | Dosya |
|---|---|
| macOS Apple Silicon | `All-in-One-Downloader-0.14.1-arm64.dmg` |
| macOS Intel | `All-in-One-Downloader-0.14.1-x64.dmg` |
| Windows 10/11 64 bit | `All-in-One-Downloader-0.14.1-setup.exe` |

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

Mimari tarama ve geliştirme planı: `DEVELOPMENT_PLAN.md`. Geliştirici ayrıntıları ve kalan testler: `CLAUDE_HANDOFF.md`.
