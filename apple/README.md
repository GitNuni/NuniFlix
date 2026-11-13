# NuniFlix for Apple TV and iPhone

One SwiftUI codebase, two apps: **NuniFlix-TV** (tvOS 17+) and **NuniFlix-iOS** (iPhone and iPad, iOS 17+).
Pick a streaming service, browse it in that service's colours and layout, open a title, request it. If it's
already on your server, Play opens it in Plex.

## Build it (on a Mac)

1. Install Xcode from the App Store and open it once, so it finishes installing its parts. To run on an Apple TV
   or iPhone, also add your Apple ID under **Xcode → Settings → Accounts**.
2. Install XcodeGen, which turns `project.yml` into an Xcode project:
   ```sh
   brew install xcodegen      # no Homebrew? https://brew.sh
   ```
3. Generate the project and open it:
   ```sh
   cd apple
   xcodegen
   open NuniFlix.xcodeproj
   ```
4. For each target (NuniFlix-TV and NuniFlix-iOS): **Signing & Capabilities → Team** → pick your Apple ID.
   If Xcode says the bundle ID is taken, change `com.nunitech.nuniflix` (both apps share it) to something of your own.
5. Pick a device at the top (an Apple TV or iPhone simulator, or your real device) and press **Run** (⌘R).

### On a real Apple TV
- Apple TV and Mac on the same network. On the Apple TV: **Settings → Remotes and Devices → Remote App and Devices**.
- In Xcode: **Window → Devices and Simulators**, and pair the Apple TV with the code it shows.
- Then pick it as the run destination.

With a free Apple ID the installed app stops opening after 7 days (just run it from Xcode again). With a paid
Apple Developer account ($99/year) it lasts a year, and you can hand it out to family through **TestFlight**:
Product → Archive → Distribute App → TestFlight.

## First run
1. **Server address:** the one you open NuniFlix on, for example `http://192.168.0.49:8095`. Outside your home
   network, use your https address.
2. **Sign in:**
   - **Apple TV:** it shows a code and a QR code. Scan it with your phone (or open `<server>/?tv` and type the code),
     sign in to NuniFlix there if you aren't already, and approve. The TV signs itself in.
   - **iPhone:** Plex or Discord (opens the browser, then come back), or a Jellyfin username and password.

## What's where
| File | What it does |
|---|---|
| `Sources/Core/API.swift` | Talks to the server (`/api/...`, `Authorization: Bearer`) |
| `Sources/Core/Models.swift` | The server's JSON |
| `Sources/Core/AppModel.swift` | Server address, sign-in (token in the Keychain) |
| `Sources/Core/Theme.swift` | Per-service colours and tile shapes; TV vs phone sizes |
| `Sources/Views/SignInViews.swift` | Server address, TV code sign-in, phone sign-in |
| `Sources/Views/BrowseViews.swift` | Service picker, a service's home, search, my requests, settings |
| `Sources/Views/DetailView.swift` | Title page: request (seasons, 4K), play |
| `Sources/Views/Cards.swift` | Posters, rows, status badges |

Needs a NuniFlix server with TV sign-in (`/api/auth/tv/*`) and a TMDB key (for browsing by service).
