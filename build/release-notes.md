Dizilerini takip et, Kasa'yı istediğinde gizle ve izlediklerini Show Tracker'a gönder.

## 0.18.0 ile gelenler

- **Diziler sekmesi:** kitaplıktaki diziler TVmaze bölüm listesiyle karşılaştırılır. Sezon sezon durum, eksik bölümler, sıradaki bölümün tarihi ve yeni bölüm bildirimi. Yanlış eşleşen dizi elle aranabilir. TVmaze'e yalnız dizi adı gider ve bu istek Tor'dan geçmez.
- **Kasa aç/kapa:** Ayarlar'dan kapatınca Kasa sekmesi ve kasaya taşıma seçenekleri gizlenir, açık kasa kilitlenir. Şifreli dosyalar silinmez.
- **Show Tracker senkronu:** oynatıcıda izlediğin bölüm ve kaldığın yer bu bilgisayardaki Show Tracker uygulamasına bildirilir. Kasadaki videolar ve dosya yolları gönderilmez.

Yeni özellikler Ayarlar'dan kapatılabilir.

## İndir

| Sistem | Dosya |
|---|---|
| macOS Apple Silicon | `All-in-One-Downloader-0.18.0-arm64.dmg` |
| macOS Intel | `All-in-One-Downloader-0.18.0-x64.dmg` |
| Windows 10/11 64 bit | `All-in-One-Downloader-0.18.0-setup.exe` |

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
