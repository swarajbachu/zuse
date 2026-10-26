package com.zuse.localconnectivity

import android.util.Base64
import java.net.InetSocketAddress
import java.net.Socket
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509TrustManager

/** Trust only the leaf certificate advertised during discovery and confirmed during pairing. */
internal fun connectPinned(host: String, port: Int, pin: String): Socket {
  val trust = object : X509TrustManager {
    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
      throw CertificateException("Client certificates are not supported.")
    }
    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
      val certificate = chain.firstOrNull() ?: throw CertificateException("Missing server certificate.")
      val actual = Base64.encodeToString(
        MessageDigest.getInstance("SHA-256").digest(certificate.encoded),
        Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP
      )
      if (!MessageDigest.isEqual(actual.toByteArray(), pin.toByteArray())) {
        throw CertificateException("The computer's encrypted identity did not match.")
      }
    }
  }
  val tls = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
  val socket = tls.socketFactory.createSocket() as SSLSocket
  try {
    socket.tcpNoDelay = true
    socket.keepAlive = true
    socket.soTimeout = 10_000
    socket.connect(InetSocketAddress(host, port), 10_000)
    socket.startHandshake()
    socket.soTimeout = 0
    return socket
  } catch (cause: Exception) {
    socket.close()
    throw cause
  }
}
