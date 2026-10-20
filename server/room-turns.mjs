export class RoomTurns {
  constructor() { this.weights = {}; this.round = 1; this.acted = new Set(); }
  configure(weights, ids) {
    if (!weights || typeof weights !== 'object' || Array.isArray(weights)) throw new Error('Ожидаются значения очереди участников.');
    const next = {};
    for (const id of ids) {
      const value = Number(weights[id] ?? this.weights[id] ?? 0);
      if (!Number.isInteger(value) || value < 0 || value > 999) throw new Error('Значение очереди: целое число от 0 до 999.');
      next[id] = value;
    }
    this.weights = next; this.round = 1; this.acted.clear();
  }
  status(ids) {
    const ordered = ids.map((id, index) => ({ id, weight: this.weights[id] || 0, index })).sort((a,b) => a.weight-b.weight || a.index-b.index);
    if (ordered.every(p => !p.weight)) return { free: true, round: this.round, eligible: ids, order: ordered, acted: [] };
    let remaining = ordered.filter(p => !this.acted.has(p.id));
    if (!remaining.length) { this.round++; this.acted.clear(); remaining = ordered; }
    return { free: false, round: this.round, eligible: remaining.filter(p => p.weight === remaining[0]?.weight).map(p => p.id), order: ordered, acted: [...this.acted] };
  }
  assert(id, ids) { if (!this.status(ids).eligible.includes(id)) throw Object.assign(new Error('Сейчас ход другого участника. Дождитесь своей очереди.'), { status: 409 }); }
  complete(id, ids) { if (!this.status(ids).free) this.acted.add(id); return this.status(ids); }
}
