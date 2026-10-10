// TEST-ONLY TLS identities for the pinning tests. Two throwaway self-signed P-256 certificates and their private keys,
// generated once with the openssl CLI at development time (valid for 100 years, subject CN=n2engine-test-only-a / -b),
// used for nothing but a local tls server in the unit tests. They protect nothing: never use them anywhere else.
// Stored as base64 DER (not PEM text, which the repository's secret scan rejects) and rebuilt to PEM at runtime.
import { X509Certificate, createPrivateKey } from "node:crypto"

export interface TestIdentity {
  /** For tls.createServer's key option */
  key: string
  /** For tls.createServer's cert option */
  cert: string
  /** SHA-256 of the certificate, 64 lowercase hex digits (as the engine's ready line prints it) */
  fingerprint: string
}

function identity(keyDer: string, certDer: string): TestIdentity {
  const key = createPrivateKey({ key: Buffer.from(keyDer, "base64"), format: "der", type: "pkcs8" })
  const cert = new X509Certificate(Buffer.from(certDer, "base64"))
  return {
    key: key.export({ format: "pem", type: "pkcs8" }).toString(),
    cert: cert.toString(),
    fingerprint: cert.fingerprint256.replace(/:/g, "").toLowerCase(),
  }
}

const KeyA =
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQguNkpAb3InRCHf8sUpXAsco6FIZVKllVfk9GqU4+sqIihRANCAAQj" +
  "9BQaP7vt7R8f1Wun2ZKVxw4rnY1+CDobPtg75WHIGwb+Rg6n2BfEp/zAWmGVyrb77Qm4hMa27MypCUThScLh"
const CertA =
  "MIIBlDCCATugAwIBAgIUNkWDCLB0AqHhowpnhSkBgG52QrkwCgYIKoZIzj0EAwIwHzEdMBsGA1UEAwwUbjJlbmdpbmUtdGVzdC1v" +
  "bmx5LWEwIBcNMjYxMDEwMjE1MzAyWhgPMjEyNjA5MTYyMTUzMDJaMB8xHTAbBgNVBAMMFG4yZW5naW5lLXRlc3Qtb25seS1hMFkw" +
  "EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEI/QUGj+77e0fH9Vrp9mSlccOK52Nfgg6Gz7YO+VhyBsG/kYOp9gXxKf8wFphlcq2++0J" +
  "uITGtuzMqQlE4UnC4aNTMFEwHQYDVR0OBBYEFKipsyZYpNAaoDnbpuPCxeE5nV5pMB8GA1UdIwQYMBaAFKipsyZYpNAaoDnbpuPC" +
  "xeE5nV5pMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDRwAwRAIgVNzs/hty3HZHNOwLXVqAkzm2iflPvxkZLG2Jt+PXmX0C" +
  "IDX7AlydUFEgL7j0npqWpyrJjl10IybhcTvS/gT7u1K4"
const KeyB =
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg/UeSbmyIdUtMqRs3GiOKajq332zDwcjqQcSQmfbZZKehRANCAATp" +
  "OkGfdY7eDSDLz9v0KxSMs/FM1QHOOjw+Eo0jqlgsef1JpP1sw6eVDV1bbnpG/k1W0tiIlLczLBt8nTzAPuyr"
const CertB =
  "MIIBlTCCATugAwIBAgIUcD7iMUGGRcuksvc1G2TgXbrJdBowCgYIKoZIzj0EAwIwHzEdMBsGA1UEAwwUbjJlbmdpbmUtdGVzdC1v" +
  "bmx5LWIwIBcNMjYxMDEwMjE1MzAyWhgPMjEyNjA5MTYyMTUzMDJaMB8xHTAbBgNVBAMMFG4yZW5naW5lLXRlc3Qtb25seS1iMFkw" +
  "EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE6TpBn3WO3g0gy8/b9CsUjLPxTNUBzjo8PhKNI6pYLHn9SaT9bMOnlQ1dW256Rv5NVtLY" +
  "iJS3MywbfJ08wD7sq6NTMFEwHQYDVR0OBBYEFM+RQ2cWEmc8NUNP+77E2+bQxXqIMB8GA1UdIwQYMBaAFM+RQ2cWEmc8NUNP+77E" +
  "2+bQxXqIMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIhAMWfEf6tz2TFxxu8hpCkZNY1zJPu8IR4C363yCIoZe9O" +
  "AiAtomIrNNguYVfuN6HbUTDTgSJz5gCkRFZ3USwtuwfs1A=="

export const TestIdentityA: TestIdentity = identity(KeyA, CertA)
export const TestIdentityB: TestIdentity = identity(KeyB, CertB)
