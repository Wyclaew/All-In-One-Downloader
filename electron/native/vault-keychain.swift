import Foundation
import Security
import LocalAuthentication
import CryptoKit
import Darwin

// Ad-hoc signed command-line helpers have no provisioned Keychain access group.
// A generic-password item in the data-protection Keychain therefore fails with
// errSecMissingEntitlement even when Touch ID capability succeeds. Persist only
// a device-encrypted Secure Enclave key blob plus an authenticated envelope.
// The Enclave enforces biometryCurrentSet on the actual private ECDH operation.
let service = "com.erne.allinonedownloader.vault"
func emit(_ value: [String: Any], to handle: FileHandle) {
    if let data = try? JSONSerialization.data(withJSONObject: value) { handle.write(data) }
}
func fail(_ message: String, code: String = "keychain-error", nativeStatus: Int? = nil) -> Never {
    var info: [String: Any] = ["code": code, "message": message]
    if let nativeStatus = nativeStatus { info["nativeStatus"] = nativeStatus }
    emit(info, to: .standardError)
    exit(1)
}
func authenticationCode(_ error: Error?) -> String {
    guard let error = error as NSError? else { return "authentication-failed" }
    if error.domain == LAError.errorDomain {
        switch LAError.Code(rawValue: error.code) {
        case .userCancel, .systemCancel, .appCancel, .userFallback: return "canceled"
        case .biometryNotEnrolled: return "not-enrolled"
        case .biometryLockout: return "locked-out"
        case .biometryNotAvailable: return "unavailable"
        case .notInteractive, .invalidContext: return "session-unavailable"
        default: return "authentication-failed"
        }
    }
    if let nested = error.userInfo[NSUnderlyingErrorKey] as? Error { return authenticationCode(nested) }
    if error.domain == NSPOSIXErrorDomain || error.domain == NSCocoaErrorDomain { return "storage-error" }
    switch error.code {
    case Int(errSecUserCanceled): return "canceled"
    case Int(errSecItemNotFound): return "key-missing"
    case Int(errSecInteractionNotAllowed): return "session-unavailable"
    case Int(errSecMissingEntitlement): return "missing-entitlement"
    default: return "authentication-failed"
    }
}
func check(_ status: OSStatus) {
    if status == errSecSuccess { return }
    let code: String
    switch status {
    case errSecUserCanceled: code = "canceled"
    case errSecItemNotFound: code = "key-missing"
    case errSecAuthFailed: code = "authentication-failed"
    case errSecInteractionNotAllowed: code = "session-unavailable"
    case errSecMissingEntitlement: code = "missing-entitlement"
    default: code = "keychain-error"
    }
    fail((SecCopyErrorMessageString(status, nil) as String?) ?? "Keychain error \(status)", code: code, nativeStatus: Int(status))
}
func protectedAccess() -> SecAccessControl {
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(nil,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet], &error)
    else { fail("Biometric access control could not be created", code: "secure-enclave-error") }
    return access
}
func authorize(_ context: LAContext, reason: String) {
    let semaphore = DispatchSemaphore(value: 0)
    var authenticated = false
    var authenticationError: Error?
    context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { success, error in
        authenticated = success
        authenticationError = error
        semaphore.signal()
    }
    semaphore.wait()
    guard authenticated else { fail("Touch ID doğrulaması tamamlanmadı.", code: authenticationCode(authenticationError)) }
}
struct Envelope: Codable {
    let version: Int
    let account: String
    let privateKey: Data
    let peerPublicKey: Data
    let salt: Data
    let sealed: Data
}
func envelopeURL() -> URL {
    guard let raw = ProcessInfo.processInfo.environment["AIO_BIOMETRIC_FILE"], raw.hasPrefix("/"),
        URL(fileURLWithPath: raw).lastPathComponent == "biometric-envelope.json" else {
        fail("Biometric storage location is missing", code: "storage-error")
    }
    return URL(fileURLWithPath: raw)
}
func writeEnvelope(_ data: Data, to url: URL) throws {
    let fm = FileManager.default
    try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700])
    let temp = url.deletingLastPathComponent().appendingPathComponent(".biometric-\(UUID().uuidString).tmp")
    let fd = Darwin.open(temp.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode_t(0o600))
    guard fd >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    defer { try? handle.close(); try? fm.removeItem(at: temp) }
    try handle.write(contentsOf: data)
    try handle.synchronize()
    try handle.close()
    guard Darwin.rename(temp.path, url.path) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
}
func loadEnvelope(_ url: URL) throws -> Envelope {
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    guard attributes[.type] as? FileAttributeType == .typeRegular,
        let bytes = attributes[.size] as? NSNumber, bytes.intValue <= 65536 else {
        fail("Invalid biometric envelope", code: "invalid-key")
    }
    let envelope = try JSONDecoder().decode(Envelope.self, from: Data(contentsOf: url))
    guard envelope.version == 1, envelope.privateKey.count <= 8192,
        envelope.peerPublicKey.count == 65, envelope.salt.count == 32,
        envelope.sealed.count >= 28, envelope.sealed.count <= 8192 else {
        fail("Invalid biometric envelope", code: "invalid-key")
    }
    return envelope
}
func envelopeAAD(_ account: String) -> Data { Data("All in One Downloader Touch ID envelope v1:\(account)".utf8) }
func seal(_ data: Data, key: SecureEnclave.P256.KeyAgreement.PrivateKey, account: String) throws -> Envelope {
    let peer = P256.KeyAgreement.PrivateKey()
    let shared = try peer.sharedSecretFromKeyAgreement(with: key.publicKey)
    var salt = Data(count: 32)
    let randomStatus = salt.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, $0.count, $0.baseAddress!) }
    check(randomStatus)
    let aad = envelopeAAD(account)
    let wrapping = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt, sharedInfo: aad, outputByteCount: 32)
    let sealed = try AES.GCM.seal(data, using: wrapping, authenticating: aad)
    guard let combined = sealed.combined else { fail("Encryption failed", code: "secure-enclave-error") }
    return Envelope(version: 1, account: account, privateKey: key.dataRepresentation, peerPublicKey: peer.publicKey.x963Representation, salt: salt, sealed: combined)
}
func unwrap(_ envelope: Envelope, context: LAContext, account: String) throws -> Data {
    guard envelope.account == account else { fail("Biometric enrollment belongs to another profile", code: "invalid-key") }
    let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: envelope.privateKey, authenticationContext: context)
    let peer = try P256.KeyAgreement.PublicKey(x963Representation: envelope.peerPublicKey)
    let shared = try key.sharedSecretFromKeyAgreement(with: peer)
    let aad = envelopeAAD(account)
    let wrapping = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: envelope.salt, sharedInfo: aad, outputByteCount: 32)
    return try AES.GCM.open(AES.GCM.SealedBox(combined: envelope.sealed), using: wrapping, authenticating: aad)
}

guard CommandLine.arguments.count >= 2 else { fail("Invalid request") }
let operation = CommandLine.arguments[1]
let context = LAContext()
context.localizedReason = "Şifreli kasayı Touch ID ile aç"
context.localizedFallbackTitle = ""
if operation == "status" {
    // Capability only: no authentication prompt and no stored item is read.
    var error: NSError?
    let canEvaluate = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
    let status: String
    if canEvaluate && context.biometryType == .touchID && SecureEnclave.isAvailable { status = "available" }
    else {
        switch error?.code {
        case LAError.biometryNotEnrolled.rawValue: status = "not-enrolled"
        case LAError.biometryLockout.rawValue: status = "locked-out"
        default: status = "unavailable"
        }
    }
    emit(["available": status == "available", "status": status, "backend": "secure-enclave"], to: .standardOutput)
    exit(0)
}
// An isolated, prompt-free native regression. No existing Keychain or envelope
// is touched; proves the exported device blob restores and cannot perform the
// protected ECDH operation when UI/authentication is prohibited.
if operation == "self-test" {
    context.interactionNotAllowed = true
    do {
        // Exercise the real envelope implementation with a separate ephemeral
        // non-biometric test key and public fixture text. Production enrollment
        // always uses protectedAccess(), never this test-only access control.
        var accessError: Unmanaged<CFError>?
        guard let testAccess = SecAccessControlCreateWithFlags(nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .privateKeyUsage, &accessError) else {
            fail("Envelope self-test access control failed", code: "self-test-failed")
        }
        let testKey = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: testAccess, authenticationContext: context)
        let testAccount = String(repeating: "a", count: 64)
        let fixture = Data("Public synthetic biometric self-test".utf8)
        let envelope = try seal(fixture, key: testKey, account: testAccount)
        guard try unwrap(envelope, context: context, account: testAccount) == fixture else {
            fail("Envelope self-test did not round-trip", code: "self-test-failed")
        }
        var changed = envelope.sealed
        changed[changed.count - 1] ^= 1
        let tampered = Envelope(version: envelope.version, account: envelope.account, privateKey: envelope.privateKey,
            peerPublicKey: envelope.peerPublicKey, salt: envelope.salt, sealed: changed)
        do {
            _ = try unwrap(tampered, context: context, account: testAccount)
            fail("Modified envelope unexpectedly decrypted", code: "self-test-failed")
        } catch { /* AES-GCM must authenticate every encrypted byte. */ }
        let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: protectedAccess(), authenticationContext: context)
        let restored = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: key.dataRepresentation, authenticationContext: context)
        let peer = P256.KeyAgreement.PrivateKey()
        do { _ = try restored.sharedSecretFromKeyAgreement(with: peer.publicKey) }
        catch {
            guard authenticationCode(error) == "session-unavailable" else { throw error }
            emit(["ok": true, "backend": "secure-enclave", "restored": true, "authenticationRequired": true, "encryptionRoundtrip": true, "tamperRejected": true], to: .standardOutput)
            exit(0)
        }
        fail("Protected operation unexpectedly succeeded without authentication", code: "self-test-failed")
    } catch { fail("Secure Enclave capability test failed", code: authenticationCode(error)) }
}
guard CommandLine.arguments.count == 3,
    CommandLine.arguments[2].range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { fail("Invalid request") }
let account = CommandLine.arguments[2]
let storage = envelopeURL()
var legacyQuery: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
    kSecUseDataProtectionKeychain as String: true
]
switch operation {
case "set":
    var data = FileHandle.standardInput.readData(ofLength: 4097)
    defer { data.resetBytes(in: 0..<data.count) }
    guard !data.isEmpty && data.count <= 4096 else { fail("Invalid key") }
    guard SecureEnclave.isAvailable else { fail("Secure Enclave is unavailable", code: "unavailable") }
    authorize(context, reason: "Kasa için Touch ID’yi etkinleştir")
    do {
        let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: protectedAccess(), authenticationContext: context)
        let envelope = try seal(data, key: key, account: account)
        // Verify the protected private operation before replacing an enrollment.
        var verified = try unwrap(envelope, context: context, account: account)
        defer { verified.resetBytes(in: 0..<verified.count) }
        guard verified == data else { fail("Enrollment verification failed", code: "secure-enclave-error") }
        try writeEnvelope(JSONEncoder().encode(envelope), to: storage)
    } catch { fail("Biometric enrollment could not be stored", code: authenticationCode(error)) }
case "get":
    if FileManager.default.fileExists(atPath: storage.path) {
        do {
            let envelope = try loadEnvelope(storage)
            var data = try unwrap(envelope, context: context, account: account)
            defer { data.resetBytes(in: 0..<data.count) }
            FileHandle.standardOutput.write(data)
        } catch {
            let code = error is DecodingError || error is CryptoKitError ? "invalid-key" : authenticationCode(error)
            fail("Biometric enrollment could not be opened", code: code)
        }
    } else {
        // Compatibility with signed builds that previously created a DP item.
        legacyQuery[kSecReturnData as String] = true
        legacyQuery[kSecMatchLimit as String] = kSecMatchLimitOne
        legacyQuery[kSecUseAuthenticationContext as String] = context
        var result: CFTypeRef?
        check(SecItemCopyMatching(legacyQuery as CFDictionary, &result))
        guard var data = result as? Data else { fail("Keychain returned no key", code: "invalid-key") }
        FileHandle.standardOutput.write(data)
        data.resetBytes(in: 0..<data.count)
    }
case "delete":
    do {
        if FileManager.default.fileExists(atPath: storage.path) { try FileManager.default.removeItem(at: storage) }
    } catch { fail("Biometric enrollment could not be removed", code: "storage-error") }
    let result = SecItemDelete(legacyQuery as CFDictionary)
    if result != errSecItemNotFound && result != errSecMissingEntitlement { check(result) }
default:
    fail("Invalid operation")
}
