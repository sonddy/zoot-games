# Zoot Games — Mobile Build Guide

This wraps the live PWA in a native Android (APK) and iOS (IPA) shell using
Capacitor. The WebView loads `https://zoot-games.onrender.com` directly, so
**you do not need to bundle web assets** and **every Render deploy ships
instantly to installed apps** (no app update required).

Phantom Wallet is handled via the official mobile deeplink protocol
(`PhantomMobile` module in `index.html`). When the WebView detects it's
running natively, it routes Connect / Sign / SignAndSend requests through
the encrypted Phantom deeplink protocol instead of the missing
`window.solana` provider. The user is bounced into the Phantom mobile app to
approve, then back into Zoot Games via the `zootgames://` URL scheme.

---

## One-time prerequisites

### Android (Windows-friendly)

1. Install **Android Studio**: https://developer.android.com/studio
   - Accepts default SDKs. After install, open Android Studio once so it
     downloads required platform tools.
2. Make sure `JAVA_HOME` points to a JDK 17 installation (Android Studio
   bundles one at `C:\Program Files\Android\Android Studio\jbr`).
3. Restart your terminal so PATH picks up Gradle.

### iOS (requires macOS — Windows can't build IPAs)

1. macOS with Xcode 15+ installed
2. `sudo gem install cocoapods`
3. Apple Developer account ($99/yr) if you want to distribute outside dev devices

---

## Day-to-day commands

After making changes in `index.html` and pushing to Render, **no rebuild is
needed** — the installed APK/IPA reloads the new HTML on next launch.

You only need to rebuild when you change:
- `capacitor.config.json`
- Native plugins
- The `mobile-shell/` fallback page
- App icon, name, or splash

In those cases:

```bash
# Sync the latest web shell into the native projects
npx cap sync

# Open Android Studio to build the APK
npx cap open android

# Or open Xcode (macOS only)
npx cap open ios
```

---

## Building a signed Android APK

### Debug APK (for sideloading to test)

In Android Studio (after `npx cap open android`):

1. `Build` → `Build Bundle(s) / APK(s)` → `Build APK(s)`
2. Wait for build, click `locate` in the toast notification
3. Grab `android/app/build/outputs/apk/debug/app-debug.apk`
4. Transfer to your phone and install (enable "Install from Unknown Sources" in Android settings)

### Release APK (for public distribution)

1. Generate a signing keystore (one-time, **keep this safe — losing it means you can never update the app**):

   ```bash
   keytool -genkey -v -keystore zootgames-release.keystore -alias zootgames -keyalg RSA -keysize 2048 -validity 10000
   ```

2. Create `android/keystore.properties` (this file is gitignored):

   ```
   storeFile=../zootgames-release.keystore
   storePassword=YOUR_STORE_PASSWORD
   keyAlias=zootgames
   keyPassword=YOUR_KEY_PASSWORD
   ```

3. Edit `android/app/build.gradle` and add inside the `android { }` block:

   ```gradle
   signingConfigs {
       release {
           def keystoreProperties = new Properties()
           def keystorePropertiesFile = rootProject.file('keystore.properties')
           if (keystorePropertiesFile.exists()) {
               keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
               storeFile file(keystoreProperties['storeFile'])
               storePassword keystoreProperties['storePassword']
               keyAlias keystoreProperties['keyAlias']
               keyPassword keystoreProperties['keyPassword']
           }
       }
   }
   buildTypes {
       release {
           signingConfig signingConfigs.release
           minifyEnabled false
       }
   }
   ```

4. Build:

   ```bash
   cd android
   ./gradlew assembleRelease
   ```

5. Find your signed APK at `android/app/build/outputs/apk/release/app-release.apk`.

6. Host it on a download page (e.g., `https://zoot-games.onrender.com/download` →
   serve the APK as a static file from the `public/` folder).

---

## Building an iOS IPA (requires Mac)

1. `npx cap add ios` (only first time)
2. `npx cap open ios`
3. In Xcode: select a development team, change Bundle ID to `com.zootgames.app`
4. `Product` → `Archive` → `Distribute App` → `Development` or `Ad Hoc`
5. Export the `.ipa`. For sideload distribution without TestFlight, host the
   `.ipa` + an `.plist` manifest at `https://your-domain/install.plist` and
   share an `itms-services://?action=download-manifest&url=...` link.

---

## How Phantom Mobile actually works inside the app

1. User taps **Connect Phantom Wallet** in the native app
2. `PhantomMobile.connect()` generates an ephemeral X25519 keypair on
   device (stored in `localStorage` so reconnect is instant)
3. Builds a URL like
   `https://phantom.app/ul/v1/connect?dapp_encryption_public_key=...&redirect_link=zootgames://onPhantomConnect`
4. Opens it — Android/iOS routes this to the installed Phantom app
5. User approves in Phantom → Phantom redirects to
   `zootgames://onPhantomConnect?phantom_encryption_public_key=...&nonce=...&data=...`
6. Android intent filter (in `AndroidManifest.xml`) hands this URL to our
   activity; Capacitor fires an `appUrlOpen` event
7. `PhantomMobile.handleIncomingDeeplink()` decrypts the response using a
   shared secret derived from our keypair + Phantom's public key
8. Decrypted payload contains the user's wallet pubkey + a session token
9. For each bet, the same encrypted protocol is used to call
   `signAndSendTransaction` — Phantom signs **and broadcasts** the tx,
   returning the signature. Our server still verifies the signature against
   the escrow before matching the bet.

If Phantom isn't installed, the URL falls back to the Phantom App Store / Play
Store page automatically.

---

## What's gitignored vs. tracked

Tracked (the things you need committed):
- `capacitor.config.json`
- `mobile-shell/`
- `android/` (the Gradle project structure)
- This file

Gitignored (machine-specific build output and secrets):
- `android/build/`, `android/.gradle/`, `android/app/build/`
- `android/local.properties` (path to your local Android SDK)
- `*.keystore`, `*.jks`, `keystore.properties` (NEVER commit these)
- `ios/App/Pods/`, `ios/App/build/`, `ios/DerivedData/`

---

## Troubleshooting

**"Could not find platform-tools"**: open Android Studio, go to Settings →
Languages & Frameworks → Android SDK, install the latest platform tools.

**"appUrlOpen never fires"**: confirm the intent filter is present in
`android/app/src/main/AndroidManifest.xml` with `android:scheme="zootgames"`.

**Phantom doesn't bounce back**: ensure Phantom mobile is installed and that
the device opens `https://phantom.app/ul/v1/...` links in Phantom (the
universal link is auto-registered when Phantom is installed).

**Tap "Connect" but nothing happens**: open Chrome DevTools via `adb` and
connect to the WebView — search for `PhantomMobile` log messages. Most
common cause is the X25519 library failing to load; `tweetnacl` is loaded
via CDN, so confirm internet works at first launch.
