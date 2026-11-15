use serde::Serialize;
use serde_json::Value;
use std::{
    collections::VecDeque,
    sync::{Condvar, Mutex},
    time::{Duration, Instant},
};

pub const EVENT_QUEUE_CAPACITY: usize = 128;

#[derive(Clone, Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope {
    pub version: u8,
    pub event_id: u64,
    pub event: Event,
}

#[derive(Clone, Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub kind: String,
    pub data: Value,
}

struct State {
    queue: VecDeque<Event>,
    dropped: u64,
    next_id: u64,
}

pub struct EventQueue {
    state: Mutex<State>,
    ready: Condvar,
}

impl Default for EventQueue {
    fn default() -> Self {
        Self {
            state: Mutex::new(State {
                queue: VecDeque::with_capacity(EVENT_QUEUE_CAPACITY),
                dropped: 0,
                next_id: 1,
            }),
            ready: Condvar::new(),
        }
    }
}

impl EventQueue {
    pub fn push(&self, kind: &str, data: impl Serialize) {
        let Ok(data) = serde_json::to_value(data) else {
            return;
        };
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.queue.len() == EVENT_QUEUE_CAPACITY {
            state.queue.pop_front();
            state.dropped += 1;
        }
        state.queue.push_back(Event {
            kind: kind.into(),
            data,
        });
        self.ready.notify_one();
    }

    pub fn recv(&self, timeout: Duration) -> Option<EventEnvelope> {
        let start = Instant::now();
        let mut state = self.state.lock().ok()?;
        while state.queue.is_empty() && state.dropped == 0 {
            let remaining = timeout.checked_sub(start.elapsed())?;
            let (next, result) = self.ready.wait_timeout(state, remaining).ok()?;
            state = next;
            if result.timed_out() && state.queue.is_empty() && state.dropped == 0 {
                return None;
            }
        }
        let event = if state.dropped > 0 {
            let dropped = std::mem::take(&mut state.dropped);
            Event {
                kind: "events_dropped".into(),
                data: serde_json::json!({ "count": dropped }),
            }
        } else {
            state.queue.pop_front()?
        };
        let event_id = state.next_id;
        state.next_id = state.next_id.wrapping_add(1).max(1);
        Some(EventEnvelope {
            version: 1,
            event_id,
            event,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_queue_is_bounded_and_reports_loss() {
        let queue = EventQueue::default();
        for index in 0..EVENT_QUEUE_CAPACITY + 3 {
            queue.push("tick", index);
        }
        let loss = queue.recv(Duration::ZERO).unwrap();
        assert_eq!(loss.event.kind, "events_dropped");
        assert_eq!(loss.event.data["count"], 3);
        let next = queue.recv(Duration::ZERO).unwrap();
        assert_eq!(next.event.data, 3);
        assert_eq!(queue.recv(Duration::ZERO).unwrap().event.data, 4);
    }
}
