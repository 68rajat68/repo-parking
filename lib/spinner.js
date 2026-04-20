const fs = require("fs");
const path = require("path");

const spinnerFrames = ["|", "/", "-", "\\"];
let currentFrame = 0;
let intervalId = null;
let message = "";

function start(msg) {
  stop();
  message = msg || "";
  currentFrame = 0;
  process.stdout.write(message + " " + spinnerFrames[0]);
  intervalId = setInterval(() => {
    process.stdout.write("\r" + message + " " + spinnerFrames[currentFrame]);
    currentFrame = (currentFrame + 1) % spinnerFrames.length;
  }, 100);
}

function stop() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  if (process.stdout.isTTY) {
    process.stdout.write("\r" + " ".repeat(message.length + 3) + "\r");
  }
}

function succeed(msg) {
  stop();
  console.log("\x1b[32m✓\x1b[0m " + (msg || message));
}

function fail(msg) {
  stop();
  console.log("\x1b[31m✗\x1b[0m " + (msg || message));
}

function info(msg) {
  stop();
  console.log("\x1b[36mℹ\x1b[0m " + msg);
}

module.exports = {
  start,
  stop,
  succeed,
  fail,
  info,
};
