# Code signing & notarization

InkCity's release pipeline produces installers for macOS and Windows. To ship
them without scary OS warnings, the binaries need to be **code-signed** (and on
macOS, **notarized**). This is separate from the **updater signature** described
below. Until you complete the steps here, releases still build and work — users
just see a one-time "unidentified developer" / "unknown publisher" warning.

## Three different signatures (don't confuse them)

| Signature | Purpose | Status |
|---|---|---|
| **Updater (minisign)** | Lets the in-app updater trust an update before installing it. | ✅ Already set up (`TAURI_SIGNING_PRIVATE_KEY`). Has nothing to do with the OS. |
| **macOS code signing + notarization** | Lets macOS Gatekeeper open the app without "Apple cannot check it for malicious software." | ⬜ Needs an Apple Developer account (below). |
| **Windows Authenticode** | Lets Windows SmartScreen run the installer without "Windows protected your PC / Unknown publisher." | ⬜ Needs a Windows code-signing certificate (below). |

The release workflow (`.github/workflows/release.yml`) is already wired for the
macOS env vars — it signs + notarizes **automatically** once the secrets exist,
and builds unsigned until then. Windows needs a small `tauri.conf.json` change,
documented below, once you have a certificate.

---

## macOS

### What you need

- An **Apple Developer Program** membership — **$99/year** (https://developer.apple.com/programs/).
- A **"Developer ID Application"** certificate (this is the cert type for apps
  distributed *outside* the Mac App Store).

### One-time setup

1. **Create the certificate.** In Xcode (Settings → Accounts → Manage
   Certificates → ➕ → "Developer ID Application"), or at
   https://developer.apple.com/account/resources/certificates. It installs into
   your login Keychain.

2. **Export it as `.p12`.** Keychain Access → find "Developer ID Application:
   …" → right-click → Export → `.p12`, set an export password (you'll need it).

3. **Base64-encode the `.p12`** for storing as a secret:
   ```bash
   base64 -i Certificates.p12 | pbcopy   # now on your clipboard
   ```

4. **Find your signing identity string:**
   ```bash
   security find-identity -v -p codesigning
   # → "Developer ID Application: Your Name (TEAMID)"
   ```
   `TEAMID` (the 10-char code in parentheses) is also your **Team ID**.

5. **Set up notarization credentials.** The simplest method is an
   **app-specific password**:
   - Go to https://appleid.apple.com → Sign-In and Security → App-Specific
     Passwords → generate one (e.g. labeled "inkcity-notarize").

### GitHub secrets to add

Repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | the base64 string from step 3 |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password from step 2 |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | your Apple ID email |
| `APPLE_PASSWORD` | the app-specific password from step 5 |
| `APPLE_TEAM_ID` | your 10-char Team ID |

That's it — the next tagged release will be signed and notarized. No code or
config changes are needed (InkCity sets the wallpaper via `NSWorkspace`, which
works fine under the Hardened Runtime that notarization requires, so no
entitlements file is necessary).

---

## Windows

Windows code-signing certificates can no longer be plain exportable `.pfx`
files for most CAs — since 2023 the private key must live on a hardware token
or a cloud HSM. For a solo developer the most practical option is:

### Recommended: Azure Trusted Signing (~$10/month)

Microsoft's cloud signing service. No hardware token; signs in CI. Requires
identity validation (an individual account needs a verifiable identity history).
See https://learn.microsoft.com/azure/trusted-signing/.

Once you have a Trusted Signing account, add a **`signCommand`** to
`src-tauri/tauri.conf.json` under `bundle.windows` (Tauri runs it per artifact,
substituting `%1` with the file path):

```jsonc
"bundle": {
  "windows": {
    "signCommand": {
      "cmd": "trusted-signing-cli",
      "args": ["-e", "https://<region>.codesigning.azure.net", "-a", "<account>", "-c", "<cert-profile>", "%1"]
    }
  }
}
```

and add Azure auth to the release workflow before the build step (using the
[`azure/trusted-signing-action`](https://github.com/Azure/trusted-signing-action)
or the `trusted-signing-cli`), with `AZURE_*` credentials stored as secrets.

### Alternative: OV / EV certificate

Buy an OV ("Organization Validation", ~$200/yr) or EV (instant SmartScreen
reputation, more expensive) certificate from a CA (Sectigo, DigiCert, SSL.com,
…). These ship on a token or cloud HSM (e.g. SSL.com eSigner, DigiCert
KeyLocker), which you then drive from CI via that provider's signing tool in the
same `signCommand` slot.

> SmartScreen reputation: with an **OV** cert the "unknown publisher" warning
> fades as downloads accumulate; an **EV** cert clears it immediately.

---

## Verifying a release

- **macOS:** download the `.dmg`, then
  ```bash
  spctl -a -vvv /Applications/InkCity.app   # should say "accepted / Notarized Developer ID"
  codesign -dv --verbose=4 /Applications/InkCity.app
  ```
- **Windows:** right-click the `.exe`/`.msi` → Properties → Digital Signatures
  tab should list your certificate.
- **Updater:** publish the draft release, then in the app (About → Check for
  updates) confirm it detects and installs the new version.
