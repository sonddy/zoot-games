# APK drop folder

After building a signed release APK with `./gradlew assembleRelease` (see
`BUILD_MOBILE.md`), copy the output here and rename it:

```
android/app/build/outputs/apk/release/app-release.apk
  →
public/downloads/zoot-games.apk
```

Then commit + push. The `/download` route will start serving it and the
"Download Android App" button on the homepage will switch from
"Coming Soon" to active automatically.

This folder is **tracked** in git so the file is included in your Render
deploy. (Render's free filesystem is ephemeral; baking the APK into the
repo ensures it survives every redeploy.)

If the APK gets bigger than ~95 MB you'll need git-lfs or host the binary
externally (S3, R2, etc) and update `/download` to redirect there.
