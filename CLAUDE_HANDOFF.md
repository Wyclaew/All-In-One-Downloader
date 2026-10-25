## 0.15.0 — son durum / yeni test kaydı

25 Ekim2026. Package/lock0.15.0. Çalışma branch'i
`codex/resolver-player-accounts`; sürüm commit/tag/push sonuçları bu bölümün
altına eklenecek. Aşağıdaki WIP kayıtları önceki anlık durumdur.

- Son ortak **221/221 yerel test geçti,0skip**,6.6sn; typecheck+rendererbuild
  başarılı. `npmtest` son log `/tmp/aio-final-all.log`.
- GerçekElectron UI: tek dizi3bölüm, Ayarlar'da sitehesapları, ses seçiminin
  ekrandan çıkıp gelince korunması, Türkçe seçimin kuyrukişine ulaşması,
  1000pxdüzeni ve0rendererhatası geçti (`/tmp/aio-audio-ui.log`).
- GerçekmainIPC: kaynak cancel/retry/stop, metadataID, redaction, route değişimi,
  duplicatecount ve kitaplıkyedeği geçti (`/tmp/aio-final-ipc.log`).
- Gerçek yerelHTTPS hesap fixture'ı: giriş/kayıtPOST, tanınan hesaplinkleri,
  exact-origin redirectkoruması, tekdeneme sınırı; CAPTCHA/MFA/koşul/ekkimlik/
  ödeme/paroladeğiştirme blokları ve0dışistek/rendererhatası geçti
  (`/tmp/aio-final-accounts.log`). Gerçekhesapoluşturulmadı.
- Oynatıcı gerçekgeneratedmediasmoke: sesler~441/883Hz, herdosyadaOFF,
  asyncsubtitle/overlap, remuxkonum/hız/pause, nextOFF ve sentetik eşzamanlı
  audio/video zamanlamaboşluğunu bulma geçti (`/tmp/aio-player-final.log`).
- NativeTouchID: arm64+x64derleme/imza; yeniad-hoc SecureEnclaveblobrestore,
  AES-GCMroundtrip/tamper ve protectedECDH'nin `interactionNotAllowed`
  bağlamında reddi geçti. **Gerçekinsanparmakiziyle enable/open denenmedi**;
  kullanıcıkasasına veya kayıtlı Keychainanahtarına dokunulmadı.

### Son istek: indirme başına ses dili

Sources'ta grup, tekvideo ve topluseçim sesdropdown'u var: Türkçe/İngilizce/
kaynağınsesi. App'tetutulan seçimnavigate'dekorunur. IPC veenqueue tercihi
herişekopyalar; globalayarsonradandeğişseişdeğişmez. Bulk skip/duplicate artık
kalite+sesiseçiminihesabakatıyor; completedvideoyu farklısesleindirilebilir.
Gerçeksesdili `audioLanguage`, kalıcıuyarı `audioWarning` ve uygunlistediller
`audioAvailableLanguages` iletaşınır. Manuel seçilen dilindosyadabulunmadığı
biliniyorsa yanlışdublajdoneolmaz; mevcutgeçerlioutput `pendingFilePath` olarak
korunur, kullanıcı kaynak/dilseçimini değiştirebilir. Etiketsizses kesin
İngilizce/Türkçe sayılmaz; bilinmiyoruyarısı görünür. GerçekTR/EN AACpaket
hashleri remux'unkaynakistenenkanalı koruduğunu doğruladı.
Kalitefiltresi `[height<=?cap]`: bilinmeyenheightkabul, bilinenovercapret;
uncappedgeri dönüş yok. Offlinegerçekyt-dlptestive realexpiredHLScasegeçti.

### Dizibox — çözüldüğü doğrulanan güncel hata

Asılappbugları: staticphase gereksizyardımcıbetikleri bekleyip browserbudget'ı
tüketiyordu; bütüniframe navigasyonları tekreloadsayacınıdolduruyordu.
Documents-first/boundedstaticphase, knownplayeriframe önceliği, frame+aynıURL
bazlıreloadkoruması ve çerezsyncframealternatiflerini eleme uygulandı. Ekcurl
backend **eklenmedi**; NodeHTTPvegerçektarayıcıyla düzeldi. IPdeny için ayrı
`network-blocked` açıklamasıvar; kullanıcıyaseçmedendirect↔Tor geçilmez.

- 3Body1x1 publicpage, hesapsız/VPN'siz20.9snHLSbuldu;2segmentMP4
  **3.244.677bayt/6.089389sn**.
- Mentalist1x6 publicpage, hesapsız/VPN'siz16snHLSbuldu; normal45snayarla
  ikinciörnek **530.192bayt/10.03102sn**,19.7sntoplam. Örnekler silindi.
- Ara18sn/36sntoplamlimitdenemesi Mentalist'tetimeoutoldu; ağ/sitehâlâ
  aralıklıgecikebiliyor. Sonsuzgüvenilirlik/herlinkgarantisiverilmez.
- Mevcut eski Mentalistdosyasındaki42boşlukonarıldıdenmemeli; yeniilk2parça
  örneği60sncivarındaki eksik12.parçanıngerialınmasını doğrulamaz.

### Hesaplar / TouchID yeni dosyaları ve sınırlar

- `site-accounts.js`: bütünprofil+originizinleri safeStorage ileşifreli
  `site-accounts.enc`; plaintextbackend/basic_textreddedilir. APIpasswordinput
  only; status'tapasswordyok. Üyelik şartlarınıotomatikonaylama, ödeme,
  CAPTCHA/MFA/e-postakoduotomasyonu yok. Güvenilenoriginbaşına açıkizinvardır.
- `site-account-forms.js`: sadeceactualaccessgate'te navigasyon; tamHTTPSorigin,
  aynıoriginPOST ve yalnızstandartfields. `result.accountState` güvenlidurum.
- `electron/native/BIOMETRIC_STORAGE.md`: ad-hochelpergenericDPKeychain'in
  -34018riskini ve SecureEnclaveECDH/HKDF/AES-GCM modelinianlatır. Keydeviceblob
  +şifrelienvelope local0600; gerçeközelECDHişlemi biometryCurrentSetilekorunur.
  Eskiyetkilikayıtgeriokuma ve şifreyleyenidenetkinleştirme vardır.

Kalan: gerçekcihazTouchIDkullanıcıetkileşimi, eskiMentalist'in eksikCDNparçaları
alınarak ayrıdosyadayenidenkurulması, kullanıcınınasılYouTubeeşzamanlıhızının
sürümsonrasıölçümü; gerçekDRM/üyelik/insandoğrulamasıbypassuygulanmadı.
Plan [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md): önceki21+bu tur39geliştirme
başlığı; tamamlanmış ve kalan kapsam ayrıanlatılır.

---

# Güncel çalışma devri — 25 Ekim 2026

**Önce bu bölümü oku. Aşağıdaki 0.14.1 yayın kaydı tarihçedir.** Son yayımlanmış
sürüm hâlâ0.14.1, HEAD `afcac29`. Bu turdaki geniş geliştirmeler çalışma
kopyasında; henüz yeni commit, tag, paket veya GitHub yayını yapılmadı. Package
version0.14.1 bırakıldı. Yeni sürüm bildirimi bu WIP için henüz gelmez.

## Son kullanıcı istekleri ve öncelik

- Dizibox şu anda çözümlenmiyor; canlı yeniden üretim ve düzeltme sürüyor.
- VPN seçmeden çözümlenen kaynak, arkada Tor açık olsa da doğrudan indirilmeli.
- Mentalist'te aralıklı donma: dosyadaki eksik zaman dilimleri saptandı; gerçek
  dosya henüz onarılmadı veya değiştirilmedi.
- Oynatıcıda altyazılar **her yeni dosya/bölüm açıldığında kapalı** olacak.
- Ayarlara e-posta/parola ve site bazında otomatik giriş/kayıt tercihi isteniyor.
  Yeni özellik geliştirme halinde; henüz gerçek hesap oluşturulmadı.
- Kullanıcı Touch ID'yi etkinleştiremiyor. Sensörün available olması kayıt
  işleminin çalıştığı anlamına gelmiyor; native kayıt kök nedeni inceleniyor.
- Önceki GitHub push/tag/yayın isteği geçerli; ancak bütün yeni kodun son ortak
  testi ve paket doğrulaması tamamlanmadan yayın yapma.

## Çalışma kopyasında bulunan geliştirmeler

- Native açık DASH VOD: SegmentTemplate Number/Time, finite Timeline,
  SegmentList/ranges, inherited BaseURL, video+tercih edilen ses, uyumlu çoklu
  Period, cache/hash ile devam. DRM/live/karmaşık unsupported durumlar sınırdır.
- HLS/DASH/file parça izinleri sunucu+rota bazında paylaşılır;429/ağ hatasında
  eşzamanlılık azaltılır, başarılı isteklerle kademeli geri gelir.
- HTTP CONNECT soketinin paused bırakılması düzeltildi; son parça abort'unda
  pooled socket'a enjekte edilen AbortError yarışı giderildi.
- File resume prefix/hash/resource/validator ve Content-Range kontrolleri
  güçlendirildi. FFmpeg0 ile çıksa bile atlanan/bozuk segment uyarısı
  `MEDIA_INCOMPLETE` sayılır; eksik dosya tamamlandı diye yeniden adlandırılmaz.
- Typed/uzantısız kaynaklar, HTML base/data-setup, Shaka manifestUri,
  JSON-LD graph, göreli POST/JSON cevapları ve bounded Packer çözümü genişletildi.
- Nested HLS master depth/cycle kontrolü; doğrulanmış `preparedVariants`
  leaf URL'si, yüksekliği ve o dala ait ses grubu probe/recovery/types boyunca
  taşınır. Yanlış DRM pozitifleri azaltıldı.
- FIFO kuyruk, sırada öne alma, aktif aynı kalite/ses işini çoğaltmama,
  bulk IPC'de gerçek eklenen adet. Disk preflight/watchdog ile alan azsa
  partial'ı koruyarak paused;1500işte reentrant pump stack taşması engellendi.
- Özel kitaplık yedekleri (8snapshot), rolling last-good, bozuk orijinali
  koruyarak kurtarma, Ayarlar'dan elle yedekleme. Kasa yedeği değildir.
- Araç sağlık kontrolü var: dosyası var ama çalışmıyor ayrı gösterilir;
  FFprobe sürümü, ortak concurrent scan, doğru updater hata sonucu.
- Kaynağı direct/proxy arasında değiştirme düğmesi bağlı işleri duraklatır,
  yeni rota ile tekrar çözümler. Global proxy environment toolEnv'den
  temizlendi, yt-dlp'ye direct işler için bile açık `--proxy ''` veriliyor.
- Cookie export paylaşılırken tek bekleyenin abort'u diğer bekleyeni kesmez.
- Oynatıcı: her açılışta altyazıOFF, async subtitle seçim yarışı, örtüşen cues,
  konum/hız/pause koruyan remux, native ses kanalları, ses gecikmesi,
  klavye/focus/scrub düzeltmeleri, sonraki bölüm kontrolü ve oynatma tanısı.
  Explicit paket zamanlama taraması `electron/player/timing.js` içindedir.

## Mentalist — kanıt ve tamamlanmayan onarım

Kullanıcının izin verdiği salt-okunur inceleme:
`~/Downloads/Everything Downloader/The Mentalist 1.Sezon 6.Bölüm.mp4`
(diskte UnicodeNFD ad olabilir).723.799.695bayt,2630.008sn,1080p H264/AAC,
video58017frame, İngilizce AAC. **42 adet eşzamanlı video/ses boşluğu** var:
video sample duration5.046711sn(normal~0.0417), AAC5.016–5.039sn.
İlkler60.018,110.068,185.143,235.193sn; son2612.568sn.
Yaklaşık210sn içerik yok. DTS görünürde bitişik: mux aradaki süreyi önceki
sample'a yazdığı için yalnız `nextDTS-prevEnd` kontrolü bunu kaçırır.
Tam FFmpeg decode0exit/0warning verdi; decode başarısı eksik parçayı kanıtlamaz.

Public bölüm sayfası önceECONNRESET ile başarısızdı; doğrudan public embed
`https://dbx.molystream.org/embed/sheila/31275-6ab461053d660456859e002e`
çözüldü:526parça/~5.005sn. Manifest çok sayıda CDN hostuna dönüşümlü gider.
Parça0..11 alınabiliyor;12'nin hostu `db4.77777846.xyz` TLS ECONNRESET ile
tekrar tekrar başarısız(1connection ile de). Bu ilk eski boşlukla eşleşiyor.
FFmpeg'in eski remote HLS davranışının başarısız parçaları atlayıp0exit
vermesi güçlü açıklama; eski indirme logu yok, kesin tarihsel kanıt sayma.
Başka manifestte ilan edilen CDN hostunda aynı12yolunu deneme HTTP200başlık
verdi ama3.117.228bayttan yalnız77.784bayt/20sn geldi; **ayna doğrulanmadı**,
genel host-değiştirme veya onarım kodu eklenmedi. Orijinali koru; önce sınırlı
örnekte tam parça+zamanlama kanıtı al, sonra yeni ayrı dosya oluştur.

Geçici yerel araştırma: `/tmp/aio-mentalist-source.cjs`,
`/tmp/aio-mentalist-{source,embed,retry}.log`,
`/tmp/aio-mentalist-decode.log`. Geçici `aio-mentalist-investigation-*`
klasöründeki `source-private.json` çalışma token/jar yolları içerebilir:
Git'e veya paylaşılabilir rapora koyma. Gerçek kasa/tarayıcı çerezi okunmadı.
Gerçek kitaplıktan yalnız ilgili indirme/etkin ağ tercihleri salt-okunur alındı.

## VPN / hız — doğrulanan ile açık kalan

Canlı kullanıcının dört indirmesi useProxy=false, rateLimit boş, concurrency6,
connections6; hızlar~30–85KB/s idi. Çalışan yt-dlp süreçlerinde explicit proxy
argümanı yoktu. Bağlantı örneğinde15TCP/0loopback proxy/0Tor portu görüldü:
**yavaşlık Tor'a gidiyor diye doğrulanmadı**. macOS proxy durumunda WPAD/PAC
otomatik keşif açık. Yeni kod environment ve OS otomatik proxy seçimini
kapatıyor; sistem genelinde VPN'in OS rotasını aşma garantisi yok.
Kontrollü aktif proxy yanında iki direct transfer byte-exact bitti, proxyye
ilave veri0. Kullanıcıdaki hız artışı henüz ölçülmedi. yt-dlp2026.08.19,
Deno ve Node kurulu. Aynı YouTube public URL'de direct metadata0exit,
55format ve uyarısız çıktı verdi; JS runtime eksikliği bu örnekte bulunmadı.

## Son doğrulama durumu

- Önceki0.14.1:128/128yerel başarılı (aşağıda tarihçe).
- Bu WIP ilk toplu turda yalnız2DASH testi başarısızdı; ilgili socket/proxy
  düzeltmelerinden sonra engine odaklı25/25geçti, ek integrity testleri var.
- Root storage/queue/browser/health odaklı19/19geçti. Son route testinde
  tool-health yalnız testin eski PATHfixturebeklentisiyle düştü; beklenti
  gerçekkorunanPATHbileşenlerine düzeltildi. Tüm son sonuç yeniden çalıştırılmalı.
- Typecheck ve renderer build geçti; sonradan yeni değişiklikler oldu.
- Gerçek main IPC `tests/manual/source-lifecycle.js`: cancel/retry/stop,
  metadataID, redaction, route switchpauses, duplicatecount, backup geçti.
- Gerçek Electron player synthetic smoke: subtitleOFF/overlap/race, iki gerçek
  ses kanalı~445/879Hz, delay, konum koruyan remux, nextOFF,480px,0renderer ve
  ağ isteği;16pureplayer/timingtest raporlandı. Son ortak turda tekrar çalıştır.
- Tam güncel test logu: `/tmp/aio-resume-tests.log` (sonuç aşağıdaki ek notta).

## Devam sırası

1. Dizibox güncel403/IPblock sınıflamasını ve site hesap özelliğini bitir;
   IPengeli gerçeküyelikformu gibi ele alma. Herlink/DRMbypass garantisi verme.
2. TouchID native enable hatasını düzelt; gerçekparmakizi testi yapılmadıysa belirt.
3. npmtest/typecheck/build + isolated Electron source/player/resolver smokes.
4. Yeni README/release notes ve DEVELOPMENT_PLAN'da biten backlogları güncelle.
5. İncele, sürümü artır, commit/push/tag; Mac+Windows CI/paket/manifest
   doğrulaması ve0.14.1→yeni updater smoke; başarısız tag'i zorla taşıma.

---

# Tarihçe: yayımlanmış0.14.1

# Claude için devir notu — All in One Downloader 0.14.1

Son güncelleme: 23 Ekim 2026. Kullanıcının en son istediği genel mimari taraması,
otomatik Tor/ayrı kaynak oturumları, metadata ve görünür Touch ID geliştirmeleri
uygulandı. **v0.14.1 yayımlandı**, kaynak commit’i `f708cce`. Kullanıcının gerçek
kitaplığı, kasa dosyaları ve tarayıcı çerezleri testlerde kullanılmadı.

- Plan: [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) — 21 uygulanmış geliştirme,
  bütün ana katmanların taraması ve 40’tan fazla öncelikli sonraki iş.
- Sürüm: `0.14.1`; yayın hedefi
  [v0.14.1](https://github.com/Wyclaew/All-In-One-Downloader/releases/tag/v0.14.1).
- Yerel Apple Silicon paket: `release/mac-arm64/All in One Downloader.app`.
- Eski 0.13.0 yayın/test kaydı bu belgenin altındadır; aşağıdaki yeni sonuçların
  yerine eski 55 test sayısı kullanılmamalı.

## GitHub yayın ve güncelleme doğrulaması — 0.14.1

- `main` ve annotated `v0.14.1` etiketi GitHub’a gönderildi. Yayın draft veya
  prerelease değil; Mac arm64/x64 DMG+ZIP, Windows EXE, blockmap ve iki update
  manifesti hazır.
- [Release workflow40021560748](https://github.com/Wyclaew/All-In-One-Downloader/actions/runs/40021560748)
  **success**: Mac, Windows ve Install notes başarılı. İki runner’da da
  **116 geçti / 0 hata / 12 skip**. FFmpeg/yt-dlp olmayan runner’ların atladığı
  gerçek araç senaryoları yerelde çalıştı; CI128tam çalıştı denmemeli.
- Yayındaki Mac arm64 ZIP’i yeniden indirildi: **95.400.475bayt**;
  `latest-mac.yml` boyutu ve **SHA-512** eşleşti. Açılan paketin deep/strict
  codesign kontrolü geçti; içindeki **43 kaynak/arayüz dosyası** çalışma
  kopyasıyla bayt olarak aynı. Paket sürümü0.14.1 ve içindeki native helper’ın
  promptsuz status sonucu `available=true`. Uygulama/kasa kurulup açılmadı.
- Bütün7 zorunlu paket/manifest aynı sürümde doğrulanmadan taslak yayımlanmadı.
  Etiket kaynak commit’i `f708cce`; daha sonraki devir doğrulama kaydı uygulama
  kodunu değiştirmez.
- `tests/manual/update-smoke.js 0.13.0 0.14.1`, gerçek updater kodunu ayrı
  geçici profilde public GitHub’a karşı çalıştırdı: `available`, `latest=0.14.1`,
  `automatic=true`. Kullanıcının çalışan uygulaması kurulmadı/değiştirilmedi.
  Bu yeni sürümü bulma ve uygun otomatik hedef seçiminin doğrulamasıdır.
- Otomatik kontrol açıksa açılışta yaklaşık15sn ve ardından6saatte bir uygulama
  üst banner’ı gelir. Hemen görmek için Ayarlar → Uygulama → Güncellemeleri
  denetle. OS bildirimi veya sessiz otomatik kurulum eklendi denmemeli.

## 0.14.1 ağ yaşam döngüsü

- Yeni `network-context.js`: `ensureForSource(id,{settings,signal,onProgress})`
  etkin vekil adresini verir. `getContext` yalnızca güvenli tür/etiket döndürür;
  `releaseSource` ve `shutdown` kendi köprülerini kapatır.
- Boş adres veya uygulamanın SOCKS5 loopback9061–9065 seçimi yönetilen Tor’dur.
  Harici9050/9150, WARP40000 ve özel vekil ayrı kalır. Yeni kurulum9061;
  var olan kullanıcının özel adresi üzerine yazılmaz.
- `autoStartTor` ve `isolateTorSources` varsayılan true. Eski `torAutoStart`
  açılışta hatırlanan çalışma tercihi içindir; isteğe bağlı başlatma onu
  değiştirmez. Tor kurulu değilse kurulum mesajı gelir, doğrudan ağa geçilmez.
- Chromium SOCKS kullanıcı/parola doğrulamadığı için kaynak başına kimliği gizli
  bir loopback köprüsü ekler. Köprü, Tor’a kaynak başına rastgele ve sabit
  SOCKS kimliğiyle gider. `IsolateSOCKSAuth KeepAliveIsolateSOCKSAuth` kullanılır.
  Tek Tor daemon’u vardır. Tarayıcı/Node/yt-dlp aynı kaynağın kimliğini kullanır;
  parçaları ayrı devrelere dağıtmak IP’ye bağlı imzalı adresleri bozabileceği
  için yapılmaz. Farklı çıkış IP’si veya hız artışı garantisi yoktur.
- Eşzamanlı başlatanlar ortak açılışı paylaşır; bir bekleyenin iptali diğerini
  kesmez. Son bekleyen, geç gelen process ve timeout durumları test edildi.
  Sınırlar64 kaynak/128 bağlantı-kaynak/512 toplam socket. Kimlikler runtime’dır.
- `probe`, metadata, `startOwn`, `startYtdlp`, kurtarma ve **pendingFilePath son
  işlem devamı** etkin adresi hazırlar. Uygulama yeniden açılıp kimlik değişirse
  çözülmüş sayfa akışı indirmeden önce yenilenir.
- Tor’u kapatmak yalnızca Tor’u kullanan işleri durdurur/duraklatır; özel vekil
  işleri etkilenmez. Kaynak silinince köprüsü kaldırılır, sıradan iptal mevcut
  indirmeyle paylaşılan kimliği silmez. Çıkışta bütün kendi köprüleri kapanır.
- VPN’li kaynak/indirme kapakları renderer’ın doğrudan oturumunda yüklenmez.
  Yerel dosya karesi/data görseli kullanılabilir; ağdan vekilli kapak önbelleği
  henüz eklenmedi. Bu, medya akışı dışında fark edilen ağ sızıntısını kapatır.

## Metadata ve kaynak araçları

- `mediainfo`: scoped, yönlendirme başına çerez hesaplayan ve sadece başlık
  okuyan dosya incelemesi; HEAD reddinde bir byte GET. Yanıt gövdesi indirilmez.
- HLS süreleri gerçek segmentlerle, fractional EXTINF ve tamamlanmış playlist
  kontrolüyle; DASH süreleri bounded XML ağacı, namespace, inheritance, dönem
  sınırları ve finite timeline üzerinden çıkarılır. Bozuk XML, geçersiz
  timescale ve sahte LL-HLS PART metadata üretmez. Canlı/unknown ayrılır.
- HLS boyutu average bitrate, bütün bayt aralıkları veya en çok3 segment
  başlığından; DASH boyutu süre+uygun bitrate’ten tahmin edilir. Mux çıktısı
  farklı olabileceği için segment tahminleri kesin dosya boyutu sayılmaz.
- En yüksek varyant kesin bozuksa çalışan alt varyant doğrulanır. `selectedVariantUrl`
  ve bounded `rejectedVariantUrls` medya/indirme boyunca taşınır; `pickVariant`
  doğrulamada reddedileni tekrar seçmez. Test edilmemiş kaliteler korunur.
- Gerçek HTMLMediaElement metadata’sı yüklediği kaynakla ilişkilendirilir.
  `durationSource`: manifest/player/probe/extractor; `filesizeSource`:
  content-length/probe/manifest-bitrate/segment-sample/byte-ranges/probe-bitrate/extractor.
  `isLive` null olabilir. Bilinmeyen süre false/0’a çevrilmez.
- Metadata işleri ayrı AbortController ve en çok3 işçi/180sn/200öğe sınırı
  kullanır. Otomatik eksik tarama limiti ayarlıdır; kısmi sonuçlar15dk içinde
  otomatik tekrarlanmaz, elle tekrar mümkün. Eski iptal edilmiş iş, yeni işin
  güncellemesini/bitirme durumunu ezemez. Medya kimliği değiştirilmez.
- Kaynak IPC: cancel, cancelAll, retryFailed, metadata, diagnostics. Rescan ve
  assisted capture ortak çözümleme kuyruğuna girer. Silinmiş/iptal edilmiş
  kuyruk girdileri çalışmaz; iptalden sonra gerçek öğe sayısı hesaplanır.
- Sources ekranı toplu/per-source araçlar, ağ etiketi, network notu, eksik bilgi
  sayısı ve rapor modalı içerir. İç kontrolün klavye olayı grup başlığını açmaz.
- `diagnostics.js` en çok60 olay tutar. Paylaşılabilir raporda URL yolu/query,
  HTTP/SOCKS kimlikleri, Cookie/Authorization ve token’lar temizlenir. Tam
  medya URL’si, çerez dosyası ve kasa anahtarı rapora konmaz.
- Yeniden başlatmada ölmüş ağ etiketi, yarım metadata yüklemesi, eski hız/ETA
  temizlenir. Araçlar ekranında ffprobe görünür.

## Altyazı, çerez ve kasa düzeltmeleri

- `subtitle-fetch.js`: scoped HTTP + seçili vekille doğrudan VTT/SRT/ASS veya
  sınırlı HLS WebVTT önce özel yerel dosyalara alınır. FFmpeg sadece `file`
  protokolüyle dönüştürür; uzak URL/çerez başlığı FFmpeg’e verilmez. Toplam16MiB,
  30sn, en çok2000segment/4işçi sınırları ve exclusive dosya oluşturma var.
- `allowed_extensions` yalnızca yerel HLS girdisinde verilir; düz VTT/SRT
  demuxer’ına HLS seçeneği gönderilmez. Generic binary CDN MIME, içerik geçerli
  metin altyazısıysa kabul edilir. Canlı/encrypted/range/fMP4 altyazı türleri
  açıkça reddedilir; hatalı kaynak gömülmüş altyazı diye raporlanmaz.
- Cookie jar’lı uzak ffprobe atlanır. Desteklenmeyen uzak FFmpeg aktarımında
  jar varsa güvenli biçimde hata verilir; native scoped HLS veya yt-dlp
  kullanılmalıdır. FFmpeg’in global Cookie header’ı yönlendirme/alt manifestte
  host-only/Secure/path kapsamını güvenle koruyamıyor; `-cookies` sürümler
  arasında güvenilir host-only eşdeğeri varsayılmadı. Yerel mux etkilenmez.
- ownengine dosya/probe isteklerinde **aynı hostun farklı yoluna yönlendirmede
  de** Cookie yeniden hesaplanır. Header bekleyen dosya probe’u iptal edilir.
- `browsers.exportCookieJar` artık örnek internet isteği göndermez. Yerel boş
  playlist + `--load-info-json --no-clean-info-json --skip-download` kullanır.
  mkdtemp0700, baştan0600 dosyalar, tarayıcı argümanı başına cache/tek in-flight
  export ve hata temizliği var. Eski verilen jar’lar aktif iş referansı
  kaybolabileceği için TTL’de silinmez; referanslı yaşam döngüsü sonraki iştir.
- Vault’un kilitli/açık/ilk kurulum ekranında kalıcı Touch ID paneli var.
  Native LAContext durumları sensör/kayıt/lockout/helper sorununu açıklar;
  sabit güvenli macOS Touch ID ayarı bağlantısı ve durum yenileme bulunur.
  İlk kayıt için şifreyle açmak gerekir. Keychain anahtarı eskimiş/kayıpsa
  yeniden kayıt yolu gösterilir. Native Keychain koruma bayrakları aynı kaldı.
- Şifre türetme ve indeks yükleme sırasında candidate anahtar oturuma
  atanmaz; epoch kontrolü uyku/kilit sonrası eski şifre işleminin kasayı
  tekrar açmasını önler. Biyometrik key identity/epoch kontrolleri korunur.

## Doğrulama — 0.14.1

- Son tam yerel tur: **128/128 geçti, 0 skip**, yaklaşık12.6sn. Gerçek araçlarla
  şifreli/plain HLS, byte-range/resume, ses seçimi, kaynak kurtarma ve **Türkçe
  altyazının bitmiş MP4’e gerçekten gömülmesi** test edildi. Önceki ara turlarda
  yeni caption fixture’ın Electron shim/MIME kurulum hataları düzeltildi.
- `postprocessing-route.test`: var olan dosyanın son işlemi sürdürülürken Tor
  yolu hazırlanır ve altyazı aynı kaynağın proxy adresini alır.
- Gerçek yt-dlp2026.08.19, sentetik Firefox SQLite profili ve yasaklanmış
  DNS/socket ile çevrimdışı export yaptı; **0 ağ isteği**. Gerçek kullanıcı
  tarayıcı çerezi/Keychain girdisi okunmadı.
- Gerçek Tor0.4.9.11 + Chromium: `tests/manual/tor-smoke.js` son tur71.7sn;
  tek daemon, iki farklı SOCKS kimliği, Node ve Chromium’un aynı kaynak
  kimliklerini paylaşması, ikisinin Tor Project API’de IsTor=true alması,
  kendi daemon’unun kapanması ve geçici profil temizliği geçti. Çıkış IP’leri
  yazdırılmadı; farklı IP veya hız ölçümü yapıldı sayılmaz.
- `tests/manual/source-lifecycle.js`: gerçek main IPC + renderer bridge ile
  kuyruktaki işin iptali sonrası istek gitmemesi, toplu retry/stop, metadata
  kimliği korunması ve temizlenmiş rapor geçti.
- Gerçek Chromium controlled resolver suite: POST/nested/state/alternatif
  oynatıcı, cookie’li MP4 için player duration/exact size, HTML/404 reddi,
  gizlenmiş DASH DRM, stalled manifest sınırı ve oturum reuse temizliği geçti.
- Verilen canlı iki URL’de yeniden kısa örnek: Dizibox3.244.677bayt/6.089389sn
  (14.8sn toplam), Hdfilmcehennemi4.131.693bayt/15.014989sn (31.3sn toplam).
  Bölüm süresi yaklaşık3635sn bulundu. Hdf başlangıç403 doğrulaması sürse de
  sayfanın alternatif oynatıcısından akış bulundu; TR VTT HTTP200/3288bayt
  gözlendi. Bu altyazı yanıtının bütün bölümü kapsadığı veya sesin İngilizce
  olduğu doğrulanmadı; canlı tam bölüm indirilmedi, örnekler silindi.
- Synthetic Sources/Vault light/dark dar pencere UI kontrolleri, yeni
  düğmeler, rapor/copy, klavye guard, Tor settings toggles/WARP koruması geçti.
  Gerçek main UI smoke: tek koleksiyon3bölüm, sezon sırası, renderer error0.
- Typecheck, renderer build ve diff whitespace kontrolü geçti. Native helper
  arm64/x64 derleme/imza ve bu Mac’te **sadece promptsuz available durumu**
  doğrulandı. Gerçek parmak izi kaydet/aç yapılmadı; kullanıcı kasası açılmadı.

## İlk CI turundaki Windows test düzeltmesi

- `v0.14.0` etiketinin Mac kontrolleri geçti; Windows’ta tek test, simüle edilen
  native helper yolunu POSIX slash sabitiyle karşılaştırdığı için başarısızdı.
  Uygulama hatası değildi. Beklenti `path.join` ile platform bağımsız yapıldı.
- Yarım0.14.0 otomatik yayına açılmadı; etiket zorla taşınmadı. Düzeltme yeni
  **v0.14.1** etiketiyle iki platformda yeniden doğrulandı. Uygulama özellikleri
  aynı; değişiklik test beklentisi ve sürüm numarasıdır.

## Yerel paket doğrulaması — 0.14.1

- Apple Silicon uygulaması `--publish never` ile üretildi. Deep/strict codesign
  doğrulaması geçti; app.asar içindeki **43 kaynak/arayüz dosyası** çalışma
  kopyasıyla bayt olarak aynı, paket sürümü0.14.1.
- Paket içindeki native helper’ın promptsuz status çağrısı
  `available=true` döndürdü. Gerçek kasaya erişim veya biyometrik kayıt yapılmadı.

## Kalan önemli sınırlar

- Her bağlantıyı koşulsuz çözme, gerçek üyelik/DRM/CAPTCHA atlatma veya Tor ile
  hız garantisi yok. Yeni native DASH/liveHLS motoru henüz yazılmadı.
- Cookie snapshot/export dosyalarının referanslı süre/çıkış temizliği, idle Tor
  kaynak emekliliği ve kaynak bazında ağ değiştirme plandadır.
- Gerçek Touch ID kayıt/aç etkileşimi, tam film/dizi resume ve Windows cihazında
  kurulum/indirme halen manuel test değerindedir. CI Windows paket üretimi,
  gerçek Windows cihaz testi yerine geçmez.
- Plan uygulanmış/sonraki işleri açıkça ayırır. Reklam/izleyici listesi bu turda
  büyütülmedi; güvenilirlik, görünür kontroller ve ağ tutarlılığına odaklanıldı.

## Araştırma kaynakları — bu tur

- [Chromium SOCKS ve kimlik doğrulama sınırı](https://chromium.googlesource.com/chromium/src/+/a3e71ebfa307d8760eb68b777e2998a869940092/net/docs/proxy.md)
- [Tor SOCKS isolation](https://spec.torproject.org/socks-extensions.html)
- [HLS RFC8216](https://www.rfc-editor.org/rfc/rfc8216.html)
- [DASH zaman modeli](https://dashif.org/Guidelines-TimingModel/)
- [FFmpeg HTTP cookies](https://ffmpeg.org/ffmpeg-protocols.html#HTTP-Cookies)
- [FFmpeg güncel HTTP uygulaması](https://ffmpeg.org/doxygen/trunk/http_8c_source.html)
- [Apple LocalAuthentication](https://developer.apple.com/documentation/localauthentication)

---

# Önceki yayın kaydı — 0.13.0

Son güncelleme: 23 Ekim 2026. 0.11.0/0.12.0 geliştirmeleri ve üçüncü kod denetimi
bu sürümde birleştirildi. **v0.13.0 yayımlandı**, kaynak commit'i `6b1380d`.
[Sürüm ve indirmeler](https://github.com/Wyclaew/All-In-One-Downloader/releases/tag/v0.13.0).
Kullanıcının gerçek kitaplığı, kasa dosyaları ve indirilen
videoları testlerde kullanılmadı. Yerel Apple Silicon uygulaması:
`release/mac-arm64/All in One Downloader.app`.

## GitHub yayın ve güncelleme doğrulaması

- `main` ve annotated `v0.13.0` etiketi push edildi. Mac arm64/x64 DMG + ZIP,
  Windows EXE, blockmap'ler ve iki update manifesti yayınlandı. GitHub `/latest`
  bu sürümü döndürüyor; draft/prerelease değil.
- [Release workflow 39862592920](https://github.com/Wyclaew/All-In-One-Downloader/actions/runs/39862592920)
  son durumda **success**: Mac build, Windows build ve Install notes başarılı.
  Yerelde **55/55** test geçti. Her iki CI runner'da araçlar eksik olduğu için
  **46 geçti, 9 FFmpeg/yt-dlp entegrasyonu atlandı**, hata yok. Bu 9 test yerelde
  gerçek araçlarla çalıştı; CI'da bütün 55 çalıştı denmemeli.
- İlk notes denemesi GitHub draft release'ini tag endpoint'inden okuyamadı
  (404). `build/verify-release.js` authenticated, sayfalı release listesinde
  tag arayacak şekilde düzeltildi; bu araç değişikliği `main` üzerindedir ve
  uygulama paketinin kodunu değiştirmez. Aynı v0.13.0 taslağındaki 7 zorunlu
  paket/manifest doğrulandı, yayınlandı ve notes job yeniden çalıştırılıp geçti.
  Yayın etiketi zorla taşınmadı; yeniden uygulama sürümü üretilmedi.
- Yayındaki Mac arm64 ZIP'i GitHub'dan yeniden indirildi: **95.375.859 bayt**,
  `latest-mac.yml` ile SHA-512 eşleşti. Açılan paketin deep/strict codesign
  doğrulaması geçti; app.asar içindeki **40 kod/arayüz dosyası** çalışma kopyasıyla
  bayt olarak aynı, paket sürümü 0.13.0. Yerel paket de aynı kontrolleri geçti.
- Ayrı geçici veri klasörüyle **v0.10.0 etiketindeki gerçek eski updater kodu**
  ve yeni updater, public GitHub API üzerinde test edildi. İkisi de mevcut
  sürüm 0.10.0 iken `phase=available`, `latest=0.13.0`, `automatic=true` döndürdü.
  Bu, bildirim ve indirilebilir hedef seçiminin doğrulamasıdır; kullanıcının
  çalışan uygulaması değiştirilmedi, tam otomatik swap/install denenmedi.
- README ve yayın notları 0.13.0 davranışını anlatır. Otomatik kontrol açıksa
  açılıştan 15 sn sonra ve 6 saatte bir üst banner gelir; elle kontrol de vardır.

## 0.13.0 kod denetiminde eklenen düzeltmeler

- Browser taramasının JSON/manifest türetme istekleri sınırlı boyut ve süreyle
  çalışır; iptal bunlara iletilir. Manifest türetme artık çerezler silindikten
  sonra yapılmaz. Son snapshot oturumu kullanılır. Havuz oturumu geri verilmeden
  istekler, HTTP auth/cache/storage temizlenir; cleanup hatası olan slot yeniden
  kullanılmaz. Kapanmış taramanın callback'i yeni aday ekleyemez.
- Ölçüm tamamlanırken yeniden settle timer kurulması önlendi. Aynı iframe'in
  yeniden atlanması alternatif deneme bütçesini tüketmez.
- `video/main.m3u8` gibi başında slash olmayan göreli JSON/config kaynakları
  tanınır. Lazy iframe'deki about:blank, gerçek data-src adresini örtmez.
- ffprobe'un bir PNG/JPEG'i video stream olarak raporlaması artık doğrulama
  için yeterli değildir. Gerçek PNG regresyon testi var. Statik sayfanın altyazısı
  browser sonucuna taşınır; zorunlu/forced altyazı işareti korunur.
- HLS video/ses manifestlerinden biri hata verince diğerinin başlık bekleyen
  isteği de durdurulup beklenir; fallback sırasında başıboş istek kalmaz.
- Updater kontrolleri tek promise paylaşır; indirme sırasında kontrol durumu
  ezilemez. Disk writer error/backpressure pipeline ile ele alınır, yanlış
  SHA-512 paketi silinir. Manifest sürümü/asset boyutu/hash/filename doğrulanır.
  SemVer prerelease sırası sayısal karşılaştırılır. Başlatılamayan kurulum helper'ı
  yakalanmayan process error üretmez. Tekrarlanan schedule eski startup timer'ı siler.
- `update-metadata.js` saf metadata işlemlerini ayırır; updater için 8 regresyon
  testi eklendi. Ağ yanıt boyutu/metadata bekleme süresi sınırlıdır. Arka plan
  kontrolü geçici hata verirse mevcut yeni sürüm bildirimi kaybolmaz.
- Release workflow iki platformda `npm test` çalıştırır. Paket sürümü/tag eşleşir.
  `releaseType: draft`; `build/verify-release.js` iki Mac ZIP/DMG, Windows EXE ve
  iki update manifestinin yüklenmiş/aynı sürüm/doğru boyut/hash olduğunu doğrular.
  Yalnızca bütün build'ler başarılıysa notes job taslağı yayımlayıp latest yapar.
- Depo public; otomatik kontrol GitHub erişim anahtarı gerektirmez. Uygulama
  açılışından yaklaşık 15 sn sonra ve 6 saatte bir bakar. Kullanıcı otomatik
  kontrolü kapatmışsa Ayarlar → Uygulama'dan elle kontrol gerekir. Bildirim
  uygulamanın üst banner'ıdır; işletim sistemi bildirimi eklendi denmemeli.

## Gerçekte doğrulanan sonuç ve kalan sınır

- Kullanıcının verdiği Dizibox adresi:
  `https://www.dizibox.live/3-body-problem-1-sezon-1-bolum-izle/`.
  Oturum/üyelik olmadan, sayfa → `/player/king/king.php` →
  `dbx.molystream.org/embed/...` zinciri takip edildi. Tarayıcı motoru HLS akışını
  ve **3635 saniyelik** süreyi buldu. Yeni **kendi HLS HTTP motoru** iki parça alıp
  FFmpeg ile yalnızca yerel olarak birleştirdi: **3.244.677 bayt**, ffprobe ile
  **6,089389 saniye** okunabilir video. İkinci bağımsız denemede de aynı çıktı
  alındı (çözümleme + örnek yaklaşık 24 sn; süre ağ ve siteye bağlıdır).
  Önceki turda yt-dlp `--test` yolu da 2.409.596 bayt aktarmıştı; yeni kanıt
  yt-dlp kullanmadan aktarımdır. Ayrı altyazı veya ses dili etiketi bulunmadı.
- `https://www.hdfilmcehennemi.nl/dizi/3-body-problem/sezon-1/bolum-1/`
  ilk sayfada HTTP 403 + Cloudflare managed challenge döndürmeye devam etti.
  Yeni çözümleme, sayfanın sunduğu **hdfilmcehennemi.mobi oynatıcısına** geçerek
  `srv9.cdnimages*.shop` üzerindeki **3635 saniyelik HLS** akışını buldu.
  Kendi motoru iki parçadan **4.131.693 bayt**, **15,014989 saniye** okunabilir
  video üretti. İki bağımsız deneme başarılıydı (yaklaşık 34 ve 59 sn).
  Türkçe altyazı adresi ayrıca HTTP **200**, **WebVTT**, **35.180 bayt** olarak
  doğrulandı. Hesap girişi, kullanıcı çerezi ve görünür insan doğrulaması
  kullanılmadı; CAPTCHA çözme/üyelik atlatma eklenmedi.
- Hdfilmcehennemi ses kanallarının dil alanları boştu. Örneklerin **İngilizce
  olduğu doğrulanmadı**; Türkçe WebVTT'nin varlığı, örnek videoya gömüldüğü
  anlamına gelmez. Bu canlı test sınırlı video + altyazı adresi doğrulamasıdır.
  Tam bölüm indirme, bütün bölümün oynatımı ve uçtan uca altyazı gömme canlı
  sitede test edilmedi. Çıktılar geçiciydi ve silindi.
- İlk turdaki doğrudan uzak FFmpeg/Dizibox başarısızlığı yerinde kaldı; yeni yol
  uzak medyayı FFmpeg'e okutmak yerine HTTP ile kendisi alır, FFmpeg'e yerel
  parçalar verir. Bu ayrım önemlidir; uzak FFmpeg yolu düzeldi denmemeli.
- Bütün siteleri koşulsuz çözme garantisi yok. Gerçek üyelik, CAPTCHA ve DRM
  gereksinimlerini atlatan bir sistem eklenmedi. Sunucu/CDN/ağ sınırları nedeniyle
  her durumda mutlak en yüksek hız veya kesin bitiş zamanı garanti edilemez.
- 0.13.0 denetiminden sonra canlı örnekler tekrar geçti: Dizibox 3.244.677 bayt /
  6,089389 sn (yaklaşık 15 sn toplam), Hdfilmcehennemi 4.131.693 bayt /
  15,014989 sn (yaklaşık 30 sn toplam). İkisi de 3635 sn kaynak bildirdi.
  Hdfilmcehennemi'de Türkçe işaretli VTT yeniden HTTP 200 döndü; yanıt bu kez
  3.288 bayttı. Kaynak birden fazla track sunduğu için bu boyutların sabit veya
  bütün bölümün tam altyazısı olduğu varsayılmamalı. Forced track seçimi ayrıca
  düzeltildi. Canlı testler yine tam bölüm indirmedi.

## Çözümleyici ve ağ

- `resolverFirst: true`: genel sitelerde önce kendi çözümleyicisi çalışır,
  sonuç yoksa yt-dlp denenir. YouTube/Vimeo/Twitch vb. özel platform çıkarıcıları
  ve playlist davranışı korunur. Ayarlar → Erişim'de sıra değiştirilebilir.
- `source-discovery.js`: Next/Nuxt/application JSON, nested source nesneleri,
  dil/MIME alanları, göreli/uzantısız adresler, base64 veri ve srcdoc okunur.
  İndirilen kod eval/Function/vm ile çalıştırılmaz; derinlik/düğüm/boyut bütçesi
  vardır. Görsel/script/iframe src niteliğini video config'i sanma düzeltildi.
- `browser-discovery.js`: oynatıcının gerçek fetch/XHR **POST yanıtı**, JSON,
  atob çıktısı, video currentSrc ve runtime state okunur. POST endpoint'i yanlış
  bir GET ile yeniden çağırmak yerine orijinal yanıtın sınırlı kopyası incelenir.
  JS/Node/IPC köprüsü açılmaz. Yanıt okuma ve aday sayıları sınırlıdır.
- **Kritik hata:** eski HOOK_SCRIPT template literal'ında kaçışsız regex slash'ı
  tarayıcı programını SyntaxError ile tamamen durduruyordu. Düzeltildi; enjekte
  edilen tüm programları derleyen regresyon testi ve gerçek Chromium'da POST
  fixture testi eklendi. Eski sınırsız fetch clone/text okuması da kaldırıldı.
- Gerçek Referer/Origin/User-Agent, onBeforeSendHeaders üzerinden akışa taşınır.
  İç içe ve runtime iframe'ler kaydedilir; derindeki oynatıcı önce denenir.
  Kapsamı oynatıcıyla sınırlı alternatif düğmeler dil tercihine göre denenir.
  Giriş/üyelik/indirme/satın alma düğmeleri otomatik tıklanmaz.
- İçerik/MIME doğrulaması uzantısız veya image/png dönen manifestleri tanır;
  HTML/404 ve HTML'e çıkan master playlist video kabul edilmez. Kısa gerçek
  videolar yalnızca kısa diye reklam sayılmaz; bildirilen uzun bölüm süresi ve
  açık reklam işaretleri dikkate alınır. DRM etiketleri ayrı kalır.
- Tarayıcıda en fazla 4 eşzamanlı ölçüm, 80 aday; genel çözümlemeye ayarın 2 katı,
  en çok 180 sn bütçe var (kapanış/temizlik ek süre alabilir). İptal ağ/ffprobe
  işlemlerine iletilir. Daha önce browser kullanan hostta ucuz iç oynatıcı
  keşfi tamamen atlanmaz; tekrar deneme yolu canlı sitelerde ayrıca sınandı.
- `proxy.js`: keep-alive bağlantı havuzu, IPv4/IPv6 adres denemesi, gzip/deflate/br
  çözme, boyut sınırı, yanıt zaman aşımı, geçici hatalarda sınırlı geri çekilme,
  Retry-After desteği. Yönlendirmede başka origin'e Cookie/Authorization taşınmaz.
- `resolver.js`: statik taramada seçilen/yakalanan Netscape oturumu kullanılıyor.
  Mobil taramadan gelen adayın kendi User-Agent'i korunuyor. HTML entity,
  srcdoc/base64 doküman ve göreli config adresleri daha iyi okunuyor. Genel
  `url:` alanlarından schema/menu bağlantılarını video sanma azaltıldı.
- Paralel çözümlemelerde engelleme kuralları ayrıldı. Yeniden kullanılan Chromium
  oturumunun proxy ayarı ilk navigasyondan önce tamamlanır; doğrudan bağlantıda
  eski proxy kalmaz. Akış doğrulaması tarayıcının güncel çerezleriyle yapılır.
- Kaynak silme/yeni tarama, önceki çözümlemeyi AbortController ile durdurur.
  Yarım kalan eski tarama yeni sonucu sonradan ezmez. yt-dlp metadata işlemlerinin
  toplam çalışma süresi sınırlandı.
- `probe.js`: genel “Unable to download” artık otomatik olarak “Ağa ulaşılamadı”
  değildir. DNS, zaman aşımı, HTTP erişim reddi, gerçek giriş gereksinimi ve site
  doğrulaması ayrı ele alınır. Eksik yt-dlp'de kendi çözümleyicisine geçilebilir.

## Otomatik kurtarma

- `recovery.js` ortak hata sınıflaması/backoff; Ayarlar → Aktarım'da açma/kapama ve
  1–6 deneme bütçesi (varsayılan 3).
- Kuyruk geçici ağ/5xx/429 hatalarında kontrollü bekler. 429 bağlantı sayısını
  azaltır. Süresi dolmuş çözümlenmiş akış (403/410 ve uygun 404/format hatası)
  orijinal sayfasından tekrar bulunur. Tercih edilen ses ve süre benzerliği
  korunur; varsa önceki yakalanmış oturum yeniden kullanılır.
- Bekleyen yeniden deneme duraklatılabilir/iptal edilebilir. Manuel tekrar deneme
  yeni bütçe açar. Giriş/DRM/disk hataları sonsuz otomatik döngüye girmez.
- yt-dlp'de HTTP/parça backoff ve eksik fragmentte durma açık; videoda sessizce
  boşluk bırakılması önlenir. Ağ aşaması uzun süre takılırsa süreç sonlandırılır.
- Ses/altyazı hazırlığı bitmeden “tamamlandı” bildirimi verilmez. Altyazı ekleme
  hatası indirilen geçerli videoyu başarısız saymaz. Tamamlanmış video hazırlık
  sırasında duraklatılmışsa tekrar ağdan indirmek yerine hazırlığa dönülür.

## Parçalı indirme, hız, ETA

- **Yeni `hls-native.js`**, `nativeHls: true`: çözümleyiciden gelen HLS VOD'u
  varsayılan olarak kendi HTTP motoru indirir. Ortak görev kuyruğu, 1–16 worker,
  sınırlı parça retry, HTTP/SOCKS vekili, ortak hız limiti; TS ve fMP4/init map,
  AES-128 (DRM değil), sequence IV ve HTTP bayt aralığı desteği vardır.
- `${destPath}.segments/plan.json` atomik günlüğü; her tamamlanmış parçanın
  boyutu/SHA-256'sı doğrulanır. Duraklatma/tekrar denemede yalnızca eksikler
  istenir. Başka dosyaya ait geçici klasör silinmez. Plan/URL/kalite kimliği
  değişince eski parçalar karıştırılmaz: imzalı adres yenilenirse cache sıfırlanabilir.
- Yanlış Range, eksik gövde, hata HTML'i ve desteklenmeyen parça içerikleri
  başarı sayılmaz. İptalde worker'lar bitmeden dosyalar silinmez. Başlık bekleme
  aralığındaki abort response hatasının ana süreci çökertmesi de önlendi.
- FFmpeg'e yalnızca üretilmiş yerel playlist ve doğrulanmış yerel TS/MP4/AAC
  parçaları verilir; ağ/key URI yoktur. Protokol `file`, demuxer formatları
  sınırlıdır. Yeni FFmpeg'in extension_picky seçeneği destek kontrolüyle
  uygulanır. Yerel işlem sırasında indirme sayacı işleniyor durumunu ezmez.
- Canlı/LL-HLS/GAP ve desteklenmeyen biçimler uzak FFmpeg yoluna döner;
  **o yol kaldığı yerden sürdürülemez**. AES-128 dışı DRM çözülmez. Fragment
  boyut sınırı 64 MiB. HLS motoru Ayarlar → Erişim'den kapatılabilir.
- HLS ETA en az 3 tamamlanmış parçadan sonra gerçek bayt/süre oranını nominal
  manifest bitrate'ına tercih eder. Resume baytları hıza katılmaz. AES padding
  ve CDN ön eki çıkarılırken hız sayacı geriye gitmesin diye ağ baytları ayrı
  sayılır. Çok hızlı biten/az veri olan aktarımda ETA boş kalabilir.
- `ownengine.js`: N sabit büyük parça yerine küçük görevleri ortak kuyruktan alan
  N worker. Hızlı bağlantı yeni işi alır; yavaş bir kanalın dosyanın sabit dörtte
  birini bitirmesi beklenmez. Her parça için eksik bayttan sınırlı yeniden deneme.
- Content-Range başlangıç/bitiş/toplamı doğrulanır. Kısa/yanlış/çakışan resume
  planı reddedilir; ETag/Last-Modified değişince eski parçalar karıştırılmaz.
  Günlük atomik yazılır; konumlu yazmanın kısa yazma ihtimali işlenir.
- Bir worker hata verdiğinde bütün istek/yazıcılar kapanmadan tek bağlantıya
  geçme veya dosyayı silme/yeniden adlandırma yapılmaz. Başlık bekleyen istek de
  iptal edilebilir. Önceden ayrılmış parçalı dosya tek akışta “tamamlanmış bayt”
  sanılmaz. Tek bağlantı için ayrı dosya kimliği günlüğü var.
- Tor kullanılıyorsa parçalar zorla farklı devrelere dağıtılmıyor. Seçilen proxy
  korunur; hız uğruna kendiliğinden doğrudan bağlantıya geçilmez.
- Yeni kurulumda 8 bağlantı; eski açık bağlantı tercihi korunur. HTTP için kullanıcının
  hız sınırı bütün worker'ların paylaştığı sınır olarak uygulanır.
- `transfer-stats.js`: son ölçümlerin kayan penceresi; resume'dan önceki baytlar
  hız sayılmaz. Ayrı video/ses fazlarının baytları doğru birikir. İkinci faz
  başlamadan ilk faz “işleniyor” sayılmaz. Yeterli veri yoksa ETA boş bırakılır.
  Kuyruk tahmini döngüsünün son işleri atlama hatası düzeltildi; dosyanın kendi
  ölçümü arayüzde tahmini kuyruk hesabıyla ezilmez.

## Dil ve altyazı

- `media-preferences.js`, `audio-selection.js`: varsayılan İngilizce. Ayarlar →
  Biçim'de İngilizce/Türkçe/kaynağın varsayılan sesi seçilebilir. Yeni kuyruğa
  alınan kayıt tercihi saklar. yt-dlp format seçimi bilinen tercih dilini önce
  arar; yoksa normal biçimlere geri döner ve bulunamayan dil bildirilir.
- `mediainfo.js`: HLS AUDIO grupları, dil ve rendition URI'leri okunur.
  `ownengine` kalite varyantına geçerken ayrı sesi kaybetmez; İngilizce sesi
  ikinci giriş olarak eşler. DASH/çok sesli FFmpeg girdisi için dilin stream
  indeksi de seçilebilir. Çift sesli dosya ses kanalı kopyalanarak yeniden
  paketlenir; video yeniden kodlanmaz.
- Etiketsiz sesi İngilizce sanan ses tanıma/çeviri eklenmedi. Dil yok/bilinmiyor
  durumu kullanıcıya dürüstçe bildirilir.
- Türkçe altyazı yazma/gömme varsayılan açık. `text-tracks.js`: HLS manifesti
  dışındaki `<track>`, JW Player ve Video.js/Plyr altyazı beyanlarını toplar;
  thumbnail VTT'ler elenir. Altyazının kendi Referer'i korunur.
- OpenSubtitles otomatik araması mevcut anahtar/ayarlarına bağlı; kaynakta veya
  sağlayıcıda olmayan Türkçe altyazı üretilemiyor. Bütün bölüme Türkçe altyazı
  kesin eklendi iddiası yok. Başarısız gömme, başarı diye raporlanmaz.

## Touch ID

- `electron/native/vault-keychain.swift`: Security + LocalAuthentication.
  Ana anahtar Keychain item'ında `biometryCurrentSet` ve
  `WhenUnlockedThisDeviceOnly` ile korunur. Bu, yalnızca arayüzde parmak izi
  penceresi gösterip korumasız yerden parola okumak değildir.
- Kasa şifresi, ana süreç argümanı veya JSON ayarında saklanmaz. Anahtar helper'a
  stdin üzerinden gider. JS kilit anahtarını ve elde edilen buffer'ları temizler.
- `biometrics.js`, `vault.js`, IPC/preload/api ve Kasa arayüzü bağlandı.
  Önce kasayı şifreyle açıp Touch ID etkinleştirilir. Şifre değişikliği kaydı
  siler; anahtar kimliği değişmişse yeniden kayıt gerekir. Uyku/kilit sırasında
  bekleyen biyometrik işlem kasayı tekrar açamaz.
- `build/biometric-helper.js` ve `after-pack.js` mimariye uygun native helper
  hazırlar ve ad-hoc imzalar. Arm64 ve x86_64 helper derlemeleri doğrulandı.
  Native “olmayan item'ı oku” çağrısı beklenen Keychain item-not-found hatasını
  verdi; gerçek parmak iziyle kaydet/aç akışı **insan etkileşimiyle hâlâ denenmeli**.
- Otomatik kasa testleri Keychain sınırını taklit ederek şifreye geri dönüş,
  iptal, kilit sırasında yarış ve parola değişikliği davranışlarını sınar.
  Bunlar gerçek biyometrik donanım testinin yerine geçmez.

## Dizi/koleksiyon arayüzü

- Extractor metadata'sından ve S01E01 / 1.Sezon 1.Bölüm başlıklarından dizi/sezon/
  bölüm alanları alınır. Mevcut kayıtlar bir defalık migration ile tamamlanır.
- Ana sayfada aynı dizi tek açılır gruptadır; bölümler sezon/bölüm sırasında.
  “Bölümler birlikte” ile tekli görünüme dönülür. Her kartın `⋯ → Dizi / koleksiyon…`
  menüsünden koleksiyon atanabilir/çıkarılabilir. Arama/izlenme/kategori filtreleri
  korunur; ses dili ve altyazı bilgisi kartta gösterilir.
- Tasarım referansı: uygulamanın mevcut Home/Settings/Vault ekranları. 16:9 kart,
  sistem yazı tipi ve mevcut renk token'ları korundu. Refero rehberinin yerel
  `craft-details.md` kaynağından doğal `<details>` klavye davranışı, focus-visible,
  sabit görsel oranı ve reduced-motion ilkeleri kullanıldı; canlı Refero aracı
  mevcut değildi. Yeni bir genel görsel tasarım yapılmadı.

## Doğrulama ve devam

- `npm test`: **55/55 geçti**, atlanan test yok (bu makinede yt-dlp/FFmpeg var).
  Gerçek video testleri düz TS, AES-128, byte-range, CDN ön eki, fMP4 init,
  ayrı İngilizce ses, güvenli pause/resume, iptal ve hata HTML'ini kapsar.
  Yerel 403 → çerezli sayfadan tazele → başarılı dosya senaryosu **iki aktarım
  motorunda da** doğrulandı. Tam birim/entegrasyon turu yaklaşık 11 sn sürdü.
- `tests/manual/resolver-fixtures.js`: gerçek Chromium'da uzantısız/image MIME
  manifest, Next state, iki iframe altındaki POST JSON yanıtı, alternatif
  oynatıcı tıklaması; ayrıca sahte mp4 HTML/404 reddi ve gizlenmiş DASH DRM
  tanıması geçti. Gerçek kitaplıktan ayrı geçici profil kullanır.
- `npm run typecheck`, `npm run build`, JS syntax ve `git diff --check` geçti.
- `tests/manual/ui-smoke.js`: ayrı profil ile tek koleksiyonda 3 bölüm, sıralama,
  yeni ayarlar ve sıfır renderer error doğrulandı; ekran görüntüleri
  `/tmp/aio-ui-smoke-results/` altında üretildi.
- **0.13.0 Mac arm64** uygulaması yerel olarak paketlendi ve GitHub paketi de
  ayrıca kontrol edildi (yukarıdaki yayın doğrulaması). Yerel `--publish never`
  paketleme GitHub yayınına karışmadı. Windows paketi GitHub runner'da üretildi;
  Windows cihazında kurulum/gerçek video indirme sınanmadı. Gerçek Touch ID etkileşimi,
  tam uzunlukta film ve farklı ağlar için manuel test hâlâ değerli.
- Canlı test:
  `npx electron tests/manual/resolve-sites.js --own-sample --captions 'https://.../'`.
  `--own-sample` en fazla iki parça/track alır, yerel mux ve ffprobe kontrolü
  yapar, çıktıyı siler. `--captions` varsa Türkçe altyazı yanıtını kontrol eder.
  `--prefer-browser` önceki host profilini taklit eder. `--sample` eski yt-dlp
  karşılaştırma yoludur; seçenekleri birbirinden ayrı kullan.
- Sonraki değerli manuel doğrulama: tam bölüm indir/pause/uygulamayı yeniden
  aç/resume; kaynakta gerçek ses dilini dinleme; Türkçe altyazıyı tam dosyaya
  gömme ve senkron; gerçek Touch ID ile kaydet/aç. Bu denemeler yapılmış sayılmaz.
  Sitelerin alan adı/CDN/oynatıcı davranışı değişebileceği için iki URL'deki
  başarı tüm site ve gelecek sürümler için garanti değildir.

## Araştırmada kullanılan birincil kaynaklar

- [yt-dlp seçenekleri ve format seçimi](https://github.com/yt-dlp/yt-dlp/blob/master/README.md)
- [yt-dlp desteklenen siteler ve destek sınırları](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)
- [FFmpeg HTTP yeniden bağlanma seçenekleri](https://ffmpeg.org/ffmpeg-protocols.html)
- [FFmpeg HLS demuxer ve format/uzantı seçenekleri](https://ffmpeg.org/ffmpeg-formats.html)
- [Electron WebRequest: gerçek istek başlıklarını yakalama](https://www.electronjs.org/docs/latest/api/web-request)
- [Apple: Keychain item'ına Touch ID erişimi](https://developer.apple.com/documentation/localauthentication/accessing-keychain-items-with-face-id-or-touch-id)
- [Apple: mevcut biyometrik kayıtla anahtar koruması](https://developer.apple.com/documentation/security/secaccesscontrolcreateflags/biometrycurrentset)
- [Electron: Touch ID penceresinin tek başına veri koruması olmadığı açıklaması](https://github.com/electron/electron/blob/main/docs/api/system-preferences.md)
