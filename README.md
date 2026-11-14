# Kestrel EFB

A free flight-planning app for US pilots. It runs in the browser and installs on Mac, Windows, iPad, iPhone, and Android.

## Install on your device

Kestrel EFB works as an installable web app (PWA) with offline caching. No app store account or payment is required.

### iPhone & iPad (Safari)
1. Open the live site in **Safari**.
2. Tap the **Share** button (the square with an upward arrow in the toolbar).
3. Scroll down and tap **Add to Home Screen**.
4. Tap **Add** in the top-right corner.

### Android (Chrome)
1. Open the live site in **Chrome**.
2. Tap the **three-dot menu** in the top-right corner.
3. Tap **Install app** or **Add to Home screen**.
4. Follow the prompt to confirm.

### Mac & Windows (Chrome / Edge / Safari)
* **Chrome or Edge:** Click the **install icon** (a monitor with a downward arrow) on the right side of the address bar, then click **Install**.
* **Safari (Mac):** Click **File > Add to Dock...** in the top menu bar, then click **Add**.

*(Note: After installing, open the app once while connected to the internet so it can cache core files for offline cockpit use.)*

## What it does

| Tab | Function |
|---|---|
| Maps | FAA VFR sectional, terminal, IFR low and high charts. Airports, navaids, fixes, Class B/C/D and special use airspace. Animated radar, flight category dots, SIGMETs. Tap anywhere to add a point to the route. GPS position and track log recording. |
| Flight plan (FPL) | Type a route (`KLUK HYK V97 CVG KCVG`). Airways expand to their fixes. NavLog with winds aloft, heading, time and fuel. Profile view of terrain and airspace along the route. |
| Airports | METAR, TAF, runways with wind components, frequencies. |
| Plates | Current FAA approach plates, departures, arrivals and airport diagrams. Save an airport's plates for offline use. |
| Imagery | Prog charts, surface analysis, radar, satellite, icing, winds aloft. |
| Flights | Saved flights, printable NavLog, weight and balance. |
| ScratchPads, Checklist, Logbook, Documents | Handwritten notes with ATIS and CRAFT templates, checklists with speech, a logbook with CSV export, imported PDFs. |
| More | Aircraft profiles, offline chart downloads, track logs with GPX export. |

Not included: flight plan filing, NOTAM text, live traffic, synthetic vision, 3D view, geo-referenced plates, takeoff and landing performance, climb and descent modeling. Coverage is the United States only.

## Keep the data current

Navigation data and the plates index follow the FAA 28-day cycle. To refresh them:

```bash
node tools/build-data.mjs
```

The included GitHub Action (`.github/workflows/update-data.yml`) runs this weekly and commits the result. It needs no secrets.

## Map key

`js/config.js` holds a CARTO basemaps key for the Dark and Light base maps. The key is sent with every tile request, so anyone who opens the site or the repository can read it. Leave it empty to use the keyless fallback maps. The Topographic and Satellite base maps and all FAA charts need no key and can be downloaded for offline use.

## Data sources

All free, with no paid API.

| Data | Source |
|---|---|
| Charts, airspace, fixes, airways, plates | FAA |
| Airports, runways, frequencies, navaids | OurAirports (public domain) |
| METAR, TAF, SIGMET | National Weather Service |
| Radar | Iowa Environmental Mesonet |
| Winds aloft, terrain elevation | Open-Meteo |
| Base maps | CARTO and OpenStreetMap, USGS |
| Map library | Leaflet (in `vendor/`) |
