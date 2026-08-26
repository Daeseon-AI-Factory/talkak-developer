//! The session registry — the persistent, process-wide map of live sessions. One `Broker` per
//! detached broker process; clients come and go, sessions outlive them (that IS the persistence).

use crate::protocol::SessionInfo;
use crate::session::{Session, SpawnSpec};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct Broker {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl Broker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawn a session, or return the existing one if `session_id` is already live (idempotent
    /// reattach — the app re-issues `spawn` on restart and must not double-create).
    pub fn spawn(&self, spec: SpawnSpec) -> Result<Arc<Session>, String> {
        let mut map = self.sessions.lock().map_err(|e| e.to_string())?;
        if let Some(existing) = map.get(&spec.session_id) {
            if existing.alive() {
                return Ok(existing.clone());
            }
            map.remove(&spec.session_id); // dead → replace
        }
        let session = Session::spawn(spec)?;
        map.insert(session.session_id.clone(), session.clone());
        Ok(session)
    }

    /// Look up a live session by id.
    pub fn get(&self, session_id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().ok()?.get(session_id).cloned()
    }

    /// Kill + drop a session.
    pub fn kill(&self, session_id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .lock()
            .map_err(|e| e.to_string())?
            .remove(session_id);
        match session {
            Some(s) => s.kill(),
            None => Ok(()), // already gone — idempotent
        }
    }

    /// Snapshot of live sessions for introspection (replaces tmux `list-sessions`/`pane_pid`).
    /// Also reaps dead sessions so a crashed child doesn't linger in the registry forever.
    pub fn list(&self) -> Vec<SessionInfo> {
        let mut map = match self.sessions.lock() {
            Ok(m) => m,
            Err(_) => return Vec::new(),
        };
        let mut dead = Vec::new();
        let mut out = Vec::new();
        for (id, s) in map.iter() {
            let alive = s.alive();
            if !alive {
                dead.push(id.clone());
            }
            out.push(SessionInfo {
                session_id: id.clone(),
                child_pid: s.child_pid,
                alive,
            });
        }
        for id in dead {
            map.remove(&id);
        }
        out
    }

    /// Number of live sessions (used by the broker's idle-exit guard, Phase 3).
    pub fn len(&self) -> usize {
        self.sessions.lock().map(|m| m.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}
