export class UnionFind {
  private readonly parent: Int32Array;

  constructor(count: number) {
    this.parent = new Int32Array(count);
    for (let i = 0; i < count; i++) this.parent[i] = i;
  }

  find(x: number): number {
    let node = x;
    while ((this.parent[node] ?? node) !== node) {
      const grand = this.parent[this.parent[node] ?? node] ?? node;
      this.parent[node] = grand;
      node = grand;
    }
    return node;
  }

  union(a: number, b: number): number {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return ra;
    const root = Math.min(ra, rb);
    this.parent[Math.max(ra, rb)] = root;
    return root;
  }
}
