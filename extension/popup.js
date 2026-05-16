const DEFAULT_BACKEND_URL = "http://localhost:3000/simplify";

const DEFAULT_PERSONA =
  "Elderly user with weak vision and low digital literacy. They get confused when there are too many options.";

document.addEventListener("DOMContentLoaded", () => {
  const personaInput = document.getElementById("persona");
  const backendUrlInput = document.getElementById("backendUrl");
  const extractButton = document.getElementById("extractBtn");
  const simplifyButton = document.getElementById("simplifyBtn");
  const resetButton = document.getElementById("resetBtn");
  const statusEl = document.getElementById("status");
  const debugEl = document.getElementById("debug");

  if (personaInput && !personaInput.value) {
    personaInput.value = DEFAULT_PERSONA;
  }

  if (backendUrlInput && !backendUrlInput.value) {
    backendUrlInput.value = DEFAULT_BACKEND_URL;
  }

  extractButton?.addEventListener("click", async () => {
    setStatus("Extracting page UI...");
    setBusy(true);
    clearDebug();

    try {
      const domResponse = await sendMessageToActiveTab({
        type: "EXTRACT_DOM"
      });

      if (!domResponse?.ok) {
        throw new Error(domResponse?.error || "Failed to extract DOM from the page.");
      }

      showDebug(domResponse.summary);
      setStatus(`Found ${domResponse.summary?.elements?.length || 0} visible UI elements.`);
    } catch (error) {
      console.error(error);
      setStatus(error instanceof Error ? error.message : "Could not extract page UI.");
    } finally {
      setBusy(false);
    }
  });

  simplifyButton?.addEventListener("click", async () => {
    setStatus("Extracting page UI...");
    setBusy(true);
    clearDebug();

    try {
      const persona = personaInput?.value?.trim() || DEFAULT_PERSONA;
      const backendUrl = backendUrlInput?.value?.trim() || DEFAULT_BACKEND_URL;

      const domResponse = await sendMessageToActiveTab({
        type: "EXTRACT_DOM"
      });

      if (!domResponse?.ok) {
        throw new Error(domResponse?.error || "Failed to extract DOM from the page.");
      }

      setStatus("Asking AI to simplify the UI...");

      const aiResponse = await fetch(backendUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          persona,
          domSummary: domResponse.summary
        })
      });

      if (!aiResponse.ok) {
        const errorText = await aiResponse.text();
        throw new Error(`Backend error: ${errorText}`);
      }

      const result = await aiResponse.json();

      if (!isValidSimplificationResult(result)) {
        throw new Error("AI response did not contain a valid reconstruction.");
      }

      setStatus("Applying simplified UI...");

      const applyResponse = await sendMessageToActiveTab({
        type: "APPLY_ACTIONS",
        payload: result
      });

      if (!applyResponse?.ok) {
        throw new Error(applyResponse?.error || "Failed to apply UI changes.");
      }

      setStatus("Simplified UI applied.");
      showDebug(result);
    } catch (error) {
      console.error(error);
      setStatus(error instanceof Error ? error.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  });

  resetButton?.addEventListener("click", async () => {
    setStatus("Resetting page...");
    clearDebug();

    try {
      const response = await sendMessageToActiveTab({
        type: "RESET_ACTIONS"
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Failed to reset page.");
      }

      setStatus("Original UI restored.");
    } catch (error) {
      console.error(error);
      setStatus(error instanceof Error ? error.message : "Could not reset page.");
    }
  });

  function setStatus(message) {
    if (statusEl) {
      statusEl.textContent = message;
    }
  }

  function setBusy(isBusy) {
    if (simplifyButton) {
      simplifyButton.disabled = isBusy;
      simplifyButton.textContent = isBusy ? "Simplifying..." : "Simplify current page";
    }

    if (resetButton) {
      resetButton.disabled = isBusy;
    }

    if (extractButton) {
      extractButton.disabled = isBusy;
    }
  }

  function showDebug(data) {
    if (!debugEl) return;

    debugEl.textContent = JSON.stringify(data, null, 2);
    debugEl.classList.add("visible");
  }

  function clearDebug() {
    if (!debugEl) return;

    debugEl.textContent = "";
    debugEl.classList.remove("visible");
  }
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab || !tab.id) {
    throw new Error("No active tab found.");
  }

  return tab;
}

function isInjectableUrl(url) {
  if (!url) return false;

  return (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("file://")
  );
}

async function ensureContentScript(tab) {
  if (!isInjectableUrl(tab.url)) {
    throw new Error(
      "This page cannot be modified. Try a normal public website such as https://example.com or your local demo page."
    );
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "PING"
    });

    if (response?.ok) {
      return;
    }
  } catch (error) {
    // Content script is not loaded yet. We inject it manually below.
  }

  await chrome.scripting.executeScript({
    target: {
      tabId: tab.id
    },
    files: ["content.js"]
  });

  await sleep(120);

  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "PING"
    });

    if (!response?.ok) {
      throw new Error("Content script did not respond after injection.");
    }
  } catch (error) {
    throw new Error(
      "Could not connect to the webpage. Refresh the page and try again. Some pages block extension scripts."
    );
  }
}

async function sendMessageToActiveTab(message) {
  const tab = await getActiveTab();

  await ensureContentScript(tab);

  return await chrome.tabs.sendMessage(tab.id, message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isValidSimplificationResult(result) {
  if (!result || typeof result !== "object") return false;

  const hasActionPlan = Array.isArray(result.actions);
  const hasReconstructionPlan =
    result.mode === "reconstruct" &&
    (
      Array.isArray(result.elements) ||
      Array.isArray(result.reconstruction?.elements) ||
      Array.isArray(result.layout?.elements)
    );

  return hasActionPlan || hasReconstructionPlan;
}
