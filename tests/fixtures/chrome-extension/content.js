document.documentElement.dataset.reaExtensionFixture = "loaded";
chrome.runtime.sendMessage({ kind: "rea-fixture-ping" });
document.addEventListener("click", async function reaContentAction(event) {
  if (event.target.id !== "rea-content-action") return;
  document.documentElement.dataset.reaContentAction = "observed";
  const marker = document.createElement("div");
  marker.textContent = "fixture-private-dom-value";
  document.body.append(marker);
  await fetch("/content-probe?fixture=retained");
  chrome.runtime.sendMessage({ kind: "rea-fixture-ping" });
});
