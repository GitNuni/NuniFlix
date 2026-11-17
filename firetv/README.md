# NuniFlix for Fire TV (Vega OS)

The Fire TV version of the Apple TV app (`../apple`), in React Native for Vega OS (Fire TV Stick 4K Select and newer).
Older Android-based Fire TVs (Fire OS) need an Android build of this same code. That build doesn't exist yet.

## What it does
Server address and TV-code sign-in, "Who's watching?" for Plex Home, services, YourFlix, Seasonal genres, your
Plex/Jellyfin library, search, title pages with requests, a player (HLS through Media Source Extensions:
`src/player`), Live TV with Vesper, themes, and **Try the demo** (no server needed: `src/demo.ts`).

The server treats `platform: "firetv"` like a browser: H.264 + stereo AAC in MPEG-TS (`server/app/player.py`).

## Develop
```sh
export PATH=/opt/homebrew/opt/node@22/bin:$HOME/vega/bin:$PATH
npm install
npm test && npm run lint
npm run build:debug                        # build/…/armv7/Debug/…vpkg: loads JS from Metro (live reload)
npx react-native start --port 8081         # Metro; debug builds print src/log.ts lines here as [TV]
vega device start-port-forwarding --port 8081 --forward false
vega run-app build/armv7-debug/nuniflix_armv7.vpkg    # note: reinstalling wipes the app's saved sign-in
npm run build:release                      # stand-alone package, no Mac needed
```
Device: Settings → My Fire TV → Developer Options → Developer Mode, then `vega devmode enable-device --code <CODE>`
(uppercase) and `$(vega which vda) connect <tv-ip>`.

## Appstore
- Listing images: `store/` (icons 512 and 114, Fire TV icon 1280x720, background 1920x1080). Screenshots: 1920x1080
  from the TV.
- Privacy policy: `PRIVACY.md` (link: https://github.com/GitNuni/NuniFlix/blob/master/firetv/PRIVACY.md).
- Testing notes for reviewers: "NuniFlix connects to the user's own self-hosted server. To review without one,
  choose **Try the demo** on the first screen: browse, request a movie, play Big Buck Bunny, and open Live TV."
- Bump `build-number` in `manifest.toml` for every upload. Upload the Release `.vpkg`.
- Friends first: Live App Testing (invite by email), then a public listing.
