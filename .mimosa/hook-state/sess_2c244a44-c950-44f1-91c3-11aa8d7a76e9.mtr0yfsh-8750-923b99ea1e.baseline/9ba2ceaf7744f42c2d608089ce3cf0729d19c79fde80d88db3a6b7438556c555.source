# Task #8: Forward mesh chat sealed frames through transport

## Goal
Make `clade-meshd` actually move sealed chat frames between peers over a real host-sim transport, and wire the Swift `MeshChatViewModel` so the UI can seed a peer, send a message, and receive it on the other side without manually copying base64 frames.

## Current gap
- `clade-meshd` only seals/opens frames in HTTP handlers (`/send`, `/open`, `/messages/send`, `/messages/receive`). It has no socket, no router, and no outgoing frame path.
- The Swift UI calls `/messages/send` and gets a sealed frame back, but the frame is never forwarded to the peer; the only delivery path is the manual `receiveFrame(src:frame:)` sim helper.
- `trios-mesh` has a `daemon::Transport` trait (`send`/`recv` byte pipe), but `clade-meshd` does not implement or use it.

## Design
Add a minimal UDP transport to `clade-meshd` that:
1. Binds one UDP socket per daemon for sealed frames.
2. Registers a per-peer `daemon::Transport` when the UI (or a test) calls `/seed-peer` with the peer's UDP address.
3. Forwards the sealed frame produced by `/messages/send` over that transport.
4. Runs a background receiver that opens incoming UDP frames and stores them as incoming chat messages.
5. Keeps the Swift side simple: seed the peer once, then use the existing send/poll flow.

This is intentionally host-sim / M1 scope: no TUN, no radio, no multi-hop routing yet.

## Rust changes

### 1. `trios/rings/RUST-13/clade-meshd/Cargo.toml`
Extend `tokio` features so the daemon can use async UDP + channels:
```toml
tokio = { version = "1", features = ["rt-multi-thread", "macros", "sync", "net"] }
```

### 2. New `trios/rings/RUST-13/clade-meshd/src/transport.rs`
- `UdpTransport` implements `trios_mesh::daemon::Transport`.
  - Stores the peer `SocketAddr` and a clone of an outbound channel.
  - `send(frame)` enqueues `(peer, frame)` to a single UDP sender task.
  - `recv()` returns `io::ErrorKind::Unsupported` because RX is handled centrally by the async receiver task.
- `spawn_udp_io(bind_addr)`:
  - Binds `tokio::net::UdpSocket`.
  - Spawns one `udp_tx_task` that owns the socket and sends outbound datagrams.
  - Returns `(Arc<UdpSocket>, outbound_tx, frame_rx)` so the main loop can run the RX processor.

### 3. `trios/rings/RUST-13/clade-meshd/src/main.rs`
- Add `mod transport;`.
- Extend `MeshState` with:
  ```rust
  udp_socket: Arc<UdpSocket>,
  peer_addrs: HashMap<NodeId, SocketAddr>,
  addr_to_peer: HashMap<SocketAddr, NodeId>,
  transports: HashMap<NodeId, Box<dyn trios_mesh::daemon::Transport>>,
  ```
- Add `udp_bind_addr(node_id)` helper:
  - Read `TRIOS_MESH_UDP_BIND`.
  - Default to `127.0.0.1:9600 + node_id` (avoids collision with the HTTP port on 9505).
- Extend `SeedPeerRequest` with optional `address: Option<String>`.
- Update `seed_peer_handler`:
  - If `address` is present, parse it, insert `peer_addrs` / `addr_to_peer`, and create a `UdpTransport` for that peer.
  - Falls back to `TRIOS_MESH_PEER_ADDR_<peer>` env var for dev/test convenience.
- Update `chat_send_handler`:
  - After sealing, if a transport exists for `req.dst`, call `send(&frame)` and set `queued = result.is_ok()`.
  - If no transport exists, store the outgoing message and return `queued: false` plus the frame so the UI can still sim-fallback if desired.
- Add a background frame processor:
  ```rust
  async fn run_frame_processor(
      state: Arc<RwLock<MeshState>>,
      mut frame_rx: mpsc::UnboundedReceiver<(SocketAddr, Vec<u8>)>,
  )
  ```
  - For each `(addr, raw_frame)`:
    - Acquire `state.write().await`.
    - Map `addr -> peer id`; drop unknown sources.
    - Call `state.node.open_data(src, &raw_frame)`.
    - Call `chat::decode_chat_payload`; ignore non-chat frames silently.
    - Call `state.store.record_incoming(...)` (which persists the store).
- Start the processor + `udp_tx_task` in `main()` before `warp::serve`.

### 4. `trios/rings/RUST-13/trios-mesh/src/daemon.rs`
No changes required; the existing `Transport` trait and `Node::seal_data` / `Node::open_data` are sufficient.

## Swift changes

### 1. `trios/BR-OUTPUT/MeshChatModels.swift`
Add:
```swift
struct MeshSeedPeerRequest: Codable {
    let peer: UInt32
    let publicKey: String
    let address: String?
}
```

### 2. `trios/BR-OUTPUT/ProjectPaths.swift`
Add:
```swift
static var meshSeedPeerURL: String { "http://127.0.0.1:\(meshPort)/seed-peer" }
```

### 3. `trios/BR-OUTPUT/MeshChatViewModel.swift`
- Add `seedPeer(peer: UInt32, publicKey: String, address: String)` that POSTs a `MeshSeedPeerRequest` to `/seed-peer`.
- Keep `sendMessage` unchanged; it already posts to `/messages/send` and receives `MeshChatSendResponse`.
- Optionally surface `lastError` when `response.queued == false` so the user knows the daemon has no transport to the peer yet.

## Verification

### Rust unit test (inside `main.rs`)
Add `udp_chat_round_trip` test:
- Create two `MeshState` instances with deterministic keys and ephemeral UDP sockets.
- Seed each side with the other's public key + UDP address.
- Use the chat send path to seal a text envelope and push it through the transport.
- Run the async frame processor for a bounded number of messages.
- Assert the recipient's store contains the incoming message with correct text and `is_outgoing == false`.

### Shell E2E test
New `trios/rings/RUST-13/clade-meshd/tests/run_mesh_chat_transport.sh`:
- Start two `clade-meshd` processes on node ids `1` and `2` with distinct HTTP/UDP ports.
- Read their logged public keys or call `/health` + `/status`.
- `curl -X POST /seed-peer` on each side with the other's public key and UDP address.
- `curl -X POST /messages/send` on node 1 to node 2.
- Poll `/messages/poll` on node 2 until the message appears.
- Exit 0 on success, print both stores for debugging on failure.

### CI checks
- `cargo test --workspace` passes.
- `bash trios/tests/swift/run_chat_sse_e2e.sh` still passes.
- `bash trios/rings/RUST-13/clade-meshd/tests/run_mesh_chat_transport.sh` passes.

## Risks and mitigations
| Risk | Mitigation |
|------|------------|
| Binding UDP port conflicts in multi-node host tests | Default port derived from `node_id`; tests use `127.0.0.1:0` ephemeral ports where possible. |
| Source address of incoming datagram must exactly match seeded address | Host-sim only; real milestone M2 will use TUN/radio IDs, not UDP addresses. |
| `Transport::send` is synchronous; async UDP I/O could block or require locks | Use an outbound channel: `Transport::send` enqueues, a single async task drains to the socket. |
| Holding `state.write()` during open/store blocks HTTP handlers briefly | Frames are small (< 1 KB) and the lock is held only for crypto + one store write. |
| Old `trios_meshd.rs` binary is still broken | Leave it untouched; this task scopes to `clade-meshd` + Swift UI. |

## Deliverables
1. `trios/rings/RUST-13/clade-meshd/src/transport.rs` (new)
2. `trios/rings/RUST-13/clade-meshd/src/main.rs` edits for transport wiring and `/seed-peer` address
3. `trios/rings/RUST-13/clade-meshd/Cargo.toml` tokio feature bump
4. `trios/BR-OUTPUT/MeshChatModels.swift` + `ProjectPaths.swift` + `MeshChatViewModel.swift` edits for peer seeding
5. Rust UDP chat round-trip unit test
6. Shell E2E test script
