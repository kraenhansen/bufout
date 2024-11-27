import { SpawnFailure, spawn } from "../spawn.js";

console.log("Spawning: 'echo inherits output' with no buffering\n");

await spawn("echo", ["inherits output"], {
  outputPrefix: "[echo] ",
});

console.log(
  "\nSpawning: 'echo failure! 1>&2 && sleep 1 && exit 1' with buffering\n",
);

// Prints to stderr right away, sleeps for a sec and exits with code 1
await spawn(
  "echo",
  ["failure!", "1>&2", "&&", "sleep", "1", "&&", "exit", "1"],
  {
    outputMode: "buffered",
    outputPrefix: "[failing] ",
    shell: true,
  },
).catch((error: SpawnFailure) => {
  console.error(error.message);
  error.flushOutput();
});
