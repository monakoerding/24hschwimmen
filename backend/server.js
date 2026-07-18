// Backend für das 24h-Schwimmen des Eberswalder Schwimmvereins e. V.
// Beispielhaft für EINE Bahn: 10 Badekappenfarben sind frei belegbare Plätze
// (keine Staffel-Reihenfolge, keine Pflicht, dass immer jemand im Wasser ist).
// Eine Person oder ein Team belegt eine Farbe, wird gezählt, und gibt die
// Farbe wieder frei - beliebig oft über die 24 Stunden verteilt. Der Server
// hält den kompletten Zustand im Speicher und in einer state.json-Datei,
// führt zusätzlich ein dauerhaftes Verlaufsprotokoll abgeschlossener Einsätze
// (history.jsonl) und synchronisiert alle verbundenen Geräte (Zähler-Handy,
// Admin, Fernseher, Statistik) in Echtzeit per WebSocket.
// Dieser Server liefert außerdem das statische Frontend aus (public/),
// sodass Backend und Frontend zusammen als ein einziger Service deployt
// werden.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const SWIM_COLORS = require('./public/colors.js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

const DB_FILE = path.join(__dirname, 'state.json');
const HISTORY_FILE = path.join(__dirname, 'history.jsonl');
const LOCKOUT_MS = 10000; // Sperrzeitraum nach einer gezählten Bahn, pro Farbe unabhängig
const LANE_LENGTH_M = 25;
const SAVE_DEBOUNCE_MS = 250; // Schreiben auf Platte wird gebündelt, der Broadcast an Clients bleibt sofort
const HISTORY_TAIL = 50; // wie viele Verlaufseinträge im Live-Zustand mitgeschickt werden

// Passwort für Admin-Login und Gesamt-Reset - bewusst simpel und offen im Code,
// nur gedacht um versehentliches Antippen/Fremdzugriff am Vor-Ort-Gerät zu
// erschweren, nicht als echter Schutz.
const RESET_PASSWORD = 'frosch';
const ADMIN_PASSWORD = 'frosch';

function defaultState() {
  return {
    participants: [], // { id, type: 'individual'|'team', firstName?, lastName?, teamName?, club, birthDate?, totalLaps, totalMs }
    lane: {
      slots: SWIM_COLORS.map((c) => ({
        color: c.id,
        occupantId: null,   // participantId, oder null = Farbe ist frei (kein Fehlerzustand!)
        laps: 0,             // Bahnen im laufenden Einsatz dieser Farbe
        lastCountAt: 0,
        turnStartedAt: 0,    // Beginn des laufenden Einsatzes
        recentActionIds: [], // Ringpuffer für Idempotenz bei Offline-Replay (siehe countLap/adjustLaps)
      })),
    },
    totalLaps: 0, // Gesamtsumme über die ganze Bahn, wird nie beim Farbwechsel zurückgesetzt
    history: [],  // kurzer Tail abgeschlossener Einsätze (voll in history.jsonl), siehe appendHistory
  };
}

function isValidParticipant(p) {
  return !!p && typeof p === 'object' && typeof p.id === 'string' &&
    (p.type === 'individual' || p.type === 'team');
}

// Bringt einen rohen Zustand (aus state.json oder einer hochgeladenen
// Sicherungsdatei) in die erwartete Form. Unbekannte/kaputte Felder fallen
// auf die Defaults zurück, statt den Server abstürzen zu lassen.
function sanitizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;

  const participants = Array.isArray(raw.participants)
    ? raw.participants.filter(isValidParticipant)
    : [];

  const rawSlots = raw.lane && Array.isArray(raw.lane.slots) ? raw.lane.slots : [];
  const slots = SWIM_COLORS.map((c) => {
    const rs = rawSlots.find((s) => s && s.color === c.id);
    return {
      color: c.id,
      occupantId: rs && typeof rs.occupantId === 'string' ? rs.occupantId : null,
      laps: rs && Number.isFinite(rs.laps) ? rs.laps : 0,
      lastCountAt: rs && Number.isFinite(rs.lastCountAt) ? rs.lastCountAt : 0,
      turnStartedAt: rs && Number.isFinite(rs.turnStartedAt) ? rs.turnStartedAt : 0,
      recentActionIds: [],
    };
  });

  return {
    participants,
    lane: { slots },
    totalLaps: Number.isFinite(raw.totalLaps) ? raw.totalLaps : 0,
    history: Array.isArray(raw.history) ? raw.history.slice(-HISTORY_TAIL) : [],
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

let saveTimer = null;
function saveState() {
  // Bündelt Schreibzugriffe auf state.json (bis zu 10 Farben können quasi
  // gleichzeitig gezählt werden). Der Socket-Broadcast in broadcast() bleibt
  // davon unberührt und passiert immer sofort.
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(DB_FILE, JSON.stringify(state, null, 2), (err) => {
      if (err) console.error('Konnte state.json nicht speichern:', err);
    });
  }, SAVE_DEBOUNCE_MS);
}

function appendHistory(entry) {
  state.history.push(entry);
  if (state.history.length > HISTORY_TAIL) state.history.shift();
  fs.appendFile(HISTORY_FILE, JSON.stringify(entry) + '\n', (err) => {
    if (err) console.error('Konnte history.jsonl nicht schreiben:', err);
  });
}

function getParticipant(id) {
  return state.participants.find((p) => p.id === id) || null;
}

function getSlot(color) {
  return state.lane.slots.find((s) => s.color === color) || null;
}

function occupiedSlotOf(participantId) {
  return state.lane.slots.find((s) => s.occupantId === participantId) || null;
}

function displayName(p) {
  if (!p) return null;
  return p.type === 'team' ? p.teamName : ((p.firstName || '') + ' ' + (p.lastName || '')).trim();
}

function newParticipantId() {
  return 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}

function normalize(str) {
  return (str || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Prüft auf eine Dublette im Teilnehmer-Register. Bei eindeutiger Übereinstimmung
// (Name + Geburtsdatum bzw. Teamname) wird hart abgelehnt; bei bloßer
// Namensgleichheit kann der Client mit confirmDuplicate erneut senden.
function findDuplicate(data) {
  if (data.type === 'team') {
    const teamName = normalize(data.teamName);
    return state.participants.find((p) => p.type === 'team' && normalize(p.teamName) === teamName);
  }
  const first = normalize(data.firstName);
  const last = normalize(data.lastName);
  return state.participants.find((p) => {
    if (p.type !== 'individual') return false;
    return normalize(p.firstName) === first && normalize(p.lastName) === last;
  });
}

// Legt einen neuen Teilnehmer (Person oder Team) an, oder liefert null +
// einen Ablehnungsgrund. Wird sowohl von register als auch von assignSlotNew
// (Direkt-Anmeldung am Zähler-Gerät) genutzt.
function createParticipant(data) {
  const type = data.type === 'team' ? 'team' : 'individual';
  if (type === 'team') {
    const teamName = (data.teamName || '').trim();
    if (!teamName) return { error: 'missingFields' };
    const dup = findDuplicate({ type, teamName });
    if (dup && !data.confirmDuplicate) return { error: 'duplicateParticipant' };
    const p = {
      id: newParticipantId(),
      type,
      teamName,
      club: (data.club || '').trim(),
      totalLaps: 0,
      totalMs: 0,
    };
    state.participants.push(p);
    return { participant: p };
  }
  const firstName = (data.firstName || '').trim();
  const lastName = (data.lastName || '').trim();
  if (!firstName || !lastName) return { error: 'missingFields' };
  const dup = findDuplicate({ type, firstName, lastName });
  if (dup && !data.confirmDuplicate) return { error: 'duplicateParticipant' };
  const p = {
    id: newParticipantId(),
    type,
    firstName,
    lastName,
    club: (data.club || '').trim(),
    birthDate: (data.birthDate || '').trim(),
    totalLaps: 0,
    totalMs: 0,
  };
  state.participants.push(p);
  return { participant: p };
}

// Beendet den laufenden Einsatz eines Slots (falls einer läuft) und schreibt
// ihn als abgeschlossenen Eintrag ins Verlaufsprotokoll - so bleibt pro
// Person/Team nachvollziehbar, wann sie/es wie lange und wie weit geschwommen
// ist, inklusive der zeitlichen Lücken dazwischen (die entstehen einfach
// dadurch, dass zwischen zwei Einsätzen kein Eintrag existiert).
function endSlotTurn(slot, now) {
  if (!slot.occupantId || !slot.turnStartedAt) return;
  const p = getParticipant(slot.occupantId);
  const entry = {
    ts: now,
    participantId: slot.occupantId,
    participantName: p ? displayName(p) : null,
    color: slot.color,
    startTs: slot.turnStartedAt,
    endTs: now,
    laps: slot.laps,
    distanceM: slot.laps * LANE_LENGTH_M,
    durationMs: now - slot.turnStartedAt,
  };
  if (p) p.totalMs = (p.totalMs || 0) + entry.durationMs;
  appendHistory(entry);
}

function pushActionId(slot, id) {
  if (!id) return;
  slot.recentActionIds.push(id);
  if (slot.recentActionIds.length > 50) slot.recentActionIds.shift();
}

function requireAdmin(socket, eventName) {
  if (socket.data && socket.data.isAdmin) return true;
  socket.emit('actionRejected', { event: eventName, reason: 'notAdmin' });
  return false;
}

// Baut den Zustand auf, so wie ihn die Clients brauchen (mit aufgelösten Namen etc.)
function publicState() {
  const slots = state.lane.slots.map((slot) => {
    const occupant = slot.occupantId ? getParticipant(slot.occupantId) : null;
    return {
      color: slot.color,
      occupantId: slot.occupantId,
      occupantName: occupant ? displayName(occupant) : null,
      occupantType: occupant ? occupant.type : null,
      occupantClub: occupant ? occupant.club : null,
      laps: slot.laps,
      distanceM: slot.laps * LANE_LENGTH_M,
      lockoutMs: LOCKOUT_MS,
      // Für die Zähler-Ansicht: wie lange ist die Sperre noch aktiv (serverseitig berechnet)
      lockedUntil: slot.lastCountAt ? slot.lastCountAt + LOCKOUT_MS : 0,
      lastCountAt: slot.lastCountAt,
      turnStartedAt: slot.turnStartedAt || 0,
    };
  });

  return {
    now: Date.now(),
    participants: state.participants,
    lane: { slots },
    colors: SWIM_COLORS,
    totalLaps: state.totalLaps,
    totalDistanceM: state.totalLaps * LANE_LENGTH_M,
    laneLengthM: LANE_LENGTH_M,
    recentHistory: state.history.slice().reverse(),
  };
}

function broadcast() {
  saveState();
  io.emit('state', publicState());
}

io.on('connection', (socket) => {
  socket.emit('state', publicState());

  // Neue Person/neues Team im Teilnehmer-Register anlegen - belegt dabei
  // NOCH KEINE Farbe (das passiert erst am Zähler-Gerät, wenn tatsächlich
  // jemand ins Wasser geht).
  socket.on('register', (data) => {
    const result = createParticipant(data || {});
    if (result.error) {
      socket.emit('registerRejected', { reason: result.error });
      return;
    }
    broadcast();
  });

  // Eine Farbe mit einer/einem bereits registrierten Teilnehmer:in belegen.
  // War die Farbe schon belegt, wird der laufende Einsatz beendet (Verlauf)
  // und der neue beginnt sofort - ein einziger Tap für den Wechsel.
  socket.on('assignSlot', ({ color, participantId }) => {
    const slot = getSlot(color);
    if (!slot) return;
    const participant = getParticipant(participantId);
    if (!participant) return;
    if (slot.occupantId === participantId) return; // schon hier, nichts zu tun

    const already = occupiedSlotOf(participantId);
    if (already) {
      socket.emit('actionRejected', { event: 'assignSlot', reason: 'alreadyAssigned' });
      return;
    }

    const now = Date.now();
    if (slot.occupantId) endSlotTurn(slot, now);
    slot.occupantId = participantId;
    slot.laps = 0;
    slot.lastCountAt = 0;
    slot.turnStartedAt = now;
    slot.recentActionIds = [];
    broadcast();
  });

  // Kombiniert Neuanmeldung + Farbbelegung in einem Schritt (schnelle
  // Direkt-Anmeldung am Zähler-Gerät, ohne den Umweg über die Anmeldeseite).
  socket.on('assignSlotNew', (data) => {
    const slot = getSlot(data && data.color);
    if (!slot) return;
    const result = createParticipant(data || {});
    if (result.error) {
      socket.emit('registerRejected', { reason: result.error });
      return;
    }
    const now = Date.now();
    if (slot.occupantId) endSlotTurn(slot, now);
    slot.occupantId = result.participant.id;
    slot.laps = 0;
    slot.lastCountAt = 0;
    slot.turnStartedAt = now;
    slot.recentActionIds = [];
    broadcast();
  });

  // Eine Farbe freigeben, ohne dass automatisch jemand Neues übernimmt -
  // das ist der normale Weg, eine zeitliche Lücke entstehen zu lassen
  // (es muss nicht durchgehend jemand im Wasser sein).
  socket.on('freeSlot', ({ color }) => {
    const slot = getSlot(color);
    if (!slot || !slot.occupantId) return;
    endSlotTurn(slot, Date.now());
    slot.occupantId = null;
    slot.laps = 0;
    slot.lastCountAt = 0;
    slot.turnStartedAt = 0;
    slot.recentActionIds = [];
    broadcast();
  });

  // Eine Bahn wurde geschwommen - Signal vom Zähler-Gerät, pro Farbe
  // unabhängig gesperrt. clientActionId erlaubt verzögertes/erneutes Senden
  // (z. B. nach Verbindungsverlust) ohne doppelt zu zählen.
  socket.on('countLap', ({ color, clientActionId } = {}) => {
    const slot = getSlot(color);
    if (!slot) return;
    if (clientActionId && slot.recentActionIds.includes(clientActionId)) {
      socket.emit('actionAck', { clientActionId, color, event: 'countLap', laps: slot.laps, deduped: true });
      return;
    }
    if (!slot.occupantId) return; // Farbe gerade nicht belegt
    const now = Date.now();
    if (now - slot.lastCountAt < LOCKOUT_MS) {
      socket.emit('countRejected', { color, remainingMs: LOCKOUT_MS - (now - slot.lastCountAt) });
      return;
    }
    slot.laps += 1;
    slot.lastCountAt = now;
    state.totalLaps += 1;
    const p = getParticipant(slot.occupantId);
    if (p) p.totalLaps = (p.totalLaps || 0) + 1;
    pushActionId(slot, clientActionId);
    socket.emit('actionAck', { clientActionId, color, event: 'countLap', laps: slot.laps });
    broadcast();
  });

  // Manuelle Korrektur, falls sich jemand vertippt/verzählt hat - und der
  // Weg, wie offline gepufferte Zählungen beim Wiederverbinden nachgetragen
  // werden (siehe counter.html): keine Sperrzeit-Prüfung, dafür immer mit
  // clientActionId für Idempotenz.
  socket.on('adjustLaps', ({ color, delta, clientActionId } = {}) => {
    const slot = getSlot(color);
    if (!slot) return;
    if (clientActionId && slot.recentActionIds.includes(clientActionId)) {
      socket.emit('actionAck', { clientActionId, color, event: 'adjustLaps', laps: slot.laps, deduped: true });
      return;
    }
    const before = slot.laps;
    slot.laps = Math.max(0, slot.laps + (delta || 0));
    const actualDelta = slot.laps - before;
    state.totalLaps = Math.max(0, state.totalLaps + actualDelta);
    const p = slot.occupantId ? getParticipant(slot.occupantId) : null;
    if (p) p.totalLaps = Math.max(0, (p.totalLaps || 0) + actualDelta);
    // Eine Korrektur nach unten (Vertipper) hebt eine laufende Zählsperre
    // sofort auf, damit direkt neu gezählt werden kann - anders als der
    // positive Nachtrag gepufferter Offline-Zählungen, der die normale
    // Sperrzeit-Logik unangetastet lässt.
    if (delta < 0) slot.lastCountAt = 0;
    pushActionId(slot, clientActionId);
    socket.emit('actionAck', { clientActionId, color, event: 'adjustLaps', laps: slot.laps });
    broadcast();
  });

  // Fehlanmeldung aus dem Teilnehmer-Register löschen (Admin-Ansicht). Wer
  // gerade eine Farbe belegt, muss erst freigegeben werden - sonst würde ein
  // laufender Einsatz kommentarlos verschwinden.
  socket.on('removeParticipant', ({ participantId } = {}) => {
    if (!requireAdmin(socket, 'removeParticipant')) return;
    if (occupiedSlotOf(participantId)) {
      socket.emit('actionRejected', { event: 'removeParticipant', reason: 'stillAssigned' });
      return;
    }
    state.participants = state.participants.filter((p) => p.id !== participantId);
    broadcast();
  });

  // Admin-Login für die getrennte Admin-Ansicht - bewusst leichtgewichtig,
  // gilt nur für diese Socket-Verbindung (kein echtes Session-System).
  socket.on('adminLogin', ({ password } = {}) => {
    socket.data.isAdmin = password === ADMIN_PASSWORD;
    socket.emit('adminLoginResult', { ok: socket.data.isAdmin });
  });

  // Gesamt-Reset vor dem Event (z. B. nach dem Testen) - setzt alles auf null:
  // Teilnehmer-Register, alle Farb-Slots und die Gesamtstrecke.
  socket.on('resetAll', ({ password } = {}) => {
    if (password !== RESET_PASSWORD) {
      socket.emit('resetRejected');
      return;
    }
    state = defaultState();
    broadcast();
    io.emit('stopCelebration');
  });

  // Zustand aus einer hochgeladenen Sicherungsdatei wiederherstellen
  // (z. B. nach einem Redeploy, bei dem state.json verloren ging). Nur mit
  // Admin-Login möglich, da das den kompletten Zustand überschreibt.
  socket.on('loadState', ({ state: incoming } = {}) => {
    if (!requireAdmin(socket, 'loadState')) return;
    state = sanitizeState(incoming);
    broadcast();
  });

  // Löst auf allen Geräten (v. a. dem Fernseher) ein Feuerwerk aus - für den
  // Moment, wenn die 24 Stunden vorbei sind. Kein Teil des gespeicherten
  // Zustands, nur ein einmaliges Signal an alle Clients. Nur mit Admin-Login.
  socket.on('triggerCelebration', () => {
    if (!requireAdmin(socket, 'triggerCelebration')) return;
    io.emit('celebrate');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('24h-Schwimmen Backend läuft auf Port ' + PORT);
});
