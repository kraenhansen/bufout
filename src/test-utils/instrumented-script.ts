import fs from "node:fs";

const {
  CONSOLE_LOG,
  CONSOLE_ERROR,
  EXIT_CODE,
  SET_TIMEOUT_MS,
  TOUCH_PATH_ON_EXIT,
} = process.env;

if (typeof CONSOLE_LOG === "string") {
  console.log(CONSOLE_LOG);
}

if (typeof CONSOLE_ERROR === "string") {
  console.error(CONSOLE_ERROR);
}

if (typeof EXIT_CODE === "string") {
  process.exitCode = parseInt(EXIT_CODE, 10);
}

if (typeof SET_TIMEOUT_MS === "string") {
  setTimeout(() => {}, parseInt(SET_TIMEOUT_MS, 10));
}

if (typeof TOUCH_PATH_ON_EXIT === "string") {
  process.once("exit", (code) => {
    fs.writeFileSync(TOUCH_PATH_ON_EXIT, `code=${code}`);
  });

  process.once("SIGINT", () => {
    fs.writeFileSync(TOUCH_PATH_ON_EXIT, "SIGINT");
    process.exit();
  });

  process.once("SIGTERM", () => {
    fs.writeFileSync(TOUCH_PATH_ON_EXIT, "SIGTERM");
    process.exit();
  });
}
