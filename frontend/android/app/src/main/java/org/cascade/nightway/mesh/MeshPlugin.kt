package org.cascade.nightway.mesh

import android.Manifest
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * Capacitor plugin "Mesh": the TypeScript BleMeshTransport (src/sos/ble.ts) talks to BleMesh through it.
 *   start({title, text}) / stop() / status() / broadcast(packet) / sendTest(...) ; event "packet".
 * Any failure (no Bluetooth, permission denied) rejects, and the app falls back to the simulated mesh.
 */
@CapacitorPlugin(
    name = "Mesh",
    permissions = [
        Permission(alias = "ble", strings = [Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT]),
        Permission(alias = "location", strings = [Manifest.permission.ACCESS_FINE_LOCATION]),
        Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS]),
    ]
)
class MeshPlugin : Plugin(), BleMesh.Listener {

    /** Android 12+: the three Bluetooth permissions (+ location for scan results); older: location. */
    private fun aliases(): Array<String> {
        val a = mutableListOf("location")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) a.add("ble")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) a.add("notifications")
        return a.toTypedArray()
    }

    private fun required(): List<String> = aliases().filter { it != "notifications" }

    @PluginMethod
    fun start(call: PluginCall) {
        if (required().any { getPermissionState(it) != PermissionState.GRANTED }) {
            requestPermissionForAliases(aliases(), call, "afterPermissions")
            return
        }
        doStart(call)
    }

    @PermissionCallback
    private fun afterPermissions(call: PluginCall) {
        val missing = required().filter { getPermissionState(it) != PermissionState.GRANTED }
        if (missing.isNotEmpty()) call.reject("permission denied: ${missing.joinToString()}") else doStart(call)
    }

    private fun doStart(call: PluginCall) {
        BleMesh.listener = this
        val err = BleMesh.start(context)
        if (err != null) { call.reject(err); return }
        try {
            val i = Intent(context, MeshService::class.java)
                .putExtra("title", call.getString("title", "NightWay"))
                .putExtra("text", call.getString("text", ""))
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(i) else context.startService(i)
        } catch (e: Exception) {
            notifyLog("foreground service: ${e.message}")      // relay still runs while the app is open
        }
        call.resolve(statusObject())
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        BleMesh.stop()
        context.stopService(Intent(context, MeshService::class.java))
        call.resolve(statusObject())
    }

    @PluginMethod
    fun status(call: PluginCall) { call.resolve(statusObject()) }

    /** Everything that commonly stops BLE relaying, for the Demo drawer's checklist. */
    @PluginMethod
    fun diagnose(call: PluginCall) {
        val adapter = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
        val locationOn = when {
            lm == null -> false
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.P -> lm.isLocationEnabled
            else -> lm.isProviderEnabled(LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
        }
        val perms = JSObject()
        for (a in aliases()) perms.put(a, getPermissionState(a)?.toString() ?: "unknown")
        call.resolve(JSObject()
            .put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
            .put("android", Build.VERSION.SDK_INT)
            .put("hasBle", context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE))
            .put("bluetoothOn", adapter?.isEnabled == true)
            .put("canAdvertise", adapter?.isMultipleAdvertisementSupported == true)
            .put("locationOn", locationOn)
            .put("permissions", perms)
            .put("running", BleMesh.running)
            .put("lastError", BleMesh.lastError))
    }

    @PluginMethod
    fun broadcast(call: PluginCall) {
        if (!BleMesh.running) { call.reject("mesh is not running"); return }
        val p = BleMesh.Packet(
            id = (call.getLong("id") ?: 0L) and 0xFFFFFFFFL,
            type = call.getInt("type") ?: 2,
            to = call.getInt("to") ?: 0,
            ttl = call.getInt("ttl") ?: 5,
            hop = call.getInt("hop") ?: 0,
            latE6 = Math.round((call.getDouble("lat") ?: 0.0) * 1e6).toInt(),
            lonE6 = Math.round((call.getDouble("lon") ?: 0.0) * 1e6).toInt(),
            ts = call.getLong("ts") ?: (System.currentTimeMillis() / 1000),
        )
        BleMesh.broadcast(p)
        call.resolve(statusObject())
    }

    private fun statusObject() = JSObject()
        .put("running", BleMesh.running)
        .put("peers", BleMesh.peerCount())
        .put("relayed", BleMesh.relayed)
        .put("sent", BleMesh.sent)
        .put("lastPacketAt", if (BleMesh.lastPacketAt > 0) BleMesh.lastPacketAt else null)

    override fun onPacket(p: BleMesh.Packet, rssi: Int) {
        notifyListeners("packet", JSObject()
            .put("id", p.id).put("type", p.type).put("to", p.to).put("ttl", p.ttl).put("hop", p.hop)
            .put("lat", p.latE6 / 1e6).put("lon", p.lonE6 / 1e6).put("ts", p.ts).put("rssi", rssi))
    }

    override fun onLog(message: String) { notifyLog(message) }

    private fun notifyLog(message: String) { notifyListeners("log", JSObject().put("message", message)) }
}
