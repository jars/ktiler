const terminal = document.querySelector(".install-terminal");
const command = terminal.querySelector("code");
const copy = terminal.querySelector(".install-terminal-copy");
const status = document.querySelector(".install-terminal-status");

copy.addEventListener("click", async () => {
  status.textContent = "";
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(command.textContent);
      status.textContent = "Copied";
      return;
    } catch {
      // The browser denied clipboard access; try copying the selection.
    }
  }

  const selection = window.getSelection();
  if (!selection) {
    status.textContent = "Couldn’t copy. Select the command and copy it manually.";
    return;
  }
  selection.selectAllChildren(command);
  try {
    // Older browsers and plain HTTP previews may only offer selection-based copying.
    if (document.execCommand?.("copy")) {
      selection.removeAllRanges();
      status.textContent = "Copied";
      return;
    }
  } catch {
    // Leave the command selected for manual copying.
  }
  status.textContent = "Command selected. Copy it manually.";
});
copy.disabled = false;

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    terminal.classList.add("is-in-view");
    observer.disconnect();
  }, { threshold: 0.5 });
  observer.observe(terminal);
}
