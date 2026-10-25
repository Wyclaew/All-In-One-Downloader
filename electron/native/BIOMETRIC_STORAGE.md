# Touch ID storage and native verification

Updated 25 October 2026. The helper executable retains its `vault-keychain`
filename for package compatibility; new enrollments use CryptoKit Secure Enclave
keys, not generic-password items in the data-protection Keychain.

## Why the backend changed

The distributed helper is a non-bundled executable with an ad-hoc signature and
no provisioned Keychain access-group entitlement. Its LocalAuthentication
capability check can succeed while `SecItemAdd` with
`kSecUseDataProtectionKeychain=true` fails with `errSecMissingEntitlement`
(-34018). Sensor availability alone did not test whether enrollment could work.

Apple explains the signing requirement for command-line tools in
[SecItem pitfalls](https://developer.apple.com/forums/thread/724013), and the
meaning of -34018 in [Keychain entitlement troubleshooting](https://developer.apple.com/forums/thread/114456).

## New enrollment

- Create a fresh `SecureEnclave.P256.KeyAgreement.PrivateKey` with
  `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` and the combined
  `.privateKeyUsage` / `.biometryCurrentSet` access-control flags.
- Generate a transient software P-256 peer. Its ECDH secret with the Enclave
  public key, random 32-byte salt and account-bound HKDF-SHA256 yield a 32-byte
  wrapping key. AES-GCM seals the vault-key payload, authenticating the same
  profile/account context.
- Persist only the Enclave's **device-encrypted** `dataRepresentation`, the peer
  public key, salt, profile hash and sealed ciphertext. The software peer's
  private key is not persisted. The vault key is never put in a plaintext file,
  command argument or environment variable.
- Verify a protected ECDH+decrypt with the authenticated context before
  atomically replacing the enrollment file. The temporary file is created with
  exclusive/no-follow flags and mode0600, then synchronized and renamed.
- On unlock, restoring the device blob is insufficient: the actual Enclave
  ECDH operation must authorize the current biometric set before AES-GCM can
  decrypt. A mere successful app-level `evaluatePolicy` is not the security
  boundary.
- The only new artifact is `userData/vault/biometric-envelope.json`; it is not
  part of the JSON library backup. Deleting/disabling enrollment removes it.
  Password fallback, vault identity binding and lock-epoch checks remain.
- When no envelope exists, `get` can still read an old, legitimately signed
  installation's protected DP Keychain item. Missing-entitlement failures now
  explicitly direct password unlock and re-enrollment.

Apple documents [the Enclave key API and restoration initializer](https://developer.apple.com/documentation/cryptokit/secureenclave/p256/keyagreement/privatekey)
and [hardware private-key protection](https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave).

## Verification and limits

`vault-keychain status` never prompts or reads an enrollment. The explicit
`vault-keychain self-test` uses only newly created ephemeral keys and public
synthetic text. It verifies a real seal/unseal round trip, ciphertext-tamper
rejection, device-blob restoration, and denial of protected ECDH with
`LAContext.interactionNotAllowed=true`. No existing Keychain item, user vault or
stored biometric envelope is touched.

The unit/integration tests use mocked enrollment plus an isolated temporary
vault. Real successful enrollment and unlock with a human fingerprint remain a
manual acceptance step; passing the prompt-free native test is not a claim
that those user interactions were performed. Re-enrollment is available after
password unlock even when old metadata incorrectly says the enrollment is ready.
