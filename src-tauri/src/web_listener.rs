//! Own the listening task so restarting cannot leave an old socket alive.
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

pub struct GatewayListener {
    pub running: AtomicBool,
    pub port: AtomicU16,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl GatewayListener {
    pub fn new() -> Self {
        Self {
            running: AtomicBool::new(false),
            port: AtomicU16::new(0),
            task: Mutex::new(None),
        }
    }

    pub async fn start(
        &self,
        port: u16,
        accept: impl Fn(TcpStream) + Send + 'static,
    ) -> Result<(), String> {
        let mut task = self.task.lock().await;
        if self.running.load(Ordering::Acquire)
            && self.port.load(Ordering::Acquire) == port
            && task.as_ref().is_some_and(|t| !t.is_finished())
        {
            return Ok(()); // Saving unrelated settings must not restart the server.
        }
        // Bind before replacing a healthy server. A busy new port must not
        // shut down the old address or report the new address as serving.
        let listener = TcpListener::bind(("0.0.0.0", port))
            .await
            .map_err(|e| format!("Could not start Browser Access on port {port}: {e}"))?;
        let actual_port = listener.local_addr().map_err(|e| e.to_string())?.port();
        if let Some(old) = task.take() {
            old.abort();
            let _ = old.await; // Releases the old listener before returning.
        }
        self.port.store(actual_port, Ordering::Release);
        self.running.store(true, Ordering::Release);
        *task = Some(tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => accept(stream),
                    Err(_) => tokio::time::sleep(std::time::Duration::from_millis(100)).await,
                }
            }
        }));
        Ok(())
    }

    pub async fn stop(&self) {
        let mut task = self.task.lock().await;
        self.running.store(false, Ordering::Release);
        if let Some(old) = task.take() {
            old.abort();
            let _ = old.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn respond(mut stream: TcpStream) {
        tokio::spawn(async move {
            let _ = stream.write_all(b"ready").await;
        });
    }
    async fn check(port: u16) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let mut b = [0; 5];
        tokio::time::timeout(std::time::Duration::from_secs(2), s.read_exact(&mut b))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&b, b"ready");
    }
    #[tokio::test]
    async fn repeated_save_and_restart_keep_the_port_working() {
        let server = GatewayListener::new();
        server.start(0, respond).await.unwrap();
        let port = server.port.load(Ordering::Acquire);
        for _ in 0..4 {
            server.start(port, respond).await.unwrap();
            check(port).await;
            server.stop().await;
            assert!(!server.running.load(Ordering::Acquire));
            server.start(port, respond).await.unwrap();
            check(port).await;
        }
        server.stop().await;
        assert!(TcpListener::bind(("0.0.0.0", port)).await.is_ok());
    }
    #[tokio::test]
    async fn port_change_releases_old_socket_and_busy_port_preserves_service() {
        let server = GatewayListener::new();
        server.start(0, respond).await.unwrap();
        let old_port = server.port.load(Ordering::Acquire);
        let busy = TcpListener::bind(("0.0.0.0", 0)).await.unwrap();
        let busy_port = busy.local_addr().unwrap().port();
        assert!(server
            .start(busy_port, respond)
            .await
            .unwrap_err()
            .contains("Could not start Browser Access"));
        assert_eq!(server.port.load(Ordering::Acquire), old_port);
        assert!(server.running.load(Ordering::Acquire));
        check(old_port).await;
        drop(busy);
        server.start(busy_port, respond).await.unwrap();
        check(busy_port).await;
        assert!(TcpListener::bind(("0.0.0.0", old_port)).await.is_ok());
        server.stop().await;
    }
    #[tokio::test]
    async fn failed_start_does_not_claim_to_be_running() {
        let busy = TcpListener::bind(("0.0.0.0", 0)).await.unwrap();
        let server = GatewayListener::new();
        assert!(server
            .start(busy.local_addr().unwrap().port(), respond)
            .await
            .is_err());
        assert!(!server.running.load(Ordering::Acquire));
        assert_eq!(server.port.load(Ordering::Acquire), 0);
    }
}
