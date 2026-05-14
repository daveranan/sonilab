Place platform sidecars here:

- `ffmpeg.exe`
- `audiowaveform.exe`
- `ffmpeg`
- `audiowaveform`

Windows:

```powershell
$env:FFMPEG_PATH = "C:\path\to\ffmpeg.exe"
npm run package:ffmpeg
npm run validate:ffmpeg

$env:AUDIOWAVEFORM_PATH = "C:\path\to\audiowaveform.exe"
npm run package:audiowaveform
npm run validate:audiowaveform
```

macOS/Linux use the same commands with extensionless binaries:

```bash
FFMPEG_PATH=/path/to/ffmpeg npm run package:ffmpeg
npm run validate:ffmpeg

AUDIOWAVEFORM_PATH=/path/to/audiowaveform npm run package:audiowaveform
npm run validate:audiowaveform
```

The binaries are not committed. Packaging should stage them before release builds.
