Place Windows sidecars here:

- `ffmpeg.exe`
- `audiowaveform.exe`

Use:

```powershell
$env:FFMPEG_PATH = "C:\path\to\ffmpeg.exe"
npm run package:ffmpeg
npm run validate:ffmpeg

$env:AUDIOWAVEFORM_PATH = "C:\path\to\audiowaveform.exe"
npm run package:audiowaveform
npm run validate:audiowaveform
```

The binaries are not committed. Packaging should stage them before release builds.
