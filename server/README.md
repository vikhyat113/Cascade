# NightWay dispatch server (SIMULATED)

Demo stand-in for police / hospital / contact desks. **Nothing here reaches real emergency services.**

```bash
cd server && npm install && npm start      # port 8787 (PORT=... to change)
```

It prints the laptop's Wi-Fi address, e.g. `http://192.168.1.20:8787`. Put that in the app: **Demo → 8. Dispatch server → Save + test**.
The phone and laptop must be on the same Wi-Fi; on Windows allow Node.js through the firewall (Private networks) when asked.

- Dashboard: `http://localhost:8787/`: tabs **Police / Hospital / Contact**, live list (SSE), map link, **Acknowledge**.
- API: `POST /sos {id, type: danger|medical|unsure, to: police|hospital|contact, lat, lon, ts, via: direct|mesh, hops}`,
  `GET /sos/:id` (→ `acked`), `POST /sos/:id/ack {to?, by?}`, `GET /sos`, `GET /events`, `GET /health`.
- In-memory only; restart to clear.
