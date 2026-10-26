# Real Bluetooth relay: status

**Flag**: `MESH_REAL`, the Demo drawer → 9 → *Real Bluetooth relay* (remembered on the phone; `config.mesh.realDefault = false`).
Off by default. When off, unavailable or failing, Help uses the simulated mesh.

## What is built
- `android/app/src/main/java/org/cascade/nightway/mesh/`: `BleMesh.kt` (scan + advertise), `MeshService.kt` (foreground service, type connectedDevice), `MeshPlugin.kt` (Capacitor plugin "Mesh").
- `src/sos/ble.ts`: `BleMeshTransport` (same interface as the simulated mesh; gateway logic).
- Desk codes (2 bits): 0 police, 1 hospital, 2 contact, 3 fire; a test packet is an `ack` to code 3 (since UPGRADE U7).
- Packet: BLE legacy, non-connectable advertisement, manufacturer data with test company ID `0xFFFF`, 18 bytes:
  `id u32 | type 2b, desk 2b, version 4b | ttl 4b, hop 4b | lat i32 µdeg | lon i32 µdeg | ts u32 s`. **No signature** (it does not fit in v1).
- Every phone scans for `0xFFFF`, drops packets already seen (id + type + desk), re-advertises new ones with hop + 1 after 0.1–0.5 s while hop < ttl (5). At most 3 packets advertised at once, each for 15 s; the rest queue.
- Gateway: a phone that can reach the dispatch server posts SOS packets it hears (`via: mesh`, hop count) and broadcasts the server's acknowledgement back as an `ack` packet.
- Permissions: Android 12+ `BLUETOOTH_SCAN`, `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT` + fine location (scan results); Android 11 and older: `BLUETOOTH`, `BLUETOOTH_ADMIN`, fine location. Foreground-service notification while on.
- Studied for patterns only (permissions, foreground service, mesh design): bitchat-android. No code copied.

## Verified
| Check | Result |
|---|---|
| Builds into the APK; app still runs with it off | yes (Gradle build, all tests) |
| Pre-flight checklist (Bluetooth, Location, permissions, advertising, foreground service) | in the app (Demo 9) |
| Two phones exchange a test packet | **pending**: the user's two-phone test |
| SOS from phone A reaches the dispatch server through phone B (1 hop), ack returns | **pending** |
| Multi-hop (3 phones) | **not verified**: needs 3 Android phones |

## Honest limits
Only helps if phones nearby run NightWay with the relay on. Range is short (tens of metres indoors). Battery use while scanning; phone brands (e.g. Xiaomi/HyperOS) may pause background work unless battery saving is off for the app. Android limits the number of simultaneous advertisements. Packets are not signed or encrypted. Police / hospital endpoints are simulated.
