const button = document.querySelector("#ping-button");
const dot = document.querySelector("#health-dot");
const healthText = document.querySelector("#health-text");
const eventLog = document.querySelector("#event-log");

function addLog(message) {
  const item = document.createElement("li");
  const time = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  item.textContent = `${time} - ${message}`;
  eventLog.prepend(item);
}

button?.addEventListener("click", () => {
  dot?.classList.add("is-checking");
  if (healthText) {
    healthText.textContent = "Checking webview runtime...";
  }
  addLog("Manual preview check started.");

  window.setTimeout(() => {
    dot?.classList.remove("is-checking");
    if (healthText) {
      healthText.textContent = "Script, CSS, and assets are active";
    }
    addLog("Check complete. JavaScript executed inside the VS Code webview.");
  }, 700);
});

addLog(`Viewport: ${window.innerWidth} x ${window.innerHeight}`);
