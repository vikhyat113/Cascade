// Help (SOS) shapes shared by the ladder, the mesh transports and the dispatch client (spec §9, §10).
export type SosType = "danger" | "medical" | "unsure";
export type Desk = "police" | "hospital" | "contact";

/** Fits a BLE advertisement in Phase 7: id 4 B, type+ttl+hop 2 B, lat/lon int32, ts 4 B; `to` takes 2 bits of the type byte. */
export interface SosPacket { id: number; type: SosType | "ack"; lat: number; lon: number; ts: number; hop: number; ttl: number; to?: Desk }

export interface MeshTransport {
  broadcast(p: SosPacket): void;
  onReceive(cb: (p: SosPacket) => void): () => void;
  status(): { peers: number; mode: "simulated" | "ble" };
}

/** What the dispatch server receives (server/server.js `POST /sos`). */
export interface SosRequest { id: string; type: SosType; to: Desk; lat: number; lon: number; ts: number; via: "direct" | "mesh"; hops: number }

export interface Dispatch {
  reachable(): Promise<boolean>;
  send(r: SosRequest): Promise<boolean>;
  acked(id: string): Promise<boolean>;
}
