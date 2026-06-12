const status = document.querySelector("#status");
const response = await fetch("./data.json");
const data = await response.json();

if (status) {
  status.innerHTML = `Loaded <code>${data.name}</code> through a relative fetch from an ES module.`;
}
