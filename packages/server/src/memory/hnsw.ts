/**
 * HNSW (Hierarchical Navigable Small World) Index
 *
 * Pure TypeScript implementation for approximate nearest neighbor search.
 * Stores vectors in a multi-layer graph structure for O(log N) search.
 *
 * Reference: "Efficient and robust approximate nearest neighbor search using
 * Hierarchical Navigable Small World graphs" (Malkov & Yashunin, 2016)
 */

interface HNSWConfig {
  dimensions: number;
  /** Max connections per node per layer (default: 16) */
  M?: number;
  /** Construction-time search breadth (default: 200) */
  efConstruction?: number;
  /** Query-time search breadth (default: 100) */
  efSearch?: number;
}

interface HNSWNode {
  id: string;
  vector: number[];
  level: number;
  connections: Map<number, Set<string>>; // layer -> connected node ids
}

export class HNSWIndex {
  private nodes = new Map<string, HNSWNode>();
  private entryPoint: string | null = null;
  private maxLevel = 0;
  private readonly dimensions: number;
  private readonly M: number;
  private readonly efConstruction: number;
  private efSearch: number;
  private readonly mL: number; // normalization factor for level generation

  constructor(config: HNSWConfig) {
    this.dimensions = config.dimensions;
    this.M = config.M ?? 16;
    this.efConstruction = config.efConstruction ?? 200;
    this.efSearch = config.efSearch ?? 100;
    this.mL = 1 / Math.log(this.M);
  }

  /** Add a vector to the index */
  add(id: string, vector: number[]): void {
    if (vector.length !== this.dimensions) {
      throw new Error(`Vector dimensions mismatch: expected ${this.dimensions}, got ${vector.length}`);
    }

    const level = this.randomLevel();
    const node: HNSWNode = { id, vector, level, connections: new Map() };

    for (let l = 0; l <= level; l++) {
      node.connections.set(l, new Set());
    }

    this.nodes.set(id, node);

    if (!this.entryPoint) {
      this.entryPoint = id;
      this.maxLevel = level;
      return;
    }

    let currentNode = this.entryPoint;

    // Traverse from top to the node's level + 1 (greedy search)
    for (let l = this.maxLevel; l > level; l--) {
      currentNode = this.greedySearch(vector, currentNode, l);
    }

    // For each layer the new node belongs to, find and connect neighbors
    for (let l = Math.min(level, this.maxLevel); l >= 0; l--) {
      const candidates = this.searchLayer(vector, currentNode, this.efConstruction, l);
      const neighbors = this.selectNeighbors(candidates, this.M);

      // Connect new node to neighbors
      for (const neighbor of neighbors) {
        node.connections.get(l)!.add(neighbor.id);
        // Bidirectional connection
        const neighborNode = this.nodes.get(neighbor.id)!;
        if (!neighborNode.connections.has(l)) {
          neighborNode.connections.set(l, new Set());
        }
        neighborNode.connections.get(l)!.add(id);

        // Prune if too many connections
        if (neighborNode.connections.get(l)!.size > this.M * 2) {
          this.pruneConnections(neighborNode, l);
        }
      }

      if (candidates.length > 0) {
        currentNode = candidates[0].id;
      }
    }

    if (level > this.maxLevel) {
      this.maxLevel = level;
      this.entryPoint = id;
    }
  }

  /** Search for the topK nearest neighbors */
  search(query: number[], topK: number): Array<{ id: string; distance: number }> {
    if (!this.entryPoint || this.nodes.size === 0) return [];

    let currentNode = this.entryPoint;

    // Traverse from top to layer 1
    for (let l = this.maxLevel; l > 0; l--) {
      currentNode = this.greedySearch(query, currentNode, l);
    }

    // Search layer 0 with efSearch
    const candidates = this.searchLayer(query, currentNode, Math.max(this.efSearch, topK), 0);

    return candidates.slice(0, topK).map(c => ({
      id: c.id,
      distance: c.distance,
    }));
  }

  /** Remove a node from the index */
  remove(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;

    // Remove all connections to this node
    for (const [level, connections] of node.connections) {
      for (const neighborId of connections) {
        const neighbor = this.nodes.get(neighborId);
        if (neighbor) {
          neighbor.connections.get(level)?.delete(id);
        }
      }
    }

    this.nodes.delete(id);

    // Update entry point if needed
    if (this.entryPoint === id) {
      if (this.nodes.size === 0) {
        this.entryPoint = null;
        this.maxLevel = 0;
      } else {
        // Pick any remaining node with highest level
        let bestId = '';
        let bestLevel = -1;
        for (const [nid, n] of this.nodes) {
          if (n.level > bestLevel) {
            bestLevel = n.level;
            bestId = nid;
          }
        }
        this.entryPoint = bestId;
        this.maxLevel = bestLevel;
      }
    }
  }

  size(): number {
    return this.nodes.size;
  }

  /** Serialize index to Buffer for persistence */
  serialize(): Buffer {
    const data = {
      dimensions: this.dimensions,
      M: this.M,
      efConstruction: this.efConstruction,
      efSearch: this.efSearch,
      maxLevel: this.maxLevel,
      entryPoint: this.entryPoint,
      nodes: Array.from(this.nodes.entries()).map(([id, node]) => ({
        id,
        vector: Array.from(node.vector),
        level: node.level,
        connections: Array.from(node.connections.entries()).map(([l, conns]) => [l, Array.from(conns)]),
      })),
    };
    return Buffer.from(JSON.stringify(data));
  }

  /** Deserialize index from Buffer */
  static deserialize(buf: Buffer): HNSWIndex {
    const data = JSON.parse(buf.toString());
    const index = new HNSWIndex({
      dimensions: data.dimensions,
      M: data.M,
      efConstruction: data.efConstruction,
      efSearch: data.efSearch,
    });

    index.maxLevel = data.maxLevel;
    index.entryPoint = data.entryPoint;

    for (const nodeData of data.nodes) {
      const connections = new Map<number, Set<string>>();
      for (const [l, conns] of nodeData.connections) {
        connections.set(l, new Set(conns));
      }
      index.nodes.set(nodeData.id, {
        id: nodeData.id,
        vector: nodeData.vector,
        level: nodeData.level,
        connections,
      });
    }

    return index;
  }

  // ---------- Private Methods ----------

  private randomLevel(): number {
    let level = 0;
    while (Math.random() < 1 / this.M && level < 32) {
      level++;
    }
    return level;
  }

  /** Greedy search: find the single closest node at a given layer */
  private greedySearch(query: number[], startId: string, layer: number): string {
    let currentId = startId;
    let currentDist = this.cosineDistance(query, this.nodes.get(currentId)!.vector);

    let improved = true;
    while (improved) {
      improved = false;
      const node = this.nodes.get(currentId)!;
      const connections = node.connections.get(layer);
      if (!connections) break;

      for (const neighborId of connections) {
        const neighbor = this.nodes.get(neighborId);
        if (!neighbor) continue;
        const dist = this.cosineDistance(query, neighbor.vector);
        if (dist < currentDist) {
          currentDist = dist;
          currentId = neighborId;
          improved = true;
        }
      }
    }

    return currentId;
  }

  /** Search a layer with ef candidates (beam search) */
  private searchLayer(
    query: number[],
    startId: string,
    ef: number,
    layer: number
  ): Array<{ id: string; distance: number }> {
    const visited = new Set<string>([startId]);
    const startDist = this.cosineDistance(query, this.nodes.get(startId)!.vector);

    // candidates: sorted by distance ascending (closest first)
    const candidates: Array<{ id: string; distance: number }> = [{ id: startId, distance: startDist }];
    // results: best ef results found so far
    const results: Array<{ id: string; distance: number }> = [{ id: startId, distance: startDist }];

    while (candidates.length > 0) {
      // Take closest candidate
      const current = candidates.shift()!;

      // If the closest candidate is farther than the worst result, stop
      if (results.length >= ef && current.distance > results[results.length - 1].distance) {
        break;
      }

      const node = this.nodes.get(current.id);
      if (!node) continue;
      const connections = node.connections.get(layer);
      if (!connections) continue;

      for (const neighborId of connections) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const neighbor = this.nodes.get(neighborId);
        if (!neighbor) continue;

        const dist = this.cosineDistance(query, neighbor.vector);

        if (results.length < ef || dist < results[results.length - 1].distance) {
          // Insert into candidates (sorted)
          const cIdx = this.binaryInsertIndex(candidates, dist);
          candidates.splice(cIdx, 0, { id: neighborId, distance: dist });

          // Insert into results (sorted)
          const rIdx = this.binaryInsertIndex(results, dist);
          results.splice(rIdx, 0, { id: neighborId, distance: dist });

          if (results.length > ef) {
            results.pop();
          }
        }
      }
    }

    return results;
  }

  /** Select best M neighbors from candidates */
  private selectNeighbors(
    candidates: Array<{ id: string; distance: number }>,
    maxCount: number
  ): Array<{ id: string; distance: number }> {
    return candidates.slice(0, maxCount);
  }

  /** Prune connections to maintain max M*2 per layer */
  private pruneConnections(node: HNSWNode, layer: number): void {
    const connections = node.connections.get(layer);
    if (!connections || connections.size <= this.M * 2) return;

    // Keep closest M*2 neighbors
    const sorted = Array.from(connections)
      .map(id => ({ id, distance: this.cosineDistance(node.vector, this.nodes.get(id)!.vector) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, this.M * 2);

    node.connections.set(layer, new Set(sorted.map(s => s.id)));
  }

  /** Cosine distance (1 - cosine_similarity) */
  private cosineDistance(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 1;
    return 1 - dot / denom;
  }

  /** Binary search for insertion index in sorted array */
  private binaryInsertIndex(arr: Array<{ distance: number }>, dist: number): number {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].distance < dist) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
