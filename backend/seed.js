// Erzeugt einen realistisch gefüllten Demo-Zustand (state.json + history.jsonl),
// damit Auftraggeber die App sofort ausprobieren können, statt mit einem
// leeren Event zu starten. Nur für Vorführungen/Entwicklung gedacht - beide
// Dateien sind gitignored und werden hier bewusst überschrieben.
//
// Aufruf: npm run seed   (bzw. node seed.js --force, falls schon Dateien da sind)

const fs = require('fs');
const path = require('path');
const SWIM_COLORS = require('./public/colors.js');

const DB_FILE = path.join(__dirname, 'state.json');
const HISTORY_FILE = path.join(__dirname, 'history.jsonl');
const LANE_LENGTH_M = 25;

const force = process.argv.includes('--force');
if ((fs.existsSync(DB_FILE) || fs.existsSync(HISTORY_FILE)) && !force) {
  console.error('state.json und/oder history.jsonl existieren schon. Mit "node seed.js --force" überschreiben.');
  process.exit(1);
}

function newId() {
  return 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}
function displayName(p) {
  return p.type === 'team' ? p.teamName : (p.firstName + ' ' + p.lastName);
}
function randomBirthDate() {
  const year = randInt(1955, 2015);
  const month = String(randInt(1, 12)).padStart(2, '0');
  const day = String(randInt(1, 28)).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const FIRST_NAMES = ['Mona', 'Jonas', 'Lea', 'Finn', 'Mia', 'Paul', 'Emma', 'Lukas', 'Sophie', 'Ben', 'Nele', 'Tom', 'Lina', 'Jan', 'Anna', 'Felix', 'Marie', 'Erik', 'Hanna', 'Max'];
const LAST_NAMES = ['Koerding', 'Schmidt', 'Müller', 'Fischer', 'Weber', 'Wagner', 'Becker', 'Hoffmann', 'Schulz', 'Krüger', 'Zimmermann', 'Braun', 'Krause', 'Lehmann', 'Schwarz', 'Vogel'];
const CLUBS = ['Eberswalder SV', 'SG Finow', 'Poseidon Frankfurt (Oder)', 'SV Neptun Bernau', 'TuS Britz'];
const TEAM_NAMES = ['Die Wasserfrösche', 'Team Nixe', 'Beckenhaie Eberswalde', 'Aqua Rebellen'];

const now = Date.now();
const EVENT_START = now - 9 * 60 * 60 * 1000; // Event läuft in der Demo schon ca. 9 Stunden

// ---- Teilnehmer-Register: Einzelpersonen + Teams ----

const participants = [];
const usedNames = new Set();

for (let i = 0; i < 17; i++) {
  let firstName, lastName, key;
  do {
    firstName = pick(FIRST_NAMES);
    lastName = pick(LAST_NAMES);
    key = firstName + ' ' + lastName;
  } while (usedNames.has(key));
  usedNames.add(key);
  participants.push({
    id: newId(),
    type: 'individual',
    firstName,
    lastName,
    club: pick(CLUBS),
    birthDate: Math.random() < 0.7 ? randomBirthDate() : '',
    totalLaps: 0,
    totalMs: 0,
  });
}

TEAM_NAMES.forEach((teamName) => {
  participants.push({
    id: newId(),
    type: 'team',
    teamName,
    club: pick(CLUBS),
    totalLaps: 0,
    totalMs: 0,
  });
});

// ---- Verlauf: mehrere abgeschlossene Einsätze pro Teilnehmer:in, mit
//      zeitlichen Lücken dazwischen (kein "muss immer schwimmen") ----

const historyEntries = [];

function addTurn(p, color, startTs, endTs) {
  const durationMs = endTs - startTs;
  const laps = Math.max(1, Math.round(durationMs / randInt(45000, 90000))); // ~45-90s pro Bahn
  historyEntries.push({
    ts: endTs,
    participantId: p.id,
    participantName: displayName(p),
    color,
    startTs,
    endTs,
    laps,
    distanceM: laps * LANE_LENGTH_M,
    durationMs,
  });
  p.totalLaps += laps;
  p.totalMs += durationMs;
}

participants.forEach((p) => {
  const turns = randInt(0, 3);
  let cursor = EVENT_START + randInt(0, 30) * 60000;
  for (let t = 0; t < turns; t++) {
    if (cursor > now - 20 * 60000) break;
    const color = pick(SWIM_COLORS).id;
    const durationMin = randInt(10, 45);
    const startTs = cursor;
    const endTs = Math.min(now - 15 * 60000, startTs + durationMin * 60000);
    if (endTs <= startTs) break;
    addTurn(p, color, startTs, endTs);
    cursor = endTs + randInt(20, 180) * 60000; // Pause bis zum nächsten Einsatz
  }
});

historyEntries.sort((a, b) => a.startTs - b.startTs);

// ---- Aktuelle Belegung: bewusst NICHT alle 10 Farben (frei ist normal) ----

const slots = SWIM_COLORS.map((c) => ({
  color: c.id,
  occupantId: null,
  laps: 0,
  lastCountAt: 0,
  turnStartedAt: 0,
  recentActionIds: [],
}));

const shuffledColors = [...slots].sort(() => Math.random() - 0.5);
const shuffledParticipants = [...participants].sort(() => Math.random() - 0.5);
const occupyCount = Math.min(randInt(6, 7), shuffledParticipants.length);

let totalLaps = historyEntries.reduce((sum, h) => sum + h.laps, 0);

for (let i = 0; i < occupyCount; i++) {
  const slot = shuffledColors[i];
  const p = shuffledParticipants[i];
  const laps = randInt(0, 12);
  slot.occupantId = p.id;
  slot.turnStartedAt = now - randInt(1, 25) * 60000;
  slot.laps = laps;
  slot.lastCountAt = laps > 0 ? now - randInt(0, 9000) : 0;
  p.totalLaps += laps; // wie beim Server: Bahnen zählen sofort zum Gesamtstand der Person
  totalLaps += laps;
}

const state = {
  participants,
  lane: { slots },
  totalLaps,
  history: historyEntries.slice(-50),
};

fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2));
fs.writeFileSync(HISTORY_FILE, historyEntries.map((e) => JSON.stringify(e)).join('\n') + '\n');

console.log(`Demo-Zustand erzeugt: ${participants.length} Teilnehmer:innen (${TEAM_NAMES.length} Teams), ${occupyCount}/${SWIM_COLORS.length} Farben aktuell belegt, ${historyEntries.length} abgeschlossene Einsätze im Verlauf.`);
console.log('-> backend/state.json, backend/history.jsonl');
