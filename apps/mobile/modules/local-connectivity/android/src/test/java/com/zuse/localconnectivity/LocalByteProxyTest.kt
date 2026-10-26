package com.zuse.localconnectivity

import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalByteProxyTest {
  @Test fun forwardsConcurrentConnectionsAndClosesLiveSockets() {
    ServerSocket(0, 16, InetAddress.getLoopbackAddress()).use { upstream ->
      val executor = Executors.newCachedThreadPool()
      val proxy = LocalByteProxy { Socket("127.0.0.1", upstream.localPort) }
      try {
        proxy.start()
        val echo = executor.submit {
          repeat(2) {
            val socket = upstream.accept()
            executor.execute {
              socket.use {
                val value = it.getInputStream().read()
                it.getOutputStream().write(value + 1)
                it.getInputStream().read()
              }
            }
          }
        }
        Socket("127.0.0.1", proxy.port).use { first ->
          Socket("127.0.0.1", proxy.port).use { second ->
            first.soTimeout = 3000
            second.soTimeout = 3000
            first.getOutputStream().write(10)
            second.getOutputStream().write(20)
            assertEquals(11, first.getInputStream().read())
            assertEquals(21, second.getInputStream().read())
            echo.get(3, TimeUnit.SECONDS)
            proxy.close()
            assertEquals(-1, first.getInputStream().read())
            assertEquals(-1, second.getInputStream().read())
          }
        }
      } finally {
        proxy.close()
        executor.shutdownNow()
        assertTrue(executor.awaitTermination(3, TimeUnit.SECONDS))
      }
    }
  }

  @Test fun failedRemoteDoesNotKillListener() {
    val proxy = LocalByteProxy { throw java.io.IOException("TLS pin mismatch") }
    try {
      proxy.start()
      repeat(2) {
        Socket("127.0.0.1", proxy.port).use { local ->
          local.soTimeout = 3000
          assertEquals(-1, local.getInputStream().read())
        }
      }
    } finally {
      proxy.close()
    }
  }
}
