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
    pub outbound: mpsc::UnboundedSender<(SocketAddr, Vec<u8>)>,
    pub frames: mpsc::UnboundedReceiver<(SocketAddr, Vec<u8>)>,
}

/// Bind a UDP socket and spawn the send/receive tasks.
pub async fn spawn_udp_io(bind_addr: SocketAddr) -> io::Result<UdpIo> {
    let socket = Arc::new(UdpSocket::bind(bind_addr).await?);

    let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<(SocketAddr, Vec<u8>)>();
    let (frame_tx, frame_rx) = mpsc::unbounded_channel::<(SocketAddr, Vec<u8>)>();

    let tx_socket = socket.clone();
    tokio::spawn(async move {
        while let Some((peer, frame)) = outbound_rx.recv().await {
            if tx_socket.send_to(&frame, peer).await.is_err() {
                break;
            }
        }
    });

    let rx_socket = socket.clone();
    tokio::spawn(async move {
        let mut buf = vec![0u8; 2048];
        loop {
            match rx_socket.recv_from(&mut buf).await {
                Ok((n, addr)) => {
                    if frame_tx.send((addr, buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
                Err(_) => break,
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
    outbound: mpsc::UnboundedSender<(SocketAddr, Vec<u8>)>,
    peer: SocketAddr,
}

impl UdpTransport {
    pub fn new(outbound: mpsc::UnboundedSender<(SocketAddr, Vec<u8>)>, peer: SocketAddr) -> Self {
        Self { outbound, peer }
    }
}

impl trios_mesh::daemon::Transport for UdpTransport {
    fn send(&mut self, frame: &[u8]) -> io::Result<()> {
        self.outbound
            .send((self.peer, frame.to_vec()))
            .map_err(|_| io::Error::new(ErrorKind::BrokenPipe, "udp tx channel closed"))
    }

    fn recv(&mut self) -> io::Result<Vec<u8>> {
        Err(io::Error::new(
            ErrorKind::Unsupported,
            "central rx is handled by the async frame processor",
        ))
    }
}
