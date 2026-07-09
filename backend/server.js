// Backend für die 24h-Schwimm-Staffel.
// Hält den kompletten Zustand (Schwimmer, Warteliste, Bahn) im Speicher
// und in einer state.json-Datei, und synchronisiert alle verbundenen
// Geräte (Tablet, Fernseher, Zähler-Handy) in Echtzeit per WebSocket.
// Dieser Server liefert außerdem das statische Frontend aus (public/),
// sodass Backend und Frontend zusammen als ein einziger Railway-Service
// deployt werden.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

const DB_FILE = path.join(__dirname, 'state.json');
const LOCKOUT_MS = 10000; // Sperrzeitraum nach einer gezählten Bahn
const LANE_LENGTH_M = 25;

function defaultState() {
  return {
    swimmers: [], // { id, name, cry }
    queue: [], // Array von swimmerId, feste Reihenfolge nach Anmeldung
    lane: { currentSwimmerId: null, laps: 0, lastCountAt: 0 },
  };
}

function loadState() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      const base = defaultState();
      // Fallback für altes Zwei-Bahnen-Format (state.lanes[1])
      const oldLane = raw.lane || (raw.lanes && raw.lanes[1]);
      return {
        swimmers: raw.swimmers || [],
        queue: raw.queue || [],
        lane: { ...base.lane, ...oldLane },
      };
    } catch (e) {
      console.error('state.json konnte nicht gelesen werden, starte mit leerem Zustand.', e);
    }
  }
  return defaultState();
}

let state = loadState();

function saveState() {
  fs.writeFile(DB_FILE, JSON.stringify(state, null, 2), (err) => {
    if (err) console.error('Konnte state.json nicht speichern:', err);
  });
}

function getSwimmer(id) {
  return state.swimmers.find((s) => s.id === id) || null;
}

// Baut den Zustand auf, so wie ihn die Clients brauchen (mit aufgelösten Namen etc.)
function publicState() {
  const lane = state.lane;
  const swimmer = lane.currentSwimmerId ? getSwimmer(lane.currentSwimmerId) : null;
  const distanceM = lane.laps * LANE_LENGTH_M;

  return {
    now: Date.now(),
    swimmers: state.swimmers,
    queue: state.queue.map((id) => getSwimmer(id)).filter(Boolean),
    lane: {
      currentSwimmerId: lane.currentSwimmerId,
      swimmerName: swimmer ? swimmer.name : null,
      swimmerCry: swimmer ? swimmer.cry : null,
      laps: lane.laps,
      distanceM,
      lockoutMs: LOCKOUT_MS,
      // Für die Zähler-Ansicht: wie lange ist die Sperre noch aktiv (serverseitig berechnet)
      lockedUntil: lane.lastCountAt ? lane.lastCountAt + LOCKOUT_MS : 0,
    },
    laneLengthM: LANE_LENGTH_M,
  };
}

function broadcast() {
  saveState();
  io.emit('state', publicState());
}

io.on('connection', (socket) => {
  socket.emit('state', publicState());

  // Neue Person meldet sich zum ersten Mal an
  socket.on('register', ({ name, cry }) => {
    const cleanName = (name || '').trim();
    if (!cleanName) return;
    const id = 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    state.swimmers.push({ id, name: cleanName, cry: (cry || '').trim() });
    state.queue.push(id);
    broadcast();
  });

  // Jemand, der schon mal geschwommen ist, meldet sich erneut zur Warteliste an
  socket.on('selectExisting', ({ swimmerId }) => {
    if (!getSwimmer(swimmerId)) return;
    if (state.queue.includes(swimmerId)) return; // nicht doppelt in der Liste
    state.queue.push(swimmerId);
    broadcast();
  });

  // Jemanden wieder von der Warteliste entfernen (falls versehentlich angemeldet)
  socket.on('removeFromQueue', ({ swimmerId }) => {
    state.queue = state.queue.filter((id) => id !== swimmerId);
    broadcast();
  });

  // Nächste Person aus der Warteliste in die Bahn setzen
  socket.on('assignNext', () => {
    const l = state.lane;
    if (l.currentSwimmerId) return; // Bahn muss erst frei sein
    if (state.queue.length === 0) return;
    const nextId = state.queue.shift();
    l.currentSwimmerId = nextId;
    l.laps = 0;
    l.lastCountAt = 0;
    broadcast();
  });

  // Aktuellen Schwimmer beenden (Bahn wird wieder frei)
  socket.on('finishSwimmer', () => {
    const l = state.lane;
    l.currentSwimmerId = null;
    l.laps = 0;
    l.lastCountAt = 0;
    broadcast();
  });

  // Eine Bahn wurde geschwommen - Signal vom Zähler-Gerät
  socket.on('countLap', () => {
    const l = state.lane;
    const now = Date.now();
    if (now - l.lastCountAt < LOCKOUT_MS) {
      socket.emit('countRejected', {
        remainingMs: LOCKOUT_MS - (now - l.lastCountAt),
      });
      return;
    }
    l.laps += 1;
    l.lastCountAt = now;
    broadcast();
  });

  // Manuelle Korrektur, falls sich jemand vertippt/verzählt hat
  socket.on('adjustLaps', ({ delta }) => {
    const l = state.lane;
    l.laps = Math.max(0, l.laps + delta);
    broadcast();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Schwimm-Staffel Backend läuft auf Port ' + PORT);
});
