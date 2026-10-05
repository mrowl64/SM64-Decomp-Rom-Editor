// Parses a GNU ld linker map (e.g. build/us/sm64.us.map produced by the decomp build)
// to give names to behavior scripts and other symbols.
export class SymbolTable {
  constructor() {
    this.byAddress = new Map();
    this.byName = new Map();
  }

  add(address, name) {
    address >>>= 0;
    if (!this.byAddress.has(address)) this.byAddress.set(address, []);
    const names = this.byAddress.get(address);
    if (!names.includes(name)) names.push(name);
    this.byName.set(name, address);
  }

  get size() {
    return this.byName.size;
  }

  nameFor(address, preferPrefix = 'bhv') {
    const names = this.byAddress.get(address >>> 0);
    if (!names) return null;
    return names.find((n) => n.startsWith(preferPrefix)) ?? names[0];
  }

  addressOf(name) {
    return this.byName.get(name);
  }

  // Behavior scripts live in segment 0x13 in decomp builds.
  behaviors() {
    return [...this.byName.entries()]
      .filter(([name, addr]) => name.startsWith('bhv') && addr >>> 24 === 0x13)
      .sort((a, b) => a[0].localeCompare(b[0]));
  }
}

const SYMBOL_LINE = /^\s+0x([0-9a-fA-F]{8,16})\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/;

export function parseMapFile(text) {
  const table = new SymbolTable();
  for (const line of text.split(/\r?\n/)) {
    const m = SYMBOL_LINE.exec(line);
    if (!m) continue;
    const address = parseInt(m[1].slice(-8), 16);
    table.add(address, m[2]);
  }
  return table;
}
