# Kestrel EFB

A free flight-planning app for US pilots. It runs in the browser and installs on Mac, Windows, iPad and iPhone.

**Planning only. Not approved for navigation.** Check every route, chart, weather report and NOTAM against official sources before you fly.

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
