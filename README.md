# Everything Downloader

Bir bağlantı yapıştır, sayfadaki indirilebilir videoları listele, seçtiklerini indir.
Her bağlantı kendi başlığı altında açılır-kapanır bir grup olarak kalır — hiçbir şey
indirmesen bile liste durur.

macOS için yazıldı; Windows altyapısı baştan hazır (aşağıya bak).

---

## Gereksinimler

İndirme motoru iki komut satırı aracına dayanır:

| Araç | Ne için |
|---|---|
| `yt-dlp` | Sayfa çözümleme ve indirme |
| `ffmpeg` | Video+ses birleştirme, ses dönüştürme, kapak gömme |

```bash
brew install yt-dlp ffmpeg
```

Windows'ta:

```powershell
winget install yt-dlp.yt-dlp
winget install Gyan.FFmpeg
```

Uygulama bu araçları PATH'te ve bilinen kurulum klasörlerinde arar; bulamazsa üstte
bir uyarı şeridi gösterir. Durumu **Ayarlar → Araçlar** bölümünden görebilir,
motoru oradan güncelleyebilirsin.

> macOS'ta GUI uygulamaları kabuğun PATH'ini miras almaz. Bu yüzden
> `electron/lib/binaries.js` her alt sürece `/opt/homebrew/bin` ve `/usr/local/bin`
> dahil genişletilmiş bir PATH verir.

## Çalıştırma

```bash
npm install
```

Geliştirme (Vite hot reload + Electron):

```bash
npm run dev
```

Derlenmiş halini çalıştır:

```bash
npm start
```

## Paketleme

macOS (.dmg, arm64 + x64):

```bash
npm run dist:mac
```

Windows (.exe kurulum):

```bash
npm run dist:win
```

**Windows notu:** kod ve `electron-builder.yml` yapılandırması hazır — platform
dallanmaları (ikili dosya adları, PATH, pencere çerçevesi, `windowsHide`, dosya
gösterme) tek tek ele alındı. Ama `.exe` üretmek NSIS gerektirir: bunu ya bir
Windows makinesinde ya da macOS'ta `wine` kurarak yapabilirsin. Bu depoda henüz
Windows paketi üretilmedi.

`resources/bin/` klasörüne `yt-dlp` / `ffmpeg` ikililerini koyarsan uygulamayla
birlikte paketlenirler ve kullanıcının ayrıca kurmasına gerek kalmaz.

## Kullanım

- **Bağlantı ekle:** URL alanına yapıştır ve Enter. Aynı anda birden fazla bağlantı
  yapıştırabilirsin — metindeki tüm URL'ler ayrı kaynak olarak eklenir.
- Çözümleme arka planda ve sırayla yürür; alan hemen boşalır, sıradaki bağlantıyı
  yazabilirsin.
- Her satırda süre, çözünürlük, boyut ve **hangi siteden geldiği** görünür.
- Satır başına kalite seçebilir, ya da grup başlığındaki seçimle **Tümünü indir**
  diyebilirsin. `Sadece ses` seçeneği mp3/m4a/opus/flac/wav olarak çıkarır.
- Bir öğeyi listeden çıkarmak: satırdaki `⋯` → *Listeden çıkar*. Kaynağı tamamen
  kaldırmak grup başlığındaki çöp kutusu (indirilmiş dosyalar silinmez).
- **Kitaplık** sekmesinde süren aktarımlar (yüzde, hız, kalan süre, parça sayısı),
  tamamlananlar ve hatalılar ayrı bölümlerde. Kategori ata, ara, dosyayı aç veya
  klasörde göster.

### Kısayollar

| Kısayol | İş |
|---|---|
| `⌘N` | URL alanına odaklan |
| `⌘⇧V` | Panodaki bağlantıyı doğrudan ekle |
| `⌘F` | Kitaplıkta ara |
| `⌘1` / `⌘2` | Kaynaklar / Kitaplık |
| `⌘,` | Ayarlar |

Pencereye bir bağlantı sürükleyip bırakmak da işe yarar.

## Veri nerede duruyor

Kitaplık, kaynaklar ve ayarlar tek bir JSON dosyasında:

- macOS: `~/Library/Application Support/Everything Downloader/library.json`
- Windows: `%APPDATA%\Everything Downloader\library.json`

Yazma işlemi geçici dosya + rename ile yapılır, yani yarıda kesilse bile dosya
bozulmaz. İndirilen videolar buraya değil, **Ayarlar → İndirme klasörü**'nde
belirlediğin yere gider.

## Mimari

```
electron/
  main.js              pencere, menü, IPC yüzeyi, yaşam döngüsü
  preload.js           contextBridge ile açılan tek API yüzeyi
  lib/
    store.js           tüm durumun tek sahibi; atomik kayıt + yayın
    binaries.js        yt-dlp/ffmpeg bulma, genişletilmiş PATH
    probe.js           bağlantı → kaynak + medya listesi (iki aşamalı)
    downloader.js      aktarım sırası, ilerleme ayrıştırma, duraklat/sürdür
src/                   React arayüzü (görünümler, bileşenler, biçimleyiciler)
```

Durumu yalnızca ana süreç değiştirir. Arayüz IPC ile istek gönderir, ana süreç
değiştirir ve yayınlar. İlerleme bilgisi ayrı ve kısılmış bir kanaldan akar, yani
saniyede birkaç kez güncellenen bir indirme kaynak listesini yeniden çizdirmez.

Çözümleme iki aşamalı: önce tek bir `yt-dlp -J --flat-playlist` çağrısı listeyi
hızla getirir, sonra süresi/kapağı eksik kalan öğeler küçük bir havuzla arka planda
tamamlanır. Böyle olmasa 200 videolu bir kanal dakikalarca boş ekran demek olurdu.

İlerleme, yt-dlp'nin süslü çubuğu okunarak değil `--progress-template` ile makine
okunur biçimde alınır. Birleştirilen indirmelerde (video + ses ayrı akış) baytlar
biriktirilir ve metre asla geri gitmez.

## Bilinen sınırlar

- Vimeo bağlantıları bu yt-dlp sürümünde `401 Unauthorized` veriyor (yt-dlp'nin
  Vimeo çıkarıcısıyla ilgili, uygulamayla değil). `Ayarlar → Araçlar → Motoru
  güncelle` ileride düzeltebilir.
- Giriş gerektiren içerik için **Ayarlar → Erişim → Tarayıcı çerezleri**'ni seç.
  Seçtiğin tarayıcının çerez veritabanı yoksa uygulama bir kez çerezsiz yeniden
  dener ve uyarır; ama her istekte boşa bir deneme yapmamak için ayarı düzeltmek
  daha iyidir.
- Duraklatma yt-dlp sürecini durdurup `.part` dosyasını bırakır; sürdürme oradan
  devam eder. Sunucu byte-range desteklemiyorsa baştan başlar.
