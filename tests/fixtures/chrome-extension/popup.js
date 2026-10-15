document.querySelector("#ping").addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({
    kind: "rea-fixture-ping",
  });
  document.body.dataset.reply = response.kind;
});
