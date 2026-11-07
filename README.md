# NuniFlix

Movie and TV requests for a Plex or Jellyfin household. Browse what's on the streaming services, request things,
and Radarr/Sonarr fetch them. Also: Swipe, Movie Match (swipe together on a shared link), Wrapped, Discord / web
push notifications, and the Office: a little pixel-art building showing who's watching what and what's downloading.

## Install on Unraid

**Docker tab → Add Container**, or copy [`unraid/nuniflix.xml`](unraid/nuniflix.xml) to
`/boot/config/plugins/dockerMan/templates-user/` and pick it from the template list.

| Setting    | Value                                   |
|------------|-----------------------------------------|
| Repository | `ghcr.io/gitnuni/nuniflix:latest`         |
| Port       | host `8095` (any free port) → container `8000` |
| Path       | host `/mnt/user/appdata/nuniflix` → container `/data` |

Start it, open the container's **log** and copy the one-time **setup code**, then go to
`http://<your-unraid-ip>:8095`. The setup wizard asks for everything else. There are no environment variables.

## Install anywhere else (Docker)

```sh
docker run -d --name nuniflix --restart unless-stopped \
  -p 8095:8000 -v /path/to/nuniflix-data:/data \
  ghcr.io/gitnuni/nuniflix:latest
docker logs nuniflix   # the setup code is in here
```

## What you'll need

- **Plex and/or Jellyfin.** People sign in with those accounts (Discord sign-in is optional).
- **Radarr / Sonarr** (and optionally 4K instances) to do the downloading.
- A free **TMDB API key** (https://www.themoviedb.org/settings/api) for posters, trailers and the streaming catalogs.
- Optional: a Discord webhook or bot for notifications, and an HTTPS address (a reverse proxy) for phone push notifications.

## Data and updates

Everything lives in the `/data` folder: settings, accounts, the database. Back that folder up. To update, pull the
new image (`latest`) and recreate the container; the data folder carries over.

## Building it yourself

```sh
cd server
docker build -t nuniflix .
```

Every push to the main branch builds and publishes `ghcr.io/gitnuni/nuniflix` through GitHub Actions
(`.github/workflows/docker.yml`).
