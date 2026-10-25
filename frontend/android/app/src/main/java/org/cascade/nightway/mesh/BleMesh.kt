package org.cascade.nightway.mesh

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Handler
import android.os.Looper
import java.nio.ByteBuffer
import kotlin.random.Random

/**
 * Minimal SOS-only relay over BLE advertisements (spec §13). No connections, no pairing.
 *
 * Packet = manufacturer-specific data, test company ID 0xFFFF, 18 bytes, big-endian:
 *   0-3  id (uint32)
 *   4    type (2 bits: danger, medical, unsure, ack) | to (2 bits: police, hospital, contact, test) | version (4 bits = 1)
 *   5    ttl (4 bits) | hop (4 bits)
 *   6-9  lat, int32 microdegrees      10-13 lon, int32 microdegrees      14-17 ts, uint32 seconds
 * No signature in v1 (it does not fit in a legacy advertisement).
 *
 * Every phone scans for the company ID, drops packets it has already seen (by id + type + to), and
 * re-advertises new ones with hop + 1 after a short random delay while hop < ttl. Only a few packets are
 * advertised at a time and each stops after a time limit; the rest wait in a queue.
 */
@SuppressLint("MissingPermission")   // MeshPlugin checks the Bluetooth permissions before start()
object BleMesh {
    const val COMPANY_ID = 0xFFFF
    private const val VERSION = 1
    private const val ADVERTISE_MS = 15_000L
    private const val MAX_ADVERTISING = 3          // lowered at run time if the phone refuses more
    private const val SEEN_KEEP_MS = 10 * 60_000L
    private const val PEER_WINDOW_MS = 60_000L

    data class Packet(val id: Long, val type: Int, val to: Int, val ttl: Int, val hop: Int, val latE6: Int, val lonE6: Int, val ts: Long) {
        val key: String get() = "$type:$id:$to"

        fun encode(): ByteArray = ByteBuffer.allocate(18)
            .putInt(id.toInt())
            .put(((type and 3) shl 6 or ((to and 3) shl 4) or VERSION).toByte())
            .put(((ttl and 15) shl 4 or (hop and 15)).toByte())
            .putInt(latE6).putInt(lonE6).putInt(ts.toInt())
            .array()

        companion object {
            fun decode(b: ByteArray): Packet? {
                if (b.size < 18) return null
                val bb = ByteBuffer.wrap(b)
                val id = bb.int.toLong() and 0xFFFFFFFFL
                val t = bb.get().toInt() and 0xFF
                if (t and 15 != VERSION) return null
                val th = bb.get().toInt() and 0xFF
                return Packet(id, t shr 6, (t shr 4) and 3, th shr 4, th and 15, bb.int, bb.int, bb.int.toLong() and 0xFFFFFFFFL)
            }
        }
    }

    interface Listener {
        fun onPacket(p: Packet, rssi: Int)
        fun onLog(message: String)
    }

    @Volatile var listener: Listener? = null
    var running = false; private set
    var relayed = 0; private set
    var sent = 0; private set
    var lastPacketAt = 0L; private set
    var lastError: String? = null; private set
    private var maxAdvertising = MAX_ADVERTISING

    private val handler = Handler(Looper.getMainLooper())
    private val seen = LinkedHashMap<String, Long>()
    private val peers = HashMap<String, Long>()
    private val queue = ArrayDeque<Packet>()
    private val advertising = LinkedHashMap<String, AdvertiseCallback>()
    private var scanner: BluetoothLeScanner? = null
    private var advertiser: BluetoothLeAdvertiser? = null

    fun peerCount(): Int {
        val now = System.currentTimeMillis()
        peers.entries.removeAll { now - it.value > PEER_WINDOW_MS }
        return peers.size
    }

    /** Starts scanning; returns null when running, else a short reason. */
    fun start(ctx: Context): String? {
        if (running) return null
        val adapter = (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter ?: return "no bluetooth"
        if (!adapter.isEnabled) return "bluetooth is off"
        val sc = adapter.bluetoothLeScanner ?: return "no BLE scanner"
        val ad = adapter.bluetoothLeAdvertiser ?: return "this phone cannot advertise BLE"
        val filter = ScanFilter.Builder().setManufacturerData(COMPANY_ID, ByteArray(0)).build()
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        try {
            sc.startScan(listOf(filter), settings, scanCallback)
        } catch (e: SecurityException) {
            return "permission missing: ${e.message}"
        }
        scanner = sc
        advertiser = ad
        running = true
        log("scanning")
        return null
    }

    fun stop() {
        if (!running) return
        try { scanner?.stopScan(scanCallback) } catch (_: Exception) {}
        for (cb in advertising.values) try { advertiser?.stopAdvertising(cb) } catch (_: Exception) {}
        advertising.clear()
        queue.clear()
        handler.removeCallbacksAndMessages(null)
        running = false
        log("stopped")
    }

    /** A packet from this phone (help request, acknowledgement, test). */
    fun broadcast(p: Packet) {
        markSeen(p.key)
        sent++
        enqueue(p)
    }

    private fun markSeen(key: String) {
        val now = System.currentTimeMillis()
        seen[key] = now
        if (seen.size > 500) seen.entries.removeAll { now - it.value > SEEN_KEEP_MS }
    }

    private fun enqueue(p: Packet) {
        queue.addLast(p)
        pump()
    }

    private fun pump() {
        val ad = advertiser ?: return
        while (running && advertising.size < maxAdvertising && queue.isNotEmpty()) {
            val p = queue.removeFirst()
            val slot = "${p.key}:${p.hop}:${System.nanoTime()}"
            val settings = AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
                .setConnectable(false)
                .setTimeout(0)
                .build()
            val data = AdvertiseData.Builder()
                .setIncludeDeviceName(false)
                .setIncludeTxPowerLevel(false)
                .addManufacturerData(COMPANY_ID, p.encode())
                .build()
            val cb = object : AdvertiseCallback() {
                override fun onStartFailure(errorCode: Int) {
                    advertising.remove(slot)
                    if (errorCode == ADVERTISE_FAILED_TOO_MANY_ADVERTISERS && maxAdvertising > 1) {
                        maxAdvertising = maxOf(1, advertising.size)    // this phone allows fewer at once:
                        queue.addFirst(p)                              // keep the packet and retry when a slot frees
                        log("phone allows $maxAdvertising advert(s) at a time")
                    } else {
                        lastError = "advertise failed (${advertiseError(errorCode)})"
                        log(lastError!!)
                    }
                    handler.post { pump() }
                }
            }
            advertising[slot] = cb
            try {
                ad.startAdvertising(settings, data, cb)
            } catch (e: Exception) {
                advertising.remove(slot)
                log("advertise error: ${e.message}")
                continue
            }
            handler.postDelayed({ stopSlot(slot) }, ADVERTISE_MS)   // time limit per packet
        }
    }

    private fun stopSlot(slot: String) {
        val cb = advertising.remove(slot) ?: return
        try { advertiser?.stopAdvertising(cb) } catch (_: Exception) {}
        pump()
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val bytes = result.scanRecord?.getManufacturerSpecificData(COMPANY_ID) ?: return
            val p = Packet.decode(bytes) ?: return
            val now = System.currentTimeMillis()
            peers[result.device.address] = now
            if (seen.containsKey(p.key)) return                 // dedupe by id
            markSeen(p.key)
            lastPacketAt = now
            listener?.onPacket(p, result.rssi)
            if (p.hop < p.ttl) {                                 // hop limit
                handler.postDelayed({
                    relayed++
                    enqueue(p.copy(hop = p.hop + 1))
                }, 100L + Random.nextLong(400L))                 // jitter so neighbours don't collide
            }
        }

        override fun onScanFailed(errorCode: Int) {
            lastError = "scan failed (code $errorCode)"
            log(lastError!!)
        }
    }

    private fun log(m: String) { listener?.onLog(m) }

    private fun advertiseError(code: Int) = when (code) {
        AdvertiseCallback.ADVERTISE_FAILED_DATA_TOO_LARGE -> "data too large"
        AdvertiseCallback.ADVERTISE_FAILED_TOO_MANY_ADVERTISERS -> "too many advertisers"
        AdvertiseCallback.ADVERTISE_FAILED_ALREADY_STARTED -> "already started"
        AdvertiseCallback.ADVERTISE_FAILED_INTERNAL_ERROR -> "internal error"
        AdvertiseCallback.ADVERTISE_FAILED_FEATURE_UNSUPPORTED -> "not supported on this phone"
        else -> "code $code"
    }
}
