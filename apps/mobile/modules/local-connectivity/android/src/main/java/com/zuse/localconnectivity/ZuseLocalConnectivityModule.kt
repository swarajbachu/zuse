package com.zuse.localconnectivity

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID

/** Android DNS-SD and pinned TLS behind the same loopback contract as iOS. */
class ZuseLocalConnectivityModule : Module() {
  private val lock = Any()
  private var browser: NsdManager.DiscoveryListener? = null
  private var multicast: WifiManager.MulticastLock? = null
  private var pathMonitor: ConnectivityManager.NetworkCallback? = null
  private var path: Network? = null
  private var generation = 0
  private var epoch = 0
  private val found = linkedMapOf<String, NsdServiceInfo>()
  private val resolved = linkedMapOf<String, NsdServiceInfo>()
  private val pending = ArrayDeque<Pair<Int, NsdServiceInfo>>()
  private var resolving = false
  private val proxies = mutableMapOf<String, LocalByteProxy>()

  private fun context(): Context = appContext.reactContext
    ?: throw CodedException("The app is not ready yet.")
  private fun nsd(): NsdManager = context().getSystemService(NsdManager::class.java)

  override fun definition() = ModuleDefinition {
    Name("ZuseLocalConnectivity")
    Events("onServicesChanged", "onPathChanged", "onDiscoveryStateChanged")
    AsyncFunction("startDiscovery") { synchronized(lock) { startDiscovery() } }
    AsyncFunction("stopDiscovery") { synchronized(lock) { stopDiscovery() } }
    AsyncFunction("openProxy") { service: Map<String, Any?> ->
      synchronized(lock) {
        val pin = service["tlsCertificatePin"] as? String
          ?: throw CodedException("The nearby computer has no encrypted identity.")
        val name = service["name"] as? String
        val endpoint = resolved[name]
          ?: throw CodedException("This computer is no longer nearby. Search again or scan its QR code.")
        if (certificatePin(endpoint) != pin) {
          throw CodedException("The nearby computer's encrypted identity changed. Pair again.")
        }
        val host = endpoint.host ?: throw CodedException("The computer has no network address.")
        val port = endpoint.port
        val proxy = LocalByteProxy { connectPinned(host.hostAddress!!, port, pin) }
        val id = UUID.randomUUID().toString()
        proxies[id] = proxy
        proxy.start()
        mapOf("id" to id, "host" to "127.0.0.1", "port" to proxy.port)
      }
    }
    AsyncFunction("closeProxy") { id: String ->
      synchronized(lock) { proxies.remove(id)?.close(); Unit }
    }
    OnActivityEntersForeground { synchronized(lock) { startDiscovery() } }
    OnActivityEntersBackground { synchronized(lock) { stopDiscovery() } }
    OnDestroy {
      synchronized(lock) {
        stopDiscovery()
        pathMonitor?.let {
          runCatching { context().getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) }
        }
        pathMonitor = null
        proxies.values.forEach { it.close() }
        proxies.clear()
      }
    }
  }

  private fun state(value: String, reason: String? = null) {
    sendEvent("onDiscoveryStateChanged", mapOf(
      "state" to value, "reason" to reason, "serviceCount" to resolved.size,
      "rawResultCount" to found.size
    ))
  }

  private fun certificatePin(service: NsdServiceInfo): String? =
    service.attributes["tls"]?.toString(Charsets.UTF_8)?.takeIf {
      it.matches(Regex("[A-Za-z0-9_-]{43}"))
    }

  private fun publish() {
    sendEvent("onServicesChanged", mapOf("services" to resolved.values.map { info ->
      mapOf(
        "id" to certificatePin(info), "name" to info.serviceName,
        "type" to "_zuse._tcp", "domain" to "local.",
        "tlsCertificatePin" to certificatePin(info)
      )
    }))
  }

  @Suppress("DEPRECATION")
  private fun resolveNext() {
    if (resolving || pending.isEmpty()) return
    val (requestedEpoch, service) = pending.removeFirst()
    resolving = true
    try {
      nsd().resolveService(service, object : NsdManager.ResolveListener {
        override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) = synchronized(lock) {
          resolving = false
          if (epoch == requestedEpoch && browser != null) {
            state("waiting", "Could not resolve ${info.serviceName} (Android error $errorCode). Try searching again.")
          }
          resolveNext()
        }
        override fun onServiceResolved(info: NsdServiceInfo) = synchronized(lock) {
          resolving = false
          if (epoch == requestedEpoch && browser != null && found[service.serviceName] === service) {
            if (certificatePin(info) != null && info.host != null && info.port > 0) {
              resolved[info.serviceName] = info
              publish()
              state("ready")
            }
          }
          resolveNext()
        }
      })
    } catch (cause: Exception) {
      resolving = false
      state("failed", cause.message ?: "Android could not resolve nearby computers.")
      resolveNext()
    }
  }

  private fun startDiscovery() {
    if (browser != null) return
    state("starting")
    try {
      startPathMonitor()
      val wifi = context().applicationContext.getSystemService(WifiManager::class.java)
      multicast = wifi.createMulticastLock("zuse-nearby").apply {
        setReferenceCounted(false)
        acquire()
      }
      val listener = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(type: String) = synchronized(lock) {
          if (browser === this) state("ready")
        }
        override fun onServiceFound(info: NsdServiceInfo) = synchronized(lock) {
          if (browser !== this) return@synchronized
          found[info.serviceName] = info
          pending.addLast(epoch to info)
          resolveNext()
        }
        override fun onServiceLost(info: NsdServiceInfo) = synchronized(lock) {
          if (browser !== this) return@synchronized
          found.remove(info.serviceName)
          resolved.remove(info.serviceName)
          publish()
        }
        override fun onStartDiscoveryFailed(type: String, code: Int) = synchronized(lock) {
          if (browser !== this) return@synchronized
          stopDiscovery()
          state("failed", "Android could not search the local network (error $code). Check Wi-Fi and try again.")
        }
        override fun onStopDiscoveryFailed(type: String, code: Int) = synchronized(lock) {
          if (browser === this) state("failed", "Android could not stop nearby discovery (error $code).")
        }
        override fun onDiscoveryStopped(type: String) = Unit
      }
      browser = listener
      nsd().discoverServices("_zuse._tcp.", NsdManager.PROTOCOL_DNS_SD, listener)
    } catch (cause: Exception) {
      stopDiscovery()
      state("failed", cause.message ?: "Nearby discovery is unavailable. Check Wi-Fi or scan a QR code.")
    }
  }

  private fun stopDiscovery() {
    val current = browser
    browser = null
    epoch += 1
    pending.clear()
    if (current != null) runCatching { nsd().stopServiceDiscovery(current) }
    multicast?.let { if (it.isHeld) it.release() }
    multicast = null
    found.clear()
    resolved.clear()
    publish()
    state("stopped")
  }

  private fun startPathMonitor() {
    if (pathMonitor != null) return
    val connectivity = context().getSystemService(ConnectivityManager::class.java)
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = synchronized(lock) {
        if (path == network) return@synchronized
        path = network
        reportPath(capabilities)
      }
      override fun onLost(network: Network) = synchronized(lock) {
        if (path != network) return@synchronized
        path = null
        reportPath(null)
      }
    }
    connectivity.registerDefaultNetworkCallback(callback)
    pathMonitor = callback
  }

  private fun reportPath(capabilities: NetworkCapabilities?) {
    generation += 1
    sendEvent("onPathChanged", mapOf(
      "status" to if (capabilities == null) "unsatisfied" else "satisfied",
      "usesWifi" to (capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true),
      "usesCellular" to (capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true),
      "networkId" to path?.networkHandle?.toString(),
      "generation" to generation
    ))
  }

}
