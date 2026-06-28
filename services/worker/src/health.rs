//! HTTP health and metrics endpoints for the settlement worker.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::thread;

use crate::metrics::WorkerMetrics;

pub fn spawn_health_server(host: &str, port: u16, metrics: WorkerMetrics) {
    let addr = format!("{host}:{port}");
    let metrics = Arc::new(metrics);
    thread::spawn(move || {
        let listener = TcpListener::bind(&addr)
            .unwrap_or_else(|e| panic!("bind settlement-worker health {addr}: {e}"));
        println!("settlement-worker health listening on http://{addr}");
        for stream in listener.incoming() {
            if let Ok(stream) = stream {
                let metrics = Arc::clone(&metrics);
                thread::spawn(move || handle(stream, metrics));
            }
        }
    });
}

fn handle(mut stream: TcpStream, metrics: Arc<WorkerMetrics>) {
    let mut buf = [0u8; 2048];
    let Ok(n) = stream.read(&mut buf) else {
        return;
    };
    let request = String::from_utf8_lossy(&buf[..n]);
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");
    match path {
        "/healthz" => respond(&mut stream, "200 OK", "application/json", r#"{"ok":true}"#),
        "/metrics" => respond(
            &mut stream,
            "200 OK",
            "text/plain; version=0.0.4",
            &metrics.render_prometheus(),
        ),
        _ => respond(&mut stream, "404 Not Found", "text/plain", "not found"),
    }
}

fn respond(stream: &mut TcpStream, status: &str, content_type: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\ncache-control: no-store\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
}
