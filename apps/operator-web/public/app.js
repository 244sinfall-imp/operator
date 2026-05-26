const state = {
  root: "",
  currentPath: "",
  currentFilePath: "",
  currentSha256: "",
  originalContent: ""
};

const rootSelect = document.getElementById("root-select");
const pathInput = document.getElementById("path-input");
const entriesEl = document.getElementById("entries");
const editorEl = document.getElementById("editor");
const statusPill = document.getElementById("status-pill");
const activeFileLabel = document.getElementById("active-file-label");
const diffOutput = document.getElementById("diff-output");
const searchResults = document.getElementById("search-results");

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.message || `Request failed: ${response.status}`);
  }

  return payload;
}

function setStatus(message) {
  statusPill.textContent = message;
}

async function loadRoots() {
  const data = await api("/api/v1/roots");
  rootSelect.innerHTML = "";
  data.roots.forEach((root) => {
    const option = document.createElement("option");
    option.value = root.path;
    option.textContent = root.label;
    rootSelect.appendChild(option);
  });

  state.root = data.roots[0]?.path || "";
  rootSelect.value = state.root;
  await openDirectory(state.root);
}

async function openDirectory(targetPath) {
  const data = await api(`/api/v1/list?path=${encodeURIComponent(targetPath)}`);
  state.currentPath = data.path;
  pathInput.value = data.path;
  entriesEl.innerHTML = "";
  data.items.forEach((item) => {
    const node = document.createElement("div");
    node.className = "entry";
    node.innerHTML = `<strong>${item.kind === "directory" ? "DIR" : "FILE"} ${item.name}</strong><small>${item.path}</small>`;
    node.onclick = () => item.kind === "directory" ? openDirectory(item.path) : openFile(item.path);
    entriesEl.appendChild(node);
  });
  setStatus(`Opened ${data.path}`);
}

async function openFile(targetPath, lineNumber) {
  const data = await api(`/api/v1/file?path=${encodeURIComponent(targetPath)}`);
  state.currentFilePath = data.path;
  state.currentSha256 = data.sha256;
  state.originalContent = data.content;
  editorEl.value = data.content;
  activeFileLabel.textContent = lineNumber ? `${data.path}:${lineNumber}` : data.path;
  if (lineNumber) {
    const lines = data.content.split("\n");
    const offset = lines.slice(0, Math.max(lineNumber - 1, 0)).join("\n").length;
    editorEl.focus();
    editorEl.setSelectionRange(offset, offset);
  }
  diffOutput.classList.add("hidden");
  setStatus(`Loaded ${data.path}`);
}

async function saveFile() {
  if (!state.currentFilePath) {
    return;
  }

  const data = await api("/api/v1/write", {
    method: "POST",
    body: JSON.stringify({
      path: state.currentFilePath,
      newContent: editorEl.value,
      expectedSha256: state.currentSha256
    })
  });

  state.currentSha256 = data.sha256;
  state.originalContent = editorEl.value;
  setStatus("Saved");
}

async function showDiff() {
  if (!state.currentFilePath) {
    return;
  }

  const data = await api("/api/v1/diff", {
    method: "POST",
    body: JSON.stringify({
      path: state.currentFilePath,
      newContent: editorEl.value
    })
  });

  diffOutput.textContent = data.patch;
  diffOutput.classList.remove("hidden");
}

async function search() {
  const query = document.getElementById("search-input").value.trim();
  if (!query) {
    return;
  }

  const data = await api("/api/v1/search", {
    method: "POST",
    body: JSON.stringify({
      query,
      root: state.root
    })
  });

  searchResults.innerHTML = "";
  data.results.forEach((result) => {
    const node = document.createElement("div");
    node.className = "search-result";
    node.innerHTML = `<strong>${result.path}:${result.line}</strong><small>${result.preview}</small>`;
    node.onclick = () => openFile(result.path, result.line);
    searchResults.appendChild(node);
  });

  setStatus(`Search: ${data.results.length} hits`);
}

document.getElementById("open-path").onclick = () => openDirectory(pathInput.value);
document.getElementById("refresh").onclick = () => openDirectory(state.currentPath || state.root);
document.getElementById("go-up").onclick = () => {
  if (!state.currentPath) {
    return;
  }

  const parts = state.currentPath.split("/");
  parts.pop();
  const nextPath = parts.join("/") || "/";
  openDirectory(nextPath);
};
document.getElementById("save-file").onclick = saveFile;
document.getElementById("show-diff").onclick = showDiff;
document.getElementById("search-button").onclick = search;
rootSelect.onchange = () => {
  state.root = rootSelect.value;
  openDirectory(state.root);
};

loadRoots().catch((error) => {
  setStatus(error.message);
});

