import { Readable, Writable } from "node:stream";

/**
 * Sources piped into one or more targets, tracked per source:
 * Piping a shared source (such as process.stdin) into every child adds listeners to the source per child,
 * eventually exceeding its max listeners. Instead each source gets a single "data" and "end" listener
 * (attached exactly while it has targets) writing into all of its targets.
 */
type Fanout = {
  source: Readable;
  /** Targets, each with a callback for when the source ends */
  targets: Map<Writable, () => void>;
  /** Targets which haven't drained yet, with their "drain" listener */
  blocked: Map<Writable, () => void>;
  /** Was the source flowing before it got its first target? */
  wasFlowing: boolean;
  onData: (chunk: unknown) => void;
  onEnd: () => void;
};

const fanouts = new Map<Readable, Fanout>();

function unblock(fanout: Fanout, target: Writable) {
  const onDrain = fanout.blocked.get(target);
  if (onDrain) {
    target.off("drain", onDrain);
    fanout.blocked.delete(target);
    if (fanout.blocked.size === 0 && fanout.targets.size > 0) {
      fanout.source.resume();
    }
  }
}

function createFanout(source: Readable): Fanout {
  const fanout: Fanout = {
    source,
    targets: new Map(),
    blocked: new Map(),
    wasFlowing: source.readableFlowing === true,
    onData(chunk) {
      for (const target of fanout.targets.keys()) {
        if (target.writableEnded || target.destroyed) {
          continue;
        }
        if (!target.write(chunk) && !fanout.blocked.has(target)) {
          // Apply backpressure, like pipe does
          const onDrain = () => unblock(fanout, target);
          fanout.blocked.set(target, onDrain);
          target.once("drain", onDrain);
        }
      }
      if (fanout.blocked.size > 0) {
        source.pause();
      }
    },
    onEnd() {
      const callbacks = [...fanout.targets.values()];
      for (const target of fanout.targets.keys()) {
        unblock(fanout, target);
      }
      fanout.targets.clear();
      release(fanout);
      for (const callback of callbacks) {
        callback();
      }
    },
  };
  source.on("data", fanout.onData);
  source.once("end", fanout.onEnd);
  fanouts.set(source, fanout);
  return fanout;
}

function release(fanout: Fanout) {
  const { source } = fanout;
  source.off("data", fanout.onData);
  source.off("end", fanout.onEnd);
  fanouts.delete(source);
  if (!fanout.wasFlowing && !source.readableEnded) {
    // Leave the source paused as it was found (allowing a process.stdin to stop keeping the process alive)
    source.pause();
  }
}

/**
 * Write everything read from the source into the target, until disconnected.
 * Calls `onEnd` if the source ends (after which it's disconnected).
 * The target is never ended: that's the responsibility of the caller.
 */
export function connectInput(
  source: Readable,
  target: Writable,
  onEnd: () => void,
) {
  if (source.readableEnded) {
    process.nextTick(onEnd);
    return;
  }
  const fanout = fanouts.get(source) ?? createFanout(source);
  fanout.targets.set(target, onEnd);
  if (fanout.blocked.size === 0) {
    source.resume();
  }
}

/**
 * Stop writing from the source into the target, leaving both open.
 */
export function disconnectInput(source: Readable, target: Writable) {
  const fanout = fanouts.get(source);
  if (!fanout || !fanout.targets.has(target)) {
    return;
  }
  fanout.targets.delete(target);
  unblock(fanout, target);
  if (fanout.targets.size === 0) {
    release(fanout);
  }
}
