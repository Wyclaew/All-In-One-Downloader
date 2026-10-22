import Foundation
import Security
import LocalAuthentication

// The OS protects the item itself with the current biometric enrollment. An
// application-level prompt followed by an unprotected password read is weaker.
let service = "com.erne.allinonedownloader.vault"
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data(message.utf8))
    exit(1)
}
func check(_ status: OSStatus) {
    if status != errSecSuccess {
        fail((SecCopyErrorMessageString(status, nil) as String?) ?? "Keychain error \(status)")
    }
}
guard CommandLine.arguments.count == 3 else { fail("Invalid request") }
let operation = CommandLine.arguments[1]
let account = CommandLine.arguments[2]
let context = LAContext()
context.localizedReason = "Şifreli kasayı Touch ID ile aç"
context.localizedFallbackTitle = ""
var query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
    kSecUseDataProtectionKeychain as String: true
]

switch operation {
case "set":
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard !data.isEmpty && data.count <= 4096 else { fail("Invalid key") }
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(nil,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .biometryCurrentSet, &error)
    else { fail("Biometric access control could not be created") }
    // Creation is explicitly authorized with biometrics as well as an unlocked
    // vault. The data never appears in process arguments or a plaintext file.
    let semaphore = DispatchSemaphore(value: 0)
    var authenticated = false
    context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
        localizedReason: "Kasa için Touch ID’yi etkinleştir") { success, _ in
        authenticated = success
        semaphore.signal()
    }
    semaphore.wait()
    guard authenticated else { fail("Touch ID doğrulaması tamamlanmadı.") }
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
    guard let data = result as? Data else { fail("Keychain returned no key") }
    FileHandle.standardOutput.write(data)
case "delete":
    let status = SecItemDelete(query as CFDictionary)
    if status != errSecItemNotFound { check(status) }
default:
    fail("Invalid operation")
}
