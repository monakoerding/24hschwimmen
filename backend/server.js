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
// Passwort für den Gesamt-Reset vor dem Event - bewusst simpel und offen im Code,
// nur gedacht um ein versehentliches Antippen zu verhindern, nicht als echter Schutz.
const RESET_PASSWORD = 'frosch';

function defaultState() {
  return {
    swimmers: [], // { id, name, cry, totalLaps, totalMs }
    queue: [], // Array von swimmerId, feste Reihenfolge nach Anmeldung
    lane: { currentSwimmerId: null, laps: 0, lastCountAt: 0, turnStartedAt: 0 },
    totalLaps: 0, // zählt über die ganze Staffel, wird nie beim Schwimmerwechsel zurückgesetzt
  };
}

// Bringt einen rohen Zustand (aus state.json oder einer hochgeladenen
// Sicherungsdatei) in die erwartete Form, mit Fallback für das alte
// Zwei-Bahnen-Format (state.lanes[1]).
function sanitizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  const oldLane = raw.lane || (raw.lanes && raw.lanes[1]);
  return {
    swimmers: Array.isArray(raw.swimmers) ? raw.swimmers : [],
    queue: Array.isArray(raw.queue) ? raw.queue : [],
    lane: { ...base.lane, ...oldLane },
    totalLaps: raw.totalLaps || 0,
  };
}

function loadState() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      return sanitizeState(raw);
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

// Schreibt die Schwimmzeit der aktuell aktiven Person fort, bevor die Bahn
// neu belegt wird - so bleibt "Minuten im Wasser" über alle Wechsel hinweg
// korrekt, obwohl lane.laps/lane.turnStartedAt pro Einsatz zurückgesetzt werden.
function endCurrentTurn(now) {
  const l = state.lane;
  if (l.currentSwimmerId && l.turnStartedAt) {
    const sw = getSwimmer(l.currentSwimmerId);
    if (sw) sw.totalMs = (sw.totalMs || 0) + (now - l.turnStartedAt);
  }
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
      lastCountAt: lane.lastCountAt,
      turnStartedAt: lane.turnStartedAt || 0,
    },
    totalLaps: state.totalLaps,
    totalDistanceM: state.totalLaps * LANE_LENGTH_M,
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
    state.swimmers.push({ id, name: cleanName, cry: (cry || '').trim(), totalLaps: 0, totalMs: 0 });
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

  // Nächste Person aus der Warteliste in die Bahn setzen. Funktioniert auch,
  // während schon jemand schwimmt (dann ist es ein direkter Wechsel ohne
  // Lücke) - so ist die Bahn nie leer, weil man die/den Nächste/n schon
  // bestätigen kann, bevor die aktuelle Person fertig ist.
  socket.on('assignNext', () => {
    if (state.queue.length === 0) return;
    const l = state.lane;
    const now = Date.now();
    endCurrentTurn(now);
    const nextId = state.queue.shift();
    l.currentSwimmerId = nextId;
    l.laps = 0;
    l.lastCountAt = 0;
    l.turnStartedAt = now;
    broadcast();
  });

  // Erste Person der Warteliste überspringen (z. B. noch nicht am Becken) -
  // wandert ans Ende der Liste, die/der Nächste rückt als Kandidat/in nach
  socket.on('skipQueueFront', () => {
    if (state.queue.length === 0) return;
    const skipped = state.queue.shift();
    state.queue.push(skipped);
    broadcast();
  });

  // Person direkt (ohne die Warteliste zu verändern) in die Bahn setzen -
  // z. B. wenn spontan jemand anderes als geplant schwimmt. Funktioniert auch
  // als Wechsel, während schon jemand schwimmt.
  socket.on('startDirect', ({ name, cry, swimmerId }) => {
    const l = state.lane;
    let id = swimmerId;
    if (id) {
      if (!getSwimmer(id)) return;
    } else {
      const cleanName = (name || '').trim();
      if (!cleanName) return;
      id = 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      state.swimmers.push({ id, name: cleanName, cry: (cry || '').trim(), totalLaps: 0, totalMs: 0 });
    }
    const now = Date.now();
    endCurrentTurn(now);
    l.currentSwimmerId = id;
    l.laps = 0;
    l.lastCountAt = 0;
    l.turnStartedAt = now;
    broadcast();
  });

  // Warteliste neu sortieren (Drag & Drop in der Zähler-Ansicht)
  socket.on('reorderQueue', ({ order }) => {
    if (!Array.isArray(order)) return;
    const current = new Set(state.queue);
    const cleaned = order.filter((id) => current.has(id));
    // Nur übernehmen, wenn es sich um eine reine Umsortierung handelt
    // (keine Einträge verloren gegangen oder dazuerfunden)
    if (cleaned.length !== state.queue.length) return;
    state.queue = cleaned;
    broadcast();
  });

  // Eine Bahn wurde geschwommen - Signal vom Zähler-Gerät
  socket.on('countLap', () => {
    const l = state.lane;
    if (!l.currentSwimmerId) return; // niemand schwimmt gerade
    const now = Date.now();
    if (now - l.lastCountAt < LOCKOUT_MS) {
      socket.emit('countRejected', {
        remainingMs: LOCKOUT_MS - (now - l.lastCountAt),
      });
      return;
    }
    l.laps += 1;
    l.lastCountAt = now;
    state.totalLaps += 1;
    const sw = getSwimmer(l.currentSwimmerId);
    if (sw) sw.totalLaps = (sw.totalLaps || 0) + 1;
    broadcast();
  });

  // Manuelle Korrektur, falls sich jemand vertippt/verzählt hat
  socket.on('adjustLaps', ({ delta }) => {
    const l = state.lane;
    const before = l.laps;
    l.laps = Math.max(0, l.laps + delta);
    const actualDelta = l.laps - before;
    state.totalLaps = Math.max(0, state.totalLaps + actualDelta);
    const sw = l.currentSwimmerId ? getSwimmer(l.currentSwimmerId) : null;
    if (sw) sw.totalLaps = Math.max(0, (sw.totalLaps || 0) + actualDelta);
    broadcast();
  });

  // Gesamt-Reset vor dem Event (z. B. nach dem Testen) - setzt alles auf null:
  // Schwimmer, Warteliste, Bahn und die Gesamtstrecke der Staffel.
  socket.on('resetAll', ({ password }) => {
    if (password !== RESET_PASSWORD) {
      socket.emit('resetRejected');
      return;
    }
    state = defaultState();
    broadcast();
  });

  // Zustand aus einer hochgeladenen Sicherungsdatei wiederherstellen
  // (z. B. nach einem Redeploy, bei dem state.json verloren ging).
  socket.on('loadState', ({ state: incoming }) => {
    state = sanitizeState(incoming);
    broadcast();
  });

  // Löst auf allen Geräten (v. a. dem Fernseher) ein Feuerwerk aus - für den
  // Moment, wenn die Staffel nach 24 Stunden vorbei ist. Kein Teil des
  // gespeicherten Zustands, nur ein einmaliges Signal an alle Clients.
  socket.on('triggerCelebration', () => {
    io.emit('celebrate');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Schwimm-Staffel Backend läuft auf Port ' + PORT);
});
