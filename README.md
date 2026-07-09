# 24h Schwimm-Staffel – Setup

Ein Node.js-Service (Express + Socket.IO) hält den gemeinsamen Zustand
(Schwimmer, Warteliste, Bahn) und liefert gleichzeitig das statische
Frontend aus (`backend/public/`). Es gibt also nur **einen** Deploy,
auf Railway.

## 1. Deploy auf Railway

1. Neues Projekt auf railway.app anlegen → „Deploy from GitHub repo" (das ganze Repo, nicht nur `backend/`) oder den Ordner `backend/` als eigenes Repo pushen.
2. Railway erkennt Node.js automatisch (package.json in `backend/` vorhanden). Falls du das ganze Repo pushst, unter „Settings" → „Root Directory" auf `backend` stellen. Kein Umgebungsvariablen-Setup nötig.
3. Nach dem Deploy: Unter „Settings" → „Networking" → „Generate Domain" klicken, um eine öffentliche URL zu bekommen, z. B.
   `https://schwimm-relay-production.up.railway.app`
4. Diese URL ist gleichzeitig die Adresse für alle Geräte (Tablet, Fernseher, Zähler-Handy) – kein separates Frontend-Hosting und keine Config-Datei mit der Backend-URL mehr nötig.

**Hinweis zur Persistenz:** Der Zustand wird in `state.json` im Container gespeichert. Bei einem Redeploy auf Railway kann diese Datei verloren gehen (kein persistentes Volume im Standard-Setup). Für ein 24h-Event reicht das i. d. R., weil der Server während des Events durchläuft. Falls du sicherheitshalber ein Railway-Volume mounten willst, kannst du das in den Railway-Settings unter „Volumes" auf `/app` (bzw. den Ordner mit server.js) hinzufügen.

## 2. Geräte am Eventtag

| Gerät | Seite | Zweck |
|---|---|---|
| Haupttablet an der Anmeldung | `/` (`index.html`) | Anmelden, Warteliste, Bahn starten/beenden |
| Fernseher an der Bahn | `/lane.html` | Live-Anzeige: Schwimmer/in, Kampfschrei, Bahnen, Strecke |
| Handy des Helfers an der Bahn | `/counter.html` | Großer Button zum Bahnenzählen (10 s Sperre) |

Alle drei Seiten unter der Railway-URL aufrufen, z. B. `https://DEINE-URL.up.railway.app/lane.html`.

## Ablauf

1. Person meldet sich am Tablet an (Name + optionaler Kampfschrei) → landet in der Warteliste.
2. Am Tablet: „Nächste/n Schwimmer/in starten" → die erste Person aus der Warteliste wird der Bahn zugewiesen (feste Reihenfolge nach Anmeldung).
3. Der Fernseher zeigt automatisch „Es schwimmt: Name – Kampfschrei" sowie Bahnenzahl und Strecke.
4. Der Helfer am Beckenrand drückt bei jeder abgeschlossenen Bahn den Zähl-Button auf `counter.html`. Danach ist der Button 10 Sekunden gesperrt, damit dieselbe Bahn nicht versehentlich doppelt gezählt wird.
5. Ist die Person fertig, drückt jemand am Tablet „Schwimmer/in beenden" – die Bahn wird frei für die nächste Person aus der Warteliste.
6. Wer schon mal geschwommen ist, kann sich über das Auswahlfeld „Schon mal geschwommen?" erneut zur Warteliste anmelden, ohne Namen/Kampfschrei neu einzutippen.

## Lokal testen

```bash
cd backend
npm install
npm start
```

Dann `http://localhost:3000` (Tablet-Ansicht), `http://localhost:3000/lane.html` und `http://localhost:3000/counter.html` im Browser öffnen.
