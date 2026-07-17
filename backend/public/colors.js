// Badekappenfarben für die Bahn - eine Farbe ist ein frei belegbarer Platz,
// kein fester Startplatz. Wird sowohl vom Server (require) als auch von
// jeder HTML-Seite (<script src="/colors.js">) genutzt, damit es nur eine
// einzige Stelle mit der Farbdefinition gibt.
var SWIM_COLORS = [
  { id: 'red',    index: 1, name: 'Rot',     hex: '#E5342E', text: '#FFFFFF' },
  { id: 'blue',   index: 2, name: 'Blau',    hex: '#1E63E5', text: '#FFFFFF' },
  { id: 'yellow', index: 3, name: 'Gelb',    hex: '#F2C230', text: '#1A1A1A' },
  { id: 'green',  index: 4, name: 'Grün',    hex: '#2E9E4C', text: '#FFFFFF' },
  { id: 'orange', index: 5, name: 'Orange',  hex: '#F2792E', text: '#FFFFFF' },
  { id: 'purple', index: 6, name: 'Lila',    hex: '#8A4FD1', text: '#FFFFFF' },
  { id: 'pink',   index: 7, name: 'Pink',    hex: '#E53E9E', text: '#FFFFFF' },
  { id: 'cyan',   index: 8, name: 'Türkis',  hex: '#23B6C4', text: '#1A1A1A' },
  { id: 'black',  index: 9, name: 'Schwarz', hex: '#1A1A1A', text: '#FFFFFF' },
  { id: 'white',  index: 0, name: 'Weiß',    hex: '#FFFFFF', text: '#1A1A1A' },
];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SWIM_COLORS;
}
