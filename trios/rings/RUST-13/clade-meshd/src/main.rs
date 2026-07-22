//! HTTP control daemon for trios-mesh.
//!
//! Exposes node status, ETX routing, and crypto diagnostics to the Trios UI
//! via a small warp REST API. Runs entirely in host-sim mode (no radio/TUN).
//!
//! phi^2 + phi^-2 = 3

mod chat;
mod key_store;
mod transport;

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::sync::RwLock;
use warp::{reply::json, Filter};

use trios_mesh::crypto::StaticKey;
use trios_mesh::daemon::{Node, Transport};
use trios_mesh::discovery::Hello;
use trios_mesh::NodeId;

const DEFAULT_PORT: u16 = 9505;
const ETX_WINDOW: usize = 16;

/// Global node state protected by a read-write lock.
struct MeshState {
    node: Node,
    /// This node's long-term static identity key.
    my_key: StaticKey,
    /// Derived public keys for any peers we have seeded.
    peer_keys: HashMap<NodeId, Vec<u8>>,
    /// Chat message and conversation store.
    store: chat::MessageStore,
    /// Channel to the UDP send task.
    udp_outbound: mpsc::UnboundedSender<(SocketAddr, Vec<u8>)>,
    /// Seeded UDP address for each peer.
    peer_addrs: HashMap<NodeId, SocketAddr>,
    /// Reverse lookup from UDP address to peer id.
    addr_to_peer: HashMap<SocketAddr, NodeId>,
    /// Per-peer transport pipe.
    transports: HashMap<NodeId, Box<dyn Transport + Send + Sync>>,
}

impl MeshState {
    fn new(id: NodeId, my_key: StaticKey, udp: &transport::UdpIo) -> Self {
        let path = chat::absolute_store_path();
        Self {
            node: Node::new(id, ETX_WINDOW),
            my_key,
            peer_keys: HashMap::new(),
            store: chat::MessageStore::new(path),
            udp_outbound: udp.outbound.clone(),
            peer_addrs: HashMap::new(),
            addr_to_peer: HashMap::new(),
            transports: HashMap::new(),
        }
    }

    #[cfg(test)]
    fn new_with_store(
        id: NodeId,
        my_key: StaticKey,
        path: std::path::PathBuf,
        udp: &transport::UdpIo,
    ) -> Self {
        Self {
            node: Node::new(id, ETX_WINDOW),
            my_key,
            peer_keys: HashMap::new(),
            store: chat::MessageStore::new(path),
            udp_outbound: udp.outbound.clone(),
            peer_addrs: HashMap::new(),
            addr_to_peer: HashMap::new(),
            transports: HashMap::new(),
        }
    }
}

#[derive(Serialize, Debug, Clone)]
struct HealthResponse {
    status: String,
    node_id: NodeId,
}

#[derive(Serialize, Debug, Clone)]
struct StatusResponse {
    node_id: NodeId,
    neighbors: Vec<NeighborStatus>,
    routes: Vec<RouteStatus>,
    sessions: Vec<SessionStatus>,
    metrics: MetricSnapshot,
}

#[derive(Serialize, Debug, Clone)]
struct NeighborStatus {
    id: NodeId,
    etx: f32,
    etx_label: String,
}

#[derive(Serialize, Debug, Clone)]
struct RouteStatus {
    destination: NodeId,
    next_hop: Option<NodeId>,
    path_etx: Option<f32>,
}

#[derive(Serialize, Debug, Clone)]
struct SessionStatus {
    peer: NodeId,
    has_session: bool,
}

#[derive(Serialize, Debug, Clone)]
struct MetricSnapshot {
    link_loss_to_reroute_ms: Option<f32>,
    node_off_to_reroute_ms: Option<f32>,
}

#[derive(Deserialize, Debug, Clone)]
struct ObserveRequest {
    peer: NodeId,
    we_heard: bool,
    they_heard: bool,
}

#[derive(Deserialize, Debug, Clone)]
struct HelloRequest {
    peer: NodeId,
    seq: u32,
    heard: Vec<NodeId>,
}

#[derive(Deserialize, Debug, Clone)]
struct SendRequest {
    dst: NodeId,
    payload: String, // base64
}

#[derive(Serialize, Debug, Clone)]
struct SendResponse {
    frame: String, // base64
}

#[derive(Deserialize, Debug, Clone)]
struct OpenRequest {
    src: NodeId,
    frame: String, // base64
}

#[derive(Serialize, Debug, Clone)]
struct OpenResponse {
    payload: String, // base64
}

#[derive(Deserialize, Debug, Clone)]
struct PeerRequest {
    peer: NodeId,
}

#[derive(Deserialize, Debug, Clone)]
struct SeedPeerRequest {
    peer: NodeId,
    /// Base64-encoded X25519 public key of the peer.
    public_key: String,
    /// Optional UDP address for sealed frame transport, e.g. "127.0.0.1:9602".
    address: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
struct ChatSendRequest {
    dst: u32,
    kind: u8,
    text: Option<String>,
    payload_base64: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
struct ChatSendResponse {
    id: u64,
    frame: String,
    queued: bool,
}

#[derive(Deserialize, Debug, Clone)]
struct ChatReceiveRequest {
    src: u32,
    frame: String,
}

#[derive(Serialize, Debug, Clone)]
struct ChatReceiveResponse {
    id: u64,
    kind: u8,
    text: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
struct ChatAckRequest {
    peer: u32,
}

#[derive(Serialize, Debug, Clone)]
struct ChatMessagesResponse {
    peer: u32,
    messages: Vec<chat::ChatMessage>,
}

#[derive(Serialize, Debug, Clone)]
struct ChatPollResponse {
    messages: Vec<chat::ChatMessage>,
    conversations: Vec<chat::Conversation>,
}

#[derive(Deserialize, Debug, Clone)]
struct SinceIdQuery {
    since_id: u64,
}

fn port() -> u16 {
    std::env::var("TRIOS_MESH_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

fn udp_bind_addr(node_id: NodeId) -> SocketAddr {
    std::env::var("TRIOS_MESH_UDP_BIND")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| {
            let port = (9600u32 + node_id as u32).min(u16::MAX as u32) as u16;
            SocketAddr::from(([127, 0, 0, 1], port))
        })
}

/// Process incoming UDP frames: map source address -> peer, open, decode, store.
async fn run_frame_processor(
    state: Arc<RwLock<MeshState>>,
    mut frames: mpsc::UnboundedReceiver<(SocketAddr, Vec<u8>)>,
) {
    while let Some((addr, raw_frame)) = frames.recv().await {
        let mut guard = state.write().await;
        let src = match guard.addr_to_peer.get(&addr).copied() {
            Some(id) => id,
            None => continue,
        };

        let payload = match guard.node.open_data(src, &raw_frame) {
            Ok(p) => p,
            Err(_) => continue,
        };

        let (kind, text, payload_b64) = match chat::decode_chat_payload(&payload) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let channel = chat::channel_for_peer(&*guard);
        let _ = guard.store.record_incoming(src, kind, text, payload_b64, channel);
    }
}

fn with_state(
    state: Arc<RwLock<MeshState>>,
) -> impl Filter<Extract = (Arc<RwLock<MeshState>>,), Error = Infallible> + Clone {
    warp::any().map(move || state.clone())
}

fn format_etx(etx: f32) -> String {
    if etx.is_infinite() {
        "dead".to_string()
    } else if etx <= 1.0 {
        "perfect".to_string()
    } else if etx <= 2.0 {
        "good".to_string()
    } else if etx <= 4.0 {
        "fair".to_string()
    } else {
        "poor".to_string()
    }
}

async fn health_handler(state: Arc<RwLock<MeshState>>) -> Result<impl warp::Reply, Infallible> {
    let state = state.read().await;
    Ok(json(&HealthResponse {
        status: "ok".to_string(),
        node_id: state.node.id,
    }))
}

async fn status_handler(state: Arc<RwLock<MeshState>>) -> Result<impl warp::Reply, Infallible> {
    let state = state.read().await;
    let node = &state.node;

    let neighbors = node
        .etx
        .neighbors()
        .iter()
        .map(|(id, etx)| NeighborStatus {
            id: *id,
            etx: *etx,
            etx_label: format_etx(*etx),
        })
        .collect();

    let routes = node
        .etx
        .path_routes()
        .iter()
        .map(|(dst, nh, etx)| RouteStatus {
            destination: *dst,
            next_hop: Some(*nh),
            path_etx: Some(*etx),
        })
        .collect();

    let sessions = state
        .peer_keys
        .keys()
        .map(|peer| SessionStatus {
            peer: *peer,
            has_session: node.has_session(*peer),
        })
        .collect();

    let metrics = MetricSnapshot {
        link_loss_to_reroute_ms: node.metrics.link_loss_to_reroute_ms,
        node_off_to_reroute_ms: node.metrics.node_off_to_reroute_ms,
    };

    Ok(json(&StatusResponse {
        node_id: node.id,
        neighbors,
        routes,
        sessions,
        metrics,
    }))
}

async fn observe_handler(
    req: ObserveRequest,
    state: Arc<RwLock<MeshState>>,
) -> Result<impl warp::Reply, Infallible> {
    let mut state = state.write().await;
    state
        .node
        .etx
        .record(req.peer, req.we_heard, req.they_heard);
    Ok(json(&serde_json::json!({ "ok": true })))
}

async fn hello_handler(
    req: HelloRequest,
    state: Arc<RwLock<MeshState>>,
) -> Result<impl warp::Reply, Infallible> {
    let mut state = state.write().await;
    let my_id = state.node.id;
    let hello = match Hello::authenticated(req.peer, req.seq, req.heard, &None) {
        Ok(h) => h,
        Err(_) => {
            return Ok(warp::reply::with_status(
                json(&serde_json::json!({"error": "hello mac failed"})),
                warp::http::StatusCode::INTERNAL_SERVER_ERROR,
            ))
        }
    };
    let heard_us = hello.reports_hearing(my_id);
    // Update ETX as if we heard the peer and the peer does not hear us yet.
    // A real implementation would parse the HELLO MAC and reverse-link quality.
    state.node.etx.record(req.peer, true, heard_us);
    Ok(warp::reply::with_status(
        json(&serde_json::json!({
            "ok": true,
            "peer": req.peer,
            "heard_us": heard_us
        })),
        warp::http::StatusCode::OK,
    ))
}

async fn send_handler(
    req: SendRequest,
    state: Arc<RwLock<MeshState>>,
) -> Result<impl warp::Reply, Infallible> {
    let payload = match BASE64.decode(&req.payload) {
        Ok(p) => p,
        Err(_) => {
            return Ok(warp::reply::with_status(
                json(&serde_json::json!({"error": "invalid base64 payload"})),
                warp::http::StatusCode::BAD_REQUEST,
            ))
        }
    };

    let mut state = state.write().await;
    let ttl = 8; // DEFAULT_TTL is private in router.rs; mirror it here.
    match state.node.seal_data(req.dst, ttl, &payload) {
        Some(frame) => Ok(warp::reply::with_status(
            json(&SendResponse {
                frame: BASE64.encode(&frame),
            }),
            warp::http::StatusCode::OK,
        )),
        None => Ok(warp::reply::with_status(
            json(&serde_json::json!({
                "error": "no session or seal failed"
            })),
            warp::http::StatusCode::SERVICE_UNAVAILABLE,
        )),
    }
}

async fn open_handler(
    req: OpenRequest,
    state: Arc<RwLock<MeshState>>,
) -> Result<impl warp::Reply, Infallible> {
    let frame = match BASE64.decode(&req.frame) {
        Ok(f) => f,
        Err(_) => {
            return Ok(warp::reply::with_status(
                json(&serde_json::json!({"error": "invalid base64 frame"})),
                warp::http::StatusCode::BAD_REQUEST,
            ))
        }
    };

    let mut state = state.write().await;
    match state.node.open_data(req.src, &frame) {
        Ok(payload) => Ok(warp::reply::with_status(
            json(&OpenResponse {
                payload: BASE64.encode(&payload),
            }),
            warp::http::StatusCode::OK,
        )),
        Err(e) => Ok(warp::reply::with_status(
            json(&serde_json::json!({ "error": format!("{:?}", e) })),
            warp::http::StatusCode::UNAUTHORIZED,
        )),
    }
}

async fn force_dead_handler(
    req: PeerRequest,
    state: Arc<RwLock<MeshState>>,
) -> Result<impl warp::Reply, Infallible> {
    let mut state = state.write().await;
    state.node.etx.force_dead(req.peer);
    state.node.on_link_loss_detected();
    state.node.on_reroute_completed();
    Ok(json(&serde_json::json!({ "ok": true, "peer": req.peer })))
}

fn peer_addr_from_env_or_req(req: &SeedPeerRequest) -> Option<SocketAddr> {
    req.address
        .as_deref()
        .and_then(|s| s.parse().ok())
        .or_else(|| {
            std::env::var(format!("TRIOS_MESH_PEER_ADDR_{}", req.peer))
                .ok()
                .and_then(|s| s.parse().ok())
        })
}

async fn seed_peer_handler(
    req: SeedPeerRequest,
    state: Arc<RwLock<MeshState>>,
) -> Result<impl warp::Reply, Infallible> {
    let peer_key = match key_store::decode_public_key(&req.public_key) {
        Ok(k) => k,
        Err(e) => {
            return Ok(warp::reply::with_status(
                json(&serde_json::json!({"error": e})),
                warp::http::StatusCode::BAD_REQUEST,
            ))
        }
    };
    let peer_bytes = peer_key.to_bytes();

    let mut state = state.write().await;
    let session = match state.my_key.session_with(&peer_key, state.node.id < req.peer) {
        Ok(s) => s,
        Err(_) => {
            return Ok(warp::reply::with_status(
                json(&serde_json::json!({"error": "session derivation failed"})),
                warp::http::StatusCode::INTERNAL_SERVER_ERROR,
            ))
        }
    };
    state.node.add_session(req.peer, session);
    state.peer_keys.insert(req.peer, peer_bytes.to_vec());

    if let Some(addr) = peer_addr_from_env_or_req(&req) {
        state.peer_addrs.insert(req.peer, addr);
        state.addr_to_peer.insert(addr, req.peer);
        let transport = transport::UdpTransport::new(state.udp_outbound.clone(), addr);
        state.transports.insert(req.peer, Box::new(transport));
    }

    Ok(warp::reply::with_status(
        json(&serde_json::json!({
            "ok": true,
            "peer": req.peer,
            "public_key": BASE64.encode(peer_bytes)
        })),
        warp::http::StatusCode::OK,
    ))
}

async fn link_loss_handler(state: Arc<RwLock<MeshState>>) -> Result<impl warp::Reply, Infallible> {
    let mut state = state.write().await;
    state.node.on_link_loss_detected();
    Ok(json(&serde_json::json!({ "ok": true })))
}

async fn reroute_handler(state: Arc<RwLock<MeshState>>) -> Result<impl warp::Reply, Infallible> {
    let mut state = state.write().await;
    state.node.on_reroute_completed();
    Ok(json(&serde_json::json!({ "ok": true })))
}

fn chat_error(
    msg: &str,
    code: warp::http::StatusCode,
) -> Result<warp::reply::WithStatus<warp::reply::Json>, Infallible> {
    Ok(warp::reply::with_status(
        json(&serde_json::json!({ "error": msg })),
        code,
    ))
}

fn build_envelope(req: &ChatSendRequest) -> Result<Vec<u8>, String> {
    let text = req.text.as_deref().unwrap_or("");
    if req.kind == chat::MSG_TEXT && req.text.is_none() {
        return Err("text messages require a text field".to_string());
    }
    if req.kind == chat::MSG_TEXT {
        chat::encode_text_message(req.kind, text)
    } else {
        // Media / status / ack: envelope is [kind][caption_len][caption?][payload?].
        let caption_bytes = text.as_bytes();
        if caption_bytes.len() > chat::MAX_TEXT {
            return Err(format!(
                "caption too long: {} > {}",
                caption_bytes.len(),
                chat::MAX_TEXT
            ));
        }
        let len = u8::try_from(caption_bytes.len())
            .map_err(|_| format!("caption length {} does not fit in u8", caption_bytes.len()))?;
        let payload = req
            .payload_base64
            .as_ref()
            .map(|b| BASE64.decode(b))
            .transpose()
            .map_err(|_| "invalid payload_base64".to_string())?
            .unwrap_or_default();
        let mut out = Vec::with_capacity(2 + caption_bytes.len() + payload.len());
        out.push(req.kind);
        out.push(len);
        out.extend_from_slice(caption_bytes);
        out.extend_from_slice(&payload);
        Ok(out)
    }
}

async fn chat_send_handler(
    req: ChatSendRequest,
    state: Arc<RwLock<MeshState>>,
) -> Result<impl warp::Reply, Infallible> {
    let envelope = match build_envelope(&req) {
        Ok(e) => e,
        Err(e) => return chat_error(&e, warp::http::StatusCode::BAD_REQUEST),
    };

    let mut state = state.write().await;
    let ttl = 8;
    let frame = match state.node.seal_data(req.dst, ttl, &envelope) {
        Some(f) => f,
        None => {
            return chat_error(
                "no session or seal failed",
                warp::http::StatusCode::SERVICE_UNAVAILABLE,
            )
        }
    };

    let channel = chat::channel_for_peer(&state);
    let msg = match state.store.record_outgoing(
        req.dst,
        req.kind,
        req.text.clone(),
        req.payload_base64.clone(),
        channel,
    ) {
        Ok(m) => m,
        Err(e) => {
            return chat_error(
                &format!("store error: {e}"),
                warp::http::StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    let queued = state
        .transports
        .get_mut(&req.dst)
        .map(|t| t.send(&frame).is_ok())
        .unwrap_or(false);

    Ok(warp::reply::with_status(
        json(&ChatSendResponse {
            id: msg.id,
            frame: BASE64.encode(&frame),
            queued,
        }),
        warp::http::StatusCode::OK,
    ))
}

async fn chat_receive_handler(
    req: ChatReceiveRequest,
    state: Arc<RwLock<MeshState>>,
) -> Result<impl warp::Reply, Infallible> {
    let frame = match BASE64.decode(&req.frame) {
        Ok(f) => f,
        Err(_) => return chat_error("invalid base64 frame", warp::http::StatusCode::BAD_REQUEST),
    };

    let mut state = state.write().await;
    let payload = match state.node.open_data(req.src, &frame) {
        Ok(p) => p,
        Err(e) => return chat_error(&format!("{:?}", e), warp::http::StatusCode::UNAUTHORIZED),
    };

    let (kind, text, payload_b64) = match chat::decode_chat_payload(&payload) {
        Ok(v) => v,
        Err(_) => {
            // Not a chat envelope; ignore silently so generic data frames do
            // not pollute the chat log.
            return Ok(warp::reply::with_status(
                json(&ChatReceiveResponse {
                    id: 0,
                    kind: chat::MSG_STATUS,
                    text: Some("not a chat frame".to_string()),
                }),
                warp::http::StatusCode::OK,
            ));
        }
    };

    let channel = chat::channel_for_peer(&state);
    let msg = match state
        .store
        .record_incoming(req.src, kind, text, payload_b64, channel)
    {
        Ok(m) => m,
        Err(e) => {
            return chat_error(
                &format!("store error: {e}"),
                warp::http::StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    Ok(warp::reply::with_status(
        json(&ChatReceiveResponse {
            id: msg.id,
            kind: msg.kind,
            text: msg.text,
        }),
        warp::http::StatusCode::OK,
    ))
}

async fn chat_messages_handler(
    peer: u32,
    state: Arc<RwLock<MeshState>>,
) -> Result<impl warp::Reply, Infallible> {
    let state = state.read().await;
    let messages = state.store.messages_for(peer).to_vec();
    Ok(warp::reply::with_status(
        json(&ChatMessagesResponse { peer, messages }),
        warp::http::StatusCode::OK,
    ))
}

async fn chat_ack_handler(
    req: ChatAckRequest,
    state: Arc<RwLock<MeshState>>,
) -> Result<impl warp::Reply, Infallible> {
    let mut state = state.write().await;
    match state.store.ack_peer(req.peer) {
        Ok(()) => Ok(warp::reply::with_status(
            json(&serde_json::json!({ "ok": true, "peer": req.peer })),
            warp::http::StatusCode::OK,
        )),
        Err(e) => chat_error(
            &format!("store error: {e}"),
            warp::http::StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

async fn chat_conversations_handler(
    state: Arc<RwLock<MeshState>>,
) -> Result<impl warp::Reply, Infallible> {
    let state = state.read().await;
    let conversations = state.store.conversations();
    Ok(warp::reply::with_status(
        json(&conversations),
        warp::http::StatusCode::OK,
    ))
}

async fn chat_poll_handler(
    q: SinceIdQuery,
    state: Arc<RwLock<MeshState>>,
) -> Result<impl warp::Reply, Infallible> {
    let state = state.read().await;
    let messages = state.store.poll_since(q.since_id);
    let conversations = state.store.conversations();
    Ok(warp::reply::with_status(
        json(&ChatPollResponse {
            messages,
            conversations,
        }),
        warp::http::StatusCode::OK,
    ))
}

fn routes(
    state: Arc<RwLock<MeshState>>,
) -> impl Filter<Extract = impl warp::Reply, Error = warp::Rejection> + Clone {
    let health = warp::path("health")
        .and(warp::get())
        .and(with_state(state.clone()))
        .and_then(health_handler);

    let status = warp::path("status")
        .and(warp::get())
        .and(with_state(state.clone()))
        .and_then(status_handler);

    let observe = warp::path("observe")
        .and(warp::post())
        .and(warp::body::json())
        .and(with_state(state.clone()))
        .and_then(observe_handler);

    let hello = warp::path("hello")
        .and(warp::post())
        .and(warp::body::json())
        .and(with_state(state.clone()))
        .and_then(hello_handler);

    let send = warp::path("send")
        .and(warp::post())
        .and(warp::body::json())
        .and(with_state(state.clone()))
        .and_then(send_handler);

    let open = warp::path("open")
        .and(warp::post())
        .and(warp::body::json())
        .and(with_state(state.clone()))
        .and_then(open_handler);

    let force_dead = warp::path("force-dead")
        .and(warp::post())
        .and(warp::body::json())
        .and(with_state(state.clone()))
        .and_then(force_dead_handler);

    let seed_peer = warp::path("seed-peer")
        .and(warp::post())
        .and(warp::body::json())
        .and(with_state(state.clone()))
        .and_then(seed_peer_handler);

    let link_loss = warp::path("link-loss")
        .and(warp::post())
        .and(with_state(state.clone()))
        .and_then(link_loss_handler);

    let reroute = warp::path("reroute")
        .and(warp::post())
        .and(with_state(state.clone()))
        .and_then(reroute_handler);

    let chat_send = warp::path("messages")
        .and(warp::path("send"))
        .and(warp::post())
        .and(warp::body::json())
        .and(with_state(state.clone()))
        .and_then(chat_send_handler);

    let chat_receive = warp::path("messages")
        .and(warp::path("receive"))
        .and(warp::post())
        .and(warp::body::json())
        .and(with_state(state.clone()))
        .and_then(chat_receive_handler);

    let chat_messages = warp::path!("messages" / u32)
        .and(warp::get())
        .and(with_state(state.clone()))
        .and_then(chat_messages_handler);

    let chat_ack = warp::path("messages")
        .and(warp::path("ack"))
        .and(warp::post())
        .and(warp::body::json())
        .and(with_state(state.clone()))
        .and_then(chat_ack_handler);

    let chat_conversations = warp::path("conversations")
        .and(warp::get())
        .and(with_state(state.clone()))
        .and_then(chat_conversations_handler);

    let chat_poll = warp::path("messages")
        .and(warp::path("poll"))
        .and(warp::get())
        .and(warp::query::<SinceIdQuery>())
        .and(with_state(state.clone()))
        .and_then(chat_poll_handler);

    let cors = warp::cors()
        .allow_any_origin()
        .allow_methods(vec!["GET", "POST", "OPTIONS"])
        .allow_headers(vec!["content-type"]);

    health
        .or(status)
        .or(observe)
        .or(hello)
        .or(send)
        .or(open)
        .or(force_dead)
        .or(seed_peer)
        .or(link_loss)
        .or(reroute)
        .or(chat_send)
        .or(chat_receive)
        .or(chat_messages)
        .or(chat_ack)
        .or(chat_conversations)
        .or(chat_poll)
        .with(cors)
}

#[tokio::main]
async fn main() {
    let node_id: NodeId = std::env::var("TRIOS_MESH_NODE_ID")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);

    let my_key = match key_store::load_or_generate(node_id) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("[clade-meshd] FATAL: cannot load node key: {e}");
            std::process::exit(1);
        }
    };
    let public_key_b64 = key_store::public_key_base64(&my_key);

    let udp_bind = udp_bind_addr(node_id);
    let udp = match transport::spawn_udp_io(udp_bind).await {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[clade-meshd] FATAL: cannot bind UDP {udp_bind}: {e}");
            std::process::exit(1);
        }
    };

    let state = Arc::new(RwLock::new(MeshState::new(node_id, my_key, &udp)));
    {
        let mut guard = state.write().await;
        if let Err(e) = guard.store.load() {
            eprintln!("[clade-meshd] failed to load chat store: {e}; starting fresh");
        }
    }

    let frames = udp.frames;
    tokio::spawn(run_frame_processor(state.clone(), frames));

    let port = port();
    let udp_local = udp.socket.local_addr().unwrap_or(udp_bind);
    println!(
        "[clade-meshd] node_id={node_id} http_port={port} udp={udp_local} public_key={public_key_b64}"
    );
    warp::serve(routes(state)).run(([127, 0, 0, 1], port)).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_etx_labels() {
        assert_eq!(format_etx(1.0), "perfect");
        assert_eq!(format_etx(1.5), "good");
        assert_eq!(format_etx(3.0), "fair");
        assert_eq!(format_etx(10.0), "poor");
        assert_eq!(format_etx(f32::INFINITY), "dead");
    }

    fn seed_both(a: &mut MeshState, b: &mut MeshState) -> Result<(), String> {
        use trios_mesh::crypto::Handshake;
        let a_hs = Handshake::new();
        let b_hs = Handshake::new();
        let a_pub = a_hs.public;
        let b_pub = b_hs.public;

        let a_session = a_hs
            .complete(&b_pub, true)
            .map_err(|e| format!("{:?}", e))?;
        let b_session = b_hs
            .complete(&a_pub, false)
            .map_err(|e| format!("{:?}", e))?;

        a.node.add_session(b.node.id, a_session);
        b.node.add_session(a.node.id, b_session);
        Ok(())
    }

    #[tokio::test]
    async fn chat_round_trip_seal_open_and_store() -> Result<(), String> {
        use std::path::PathBuf;

        let alice_path = PathBuf::from("/tmp/clade_meshd_test_alice.json");
        let bob_path = PathBuf::from("/tmp/clade_meshd_test_bob.json");
        let _ = std::fs::remove_file(&alice_path);
        let _ = std::fs::remove_file(&bob_path);

        let alice_udp = transport::spawn_udp_io("127.0.0.1:0".parse().unwrap())
            .await
            .map_err(|e| format!("{e}"))?;
        let bob_udp = transport::spawn_udp_io("127.0.0.1:0".parse().unwrap())
            .await
            .map_err(|e| format!("{e}"))?;

        let mut alice = MeshState::new_with_store(1, StaticKey::generate(), alice_path, &alice_udp);
        let mut bob = MeshState::new_with_store(2, StaticKey::generate(), bob_path, &bob_udp);
        seed_both(&mut alice, &mut bob)?;

        alice.store.load().map_err(|e| format!("{:?}", e))?;
        bob.store.load().map_err(|e| format!("{:?}", e))?;

        let text = "hello mesh";
        let envelope = chat::encode_text_message(chat::MSG_TEXT, text)?;
        let frame = alice
            .node
            .seal_data(2, 8, &envelope)
            .ok_or_else(|| "seal_data returned None".to_string())?;

        let payload = bob
            .node
            .open_data(1, &frame)
            .map_err(|e| format!("{:?}", e))?;
        let (kind, decoded_text, _payload_b64) = chat::decode_chat_payload(&payload)?;

        assert_eq!(kind, chat::MSG_TEXT);
        assert_eq!(decoded_text.as_deref(), Some(text));

        let channel = chat::channel_for_peer(&alice);
        let msg = alice
            .store
            .record_outgoing(2, chat::MSG_TEXT, Some(text.to_string()), None, channel)
            .map_err(|e| format!("{e}"))?;
        assert_eq!(msg.peer, 2);
        assert!(msg.is_outgoing);

        bob.store
            .record_incoming(1, kind, decoded_text, None, channel)
            .map_err(|e| format!("{e}"))?;
        let bob_messages = bob.store.messages_for(1);
        assert_eq!(bob_messages.len(), 1);
        assert!(!bob_messages[0].is_outgoing);
        assert_eq!(bob_messages[0].text.as_deref(), Some(text));

        Ok(())
    }

    #[tokio::test]
    async fn udp_chat_transport_round_trip() -> Result<(), String> {
        use std::path::PathBuf;
        use std::time::Duration;
        use tokio::time::timeout;

        let alice_path = PathBuf::from("/tmp/clade_meshd_udp_alice.json");
        let bob_path = PathBuf::from("/tmp/clade_meshd_udp_bob.json");
        let _ = std::fs::remove_file(&alice_path);
        let _ = std::fs::remove_file(&bob_path);

        let alice_udp = transport::spawn_udp_io("127.0.0.1:0".parse().unwrap())
            .await
            .map_err(|e| format!("{e}"))?;
        let bob_udp = transport::spawn_udp_io("127.0.0.1:0".parse().unwrap())
            .await
            .map_err(|e| format!("{e}"))?;

        let alice_addr = alice_udp.socket.local_addr().map_err(|e| format!("{e}"))?;
        let bob_addr = bob_udp.socket.local_addr().map_err(|e| format!("{e}"))?;

        let mut alice = MeshState::new_with_store(1, StaticKey::generate(), alice_path, &alice_udp);
        let mut bob = MeshState::new_with_store(2, StaticKey::generate(), bob_path, &bob_udp);
        let alice_id = alice.node.id;
        let bob_id = bob.node.id;

        // Seed each side with the other's static public key and UDP address.
        let alice_pub = alice.my_key.public();
        let bob_pub = bob.my_key.public();

        let a_session = alice
            .my_key
            .session_with(&bob_pub, alice_id < bob_id)
            .map_err(|e| format!("{:?}", e))?;
        let b_session = bob
            .my_key
            .session_with(&alice_pub, bob_id < alice_id)
            .map_err(|e| format!("{:?}", e))?;

        alice.node.add_session(bob_id, a_session);
        bob.node.add_session(alice_id, b_session);

        alice.addr_to_peer.insert(bob_addr, bob_id);
        alice.peer_addrs.insert(bob_id, bob_addr);
        alice.transports.insert(
            bob_id,
            Box::new(transport::UdpTransport::new(alice.udp_outbound.clone(), bob_addr)),
        );

        bob.addr_to_peer.insert(alice_addr, alice_id);
        bob.peer_addrs.insert(alice_id, alice_addr);

        // Run Bob's frame processor so the UDP frame is opened and stored.
        let bob_state = Arc::new(RwLock::new(bob));
        let bob_frames = bob_udp.frames;
        tokio::spawn(run_frame_processor(bob_state.clone(), bob_frames));

        let text = "hello over udp";
        let envelope = chat::encode_text_message(chat::MSG_TEXT, text)?;
        let frame = alice
            .node
            .seal_data(bob_id, 8, &envelope)
            .ok_or_else(|| "seal failed".to_string())?;

        // Push the frame through the transport.
        let mut transport = alice
            .transports
            .remove(&bob_id)
            .ok_or_else(|| "missing transport".to_string())?;
        transport
            .send(&frame)
            .map_err(|e| format!("transport send failed: {e}"))?;

        // Wait for the frame to arrive and be stored.
        let _ = timeout(Duration::from_secs(2), async {
            loop {
                {
                    let guard = bob_state.read().await;
                    let msgs = guard.store.messages_for(alice_id);
                    if !msgs.is_empty() {
                        assert_eq!(msgs.len(), 1);
                        assert!(!msgs[0].is_outgoing);
                        assert_eq!(msgs[0].text.as_deref(), Some(text));
                        return;
                    }
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .map_err(|_| "timed out waiting for incoming message")?;

        Ok(())
    }
}
