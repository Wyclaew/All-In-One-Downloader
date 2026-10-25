Ses dilini her indirme için seçebilir, site hesaplarını güvenli biçimde tanımlayabilir ve oynatma sorunlarını daha açık inceleyebilirsin.

## 0.15.0 ile gelenler

- **İndirme başına ses dili:** çözünürlüğün yanında Türkçe, İngilizce veya kaynağın sesini seç. Video/kaynak/toplu seçimler ve gerçek ses dili ayrı gösterilir. Bilinen yanlış dublaj başarı sayılmaz; etiketsiz ses doğrulanamadı diye belirtilir.
- **Dizibox çözümlemesi:** reklam çerçeveleri ve statik kodlar gerçek oynatıcının süresini tüketmez. Asıl oynatıcıya öncelik verilir; IP engeli, üyelik ve doğrulama farklı açıklanır.
- **Site hesapları:** Ayarlar'da e-posta/parolayı güvenli sakla; HTTPS sitesi başına giriş/kayıt izni ver. Standart formlar denenir. Kod/CAPTCHA/koşullar/ek bilgi gereken yerde tarayıcıda tamamla.
- **Touch ID etkinleştirme düzeltmesi:** kasayı şifreyle açıp yeniden etkinleştir. Yeni kayıtlar Secure Enclave'in biyometrik korumasını kullanır; şifreyle açma korunur.
- **Gelişmiş oynatıcı:** altyazılar her açılışta kapalı; çoklu ses, ses gecikmesi, konum koruyan uyumluluk işlemi, kare/tampon bilgisi ve isteğe bağlı dosya zamanlama tanısı.
- **Aktarım bütünlüğü:** açık sonlu DASH, uyarlanan parça sayısı, daha güçlü devam/range kontrolü. FFmpeg eksik parça atlayıp başarılı çıksa bile eksik dosya tamamlandı sayılmaz.
- **Ağ tercihi:** doğrudan seçilen işler arkada uygulama Tor'u açıkken doğrudan kalır. Kaynağın ağ yolunu değiştirip yeniden tarayabilirsin.
- **Günlük kullanım:** kitaplık yedeği/kurtarma, disk azlığında güvenli duraklama, FIFO/öncelik ve aynı ses/kalitede çift kayıt kontrolü.

Kaynakta bulunmayan ses/altyazı üretilemez; bütün siteler, gerçek üyelik veya DRM için koşulsuz çözüm garantisi verilmez. Gerçek parmak iziyle etkileşim cihazında denenmelidir.

## İndir

| Sistem | Dosya |
|---|---|
| macOS Apple Silicon | `All-in-One-Downloader-0.15.0-arm64.dmg` |
| macOS Intel | `All-in-One-Downloader-0.15.0-x64.dmg` |
| Windows 10/11 64 bit | `All-in-One-Downloader-0.15.0-setup.exe` |

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
