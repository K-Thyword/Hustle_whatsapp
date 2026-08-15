const contentEl = document.getElementById("tab-content");
let currentChart = null;

async function api(path) {
  const res = await fetch(`/api${path}`);
  if (res.status === 401) {
    window.location.href = "/login.html";
    throw new Error("not authenticated");
  }
  if (!res.ok) throw new Error(`Request failed: ${path}`);
  return res.json();
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function statusBadge(status, isOpen) {
  if (status === "cancelled") return `<span class="badge badge-cancelled">cancelled</span>`;
  return `<span class="badge ${isOpen ? "badge-open" : "badge-closed"}">${esc(status)}</span>`;
}

// --- Tab: Overview ---
async function renderOverview() {
  contentEl.innerHTML = `<h1>Overview</h1><p class="muted">A snapshot of recent activity.</p>
    <div class="filters">
      <select id="overviewDays">
        <option value="1">Today</option>
        <option value="7" selected>Last 7 days</option>
        <option value="30">Last 30 days</option>
      </select>
    </div>
    <div class="kpi-row" id="kpiRow"></div>
    <div class="chart-wrap"><canvas id="serviceChart" height="200"></canvas></div>`;

  const load = async () => {
    const days = document.getElementById("overviewDays").value;
    const data = await api(`/overview?days=${days}`);
    document.getElementById("kpiRow").innerHTML = `
      <div class="kpi-card"><div class="value">${data.submitted}</div><div class="label">New requests (${esc(data.windowLabel)})</div></div>
      <div class="kpi-card"><div class="value">${data.completed}</div><div class="label">Completed</div></div>
      <div class="kpi-card"><div class="value">${data.cancelled}</div><div class="label">Cancelled</div></div>
      <div class="kpi-card"><div class="value">${data.open}</div><div class="label">Open right now (all-time)</div></div>
      <div class="kpi-card"><div class="value">${data.alerts}</div><div class="label">Delivery alerts</div></div>
      <div class="kpi-card"><div class="value">${data.strugglingConversations}</div><div class="label">Customers who seemed stuck</div></div>`;

    if (currentChart) currentChart.destroy();
    const ctx = document.getElementById("serviceChart");
    const labels = Object.keys(data.byService);
    currentChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels: labels.length ? labels : ["No requests yet"],
        datasets: [{ label: "Requests by service", data: labels.length ? Object.values(data.byService) : [0], backgroundColor: "#1a6b2f" }],
      },
      options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } },
    });
  };
  document.getElementById("overviewDays").addEventListener("change", load);
  load();
}

// --- Tab: Requests ---
async function renderRequests() {
  contentEl.innerHTML = `<h1>Requests</h1><p class="muted">Every request's current status, grouped from the event log.</p>
    <div class="filters">
      <select id="statusFilter">
        <option value="">All statuses</option>
        <option value="open">Open only</option>
        <option value="submitted">Submitted</option>
        <option value="claimed">Claimed</option>
        <option value="quoted">Quoted</option>
        <option value="matched">Matched</option>
        <option value="confirmed">Confirmed</option>
        <option value="completed">Completed</option>
        <option value="reviewed">Reviewed</option>
        <option value="cancelled">Cancelled</option>
      </select>
    </div>
    <div id="requestsTable"></div>`;

  const load = async () => {
    const status = document.getElementById("statusFilter").value;
    const rows = await api(`/requests${status ? `?status=${status}` : ""}`);
    if (!rows.length) {
      document.getElementById("requestsTable").innerHTML = `<p class="muted">No requests found.</p>`;
      return;
    }
    document.getElementById("requestsTable").innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th></th><th>Reference</th><th>Service</th><th>Location</th><th>Status</th><th>Claimed by</th><th>Submitted</th><th>Updated</th></tr></thead>
      <tbody>${rows
        .map(
          (r, i) => `<tr class="req-row" data-idx="${i}" style="cursor:pointer">
            <td class="expand-arrow">▸</td>
            <td>${esc(r.requestId)}</td>
            <td>${esc(r.serviceType)}</td>
            <td>${esc(r.location)}</td>
            <td>${statusBadge(r.status, r.isOpen)}</td>
            <td>${esc(r.claimedByName ?? "—")}</td>
            <td>${fmtTime(r.submittedAt)}</td>
            <td>${fmtTime(r.lastUpdated)}</td>
          </tr>
          <tr class="req-timeline hidden" data-timeline-for="${i}"><td colspan="8"></td></tr>`
        )
        .join("")}</tbody></table></div>`;

    document.querySelectorAll(".req-row").forEach((rowEl) => {
      rowEl.addEventListener("click", () => {
        const idx = rowEl.dataset.idx;
        const timelineRow = document.querySelector(`[data-timeline-for="${idx}"]`);
        const arrow = rowEl.querySelector(".expand-arrow");
        const isHidden = timelineRow.classList.contains("hidden");
        if (isHidden) {
          const r = rows[idx];
          const cell = timelineRow.querySelector("td");
          cell.innerHTML = r.timeline.length
            ? `<div class="timeline">${r.timeline
                .map((t) => `<div class="timeline-item"><span class="badge badge-open">${esc(t.event)}</span> ${fmtTime(t.timestamp)}${t.detail ? ` — <span class="muted">${esc(t.detail)}</span>` : ""}</div>`)
                .join("")}</div>`
            : `<span class="muted">No timeline events.</span>`;
        }
        timelineRow.classList.toggle("hidden");
        arrow.textContent = isHidden ? "▾" : "▸";
      });
    });
  };
  document.getElementById("statusFilter").addEventListener("change", load);
  load();
}

// --- Tab: Alerts ---
async function renderAlerts() {
  contentEl.innerHTML = `<h1>Alerts</h1><p class="muted">Notifications that never actually reached an agent or customer — window closed, template also failed.</p><div id="alertsTable"></div>`;
  const rows = await api("/alerts");
  if (!rows.length) {
    document.getElementById("alertsTable").innerHTML = `<p class="muted">No alerts logged. 🎉</p>`;
    return;
  }
  document.getElementById("alertsTable").innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>When</th><th>Message</th></tr></thead>
    <tbody>${rows.map((a) => `<tr><td>${fmtTime(a.timestamp)}</td><td>${esc(a.message)}</td></tr>`).join("")}</tbody></table></div>`;
}

// --- Tab: Chats ---
async function renderChats() {
  contentEl.innerHTML = `<h1>Chats</h1><p class="muted">Browse full conversations, or search across all of them.</p>
    <div class="filters"><input type="search" id="chatSearch" placeholder="Search messages or phone number..." style="flex:1" /></div>
    <div class="two-col">
      <div class="card conv-list" id="convList"></div>
      <div class="card thread" id="thread"><p class="muted">Select a conversation.</p></div>
    </div>`;

  const convList = document.getElementById("convList");
  const thread = document.getElementById("thread");

  async function loadConversations() {
    const convs = await api("/conversations");
    if (!convs.length) {
      convList.innerHTML = `<p class="muted" style="padding:12px">No conversations logged yet.</p>`;
      return;
    }
    convList.innerHTML = convs
      .map(
        (c) => `<div class="conv-item" data-phone="${esc(c.phone)}">
          <div class="conv-phone">${esc(c.phone)}</div>
          <div class="conv-preview">${esc(c.lastMessage)}</div>
          <div class="msg-time">${fmtTime(c.lastTimestamp)} · ${c.messageCount} msgs</div>
        </div>`
      )
      .join("");
    convList.querySelectorAll(".conv-item").forEach((el) =>
      el.addEventListener("click", () => {
        convList.querySelectorAll(".conv-item").forEach((x) => x.classList.remove("active"));
        el.classList.add("active");
        loadThread(el.dataset.phone);
      })
    );
  }

  async function loadThread(phone) {
    thread.innerHTML = `<p class="muted">Loading…</p>`;
    const lines = await api(`/conversations/${encodeURIComponent(phone)}`);
    thread.innerHTML = lines
      .map(
        (l) => `<div class="msg-row ${l.direction}">
          <div>
            <div class="msg ${l.direction}">${esc(l.text)}</div>
            <div class="msg-time" style="text-align:${l.direction === "bot" ? "right" : "left"}">${fmtTime(l.timestamp)}</div>
          </div>
        </div>`
      )
      .join("");
  }

  let searchTimer;
  document.getElementById("chatSearch").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    searchTimer = setTimeout(async () => {
      if (!q) return loadConversations();
      const results = await api(`/transcripts/search?q=${encodeURIComponent(q)}`);
      convList.innerHTML = results.length
        ? results
            .map(
              (l) => `<div class="conv-item" data-phone="${esc(l.phone)}">
                <div class="conv-phone">${esc(l.phone)}</div>
                <div class="conv-preview">${esc(l.text)}</div>
                <div class="msg-time">${fmtTime(l.timestamp)}</div>
              </div>`
            )
            .join("")
        : `<p class="muted" style="padding:12px">No matches.</p>`;
      convList.querySelectorAll(".conv-item").forEach((el) =>
        el.addEventListener("click", () => loadThread(el.dataset.phone))
      );
    }, 300);
  });

  loadConversations();
}

// --- Tab: Agents ---
async function renderAgents() {
  contentEl.innerHTML = `<h1>Agents</h1><p class="muted">Workload derived from who's claimed each request.</p><div id="agentsTable"></div>`;
  const rows = await api("/agents");
  if (!rows.length) {
    document.getElementById("agentsTable").innerHTML = `<p class="muted">No claims logged yet.</p>`;
    return;
  }
  document.getElementById("agentsTable").innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Agent</th><th>Total claimed</th><th>Open</th><th>Completed</th></tr></thead>
    <tbody>${rows
      .map((a) => `<tr><td>${esc(a.name)}</td><td>${a.claimed}</td><td>${a.open}</td><td>${a.completed}</td></tr>`)
      .join("")}</tbody></table></div>`;
}

// --- Tab: Reports ---
async function renderReports() {
  contentEl.innerHTML = `<h1>Reports</h1><p class="muted">Sent automatically to agents over WhatsApp every Monday at 8am — also viewable here anytime.</p>
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px">
        <h2 style="margin:0">This week</h2>
        <button class="refresh" id="regenBtn">Regenerate</button>
      </div>
      <div class="digest-box" id="digestBox">Loading…</div>
    </div>
    <div class="card" style="margin-top:16px" id="sendCard"></div>`;

  const load = async () => {
    document.getElementById("digestBox").textContent = "Loading…";
    const { text, aiGenerated } = await api("/digest");
    document.getElementById("digestBox").innerHTML = `${esc(text)}${
      aiGenerated ? "" : `<div class="muted" style="margin-top:10px">(Computed summary — set ANTHROPIC_API_KEY on this service for an AI-written version.)</div>`
    }`;
  };
  document.getElementById("regenBtn").addEventListener("click", load);

  const { configured } = await api("/digest/whatsapp-status");
  const sendCard = document.getElementById("sendCard");
  if (!configured) {
    sendCard.innerHTML = `<h2 style="margin-top:0">WhatsApp delivery</h2>
      <p class="muted">Not set up yet on this service — add WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, and AGENT_NOTIFY_NUMBERS to send this automatically. See dashboard/README.md.</p>`;
  } else {
    sendCard.innerHTML = `<h2 style="margin-top:0">WhatsApp delivery</h2>
      <p class="muted">Configured — sends automatically Monday 8am. Send this week's digest right now to confirm it works:</p>
      <button class="refresh" id="sendNowBtn">Send now</button>
      <span id="sendStatus" class="muted" style="margin-left:10px"></span>`;
    document.getElementById("sendNowBtn").addEventListener("click", async (e) => {
      e.target.disabled = true;
      document.getElementById("sendStatus").textContent = "Sending…";
      const result = await (await fetch("/api/digest/send-now", { method: "POST" })).json();
      document.getElementById("sendStatus").textContent = `Sent to ${result.sent} agent(s)${result.failed ? `, ${result.failed} failed` : ""}.`;
      e.target.disabled = false;
    });
  }

  load();
}

const tabs = { overview: renderOverview, requests: renderRequests, alerts: renderAlerts, chats: renderChats, agents: renderAgents, reports: renderReports };

// Chats and Reports both hold in-progress state a background refresh would
// clobber (a selected conversation mid-read, a "Send now" button click) —
// only the plain data-table tabs auto-refresh.
const AUTO_REFRESH_TABS = new Set(["overview", "requests", "alerts", "agents"]);
let currentTab = "overview";
let lastRefreshAt = Date.now();

function switchTab(name) {
  currentTab = name;
  lastRefreshAt = Date.now();
  tabs[name]();
}

document.querySelectorAll(".nav-item[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item[data-tab]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    switchTab(btn.dataset.tab);
  });
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login.html";
});

setInterval(() => {
  const el = document.getElementById("lastUpdated");
  if (!el) return;
  const secs = Math.round((Date.now() - lastRefreshAt) / 1000);
  el.textContent = secs < 5 ? "Updated just now" : `Updated ${secs}s ago`;
}, 1000);

setInterval(() => {
  if (AUTO_REFRESH_TABS.has(currentTab)) {
    lastRefreshAt = Date.now();
    tabs[currentTab]();
  }
}, 45000);

(async function init() {
  try {
    const status = await api("/status");
    if (!status.sheetsConfigured) document.getElementById("sheetsWarning").classList.remove("hidden");
  } catch {
    // /api/status itself redirects to login on 401, nothing else to do here
    return;
  }
  switchTab("overview");
})();
