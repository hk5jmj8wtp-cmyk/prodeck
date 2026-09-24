//! DiGiCo S31 general-purpose OSC, firmware 3+ with default addresses/ranges.
//! Channel numbers and query semantics: S-Series V3.0.9 release notes, pp.12–15.
//! See docs/DIGICO_S31.md for sources, setup, and hardware-validation limits.
use crate::ahmap::{self, DeskModel};
use crate::avantis::{apply_fader, apply_mute, snapshot, AvantisInner, AvantisState};
use rosc::{OscMessage, OscPacket, OscType};
use serde_json::json;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::UdpSocket;

pub const PORT: u16 = 8000;
pub const FEEDBACK_PORT: u16 = 8001;
// ProDeck currently exposes integer snapshot rows 1–500, not snapshot names.
const MAX_SCENE: u32 = 500;
const FADER_OFF: f32 = -150.0;
static RECONNECT: AtomicBool = AtomicBool::new(false);
pub fn reconnect() {
    RECONNECT.store(true, Ordering::Release);
}

#[derive(Clone, PartialEq, Eq)]
struct Config {
    enabled: bool,
    host: String,
    port: u16,
    feedback_port: u16,
}
struct Connection {
    socket: Arc<UdpSocket>,
    peer: SocketAddr,
    config: Config,
}
#[derive(Default)]
pub struct S31State(Mutex<Option<Connection>>);

pub fn selected<R: tauri::Runtime>(app: &AppHandle<R>) -> bool {
    let state = app.state::<crate::settings::SettingsState>();
    let s = state.lock().unwrap_or_else(|p| p.into_inner());
    DeskModel::parse(&s.avantis_model) == DeskModel::S31
}
fn settings<R: tauri::Runtime>(app: &AppHandle<R>) -> Config {
    let state = app.state::<crate::settings::SettingsState>();
    let s = state.lock().unwrap_or_else(|p| p.into_inner());
    Config {
        enabled: s.avantis_enabled && DeskModel::parse(&s.avantis_model) == DeskModel::S31,
        host: s.avantis_host.trim().to_string(),
        port: if s.avantis_port == 0 {
            PORT
        } else {
            s.avantis_port
        },
        feedback_port: if s.s31_feedback_port == 0 {
            FEEDBACK_PORT
        } else {
            s.s31_feedback_port
        },
    }
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Busses retain their OSC number when switched between aux and group mode.
/// A neutral bus key avoids silently moving a control to a different output.
fn channel_key(n: u16) -> Option<String> {
    Some(match n {
        1..=60 => format!("input:{n}"),
        70..=93 => format!("bus:{}", n - 69),
        100..=107 => format!("mtx:{}", n - 99),
        110..=119 => format!("dca:{}", n - 109),
        120 => "main:1".into(),
        _ => return None,
    })
}
fn channel_number(key: &str) -> Option<u16> {
    let (kind, idx) = key.split_once(':')?;
    let n: u16 = idx.parse().ok()?;
    match (kind, n) {
        ("input", 1..=60) => Some(n),
        ("bus", 1..=24) => Some(n + 69),
        ("mtx", 1..=8) => Some(n + 99),
        ("dca", 1..=10) => Some(n + 109),
        ("main", 1) => Some(120),
        _ => None,
    }
}
fn message(addr: &str, args: Vec<OscType>) -> OscPacket {
    OscPacket::Message(OscMessage {
        addr: addr.into(),
        args,
    })
}
fn encode(packet: &OscPacket) -> Result<Vec<u8>, String> {
    rosc::encoder::encode(packet).map_err(|e| e.to_string())
}
fn query_addresses() -> Vec<String> {
    (1..=120)
        .filter(|n| channel_key(*n).is_some())
        .flat_map(|n| ["name", "mute", "fader"].map(|field| format!("/channel/{n}/{field}")))
        .collect()
}

/// Some S-Series firmware omits final OSC alignment padding. Only restore
/// trailing zeros; never interpret arbitrary non-OSC packets as desk feedback.
fn decode(data: &[u8]) -> Option<OscPacket> {
    if let Ok((rest, packet)) = rosc::decoder::decode_udp(data) {
        if rest.is_empty() {
            return Some(packet);
        }
    }
    if data.len() % 4 == 0 {
        return None;
    }
    // Only a complete, NUL-terminated string may be missing alignment.
    // Padding a truncated number could turn a damaged mute into an unmute.
    let address_end = data.iter().position(|b| *b == 0)?;
    let tags = (address_end + 4) & !3;
    if data.get(tags..tags + 4) != Some(b",s\0\0") || data.last() != Some(&0) {
        return None;
    }
    let mut padded = data.to_vec();
    padded.resize((data.len() + 3) & !3, 0);
    let (rest, packet) = rosc::decoder::decode_udp(&padded).ok()?;
    rest.is_empty().then_some(packet)
}

/// Return whether a message is recognized and valid (even an unchanged mute
/// is a fresh desk confirmation). Reject non-finite levels and invalid types.
fn apply_message(s: &mut AvantisInner, addr: &str, args: &[OscType]) -> bool {
    if args.len() != 1 {
        return false;
    }
    if addr == "/digico/snapshots/fire" {
        if let OscType::Int(n) = args[0] {
            if (1..=MAX_SCENE as i32).contains(&n) {
                s.scene = Some(n as u32);
                s.scene_at = Some(now_ms());
                return true;
            }
        }
        return false;
    }
    let Some(rest) = addr.strip_prefix("/channel/") else {
        return false;
    };
    let Some((number, field)) = rest.split_once('/') else {
        return false;
    };
    let Some(key) = number.parse().ok().and_then(channel_key) else {
        return false;
    };
    match (field, &args[0]) {
        ("mute", OscType::Bool(v)) => {
            apply_mute(s, key.clone(), *v);
        }
        ("mute", OscType::Int(v)) if *v == 0 || *v == 1 => {
            apply_mute(s, key.clone(), *v == 1);
        }
        ("fader", OscType::Float(db)) if db.is_finite() && (FADER_OFF..=10.0).contains(db) => {
            apply_fader(
                s,
                key.clone(),
                ahmap::fader_u8_from_db((*db > FADER_OFF).then_some(*db)),
            );
            s.fader_db.insert(key.clone(), *db);
        }
        ("name", OscType::String(name)) if name.len() <= 256 => {
            s.names.insert(key.clone(), name.trim().to_string());
        }
        _ => return false,
    }
    // Display even channels whose name report is empty, missing, or delayed.
    s.names.entry(key.clone()).or_insert_with(|| {
        let (kind, n) = key.split_once(':').unwrap();
        format!("{} {n}", ahmap::pretty_kind(kind).unwrap_or(kind))
    });
    if s.names.get(&key).is_some_and(|name| name.is_empty()) {
        s.names.insert(key.clone(), key);
    }
    true
}
fn apply_packet(s: &mut AvantisInner, packet: OscPacket) -> bool {
    match packet {
        OscPacket::Message(m) => apply_message(s, &m.addr, &m.args),
        OscPacket::Bundle(b) => b
            .content
            .into_iter()
            .fold(false, |seen, p| apply_packet(s, p) | seen),
    }
}
fn emit<R: tauri::Runtime>(app: &AppHandle<R>, state: &AvantisState) {
    app.emit("avantis:state", snapshot(state)).ok();
}
fn disconnect<R: tauri::Runtime>(app: &AppHandle<R>, state: &AvantisState) {
    *app.state::<S31State>()
        .0
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = None;
    let mut s = state.lock().unwrap_or_else(|p| p.into_inner());
    if s.model != DeskModel::S31 {
        return;
    }
    s.connected = false;
    s.connected_at = None;
    drop(s);
    app.emit("avantis:status", json!({ "connected": false }))
        .ok();
    emit(app, state);
}

pub fn spawn_mirror(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AvantisState>().inner().clone();
        loop {
            let config = settings(&app);
            if !config.enabled || config.host.is_empty() {
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
            if let Err(e) = session(&app, &state, config).await {
                crate::diag::log(format!("[s31] {e}"));
            }
            disconnect(&app, &state);
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
}
async fn session<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &AvantisState,
    config: Config,
) -> Result<(), String> {
    RECONNECT.store(false, Ordering::Release);
    let peer = tokio::net::lookup_host((config.host.as_str(), config.port))
        .await
        .map_err(|e| e.to_string())?
        .find(|a| a.is_ipv4())
        .ok_or("Use the S31's IPv4 address")?;
    let socket = Arc::new(
        UdpSocket::bind(("0.0.0.0", config.feedback_port))
            .await
            .map_err(|e| {
                format!(
                    "Cannot listen on S31 feedback port {}: {e}",
                    config.feedback_port
                )
            })?,
    );
    {
        let mut s = state.lock().unwrap_or_else(|p| p.into_inner());
        // A new desk/session must never inherit confirmed mutes or names from
        // an A&H cache, another IP, or the previous connection.
        *s = AvantisInner {
            model: DeskModel::S31,
            ..Default::default()
        };
    }
    app.emit("avantis:status", json!({ "connected": false }))
        .ok();
    emit(app, state);
    let queries = query_addresses();
    let mut next_query = 0;
    let mut query_tick = tokio::time::interval(Duration::from_millis(10));
    let mut heartbeat = tokio::time::interval(Duration::from_secs(3));
    let mut check = tokio::time::interval(Duration::from_millis(500));
    let mut publish = tokio::time::interval(Duration::from_millis(250));
    let mut last_rx = tokio::time::Instant::now();
    let mut dirty = false;
    let mut connected = false;
    let mut buf = [0u8; 65_535];
    loop {
        tokio::select! {
            result = socket.recv_from(&mut buf) => {
                let (n, source) = result.map_err(|e| e.to_string())?;
                // The desk may transmit from a different source port. Match
                // its configured IP, not the port it receives commands on.
                if source.ip() != peer.ip() { continue; }
                if settings(app) != config { return Ok(()); }
                let Some(packet) = decode(&buf[..n]) else { continue };
                let mut s = state.lock().unwrap_or_else(|p| p.into_inner());
                if !apply_packet(&mut s, packet) { continue; }
                last_rx = tokio::time::Instant::now();
                if !connected {
                    connected = true;
                    s.connected = true;
                    s.connected_at = Some(now_ms());
                    // Mark the first mute report as part of this connection.
                    let at = s.connected_at.unwrap();
                    for seen in s.mute_seen.values_mut() { *seen = at; }
                    *app.state::<S31State>().0.lock().unwrap_or_else(|p| p.into_inner()) = Some(Connection {
                        socket: socket.clone(), peer, config: config.clone(),
                    });
                    app.emit("avantis:status", json!({ "connected": true })).ok();
                }
                dirty = true;
            }
            _ = query_tick.tick(), if next_query < queries.len() => {
                socket.send_to(&encode(&message(&queries[next_query], vec![]))?, peer).await.map_err(|e| e.to_string())?;
                next_query += 1;
            }
            _ = heartbeat.tick() => {
                // A parameter query is documented and non-mutating; unlike
                // UDP socket creation, a valid reply proves the desk is alive.
                socket.send_to(&encode(&message("/channel/1/mute", vec![]))?, peer).await.map_err(|e| e.to_string())?;
            }
            _ = publish.tick() => {
                if dirty { dirty = false; emit(app, state); }
            }
            _ = check.tick() => {
                if RECONNECT.swap(false, Ordering::AcqRel) { return Ok(()); }
                if settings(app) != config { return Ok(()); }
                if last_rx.elapsed() > Duration::from_secs(12) {
                    return Err("No S31 feedback. Check OSC controller IP, Send Port, and Send/Receive switches on the desk.".into());
                }
            }
        }
    }
}

// Writes use the same registered feedback socket and never optimistically
// update the mirror: only console feedback confirms the resulting state.
async fn fire<R: tauri::Runtime>(
    app: &AppHandle<R>,
    packet: OscPacket,
    key: Option<&str>,
) -> Result<(), String> {
    let config = settings(app);
    let (socket, peer) = {
        let state = app.state::<S31State>();
        let connection = state.0.lock().unwrap_or_else(|p| p.into_inner());
        let c = connection
            .as_ref()
            .filter(|c| c.config == config && config.enabled)
            .ok_or("S31 is not connected. Check OSC feedback in Settings → Sound Console.")?;
        (c.socket.clone(), c.peer)
    };
    {
        let state = app.state::<AvantisState>();
        let s = state.lock().unwrap_or_else(|p| p.into_inner());
        if !s.connected || s.model != DeskModel::S31 {
            return Err("S31 is not connected".into());
        }
        if key.is_some_and(|key| !s.names.contains_key(key)) {
            return Err("This channel has not been reported by the S31. Check OSC channel mapping on the desk.".into());
        }
    }
    socket
        .send_to(&encode(&packet)?, peer)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn channel_message(key: &str, field: &str, arg: OscType) -> Result<OscPacket, String> {
    let n = channel_number(key).ok_or("That channel does not exist in the S31 OSC map")?;
    Ok(message(&format!("/channel/{n}/{field}"), vec![arg]))
}
pub async fn set_mute<R: tauri::Runtime>(
    app: &AppHandle<R>,
    key: &str,
    muted: bool,
) -> Result<(), String> {
    fire(
        app,
        channel_message(key, "mute", OscType::Bool(muted))?,
        Some(key),
    )
    .await
}
fn fader_message(key: &str, value: u8, db: Option<f32>) -> Result<OscPacket, String> {
    let db = db.unwrap_or_else(|| ahmap::db_from_fader_u8(value.min(127)).unwrap_or(FADER_OFF));
    if !db.is_finite() || !(FADER_OFF..=10.0).contains(&db) {
        return Err("S31 fader must be between -150 and +10 dB".into());
    }
    channel_message(key, "fader", OscType::Float(db))
}
pub async fn set_fader<R: tauri::Runtime>(
    app: &AppHandle<R>,
    key: &str,
    value: u8,
    db: Option<f32>,
) -> Result<(), String> {
    fire(app, fader_message(key, value, db)?, Some(key)).await
}
pub async fn set_name<R: tauri::Runtime>(
    app: &AppHandle<R>,
    key: &str,
    name: &str,
) -> Result<(), String> {
    fire(
        app,
        channel_message(key, "name", OscType::String(name.into()))?,
        Some(key),
    )
    .await
}
pub async fn recall_scene<R: tauri::Runtime>(app: &AppHandle<R>, scene: u32) -> Result<(), String> {
    if !(1..=MAX_SCENE).contains(&scene) {
        return Err("S31 snapshot must be 1–500 in ProDeck".into());
    }
    fire(
        app,
        message("/digico/snapshots/fire", vec![OscType::Int(scene as i32)]),
        None,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn channel_map_matches_digico_release_notes() {
        for (n, key) in [
            (1, "input:1"),
            (60, "input:60"),
            (70, "bus:1"),
            (79, "bus:10"),
            (80, "bus:11"),
            (93, "bus:24"),
            (100, "mtx:1"),
            (107, "mtx:8"),
            (110, "dca:1"),
            (119, "dca:10"),
            (120, "main:1"),
        ] {
            assert_eq!(channel_key(n).as_deref(), Some(key));
            assert_eq!(channel_number(key), Some(n));
        }
        for n in [0, 61, 69, 94, 99, 108, 109, 121, 65535] {
            assert!(channel_key(n).is_none());
        }
        for key in [
            "input:0", "input:61", "bus:25", "aux:1", "grp:1", "main:2", "mtx:9", "dca:11",
            "mgrp:1",
        ] {
            assert!(channel_number(key).is_none(), "{key}");
        }
        assert!(DeskModel::parse("s31").is_osc());
        assert!(ahmap::note_map(DeskModel::S31).is_empty());
    }
    #[test]
    fn mute_polarity_and_confirmation_are_preserved() {
        let mut s = AvantisInner::default();
        assert!(apply_message(
            &mut s,
            "/channel/1/mute",
            &[OscType::Bool(true)]
        ));
        assert_eq!(s.mutes["input:1"], true);
        assert!(s.mute_seen["input:1"] > 0);
        assert!(apply_message(&mut s, "/channel/1/mute", &[OscType::Int(0)]));
        assert_eq!(s.mutes["input:1"], false);
        assert!(apply_message(&mut s, "/channel/1/mute", &[OscType::Int(0)]));
        assert!(!apply_message(
            &mut s,
            "/channel/1/mute",
            &[OscType::Int(2)]
        ));
    }
    #[test]
    fn faders_use_decibels_not_normalized_x32_values() {
        let mut s = AvantisInner::default();
        for db in [-150.0, -90.0, -20.0, 0.0, 10.0] {
            assert!(apply_message(
                &mut s,
                "/channel/120/fader",
                &[OscType::Float(db)]
            ));
            assert_eq!(s.fader_db["main:1"], db);
            assert_eq!(
                s.faders["main:1"],
                ahmap::fader_u8_from_db((db > FADER_OFF).then_some(db))
            );
        }
        let OscPacket::Message(m) = fader_message("input:1", 1, Some(-89.0)).unwrap() else {
            panic!()
        };
        assert_eq!(
            m.args,
            vec![OscType::Float(-89.0)],
            "quiet channels must not jump to -54 dB"
        );
        for db in [f32::NAN, f32::INFINITY, -151.0, 11.0] {
            assert!(fader_message("input:1", 1, Some(db)).is_err());
            assert!(!apply_message(
                &mut s,
                "/channel/120/fader",
                &[OscType::Float(db)]
            ));
        }
        assert!(!apply_message(
            &mut s,
            "/channel/1/send/1/level",
            &[OscType::Float(-10.0)]
        ));
    }
    #[test]
    fn bundles_queries_and_wire_types_round_trip() {
        let packet = OscPacket::Bundle(rosc::OscBundle {
            timetag: (0, 1).into(),
            content: vec![
                channel_message("bus:24", "mute", OscType::Bool(true)).unwrap(),
                channel_message("input:1", "name", OscType::String("Pastor".into())).unwrap(),
            ],
        });
        let mut s = AvantisInner::default();
        assert!(apply_packet(
            &mut s,
            decode(&encode(&packet).unwrap()).unwrap()
        ));
        assert_eq!(s.names["input:1"], "Pastor");
        assert!(s.mutes["bus:24"]);
        for addr in query_addresses() {
            assert!(decode(&encode(&message(&addr, vec![])).unwrap()).is_some());
            assert!(
                !apply_message(&mut s, &addr, &[]),
                "queries are not feedback"
            );
        }
        assert!(decode(b"not osc").is_none());
        let mut name =
            encode(&channel_message("input:1", "name", OscType::String("ab".into())).unwrap())
                .unwrap();
        name.pop(); // missing string alignment byte, not the terminator
        assert!(decode(&name).is_some());
        let mut mute =
            encode(&channel_message("input:1", "mute", OscType::Int(1)).unwrap()).unwrap();
        mute.pop(); // missing numeric payload must never be fabricated
        assert!(decode(&mute).is_none());
        assert!(!apply_message(
            &mut s,
            "/digico/snapshots/fire",
            &[OscType::Int(0)]
        ));
        assert!(apply_message(
            &mut s,
            "/digico/snapshots/fire",
            &[OscType::Int(1)]
        ));
        assert_eq!(s.scene, Some(1));
    }
    #[tokio::test]
    async fn udp_uses_registered_feedback_port_and_receives_console_messages() {
        let desk = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let query = encode(&message("/channel/1/mute", vec![])).unwrap();
        client
            .send_to(&query, desk.local_addr().unwrap())
            .await
            .unwrap();
        let mut buf = [0; 1024];
        let (n, from) = tokio::time::timeout(Duration::from_secs(1), desk.recv_from(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(from, client.local_addr().unwrap());
        assert!(decode(&buf[..n]).is_some());
        desk.send_to(
            &encode(&channel_message("input:1", "mute", OscType::Bool(true)).unwrap()).unwrap(),
            from,
        )
        .await
        .unwrap();
        let (n, _) = tokio::time::timeout(Duration::from_secs(1), client.recv_from(&mut buf))
            .await
            .unwrap()
            .unwrap();
        let mut state = AvantisInner::default();
        assert!(apply_packet(&mut state, decode(&buf[..n]).unwrap()));
        assert!(state.mutes["input:1"]);
    }

    async fn test_app(
        desk_port: u16,
    ) -> (tauri::App<tauri::test::MockRuntime>, AvantisState, Config) {
        let reservation = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let feedback_port = reservation.local_addr().unwrap().port();
        let settings = crate::settings::Settings {
            avantis_enabled: true,
            avantis_model: "s31".into(),
            avantis_host: "127.0.0.1".into(),
            avantis_port: desk_port,
            s31_feedback_port: feedback_port,
            ..Default::default()
        };
        let state: AvantisState = Arc::new(Mutex::new(AvantisInner::default()));
        state
            .lock()
            .unwrap()
            .names
            .insert("input:55".into(), "OLD DESK".into());
        let app = tauri::test::mock_builder()
            .manage(Mutex::new(settings))
            .manage(state.clone())
            .manage(S31State::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let config = super::settings(app.handle());
        drop(reservation);
        (app, state, config)
    }

    async fn wait_until(mut predicate: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !predicate() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("driver did not reach expected state");
    }

    #[tokio::test]
    async fn real_session_confirms_feedback_reuses_socket_and_stops_on_config_change() {
        let desk = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let (app, state, config) = test_app(desk.local_addr().unwrap().port()).await;
        assert!(set_mute(app.handle(), "input:1", true).await.is_err());
        let handle = app.handle().clone();
        let mirror = state.clone();
        let expected_port = config.feedback_port;
        let task = tokio::spawn(async move { session(&handle, &mirror, config).await });
        let mut buf = [0u8; 4096];
        let (_, sender) = tokio::time::timeout(Duration::from_secs(2), desk.recv_from(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(sender.port(), expected_port);
        assert!(
            !state.lock().unwrap().names.contains_key("input:55"),
            "old console state must be cleared"
        );
        desk.send_to(b"malformed", sender).await.unwrap();
        desk.send_to(
            &encode(&message("/unrecognized", vec![OscType::Int(1)])).unwrap(),
            sender,
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(
            !state.lock().unwrap().connected,
            "random UDP is not a connection"
        );
        desk.send_to(
            &encode(&channel_message("input:1", "mute", OscType::Bool(false)).unwrap()).unwrap(),
            sender,
        )
        .await
        .unwrap();
        wait_until(|| state.lock().unwrap().connected).await;
        assert_eq!(state.lock().unwrap().model, DeskModel::S31);
        assert!(
            set_mute(app.handle(), "input:60", true).await.is_err(),
            "unreported channels cannot be controlled"
        );
        set_mute(app.handle(), "input:1", true).await.unwrap();
        let (sent, source) = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let (n, from) = desk.recv_from(&mut buf).await.unwrap();
                if let Some(OscPacket::Message(m)) = decode(&buf[..n]) {
                    if !m.args.is_empty() {
                        break (m, from);
                    }
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(
            source.port(),
            expected_port,
            "commands must use the registered socket"
        );
        assert_eq!(sent.addr, "/channel/1/mute");
        assert_eq!(sent.args, vec![OscType::Bool(true)]);
        assert!(
            !state.lock().unwrap().mutes["input:1"],
            "send alone cannot confirm a mute"
        );
        desk.send_to(&encode(&OscPacket::Message(sent)).unwrap(), sender)
            .await
            .unwrap();
        wait_until(|| state.lock().unwrap().mutes["input:1"]).await;
        {
            let s = state.lock().unwrap();
            assert!(s.mute_seen["input:1"] >= s.connected_at.unwrap());
        }
        app.state::<crate::settings::SettingsState>()
            .lock()
            .unwrap()
            .avantis_enabled = false;
        assert!(set_mute(app.handle(), "input:1", false).await.is_err());
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        disconnect(app.handle(), &state);
        assert!(!state.lock().unwrap().connected);
        assert!(app.state::<S31State>().0.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn quiet_console_times_out_instead_of_staying_connected() {
        let desk = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let (app, state, config) = test_app(desk.local_addr().unwrap().port()).await;
        let handle = app.handle().clone();
        let mirror = state.clone();
        let task = tokio::spawn(async move { session(&handle, &mirror, config).await });
        let mut buf = [0u8; 4096];
        let (_, sender) = tokio::time::timeout(Duration::from_secs(2), desk.recv_from(&mut buf))
            .await
            .unwrap()
            .unwrap();
        desk.send_to(
            &encode(&channel_message("input:1", "mute", OscType::Bool(false)).unwrap()).unwrap(),
            sender,
        )
        .await
        .unwrap();
        wait_until(|| state.lock().unwrap().connected).await;
        let result = tokio::time::timeout(Duration::from_secs(15), task)
            .await
            .unwrap()
            .unwrap();
        assert!(result.unwrap_err().contains("No S31 feedback"));
        disconnect(app.handle(), &state);
        assert!(!state.lock().unwrap().connected);
        assert!(set_mute(app.handle(), "input:1", true).await.is_err());
    }
}
