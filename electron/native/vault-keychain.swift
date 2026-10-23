import Foundation
import Security
import LocalAuthentication

// The OS protects the item itself with the current biometric enrollment. An
// application-level prompt followed by an unprotected password read is weaker.
let service = "com.erne.allinonedownloader.vault"
func emit(_ value: [String: Any], to handle: FileHandle) {
    if let data = try? JSONSerialization.data(withJSONObject: value) { handle.write(data) }
}
func fail(_ message: String, code: String = "keychain-error") -> Never {
    emit(["code": code, "message": message], to: .standardError)
    exit(1)
}
func authenticationCode(_ error: Error?) -> String {
    guard let error = error as? LAError else { return "authentication-failed" }
    switch error.code {
    case .userCancel, .systemCancel, .appCancel, .userFallback: return "canceled"
    case .biometryNotEnrolled: return "not-enrolled"
    case .biometryLockout: return "locked-out"
    case .biometryNotAvailable: return "unavailable"
    case .notInteractive, .invalidContext: return "session-unavailable"
    default: return "authentication-failed"
    }
}
func check(_ status: OSStatus) {
    if status != errSecSuccess {
        let code: String
        switch status {
        case errSecUserCanceled: code = "canceled"
        case errSecItemNotFound: code = "key-missing"
        case errSecAuthFailed: code = "authentication-failed"
        case errSecInteractionNotAllowed: code = "session-unavailable"
        default: code = "keychain-error"
        }
        fail((SecCopyErrorMessageString(status, nil) as String?) ?? "Keychain error \(status)", code: code)
    }
}
guard CommandLine.arguments.count >= 2 else { fail("Invalid request") }
let operation = CommandLine.arguments[1]
let context = LAContext()
context.localizedReason = "Şifreli kasayı Touch ID ile aç"
context.localizedFallbackTitle = ""
if operation == "status" {
    // This is a capability check only: no prompt and no Keychain item access.
    // Never retain this result across authentication attempts; macOS enrollment
    // and sensor availability can change while the application is open.
    var error: NSError?
    let canEvaluate = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
    let status: String
    if canEvaluate && context.biometryType == .touchID { status = "available" }
    else {
        switch error?.code {
        case LAError.biometryNotEnrolled.rawValue: status = "not-enrolled"
        case LAError.biometryLockout.rawValue: status = "locked-out"
        default: status = "unavailable"
        }
    }
    emit(["available": status == "available", "status": status], to: .standardOutput)
    exit(0)
}
guard CommandLine.arguments.count == 3 else { fail("Invalid request") }
let account = CommandLine.arguments[2]
var query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
    kSecUseDataProtectionKeychain as String: true
]

switch operation {
case "set":
    var data = FileHandle.standardInput.readDataToEndOfFile()
    defer { data.resetBytes(in: 0..<data.count) }
    guard !data.isEmpty && data.count <= 4096 else { fail("Invalid key") }
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(nil,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .biometryCurrentSet, &error)
    else { fail("Biometric access control could not be created") }
    // Creation is explicitly authorized with biometrics as well as an unlocked
    // vault. The data never appears in process arguments or a plaintext file.
    let semaphore = DispatchSemaphore(value: 0)
    var authenticated = false
    var authenticationError: Error?
    context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
        localizedReason: "Kasa için Touch ID’yi etkinleştir") { success, error in
        authenticated = success
        authenticationError = error
        semaphore.signal()
    }
    semaphore.wait()
    guard authenticated else { fail("Touch ID doğrulaması tamamlanmadı.", code: authenticationCode(authenticationError)) }
    let deletion = SecItemDelete(query as CFDictionary)
    if deletion != errSecSuccess && deletion != errSecItemNotFound { check(deletion) }
    query[kSecAttrAccessControl as String] = access
    query[kSecValueData as String] = data
    query[kSecUseAuthenticationContext as String] = context
    check(SecItemAdd(query as CFDictionary, nil))
case "get":
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecUseAuthenticationContext as String] = context
    var result: CFTypeRef?
    check(SecItemCopyMatching(query as CFDictionary, &result))
    guard var data = result as? Data else { fail("Keychain returned no key") }
    FileHandle.standardOutput.write(data)
    data.resetBytes(in: 0..<data.count)
case "delete":
    let status = SecItemDelete(query as CFDictionary)
    if status != errSecItemNotFound { check(status) }
default:
    fail("Invalid operation")
}
