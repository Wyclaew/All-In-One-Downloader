Buraya `yt-dlp` ve `ffmpeg` ikililerini koyabilirsin; `electron-builder` bunları
uygulamayla birlikte paketler ve `electron/lib/binaries.js` PATH'ten önce burayı
arar. Böylece kullanıcının ayrıca kurulum yapması gerekmez.

Beklenen düzen:

```
resources/bin/yt-dlp            # macOS / Linux
resources/bin/ffmpeg
resources/bin/yt-dlp.exe        # Windows
resources/bin/ffmpeg.exe
```

Platforma göre ayırmak isterseniz `resources/bin/darwin/` ve `resources/bin/win32/`
alt klasörleri de aranır.

Klasör boş bırakılabilir — o zaman uygulama sistemde kurulu araçları kullanır.
