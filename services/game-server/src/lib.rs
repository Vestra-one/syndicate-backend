//! syndicate-game-server: REST + WebSocket API, lobby/rooms, seat verification,
//! in-process betting engine, sealing, and the chain-job handshake.

pub mod api;
pub mod app;
pub mod auth;
pub mod chainjobs;
pub mod config;
pub mod db;
pub mod error;
pub mod price;
pub mod runtime;
pub mod sweeper;
pub mod util;
pub mod verifier;
pub mod view;
pub mod ws;
