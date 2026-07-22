//! Chat message store and tri-net app-layer framing for clade-meshd.
//!
//! Implements the tri-net chat protocol envelope:
//!   [kind: u8][text_len: u8][text bytes]
//!
//! MSG_TEXT=0, MSG_PHOTO=1, MSG_VIDEO=2, MSG_VOICE=3, MSG_STATUS=4, MSG_ACK=5.
//! v1 supports text; media kinds are stored as placeholders for future chunks.
//!
//! phi^2 + phi^-2 = 3

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};

// Protocol constants from tri-net chat app-layer spec. v1 only uses text and
// status; media and ack kinds are reserved for future chunked transfers.
#[allow(dead_code)]
pub const MSG_TEXT: u8 = 0;
#[allow(dead_code)]
pub const MSG_PHOTO: u8 = 1;
#[allow(dead_code)]
pub const MSG_VIDEO: u8 = 2;
#[allow(dead_code)]
pub const MSG_VOICE: u8 = 3;
pub const MSG_STATUS: u8 = 4;
#[allow(dead_code)]
pub const MSG_ACK: u8 = 5;

pub const MAX_TEXT: usize = 200;
#[allow(dead_code)]
pub const MAX_CHUNK: usize = 1024;

/// A single chat message, stored per peer.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ChatMessage {
    pub id: u64,
    pub peer: u32,
    pub kind: u8,
    pub text: Option<String>,
    pub payload_base64: Option<String>,
    pub sent_at: u64,
    pub acked: bool,
    pub channel: char,
    pub is_outgoing: bool,
}

/// Conversation summary used by the Swift UI list.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct Conversation {
    pub peer: u32,
    pub last_message_id: u64,
    pub unread: usize,
    pub updated_at: u64,
}

/// On-disk snapshot of the chat store.
#[derive(Serialize, Deserialize, Debug, Default)]
struct StoredData {
    messages: HashMap<u32, Vec<ChatMessage>>,
    conversations: HashMap<u32, Conversation>,
    next_id: u64,
}

/// In-memory chat store with JSON persistence under `.trinity/mesh_chat/`.
pub struct MessageStore {
    messages: HashMap<u32, Vec<ChatMessage>>,
    conversations: HashMap<u32, Conversation>,
    next_id: AtomicU64,
    path: PathBuf,
}

impl MessageStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            messages: HashMap::new(),
            conversations: HashMap::new(),
            next_id: AtomicU64::new(1),
            path,
        }
    }

    /// Load persisted data if the store file exists. Failures are returned so
    /// the caller can decide whether to start fresh or abort.
    pub fn load(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        if !self.path.exists() {
            return Ok(());
        }
        let raw = std::fs::read_to_string(&self.path)?;
        if raw.trim().is_empty() {
            return Ok(());
        }
        let data: StoredData = serde_json::from_str(&raw)?;
        self.messages = data.messages;
        self.conversations = data.conversations;
        self.next_id = AtomicU64::new(data.next_id.max(1));
        Ok(())
    }

    /// Persist current state to disk. The parent directory is created on demand.
    pub fn save(&self) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let data = StoredData {
            messages: self.messages.clone(),
            conversations: self.conversations.clone(),
            next_id: self.next_id.load(Ordering::SeqCst),
        };
        let raw = serde_json::to_string_pretty(&data)?;
        std::fs::write(&self.path, raw)?;
        Ok(())
    }

    fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    pub fn messages_for(&self, peer: u32) -> &[ChatMessage] {
        self.messages
            .get(&peer)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    pub fn conversations(&self) -> Vec<Conversation> {
        let mut list: Vec<Conversation> = self.conversations.values().cloned().collect();
        list.sort_by_key(|a| std::cmp::Reverse(a.updated_at));
        list
    }

    pub fn poll_since(&self, since_id: u64) -> Vec<ChatMessage> {
        self.messages
            .values()
            .flat_map(|v| v.iter())
            .filter(|m| m.id > since_id)
            .cloned()
            .collect()
    }

    fn touch_conversation(&mut self, peer: u32, message_id: u64, now: u64, incoming: bool) {
        let entry = self
            .conversations
            .entry(peer)
            .or_insert_with(|| Conversation {
                peer,
                last_message_id: 0,
                unread: 0,
                updated_at: 0,
            });
        entry.last_message_id = message_id;
        entry.updated_at = now;
        if incoming {
            entry.unread += 1;
        }
    }

    /// Record an outgoing chat message after the crypto frame has been sealed.
    pub fn record_outgoing(
        &mut self,
        dst: u32,
        kind: u8,
        text: Option<String>,
        payload_base64: Option<String>,
        channel: char,
    ) -> Result<ChatMessage, Box<dyn std::error::Error>> {
        let now = now_secs()?;
        let id = self.next_id();
        let msg = ChatMessage {
            id,
            peer: dst,
            kind,
            text,
            payload_base64,
            sent_at: now,
            acked: false,
            channel,
            is_outgoing: true,
        };
        self.messages.entry(dst).or_default().push(msg.clone());
        self.touch_conversation(dst, id, now, false);
        self.save()?;
        Ok(msg)
    }

    /// Record an incoming chat frame that was successfully opened by the node.
    pub fn record_incoming(
        &mut self,
        src: u32,
        kind: u8,
        text: Option<String>,
        payload_base64: Option<String>,
        channel: char,
    ) -> Result<ChatMessage, Box<dyn std::error::Error>> {
        let now = now_secs()?;
        let id = self.next_id();
        let msg = ChatMessage {
            id,
            peer: src,
            kind,
            text,
            payload_base64,
            sent_at: now,
            acked: false,
            channel,
            is_outgoing: false,
        };
        self.messages.entry(src).or_default().push(msg.clone());
        self.touch_conversation(src, id, now, true);
        self.save()?;
        Ok(msg)
    }

    /// Mark all messages for a peer as acknowledged and clear unread count.
    pub fn ack_peer(&mut self, peer: u32) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(msgs) = self.messages.get_mut(&peer) {
            for m in msgs.iter_mut() {
                m.acked = true;
            }
        }
        if let Some(conv) = self.conversations.get_mut(&peer) {
            conv.unread = 0;
        }
        self.save()?;
        Ok(())
    }
}

/// Resolve an absolute store path from the environment or a default relative
/// to the current working directory. Callers are responsible for running from
/// a writable directory (e.g. the trios repo root).
#[allow(dead_code)]
pub fn default_store_path() -> PathBuf {
    std::env::var("TRIOS_MESH_CHAT_STORE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(".trinity/mesh_chat/clade_meshd_store.json"))
}

#[allow(dead_code)]
pub fn absolute_store_path() -> PathBuf {
    let p = default_store_path();
    if p.is_absolute() {
        return p;
    }
    std::env::current_dir()
        .map(|cwd| cwd.join(&p))
        .unwrap_or_else(|_| p)
}

fn now_secs() -> Result<u64, Box<dyn std::error::Error>> {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    Ok(secs)
}

/// Build a binary chat envelope. Text is encoded as
/// `[kind: u8][text_len: u8][text bytes]`. Media kinds in v1 are encoded the
/// same way with an optional caption.
pub fn encode_text_message(kind: u8, text: &str) -> Result<Vec<u8>, String> {
    let bytes = text.as_bytes();
    if bytes.len() > MAX_TEXT {
        return Err(format!("text too long: {} > {}", bytes.len(), MAX_TEXT));
    }
    let len = u8::try_from(bytes.len())
        .map_err(|_| format!("text length {} does not fit in u8", bytes.len()))?;
    let mut out = Vec::with_capacity(2 + bytes.len());
    out.push(kind);
    out.push(len);
    out.extend_from_slice(bytes);
    Ok(out)
}

/// Decode a chat envelope. Returns `(kind, text, raw_payload_base64)`.
/// For media kinds the text is treated as caption/placeholder.
pub fn decode_chat_payload(payload: &[u8]) -> Result<(u8, Option<String>, Option<String>), String> {
    if payload.len() < 2 {
        return Err(format!("chat payload too short: {} bytes", payload.len()));
    }
    let kind = payload[0];
    let len = payload[1] as usize;
    if payload.len() < 2 + len {
        return Err(format!(
            "chat payload truncated: expected {} bytes after header",
            len
        ));
    }
    let body = &payload[2..2 + len];
    let text =
        String::from_utf8(body.to_vec()).map_err(|_| "chat text is not valid utf-8".to_string())?;

    let payload_b64 = if payload.len() > 2 + len {
        Some(BASE64.encode(&payload[2 + len..]))
    } else {
        None
    };

    Ok((kind, Some(text), payload_b64))
}

/// Pick a traffic channel character based on the latest neighbor SNR/ETX.
/// This is a host-sim heuristic; real radios select T/P/V automatically.
pub fn channel_for_peer(state: &crate::MeshState) -> char {
    // The daemon currently tracks ETX, not SNR. Treat low ETX as good signal
    // (V = voice), moderate as P (photo), everything else as T (text).
    let node = &state.node;
    let best = node
        .etx
        .neighbors()
        .iter()
        .map(|(_, etx)| *etx)
        .fold(f32::INFINITY, f32::min);
    if best <= 1.2 {
        'V'
    } else if best <= 2.0 {
        'P'
    } else {
        'T'
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_decode_round_trip() -> Result<(), Box<dyn std::error::Error>> {
        let payload = encode_text_message(MSG_TEXT, "hello mesh")?;
        let (kind, text, extra) = decode_chat_payload(&payload)?;
        assert_eq!(kind, MSG_TEXT);
        assert_eq!(text, Some("hello mesh".to_string()));
        assert_eq!(extra, None);
        Ok(())
    }

    #[test]
    fn rejects_long_text() {
        let big = "x".repeat(MAX_TEXT + 1);
        assert!(encode_text_message(MSG_TEXT, &big).is_err());
    }

    #[test]
    fn store_round_trip_persist() -> Result<(), Box<dyn std::error::Error>> {
        let dir = std::env::temp_dir().join(format!("clade-meshd-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("store.json");
        {
            let mut store = MessageStore::new(path.clone());
            let out = store.record_outgoing(7, MSG_TEXT, Some("hi".into()), None, 'T')?;
            assert!(out.is_outgoing);
            let inc = store.record_incoming(7, MSG_TEXT, Some("ack".into()), None, 'T')?;
            assert!(!inc.is_outgoing);
            assert_eq!(store.conversations().len(), 1);
            assert_eq!(store.conversations()[0].unread, 1);
        }
        {
            let mut store = MessageStore::new(path.clone());
            store.load()?;
            assert_eq!(store.messages_for(7).len(), 2);
            store.ack_peer(7)?;
            assert_eq!(store.conversations()[0].unread, 0);
        }
        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
    }
}
