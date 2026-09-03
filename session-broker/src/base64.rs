//! Standard base64 (RFC 4648, padded) for the bytes that cross the wire.
//!
//! serde encodes a `Vec<u8>` as a JSON array of numbers — `[27,91,51,49,109]` — which is three to
//! four characters per byte and has to be parsed number by number on the other side. Terminal
//! output is the hot path of this whole product, and it crossed the socket that way, then crossed
//! the webview boundary that way again. Base64 is a third larger than the bytes and decodes in one
//! pass. No dependency: the alphabet is thirty lines, and the tests below pin it.

use serde::{Deserialize, Deserializer, Serializer};

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        out.push(ALPHABET[(b0 >> 2) as usize] as char);
        out.push(ALPHABET[(((b0 & 0b11) << 4) | (b1 >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(((b1 & 0b1111) << 2) | (b2 >> 6)) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(b2 & 0b11_1111) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Decodes padded or unpadded input; anything outside the alphabet is an error, never silently
/// skipped, because a corrupt frame must fail loudly rather than feed garbage to a terminal.
pub fn decode(text: &str) -> Result<Vec<u8>, String> {
    let raw = text.as_bytes();
    let trimmed = raw.iter().rposition(|&c| c != b'=').map_or(0, |i| i + 1);
    let body = &raw[..trimmed];
    if raw.len() - trimmed > 2 {
        return Err("base64: too much padding".into());
    }
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for &c in body {
        let value = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            other => return Err(format!("base64: invalid character {:?}", other as char)),
        };
        acc = (acc << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    if body.len() % 4 == 1 {
        return Err("base64: truncated input".into());
    }
    Ok(out)
}

pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&encode(bytes))
}

pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
    let text = String::deserialize(deserializer)?;
    decode(&text).map_err(serde::de::Error::custom)
}

#[cfg(test)]
mod tests {
    use super::{decode, encode};

    #[test]
    fn matches_the_rfc_4648_vectors() {
        let vectors: [(&[u8], &str); 7] = [
            (b"", ""),
            (b"f", "Zg=="),
            (b"fo", "Zm8="),
            (b"foo", "Zm9v"),
            (b"foob", "Zm9vYg=="),
            (b"fooba", "Zm9vYmE="),
            (b"foobar", "Zm9vYmFy"),
        ];
        for (bytes, text) in vectors {
            assert_eq!(encode(bytes), text);
            assert_eq!(decode(text).expect("decode"), bytes);
        }
    }

    #[test]
    fn every_byte_value_survives_a_round_trip() {
        let all: Vec<u8> = (0..=255).collect();
        let mut long = all.clone();
        long.extend_from_slice(&all);
        long.push(0x1b);
        for sample in [all, long, vec![0x1b, b'[', b'3', b'1', b'm']] {
            assert_eq!(decode(&encode(&sample)).expect("decode"), sample);
        }
    }

    #[test]
    fn unpadded_input_decodes_and_garbage_is_refused() {
        assert_eq!(decode("Zm9vYg").expect("unpadded"), b"foob");
        assert!(decode("Zm9v!").is_err());
        assert!(decode("Z").is_err());
        assert!(decode("Zg===").is_err());
    }

    #[test]
    fn serde_carries_bytes_as_one_string_not_an_array() {
        #[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
        struct Frame {
            #[serde(with = "super")]
            bytes: Vec<u8>,
        }
        let frame = Frame {
            bytes: b"\x1b[31mred\x1b[0m".to_vec(),
        };
        let json = serde_json::to_string(&frame).expect("encode");
        assert_eq!(json, r#"{"bytes":"G1szMW1yZWQbWzBt"}"#);
        assert_eq!(serde_json::from_str::<Frame>(&json).expect("decode"), frame);
    }
}
