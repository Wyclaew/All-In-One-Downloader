# All in One Downloader

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

**Windows notu:** bir Windows kurulumu macOS'ta wine olmadan üretilemez, bu yüzden
iki kurulum dosyası da GitHub Actions üzerinde kendi işletim sistemlerinde
derlenir. `v` ile başlayan bir etiket gönderdiğinde (`git tag v0.2.1 && git push
--tags`) akış çalışır ve `.dmg` (arm64 + x64) ile `.exe` kurulumunu aynı
sürüme ekler. Actions sekmesinden elle de başlatabilirsin.

`resources/bin/` klasörüne `yt-dlp` / `ffmpeg` ikililerini koyarsan uygulamayla
birlikte paketlenirler ve kullanıcının ayrıca kurmasına gerek kalmaz.

## Kullanım

- **Bağlantı ekle:** URL alanına yapıştır ve Enter. Aynı anda birden fazla bağlantı
  yapıştırabilirsin — metindeki tüm URL'ler ayrı kaynak olarak eklenir.
- Çözümleme arka planda ve **paralel** yürür (varsayılan 3 bağlantı birlikte); alan
  hemen boşalır, sıradaki bağlantıyı yazabilirsin.
- yt-dlp bir sayfayı tanımazsa **kendi çözümleyicim** devreye girer. Reklam duvarı
  veya doğrulama isteyen sayfalarda grup başlığındaki nişangâh düğmesi görünür bir
  pencere açar: kapıyı sen geçersin, akışı uygulama yakalar.
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

- macOS: `~/Library/Application Support/All in One Downloader/library.json`
- Windows: `%APPDATA%\All in One Downloader\library.json`

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
    browsers.js        tarayıcı çerez depolarını bulma (Opera GX dahil)
    resolver.js        yt-dlp'nin tanımadığı sayfalar için iki motorlu çözümleyici
    mediainfo.js       manifest ayrıştırma + ffprobe ile süre/çözünürlük
    blocklist.js       istek engelleme; reklam SDK'larına bilerek izin verir
    subtitles.js       OpenSubtitles arama, sese hizalama, gömme
src/                   React arayüzü (görünümler, bileşenler, biçimleyiciler)
```

Durumu yalnızca ana süreç değiştirir. Arayüz IPC ile istek gönderir, ana süreç
değiştirir ve yayınlar. İlerleme bilgisi ayrı ve kısılmış bir kanaldan akar, yani
saniyede birkaç kez güncellenen bir indirme kaynak listesini yeniden çizdirmez.

Çözümleme iki aşamalı: önce tek bir `yt-dlp -J --flat-playlist` çağrısı listeyi
hızla getirir, sonra süresi/kapağı eksik kalan öğeler küçük bir havuzla arka planda
tamamlanır. Böyle olmasa 200 videolu bir kanal dakikalarca boş ekran demek olurdu.

## Çözümleyici nasıl çalışıyor

yt-dlp bir sayfayı tanımazsa devreye giren kendi motorum. Sırayla, en ucuzdan
başlayarak:

1. **Sayfa taraması.** Sayfayı ve **oynatıcı script'lerini** indirir, iç içe
   iframe'leri Referer zincirini koruyarak 3 kata kadar takip eder. Şu yollardan
   akış arar:
   - `.m3u8` / `.mpd` / `.mp4` gibi doğrudan adresler
   - oynatıcı config konumları (`file:`, `sources:[{src:…}]`) — uzantısı olmasa bile
   - `<video>` / `<source>` etiketleri ve `data-src`, `data-hls`, `data-file` gibi
     data öznitelikleri
   - `og:video`, `twitter:player:stream` ve JSON-LD `contentUrl` beyanları
   - `eval(function(p,a,c,k,e,d))` ile paketlenmiş script'lerin açılması
   - base64 blob'lar, `\x68\x74…` hex kaçışları, `%68%74…` yüzde kaçışları,
     **tersten yazılmış** adresler (`//:sptth`) ve `String.fromCharCode(…)` dizileri
2. **Watch → embed dönüşümü.** Bir sitenin izleme sayfası ile embed sayfası farklı
   belgelerdir ve biri bozulduğunda diğeri sıklıkla çalışır. Vimeo bunun standart
   örneği: yt-dlp `vimeo.com/ID` için OAuth `401` veriyor ama
   `player.vimeo.com/video/ID` için on altı format döndürüyor. Adres biçiminden
   embed adresi türetilip yt-dlp'ye verilir.
3. **Gömülü oynatıcı devri.** Sayfada yt-dlp'nin tanıdığı bir oynatıcı (YouTube,
   Vimeo, Dailymotion, Twitch, JW, Kaltura, Brightcove, Wistia, VK, OK.ru…)
   gömülüyse o adres yt-dlp'ye geri verilir — kendi kazıdığımız çıplak bir akış
   yerine tam format listesi, altyazılar ve künye gelir.
4. **Tarayıcı motoru.** Sayfa görünmez bir pencerede **gerçekten çalıştırılır** ve
   ağ istekleri dinlenir. Obfuscate edilmiş ve `blob:`/MSE ile beslenen oynatıcılar
   böyle çözülür. Ayrıca:
   - oynatıcıya benzeyen bir **JSON belgesi** yanıtı açılıp içi taranır (bazı
     oynatıcılar hiç `.m3u8` istemez)
   - yalnızca segment görülürse, segmentin klasöründen yukarı çıkarak
     **manifest türetilir** (`master.m3u8`, `index.m3u8`, `manifest.mpd`…)
   - reklam SDK'larına bilerek izin verilir, reklam otomatik geçilir
5. **İç oynatıcıyı doğrudan açma.** Bir sitenin sarmalayıcı sayfasındaki kapı,
   oynatıcının kapısı değildir: ön-reklam, onay ekranı, bot kontrolü ve
   inceleme-engelleyici script hep **dış sayfada** durur; oynatıcı çerçevesinde
   hiçbiri yoktur. O çerçeveyi ebeveyni Referer olarak vererek doğrudan açmak —
   dış sayfanın yaptığı isteğin aynısı — sarmalayıcının hiç vermediği akışı
   saniyeler içinde verir.
6. **Tarayıcıda yakala.** Reklam duvarı veya doğrulama isteyen sayfalar için
   görünür pencere: kapıyı sen geçersin, akışı uygulama yakalar.

Bulunan her aday **doğrulanır**: manifest ayrıştırılır, gerekirse `ffprobe`
çalıştırılır. Süresi olmayan bir şey medya sayılmaz — poster görselleri böyle
ayıklanır. Reklamlar üç ayrı sinyalle elenir: bilinen reklam ağları, sayfanın
JSON-LD'de beyan ettiği süre, ve akışlar arası süre karşılaştırması.

İlerleme, yt-dlp'nin süslü çubuğu okunarak değil `--progress-template` ile makine
okunur biçimde alınır. Birleştirilen indirmelerde (video + ses ayrı akış) baytlar
biriktirilir ve metre asla geri gitmez.

## Bilinen sınırlar

- DRM korumalı akışlar (Widevine/PlayReady/FairPlay) indirilmez ve indirilmeyecek.
  Ama HLS'te sık görülen düz `AES-128` şifreleme **DRM değildir**; uygulama ikisini
  ayırt eder ve AES-128'i normal indirir.
- Bot doğrulaması (captcha) isteyen sayfalar otomatik çözülmez. Bunun için
  **Tarayıcıda yakala** var: doğrulamayı sen geçersin, akışı uygulama yakalar.
- Duraklatma yt-dlp sürecini durdurup `.part` dosyasını bırakır; sürdürme oradan
  devam eder. Sunucu byte-range desteklemiyorsa baştan başlar.
