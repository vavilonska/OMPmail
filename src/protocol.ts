export type Peer = {
  id: string;
  pid: number;
  label: string;
  cwd: string;
  startedAt: number;
  heartbeatAt: number;
};

/** CPU logical workers, RAM MiB, and aggregate GPU percent (including VRAM pressure). */
export type Resources = { cpu: number; memoryMB: number; gpu: number };
export type Demand = { minimum: Resources; preferred: Resources };
export type Lease = {
  ownerId: string;
  reason: string;
  acquiredAt: number;
  demand: Demand;
  allocation: Resources;
};
export type Request = {
  ownerId: string;
  reason: string;
  requestedAt: number;
  demand: Demand;
};
export type Recommendation = {
  ownerId: string;
  /** A proposal, never permission to consume or proof that resources were freed. */
  target: Resources | null;
};
export type Mail = {
  id: number;
  from: string;
  to: string;
  kind: 'message' | 'request' | 'release';
  text: string;
  createdAt: number;
};
export type Snapshot = {
  selfId: string;
  peers: Peer[];
  capacity: Resources;
  freeMemoryMB: number;
  leases: Lease[];
  queue: Request[];
  recommendations: Recommendation[];
};
export type AcquireResult = Snapshot & {
  status: 'granted' | 'queued';
  ownerId: string;
  /** True only if the requested adjustment was accepted; old grants survive a refused growth. */
  updated: boolean;
  allocation: Resources | null;
};
