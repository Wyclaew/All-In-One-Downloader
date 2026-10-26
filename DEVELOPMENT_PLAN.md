# Geliştirme planı — All in One Downloader

25 Ekim 2026 · 0.16.0 çalışması (önceki sürümlerin tarihçesi aşağıda). Kullanıcının isteğiyle uygulamanın bütün ana
katmanları tarandı. Bu belge tamamlanan işleri, sonraki işleri ve doğrulama
ölçütlerini ayırır. Gelecek işler henüz uygulanmış özellik sayılmaz.

## 0.16.0 — tamamlanan sonraki işler

- Referans ve aktif iş korumalı geçici çerez temizliği, sınırlı önbellek ve crash recovery.
- Toplu koleksiyon/sezon/bölüm düzenleyicisi; önizleme, stale edit koruması ve geri alma.
- Koleksiyon adıyla Home/Library araması.
- Kitaplıktan sınırlı, iptal edilebilir ve yalnız yerel video zamanlama kontrolü.
- Dosya aktarımında fazlar boyunca AbortSignal, iptal sonrası yazmama ve doğrulanan devam.
- Çok dönemli DASH toplam kalan süre hesabı.
- Otomatik başlatma kapalıyken startup/ayar değişiminde kuyruk tercihini koruma.
- Sinyalle kapanışta normal güvenli quit yolu.

Bunlar önceki yol haritasının tamamlanan kısımlarıdır. Canlı kayıt, büyük liste
sanallaştırması ve doğrulanmış CDN alternatifi bu teslimata dahil değildir.

## 25 Ekim 2026 — 0.15.0 çalışmasında tamamlananlar

0.14.1'in üzerine aşağıdaki işler kodlandı. Yayın ve son doğrulama durumu için
[CLAUDE_HANDOFF.md](CLAUDE_HANDOFF.md) esas alınmalı; eski backlog satırı yeni
özelliğin hâlâ yok olduğu anlamına gelmez.

1. Sonlu açık DASH VOD için native SegmentTemplate/Timeline/SegmentList motoru.
2. DASH ayrı ses dili, kalite sınırı, uyumlu çok dönem ve doğrulanmış devam.
3. Sunucu+rota bazında parça izni;429/ağ sorununda düşürme ve kademeli toparlanma.
4. Son bekleyen iptalinde başka origin'in kuyruğunu kilitleyen kabul sırası düzeltmesi.
5. HTTP CONNECT ve pooled socket iptal yarışlarının giderilmesi.
6. Partial prefix/hash/resource/validator ve tam Content-Range kontrolü.
7. FFmpeg parça atlayıp0exit verse bile eksik dosyayı başarı saymama.
8. Disk preflight ve aktarımda alan izleme; partial'ı koruyan duraklama.
9. FIFO, sırada öne al, aktif aynı kalite/ses tekrarını engelleme.
10. Binlerce eşzamanlı preflight hatasında reentrant queue taşmasını önleme.
11. Özel sekiz kitaplık snapshot'ı, rolling last-good ve bozuk orijinali koruyan kurtarma.
12. Araç dosyasının bulunması ile çalışabilirliğinin ayrı denetlenmesi.
13. Proxy environment temizliği ve direct yt-dlp için açık boş proxy argümanı.
14. Kaynak bazında rota değiştirme; doğrudan işin Tor'dan bağımsızlığı ve görünür rota.
15. Paylaşılan tarayıcı çerezi aktarımında bağımsız iptal.
16. Typed/uzantısız HTML kaynakları, HTML base/data-setup, Shaka ve JSON-LD graph.
17. Göreli API yanıt adresleri, bounded Packer token çözümü ve yanlış DRM pozitifleri.
18. İç içe HLS leaf kalite/ses grubu ilişkisinin probe→indiricide korunması.
19. Statik taramada belge önceliği ve tarayıcıya ayrılmış gerçek süre bütçesi.
20. Reklam iframe'lerinin gerçek oynatıcı navigasyon sayacını tüketmemesi.
21. Çerez eşitleme iframe'lerinin alternatif video oynatıcı sanılmaması.
22. Bilinen asıl oynatıcı iframe'ini önce açma, geç gelen manifest için sınırlı ek süre.
23. IP engeli, hesap gereksinimi, CAPTCHA ve sıradan ağ arızasını ayırma.
24. Site hesap bilgilerini yalnız sistem anahtarlığıyla şifreli saklama.
25. Exact HTTPS origin başına ayrı otomatik giriş ve kayıt izni.
26. Standart form ve tanınan hesap bağlantıları için sınırlı otomasyon; ek işlemlerde durma.
27. Touch ID etkinleştirmesindeki entitlement sorununu Secure Enclave korumalı kayıtla giderme.
28. Eski kaydın şifreyle yeniden etkinleştirilmesi ve ayrıntılı native hata açıklamaları.
29. Her dosya/bölüm açılışında altyazının kapalı olması.
30. Örtüşen altyazılar, async seçim/OFF yarışı ve gecikme sıfırlama düzeltmeleri.
31. Gerçek çoklu ses kanalı seçimi ve oynatıcıda ses gecikmesi.
32. Konum/hız/pause durumunu koruyan kapsayıcı uyumluluk işlemi.
33. Klavye/focus/seek kontrolleri, sonraki bölüm iptali ve küçük pencere düzeni.
34. Oynatıcı tampon/kare istatistikleri, tekrar açma ve açık paket-zamanlama tanısı.
35. Video, kaynak ve toplu seçimde çözünürlük yanında Türkçe/İngilizce/kaynak sesi.
36. Ses tercihinin işte saklanması, genel ayardan bağımsızlığı ve dil bazında duplicate kontrolü.
37. Gerçek ses dili/kalıcı uyarı; elle seçilen bilinen yanlış dublajın başarı sayılmaması.
38. Ses seçilemeden seçilmiş diye raporlamama; gerçek AAC paketleriyle TR/EN doğrulaması.
39. Kalite sınırını aşan sessiz geri dönüşü kaldırıp bilinmeyen yüksekliği ayrı ele alma.

Önceki21maddeyle birlikte toplam60uygulanmış iyileştirme başlığı bulunuyor;
bunlar ayrı60büyük özellik iddiası değildir. Geriye kalanlar: canlı kayıt modu,
referanslı çerez temizliği, kaynaklar arası güvenilir CDN alternatifi, toplu dizi
metadata düzenleyicisi, büyük kitaplık sanallaştırması ve aşağıdaki diğer işler.
Gerçek parmak iziyle etkileşim, eksik Mentalist dosyasının yeniden oluşturulması,
her site/DRM/üyelik garantisi tamamlanmış sayılmaz.


## Mimari tarama

| Alan | İncelenen bileşenler | Sonuç |
|---|---|---|
| Çözümleme | resolver, source-discovery, browser-discovery, userscripts, probe | Statik → gerçek tarayıcı → alternatif oynatıcı zinciri var; metadata ve iş yaşam döngüsü güçlendirildi. |
| Aktarım | downloader, ownengine, hls-native, recovery, transfer-stats | Ortak parça kuyruğu ve doğrulanan devam var; kaynak kimliği bütün aşamalarda korunmalı. |
| Ağ | proxy, tor, browsers, yeni network-context | Tor önceden elle açılmak zorundaydı; otomatik hazırlık ve kaynak başına oturum eklendi. |
| Dil / altyazı | media-preferences, mediainfo, text-tracks, subtitles, audio-selection | İngilizce/TR tercihleri korunuyor; Tor üzerinden altyazı ve güvenli yerel dönüştürme eklendi. |
| Kasa | vault, biometrics, Swift Keychain helper, Vault ekranı | Gerçek Keychain koruması var; kurulum görünürlüğü, durum açıklamaları ve kilit yarışları düzeltildi. |
| Veri / dosyalar | store, locate, tidy, thumbs | Yeniden başlatmada eski etkinlik temizlendi; büyük kitaplık ve yedekleme için sonraki işler belirlendi. |
| Oynatıcı | player, player-preload, yerel player arayüzü | Özel dosya protokolü, izleme konumu ve altyazı var; uyumluluk / bölüm akışı için geliştirmeler planlandı. |
| Arayüz | Home, Sources, Library, Settings, Vault, ortak bileşenler | Mevcut görünüm korunarak kaynak araçları, bilgi kaynağı açıklamaları ve Touch ID paneli eklendi. |
| Yayın | updater, update-metadata, build, GitHub workflow | Taslak paket doğrulama korunuyor; bu sürüm aynı yayın hattını kullanıyor. |

## Önceki0.14.1 sürümünde uygulananlar

1. VPN/Tor seçili bir kaynak işlenirken Tor otomatik hazırlanır; bağlantı hazır
   olmadan çözümleme/aktarım başlamaz. Hata halinde doğrudan bağlantıya geçilmez.
2. Aynı anda iki kaynak ayrı SOCKS kimlikleriyle Tor oturumları alır. Tek Tor
   süreci kullanılır. Aynı kaynağın tarayıcısı, çözümleyicisi, altyazısı ve
   indirmesi aynı kimlikte kalır; her parçaya ayrı kimlik verilmez.
3. Özel vekil, WARP ve harici Tor seçimi korunur. Otomatik başlatma ve kaynak
   ayırma ayrı ayarlardır. Yeni kurulumda uygulamanın Tor adresi seçilir.
4. Paylaşılan Tor açılışında bir kaynağı iptal etmek diğerini bozmaz. Son bekleyen
   iptal edilince yarım açılış kapanır; geç gelen işlem başıboş kalmaz.
5. Tor kapatıldığında onu kullanan taramalar durur, indirmeler duraklar; özel
   vekildeki işler bundan etkilenmez. Kaynak silinince kendi yerel köprüsü kapanır.
6. Bağlantıyı dene işlemi de Tor’u gerektiğinde hazırlar. SOCKS kimlikleri
   ayarlara, kitaplık JSON’una ve hata raporuna yazılmaz.
7. HLS süreleri gerçek parçalardan; DASH süreleri dönem/timeline bilgilerinden
   çıkarılır. Alt saniyeler, ses grupları ve farklı XML namespace’leri ele alınır.
8. Boyut için kesin dosya başlığı, manifest bitrate’i, bayt aralıkları veya en
   fazla üç parçanın başlığı kullanılır. Bütün video metadata için indirilmez.
   Parçalı videonun son paket boyutu tahmin olarak işaretlenir.
9. En yüksek HLS kalitesi bozuksa çalışan alt kalite doğrulanabilir. Kesin bozuk
   olduğu saptanan varyant indirmede tekrar seçilmez; kalite sınırı korunur.
10. Oynatıcının gerçekten yüklediği videonun süre/boyut bilgisi kaynakla eşleştirilir.
    Bilinmeyen süre, canlı yayın veya kısa reklam sanılmaz.
11. Eksik bilgiyi yeniden tarama ayrı, iptal edilebilir bir iştir. Var olan medya
    kimlikleri ve indirme ilişkileri değiştirilmez. İptal edilmiş eski iş yeni
    taramayı engelleyemez; ekranda sonsuz bilgi yükleme durumu kalmaz.
12. Kaynak ekranında toplu tekrar deneme/durdurma, kaynak başına durdurma,
    eksik bilgi sayısı, son kullanılan ağ yolu ve temizlenmiş hata raporu bulunur.
13. Altyazılar seçili ağ yolundan, her yönlendirmede yeniden hesaplanan çerez
    kapsamıyla indirilir. FFmpeg yalnızca hazırlanan yerel dosyaları dönüştürür.
    Tor/SOCKS için altyazı alımı artık uzak FFmpeg desteğine bağlı değildir.
14. Dosya aktarımı ve bilgi isteğinde aynı sunucudaki farklı yola yönlendirme
    dahil çerez kapsamı yeniden hesaplanır; dosya başlığı bekleyişi iptal edilir.
15. Kasanın kilitli, açık ve ilk kurulum durumlarında Touch ID paneli görünür.
    Parmak izi kaydı, geçici kilitlenme veya eksik bileşen açıkça açıklanır;
    macOS parmak izi ayarları açılabilir ve durum yeniden kontrol edilebilir.
16. Anahtar eskimiş/kaybolmuşsa şifreyle güvenli yeniden kayıt yolu gösterilir.
    Biyometrik ve şifre işlemi sürerken uyku/kilit eski işlemin kasayı açmasını
    önler. Anahtar, şifre türetme ve indeks okuma tamamlanmadan oturuma atanmaz.
17. Yeniden başlatmada ölmüş Tor oturumu ve yarım metadata etkinliği temizlenir;
    yarım aktarımdaki eski hız/ETA gösterilmez.
18. Araçlar ekranına ffprobe görünürlüğü eklendi. Süre/boyut bulunamadığında
    kurulu araçları kontrol etmek daha kolaydır.
19. Tarayıcı oturumu aktarımı internete örnek istek göndermeden yapılır. Aynı
    tarayıcıya eşzamanlı istekler tek aktarım paylaşır; çerez dosyası baştan özel
    dizinde oluşur. Başarısız iş temizlenir; aktif işin kullandığı eski dosya silinmez.
20. VPN’li kaynakların uzak kapak görselleri doğrudan renderer ağından yüklenmez.
    İndirilen dosyanın yerel kapak karesi kullanılabilir. Görsel kaynağı değişince
    eski yükleme hatası yeni yerel kapağı engellemez.
21. Dosyası zaten inmiş bir işin son işlemleri sürdürülürken de kaynak ağı
    hazırlanır; altyazı alma aşaması Tor’u atlayamaz.

## Yol haritası — önceki öneriler ve kalan kapsam

P1: güvenilirlik/uyumluluk; P2: günlük kullanım ve ölçek; P3: ileri özellik.
Yukarıda tamamlanan kısımlar tekrar yapılmamalı. Aşağıdaki eski öneriler kısmen
uygulandı; kapsamı kalan kısım üzerinden değerlendir. Her madde bağımsız ve test
edilebilir bir teslimata bölünmelidir.

| Öncelik | Öneri | Kullanıcıya faydası / kabul ölçütü |
|---|---|---|
| P1 | Yerel DASH VOD motoru | Tor ve çerezli DASH, scoped HTTP + yerel mux ile iner; çok dönem, ayrı ses, devam ve byte bütünlüğü test edilir. |
| P1 | Canlı HLS kayıt modu | “Canlı kaydet / kaydı bitir” akışı; sonsuz videoya sahte süre/boyut gösterilmez, disk sınırı vardır. |
| P1 | Sunucuya göre uyarlanan parça sayısı | 429/zaman aşımında işçi sayısı düşer, ağ düzelince ölçerek artar; sabit yüksek sayı zorlanmaz. |
| P1 | Yavaş iş için doğrulanan devralma | Uzun süren parça, başka işçiyle kontrollü devralınır; iki yazıcı aynı byte aralığını bozmaz. |
| P1 | Kaynak yenilemede devam kararı | Yenilenen manifest aynı içerikse mevcut doğrulanmış parçalar kullanılır; değişmişse güvenle sıfırlanır. |
| P1 | Süresi dolmak üzere olan adresi yenileme | Yakın token süresi tahmin edilebiliyorsa hata oluşmadan aynı ağ kimliğiyle yenilenir. |
| P1 | Tarayıcı çerezlerinin yaşam döngüsü | Paylaşılmış/çevrimdışı/güvenli export bu sürümde var. Kalan: kaynak referanslarıyla süre/çıkış/eski dosya temizliği ve paylaşılan işte bağımsız iptal. |
| P1 | Site uyumluluk kayıtları | Yerel fixture + isteğe bağlı canlı kontrol; alan adı/oynatıcı değişince hangi aşamanın bozulduğu anlaşılır. |
| P1 | Sürümlemeli site adaptörleri | Genel keşfi bozmayan küçük adaptör sözleşmesi; otomatik test ve geri alma ile dağıtılır, keyfi uzak kod çalıştırılmaz. |
| P1 | Paketlenmiş uygulama ağ testi | Gerçek Tor + Chromium, IP’ye bağlı URL ve özel vekil Windows/Mac paketlerinde doğrulanır. |
| P1 | Büyük indirmede disk denetimi | Başlamadan ve aktarırken boş alan izlenir; yetersiz disk halinde güvenli duraklama ve anlaşılır mesaj. |
| P1 | Sürümler arası veri yedeği | Güncelleme/migration öncesi geri alınabilir kitaplık yedeği; kasa ciphertext’i ve anahtar ilişkisi korunur. |
| P1 | Çalışan araç yetenek testi | Araç dosyası var mı yerine çalışıyor mu/codec/HTTP desteği var mı sorulur; bozuk kurulum açıkça görünür. |
| P2 | Kaynak bazında olay çizelgesi | Hangi motor denendi, neden değişti, kaç kurtarma yapıldı; paylaşılabilir raporda sırlar bulunmaz. |
| P2 | Kaynak bazında ağ değiştirme | Var olan kaynağa doğrudan/Tor/özel vekil seçimi; aktif iş varsa güvenli durdurup yeniden çözümleme. |
| P2 | Tor oturumu yönetimi | Kullanılmayan kimlikler güvenli emekli edilir; aktif indirmeye bağlı kimlik yenilenmez, 64 oturum sınırı anlaşılır gösterilir. |
| P2 | Oturum gereksinimini daha erken anlama | Gerçek giriş/bölge/DRM/bozuk sunucu ayrılır; internet yok mesajı yalnızca uygun durumda kullanılır. |
| P2 | Metadata güvenilirlik açıklaması | Süre ve boyutun ölçüm zamanı/kaynağı; kalite değişince seçili kaliteye uygun tahmin ve bilinmiyor durumu. |
| P2 | Koleksiyon düzenleyicisi | Dizi adı, sezon, bölüm ve sıralama topluca düzeltilebilir; dosya adını değiştirmek zorunlu değildir. |
| P2 | Eksik bölüm görünümü | Kullanıcının eklediği bölüm listesine göre indirilen/eksik bölümler; otomatik site hesap erişimi varsayılmaz. |
| P2 | Seri indirme kuyruğu şablonları | Sezon/klasör/kalite/dil tercihleri birlikte kaydedilir; seçilen bölüm sayısı ve hedef yer başlamadan gösterilir. |
| P2 | Kuyruk önceliği ve zamanlama | Sürükle sıralama, gece indir, işlem bitince uyku; aktif dosya kaybetmeden uygulanır. |
| P2 | Çift kayıt denetimi | Aynı sayfa/aynı bölüm/aynı dosya farklı adreslerden eklenirse kullanıcı bilgilendirilir; yanlış eşleşmede seçim bırakılır. |
| P2 | Kitaplık ölçek testi | 10 bin kayıtla başlangıç/arama/IPC ölçülür; gerekirse artımlı durum aktarımı, indeks ve SQLite migration planlanır. |
| P2 | Sanallaştırılmış uzun listeler | Binlerce bölüm/indirme akıcı kayar; klavye seçimi ve ekran okuyucu korunur. |
| P2 | Dosya taşıma ve yeniden bağlama | Klasör taşındığında topluca bul/bağla; benzer isimli farklı bölüme sessizce bağlanmaz. |
| P2 | Doğrulanan aktarım özeti | Gerçek süre, çözünürlük, ses dili, altyazı ve çıktı boyutu tamamlanınca özetlenir; başarısız gömme başarı sayılmaz. |
| P2 | Altyazı önizleme ve seçim | Türkçe tam/forced/SDH parçalar ayırt edilir; kısa önizlemeyle yanlış sürüm seçimi azaltılır. |
| P2 | Bölüme özgü ses tercihi | Genel İngilizce tercih korunurken tek video için Türkçe/kaynak seçilebilir; gerçek etiket yoksa tahmin olduğu söylenir. |
| P2 | Oynatıcı uyumluluk raporu | Chromium’un açamadığı codec anlaşılır anlatılır; isteğe bağlı yerel dönüştürme öncesi süre/alan maliyeti gösterilir. |
| P2 | Sonraki bölüm akışı | Koleksiyonda sonraki bölüm ön yüklenir, izleme konumu ve otomatik oynatma seçimi korunur. |
| P2 | Kasa kurtarma ve bütünlük kontrolü | Şifre değiştirme, yedek ve bozulmuş ciphertext testleri; parmak izi bir şifre kurtarma yöntemi diye sunulmaz. |
| P2 | Kasa işlem güvenliği | İçe/dışa aktarma sırasında elektrik/uygulama kapanması; orijinal dosya ancak doğrulanan güvenli kopyadan sonra silinir. |
| P2 | Klavye ve erişilebilirlik turu | Tüm menü/modal/oynatıcı klavyeyle kullanılabilir; focus geri gelir, ilerleme ekran okuyucuda anlamlıdır. |
| P2 | Dar pencere ve uzun metin turu | Uzun Türkçe başlık/alan adı, yüzde200 metin ve küçük ekran taşma üretmez. |
| P2 | İsteğe bağlı işlem sonu sistem bildirimi | Hata ve tamamlanma ayarları ayrı; güncelleme üst banner davranışıyla karıştırılmaz. |
| P3 | Dışa/içe aktarılan kuyruk dosyası | Kullanıcı URL listesini aktarır; çerez/token/anahtar rapor veya kuyruk paylaşımına sızmaz. |
| P3 | Kısayollar ve hızlı ekleme | Panodan toplu yapıştırma, uygulama bağlantısı ve isteğe bağlı tarayıcı uzantısı; izinler dar tutulur. |
| P3 | Yerel çevrimdışı yardım | Hata koduna göre kısa çözüm, klavye kısayolları ve destek raporu rehberi. |
| P3 | Geri alınabilir kitaplık temizliği | Silme/taşıma gibi toplu işlerde sonuç önizleme, geri alma ve açık alan hesabı. |
| P3 | İsteğe bağlı yerel ses dili tespiti | Etiketsiz sesi örnekten tahmin eder; model/işlem maliyeti açıklanır, kesin İngilizce diye etiketlenmez. |
| P3 | İsteğe bağlı Türkçe altyazı üretimi | Yerel konuşma tanıma/çeviri açık kullanıcı tercihiyle; kaynak altyazısı ve üretilen metin ayrı belirtilir. |
| P3 | İmzalı/noter onaylı dağıtım | Gerekli Apple/Windows sertifikaları sağlanırsa ilk açılış engelleri azaltılır; mevcut imza durumu doğru anlatılır. |

## Çalışma ve tasarım kuralları

- Hız hedefi gerçek dosya bütünlüğü, seçilen kalite/dil ve ağ tercihiyle birlikte
  değerlendirilir. Tor için farklı çıkış IP’si veya hız artışı garanti edilmez.
- DRM, gerçek üyelik ve insan doğrulaması geçerli sınırdır. Her bağlantıyı
  koşulsuz çözüyoruz iddiası yerine hangi aşamada ne bulunduğu gösterilir.
- Mevcut sistem yazı tipi, açık/koyu tema token’ları, yoğun kaynak satırları ve
  ayar satırları korundu. Refero rehberinin yerel craft/copy ilkeleri kullanıldı;
  canlı Refero aracı yoktu. Yeni işlemler mevcut menü/modal/düğme dilindedir.
- Yeni özellik için önce kontrollü fixture; gerçek ağ testi ayrıca ve sınırlı
  veriyle yapılır. Testler kullanıcının gerçek kitaplığını/kasasını açmaz.
- Her yayın: uygun birim/entegrasyon testleri, typecheck, arayüz derlemesi,
  native helper, paket ve güncelleme manifesti doğrulaması. Gerçek Touch ID
  etkileşimi ve farklı Windows/Mac cihazları ayrıca insan testidir.

Güncel uygulama/devir/test/yayın durumu: [CLAUDE_HANDOFF.md](CLAUDE_HANDOFF.md).

0.16.0 son inceleme: aynı başlıklı eşzamanlı dosya hedefleri ayrıldı; native
rezervasyon ve kalıcı devam kimliği, yt-dlp iş başına ad ayrımı eklendi. MKV
timestamp sıçramaları ve rescan öncesi cookie lease boşluğu düzeltildi.
