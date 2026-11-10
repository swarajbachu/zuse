package com.zuse.localconnectivity

import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.atomic.AtomicBoolean

/** One loopback listener multiplexes HTTP requests and the persistent WebSocket. */
internal class LocalByteProxy(private val connectRemote: () -> Socket) : AutoCloseable {
  private val closed = AtomicBoolean(false)
  private val listener = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
  private val sockets = ConcurrentHashMap.newKeySet<Socket>()
  private val slots = Semaphore(16)
  private val workers = Executors.newCachedThreadPool()
  val port: Int get() = listener.localPort

  fun start() {
    workers.execute {
      try {
        while (!closed.get()) {
          val local = listener.accept()
          if (!slots.tryAcquire()) {
            local.close()
            continue
          }
          sockets.add(local)
          try {
            workers.execute { forward(local) }
          } catch (_: java.util.concurrent.RejectedExecutionException) {
            sockets.remove(local)
            slots.release()
            local.close()
          }
        }
      } catch (_: Exception) {
        // Closing the listener interrupts accept.
      }
    }
  }

  private fun forward(local: Socket) {
    var remote: Socket? = null
    try {
      local.tcpNoDelay = true
      local.keepAlive = true
      remote = connectRemote()
      val upstream = remote
      sockets.add(upstream)
      if (closed.get()) return
      workers.execute {
        try {
          upstream.getInputStream().copyTo(local.getOutputStream(), 64 * 1024)
        } catch (_: Exception) {
          // Either peer closing terminates both pumps.
        } finally {
          local.close()
          upstream.close()
        }
      }
      local.getInputStream().copyTo(upstream.getOutputStream(), 64 * 1024)
    } catch (_: Exception) {
      // Refused connections and TLS failures close this session, not the listener.
    } finally {
      local.close()
      remote?.close()
      sockets.remove(local)
      remote?.let { sockets.remove(it) }
      slots.release()
    }
  }

  override fun close() {
    if (!closed.compareAndSet(false, true)) return
    listener.close()
    sockets.forEach { runCatching { it.close() } }
    sockets.clear()
    workers.shutdownNow()
  }
}
