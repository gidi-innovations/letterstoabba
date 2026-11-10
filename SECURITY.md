# How Letters to Abba protects letters

- A random 256-bit data key (AES-GCM) encrypts every letter, with a fresh 12-byte IV per save.
  Titles, text, dates, categories and statuses are all inside the ciphertext.
- The data key is stored only in wrapped (encrypted) form, twice:
  1. wrapped with a key derived from the passphrase (PBKDF2-SHA256, 310,000 iterations, random 16-byte salt)
  2. wrapped with a key derived from a 24-character random recovery key (about 120 bits)
- The unwrapped key lives in memory only while the journal is unlocked. The journal auto-locks after
  inactivity (1–30 min, default 5) and when the app is hidden for more than a minute.
- Data is kept in the browser's IndexedDB on the device. Nothing is sent anywhere; the page's
  Content-Security-Policy blocks connections to other sites, and all fonts are self-hosted.
- Backups (`.abba`) contain only the wrapped keys and ciphertext.

## Limits (be honest with users)
- If both the passphrase and the recovery key are lost, the letters cannot be recovered by anyone.
- Clearing browser data, uninstalling, or losing the device deletes the letters on it; backups protect against this.
- Whoever controls this GitHub repository could publish a modified version. Keep write access to trusted people only.
- A device that is already compromised (malware, keylogger) can see what the user types.
