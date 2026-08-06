//! The updater's biting tests — the deliverable, not the feature.
//!
//! An updater fetches and runs new code, so the two failures that matter are a
//! TAMPERED payload being installed and a DOWNGRADE being installed. Both are
//! proven here by watching the refusal happen, not by trusting that a library
//! would refuse: a guard nobody has seen go red is not evidence.
//!
//! `tampered_payload_is_refused` reproduces exactly what `tauri-plugin-updater`
//! does at download time — unwrap tauri's base64 envelope, hand the inner
//! minisign bytes to `minisign-verify`, verify against the SAME public key that
//! ships in `tauri.conf.json` — over a committed fixture signed with the SAME
//! private key now held in `~/.ohmail/secrets.env`. It exercises the signature
//! layer and the real key material; it does not drive the plugin's HTTP path.
//!
//! `downgrade_is_refused` drives `should_offer`, the version gate the install
//! path actually calls, table-driven across the boundary cases.

use super::should_offer;
use base64::Engine as _;
use std::fs;
use std::path::PathBuf;

const BASE64: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::STANDARD;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn fixtures_dir() -> PathBuf {
    manifest_dir().join("../test/fixtures/updater")
}

/// The public key exactly as the client trusts it: read from the shipped
/// `tauri.conf.json` so the test breaks if the committed key is ever changed
/// without re-signing the fixture. Same targeted scan as `build.rs`.
fn shipped_pubkey() -> String {
    let conf = fs::read_to_string(manifest_dir().join("tauri.conf.json")).unwrap();
    let needle = "\"pubkey\"";
    let start = conf.find(needle).unwrap() + needle.len();
    let rest = &conf[start..];
    let colon = rest.find(':').unwrap();
    let after = &rest[colon + 1..];
    let open = after.find('"').unwrap();
    let value = &after[open + 1..];
    let close = value.find('"').unwrap();
    value[..close].to_string()
}

/// tauri wraps both the public key and the signature as base64 over the whole
/// minisign file text; unwrap that and parse the minisign content.
fn minisign_public_key() -> minisign_verify::PublicKey {
    let text = String::from_utf8(BASE64.decode(shipped_pubkey().trim()).unwrap()).unwrap();
    minisign_verify::PublicKey::decode(&text).unwrap()
}

fn minisign_signature(sig_b64: &str) -> minisign_verify::Signature {
    let text = String::from_utf8(BASE64.decode(sig_b64.trim()).unwrap()).unwrap();
    minisign_verify::Signature::decode(&text).unwrap()
}

#[test]
fn valid_payload_is_accepted() {
    // The positive control. If this cannot pass, the negative result below
    // proves nothing — it might be refusing everything.
    let pk = minisign_public_key();
    let payload = fs::read(fixtures_dir().join("payload.bin")).unwrap();
    let sig_b64 = fs::read_to_string(fixtures_dir().join("payload.bin.sig")).unwrap();
    let sig = minisign_signature(&sig_b64);

    assert!(
        pk.verify(&payload, &sig, true).is_ok(),
        "the committed signature must verify against the shipped public key — \
         if it does not, the pubkey in tauri.conf.json and the fixture signature disagree"
    );
}

#[test]
fn tampered_payload_is_refused() {
    // Sign an archive, corrupt one byte, watch the verification refuse. This is
    // the RCE surface: a payload that does not match its signature must never be
    // accepted for install.
    let pk = minisign_public_key();
    let payload = fs::read(fixtures_dir().join("payload.bin")).unwrap();
    let sig_b64 = fs::read_to_string(fixtures_dir().join("payload.bin.sig")).unwrap();
    let sig = minisign_signature(&sig_b64);

    // One byte, flipped — the smallest possible tamper.
    let mut tampered = payload.clone();
    tampered[0] ^= 0x01;
    assert_ne!(tampered, payload, "the tamper must actually change the bytes");

    assert!(
        pk.verify(&tampered, &sig, true).is_err(),
        "a one-byte-tampered payload MUST be refused — the updater would otherwise \
         install whatever a MITM or a compromised feed served"
    );
}

#[test]
fn downgrade_is_refused() {
    // The version gate `prompt_and_install` calls before it installs anything.
    // Table-driven across the boundary cases; bare semver, no `-preview` left to
    // make the ordering subtle.
    let cases: &[(&str, &str, bool)] = &[
        // installed, candidate, may we offer it?
        ("0.5.0", "0.5.0", false), // the same release — never an update
        ("0.5.0", "0.5.1", true),  // patch newer
        ("0.5.0", "0.6.0", true),  // minor newer
        ("0.5.0", "1.0.0", true),  // major newer
        ("0.6.0", "0.5.0", false), // a downgrade — refused
        ("0.5.1", "0.5.0", false), // a patch downgrade — refused
        ("1.0.0", "0.9.9", false), // a major downgrade — refused
    ];
    for &(installed, candidate, expected) in cases {
        let got = should_offer(
            &semver::Version::parse(installed).unwrap(),
            &semver::Version::parse(candidate).unwrap(),
        );
        assert_eq!(
            got, expected,
            "should_offer(installed={installed}, candidate={candidate}) expected {expected}"
        );
    }
}
