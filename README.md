# All in One Downloader

Bir bağlantı yapıştır, sayfadaki indirilebilir videoları listele, seçtiklerini indir.
Her bağlantı kendi başlığı altında açılır-kapanır bir grup olarak kalır — hiçbir şey
indirmesen bile liste durur.

macOS için yazıldı; Windows altyapısı baştan hazır (aşağıya bak).

---

## macOS'ta ilk açılış

Hazır `.dmg`'yi indirip açtığında macOS şunu der:

> **"Apple, 'All in One Downloader' uygulamasının kötü amaçlı yazılım içermediğini
> doğrulayamadı."**

Bu bir virüs uyarısı değil ve uygulamanın içeriğine bakılarak verilmiş bir karar
değil. macOS, ücretli bir Apple geliştirici sertifikasıyla imzalanıp Apple'a
notarization için gönderilmemiş **her** uygulamaya aynı uyarıyı gösterir. Bir kez
geçmen yeterli:

1. Uygulamayı **Applications** klasörüne sürükle, çift tıkla, uyarıyı kapat.
2. **Sistem Ayarları → Gizlilik ve Güvenlik**, aşağı in.
3. *"All in One Downloader engellendi"* satırındaki **Yine de Aç** → onayla.

Tek satırlık hali:

```bash
xattr -dr com.apple.quarantine "/Applications/All in One Downloader.app"
```

`npm run dist:mac` ile kendi makinende ürettiğin build'de bu uyarı hiç çıkmaz:
karantina bayrağını dosyaya tarayıcı koyar, derleyici koymaz.


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

## İmzalama ve notarization

Uygulama sertifikasız dağıtılıyor. `mac.identity: null` electron-builder'da
imzalamayı **tamamen** atlar, ve hiç imzası olmayan bir arm64 paketi çekirdek
tarafından Gatekeeper'a gelmeden reddedilir ("uygulama zarar görmüş"). Bu yüzden
`build/after-pack.js` paketi **ad-hoc** imzalar: sertifika değildir, uyarıyı
susturmaz, ama paketi geçerli koda çevirir — böylece *Yine de Aç* gerçekten açar ve
tek build hem Apple Silicon'da hem Intel'de çalışır. `resources/bin/` içine konan
yardımcı ikililer de ayrıca imzalanır, çünkü `codesign --deep` Resources'a inmez.

Uyarıyı tamamen kaldırmak yıllık ücretli bir Apple Developer hesabı gerektirir.
Altyapı hazır: depo ayarlarına şu beş sırrı eklediğin an akış imzalı + notarize
edilmiş build üretmeye başlar, başka değişiklik gerekmez.

| Sır | Ne |
|---|---|
| `MAC_CERTIFICATE_P12` | Developer ID sertifikasının `.p12` hâlinin base64'ü |
| `MAC_CERTIFICATE_PASSWORD` | `.p12`'yi çıkarırken verdiğin şifre |
| `APPLE_ID` | Geliştirici hesabının Apple ID'si |
| `APPLE_APP_SPECIFIC_PASSWORD` | appleid.apple.com'dan alınan uygulamaya özel şifre |
| `APPLE_TEAM_ID` | 10 karakterlik takım kimliği |

Bu değerleri ben yazamam ve uydurmam — hesabı olan sen ekleyeceksin. Windows
tarafındaki SmartScreen uyarısının sebebi de aynı: ayrı bir kod imzalama
sertifikası. `.exe` için de sertifika alırsan `CSC_LINK` / `CSC_KEY_PASSWORD`
Windows işine aynı şekilde bağlanır.

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

- Her satırda **indirmeden önce boyut** görünür. Boyut tek bir sayı değil, seçtiğin
  kaliteye göre değişir: açılır menüyü değiştirdiğinde rakam da değişir. Başında
  `~` varsa bit hızı × süre üzerinden hesaplanmış tahmindir, sunucunun bildirdiği
  kesin uzunluk değildir.
- İnerken kalan süre gösterilir. Parçalı akışlarda yt-dlp `eta` vermez; o durumda
  ölçülen hızla bilinen hedeften, ya da parça hızından hesaplanır.

## İndirme neden yavaş kalıyor, ne yaptık

Hattın 8 MB/s iken indirmenin 300 KB/s'de takılmasının sebebi genelde hat değil,
**tek bağlantı**: sunucu bağlantı başına hız kısar, gidiş-dönüş süresi tek TCP
akışının penceresini daraltır, ve aradaki bir kutu o tek akışa "yeter" der. Bu
sınırların hiçbiri dosya başına değil, **bağlantı başına** işler.

**Ayarlar → Aktarım → Dosya başına bağlantı** (varsayılan 4) iki yerde iş görür:

| Akış türü | Ne oluyor |
|---|---|
| HLS / DASH (dizi-film siteleri) | yt-dlp'ye `--concurrent-fragments` verilir; parçalar tek tek değil aynı anda iner. Varsayılan yt-dlp davranışı **1**'dir, yani bu ayar olmadan bir film binlerce parçanın her biri için ayrı bir gidiş-dönüş bekler. |
| Düz dosya (kendi motorum) | Dosya gerçekten parçalara bölünür, her parça kendi bağlantısıyla ve kendi konumuna yazılır. Duraklatırsan her parçanın nerede kaldığı yanına günlüklenir, sürdürünce yalnızca eksikler istenir. |

Sunucu `Range` desteklemiyorsa ya da 206 yerine başka bir şey dönerse kendiliğinden
tek bağlantıya düşer. Çok yükseltmek bazı sitelerde 429 (çok fazla istek) yiyebilir;
4–8 arası iyi bir aralık.

## Şifreli kasa

**Kasa** sekmesi, içeriği *ve adı* şifreli duran bir klasör. Bir dosya adı çoğu
zaman o dosyanın ne olduğunu söylemeye yeter, o yüzden ikisi birlikte şifrelenir.

- Kitaplıkta **ya da Kaynaklar'da** tamamlanmış bir kaydın `⋯` menüsünden **Kasaya
  taşı**, ya da Kasa sekmesinden doğrudan **Dosya ekle**. Şifreli kopya yazılıp
  doğrulandıktan sonra şifresiz özgün dosya silinir — yarıda kalan bir işlem
  dosyayı kaybettirmez.
- Kasaya giden video, kitaplıktan ve kaynak listesinden birlikte silinir: dosya
  artık orada olmadığı için o satırlar yalnızca bozuk bir "aç" düğmesi sunardı. Bir
  kaynağın **son** videosu da kasaya girerse başlık kendiliğinden kaybolur.
- Kasadaki dosyaların diskte nerede durduğunu alt satırdaki ⓘ gösterir; yanındaki
  düğme klasörü açar.
- Diskte `~/Library/Application Support/All in One Downloader/vault/` altında
  rastgele adlı bloklar durur. Gerçek adlar, başlıklar ve boyutlar yalnızca
  şifreli dizinde.

Katmanlar:

| Katman | Ne yapar |
|---|---|
| AES-256-GCM | Her dosya kendi rastgele nonce'uyla şifrelenir; doğrulama etiketi iliştirilir, kurcalanan dosya açılmaz |
| scrypt (N=32768, r=8) | Şifreden anahtar türetme; her deneme ~100 ms ve 32 MB ister |
| Rastgele blok adları | Klasöre bakan biri ne olduğunu göremez |
| Anahtar yalnızca bellekte | Diske yazılmaz, arayüze geçmez, kilitlenince üzerine sıfır yazılır |
| Otomatik kilit | Ayarlanan süre boyunca işlem olmazsa kilitlenir; çözülmüş geçici kopyalar silinir |

Sınırlar açıkça söylenmeli: bir dosyayı oynatmak onu geçici olarak (yalnızca sana
açık, `0700` bir klasöre) şifresiz kopyalamayı gerektirir; kasa açıkken
bilgisayarının başındaki birine karşı koruma yoktur; ve şifreyi unutursan
kurtarma yolu yoktur — bırakılmış bir kurtarma yolu şifreyi baştan anlamsız
kılardı.

## yt-dlp'yi kapatmak

**Ayarlar → Erişim → İndirme motoru**'ndan yt-dlp kapatılabilir. Kapalıyken hiç
çağrılmaz: her bağlantıyı kendi çözümleyicim çözer, indirmeyi de kendisi yapar.

| Akış | Nasıl iner |
|---|---|
| Düz dosya | Parçalı HTTP (`Range`) — duraklat/sürdür gerçekten kaldığı yerden devam eder |
| HLS / DASH | ffmpeg manifesti okur, tek kaba yazar; ilerleme videonun kendi zaman çizgisinden gelir |

Kalite, master playlist'teki varyantlardan seçilir — istediğin yüksekliğe eşit ya
da ondan küçük en iyi varyant doğrudan indirilir. Bu yolda ffmpeg zorunludur ve
parçalı akışlarda duraklatma baştan başlamak demektir (ffmpeg çıktısı
sürdürülemez). yt-dlp'nin kendi çıkarıcısı olan siteler (YouTube gibi) için
kapalıyken elde kalan tek yol kendi çözümleyicim olur, yani bazı sayfalarda sonuç
değişir.

## Site tarifleri (script)

Fikir Tampermonkey'den geliyor. Tampermonkey'in kendisi buraya yüklenemez —
Electron'un eklenti desteği Chrome API'sinin küçük bir bölümünü kapsıyor ve bir
userscript yöneticisinin dayandığı parçalar (storage, tabs, scripting,
declarativeNetRequest, MV3 service worker) çoğunlukla yok. uBlock Origin'in
yüklenememesiyle aynı sebep. O yüzden aynı fikir buraya özel yazıldı.

Aradaki fark, işin bütün anlamı. Tarayıcıda bir script **gördüğünü** değiştirir.
Burada bir script **çözümleyiciye akış verebilir**:

```js
AIO.found('https://cdn.site/gercek/master.m3u8')
```

Yani hiç kimsenin çıkarıcı yazmadığı bir site, on beş satırlık bir metin
dosyasıyla öğretilebilir.

- **Nerede:** Ayarlar → Erişim → *Site tarifleri* → **Klasörü aç**. Dosyalar
  `~/Library/Application Support/All in One Downloader/userscripts/*.user.js`
- **Başlık:** `@match`, `@exclude`, `@run-at`, `@name`, `@description`, `@enabled`
  — Tampermonkey ile aynı yazılır, `*://*.site.com/*` orada ne demekse burada da
  o demek (çıplak alan adı da eşleşir).
- **API:** `AIO.found(url, {kind, title, duration})` · `AIO.title()` ·
  `AIO.duration()` · `AIO.note()` · `AIO.click(seçici)` · `AIO.every(ms, fn)`

Kutudan çıkan tarif **Oynatıcıya sor**: sayfadaki oynatıcı nesnelerinin kendi
kaynak listesini okur (JW Player, Video.js, Clappr, Plyr, hls.js, Shaka, DPlayer,
Playerjs). MSE ile beslenen bir oynatıcıda ağı izlemek işe yaramaz — `<video>`
etiketinin `src`'si `blob:`tir ve gerçek adres hiç görünmeyebilir. Ama oynatıcı
nesnesi adresi bilir, çünkü bilmek zorunda. Bu tarif ona doğrudan sorar.

Sınırlar açık olsun: script'ler sayfa dünyasında çalışır (oynatıcının
değişkenlerini okuyabilmeleri için gereken bu), Node'a erişemezler, ve
verdikleri adres ağdan yakalanan bir istekle **aynı** doğrulamadan geçer —
süre kontrolü, reklam filtresi, manifest ayrıştırma. Bir script öneri sunar,
karar vermez. Patlayan bir script kendi çıktısına mal olur, çözümlemeye değil.

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
    ownengine.js       yt-dlp kapalıyken indirme: parçalı HTTP + ffmpeg
    vault.js           şifreli kasa: AES-256-GCM, scrypt, şifreli dizin
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
2. **Oynatıcının kendi kaynak API'si.** Birçok sitede adres sayfada hiç yoktur:
   sayfa bir kimlik taşır, oynatıcı da akışı kendi arka ucundan ister
   (`/api/source/abc123`, `/player/index.php?data=…` gibi). HTML'i kazımak boşuna,
   çünkü orada bir şey yok. Oynatıcının soracağı ucu, sayfayı Referer vererek
   sormak aynı cevabı verir — hem de tarayıcı başlatmadan, tek istekte. Yalnızca
   sitenin kendi alanındaki uçlar sorulur.
3. **Script zinciri.** Bir yükleyici script gerçek oynatıcıyı `<script src>`
   etiketiyle değil `el.src = "…"` ile çağırır; zincir bir kat daha takip edilir,
   çünkü kaynak genelde o ikinci dosyadadır.
4. **Mobil sürüm.** Aynı site masaüstüne kaynağı JavaScript'te kuran bir oynatıcı,
   telefona ise düz bir `<video src>` verir — çünkü telefonun kendi oynatıcısı işi
   görür. Masaüstü taraması boş dönerse sayfa bir kez de telefon olarak istenir;
   akış çoğu zaman doğrudan işaretlemede durur. Bulunduysa bu istek hiç yapılmaz.
5. **Meta-refresh yönlendirmesi.** 3xx dönmeyen, yalnızca
   `<meta http-equiv="refresh">` ile yönlendiren sarmalayıcı sayfalar takip edilir.
6. **Watch → embed dönüşümü.** Bir sitenin izleme sayfası ile embed sayfası farklı
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
