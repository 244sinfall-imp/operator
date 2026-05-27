const state = {
  authenticated: false,
  root: "",
  currentPath: "",
  currentFilePath: "",
  currentSha256: "",
  originalContent: ""
};

const authShell = document.getElementById("auth-shell");
const appShell = document.getElementById("app-shell");
const loginForm = document.getElementById("login-form");
const passwordInput = document.getElementById("password-input");
const authError = document.getElementById("auth-error");
const rootSelect = document.getElementById("root-select");
const pathInput = document.getElementById("path-input");
const entriesEl = document.getElementById("entries");
const editorEl = document.getElementById("editor");
const editorHighlightEl = document.getElementById("editor-highlight");
const statusPill = document.getElementById("status-pill");
const activeFileLabel = document.getElementById("active-file-label");
const languageBadge = document.getElementById("language-badge");
const diffOutput = document.getElementById("diff-output");
const searchResults = document.getElementById("search-results");
const logoutButton = document.getElementById("logout-button");
const restartGatewayButton = document.getElementById("restart-gateway-button");
const entriesCount = document.getElementById("entries-count");
const searchCount = document.getElementById("search-count");

const LANGUAGE_BY_EXTENSION = new Map([
  ["css", "css"],
  ["html", "html"],
  ["js", "javascript"],
  ["json", "json"],
  ["jsx", "javascript"],
  ["md", "markdown"],
  ["mjs", "javascript"],
  ["sh", "shell"],
  ["ts", "typescript"],
  ["tsx", "typescript"],
  ["yaml", "yaml"],
  ["yml", "yaml"]
]);

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    ...options
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    if (response.status === 401) {
      setAuthenticated(false);
    }
    throw new Error(payload.message || `Request failed: ${response.status}`);
  }

  return payload;
}

function setAuthenticated(value) {
  state.authenticated = value;
  authShell.classList.toggle("hidden", value);
  appShell.classList.toggle("hidden", !value);
}

function showAuthError(message) {
  authError.textContent = message;
  authError.classList.remove("hidden");
}

function clearAuthError() {
  authError.textContent = "";
  authError.classList.add("hidden");
}

function setStatus(message, tone = "ok") {
  statusPill.textContent = message;
  statusPill.classList.toggle("busy", tone === "busy");
  statusPill.classList.toggle("error", tone === "error");
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function detectLanguage(path) {
  const filename = path.split("/").pop() || "";
  const extension = filename.includes(".") ? filename.split(".").pop().toLowerCase() : "";
  return LANGUAGE_BY_EXTENSION.get(extension) || "plain text";
}

function formatBytes(size) {
  if (!Number.isFinite(size)) {
    return "unknown";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function formatMtime(ms) {
  if (!Number.isFinite(ms)) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(ms));
}

function updateDirtyState() {
  appShell.classList.toggle(
    "is-dirty",
    Boolean(state.currentFilePath && editorEl.value !== state.originalContent)
  );
}

function highlightByPattern(value, pattern, classify) {
  let html = "";
  let lastIndex = 0;

  value.replace(pattern, (match, ...args) => {
    const offset = args[args.length - 2];
    html += escapeHtml(value.slice(lastIndex, offset));
    html += `<span class="tok ${classify(match)}">${escapeHtml(match)}</span>`;
    lastIndex = offset + match.length;
    return match;
  });

  return html + escapeHtml(value.slice(lastIndex));
}

function highlightCode(value, language) {
  if (!value) {
    return "";
  }

  if (language === "json") {
    return highlightByPattern(
      value,
      /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"\s*:|"(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\btrue\b|\bfalse\b|\bnull\b)/g,
      (token) => {
        if (token.startsWith("\"") && token.trim().endsWith(":")) return "key";
        if (token.startsWith("\"")) return "string";
        if (/true|false/.test(token)) return "boolean";
        if (token === "null") return "null";
        return "number";
      }
    );
  }

  if (["javascript", "typescript"].includes(language)) {
    return highlightByPattern(
      value,
      /(\/\/.*|\/\*[\s\S]*?\*\/|`(?:\\.|[^`])*`|'(?:\\.|[^'])*'|"(?:\\.|[^"])*"|\b(?:async|await|break|case|catch|class|const|continue|default|else|export|for|from|function|if|import|let|new|return|throw|try|type|var|while)\b|\b\d+(?:\.\d+)?\b)/g,
      (token) => {
        if (token.startsWith("//") || token.startsWith("/*")) return "comment";
        if (token.startsWith("\"") || token.startsWith("'") || token.startsWith("`")) return "string";
        if (/^\d/.test(token)) return "number";
        return "keyword";
      }
    );
  }

  if (language === "shell") {
    return highlightByPattern(
      value,
      /(#.*|'(?:\\.|[^'])*'|"(?:\\.|[^"])*"|\b(?:case|do|done|elif|else|esac|fi|for|function|if|in|then|while)\b|\b\d+(?:\.\d+)?\b)/g,
      (token) => {
        if (token.startsWith("#")) return "comment";
        if (token.startsWith("\"") || token.startsWith("'")) return "string";
        if (/^\d/.test(token)) return "number";
        return "keyword";
      }
    );
  }

  if (language === "css") {
    return highlightByPattern(
      value,
      /(\/\*[\s\S]*?\*\/|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[\w-]+(?=\s*:)|#[\da-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%)?\b)/g,
      (token) => {
        if (token.startsWith("/*")) return "comment";
        if (token.startsWith("\"") || token.startsWith("'")) return "string";
        if (token.startsWith("#")) return "number";
        if (/^\d/.test(token)) return "number";
        return "key";
      }
    );
  }

  if (language === "yaml") {
    return highlightByPattern(
      value,
      /(#.*|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[\w-]+(?=\s*:)|\b\d+(?:\.\d+)?\b|\btrue\b|\bfalse\b|\bnull\b)/g,
      (token) => {
        if (token.startsWith("#")) return "comment";
        if (token.startsWith("\"") || token.startsWith("'")) return "string";
        if (/^\d/.test(token)) return "number";
        if (/true|false/.test(token)) return "boolean";
        if (token === "null") return "null";
        return "key";
      }
    );
  }

  if (language === "html" || language === "markdown") {
    return highlightByPattern(
      value,
      /(<!--[\s\S]*?-->|<\/?[\w-]+(?:\s+[^>]*)?>|`[^`]+`|\*\*[^*]+\*\*|^#{1,6}\s.+$)/gm,
      (token) => {
        if (token.startsWith("<!--")) return "comment";
        if (token.startsWith("<")) return "keyword";
        if (token.startsWith("#")) return "key";
        return "string";
      }
    );
  }

  return escapeHtml(value);
}

function updateEditorHighlight() {
  const language = detectLanguage(state.currentFilePath);
  editorHighlightEl.innerHTML = highlightCode(editorEl.value, language);
  languageBadge.textContent = language;
  updateDirtyState();
}

async function ensureSession() {
  const response = await fetch("/auth/session", { credentials: "same-origin" });
  if (!response.ok) {
    setAuthenticated(false);
    passwordInput.focus();
    return false;
  }

  setAuthenticated(true);
  return true;
}

async function login(password) {
  const response = await fetch("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ password })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || "Invalid password");
  }

  clearAuthError();
  setAuthenticated(true);
}

async function logout() {
  await fetch("/auth/logout", {
    method: "POST",
    credentials: "same-origin"
  });
  setAuthenticated(false);
  passwordInput.value = "";
  passwordInput.focus();
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
    const node = document.createElement("button");
    node.className = `entry ${item.kind}`;
    node.type = "button";
    node.onclick = () => item.kind === "directory" ? openDirectory(item.path) : openFile(item.path);

    const icon = document.createElement("span");
    icon.className = "entry-icon";
    icon.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.className = "entry-text";

    const name = document.createElement("strong");
    name.textContent = item.name;

    const path = document.createElement("small");
    path.textContent = item.path;

    const meta = document.createElement("small");
    meta.textContent = item.kind === "directory"
      ? `folder / ${formatMtime(item.mtimeMs)}`
      : `${formatBytes(item.size)} / ${formatMtime(item.mtimeMs)}`;

    text.append(name, path, meta);
    node.append(icon, text);
    entriesEl.appendChild(node);
  });
  entriesCount.textContent = String(data.items.length);
  setStatus(`${data.items.length} entries`);
}

async function openFile(targetPath, lineNumber) {
  const data = await api(`/api/v1/file?path=${encodeURIComponent(targetPath)}`);
  state.currentFilePath = data.path;
  state.currentSha256 = data.sha256;
  state.originalContent = data.content;
  editorEl.value = data.content;
  activeFileLabel.textContent = lineNumber ? `${data.path}:${lineNumber}` : data.path;
  updateEditorHighlight();
  if (lineNumber) {
    const lines = data.content.split("\n");
    const offset = lines.slice(0, Math.max(lineNumber - 1, 0)).join("\n").length;
    editorEl.focus();
    editorEl.setSelectionRange(offset, offset);
    editorHighlightEl.scrollTop = editorEl.scrollTop;
    editorHighlightEl.scrollLeft = editorEl.scrollLeft;
  }
  diffOutput.classList.add("hidden");
  setStatus(`${formatBytes(data.size)} loaded`);
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
  updateDirtyState();
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

  setStatus("Searching...", "busy");

  searchResults.innerHTML = "";
  searchCount.textContent = "0";
  try {
    const data = await api("/api/v1/search", {
      method: "POST",
      body: JSON.stringify({
        query,
        root: state.root
      })
    });

    data.results.forEach((result) => {
      const node = document.createElement("button");
      node.className = "search-result";
      node.type = "button";
      node.onclick = () => openFile(result.path, result.line);

      const title = document.createElement("strong");
      title.textContent = `${result.path}:${result.line}`;

      const preview = document.createElement("small");
      preview.textContent = result.preview;

      node.append(title, preview);
      searchResults.appendChild(node);
    });

    searchCount.textContent = String(data.results.length);
    if (data.results.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No matches";
      searchResults.appendChild(empty);
    }

    setStatus(`Search: ${data.results.length} hits`);
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function restartGateway() {
  if (!confirm("Restart OpenClaw gateway?")) {
    return;
  }

  restartGatewayButton.disabled = true;
  setStatus("Restarting gateway...", "busy");
  try {
    await api("/api/v1/openclaw/gateway/restart", {
      method: "POST",
      body: JSON.stringify({})
    });
    setStatus("Gateway restarted");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    restartGatewayButton.disabled = false;
  }
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
document.getElementById("search-input").onkeydown = (event) => {
  if (event.key === "Enter") {
    search();
  }
};
restartGatewayButton.onclick = restartGateway;
logoutButton.onclick = logout;
editorEl.oninput = updateEditorHighlight;
editorEl.onscroll = () => {
  editorHighlightEl.scrollTop = editorEl.scrollTop;
  editorHighlightEl.scrollLeft = editorEl.scrollLeft;
};
rootSelect.onchange = () => {
  state.root = rootSelect.value;
  openDirectory(state.root);
};

loginForm.onsubmit = async (event) => {
  event.preventDefault();
  clearAuthError();
  try {
    await login(passwordInput.value);
    await loadRoots();
  } catch (error) {
    showAuthError(error.message);
  }
};

ensureSession().then((authenticated) => {
  if (!authenticated) {
    return;
  }

  return loadRoots();
}).catch((error) => {
  setStatus(error.message, "error");
});
