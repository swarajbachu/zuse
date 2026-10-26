package com.zuse.localconnectivity

import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.net.Socket
import java.security.KeyFactory
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.spec.PKCS8EncodedKeySpec
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLException
import javax.net.ssl.SSLServerSocket
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PinnedLocalSocketTest {
  @Test fun forwardsPinnedTlsAndRejectsAChangedCertificate() {
    // These are public, test-only credentials; no production certificate is trusted.
    val assets = InstrumentationRegistry.getInstrumentation().context.assets
    val certificate = assets.open("server.cer").use {
      CertificateFactory.getInstance("X.509").generateCertificate(it)
    }
    val key = assets.open("server.key").use {
      KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(it.readBytes()))
    }
    val store = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
      load(null)
      setKeyEntry("test", key, "test".toCharArray(), arrayOf(certificate))
    }
    val keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply {
      init(store, "test".toCharArray())
    }
    val tls = SSLContext.getInstance("TLS").apply { init(keys.keyManagers, null, null) }
    val executor = Executors.newSingleThreadExecutor()
    (tls.serverSocketFactory.createServerSocket(0) as SSLServerSocket).use { server ->
      server.soTimeout = 5000
      val pin = Base64.encodeToString(
        MessageDigest.getInstance("SHA-256").digest(certificate.encoded),
        Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP
      )
      val echo = executor.submit {
        server.accept().use { socket ->
          socket.soTimeout = 5000
          socket.getOutputStream().write(socket.getInputStream().read() + 1)
        }
        server.accept().use { socket ->
          socket.soTimeout = 5000
          runCatching { socket.getInputStream().read() }
        }
      }
      try {
        LocalByteProxy { connectPinned("127.0.0.1", server.localPort, pin) }.use { proxy ->
          proxy.start()
          Socket("127.0.0.1", proxy.port).use { local ->
            local.soTimeout = 5000
            local.getOutputStream().write(42)
            assertEquals(43, local.getInputStream().read())
          }
        }
        assertThrows(SSLException::class.java) {
          connectPinned("127.0.0.1", server.localPort, "A".repeat(43)).close()
        }
        echo.get(10, TimeUnit.SECONDS)
      } finally {
        executor.shutdownNow()
      }
    }
  }
}
