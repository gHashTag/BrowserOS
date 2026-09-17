//! Host-sim UDP transport for sealed mesh frames.
//!
//! Each `clade-meshd` instance binds one UDP socket for frame I/O.  A single
//! outbound channel fans frames out to a tokio send task, and a central async
//! receive task forwards raw datagrams to the caller for opening/storage.

use std::io::{self, ErrorKind};
use std::net::SocketAddr;
use std::sync::Arc;

use tokio::net::UdpSocket;
use tokio::sync::mpsc;

/// Handle to the UDP I/O tasks and the outbound channel.
pub struct UdpIo {
    pub socket: Arc<UdpSocket>,
    pub outbound: mpsc::Sender<(SocketAddr, Vec<u8>)>,
    pub frames: mpsc::Receiver<(SocketAddr, Vec<u8>)>,
}

/// Maximum frame size for the UDP transport. The mesh wire layer has an 11-byte
/// header; the modem layer enforces a 255-byte ceiling. We allow a generous
/// host-sim budget but still cap it to prevent amplification and memory abuse.
const MAX_FRAME_SIZE: usize = 1024;

/// Bound the UDP channels so a flood of ingress datagrams applies backpressure
/// rather than exhausting memory.
const UDP_CHANNEL_CAPACITY: usize = 256;

/// Bind a UDP socket and spawn the send/receive tasks.
pub async fn spawn_udp_io(bind_addr: SocketAddr) -> io::Result<UdpIo> {
    let socket = Arc::new(UdpSocket::bind(bind_addr).await?);

    let (outbound_tx, mut outbound_rx) = mpsc::channel::<(SocketAddr, Vec<u8>)>(UDP_CHANNEL_CAPACITY);
    let (frame_tx, frame_rx) = mpsc::channel::<(SocketAddr, Vec<u8>)>(UDP_CHANNEL_CAPACITY);

    let tx_socket = socket.clone();
    tokio::spawn(async move {
        while let Some((peer, frame)) = outbound_rx.recv().await {
            if frame.len() > MAX_FRAME_SIZE {
                continue;
            }
            if tx_socket.send_to(&frame, peer).await.is_err() {
                break;
            }
        }
    });

    let rx_socket = socket.clone();
    tokio::spawn(async move {
        let mut buf = vec![0u8; MAX_FRAME_SIZE];
        while let Ok((n, addr)) = rx_socket.recv_from(&mut buf).await {
            let n = n.min(MAX_FRAME_SIZE);
            if frame_tx.send((addr, buf[..n].to_vec())).await.is_err() {
                break;
            }
        }
    });

    Ok(UdpIo {
        socket,
        outbound: outbound_tx,
        frames: frame_rx,
    })
}

/// Per-peer UDP pipe used by the mesh node's `Transport` trait.
pub struct UdpTransport {
    outbound: mpsc::Sender<(SocketAddr, Vec<u8>)>,
    peer: SocketAddr,
}

impl UdpTransport {
    pub fn new(outbound: mpsc::Sender<(SocketAddr, Vec<u8>)>, peer: SocketAddr) -> Self {
        Self { outbound, peer }
    }
}

impl trios_mesh::daemon::Transport for UdpTransport {
    fn send(&mut self, frame: &[u8]) -> io::Result<()> {
        if frame.len() > MAX_FRAME_SIZE {
            return Err(io::Error::new(
                ErrorKind::InvalidData,
                "frame exceeds UDP transport maximum",
            ));
        }
        self.outbound
            .try_send((self.peer, frame.to_vec()))
            .map_err(|_| io::Error::new(ErrorKind::BrokenPipe, "udp tx channel closed"))
    }

    fn recv(&mut self) -> io::Result<Vec<u8>> {
        Err(io::Error::new(
            ErrorKind::Unsupported,
            "central rx is handled by the async frame processor",
        ))
    }
}
