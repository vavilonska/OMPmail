export type Peer = {
  id: string;
  pid: number;
  label: string;
  cwd: string;
  startedAt: number;
  heartbeatAt: number;
};

export type Lease = {
  ownerId: string;
  reason: string;
  acquiredAt: number;
};

export type Request = {
  ownerId: string;
  reason: string;
  requestedAt: number;
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
  lease: Lease | null;
  queue: Request[];
};

export type AcquireResult = {
  status: 'granted' | 'queued';
  ownerId: string;
  position: number;
  lease: Lease | null;
};
