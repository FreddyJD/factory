use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use std::{error::Error, fs};

fn verify(data: &[u8], key: &str, signature: &str, version: &str) -> Result<(), Box<dyn Error>> {
    let key = String::from_utf8(STANDARD.decode(key.trim())?)?;
    let signature = String::from_utf8(STANDARD.decode(signature.trim())?)?;
    let signature = Signature::decode(&signature)?;
    PublicKey::decode(&key)?.verify(data, &signature, true)?;
    let signed_version = signature
        .trusted_comment()
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"));
    if signed_version != Some(version) {
        return Err("artifact signature does not match the announced version".into());
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 3 {
        return Err("usage: verify-update INSTALLER SIGNATURE VERSION".into());
    }
    let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))?;
    let key = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .ok_or("missing embedded updater key")?;
    verify(
        &fs::read(&args[0])?,
        key,
        &fs::read_to_string(&args[1])?,
        &args[2],
    )?;
    println!("Installer signature and version verified against the embedded public key.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Public test vectors from tauri-plugin-updater 2.14.1 (MIT/Apache-2.0).
    const KEY: &str = "untrusted comment: minisign public key: A49EF4746FA6E6D7\nRWTX5qZvdPSepDGWg2bz8n6ArQnBMwgQK1geVosorcbLzcunD+KJ+cYe";
    const SIGNATURE: &str = "untrusted comment: signature from tauri secret key\nRUTX5qZvdPSepPF2zsjvP/L/TQtBLRnWRvaq+4omK1UEugtQp/USrGiI1v762sDy3id3aor7bRC9ETyeot6lMHHrWoZ5hjUM1Qc=\ntrusted comment: timestamp:1791649051\tfile:payload\tversion:2.0.0\nDDq2CLOEl5cQmC2eJRHlnZPVViOZsu1CjpPKQoei4A/XBfkDqGO0B+QMrcrHgEQ5qV3mne75tdFWhJpqUXh9AA==";

    #[test]
    fn accepts_the_signed_payload_and_version() {
        assert!(verify(
            b"test",
            &STANDARD.encode(KEY),
            &STANDARD.encode(SIGNATURE),
            "2.0.0"
        )
        .is_ok());
    }

    #[test]
    fn rejects_tampered_payload_or_announced_version() {
        let key = STANDARD.encode(KEY);
        let signature = STANDARD.encode(SIGNATURE);
        assert!(verify(b"modified", &key, &signature, "2.0.0").is_err());
        assert!(verify(b"test", &key, &signature, "3.0.0").is_err());
    }

    #[test]
    fn rejects_a_different_signing_key() {
        let other_key = "untrusted comment: other public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
        assert!(verify(
            b"test",
            &STANDARD.encode(other_key),
            &STANDARD.encode(SIGNATURE),
            "2.0.0"
        )
        .is_err());
    }
}
