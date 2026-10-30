# Svampkartan

A map of mushroom finds in Sweden. It shows GBIF records for five edible species
(Kantarell, Trattkantarell, Svart trumpetsvamp, Karljohan, Blek taggsvamp) and lets you add your own spots.

Your own spots are stored only in your browser's local storage: they are never sent anywhere or
included in this repository. Use **Export JSON** to back them up or move them to another device.

- `index.html`, `app.js`: the app (Leaflet + OpenStreetMap)
- `data/gbif_species.js`: one-time GBIF snapshot of Swedish records
- `scripts/fetch_gbif.py`: regenerates that snapshot

Occurrence data: [GBIF.org](https://www.gbif.org/), licensed per dataset (CC0 / CC BY / CC BY-NC).
