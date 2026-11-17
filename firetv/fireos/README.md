# NuniFlix for older Fire TVs (Fire OS / Android)

The same app as the Vega one: all screens come from `../src`. Only three pieces differ, chosen by file name
(`*.android.ts(x)`):
- `src/platform/storage.android.ts`: community AsyncStorage
- `src/platform/tv.android.ts`: remote buttons from react-native-tvos
- `src/player/Video.android.tsx`: react-native-video (ExoPlayer plays the server's HLS directly)

Works on Fire OS 6+ (Android 7.1 and up): Fire TV Stick 2nd gen and later, Stick 4K / 4K Max (Fire OS),
Cube, Fire TV Edition TVs. Not the very first sticks (Fire OS 5).

## Build the APK
```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm install
cd android && ./gradlew assembleRelease     # → android/app/build/outputs/apk/release/app-release.apk
```
Signing: the release key is `~/.android-keys/nuniflix-fireos.jks`, with its passwords in `~/.gradle/gradle.properties`
(`NUNIFLIX_*`). Neither is in the repo. **Back the key up.** Updates must be signed with the same key, or friends
have to uninstall first. Raise `versionCode` in `android/app/build.gradle` for every new APK.

## Put it on a friend's Fire TV (Downloader)
1. On the Fire TV: install **Downloader** (by AFTVnews) from the Appstore.
2. Settings → My Fire TV → Developer Options → **Install unknown apps** → Downloader: **On**.
   (No Developer Options? Settings → My Fire TV → About → click the device name 7 times.)
3. Open Downloader, type the APK's link, and install.
4. Open NuniFlix, enter `https://flix.nunitech.com`, and sign in with the code.
