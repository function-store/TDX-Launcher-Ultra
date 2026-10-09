//! Per-PID CPU/RAM sampling for the Current tab's performance readout.
//!
//! One persistent `System` lives in AppState: sysinfo derives `cpu_usage`
//! from the delta between two refreshes of the same instance, so a fresh
//! `System` per call would report 0% forever. The first sample after enabling
//! the feature therefore reads 0% — correct values arrive from the second
//! poll onward.

use serde::Serialize;
use std::collections::HashMap;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

#[derive(Debug, Clone, Serialize)]
pub struct ProcPerf {
    /// Percent of the whole machine (process usage / logical core count).
    pub cpu_pct: f32,
    pub mem_mb: u64,
}

pub struct PerfSampler {
    sys: System,
}

impl PerfSampler {
    pub fn new() -> Self {
        Self { sys: System::new() }
    }

    /// Sample every given PID in one refresh — never a full-system scan
    /// (the Current tab polls this for all live sessions on an interval).
    /// PIDs with no live process are simply absent from the result.
    pub fn sample_many(&mut self, pids: &[u32]) -> HashMap<u32, ProcPerf> {
        let spids: Vec<Pid> = pids.iter().map(|p| Pid::from_u32(*p)).collect();
        self.sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&spids),
            true,
            ProcessRefreshKind::nothing().with_cpu().with_memory(),
        );
        let cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1) as f32;
        pids.iter()
            .filter_map(|&pid| {
                let proc_ = self.sys.process(Pid::from_u32(pid))?;
                Some((
                    pid,
                    ProcPerf {
                        cpu_pct: proc_.cpu_usage() / cores,
                        mem_mb: proc_.memory() / (1024 * 1024),
                    },
                ))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_own_process_and_skips_dead_pid() {
        let mut s = PerfSampler::new();
        let me = std::process::id();
        let map = s.sample_many(&[me, u32::MAX - 7]);
        // First sample legitimately reads 0% CPU (delta-based); RAM is real.
        assert!(map.get(&me).expect("own process sampleable").mem_mb > 0);
        assert!(!map.contains_key(&(u32::MAX - 7)));
    }
}
