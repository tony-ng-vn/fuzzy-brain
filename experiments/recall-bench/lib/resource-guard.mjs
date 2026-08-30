// Refuses a load run the machine cannot survive.
//
// Written after a 10M open-loop run at 150-200 offered QPS drove ~100 Postgres
// backends against a 17.8 GB working set on a 24 GB laptop: swap reached
// 15.6 of 16 GB, load average hit 72 on 12 cores, and the desktop stopped
// responding. Every one of those numbers was knowable before the first query.
// The disk budget (section 3.5) already refuses a corpus too big for the
// volume; this is the same idea for memory and CPU.
//
// The assessment is pure so it can be tested without a machine under load;
// readMachine() is the only part that touches the host.
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const GB = 1024 ** 3;

// A working set past this fraction of RAM cannot stay resident once the user's
// own apps are counted, and an ANN index that does not stay resident turns
// every probe into a page-in. Measured at 10M: 17.8 GB of 24 GB (0.74) gave a
// 38% buffer hit ratio and 40 sustainable QPS against 1,200 at 1M.
const WORKING_SET_FRACTION = 0.7;
// Postgres backends past a few per core stop adding throughput and start
// adding context switches and per-backend memory. The 10M run used 96 on 12.
const CONNECTIONS_PER_CPU = 4;
// Swap already in use before the run means the machine is under pressure from
// something else; adding a benchmark makes it the user's problem, not ours.
const START_SWAP_FRACTION = 0.1;
// Growth past this during a run means the run itself is the thing swapping.
const RUN_SWAP_GROWTH_GB = 2;

export function readSwapUsedGb() {
  // vm.swapusage is the only honest swap reading on macOS; freemem() counts
  // free pages, which stay near zero on a healthy Mac and say nothing.
  try {
    const out = execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' });
    const match = out.match(/used\s*=\s*([\d.]+)([MG])/);
    if (!match) return null;
    const value = Number(match[1]);
    return match[2] === 'G' ? value : value / 1024;
  } catch {
    return null;
  }
}

export function readMachine() {
  return {
    totalRamGb: os.totalmem() / GB,
    cpus: os.cpus().length,
    load1: os.loadavg()[0],
    swapUsedGb: readSwapUsedGb(),
  };
}

// Returns the reasons this run should not start. Empty means go.
export function assessHeadroom({ workingSetGb, connections, machine }) {
  const problems = [];
  const { totalRamGb, cpus, load1, swapUsedGb } = machine;

  const ramBudgetGb = totalRamGb * WORKING_SET_FRACTION;
  if (workingSetGb != null && workingSetGb > ramBudgetGb) {
    problems.push(
      `working set ${workingSetGb.toFixed(1)} GB exceeds ${ramBudgetGb.toFixed(1)} GB ` +
        `(${Math.round(WORKING_SET_FRACTION * 100)}% of ${totalRamGb.toFixed(0)} GB RAM); ` +
        'the run will page rather than measure',
    );
  }

  const connectionCap = cpus * CONNECTIONS_PER_CPU;
  if (connections > connectionCap) {
    problems.push(
      `${connections} connections exceeds ${connectionCap} (${CONNECTIONS_PER_CPU} per core on ${cpus} cores)`,
    );
  }

  if (swapUsedGb != null && swapUsedGb > totalRamGb * START_SWAP_FRACTION) {
    problems.push(
      `${swapUsedGb.toFixed(1)} GB of swap is already in use; the machine is under pressure before the run starts`,
    );
  }

  if (load1 > cpus) {
    problems.push(`load average ${load1.toFixed(1)} already exceeds ${cpus} cores`);
  }

  return problems;
}

// True when the run itself has started swapping and should be abandoned.
export function shouldAbort({ startSwapGb, currentSwapGb, totalRamGb }) {
  if (startSwapGb == null || currentSwapGb == null) return false;
  if (currentSwapGb - startSwapGb > RUN_SWAP_GROWTH_GB) return true;
  return currentSwapGb > totalRamGb * 0.5;
}

// Samples swap while a run is in flight and calls onAbort once. The caller
// decides how to stop; this only watches.
export function watchPressure({ machine, intervalMs = 5000, onAbort }) {
  const startSwapGb = machine.swapUsedGb;
  const timer = setInterval(() => {
    const currentSwapGb = readSwapUsedGb();
    if (shouldAbort({ startSwapGb, currentSwapGb, totalRamGb: machine.totalRamGb })) {
      clearInterval(timer);
      onAbort(
        `aborting: swap went from ${startSwapGb.toFixed(1)} GB to ${currentSwapGb.toFixed(1)} GB during the run`,
      );
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
