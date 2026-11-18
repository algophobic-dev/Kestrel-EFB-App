# Kestrel EFB

A free flight-planning app for pilots, with airports and weather worldwide. It runs in the browser and installs on Mac, Windows, iPad and iPhone.

- Website: https://algophobic-dev.github.io/Kestrel-EFB/
- App: https://algophobic-dev.github.io/Kestrel-EFB-App/

Provided as is, with no warranty. Data comes from public sources and is not verified.

## What it does

| Tab | Function |
|---|---|
| Maps | FAA VFR sectional, terminal, IFR low and high charts, and open flightmaps VFR charts for about 20 countries in Europe and southern Africa. Airports, navaids, fixes, Class B/C/D and special use airspace, and with the relay world airspace from OpenAIP. TFRs in red, with full details when tapped, and PIREPs colored by turbulence and icing (with the relay). Animated radar (worldwide outside the US at lower detail), flight category dots, SIGMETs, obstacles, terrain hazard coloring, runway and taxiway charts when zoomed in, and with the relay live traffic and icing, turbulence and IFR advisories. Tap anywhere to add a point to the route or mark a position. GPS position and track log recording. |
| Flight plan (FPL) | Type a route (`KLUK HYK V97 CVG KCVG`). Airways, SIDs, STARs and approaches expand to their fixes (`KAPA WNGSS1 CHNGY ...`), or pick them with the Procedure button. Climb and descent are modeled from the aircraft profile. The Routes button suggests an RNAV route through waypoints along the great circle, and high and low airway routes that use Q and T routes before Jet and Victor routes. The 3D view flies the route over terrain. NavLog with winds aloft, heading, time and fuel. Profile view of terrain and airspace along the route. Export saves the route as a Garmin FPL, GPX route or PLN file, or copies the route text. Brief shows a preflight briefing for the route: METAR, TAF and NOTAMs at each end, SIGMETs and G-AIRMETs the route crosses, TFRs within 10 nm, PIREPs within 40 nm, and winds aloft for each leg. It prints, and its File button copies the flight plan details and opens 1800wxbrief.com. |
| Airports | METAR, TAF, D-ATIS, TFRs within 30 nm (with the relay), runways with wind components, frequencies, NOTAMs (with the relay), a fuel price note and link. |
| Plates | Current FAA approach plates, departures, arrivals and airport diagrams. Save an airport's plates for offline use. Show on map places an approach plate on the map (with the relay). |
| Imagery | Prog charts, surface analysis, radar, satellite, icing, winds aloft. |
| Flights | Saved flights, printable NavLog, weight and balance, takeoff and landing distance estimates. |
| ScratchPads, Checklist, Logbook, Documents | Handwritten notes with ATIS and CRAFT templates, checklists with speech, a logbook with CSV export, imported PDFs. |
| More | Aircraft profiles, offline chart downloads, marked positions, imported map content (GeoJSON, KML), track logs with GPX export. |

Not included: filing a flight plan from inside the app. That needs a vendor agreement with Leidos Flight Service. The File at 1800wxbrief.com button copies the flight plan details and opens the filing site instead.

Coverage: everything works in the US. Elsewhere you get airports, runways, frequencies, navaids, METAR, TAF and SIGMETs (METAR and TAF through the relay), radar, direct routes with winds aloft, open flightmaps charts where available, and world airspace with an OpenAIP key. FAA charts, plates, airways, procedures, obstacles and advisories cover the US only.

## Put it on GitHub

There is no build step. The repository is the app.

1. Create a repository and upload every file and folder in this directory.
2. In the repository, open **Settings > Pages**, set the source to the `main` branch and the root folder, and save.
3. Open the address GitHub shows. Install it from there:
   - iPad and iPhone: in Safari, select Share, then Add to Home Screen.
   - Mac and Windows: in Chrome or Edge, select the install icon in the address bar.

To run it on your own computer instead:

```bash
python3 -m http.server 8765
```

Then open `http://localhost:8765`.

## Mac app

`mac/Kestrel-EFB.dmg` is a native Mac app: the same app in its own window, with a menu bar (File, View, Map, Flight) and keyboard shortcuts. It runs on Apple silicon and Intel Macs with macOS 12 or later.

1. Open the DMG and drag Kestrel EFB to Applications.
2. The first time, right-click the app and choose Open. It is not notarized by Apple, so a plain double-click is blocked on other Macs.

The app loads the live site, so it needs a connection and always shows the latest version. To rebuild it after changing `mac/main.swift`:

```bash
bash mac/build.sh
```

## ADS-B receivers (Mac and Windows apps)

The Mac and Windows apps show traffic and use the GPS position from an ADS-B receiver that sends GDL90 over Wi-Fi, such as Stratux or Sentry. Join the receiver's Wi-Fi network, then open the app. It listens on UDP port 4000 and shows "ADS-B receiver connected." Receiver traffic shows in yellow, with altitude relative to yours in hundreds of feet. While a receiver is connected, its GPS is used instead of the computer's location, and internet traffic is hidden.

- Mac: allow local network access if macOS asks.
- Windows: allow Kestrel EFB on private networks if Windows Firewall asks.
- Stratus receivers send GDL90 only in their open mode; check the receiver's settings.
- Weather sent by the receiver (FIS-B) is not shown yet.
- Browsers cannot receive these packets, so this does not work in the web app on iPad, iPhone or in a browser.

## Windows app

`Kestrel-EFB.exe` on the Releases page is a native Windows app: the same app in its own window, with a menu bar and keyboard shortcuts. It is one file with nothing to install; double-click it. It needs Windows 10 or 11 (64-bit) and a connection. The first time, Windows SmartScreen may warn that it is from an unknown publisher: select More info, then Run anyway.

The source is in `windows/`. GitHub builds it: open the Actions tab, select Build Windows app, and choose Run workflow. It also runs whenever a release is published.

## Keep the data current

Navigation data and the plates index follow the FAA 28-day cycle. To refresh them:

```bash
node tools/build-data.mjs
```

The included GitHub Action (`.github/workflows/update-data.yml`) runs this weekly and commits the result. It needs no secrets.

## Relay server (optional, free)

Live traffic, NOTAMs, raw METAR/TAF text and weather outside the US cannot be fetched by a browser directly. The small relay in `server/` fetches them for the app. It runs on the Cloudflare Workers free plan (100,000 requests a day). The app works without it; those features stay off.

1. Create a free account at cloudflare.com.
2. Deploy the relay:

```bash
cd server
npx wrangler login
npx wrangler deploy
```

3. Copy the address it prints (like `https://kestrel-relay.yourname.workers.dev`) into `proxyUrl` in `js/config.js`, then upload that file.
4. In `server/wrangler.toml`, set `ALLOWED_ORIGINS` to your site's address so other sites cannot use your relay, then deploy again.

Traffic and weather work as soon as the relay is deployed. World airspace and NOTAMs also need a key.

### World airspace (OpenAIP)

Create a free account at openaip.net, open your profile, and create an API client key. Then store it and deploy again:

```bash
npx wrangler secret put OPENAIP_KEY
npx wrangler deploy
```

Then turn on Airspace (world) in the map layers. The relay keeps each tile for a day, so OpenAIP sees few requests.

### NOTAMs

NOTAMs need a key. The relay uses the first one it has, in this order.

**NOTAM Management Service (NMS-API).** Free. Request access from the NOTAM Service Center (7-AWA-NAIMES@faa.gov). They send a password-protected spreadsheet: KEY is the client ID and SECRET is the client secret. Store both, then deploy:

```bash
npx wrangler secret put NMS_CLIENT_ID
npx wrangler secret put NMS_CLIENT_SECRET
npx wrangler deploy
```

New accounts start on the staging (test) environment, which the relay uses by default. Once the NOTAM Service Center moves the account to production, they send production keys. Store those the same way, then point the relay at production and deploy:

```bash
npx wrangler secret put NMS_HOST
npx wrangler deploy
```

For `NMS_HOST`, enter `https://api-nms.aim.faa.gov`.

The NMS terms allow showing the NOTAMs in the app, but not describing them as FAA data.

**SkyLink API** (skylinkapi.com). A free trial of 1,000 requests a month for personal use. Store the key as `SKYLINK_API_KEY`, or as `RAPIDAPI_KEY` if it comes from RapidAPI.

**Older FAA NOTAM API** (api.faa.gov). Store the two values as `FAA_CLIENT_ID` and `FAA_CLIENT_SECRET`.

## Accounts and device sync (optional)

Sync keeps aircraft, flights, logbook, checklists, marked positions and fuel notes the same on all your devices. Sign in with a username and password, or use a private sync code with no account. Accounts need no email: a recovery code, shown once when the account is created, resets a forgotten password. The password is stretched in the browser before it is sent, and the relay keeps only a salted hash. It stores the data in a free Cloudflare KV namespace on the relay. Create the namespace once, answer yes when Wrangler offers to add it to `wrangler.toml`, then deploy:

```bash
cd server
npx wrangler kv namespace create SYNC
npx wrangler deploy
```

Then open More > Account and sync in the app and create an account or a sync code.

## Map key

`js/config.js` holds a CARTO basemaps key for the Dark and Light base maps. The key is sent with every tile request, so anyone who opens the site or the repository can read it. Leave it empty to use the keyless fallback maps. The Topographic and Satellite base maps and all FAA charts need no key and can be downloaded for offline use.

## Data sources

All free, with no paid API.

| Data | Source |
|---|---|
| Charts, airspace, fixes, airways, plates | FAA |
| Airports, runways, frequencies, navaids | OurAirports (public domain) |
| METAR, TAF, SIGMET in the US | National Weather Service |
| METAR, TAF, SIGMET elsewhere (through the relay) | aviationweather.gov |
| Radar in the US | Iowa Environmental Mesonet |
| Radar elsewhere | RainViewer ("Weather data by RainViewer") |
| VFR charts in Europe | open flightmaps (OFMA General Users' License) |
| World airspace (through the relay) | OpenAIP (openaip.net) |
| Winds aloft, terrain elevation | Open-Meteo |
| Terrain hazard tiles | Mapzen terrain tiles on AWS |
| D-ATIS | atis.info |
| PIREPs (through the relay) | aviationweather.gov |
| TFRs (through the relay) | tfr.faa.gov |
| Live traffic (through the relay) | adsb.lol |
| Base maps | CARTO and OpenStreetMap, USGS |
| Satellite outside the US | Esri World Imagery (shown online only, not saved offline) |
| Map library | Leaflet (in `lib/`) |
