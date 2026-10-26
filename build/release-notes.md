Kitaplığını daha kolay düzenleyebilir, takılan bir videonun zamanlamasını kontrol edebilir ve daha güvenilir iptal/devam davranışından yararlanabilirsin.

Ses seçimi ve aktarım hataları düzeltildi. Türkçe/İngilizce isteği başka dile
sessizce düşmez; etiketsiz `Original Audio` için ayrı **Orijinal ses** seçeneği
vardır. Mentalist kaynağında İngilizce etiketi yerine bu ad sunuluyorsa Orijinal
ses seçilebilir. Kaynak ve kitaplık durumu, toplam ilerleme çubuğu, yinelenen
indirme düğmeleri ve ses değiştirerek aynı işi yeniden deneme düzeltildi.
Gereksiz yeniden çözümleme kaldırıldı; geçici kopmalarda sağlam parçalar korunur.


Aynı başlıklı eşzamanlı indirmeler için ayrı dosya hedefleri, yeniden çözümlemede
oturum koruması ve MKV kesinti tanısı düzeltmeleri de bu sürüme dahildir.

## 0.17.0 ile gelenler

- **Toplu dizi / bölüm düzenleme:** koleksiyon adı, sezon ve bölüm numaraları. Önizleme, doğal sıralama ve son işlemi geri alma. Video dosyaları yeniden adlandırılmaz.
- **Video zamanlama kontrolü:** kitaplıktaki video menüsünden ses/görüntü boşluklarını incele. Kontrol dosyayı değiştirmez; modal kapanınca durur.
- **Daha güvenilir aktarım:** tek/paralel dosyalarda iptal sinyali tüm aşamalara ulaşır; doğrulanan kısmi dosyadan devam edilir.
- **DASH kalan süre:** çok dönemli videolarda sonraki dönemler de hesaba katılır.
- **Oturum temizliği:** aktif işin/kitaplığın kullandığı çerez dosyaları korunur, kullanılmayan özel geçici dosyalar sınırlı temizlenir.
- **Kuyruk tercihi:** otomatik başlatma kapalıyken ayar değiştirmek veya uygulamayı açmak indirmeleri kendiliğinden başlatmaz. Koleksiyon adına göre arama eklenmiştir.

Önceki ses seçimi, Dizibox çözümleme, site hesapları, Touch ID ve her açılışta kapalı altyazı davranışı korunur.

## İndir

| Sistem | Dosya |
|---|---|
| macOS Apple Silicon | `All-in-One-Downloader-0.17.0-arm64.dmg` |
| macOS Intel | `All-in-One-Downloader-0.17.0-x64.dmg` |
| Windows 10/11 64 bit | `All-in-One-Downloader-0.17.0-setup.exe` |

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
